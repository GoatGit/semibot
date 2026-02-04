# 数据模型设计

## 1. ER 图

```
┌─────────────┐       ┌─────────────┐       ┌─────────────┐
│   agents    │       │   skills    │       │    tools    │
├─────────────┤       ├─────────────┤       ├─────────────┤
│ id (PK)     │       │ id (PK)     │       │ id (PK)     │
│ name        │──┐    │ name        │──┐    │ name        │
│ description │  │    │ description │  │    │ type        │
│ system_prompt│ │    │ trigger_kw  │  │    │ schema      │
│ config      │  │    │ tools       │──┼────│ impl        │
│ skills[]    │──┼────│             │  │    │             │
│ sub_agents[]│  │    └─────────────┘  │    └─────────────┘
│ created_at  │  │                     │
│ updated_at  │  │                     │
└─────────────┘  │                     │
       │         │                     │
       │         └─────────────────────┘
       │
       ▼
┌─────────────┐       ┌─────────────┐       ┌─────────────┐
│  sessions   │       │  messages   │       │  memories   │
├─────────────┤       ├─────────────┤       ├─────────────┤
│ id (PK)     │       │ id (PK)     │       │ id (PK)     │
│ agent_id(FK)│───────│ session_id  │       │ agent_id(FK)│
│ user_id     │       │ role        │       │ content     │
│ status      │       │ content     │       │ embedding   │
│ metadata    │       │ tool_calls  │       │ metadata    │
│ created_at  │       │ metadata    │       │ created_at  │
└─────────────┘       │ created_at  │       └─────────────┘
                      └─────────────┘
```

## 2. 表结构定义

### 2.1 agents - 智能体定义

```sql
CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    system_prompt TEXT NOT NULL,
    config JSONB DEFAULT '{
        "model": "gpt-4o",
        "temperature": 0.7,
        "max_tokens": 4096,
        "timeout_seconds": 120
    }',
    skills TEXT[] DEFAULT '{}',
    sub_agents TEXT[] DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_agents_name ON agents(name);
CREATE INDEX idx_agents_active ON agents(is_active) WHERE is_active = true;

-- 更新时间触发器
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agents_updated_at
    BEFORE UPDATE ON agents
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| name | VARCHAR(100) | Agent 名称 |
| description | TEXT | 描述信息 |
| system_prompt | TEXT | 系统提示词，定义 Agent 角色和行为 |
| config | JSONB | 模型配置（模型名、温度、token限制等） |
| skills | TEXT[] | 关联的技能 ID 列表 |
| sub_agents | TEXT[] | 子 Agent ID 列表 |
| is_active | BOOLEAN | 是否启用 |

**config 结构**:

```json
{
    "model": "gpt-4o",
    "temperature": 0.7,
    "max_tokens": 4096,
    "timeout_seconds": 120,
    "retry_attempts": 3,
    "fallback_model": "gpt-4o-mini"
}
```

### 2.2 skills - 技能定义

```sql
CREATE TABLE skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    trigger_keywords TEXT[] DEFAULT '{}',
    tools JSONB NOT NULL DEFAULT '[]',
    config JSONB DEFAULT '{}',
    is_builtin BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_skills_name ON skills(name);
CREATE INDEX idx_skills_builtin ON skills(is_builtin);

CREATE TRIGGER skills_updated_at
    BEFORE UPDATE ON skills
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| name | VARCHAR(100) | 技能名称（唯一） |
| description | TEXT | 技能描述 |
| trigger_keywords | TEXT[] | 触发关键词 |
| tools | JSONB | 工具配置列表 |
| config | JSONB | 技能配置 |
| is_builtin | BOOLEAN | 是否内置技能 |

**tools 结构**:

```json
[
    {
        "tool_id": "uuid",
        "required": true,
        "default_params": {}
    }
]
```

### 2.3 tools - 工具定义

```sql
CREATE TABLE tools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE,
    type VARCHAR(50) NOT NULL CHECK (type IN ('api', 'code', 'query', 'mcp')),
    description TEXT,
    schema JSONB NOT NULL,
    implementation JSONB NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tools_name ON tools(name);
CREATE INDEX idx_tools_type ON tools(type);

CREATE TRIGGER tools_updated_at
    BEFORE UPDATE ON tools
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| name | VARCHAR(100) | 工具名称（唯一） |
| type | VARCHAR(50) | 工具类型：api/code/query/mcp |
| description | TEXT | 工具描述 |
| schema | JSONB | OpenAPI 风格的参数定义 |
| implementation | JSONB | 执行配置 |

**schema 结构** (OpenAI Function Calling 格式):

```json
{
    "name": "search_web",
    "description": "Search the web for information",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search query"
            },
            "limit": {
                "type": "integer",
                "default": 10
            }
        },
        "required": ["query"]
    }
}
```

**implementation 结构**:

```json
// API 类型
{
    "type": "api",
    "endpoint": "https://api.example.com/search",
    "method": "POST",
    "headers": {
        "Authorization": "Bearer ${API_KEY}"
    },
    "body_template": {
        "q": "{{query}}",
        "num": "{{limit}}"
    }
}

// Code 类型
{
    "type": "code",
    "runtime": "python",
    "code": "def execute(query, limit=10):\n    return search_results"
}

// Query 类型
{
    "type": "query",
    "database": "main",
    "sql_template": "SELECT * FROM data WHERE content ILIKE '%{{query}}%' LIMIT {{limit}}"
}
```

### 2.4 sessions - 会话

```sql
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    user_id VARCHAR(100) NOT NULL,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'failed')),
    title VARCHAR(200),
    metadata JSONB DEFAULT '{}',
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sessions_agent ON sessions(agent_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_created ON sessions(created_at DESC);
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| agent_id | UUID | 关联的 Agent |
| user_id | VARCHAR(100) | 用户标识 |
| status | VARCHAR(20) | 会话状态 |
| title | VARCHAR(200) | 会话标题（自动生成） |
| metadata | JSONB | 元数据 |

### 2.5 messages - 消息历史

```sql
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES messages(id),
    role VARCHAR(20) NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    tool_calls JSONB,
    tool_call_id VARCHAR(100),
    tokens_used INTEGER,
    latency_ms INTEGER,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_messages_created ON messages(session_id, created_at);
CREATE INDEX idx_messages_role ON messages(role);
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| session_id | UUID | 关联的会话 |
| parent_id | UUID | 父消息（用于分支对话） |
| role | VARCHAR(20) | 角色：system/user/assistant/tool |
| content | TEXT | 消息内容 |
| tool_calls | JSONB | 工具调用信息 |
| tool_call_id | VARCHAR(100) | 工具调用 ID（tool 角色使用） |
| tokens_used | INTEGER | 消耗的 token 数 |
| latency_ms | INTEGER | 响应延迟（毫秒） |

**tool_calls 结构**:

```json
[
    {
        "id": "call_abc123",
        "type": "function",
        "function": {
            "name": "search_web",
            "arguments": "{\"query\": \"AI agents\"}"
        }
    }
]
```

### 2.6 memories - 向量记忆

```sql
-- 启用 pgvector 扩展
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    embedding VECTOR(1536),  -- OpenAI text-embedding-ada-002
    memory_type VARCHAR(50) DEFAULT 'episodic' CHECK (memory_type IN ('episodic', 'semantic', 'procedural')),
    importance FLOAT DEFAULT 0.5,
    metadata JSONB DEFAULT '{}',
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 向量索引 (IVFFlat for faster search)
CREATE INDEX idx_memories_embedding ON memories
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

CREATE INDEX idx_memories_agent ON memories(agent_id);
CREATE INDEX idx_memories_type ON memories(memory_type);
CREATE INDEX idx_memories_importance ON memories(importance DESC);
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| agent_id | UUID | 关联的 Agent |
| session_id | UUID | 来源会话（可选） |
| content | TEXT | 记忆内容 |
| embedding | VECTOR(1536) | 向量表示 |
| memory_type | VARCHAR(50) | 记忆类型：episodic/semantic/procedural |
| importance | FLOAT | 重要性评分 (0-1) |
| expires_at | TIMESTAMPTZ | 过期时间（可选） |

**记忆类型说明**:

- **episodic**: 情节记忆，特定事件和对话
- **semantic**: 语义记忆，事实和知识
- **procedural**: 程序记忆，如何执行任务

## 3. 查询示例

### 3.1 获取 Agent 完整配置

```sql
SELECT
    a.*,
    COALESCE(
        (SELECT jsonb_agg(s.*) FROM skills s WHERE s.id::text = ANY(a.skills)),
        '[]'::jsonb
    ) as skill_details,
    COALESCE(
        (SELECT jsonb_agg(sub.*) FROM agents sub WHERE sub.id::text = ANY(a.sub_agents)),
        '[]'::jsonb
    ) as sub_agent_details
FROM agents a
WHERE a.id = $1;
```

### 3.2 获取会话历史

```sql
SELECT
    m.id,
    m.role,
    m.content,
    m.tool_calls,
    m.created_at
FROM messages m
WHERE m.session_id = $1
ORDER BY m.created_at ASC;
```

### 3.3 相似记忆检索

```sql
SELECT
    id,
    content,
    memory_type,
    importance,
    1 - (embedding <=> $1) as similarity
FROM memories
WHERE agent_id = $2
    AND (expires_at IS NULL OR expires_at > NOW())
ORDER BY embedding <=> $1
LIMIT 10;
```

## 4. 数据迁移

迁移文件位于 `infra/migrations/` 目录：

```
migrations/
├── 001_init.sql           # 初始化扩展和函数
├── 002_agents.sql         # agents 表
├── 003_skills.sql         # skills 表
├── 004_tools.sql          # tools 表
├── 005_sessions.sql       # sessions 表
├── 006_messages.sql       # messages 表
└── 007_memories.sql       # memories 表
```
