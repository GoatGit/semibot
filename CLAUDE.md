# CLAUDE.md

本文件为 Claude AI 提供项目开发指南和规范。

## 基本规则

- 使用中文回答问题
- 新增和修改接口时必须同步修改相关接口文档
- 禁止自己写文档，除非遇到重大改动可询问是否需要（文档放 `docs/` 目录）
- 添加新功能时，如要求保留旧版本，需形成版本说明
- 修改前确保获取足够上下文，删除或修改功能需确保所有引用位置都已更新
- 禁止随意修改用户展示页面，需获得允许并充分评估后再修改
- 更改路由等逻辑时不要修改页面排版
- 新功能落地前需先进行技术架构设计，确认后再实现

## 详细规范

- [架构设计](.claude/rules/architecture.md) - 分层架构、双层模型、Repository 接口、类型单一来源
- [编码规范](.claude/rules/coding-standards.md) - 硬编码规范、边界日志、日志规范、错误处理、错误码与状态码
- [数据库规范](.claude/rules/database.md) - 外键约束、软删除、审计字段、乐观锁、JSONB 写入、查询优化
- [API 规范](.claude/rules/api-standards.md) - 字段命名、DTO 类型、输入验证、响应格式
- [安全规范](.claude/rules/security.md) - 多租户隔离、执行上下文隔离、限流、SSE 连接限制
- [并发规范](.claude/rules/concurrency.md) - Redis 原子操作、异步批量、资源关闭、重试策略、失败清理
- [测试规范](.claude/rules/testing.md) - 覆盖率目标、测试隔离、安全测试、并发安全测试
- [前端规范](.claude/rules/frontend.md) - Mock 清理、SSE 事件、Hook 封装、长操作反馈
- [部署规范](.claude/rules/deployment.md) - Docker 镜像、服务安全、健康检查、优雅关闭
- [反模式清单](.claude/rules/anti-patterns.md) - 禁止的常见反模式速查表
