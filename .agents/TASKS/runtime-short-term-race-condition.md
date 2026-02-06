# 任务：修复 ShortTermMemory 竞态条件

## 任务 ID
`runtime-short-term-race-condition`

## 优先级
P2 - 中优先级

## 关联 PRD
`runtime-comprehensive-review.md` - 问题 3.3

## 问题描述

`ShortTermMemory.save()` 方法中存在竞态条件：

```python
# 当前代码 (short_term.py:203-212)
entry_count = await client.zcard(session_key)  # 在 pipeline 外执行
if entry_count >= MAX_SESSION_ENTRIES:
    logger.warning(...)
    pipe.zremrangebyrank(session_key, 0, -MAX_SESSION_ENTRIES - 1)
```

问题：`zcard` 在 pipeline 外执行，如果多个并发请求同时写入，可能导致：
1. 多个请求都通过检查
2. 条目数超过限制
3. 或者删除了过多条目

## 修复方案

### 方案 A：使用 Lua 脚本（推荐）

```python
# 定义 Lua 脚本
TRIM_AND_ADD_SCRIPT = """
local key = KEYS[1]
local max_entries = tonumber(ARGV[1])
local entry_json = ARGV[2]
local timestamp = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

-- 添加新条目
redis.call('ZADD', key, timestamp, entry_json)

-- 检查并修剪
local count = redis.call('ZCARD', key)
if count > max_entries then
    -- 删除最旧的条目，保留 max_entries 个
    local to_remove = count - max_entries
    redis.call('ZREMRANGEBYRANK', key, 0, to_remove - 1)
    -- 记录修剪日志（返回值）
    return to_remove
end

-- 设置 TTL
redis.call('EXPIRE', key, ttl)

return 0
"""

async def save(self, session_id: str, content: str, ...) -> str:
    # ... 验证和准备数据 ...

    client = await self._get_client()

    # 使用 Lua 脚本原子执行
    trimmed = await client.eval(
        TRIM_AND_ADD_SCRIPT,
        1,  # 1 个 key
        session_key,
        MAX_SESSION_ENTRIES,
        entry_json,
        timestamp,
        ttl_seconds,
    )

    if trimmed > 0:
        logger.warning(
            "session_entries_trimmed",
            session_id=session_id,
            trimmed_count=trimmed,
            limit=MAX_SESSION_ENTRIES,
        )

    return entry_id
```

### 方案 B：使用 WATCH 乐观锁

```python
async def save(self, session_id: str, content: str, ...) -> str:
    # ... 验证和准备数据 ...

    client = await self._get_client()

    while True:
        try:
            # 监视 key
            await client.watch(session_key)

            # 获取当前数量
            entry_count = await client.zcard(session_key)

            # 开始事务
            async with client.pipeline(transaction=True) as pipe:
                pipe.zadd(session_key, {entry_json: timestamp})

                if entry_count >= MAX_SESSION_ENTRIES:
                    logger.warning(...)
                    pipe.zremrangebyrank(session_key, 0, -MAX_SESSION_ENTRIES - 1)

                pipe.expire(session_key, ttl_seconds)
                await pipe.execute()

            break  # 成功

        except redis.WatchError:
            # 并发修改，重试
            continue
```

## 推荐方案 A 的理由

1. **原子性**: Lua 脚本在 Redis 中原子执行
2. **性能**: 减少网络往返
3. **简洁**: 代码更清晰
4. **可靠**: 不需要重试逻辑

## 验收标准

- [ ] 竞态条件已修复
- [ ] 并发测试验证
- [ ] 性能无显著下降
- [ ] 边界日志记录正确
- [ ] 单元测试覆盖

## 实现步骤

1. 定义 Lua 脚本常量
2. 重构 `save()` 方法使用 Lua 脚本
3. 添加并发测试用例
4. 验证边界日志
5. 运行完整测试套件
