## Task: Skills 管理与使用规范落地（管理员统一管理）

**ID:** skills-management-and-usage-spec  
**Label:** Semibot: Skills 管理与使用规范落地  
**Description:** 建立目录型 skill 安装与使用规范，统一管理语义与执行语义  
**Type:** Spec + Architecture  
**Status:** Backlog  
**Priority:** P0 - Critical  
**Created:** 2026-02-08  
**Updated:** 2026-02-08  
**PRD:** `skills-management-and-usage-spec.md`

---

### 阶段 A：模型与边界

- [ ] 定义 `SkillDefinition` 与 `SkillPackage` 的职责边界
- [ ] 定义全租户共享下的执行上下文隔离规范（org/session/user）
- [ ] 输出协议兼容矩阵（Anthropic/Codex/平台内部）

### 阶段 B：安装流程标准化

- [ ] 统一 skill_id / manifest / catalog 三入口安装状态机
- [ ] 安装流程增加目录结构校验（至少 `SKILL.md`）
- [ ] 安装记录保存来源、版本、hash、安装日志
- [ ] 明确“安装失败可重试/回滚”的策略

### 阶段 C：管理接口与前端

- [ ] 设计 `versions/publish/rollback` API
- [ ] 管理页面展示来源、版本、安装状态、最后安装日志
- [ ] 管理页面支持版本切换与回滚

### 阶段 D：测试与验收

- [ ] 单测覆盖 manifest 解析与目录校验
- [ ] 集成测试覆盖安装成功/失败/回滚
- [ ] 安全测试覆盖非法包、路径穿越、无效入口
- [ ] 编写运维手册：catalog 与 package 发布流程

---

### 验收标准

- [ ] 技能安装不再是“仅元数据入库”，而是“目录包可执行落地”
- [ ] 管理端可追踪每个技能版本与来源
- [ ] 全租户共享可见，但执行上下文隔离规范明确且可测试
- [ ] 协议兼容矩阵可用于自动化检查
