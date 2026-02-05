# Semibot: Design Gap Audit + Milestone Plan

**Priority:** High
**Status:** Not Started
**Type:** Planning
**Created:** 2026-02-05
**Last Updated:** 2026-02-05

## Overview

对照 `docs/design` 与当前实现，产出完整差距清单并给出分阶段里程碑实施顺序、依赖关系、交付物与验收标准，作为后续建设的执行基线。

## User Story

**As a** 产品/工程负责人
**I want** 明确的差距清单与里程碑计划
**So that** 可以按依赖顺序推进实现并降低返工风险

## Description

本任务以设计文档为唯一基准（PRD、API 设计、架构设计、数据模型、Agent Runtime、错误码、测试策略），系统性盘点实际代码与数据库迁移，标记缺失或仅为 mock/占位的部分，并给出分阶段实施路径和验收标准。

## Context

当前实现存在大量原型/骨架代码与 mock 页面，关键链路未闭环。需要一份可执行的差距清单与里程碑计划，保证后续实现方向与优先级一致。

## Implementation Overview

- 汇总设计需求：`docs/design/*` 逐项拆解
- 代码现状盘点：`apps/api`、`runtime`、`apps/web`、`database`、`packages`
- 建立“需求 -> 实现状态 -> 差距 -> 优先级”映射
- 输出里程碑（M0~M7）实施顺序、依赖与交付物
- 明确验收标准与风险/依赖事项

## Features / Requirements

1. **差距清单**
- 覆盖：认证与多租户、API 端点、持久化与数据模型、队列与异步、Runtime 对接、Skills/Tools/MCP、记忆系统、可观测与计量、多模型、国际化、前端接入、测试体系
- 每项包含：设计要求、当前实现、差距描述、优先级、参考文件路径

2. **里程碑实施顺序**
- 提供 M0~M7 分阶段计划
- 每阶段包含：目标、依赖、交付物、验收标准

3. **风险与依赖说明**
- 外部依赖（数据库/Redis/LLM Provider）
- 关键技术风险（幂等、并发、SSE、配额）

4. **交付物**
- 差距清单文档（Markdown）
- 里程碑计划文档（Markdown）
- 端点/数据表/测试覆盖的缺口摘要

## Files to Create

- `.agents/TASKS/design-gap-audit-and-milestone-plan.md` - 任务条目
- `.agents/PRDS/design-gap-audit-and-milestone-plan.md` - PRD 文档

## Files to Modify

- 无

## API Endpoints

- 无

## Database Changes

- 无

## Testing Requirements

- 仅文档产出，无代码测试变更

## Acceptance Criteria

- 差距清单覆盖 `docs/design` 全部核心模块，并标明实现状态与优先级
- 里程碑计划包含依赖顺序、交付物与验收标准
- 每条差距均能追溯到设计文档与现有代码路径
- 输出可直接用于后续实施拆分与排期

## Implementation Notes

- 本任务仅产出规划文档，不包含具体功能实现
- 后续功能实现必须基于该差距清单拆分为独立任务
