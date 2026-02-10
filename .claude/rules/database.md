# 数据库规范

## 外键约束

**禁止使用物理外键进行强行约束**，应在代码层面使用**逻辑外键**约束数据一致性。

---

## SQL 脚本规范

SQL 脚本文件放置在 `docs/sql/` 目录下。

### 字段要求

1. **必须有注释** - 每个必要字段必须添加注释，方便维护
2. **合理的字段类型** - 避免语法错误和数据溢出
3. **类型选择原则**：
   - 数值类型考虑范围，避免溢出
   - 字符串类型考虑最大长度
   - 时间类型统一使用 DATETIME 或 TIMESTAMP

### 示例

```sql
CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '用户ID',
  username VARCHAR(50) NOT NULL COMMENT '用户名',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id)
) COMMENT='用户表';
```

---

## 软删除

**核心表使用软删除机制，禁止物理删除。**

### 必需字段

```sql
deleted_at TIMESTAMP NULL DEFAULT NULL COMMENT '删除时间',
deleted_by UUID NULL COMMENT '删除人ID'
```

### 查询规范

```typescript
// ✅ 默认过滤已删除记录
const users = await db.query('SELECT * FROM users WHERE deleted_at IS NULL');

// ✅ 软删除操作
await db.query('UPDATE users SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2', [userId, id]);
```

---

## 审计字段

**核心表必须包含审计字段。**

```sql
created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
created_by UUID NOT NULL COMMENT '创建人ID',
updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
updated_by UUID NULL COMMENT '更新人ID'
```

---

## 乐观锁

**高频更新表添加版本号字段。**

```sql
version INT NOT NULL DEFAULT 1 COMMENT '版本号（乐观锁）'
```

```typescript
// ✅ 更新时检查版本
const result = await db.query(
  'UPDATE skills SET name = $1, version = version + 1 WHERE id = $2 AND version = $3',
  [name, id, currentVersion]
);
if (result.rowCount === 0) {
  throw createError(409, 'CONFLICT', '数据已被其他用户修改');
}
```

---

## 查询优化

### N+1 查询

用 `WHERE id = ANY($1::uuid[])` 批量替代循环单查。

### 复合索引

按常见查询模式建索引（如 `org_id + status + created_at DESC`），用 `EXPLAIN ANALYZE` 验证命中。

### 表分区

高增长表（messages、execution_logs）按日期做 Range 分区。

---

## JSONB 列写入规范（postgres.js）

**禁止使用 `JSON.stringify()` 写入 JSONB 列，必须使用 `sql.json()`。**

### 背景

本项目使用 [postgres.js](https://github.com/porsager/postgres) 作为 PostgreSQL 驱动。在 tagged template 中传入字符串参数时，postgres.js 会将其作为 text 类型发送给 PostgreSQL。虽然 PostgreSQL 能将 text 隐式转换为 JSONB 存入，但在某些情况下（如 `prepare: false` 模式）会导致**双重序列化**：数据库中存储的是 JSON 字符串值 `"\"{ ... }\""` 而非 JSON 对象。读取时 postgres.js 解析 JSONB 得到的是字符串而非对象，导致字段访问返回 `undefined`。

### 规则

```typescript
// ❌ 错误：JSON.stringify 导致双重序列化风险
config = ${JSON.stringify(data.config ?? {})}
metadata = ${JSON.stringify(data.metadata)}

// ✅ 正确：sql.json() 显式标记 JSONB 类型（OID 3802）
config = ${sql.json((data.config ?? {}) as Parameters<typeof sql.json>[0])}
metadata = ${sql.json(data.metadata as Parameters<typeof sql.json>[0])}

// ✅ 正确：可选字段为 null 时的处理
metadata = ${data.metadata ? sql.json(data.metadata as Parameters<typeof sql.json>[0]) : null}

// ✅ 例外：vector 类型仍使用 JSON.stringify + ::vector 转换
embedding = ${JSON.stringify(data.embedding)}::vector
```

### 读取侧防御

对于已有数据可能存在双重序列化的情况，在 row → entity 转换函数中添加防御性解析：

```typescript
// 防御性解析：兼容历史脏数据
const rawConfig = typeof row.config === 'string' ? JSON.parse(row.config) : row.config
const config = (rawConfig ?? {}) as Record<string, unknown>
```

### 类型断言说明

postgres.js 的 `sql.json()` 接受 `JSONValue` 类型参数。当 TypeScript 类型不兼容时：
- 普通对象：使用 `as Parameters<typeof sql.json>[0]>`
- 数组类型（如 `ToolCall[]`）：使用 `as unknown as Parameters<typeof sql.json>[0]>`
