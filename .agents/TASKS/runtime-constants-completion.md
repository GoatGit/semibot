# 任务：补全 Runtime Constants 配置

## 任务 ID
`runtime-constants-completion`

## 优先级
P0 - 阻塞性问题

## 关联 PRD
`runtime-comprehensive-review.md` - 问题 1.1

## 问题描述

`runtime/src/constants/config.py` 只包含 Queue 模块的常量，但 Memory 模块（short_term.py, long_term.py, embedding.py）引用了大量未定义的常量，会导致导入错误。

## 当前状态

```python
# config.py 当前只有 Queue 相关常量
DEFAULT_QUEUE_NAME = "agent:tasks"
RESULT_CHANNEL_PREFIX = "agent:results"
# ... 其他 Queue 常量
```

## 需要添加的常量

### Redis/Short-term Memory 常量
```python
# Short-term Memory
DEFAULT_TTL_SECONDS = 3600  # 1 hour
MAX_SESSION_ENTRIES = 100
REDIS_KEY_PREFIX = "semibot:memory:short_term"

# Redis 连接
REDIS_MAX_RETRIES = 3
REDIS_RETRY_DELAY_BASE = 1  # seconds
REDIS_RETRY_DELAY_MAX = 10  # seconds
```

### PostgreSQL/Long-term Memory 常量
```python
# Long-term Memory
DEFAULT_SEARCH_LIMIT = 5
MAX_SEARCH_LIMIT = 100
DEFAULT_MIN_SIMILARITY = 0.7
EMBEDDING_DIMENSION = 1536  # OpenAI ada-002

# PostgreSQL 连接池
PG_POOL_MIN_SIZE = 2
PG_POOL_MAX_SIZE = 10
PG_POOL_ACQUIRE_TIMEOUT = 30  # seconds
PG_MAX_RETRIES = 3
PG_RETRY_DELAY_BASE = 1  # seconds
PG_RETRY_DELAY_MAX = 10  # seconds
```

### Embedding 服务常量
```python
# Embedding
DEFAULT_EMBEDDING_MODEL = "text-embedding-ada-002"
EMBEDDING_BATCH_SIZE = 100
EMBEDDING_CACHE_PREFIX = "semibot:embedding:cache"
EMBEDDING_CACHE_TTL = 604800  # 7 days
EMBEDDING_MAX_RETRIES = 3
EMBEDDING_REQUEST_TIMEOUT = 30  # seconds
EMBEDDING_RETRY_DELAY_BASE = 1
EMBEDDING_RETRY_DELAY_MAX = 10
```

## 验收标准

- [ ] 所有常量已添加到 `config.py`
- [ ] 每个常量有清晰的文档注释
- [ ] 常量按模块分组组织
- [ ] `python -c "from src.constants import *"` 无错误
- [ ] `python -c "from src.memory.short_term import ShortTermMemory"` 无错误
- [ ] `python -c "from src.memory.long_term import LongTermMemory"` 无错误
- [ ] `python -c "from src.memory.embedding import EmbeddingService"` 无错误

## 实现步骤

1. 编辑 `runtime/src/constants/config.py`
2. 添加分组注释和所有常量
3. 运行导入测试验证
4. 运行现有测试确保无回归
