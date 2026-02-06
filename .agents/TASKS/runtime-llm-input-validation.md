# 任务：LLM Provider 输入验证

## 任务 ID
`runtime-llm-input-validation`

## 优先级
P1 - 高优先级

## 关联 PRD
`runtime-comprehensive-review.md` - 问题 3.1

## 问题描述

LLM Provider 的 `chat` 方法未验证 `messages` 参数是否为空列表，空列表会导致 API 调用失败。

## 当前代码

```python
# openai_provider.py
async def chat(
    self,
    messages: list[dict[str, str]],
    ...
) -> LLMResponse:
    # 直接使用 messages，未验证
    params: dict[str, Any] = {
        "model": self.config.model,
        "messages": messages,
        ...
    }
```

## 修复方案

### 1. 在 base.py 添加验证方法

```python
def _validate_messages(self, messages: list[dict[str, str]]) -> None:
    """Validate messages list.

    Args:
        messages: List of message dicts

    Raises:
        ValueError: If messages is empty or invalid
    """
    if not messages:
        raise ValueError("messages cannot be empty")

    for i, msg in enumerate(messages):
        if "role" not in msg:
            raise ValueError(f"Message {i} missing 'role' field")
        if "content" not in msg:
            raise ValueError(f"Message {i} missing 'content' field")
```

### 2. 在各 Provider 的 chat 方法开头调用

```python
async def chat(self, messages: list[dict[str, str]], ...) -> LLMResponse:
    self._validate_messages(messages)  # 添加验证
    # ... 原有逻辑
```

### 3. 在 router.py 也添加验证

```python
async def chat(self, messages: list[dict[str, str]], ...) -> LLMResponse:
    if not messages:
        raise ValueError("messages cannot be empty")
    # ... 原有逻辑
```

## 验收标准

- [ ] 空消息列表抛出 ValueError
- [ ] 缺少 role 字段抛出 ValueError
- [ ] 缺少 content 字段抛出 ValueError
- [ ] 添加对应的单元测试
- [ ] 边界日志记录（根据编码规范）

## 实现步骤

1. 在 `base.py` 添加 `_validate_messages` 方法
2. 在 `openai_provider.py` 的 `chat` 方法添加验证
3. 在 `anthropic_provider.py` 的 `chat` 方法添加验证
4. 在 `router.py` 的 `chat` 方法添加验证
5. 添加单元测试验证错误情况
6. 运行测试确保无回归
