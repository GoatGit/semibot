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
