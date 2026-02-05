# 数据模型设计

> **注意**: 本设计遵循 CLAUDE.md 规范，**禁止使用物理外键**，所有关联关系通过**逻辑外键**在代码层面约束。

## 1. ER 图

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│                              用户与租户层                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │    users     │    │ organizations│    │   api_keys   │                   │
│  ├──────────────┤    ├──────────────┤    ├──────────────┤                   │
│  │ id (PK)      │◄───│ owner_id     │    │ id (PK)      │                   │
│  │ email        │    │ id (PK)      │◄───│ org_id       │                   │
│  │ password_hash│    │ name         │    │ user_id      │───►users          │
│  │ org_id       │───►│ plan         │    │ key_hash     │                   │
│  └──────────────┘    │ quota        │    │ permissions  │                   │
│                      └──────────────┘    └──────────────┘                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Agent 核心层                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │    agents    │    │    skills    │    │    tools     │                   │
│  ├──────────────┤    ├──────────────┤    ├──────────────┤                   │
│  │ id (PK)      │    │ id (PK)      │    │ id (PK)      │                   │
│  │ org_id       │───►│ org_id       │───►│ org_id       │───►organizations  │
│  │ name         │    │ name         │    │ name         │                   │
│  │ skills[]     │───►│ tools[]      │───►│ schema       │                   │
│  │ sub_agents[] │    │ trigger_kw   │    │ impl         │                   │
│  │ version      │    └──────────────┘    └──────────────┘                   │
│  └──────────────┘                                                           │
│         │                                                                   │
│         ▼                                                                   │
│  ┌──────────────┐                                                           │
│  │agent_versions│  (版本历史)                                               │
│  └──────────────┘                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              会话与消息层                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │   sessions   │    │   messages   │    │   memories   │                   │
│  ├──────────────┤    ├──────────────┤    ├──────────────┤                   │
│  │ id (PK)      │◄───│ session_id   │    │ id (PK)      │                   │
│  │ agent_id     │───►agents         │    │ agent_id     │───►agents         │
│  │ user_id      │───►users          │    │ session_id   │───►sessions       │
│  │ org_id       │───►organizations  │    │ embedding    │                   │
│  │ status       │    │ role         │    │ memory_type  │                   │
│  └──────────────┘    │ content      │    └──────────────┘                   │
│                      └──────────────┘                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              日志与计量层                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐    ┌──────────────┐                                       │
│  │execution_logs│    │  usage_logs  │                                       │
│  ├──────────────┤    ├──────────────┤                                       │
│  │ id (PK)      │    │ id (PK)      │                                       │
│  │ org_id       │───►│ org_id       │───►organizations                      │
│  │ session_id   │───►│ user_id      │───►users                              │
│  │ agent_id     │───►│ agent_id     │───►agents                             │
│  │ state        │    │ tokens_used  │                                       │
│  │ action       │    │ api_calls    │                                       │
│  │ result       │    │ period       │                                       │
│  └──────────────┘    └──────────────┘                                       │
└─────────────────────────────────────────────────────────────────────────────┘

注：箭头表示逻辑外键关系，在应用层代码中维护数据一致性
```

## 2. 表结构定义

### 通用函数

```sql
-- 更新时间触发器函数（所有表共用）
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

---

## 2.1 用户与租户层

### 2.1.1 organizations - 组织/租户

```sql
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),       -- 组织唯一标识
    name VARCHAR(100) NOT NULL,                          -- 组织名称
    slug VARCHAR(50) NOT NULL UNIQUE,                    -- URL友好标识
    owner_id UUID NOT NULL,                              -- 创建者用户ID（逻辑外键 -> users.id）
    plan VARCHAR(20) DEFAULT 'free'                      -- 订阅计划：free/pro/enterprise
        CHECK (plan IN ('free', 'pro', 'enterprise')),
    quota JSONB DEFAULT '{                               -- 配额限制
        "max_agents": 5,
        "max_tokens_per_month": 100000,
        "max_api_calls_per_day": 1000
    }',
    settings JSONB DEFAULT '{}',                         -- 组织级设置
    is_active BOOLEAN DEFAULT true,                      -- 是否启用
    created_at TIMESTAMPTZ DEFAULT NOW(),                -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                 -- 更新时间
);

-- 索引
CREATE INDEX idx_organizations_slug ON organizations(slug);
CREATE INDEX idx_organizations_owner ON organizations(owner_id);
CREATE INDEX idx_organizations_active ON organizations(is_active) WHERE is_active = true;

-- 更新触发器
CREATE TRIGGER organizations_updated_at
    BEFORE UPDATE ON organizations
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE organizations IS '组织/租户表，支持多租户隔离';
COMMENT ON COLUMN organizations.owner_id IS '逻辑外键，关联 users.id';
```

**quota 结构**:

```json
{
    "max_agents": 5,
    "max_tokens_per_month": 100000,
    "max_api_calls_per_day": 1000,
    "max_sessions_per_day": 100,
    "max_memory_mb": 1024
}
```

### 2.1.2 users - 用户

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),       -- 用户唯一标识
    email VARCHAR(255) NOT NULL UNIQUE,                  -- 邮箱（登录账号）
    password_hash VARCHAR(255),                          -- 密码哈希（OAuth用户可为空）
    name VARCHAR(100),                                   -- 显示名称
    avatar_url VARCHAR(500),                             -- 头像URL
    org_id UUID NOT NULL,                                -- 所属组织（逻辑外键 -> organizations.id）
    role VARCHAR(20) DEFAULT 'member'                    -- 组织内角色：owner/admin/member
        CHECK (role IN ('owner', 'admin', 'member')),
    auth_provider VARCHAR(20) DEFAULT 'email'            -- 认证方式：email/google/github
        CHECK (auth_provider IN ('email', 'google', 'github')),
    auth_provider_id VARCHAR(255),                       -- 第三方认证ID
    email_verified BOOLEAN DEFAULT false,                -- 邮箱是否验证
    last_login_at TIMESTAMPTZ,                           -- 最后登录时间
    is_active BOOLEAN DEFAULT true,                      -- 是否启用
    created_at TIMESTAMPTZ DEFAULT NOW(),                -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                 -- 更新时间
);

-- 索引
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_org ON users(org_id);
CREATE INDEX idx_users_auth ON users(auth_provider, auth_provider_id);
CREATE INDEX idx_users_active ON users(is_active) WHERE is_active = true;

-- 更新触发器
CREATE TRIGGER users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE users IS '用户账户表';
COMMENT ON COLUMN users.org_id IS '逻辑外键，关联 organizations.id';
```

### 2.1.3 api_keys - API密钥

```sql
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),       -- 密钥唯一标识
    org_id UUID NOT NULL,                                -- 所属组织（逻辑外键 -> organizations.id）
    user_id UUID NOT NULL,                               -- 创建者（逻辑外键 -> users.id）
    name VARCHAR(100) NOT NULL,                          -- 密钥名称（便于识别）
    key_prefix VARCHAR(10) NOT NULL,                     -- 密钥前缀（用于显示，如 sk-abc...）
    key_hash VARCHAR(255) NOT NULL,                      -- 密钥哈希（SHA256）
    permissions JSONB DEFAULT '["*"]',                   -- 权限列表
    rate_limit INTEGER DEFAULT 60,                       -- 每分钟请求限制
    expires_at TIMESTAMPTZ,                              -- 过期时间（可选）
    last_used_at TIMESTAMPTZ,                            -- 最后使用时间
    is_active BOOLEAN DEFAULT true,                      -- 是否启用
    created_at TIMESTAMPTZ DEFAULT NOW(),                -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                 -- 更新时间
);

-- 索引
CREATE INDEX idx_api_keys_org ON api_keys(org_id);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX idx_api_keys_active ON api_keys(is_active) WHERE is_active = true;

-- 更新触发器
CREATE TRIGGER api_keys_updated_at
    BEFORE UPDATE ON api_keys
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE api_keys IS 'API密钥管理表';
COMMENT ON COLUMN api_keys.org_id IS '逻辑外键，关联 organizations.id';
COMMENT ON COLUMN api_keys.user_id IS '逻辑外键，关联 users.id';
```

**permissions 结构**:

```json
["*"]                           // 全部权限
["agents:read", "agents:write"] // 限定权限
["chat:*", "sessions:read"]     // 通配符权限
```

---

## 2.2 Agent 核心层

### 2.2.1 agents - 智能体定义

```sql
CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),       -- Agent唯一标识
    org_id UUID NOT NULL,                                -- 所属组织（逻辑外键 -> organizations.id）
    name VARCHAR(100) NOT NULL,                          -- Agent名称
    description TEXT,                                    -- 描述信息
    system_prompt TEXT NOT NULL,                         -- 系统提示词
    config JSONB DEFAULT '{                              -- 模型配置
        "model": "gpt-4o",
        "temperature": 0.7,
        "max_tokens": 4096,
        "timeout_seconds": 120
    }',
    skills TEXT[] DEFAULT '{}',                          -- 关联技能ID列表
    sub_agents TEXT[] DEFAULT '{}',                      -- 子Agent ID列表
    version INTEGER DEFAULT 1,                           -- 当前版本号
    is_active BOOLEAN DEFAULT true,                      -- 是否启用
    is_public BOOLEAN DEFAULT false,                     -- 是否公开（可被其他组织使用）
    created_at TIMESTAMPTZ DEFAULT NOW(),                -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                 -- 更新时间
);

-- 索引
CREATE INDEX idx_agents_org ON agents(org_id);
CREATE INDEX idx_agents_name ON agents(org_id, name);
CREATE INDEX idx_agents_active ON agents(is_active) WHERE is_active = true;
CREATE INDEX idx_agents_public ON agents(is_public) WHERE is_public = true;

-- 更新触发器
CREATE TRIGGER agents_updated_at
    BEFORE UPDATE ON agents
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE agents IS '智能体定义表';
COMMENT ON COLUMN agents.org_id IS '逻辑外键，关联 organizations.id';
```

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

### 2.2.2 agent_versions - Agent版本历史

```sql
CREATE TABLE agent_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),       -- 版本记录唯一标识
    agent_id UUID NOT NULL,                              -- 所属Agent（逻辑外键 -> agents.id）
    version INTEGER NOT NULL,                            -- 版本号
    system_prompt TEXT NOT NULL,                         -- 该版本的系统提示词
    config JSONB NOT NULL,                               -- 该版本的配置
    skills TEXT[] DEFAULT '{}',                          -- 该版本的技能列表
    sub_agents TEXT[] DEFAULT '{}',                      -- 该版本的子Agent列表
    change_log TEXT,                                     -- 版本变更说明
    created_by UUID,                                     -- 创建者（逻辑外键 -> users.id）
    created_at TIMESTAMPTZ DEFAULT NOW()                 -- 创建时间
);

-- 索引
CREATE INDEX idx_agent_versions_agent ON agent_versions(agent_id);
CREATE UNIQUE INDEX idx_agent_versions_unique ON agent_versions(agent_id, version);

COMMENT ON TABLE agent_versions IS 'Agent版本历史表，支持配置回滚';
COMMENT ON COLUMN agent_versions.agent_id IS '逻辑外键，关联 agents.id';
COMMENT ON COLUMN agent_versions.created_by IS '逻辑外键，关联 users.id';
```

### 2.3 skills - 技能定义

```sql
CREATE TABLE skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),       -- 技能唯一标识
    org_id UUID,                                         -- 所属组织（逻辑外键 -> organizations.id，NULL 表示系统内置）
    name VARCHAR(100) NOT NULL,                          -- 技能名称
    description TEXT,                                    -- 技能描述
    trigger_keywords TEXT[] DEFAULT '{}',                -- 触发关键词
    tools JSONB NOT NULL DEFAULT '[]',                   -- 工具配置列表
    config JSONB DEFAULT '{}',                           -- 技能配置
    is_builtin BOOLEAN DEFAULT false,                    -- 是否内置技能
    is_active BOOLEAN DEFAULT true,                      -- 是否启用
    created_by UUID,                                     -- 创建者（逻辑外键 -> users.id）
    created_at TIMESTAMPTZ DEFAULT NOW(),                -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                 -- 更新时间
);

-- 索引
CREATE INDEX idx_skills_org ON skills(org_id);
CREATE INDEX idx_skills_name ON skills(org_id, name);
CREATE INDEX idx_skills_builtin ON skills(is_builtin) WHERE is_builtin = true;
CREATE INDEX idx_skills_active ON skills(is_active) WHERE is_active = true;

-- 唯一约束：同一组织内技能名称唯一（内置技能 org_id 为 NULL 时全局唯一）
CREATE UNIQUE INDEX idx_skills_unique_name ON skills(COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

-- 更新触发器
CREATE TRIGGER skills_updated_at
    BEFORE UPDATE ON skills
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE skills IS '技能定义表，支持多租户隔离';
COMMENT ON COLUMN skills.org_id IS '逻辑外键，关联 organizations.id，NULL 表示系统内置技能';
COMMENT ON COLUMN skills.created_by IS '逻辑外键，关联 users.id';
```

**字段说明**:

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
| id | UUID | 主键 |
| org_id | UUID | 所属组织（NULL 表示系统内置） |
| name | VARCHAR(100) | 技能名称（组织内唯一） |
| description | TEXT | 技能描述 |
| trigger_keywords | TEXT[] | 触发关键词 |
| tools | JSONB | 工具配置列表 |
| config | JSONB | 技能配置 |
| is_builtin | BOOLEAN | 是否内置技能 |
| is_active | BOOLEAN | 是否启用 |
| created_by | UUID | 创建者用户 ID |

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

### 2.4 tools - 工具定义

```sql
CREATE TABLE tools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),       -- 工具唯一标识
    org_id UUID,                                         -- 所属组织（逻辑外键 -> organizations.id，NULL 表示系统内置）
    name VARCHAR(100) NOT NULL,                          -- 工具名称
    type VARCHAR(50) NOT NULL                            -- 工具类型
        CHECK (type IN ('api', 'code', 'query', 'mcp', 'browser')),
    description TEXT,                                    -- 工具描述
    schema JSONB NOT NULL,                               -- OpenAPI 风格的参数定义
    implementation JSONB NOT NULL,                       -- 执行配置
    is_builtin BOOLEAN DEFAULT false,                    -- 是否内置工具
    is_active BOOLEAN DEFAULT true,                      -- 是否启用
    created_by UUID,                                     -- 创建者（逻辑外键 -> users.id）
    created_at TIMESTAMPTZ DEFAULT NOW(),                -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                 -- 更新时间
);

-- 索引
CREATE INDEX idx_tools_org ON tools(org_id);
CREATE INDEX idx_tools_name ON tools(org_id, name);
CREATE INDEX idx_tools_type ON tools(type);
CREATE INDEX idx_tools_builtin ON tools(is_builtin) WHERE is_builtin = true;
CREATE INDEX idx_tools_active ON tools(is_active) WHERE is_active = true;

-- 唯一约束：同一组织内工具名称唯一（内置工具 org_id 为 NULL 时全局唯一）
CREATE UNIQUE INDEX idx_tools_unique_name ON tools(COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

-- 更新触发器
CREATE TRIGGER tools_updated_at
    BEFORE UPDATE ON tools
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE tools IS '工具定义表，支持多租户隔离';
COMMENT ON COLUMN tools.org_id IS '逻辑外键，关联 organizations.id，NULL 表示系统内置工具';
COMMENT ON COLUMN tools.created_by IS '逻辑外键，关联 users.id';
```

**字段说明**:

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
| id | UUID | 主键 |
| org_id | UUID | 所属组织（NULL 表示系统内置） |
| name | VARCHAR(100) | 工具名称（组织内唯一） |
| type | VARCHAR(50) | 工具类型：api/code/query/mcp/browser |
| description | TEXT | 工具描述 |
| schema | JSONB | OpenAPI 风格的参数定义 |
| implementation | JSONB | 执行配置 |
| is_builtin | BOOLEAN | 是否内置工具 |
| is_active | BOOLEAN | 是否启用 |
| created_by | UUID | 创建者用户 ID |

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

// MCP 类型 (Model Context Protocol)
{
    "type": "mcp",
    "server": "mcp-server-name",              // MCP 服务器名称
    "transport": "stdio",                      // 传输方式：stdio/sse/websocket
    "command": "npx",                          // 启动命令
    "args": ["-y", "@modelcontextprotocol/server-example"],  // 命令参数
    "env": {                                   // 环境变量
        "API_KEY": "${MCP_API_KEY}"
    },
    "tool_name": "example_tool",               // MCP 服务器提供的工具名称
    "timeout_ms": 30000                        // 调用超时时间（毫秒）
}
```

**MCP 类型说明**:

MCP (Model Context Protocol) 是一种标准化的 AI 工具集成协议，允许 Agent 调用外部 MCP 服务器提供的工具。

| 字段 | 必填 | 说明 |
| ---- | ---- | ---- |
| server | 是 | MCP 服务器标识名称 |
| transport | 是 | 传输方式：stdio（标准输入输出）、sse（服务器推送事件）、websocket |
| command | 条件 | stdio 传输时的启动命令 |
| args | 否 | 命令参数列表 |
| env | 否 | 环境变量，支持 ${VAR} 语法引用系统环境变量 |
| url | 条件 | sse/websocket 传输时的服务器 URL |
| tool_name | 是 | 要调用的工具名称 |
| timeout_ms | 否 | 超时时间，默认 30000ms |

**Browser 类型**:

Browser 类型工具通过 CDP (Chrome DevTools Protocol) 控制浏览器执行自动化操作。

```json
// Browser 类型
{
    "type": "browser",
    "browser": "chromium",                      // 浏览器类型：chromium/firefox/webkit
    "headless": true,                           // 是否无头模式
    "action": "navigate",                       // 动作类型，见下表
    "timeout_ms": 30000,                        // 操作超时时间
    "viewport": {                               // 视口配置
        "width": 1280,
        "height": 720
    },
    "user_agent": "...",                        // 自定义 User-Agent (可选)
    "proxy": "http://proxy:8080"                // 代理服务器 (可选)
}
```

**Browser 动作类型**:

| 动作 | 说明 | 参数 |
| ---- | ---- | ---- |
| navigate | 导航到 URL | `url` |
| snapshot | 获取语义快照 (ARIA 树) | `selector` (可选) |
| screenshot | 截取屏幕截图 | `selector`, `full_page` |
| click | 点击元素 | `selector` 或 `ref` |
| type | 输入文本 | `selector`, `text` |
| scroll | 滚动页面 | `direction`, `amount` |
| wait | 等待元素/条件 | `selector`, `state` |
| evaluate | 执行 JavaScript | `script` |
| extract | 提取页面数据 | `selectors` |

**Semantic Snapshot 说明**:

Semantic Snapshot 通过解析页面的可访问性树 (ARIA Tree) 生成结构化文本表示，相比截图更高效精确：

- **体积小**：通常 < 50KB，远小于截图的 5MB
- **精度高**：元素带有唯一引用 `[ref=N]`，可直接用于交互
- **速度快**：文本解析比计算机视觉快 10-100 倍

示例输出：

```text
[document] Example Page
├─ [header]
│  └─ [nav]
│     ├─ [link ref=1] Home
│     ├─ [link ref=2] Products
│     └─ [link ref=3] Contact
├─ [main]
│  ├─ [heading] Welcome
│  ├─ [paragraph] This is the main content...
│  └─ [button ref=4] Get Started
└─ [footer]
   └─ [text] © 2024 Example Inc.
```

### 2.5 sessions - 会话

```sql
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),       -- 会话唯一标识
    org_id UUID NOT NULL,                                -- 所属组织（逻辑外键 -> organizations.id）
    agent_id UUID NOT NULL,                              -- 关联的 Agent（逻辑外键 -> agents.id）
    user_id UUID NOT NULL,                               -- 用户标识（逻辑外键 -> users.id）
    status VARCHAR(20) DEFAULT 'active'                  -- 会话状态
        CHECK (status IN ('active', 'paused', 'completed', 'failed')),
    title VARCHAR(200),                                  -- 会话标题（自动生成）
    metadata JSONB DEFAULT '{}',                         -- 元数据
    started_at TIMESTAMPTZ DEFAULT NOW(),                -- 开始时间
    ended_at TIMESTAMPTZ,                                -- 结束时间
    created_at TIMESTAMPTZ DEFAULT NOW()                 -- 创建时间
);

-- 索引
CREATE INDEX idx_sessions_org ON sessions(org_id);
CREATE INDEX idx_sessions_agent ON sessions(agent_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_org_user ON sessions(org_id, user_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_created ON sessions(created_at DESC);

COMMENT ON TABLE sessions IS '会话表，记录用户与 Agent 的交互会话';
COMMENT ON COLUMN sessions.org_id IS '逻辑外键，关联 organizations.id';
COMMENT ON COLUMN sessions.agent_id IS '逻辑外键，关联 agents.id';
COMMENT ON COLUMN sessions.user_id IS '逻辑外键，关联 users.id';
```

**字段说明**:

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
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
    session_id UUID NOT NULL,                            -- 逻辑外键，关联 sessions.id
    parent_id UUID,                                       -- 逻辑外键，关联 messages.id（分支对话）
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
| ---- | ---- | ---- |
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
    agent_id UUID NOT NULL,                              -- 逻辑外键，关联 agents.id
    session_id UUID,                                      -- 逻辑外键，关联 sessions.id
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
| ---- | ---- | ---- |
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

---

## 2.7 日志与计量层

### 2.7.1 execution_logs - 执行日志

```sql
CREATE TABLE execution_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),       -- 日志唯一标识
    org_id UUID NOT NULL,                                -- 所属组织（逻辑外键 -> organizations.id）
    agent_id UUID NOT NULL,                              -- 执行的Agent（逻辑外键 -> agents.id）
    session_id UUID NOT NULL,                            -- 会话ID（逻辑外键 -> sessions.id）
    request_id VARCHAR(100),                             -- API 请求追踪ID
    step_id VARCHAR(100),                                -- 计划步骤ID（幂等）
    action_id VARCHAR(100),                              -- 动作ID（tool/skill）
    state VARCHAR(50) NOT NULL,                          -- 执行状态：START/PLAN/ACT/OBSERVE/REFLECT/RESPOND
    action_type VARCHAR(50),                             -- 动作类型：tool_call/skill_call/delegate/llm_call
    action_name VARCHAR(100),                            -- 动作名称（tool/skill 名）
    action_input JSONB,                                  -- 输入参数
    action_output JSONB,                                 -- 输出结果
    error_code VARCHAR(50),                              -- 错误码（如有）
    error_message TEXT,                                  -- 错误信息（如有）
    retry_count INTEGER DEFAULT 0,                       -- 重试次数
    duration_ms INTEGER,                                 -- 执行耗时（毫秒）
    tokens_input INTEGER DEFAULT 0,                      -- 输入token数
    tokens_output INTEGER DEFAULT 0,                     -- 输出token数
    model VARCHAR(50),                                   -- 使用的模型
    metadata JSONB DEFAULT '{}',                         -- 扩展元数据
    created_at TIMESTAMPTZ DEFAULT NOW()                 -- 创建时间
);

-- 索引
CREATE INDEX idx_execution_logs_org ON execution_logs(org_id);
CREATE INDEX idx_execution_logs_agent ON execution_logs(agent_id);
CREATE INDEX idx_execution_logs_session ON execution_logs(session_id);
CREATE INDEX idx_execution_logs_request ON execution_logs(request_id);
CREATE INDEX idx_execution_logs_step ON execution_logs(step_id);
CREATE INDEX idx_execution_logs_state ON execution_logs(state);
CREATE INDEX idx_execution_logs_created ON execution_logs(created_at DESC);
CREATE INDEX idx_execution_logs_error ON execution_logs(error_code) WHERE error_code IS NOT NULL;

-- 分区建议：按月分区以提高查询性能
-- CREATE TABLE execution_logs_2024_01 PARTITION OF execution_logs
--     FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

COMMENT ON TABLE execution_logs IS 'Agent执行日志表，用于调试、审计和性能分析';
COMMENT ON COLUMN execution_logs.org_id IS '逻辑外键，关联 organizations.id';
COMMENT ON COLUMN execution_logs.agent_id IS '逻辑外键，关联 agents.id';
COMMENT ON COLUMN execution_logs.session_id IS '逻辑外键，关联 sessions.id';
```

### 2.7.2 usage_logs - 使用量统计

```sql
CREATE TABLE usage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),       -- 记录唯一标识
    org_id UUID NOT NULL,                                -- 所属组织（逻辑外键 -> organizations.id）
    user_id UUID,                                        -- 用户ID（逻辑外键 -> users.id，可选）
    agent_id UUID,                                       -- Agent ID（逻辑外键 -> agents.id，可选）
    period_start TIMESTAMPTZ NOT NULL,                   -- 统计周期开始
    period_end TIMESTAMPTZ NOT NULL,                     -- 统计周期结束
    period_type VARCHAR(20) NOT NULL                     -- 周期类型：hourly/daily/monthly
        CHECK (period_type IN ('hourly', 'daily', 'monthly')),
    tokens_input INTEGER DEFAULT 0,                      -- 输入token总数
    tokens_output INTEGER DEFAULT 0,                     -- 输出token总数
    api_calls INTEGER DEFAULT 0,                         -- API调用次数
    tool_calls INTEGER DEFAULT 0,                        -- Tool调用次数
    sessions_count INTEGER DEFAULT 0,                    -- 会话数
    messages_count INTEGER DEFAULT 0,                    -- 消息数
    errors_count INTEGER DEFAULT 0,                      -- 错误数
    cost_usd DECIMAL(10, 4) DEFAULT 0,                   -- 估算成本（美元）
    metadata JSONB DEFAULT '{}',                         -- 扩展元数据（按模型细分等）
    created_at TIMESTAMPTZ DEFAULT NOW(),                -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                 -- 更新时间
);

-- 索引
CREATE INDEX idx_usage_logs_org ON usage_logs(org_id);
CREATE INDEX idx_usage_logs_user ON usage_logs(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_usage_logs_agent ON usage_logs(agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX idx_usage_logs_period ON usage_logs(period_start, period_end);
CREATE INDEX idx_usage_logs_period_type ON usage_logs(period_type);

-- 唯一约束：防止重复统计
-- 注意：PostgreSQL 的 UNIQUE 允许多个 NULL，因此需区分三种维度
-- 1) 组织级汇总（user_id 与 agent_id 均为 NULL）
-- 2) 用户级汇总（user_id 非 NULL，agent_id 为 NULL）
-- 3) Agent 级汇总（agent_id 非 NULL，user_id 可为 NULL 或非 NULL）
CREATE UNIQUE INDEX idx_usage_logs_unique_org
    ON usage_logs(org_id, period_type, period_start)
    WHERE user_id IS NULL AND agent_id IS NULL;

CREATE UNIQUE INDEX idx_usage_logs_unique_user
    ON usage_logs(org_id, user_id, period_type, period_start)
    WHERE user_id IS NOT NULL AND agent_id IS NULL;

CREATE UNIQUE INDEX idx_usage_logs_unique_agent
    ON usage_logs(org_id, agent_id, period_type, period_start)
    WHERE agent_id IS NOT NULL;

-- 更新触发器
CREATE TRIGGER usage_logs_updated_at
    BEFORE UPDATE ON usage_logs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE usage_logs IS '使用量统计表，用于配额管理和计费';
COMMENT ON COLUMN usage_logs.org_id IS '逻辑外键，关联 organizations.id';
COMMENT ON COLUMN usage_logs.user_id IS '逻辑外键，关联 users.id';
COMMENT ON COLUMN usage_logs.agent_id IS '逻辑外键，关联 agents.id';
```

**metadata 结构示例**（按模型细分）:

```json
{
    "by_model": {
        "gpt-4o": {"tokens_input": 5000, "tokens_output": 2000, "calls": 10},
        "gpt-4o-mini": {"tokens_input": 3000, "tokens_output": 1000, "calls": 5}
    },
    "by_tool": {
        "web_search": {"calls": 8, "errors": 1},
        "code_executor": {"calls": 3, "errors": 0}
    }
}
```

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

```text
migrations/
├── 001_init.sql               # 初始化扩展和函数（pgvector、update_updated_at）
├── 002_organizations.sql      # organizations 表
├── 003_users.sql              # users 表
├── 004_api_keys.sql           # api_keys 表
├── 005_agents.sql             # agents 表
├── 006_agent_versions.sql     # agent_versions 表
├── 007_skills.sql             # skills 表
├── 008_tools.sql              # tools 表
├── 009_sessions.sql           # sessions 表
├── 010_messages.sql           # messages 表
├── 011_memories.sql           # memories 表
├── 012_execution_logs.sql     # execution_logs 表
└── 013_usage_logs.sql         # usage_logs 表
```

**迁移执行顺序说明**：

1. `001_init.sql` - 必须首先执行，创建 pgvector 扩展和通用触发器函数
2. `002_organizations.sql` - 组织表是多租户的基础
3. `003_users.sql` - 用户表依赖组织表
4. `004_api_keys.sql` - API 密钥依赖组织和用户表
5. `005-008` - Agent 核心层表，按依赖顺序执行
6. `009-011` - 会话与消息层表
7. `012-013` - 日志与计量层表
