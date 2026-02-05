# Semibot: M1 Auth & Multi-tenant Foundation

**Priority:** High
**Status:** Not Started
**Type:** Feature
**Created:** 2026-02-05
**Last Updated:** 2026-02-05

## Overview

实现多租户认证与权限基座，包括用户注册/登录、组织与成员管理、API Key 管理、JWT 与权限校验，确保后续所有资源具备组织级隔离。

## User Story

**As a** 组织管理员
**I want** 管理用户、组织、API Key 与权限
**So that** 可以安全隔离租户并控制访问权限

## Description

基于 `docs/design/API_DESIGN.md` 与 `docs/design/DATA_MODEL.md` 落地认证与组织体系。替换当前仅有中间件模拟验证的状态，接入数据库与 Redis，确保租户隔离与权限校验可用。

## Context

当前实现仅提供 auth 中间件与 mock API Key 校验，缺少 Auth/Org/API Key 等核心端点与持久化。

## Implementation Overview

- 数据库落地 users/organizations/api_keys
- Auth API: register/login/refresh/logout
- Organizations API: current/update/members
- API Key 管理：创建/吊销/列表
- JWT 与权限模型统一
- I18N 错误响应结构接入

## Features / Requirements

1. **Auth API**
- POST /auth/register
- POST /auth/login
- POST /auth/refresh
- POST /auth/logout

2. **Organizations API**
- GET /organizations/current
- PUT /organizations/current
- GET /organizations/current/members

3. **API Key 管理**
- POST /api-keys
- GET /api-keys
- DELETE /api-keys/:id

4. **权限与租户隔离**
- 所有数据访问按 org_id 过滤
- RBAC/permissions 模型与校验

## Files to Create

- `apps/api/src/routes/v1/auth.ts`
- `apps/api/src/routes/v1/organizations.ts`
- `apps/api/src/routes/v1/api-keys.ts`
- `apps/api/src/services/auth.service.ts`
- `apps/api/src/services/organization.service.ts`
- `apps/api/src/services/api-keys.service.ts`
- `apps/api/src/repositories/*` (如采用 repository 层)

## Files to Modify

- `apps/api/src/routes/v1/index.ts`
- `apps/api/src/middleware/auth.ts`
- `apps/api/src/middleware/errorHandler.ts`
- `apps/api/src/constants/errorCodes.ts`
- `database/migrations/*` (确保与设计一致)

## API Endpoints

- POST /api/v1/auth/register
- POST /api/v1/auth/login
- POST /api/v1/auth/refresh
- POST /api/v1/auth/logout
- GET /api/v1/organizations/current
- PUT /api/v1/organizations/current
- GET /api/v1/organizations/current/members
- POST /api/v1/api-keys
- GET /api/v1/api-keys
- DELETE /api/v1/api-keys/:id

## Database Changes

- 使用既有 `organizations/users/api_keys` 表
- 如需字段补充，追加迁移

## Testing Requirements

### Unit Tests
- Auth token 签发与校验
- 权限校验与通配符权限

### Integration Tests
- 注册/登录/刷新 Token
- 组织信息查询与更新
- API Key 创建与校验

### E2E Tests
- 用户注册登录到访问组织资源完整流程

## Acceptance Criteria

- 所有 Auth/Org/API Key 端点可用
- JWT 与权限校验通过
- 组织级隔离生效
- 错误响应符合统一格式
