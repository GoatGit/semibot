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
