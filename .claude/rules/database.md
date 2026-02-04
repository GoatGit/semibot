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
