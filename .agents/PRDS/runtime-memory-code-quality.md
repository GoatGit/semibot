# Semibot: Runtime Memory 代码质量修复

**Priority:** Medium
**Status:** Not Started
**Type:** Refactor
**Created:** 2026-02-06
**Last Updated:** 2026-02-06

## Overview

修复 memory 模块中的代码质量问题，包括废弃 API、重复定义、硬编码值和日志级别不一致。

## Description

代码审查发现以下质量问题需要修复：

### 问题清单

| 问题 | 位置 | 说明 |
|------|------|------|
| datetime.utcnow() 已废弃 | base.py:21 | Python 3.12 废弃，应使用 datetime.now(timezone.utc) |
| 重复的常量定义 | embedding.py:17, long_term.py:27 | EMBEDDING_DIMENSION = 1536 定义两次 |
| 硬编码连接池大小 | long_term.py:110-111 | min_size=2, max_size=10 应提取为常量 |
| 日志级别不一致 | 多处 | 有的用 logger.info，有的用 logger.debug |

## Features / Requirements

### 1. 修复废弃 API

```python
# base.py:21 当前
created_at: datetime = field(default_factory=datetime.utcnow)

# 修改为
created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
```

### 2. 统一常量定义

- 将 `EMBEDDING_DIMENSION` 移到 `constants/config.py`
- 删除重复定义
- 所有模块从 config 导入

### 3. 提取硬编码值

```python
# 移到 constants/config.py
PG_POOL_MIN_SIZE = 2
PG_POOL_MAX_SIZE = 10
DEFAULT_EMBEDDING_MODEL = "text-embedding-ada-002"
EMBEDDING_DIMENSION = 1536
EMBEDDING_BATCH_SIZE = 100
EMBEDDING_REQUEST_TIMEOUT = 30
```

### 4. 统一日志级别规范

| 场景 | 级别 |
|------|------|
| 操作成功（增删改） | INFO |
| 搜索/查询结果 | DEBUG |
| 边界/限制触发 | WARN |
| 错误/异常 | ERROR |
| 健康检查失败 | ERROR |

## Files to Modify

- `runtime/src/memory/base.py`
- `runtime/src/memory/embedding.py`
- `runtime/src/memory/long_term.py`
- `runtime/src/memory/short_term.py`
- `runtime/src/constants/config.py`

## Testing Requirements

- [ ] 所有现有单元测试通过
- [ ] 验证日志输出级别正确

## Acceptance Criteria

- [ ] 无 datetime.utcnow() 使用
- [ ] 常量无重复定义
- [ ] 硬编码值提取到 config.py
- [ ] 日志级别符合规范
- [ ] 代码通过 linter 检查
