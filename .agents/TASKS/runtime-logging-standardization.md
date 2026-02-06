# 任务：统一日志系统使用

## 任务 ID
`runtime-logging-standardization`

## 优先级
P3 - 低优先级

## 关联 PRD
`runtime-comprehensive-review.md` - 问题 6.2

## 问题描述

部分文件使用 `logging.getLogger(__name__)`，部分使用 `src.utils.logging.get_logger`，日志系统使用不一致。

## 当前状态

### 使用 `logging.getLogger`:
- `src/agents/executor.py`
- `src/agents/planner.py`
- `src/llm/router.py`
- `src/llm/openai_provider.py`
- `src/llm/anthropic_provider.py`
- `src/orchestrator/nodes.py`
- `src/skills/registry.py`
- `src/queue/producer.py`
- `src/queue/consumer.py`

### 使用 `src.utils.logging.get_logger`:
- `src/memory/short_term.py`
- `src/memory/long_term.py`
- `src/memory/embedding.py`
- `src/utils/validation.py`

## 修复方案

统一使用 `src.utils.logging.get_logger`，提供结构化日志支持：

```python
# 修改前
import logging
logger = logging.getLogger(__name__)

# 修改后
from src.utils.logging import get_logger
logger = get_logger(__name__)
```

## 需要修改的文件

1. `src/agents/executor.py`
2. `src/agents/planner.py`
3. `src/llm/router.py`
4. `src/llm/openai_provider.py`
5. `src/llm/anthropic_provider.py`
6. `src/orchestrator/nodes.py`
7. `src/skills/registry.py`
8. `src/queue/producer.py`
9. `src/queue/consumer.py`

## 验收标准

- [ ] 所有文件使用 `get_logger`
- [ ] 日志格式统一（结构化 JSON 或控制台）
- [ ] 测试通过无回归
- [ ] 日志输出正常

## 实现步骤

1. 逐个修改文件的 import 语句
2. 更新 logger 初始化
3. 运行测试验证
4. 验证日志输出格式
