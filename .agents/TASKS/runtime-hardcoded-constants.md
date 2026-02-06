# 任务：提取硬编码常量到配置

## 任务 ID
`runtime-hardcoded-constants`

## 优先级
P2 - 中优先级

## 关联 PRD
`runtime-comprehensive-review.md` - 问题 4.1, 4.2, 4.3

## 问题描述

多处代码存在硬编码的魔法数字，违反编码规范。

## 需要修复的位置

### 1. LLM Provider 重试参数

**位置**: `src/llm/openai_provider.py:51-54`, `src/llm/anthropic_provider.py:50-53`

**当前代码**:
```python
@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10),
)
```

**修复方案**:
```python
# 在 config.py 添加
LLM_MAX_RETRIES = 3
LLM_RETRY_DELAY_BASE = 1  # seconds
LLM_RETRY_DELAY_MAX = 10  # seconds

# 在 provider 中使用
@retry(
    stop=stop_after_attempt(LLM_MAX_RETRIES),
    wait=wait_exponential(
        multiplier=1,
        min=LLM_RETRY_DELAY_BASE,
        max=LLM_RETRY_DELAY_MAX
    ),
)
```

### 2. observe_node 迭代限制

**位置**: `src/orchestrator/nodes.py:346`

**当前代码**:
```python
if all_failed and current_iteration < 3:
```

**修复方案**:
```python
# 在 config.py 添加
MAX_REPLAN_ATTEMPTS = 3

# 在 nodes.py 中使用
from src.constants import MAX_REPLAN_ATTEMPTS

if all_failed and current_iteration < MAX_REPLAN_ATTEMPTS:
    logger.info(
        f"所有操作失败，尝试重新规划 (当前: {current_iteration}, 限制: {MAX_REPLAN_ATTEMPTS})"
    )
```

### 3. LLM Router 默认模型映射

**位置**: `src/llm/router.py:65-70`

**当前代码**:
```python
self.task_routing = task_routing or {
    "planning": "gpt-4o",
    "execution": "gpt-4o-mini",
    "reflection": "gpt-4o-mini",
    "complex_reasoning": "claude-3-sonnet",
}
```

**修复方案**:
```python
# 在 config.py 添加
DEFAULT_TASK_MODEL_ROUTING = {
    "planning": "gpt-4o",
    "execution": "gpt-4o-mini",
    "reflection": "gpt-4o-mini",
    "complex_reasoning": "claude-3-sonnet",
}

DEFAULT_LLM_MODEL = "gpt-4o"
DEFAULT_FALLBACK_MODEL = "gpt-4o-mini"

# 在 router.py 中使用
from src.constants import (
    DEFAULT_TASK_MODEL_ROUTING,
    DEFAULT_LLM_MODEL,
    DEFAULT_FALLBACK_MODEL,
)
```

## 验收标准

- [ ] 所有魔法数字已提取为常量
- [ ] 常量定义在 `config.py` 中
- [ ] 每个常量有文档注释
- [ ] 边界检查处添加日志（根据编码规范）
- [ ] 测试通过无回归

## 实现步骤

1. 在 `config.py` 添加 LLM 相关常量
2. 在 `config.py` 添加 Orchestrator 相关常量
3. 更新 `openai_provider.py` 使用常量
4. 更新 `anthropic_provider.py` 使用常量
5. 更新 `router.py` 使用常量
6. 更新 `nodes.py` 使用常量并添加边界日志
7. 运行测试验证
