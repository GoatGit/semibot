# Runtime 模块全面审查 PRD

## 概述

对 `runtime/` 目录进行全面代码审查，识别功能完整性、逻辑冲突、边界/异常处理、测试覆盖等方面的问题。

## 审查范围

- `runtime/src/agents/` - Agent 基类和实现
- `runtime/src/llm/` - LLM Provider 实现
- `runtime/src/orchestrator/` - LangGraph 状态机
- `runtime/src/memory/` - 内存系统
- `runtime/src/queue/` - Redis 队列
- `runtime/src/skills/` - 技能和工具系统
- `runtime/src/utils/` - 工具函数
- `runtime/src/constants/` - 常量配置
- `runtime/tests/` - 测试用例

---

## 问题分类

### 1. 功能不完整

#### 1.1 constants/config.py 缺少 Memory 模块常量
**严重程度**: 高
**位置**: `src/constants/config.py`
**描述**: config.py 只包含 Queue 模块的常量，但 Memory 模块（short_term.py, long_term.py, embedding.py）引用了大量未定义的常量。

缺失常量列表：
- `DEFAULT_TTL_SECONDS`
- `MAX_SESSION_ENTRIES`
- `REDIS_KEY_PREFIX`
- `REDIS_MAX_RETRIES`
- `REDIS_RETRY_DELAY_BASE`
- `REDIS_RETRY_DELAY_MAX`
- `DEFAULT_MIN_SIMILARITY`
- `DEFAULT_SEARCH_LIMIT`
- `EMBEDDING_DIMENSION`
- `MAX_SEARCH_LIMIT`
- `PG_MAX_RETRIES`
- `PG_POOL_ACQUIRE_TIMEOUT`
- `PG_POOL_MAX_SIZE`
- `PG_POOL_MIN_SIZE`
- `PG_RETRY_DELAY_BASE`
- `PG_RETRY_DELAY_MAX`
- `DEFAULT_EMBEDDING_MODEL`
- `EMBEDDING_BATCH_SIZE`
- `EMBEDDING_CACHE_PREFIX`
- `EMBEDDING_CACHE_TTL`
- `EMBEDDING_MAX_RETRIES`
- `EMBEDDING_REQUEST_TIMEOUT`
- `EMBEDDING_RETRY_DELAY_BASE`
- `EMBEDDING_RETRY_DELAY_MAX`

#### 1.2 缺少 Agents 模块测试
**严重程度**: 高
**位置**: `tests/` 目录
**描述**: 没有针对 `agents/base.py`, `agents/executor.py`, `agents/planner.py` 的测试文件。

#### 1.3 缺少 Orchestrator 模块测试
**严重程度**: 高
**位置**: `tests/` 目录
**描述**: 没有针对 `orchestrator/graph.py`, `orchestrator/nodes.py`, `orchestrator/edges.py`, `orchestrator/state.py` 的测试文件。

#### 1.4 缺少 LLM 模块测试
**严重程度**: 高
**位置**: `tests/` 目录
**描述**: 没有针对 `llm/base.py`, `llm/router.py`, `llm/openai_provider.py`, `llm/anthropic_provider.py` 的测试文件。

#### 1.5 缺少 Skills 模块测试
**严重程度**: 中
**位置**: `tests/` 目录
**描述**: 没有针对 `skills/base.py`, `skills/registry.py`, `skills/code_executor.py`, `skills/web_search.py` 的测试文件。

#### 1.6 缺少 SubAgent Delegator 实现
**严重程度**: 中
**位置**: `src/orchestrator/nodes.py`
**描述**: `delegate_node` 依赖 `sub_agent_delegator` 但没有实现该组件。

---

### 2. 逻辑处理冲突

#### 2.1 AgentState 使用 TypedDict 但 nodes.py 使用 dict 更新方式
**严重程度**: 中
**位置**: `src/orchestrator/state.py`, `src/orchestrator/nodes.py`
**描述**: `AgentState` 是 TypedDict，但各 node 函数返回 `{**state, ...}` 的字典展开方式可能导致类型不一致。应确保返回值符合 LangGraph 的状态更新模式。

#### 2.2 _build_planning_prompt 函数未被使用
**严重程度**: 低
**位置**: `src/orchestrator/nodes.py:500-525`
**描述**: `_build_planning_prompt` 函数被定义但在 `plan_node` 中调用后结果未被使用（第126行调用但结果赋值给 `planning_prompt` 后从未使用）。

#### 2.3 PlannerAgent 和 plan_node 功能重复
**严重程度**: 中
**位置**: `src/agents/planner.py`, `src/orchestrator/nodes.py`
**描述**: `PlannerAgent` 类和 `plan_node` 函数实现了几乎相同的规划逻辑，造成代码冗余。需要明确架构：是使用 Agent 类还是直接使用 node 函数。

#### 2.4 ExecutorAgent 和 act_node 功能重复
**严重程度**: 中
**位置**: `src/agents/executor.py`, `src/orchestrator/nodes.py`
**描述**: `ExecutorAgent` 类和 `act_node` 函数实现了几乎相同的执行逻辑，造成代码冗余。

---

### 3. 边界/异常处理问题

#### 3.1 LLM Provider 未处理空消息列表
**严重程度**: 中
**位置**: `src/llm/openai_provider.py`, `src/llm/anthropic_provider.py`
**描述**: `chat` 方法未验证 `messages` 参数是否为空列表，空列表会导致 API 调用失败。

#### 3.2 observe_node 边界条件处理不完整
**严重程度**: 中
**位置**: `src/orchestrator/nodes.py:354-370`
**描述**:
```python
if plan and plan.current_step_index < len(plan.steps) - 1:
```
当 `plan.steps` 为空时，`len(plan.steps) - 1 = -1`，条件 `0 < -1` 永远为 False。逻辑正确但不直观，应添加显式空检查。

#### 3.3 ShortTermMemory.save 中的竞态条件
**严重程度**: 中
**位置**: `src/memory/short_term.py:203-212`
**描述**:
```python
entry_count = await client.zcard(session_key)
if entry_count >= MAX_SESSION_ENTRIES:
    ...
    pipe.zremrangebyrank(session_key, 0, -MAX_SESSION_ENTRIES - 1)
```
`zcard` 在 pipeline 外执行，存在竞态条件。应该将检查移到 pipeline 内部或使用 Lua 脚本。

#### 3.4 LongTermMemory.search 中 _update_access 异步调用问题
**严重程度**: 低
**位置**: `src/memory/long_term.py:408`
**描述**:
```python
await self._update_access(str(row["id"]))
```
在循环中逐个 await，应该使用 `asyncio.gather` 并行执行或使用后台任务。

#### 3.5 EmbeddingService 缓存关闭时未关闭
**严重程度**: 低
**位置**: `src/memory/embedding.py:602-605`
**描述**: `EmbeddingService.close()` 只关闭 provider，未关闭 cache。

#### 3.6 TaskConsumer signal handler 问题
**严重程度**: 低
**位置**: `src/queue/consumer.py:191-193`
**描述**:
```python
loop.add_signal_handler(sig, lambda: asyncio.create_task(self.stop()))
```
Lambda 捕获可能导致问题，且在某些平台（Windows）上 signal handler 不可用。

---

### 4. 常量硬编码问题

#### 4.1 LLM Provider 硬编码重试参数
**严重程度**: 中
**位置**: `src/llm/openai_provider.py:51-54`, `src/llm/anthropic_provider.py:50-53`
**描述**:
```python
@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10),
)
```
重试次数 `3`、等待时间 `1-10` 秒应提取为常量。

#### 4.2 observe_node 硬编码迭代限制
**严重程度**: 中
**位置**: `src/orchestrator/nodes.py:346`
**描述**:
```python
if all_failed and current_iteration < 3:
```
魔法数字 `3` 应提取为常量。

#### 4.3 LLM Router 硬编码模型映射
**严重程度**: 低
**位置**: `src/llm/router.py:65-70`
**描述**:
```python
self.task_routing = task_routing or {
    "planning": "gpt-4o",
    "execution": "gpt-4o-mini",
    ...
}
```
默认模型映射应提取为常量配置。

---

### 5. 测试覆盖不足

#### 5.1 Memory 模块测试缺少集成测试
**严重程度**: 中
**位置**: `tests/memory/`
**描述**: 现有测试为单元测试，缺少 Redis 和 PostgreSQL 的集成测试。

#### 5.2 Queue 模块测试覆盖不完整
**严重程度**: 中
**位置**: `tests/queue/`
**描述**: 缺少以下场景测试：
- 队列满时的背压处理
- 死信队列重试逻辑
- 并发消费者竞争

#### 5.3 缺少端到端测试
**严重程度**: 高
**位置**: `tests/`
**描述**: 没有完整的 Agent 执行流程端到端测试。

---

### 6. 其他问题

#### 6.1 缺少类型导出
**严重程度**: 低
**位置**: 各 `__init__.py` 文件
**描述**: 多数 `__init__.py` 为空或只导入部分类型，应完善导出列表。

#### 6.2 日志不一致
**严重程度**: 低
**位置**: 多个文件
**描述**: 部分文件使用 `logging.getLogger(__name__)`，部分使用 `src.utils.logging.get_logger`。应统一使用 structlog。

#### 6.3 缺少配置文件示例
**严重程度**: 低
**位置**: `runtime/` 根目录
**描述**: 缺少 `.env.example` 或配置文件示例，不便于开发者快速上手。

#### 6.4 pyproject.toml 依赖可能缺失
**严重程度**: 中
**位置**: `runtime/pyproject.toml`
**描述**: 需要验证 asyncpg、httpx、structlog、tenacity 等依赖是否已声明。

---

## 优先级排序

1. **P0 - 阻塞性问题**
   - 1.1 constants/config.py 缺少 Memory 模块常量（会导致导入错误）

2. **P1 - 高优先级**
   - 1.2-1.5 缺少测试覆盖
   - 5.3 缺少端到端测试
   - 3.1 LLM Provider 未处理空消息列表

3. **P2 - 中优先级**
   - 2.3-2.4 代码重复问题
   - 3.3 ShortTermMemory 竞态条件
   - 4.1-4.2 常量硬编码问题

4. **P3 - 低优先级**
   - 2.2 未使用的函数
   - 6.1-6.3 代码规范问题
