# CLAUDE.md

本文件为 Claude AI 提供项目开发指南和规范。

使用中文回答问题

新增和修改接口的时候必须同步修改相关的接口文档，按照规范开发！

不要自己写文档，除非遇到重大改动你可以询问我是否需要书写文档、文档写在 docs/ 目录下，没有我的允许绝对禁止输出文档！

在添加新功能时，我如果要求保留旧版本，再进行保留，并且要形成版本说明，避免后续开发出现版本混乱！

在修改时请你确保对于修改的内容已经获取了足够的上下文，避免出现代码库层面的不一致，删除或者修改功能一定要确保代码中所有的引用位置都进行了修改！！！

对于已经创建好的对用户展示结果的页面禁止随便修改，除非我允许之后你可以充分评估后再开始修改！

更改路由信息等逻辑方面的问题时不要修改页面元素排版等美工问题

写数据库时`禁止使用物理外键机型强行约束`，你应该在代码层面使用`逻辑外键`去约束数据的一致性

如果输出 sql 脚本文件，放在 docs/sql/ 目录下，并且每一个必要的字段必须有注释，方便进行维护。除此之外你需要给每一个字段安排合理的字段类型，避免语法错误，同时避免因为数据类型的问题导致的溢出。



在执行新功能的落地前你需要西安纪行技术架构，并推理最合理的方式是什么，架构完成之后先给我查看，确认一下，再进行最终的落地实现



## 项目编码规范

### 禁止硬编码值和魔法数字

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

**需要提取为常量的值类型：**
- 超时时间（毫秒/秒）
- 重试次数
- 分页大小/限制
- 连接池配置
- 缓存 TTL
- Token 限制
- 并发数
- 倍数/比例

**例外情况（可以使用字面量）：**
- 数组索引：`arr[0]`, `arr[1]`
- 数学运算：`x * 2`, `y / 2`, `n + 1`
- 布尔值：`true`, `false`
- 空值检查：`=== 0`, `!== 0`, `> 0`
- CSS/样式值
- 测试数据

详细规范请参考 `docs/CODING_STANDARDS.md`。

### 边界检查必须打印日志

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

**需要添加日志的边界场景：**
- 数组/列表截断（`.slice(-MAX_ENTRIES)`）
- 分页大小限制（`Math.min(limit, MAX_PAGE_SIZE)`）
- 重试次数达到上限
- 连接/任务数量达到上限
- 文档/内容长度截断
- 请求体大小限制
- 用户配额/限制检查
