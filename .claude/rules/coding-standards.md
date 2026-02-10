# 编码规范

## 禁止硬编码值和魔法数字

**所有数值常量、超时时间、配置参数必须定义在 `src/constants/config.ts` 中，禁止在代码中直接使用硬编码值。**

```typescript
// ❌ 错误示例 - 魔法数字
if (retryCount > 3) { ... }
setTimeout(callback, 5000);
const maxItems = 100;

// ✅ 正确示例 - 使用常量
import { DEFAULT_MAX_RETRIES, SSE_RECONNECT_DELAY, MAX_PAGE_SIZE } from '@/constants/config';

if (retryCount > DEFAULT_MAX_RETRIES) { ... }
setTimeout(callback, SSE_RECONNECT_DELAY);
const maxItems = MAX_PAGE_SIZE;
```

### 需要提取为常量的值类型

- 超时时间（毫秒/秒）
- 重试次数
- 分页大小/限制
- 连接池配置
- 缓存 TTL
- Token 限制
- 并发数
- 倍数/比例

### 例外情况（可以使用字面量）

- 数组索引：`arr[0]`, `arr[1]`
- 数学运算：`x * 2`, `y / 2`, `n + 1`
- 布尔值：`true`, `false`
- 空值检查：`=== 0`, `!== 0`, `> 0`
- CSS/样式值
- 测试数据

---

## 边界检查必须打印日志

**所有触及边界、最大/最小限制的代码位置，必须打印日志以便测试和调试。**

```typescript
// ❌ 错误示例 - 边界检查无日志
if (items.length >= MAX_ITEMS) {
  return false;
}
const truncated = content.slice(0, MAX_LENGTH);

// ✅ 正确示例 - 边界检查有日志
if (items.length >= MAX_ITEMS) {
  console.warn(`[Module] 数量已达上限，操作被拒绝 (当前: ${items.length}, 限制: ${MAX_ITEMS})`);
  return false;
}
if (content.length > MAX_LENGTH) {
  console.warn(`[Module] 内容超出限制，已截断 (原始长度: ${content.length}, 限制: ${MAX_LENGTH})`);
}
const truncated = content.slice(0, MAX_LENGTH);
```

### 需要添加日志的边界场景

- 数组/列表截断（`.slice(-MAX_ENTRIES)`）
- 分页大小限制（`Math.min(limit, MAX_PAGE_SIZE)`）
- 重试次数达到上限
- 连接/任务数量达到上限
- 文档/内容长度截断
- 请求体大小限制
- 用户配额/限制检查

---

## 日志规范

**统一使用项目日志工具**，禁止混用不同日志库。

### TypeScript/Node.js

```typescript
// ✅ 使用项目 logger
import { logger } from '@/lib/logger';

logger.info('操作成功', { userId, action });
logger.warn('边界触发', { current, limit });
logger.error('操作失败', { error: err.message });

// ❌ 禁止直接使用 console
console.log('xxx');
```

### Python

```python
# ✅ 统一使用项目 logger
from src.utils.logging import get_logger
logger = get_logger(__name__)

# ❌ 禁止混用
import logging
logger = logging.getLogger(__name__)
```

### 日志级别规范

| 场景 | 级别 |
|------|------|
| 增删改成功 | INFO |
| 查询/搜索结果 | DEBUG |
| 边界/限制触发 | WARN |
| 错误/异常 | ERROR |
| 健康检查失败 | ERROR |

---

## 错误处理

### API 错误抛出

```typescript
// ✅ 使用 createError
import { createError } from '@/lib/errors';

throw createError(404, 'RESOURCE_NOT_FOUND', '资源不存在');

// ❌ 禁止直接抛对象
throw { code: 404, message: '资源不存在' };
```

### 输入验证

**所有 API 路由必须使用 Zod Schema 验证。**

```typescript
// ✅ 使用 Zod 验证
const schema = z.object({
  id: z.string().uuid(),
  content: z.string().min(1),
});

router.post('/', validate(schema), handler);
```

---

## 错误码与状态码

### 统一错误码

错误码定义在 `constants/errorCodes.ts`，用便捷函数（`errors.notFound()`）而非裸 `createError()`。

### HTTP 状态码映射

| 状态码 | 场景 |
|--------|------|
| 400 | 输入校验失败 |
| 401 | 未认证 |
| 403 | 无权限 |
| 404 | 资源不存在 |
| 409 | 版本冲突（乐观锁） |
| 429 | 限流 |
| 500 | 服务端错误 |

### 错误信息要求

错误信息必须包含：什么失败了、为什么失败、用户应该怎么做。禁止吞异常：catch 后必须打日志并抛出或处理。

---

## 废弃 API

及时更新废弃的 API 和依赖。

```python
# ❌ Python 3.12 已废弃
from datetime import datetime
created_at = datetime.utcnow()

# ✅ 使用 timezone-aware
from datetime import datetime, timezone
created_at = datetime.now(timezone.utc)
```

---

## 代码去重

- 禁止功能重复实现（如同时存在 Agent 类和 Node 函数做相同事情）
- 常量定义禁止重复，统一在一处定义
- 明确架构选型后保持一致
