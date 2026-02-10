# 架构设计

## 分层架构

Route → Service → Repository → Database，禁止跨层调用（如 Route 直接查数据库）。

---

## 双层模型

管理语义（Definition）与执行语义（Package）分离，支持版本管理和共享可见性。

---

## Repository 统一接口

每个 Repository 必须实现以下标准方法：

- `findById` - 按 ID 查询
- `findByIdAndOrg` - 按 ID + org_id 查询（租户隔离）
- `findByOrg` - 按 org_id 分页查询
- `create` - 创建
- `update` - 更新（带 version 乐观锁）
- `softDelete` - 软删除
- `countByOrg` - 按 org_id 计数
- `findByIds` - 批量查询

---

## 类型定义单一来源

所有 DTO/Entity 类型集中在 `packages/shared-types/`，禁止跨模块重复定义。

---

## 职责单一

- 避免重复实现（如同时存在 Agent 类和 Node 函数做相同事情）
- 明确架构选型后保持一致
- 依赖注入：通过构造函数传入依赖（llm_provider、skill_registry、memory_system），不用全局状态
