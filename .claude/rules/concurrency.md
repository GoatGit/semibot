# 并发规范

## Redis 原子操作

**涉及读写依赖的 Redis 操作，使用 Pipeline 或 Lua 脚本。**

```python
# ❌ 错误 - 存在竞态条件
entry_count = await client.zcard(session_key)
if entry_count >= MAX_SESSION_ENTRIES:
    await client.zremrangebyrank(session_key, 0, -MAX_SESSION_ENTRIES - 1)
await client.zadd(session_key, {entry_id: timestamp})

# ✅ 正确 - 使用 Pipeline
async with client.pipeline() as pipe:
    pipe.zcard(session_key)
    pipe.zadd(session_key, {entry_id: timestamp})
    pipe.zremrangebyrank(session_key, 0, -MAX_SESSION_ENTRIES - 1)
    await pipe.execute()
```

### Lua 脚本示例

```python
# 原子性检查并添加
SAVE_WITH_LIMIT_SCRIPT = """
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[1]) then
    redis.call('ZREMRANGEBYRANK', KEYS[1], 0, count - tonumber(ARGV[1]))
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
return redis.call('ZCARD', KEYS[1])
"""
```

---

## 批量异步操作

**使用 `asyncio.gather` 而非循环 await。**

```python
# ❌ 错误 - 串行执行
for row in rows:
    await self._update_access(str(row["id"]))

# ✅ 正确 - 并行执行
await asyncio.gather(*[
    self._update_access(str(row["id"]))
    for row in rows
])
```

---

## 资源关闭

**关闭时确保关闭所有依赖组件。**

```python
# ❌ 不完整 - 只关闭 provider
async def close(self):
    await self.provider.close()

# ✅ 完整 - 关闭所有组件
async def close(self):
    await self.provider.close()
    await self.cache.close()
    await self.pool.close()
```

---

## 信号处理

```python
# ❌ 问题 - Lambda 捕获问题，Windows 不支持
loop.add_signal_handler(sig, lambda: asyncio.create_task(self.stop()))

# ✅ 正确 - 使用 functools.partial
import functools
loop.add_signal_handler(sig, functools.partial(asyncio.create_task, self.stop()))

# 或添加平台检查
import sys
if sys.platform != 'win32':
    loop.add_signal_handler(sig, ...)
```
