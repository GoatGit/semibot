# 记忆系统设计：短期 + 长期 + 沉淀器

> 版本：1.0 | 日期：2026-02-26

## 1. 设计理念

短期记忆和长期记忆的本质区别不是存储介质，而是**生命周期和检索方式**：

| | 短期记忆 | 长期记忆 |
|---|---|---|
| 生命周期 | 会话级，会话结束可丢弃 | 永久，跨会话持续存在 |
| 检索方式 | 按时间顺序（最近的 N 条） | 按语义相似度（向量检索） |
| 内容 | 对话消息、工具调用结果、中间状态 | 提炼后的知识、用户偏好、学到的经验 |
| 数据量 | 小（单次会话几十条） | 大（持续积累） |
| 存储 | 进程内存 dict | SQLite + sqlite-vec |

## 2. 架构总览

```
┌─────────────────────────────────────────────────────┐
│                   MemoryManager                      │
│                                                     │
│  ┌─────────────────────┐  ┌───────────────────────┐ │
│  │   ShortTermMemory   │  │    LongTermMemory     │ │
│  │                     │  │                       │ │
│  │   Python dict       │  │   SQLite + sqlite-vec │ │
│  │   (进程内存)         │  │                       │ │
│  │                     │  │   • 知识片段           │ │
│  │   • 对话历史        │  │   • 用户偏好           │ │
│  │   • 工具调用结果     │  │   • 进化技能           │ │
│  │   • 执行计划状态     │  │   • 项目上下文         │ │
│  │   • 临时上下文       │  │                       │ │
│  └─────────┬───────────┘  └──────────┬────────────┘ │
│            │                         │              │
│            │    ┌────────────────┐   │              │
│            └───▶│  Consolidator  │◀──┘              │
│                 │  (沉淀器)       │                  │
│                 └────────────────┘                  │
│                 会话结束时，将短期记忆                  │
│                 中有价值的内容沉淀到长期记忆             │
└─────────────────────────────────────────────────────┘
```

## 3. 数据模型

### 3.1 MemoryEntry（短期记忆条目）

```python
@dataclass
class MemoryEntry:
    """短期记忆条目"""
    id: str                          # UUID
    role: str                        # user / assistant / system / tool
    content: str                     # 消息内容
    tool_calls: list[dict] | None    # 工具调用记录
    token_count: int                 # token 数量（用于预算控制）
    timestamp: float                 # 时间戳
    metadata: dict | None            # 扩展字段
```

### 3.2 Memory（长期记忆条目）

```python
@dataclass
class Memory:
    """长期记忆条目"""
    id: str                          # UUID
    content: str                     # 记忆内容
    category: MemoryCategory         # 分类
    importance: float                # 重要性评分 0-1
    access_count: int                # 访问次数
    embedding: list[float] | None    # 向量
    metadata: dict | None            # 扩展字段（来源 session 等）
    created_at: str
    updated_at: str

class MemoryCategory(str, Enum):
    KNOWLEDGE = "knowledge"          # 事实、规则
    PREFERENCE = "preference"        # 用户偏好、习惯
    SKILL = "skill"                  # 成功解决问题的模式
    PROJECT = "project"              # 项目上下文、架构决策
```

### 3.3 SQLite 表结构

```sql
-- 长期记忆
CREATE TABLE IF NOT EXISTS memories (
    id            TEXT PRIMARY KEY,
    content       TEXT NOT NULL,
    category      TEXT NOT NULL CHECK(category IN ('knowledge','preference','skill','project')),
    importance    REAL NOT NULL DEFAULT 0.5,
    access_count  INTEGER NOT NULL DEFAULT 0,
    metadata      TEXT,              -- JSON
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE INDEX idx_memories_category ON memories(category);
CREATE INDEX idx_memories_importance ON memories(importance DESC);

-- 向量索引（sqlite-vec 扩展）
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
    id        TEXT PRIMARY KEY,
    embedding FLOAT[1536]            -- OpenAI text-embedding-3-small 维度
);
```

## 4. 短期记忆：ShortTermMemory

### 4.1 核心设计

纯内存实现，按 session_id 隔离，支持 token 预算和自动压缩。

```python
class ShortTermMemory:
    """会话级记忆 — 纯内存，快速读写"""

    def __init__(self, max_messages: int = 200):
        self._sessions: dict[str, list[MemoryEntry]] = {}
        self._summaries: dict[str, str] = {}       # 压缩后的摘要
        self._max_messages = max_messages

    def add(self, session_id: str, entry: MemoryEntry):
        """追加一条记忆"""
        entries = self._sessions.setdefault(session_id, [])
        entries.append(entry)
        if len(entries) > self._max_messages:
            self._compact(session_id)

    def get_recent(self, session_id: str, limit: int = 50) -> list[MemoryEntry]:
        """获取最近 N 条"""
        return self._sessions.get(session_id, [])[-limit:]

    def get_context_window(
        self, session_id: str, max_tokens: int = 8000
    ) -> ContextWindow:
        """按 token 预算获取上下文（从最近往前取）"""
        entries = self._sessions.get(session_id, [])
        result = []
        token_count = 0

        for entry in reversed(entries):
            token_count += entry.token_count
            if token_count > max_tokens:
                break
            result.append(entry)

        summary = self._summaries.get(session_id)
        return ContextWindow(
            summary=summary,                # 早期对话的摘要（如果有）
            messages=list(reversed(result)), # 最近的完整消息
            total_tokens=token_count,
        )

    def get_all(self, session_id: str) -> list[MemoryEntry]:
        """获取全部（沉淀器使用）"""
        return self._sessions.get(session_id, [])

    def clear(self, session_id: str):
        """清除会话记忆"""
        self._sessions.pop(session_id, None)
        self._summaries.pop(session_id, None)
```

### 4.2 自动压缩

当消息数超过上限时，用 LLM 将前半段总结成一条摘要：

```python
    async def _compact(self, session_id: str):
        """压缩：前半段总结为 summary，保留后半段完整消息"""
        entries = self._sessions[session_id]
        midpoint = len(entries) // 2
        old_entries = entries[:midpoint]

        # LLM 生成摘要
        summary = await self._summarize(old_entries)

        # 如果已有旧摘要，合并
        existing_summary = self._summaries.get(session_id, "")
        if existing_summary:
            summary = f"{existing_summary}\n\n{summary}"

        self._summaries[session_id] = summary
        self._sessions[session_id] = entries[midpoint:]

    SUMMARIZE_PROMPT = """
    将以下对话历史压缩为简洁的摘要，保留：
    1. 用户的核心意图和目标
    2. 已完成的关键操作和结果
    3. 重要的决策和上下文
    4. 未解决的问题

    不要保留寒暄、重复内容、中间调试过程。
    """
```

### 4.3 token 预算策略

不同模型上下文窗口不同，token 预算需要动态调整：

```python
# 预算分配策略
CONTEXT_BUDGET = {
    "system_prompt": 0.15,       # 15% 给系统提示词
    "long_term_memory": 0.15,    # 15% 给长期记忆检索结果
    "short_term_memory": 0.50,   # 50% 给短期记忆（对话历史）
    "response_reserve": 0.20,    # 20% 预留给模型生成响应
}

def calculate_budget(model: str) -> dict[str, int]:
    """根据模型计算各部分 token 预算"""
    total = MODEL_CONTEXT_WINDOWS.get(model, 8192)
    return {
        key: int(total * ratio)
        for key, ratio in CONTEXT_BUDGET.items()
    }
```

## 5. 长期记忆：LongTermMemory

### 5.1 核心设计

SQLite + sqlite-vec，支持语义检索 + 综合评分排序。

```python
class LongTermMemory:
    """持久化记忆 — SQLite + 向量检索"""

    def __init__(self, db: sqlite3.Connection, embedder: EmbeddingProvider):
        self._db = db
        self._embedder = embedder
        self._embedding_cache = LRUCache(maxsize=1000)

    async def store(
        self,
        content: str,
        category: MemoryCategory,
        importance: float = 0.5,
        metadata: dict | None = None,
    ) -> str:
        """存储一条长期记忆"""
        memory_id = str(uuid4())
        embedding = await self._get_embedding(content)

        self._db.execute(
            "INSERT INTO memories (id, content, category, importance, metadata, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            [memory_id, content, category.value, importance,
             json.dumps(metadata), now_iso(), now_iso()]
        )
        self._db.execute(
            "INSERT INTO memory_vectors (id, embedding) VALUES (?, ?)",
            [memory_id, serialize_f32(embedding)]
        )
        self._db.commit()
        return memory_id

    async def search(
        self,
        query: str,
        limit: int = 5,
        category: MemoryCategory | None = None,
        min_importance: float = 0.0,
    ) -> list[ScoredMemory]:
        """语义搜索 + 综合评分"""
        query_embedding = await self._get_embedding(query)

        # 向量相似度检索（取 limit * 3 候选，后续再精排）
        candidates = self._vector_search(query_embedding, top_k=limit * 3)

        # 过滤
        if category:
            candidates = [c for c in candidates if c.category == category.value]
        candidates = [c for c in candidates if c.importance >= min_importance]

        # 综合评分排序
        scored = [self._score(c, query_embedding) for c in candidates]
        scored.sort(key=lambda x: x.final_score, reverse=True)
        result = scored[:limit]

        # 更新访问计数
        for item in result:
            self._db.execute(
                "UPDATE memories SET access_count = access_count + 1, updated_at = ? WHERE id = ?",
                [now_iso(), item.memory.id]
            )
        self._db.commit()

        return result
```

### 5.2 综合评分算法

```python
    def _score(self, memory: MemoryRow, query_embedding: list[float]) -> ScoredMemory:
        """
        综合评分 = 语义相似度 × 0.6 + 重要性 × 0.25 + 时间衰减 × 0.15

        - 语义相似度：cosine similarity，衡量内容相关性
        - 重要性：0-1，由沉淀器评估或手动设置
        - 时间衰减：越近的记忆权重越高，半衰期 30 天
        """
        similarity = cosine_similarity(memory.embedding, query_embedding)
        time_decay = self._time_decay(memory.updated_at, half_life_days=30)

        final_score = (
            similarity * 0.6
            + memory.importance * 0.25
            + time_decay * 0.15
        )

        return ScoredMemory(memory=memory, similarity=similarity, final_score=final_score)

    def _time_decay(self, updated_at: str, half_life_days: int = 30) -> float:
        """时间衰减函数：指数衰减，半衰期 30 天"""
        age_days = (datetime.now(timezone.utc) - parse_iso(updated_at)).days
        return 0.5 ** (age_days / half_life_days)
```

### 5.3 向量检索实现

```python
    def _vector_search(self, query_embedding: list[float], top_k: int = 15) -> list[MemoryRow]:
        """sqlite-vec 向量近邻搜索"""
        rows = self._db.execute(
            """
            SELECT m.*, v.distance
            FROM memory_vectors v
            JOIN memories m ON m.id = v.id
            WHERE v.embedding MATCH ?
              AND k = ?
            ORDER BY v.distance
            """,
            [serialize_f32(query_embedding), top_k]
        ).fetchall()

        return [MemoryRow.from_row(row) for row in rows]

    async def _get_embedding(self, text: str) -> list[float]:
        """获取文本向量，带 LRU 缓存"""
        cache_key = hashlib.md5(text.encode()).hexdigest()
        cached = self._embedding_cache.get(cache_key)
        if cached is not None:
            return cached

        embedding = await self._embedder.embed(text)
        self._embedding_cache.put(cache_key, embedding)
        return embedding
```

## 6. 沉淀器：MemoryConsolidator

### 6.1 核心设计

会话结束时，用 LLM 从短期记忆中提取有价值的内容，沉淀到长期记忆。

```python
class MemoryConsolidator:
    """记忆沉淀器 — 短期 → 长期"""

    MIN_MESSAGES_TO_CONSOLIDATE = 3   # 太短的会话不沉淀

    EXTRACTION_PROMPT = """
    分析以下对话历史，提取值得长期记住的信息。

    只提取以下类型：
    1. knowledge — 用户教给你的事实、规则（"我们用 PostgreSQL 16"）
    2. preference — 用户的习惯和偏好（"代码注释用中文"、"不要用 class 组件"）
    3. project — 项目相关的上下文（"API 前缀是 /api/v2"、"用 monorepo 结构"）
    4. skill — 成功解决问题的可复用模式（"这个项目的部署流程是..."）

    对每条提取的记忆，给出 importance 评分（0-1）：
    - 0.8-1.0：明确的规则或强偏好（"禁止使用 any 类型"）
    - 0.5-0.7：有用的上下文（"这个项目用 FastAPI"）
    - 0.2-0.4：可能有用的细节

    如果没有值得记住的内容，返回空列表。

    输出 JSON 格式：
    [
      {"content": "...", "category": "knowledge|preference|project|skill", "importance": 0.8},
      ...
    ]
    """

    def __init__(
        self,
        short_term: ShortTermMemory,
        long_term: LongTermMemory,
        llm: LLMProvider,
    ):
        self._short_term = short_term
        self._long_term = long_term
        self._llm = llm

    async def consolidate(self, session_id: str):
        """会话结束时触发沉淀"""
        entries = self._short_term.get_all(session_id)

        if len(entries) < self.MIN_MESSAGES_TO_CONSOLIDATE:
            return

        # 1. LLM 提取有价值的记忆
        extracted = await self._extract(entries)

        # 2. 逐条去重并存储
        for item in extracted:
            await self._store_with_dedup(item, session_id)

    async def _extract(self, entries: list[MemoryEntry]) -> list[ExtractedMemory]:
        """用 LLM 从对话中提取记忆"""
        conversation = "\n".join(
            f"[{e.role}] {e.content}" for e in entries
        )

        response = await self._llm.generate(
            system=self.EXTRACTION_PROMPT,
            user=conversation,
            response_format="json",
        )

        return [ExtractedMemory(**item) for item in json.loads(response)]

    async def _store_with_dedup(self, item: ExtractedMemory, session_id: str):
        """去重存储：相似度 > 0.9 的视为重复，合并重要性"""
        existing = await self._long_term.search(
            item.content, limit=1, category=MemoryCategory(item.category)
        )

        if existing and existing[0].similarity > 0.9:
            # 已有相似记忆 → 更新重要性（取较高值）
            memory = existing[0].memory
            new_importance = max(memory.importance, item.importance)
            self._long_term.update_importance(memory.id, new_importance)
        else:
            # 新记忆 → 存储
            await self._long_term.store(
                content=item.content,
                category=MemoryCategory(item.category),
                importance=item.importance,
                metadata={"source_session": session_id},
            )
```

### 6.2 沉淀触发时机

```python
# 在 engine.py 中
class SemibotEngine:

    async def end_session(self, session_id: str):
        """结束会话，触发记忆沉淀"""
        # 1. 沉淀有价值的记忆
        await self.consolidator.consolidate(session_id)

        # 2. 可选：持久化消息历史到 SQLite（用于回顾）
        if self.config.persist_messages:
            self._persist_messages(session_id)

        # 3. 清理短期记忆
        self.memory.short_term.clear(session_id)
```

## 7. MemoryManager：统一入口

```python
class MemoryManager:
    """记忆系统统一入口"""

    def __init__(self, storage: Storage, embedder: EmbeddingProvider, llm: LLMProvider):
        self.short_term = ShortTermMemory(max_messages=200)
        self.long_term = LongTermMemory(db=storage.db, embedder=embedder)
        self.consolidator = MemoryConsolidator(
            short_term=self.short_term,
            long_term=self.long_term,
            llm=llm,
        )

    async def build_context(self, session_id: str, query: str, model: str) -> AgentContext:
        """为 Orchestrator 构建完整上下文"""
        budget = calculate_budget(model)

        # 1. 短期：按 token 预算取最近对话
        context_window = self.short_term.get_context_window(
            session_id, max_tokens=budget["short_term_memory"]
        )

        # 2. 长期：语义检索相关记忆
        relevant_memories = await self.long_term.search(
            query, limit=5
        )

        # 3. 格式化为 Orchestrator 可用的上下文
        return AgentContext(
            summary=context_window.summary,
            recent_messages=context_window.messages,
            relevant_memories=[m.memory.content for m in relevant_memories],
            token_budget_remaining=budget["response_reserve"],
        )

    def add_message(self, session_id: str, role: str, content: str, **kwargs):
        """添加消息到短期记忆"""
        entry = MemoryEntry(
            id=str(uuid4()),
            role=role,
            content=content,
            tool_calls=kwargs.get("tool_calls"),
            token_count=estimate_tokens(content),
            timestamp=time.time(),
            metadata=kwargs.get("metadata"),
        )
        self.short_term.add(session_id, entry)

    async def end_session(self, session_id: str):
        """结束会话，触发沉淀"""
        await self.consolidator.consolidate(session_id)
        self.short_term.clear(session_id)
```

## 8. 在 Orchestrator 中的集成

```python
# orchestrator/nodes.py

async def start_node(state: AgentState) -> AgentState:
    """初始化节点：加载记忆上下文"""
    query = state.messages[-1].content
    context = await memory_manager.build_context(
        session_id=state.session_id,
        query=query,
        model=state.model,
    )
    return {**state, context: context}

async def respond_node(state: AgentState) -> AgentState:
    """响应节点：存储到短期记忆"""
    memory_manager.add_message(
        session_id=state.session_id,
        role="assistant",
        content=state.response,
        tool_calls=state.tool_results,
    )
    return state
```

## 9. Embedding 提供者

```python
class EmbeddingProvider(ABC):
    """向量化接口"""

    @abstractmethod
    async def embed(self, text: str) -> list[float]:
        pass

    @abstractmethod
    def dimension(self) -> int:
        pass

class OpenAIEmbedding(EmbeddingProvider):
    """OpenAI text-embedding-3-small"""

    def __init__(self, api_key: str):
        self._client = AsyncOpenAI(api_key=api_key)

    async def embed(self, text: str) -> list[float]:
        response = await self._client.embeddings.create(
            model="text-embedding-3-small",
            input=text,
        )
        return response.data[0].embedding

    def dimension(self) -> int:
        return 1536

class OllamaEmbedding(EmbeddingProvider):
    """本地 Ollama 向量化（离线可用）"""

    async def embed(self, text: str) -> list[float]:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self.base_url}/api/embeddings",
                json={"model": self.model, "prompt": text},
            )
            return resp.json()["embedding"]

    def dimension(self) -> int:
        return 768  # nomic-embed-text 默认维度
```

## 10. 记忆维护

### 10.1 自动清理

```python
class MemoryMaintenance:
    """定期维护长期记忆"""

    async def cleanup(self, max_memories: int = 10000):
        """清理低价值记忆"""
        count = self._db.execute("SELECT COUNT(*) FROM memories").fetchone()[0]

        if count <= max_memories:
            return

        # 删除低重要性 + 长期未访问的记忆
        overflow = count - max_memories
        self._db.execute("""
            DELETE FROM memories WHERE id IN (
                SELECT id FROM memories
                ORDER BY importance ASC, updated_at ASC
                LIMIT ?
            )
        """, [overflow])
        # 同步清理向量索引
        self._db.execute("""
            DELETE FROM memory_vectors WHERE id NOT IN (
                SELECT id FROM memories
            )
        """)
        self._db.commit()
```

### 10.2 手动管理

```python
# CLI 命令
@cli.group()
def memory():
    """记忆管理"""
    pass

@memory.command()
@click.argument('query')
@click.option('--limit', default=10)
def search(query, limit):
    """搜索长期记忆"""
    results = engine.memory.long_term.search(query, limit=limit)
    for r in results:
        click.echo(f"[{r.memory.category}] (重要性:{r.memory.importance:.1f}) {r.memory.content}")

@memory.command()
@click.argument('memory_id')
def delete(memory_id):
    """删除指定记忆"""
    engine.memory.long_term.delete(memory_id)
    click.echo(f"已删除记忆 {memory_id}")

@memory.command()
def stats():
    """记忆统计"""
    stats = engine.memory.long_term.get_stats()
    click.echo(f"总记忆数: {stats['total']}")
    for cat, count in stats['by_category'].items():
        click.echo(f"  {cat}: {count}")
```

## 11. 与 Event Engine 的集成

### 11.1 沉淀器由事件触发

当前设计中沉淀器硬编码在 `end_session` 里。重构后改为事件驱动：

```python
# 会话结束时发出事件
event_bus.emit(Event(
    event_type="session.ended",
    source="system",
    subject=f"session:{session_id}",
    payload={"message_count": len(entries)},
))

# 规则配置
{
    "name": "consolidate_on_session_end",
    "event_type": "session.ended",
    "conditions": { "all": [
        { "field": "payload.message_count", "op": ">=", "value": 3 }
    ]},
    "action_mode": "auto",
    "actions": [{ "action_type": "run_agent", "target": "memory_consolidator" }],
    "risk_level": "low"
}
```

好处：沉淀逻辑可通过规则配置调整（最小消息数、是否启用），无需改代码。

### 11.2 重要记忆写入事件

当沉淀器存入高重要性记忆时，发出 `memory.write.important` 事件：

```python
async def store(self, content, category, importance, ...):
    memory_id = await self._do_store(...)

    if importance >= 0.8:
        event_bus.emit(Event(
            event_type="memory.write.important",
            source="memory",
            subject=f"memory:{memory_id}",
            payload={
                "content": content,
                "category": category,
                "importance": importance,
            },
        ))

    return memory_id
```

下游规则可基于此事件触发通知（如"学到了新的项目规则"）或触发技能进化候选检查。

### 11.3 记忆分类扩展

长期记忆的 `category` 保持现有四类不变：

| 类别 | 说明 |
|------|------|
| `knowledge` | 事实、规则 |
| `preference` | 用户偏好、习惯 |
| `skill` | 成功解决问题的模式 |
| `project` | 项目上下文、架构决策 |

事件本身不作为记忆类别存储——事件有独立的 `events` 表。但沉淀器可以从事件执行结果中提取 `skill` 类记忆（比如"这个规则配置解决了 X 问题"）。

## 12. 向量检索方案对比

| 方案 | 优点 | 缺点 | 推荐场景 |
|------|------|------|---------|
| **sqlite-vec** | 零依赖，与 SQLite 一体，单文件 | 生态较新，ANN 精度一般 | 默认方案，追求极简 |
| **ChromaDB** | Python 原生，API 友好，支持元数据过滤 | 多一个依赖，独立存储目录 | 记忆量大（万级以上） |
| **内存 FAISS + JSON 持久化** | 最快，无外部依赖 | 数据量受内存限制，无持久化保障 | 记忆量小（千级以内） |

推荐 **sqlite-vec** 作为默认方案：与业务数据共用一个 SQLite 文件，真正做到单文件存储、零配置。
