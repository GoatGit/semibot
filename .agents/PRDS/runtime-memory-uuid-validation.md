# Semibot: Runtime Memory UUID 验证与输入校验

**Priority:** Critical
**Status:** Not Started
**Type:** Bug
**Created:** 2026-02-06
**Last Updated:** 2026-02-06

## Overview

修复 runtime/src/memory 模块中缺少的 UUID 验证和输入校验，防止无效输入导致的运行时异常。

## Description

当前 `LongTermMemory` 和 `ShortTermMemory` 模块直接将字符串参数转换为 UUID，未进行格式验证。传入非 UUID 格式的字符串会导致 `ValueError` 异常抛出，影响服务稳定性。

### 当前问题

```python
# long_term.py:175-179 - 无验证直接转换
uuid.UUID(entry_id),
uuid.UUID(effective_org_id),
uuid.UUID(agent_id),  # 非 UUID 格式会抛 ValueError

# long_term.py:123, short_term.py:106 - 空内容未校验
embedding_result = await self.embedding_service.embed(content)  # content="" 浪费 API 调用
```

## Features / Requirements

### 1. 添加 UUID 验证函数

- 创建 `validate_uuid(value: str, field_name: str) -> uuid.UUID` 工具函数
- 验证失败时抛出自定义 `InvalidInputError` 而非 `ValueError`
- 在所有接受 UUID 参数的入口处调用验证

### 2. 添加内容非空校验

- `save()` 方法校验 content 非空
- 空内容时记录警告日志并快速返回或抛出异常

### 3. 添加参数边界校验

- `importance` 参数增加类型检查（必须是数值）
- `ttl_seconds` 参数增加正数检查
- `limit` 参数增加正数检查

## Files to Modify

- `runtime/src/memory/long_term.py`
- `runtime/src/memory/short_term.py`
- `runtime/src/utils/validation.py` (新建)

## Code Changes

```python
# runtime/src/utils/validation.py (新建)
import uuid
from typing import Any

class InvalidInputError(ValueError):
    """Invalid input parameter error."""
    pass

def validate_uuid(value: str, field_name: str = "id") -> uuid.UUID:
    """
    验证并转换 UUID 字符串。

    Args:
        value: UUID 字符串
        field_name: 字段名（用于错误消息）

    Returns:
        uuid.UUID 对象

    Raises:
        InvalidInputError: 格式无效时
    """
    if not value:
        raise InvalidInputError(f"{field_name} cannot be empty")
    try:
        return uuid.UUID(value)
    except ValueError as e:
        raise InvalidInputError(f"Invalid UUID format for {field_name}: {value}") from e

def validate_content(content: str, min_length: int = 1) -> str:
    """验证内容非空。"""
    if not content or len(content.strip()) < min_length:
        raise InvalidInputError(f"Content must be at least {min_length} characters")
    return content.strip()
```

```python
# long_term.py save() 方法修改
from src.utils.validation import validate_uuid, validate_content, InvalidInputError

async def save(
    self,
    agent_id: str,
    content: str,
    ...
) -> str:
    # 输入验证
    content = validate_content(content)
    agent_uuid = validate_uuid(agent_id, "agent_id")

    # 后续逻辑...
```

## Testing Requirements

### Unit Tests

- [ ] 测试有效 UUID 正常通过验证
- [ ] 测试无效 UUID 格式抛出 InvalidInputError
- [ ] 测试空 UUID 抛出 InvalidInputError
- [ ] 测试空内容抛出 InvalidInputError
- [ ] 测试空白内容（纯空格）抛出 InvalidInputError
- [ ] 测试负数 ttl_seconds 抛出异常
- [ ] 测试负数 limit 抛出异常

## Acceptance Criteria

- [ ] 所有 UUID 参数入口增加验证
- [ ] 空内容不会调用 embedding API
- [ ] 无效输入返回明确的错误消息
- [ ] 现有单元测试通过
- [ ] 新增输入验证测试用例
