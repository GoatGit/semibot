# Semibot: M4 Skills/Tools/MCP Layer

**Priority:** Medium
**Status:** Not Started
**Type:** Feature
**Created:** 2026-02-05
**Last Updated:** 2026-02-05

## Overview

实现技能与工具注册/发现/绑定，并支持 MCP Server 管理与调用。

## Description

将 Runtime 的 SkillRegistry 能力映射到 API 与数据库，实现 skills/tools CRUD，与 Agent 绑定关系，并接入 MCP Server 管理。

## Features / Requirements

1. **Skills/Tools CRUD**
- 技能/工具列表、创建、更新、删除
- 绑定 Agent

2. **MCP Server 管理**
- MCP Server 列表、创建、删除
- 运行时可调用 MCP 工具

## Files to Create

- `apps/api/src/routes/v1/skills.ts`
- `apps/api/src/routes/v1/tools.ts`
- `apps/api/src/routes/v1/mcp.ts`
- `apps/api/src/services/skill.service.ts`
- `apps/api/src/services/tool.service.ts`

## Testing Requirements

### Integration Tests
- 技能/工具 CRUD 与 Agent 绑定
- MCP Server 管理

## Acceptance Criteria

- Skills/Tools 可配置并被 Agent 绑定
- MCP Server 可管理并触发调用
