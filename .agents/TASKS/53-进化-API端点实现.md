# 任务：进化系统 — API 端点实现

**优先级**: 🟡 P1 - 重要
**类型**: 功能实现
**预估工时**: 3-4 天
**影响范围**: apps/api/src/routes/v1/、apps/api/src/services/、apps/api/src/repositories/

---

## 问题描述

进化系统需要 7 个 API 端点供前端管理界面和外部集成使用，包括进化技能的列表/详情/审核/删除/提升、进化统计、进化配置更新。所有端点需遵循项目 API 规范。

---

## 详细实现

### 1. 路由定义 + Zod Schema

```typescript
// apps/api/src/routes/v1/evolved-skills.ts

import { Router } from 'express';
import { z } from 'zod';
import { validate } from '@/middleware/validate';
import { EvolvedSkillService } from '@/services/evolved-skill.service';

const router = Router();

// === Zod Schemas ===

const listEvolvedSkillsSchema = z.object({
  query: z.object({
    status: z.enum([
      'pending_review', 'approved', 'rejected', 'auto_approved', 'deprecated'
    ]).optional(),
    agentId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
  }),
});

const getEvolvedSkillSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

const reviewEvolvedSkillSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    action: z.enum(['approve', 'reject']),
    comment: z.string().max(1000).optional(),
  }),
});

const deleteEvolvedSkillSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

const promoteEvolvedSkillSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

const getEvolutionStatsSchema = z.object({
  params: z.object({
    agentId: z.string().uuid(),
  }),
});

const updateEvolutionConfigSchema = z.object({
  params: z.object({
    agentId: z.string().uuid(),
  }),
  body: z.object({
    enabled: z.boolean().optional(),
    autoApprove: z.boolean().optional(),
    minQualityScore: z.number().min(0).max(1).optional(),
    maxEvolvePerHour: z.number().int().min(1).max(100).optional(),
    cooldownMinutes: z.number().int().min(1).max(1440).optional(),
  }),
});

// === Routes ===

// 1. 列出进化技能
router.get('/',
  validate(listEvolvedSkillsSchema),
  async (req, res) => {
    const { orgId } = req.auth;
    const { status, agentId, limit, cursor } = req.query;
    const result = await EvolvedSkillService.list(orgId, {
      status, agentId, limit, cursor,
    });
    res.json({ success: true, data: result.data, meta: result.meta });
  }
);

// 2. 获取进化技能详情
router.get('/:id',
  validate(getEvolvedSkillSchema),
  async (req, res) => {
    const { orgId } = req.auth;
    const skill = await EvolvedSkillService.getById(req.params.id, orgId);
    res.json({ success: true, data: skill });
  }
);

// 3. 审核进化技能
router.post('/:id/review',
  validate(reviewEvolvedSkillSchema),
  async (req, res) => {
    const { orgId, userId } = req.auth;
    const skill = await EvolvedSkillService.review(
      req.params.id, orgId, userId, req.body
    );
    res.json({ success: true, data: skill });
  }
);

// 4. 删除/废弃进化技能
router.delete('/:id',
  validate(deleteEvolvedSkillSchema),
  async (req, res) => {
    const { orgId, userId } = req.auth;
    await EvolvedSkillService.deprecate(req.params.id, orgId, userId);
    res.json({ success: true, data: null });
  }
);

// 5. 提升为正式技能
router.post('/:id/promote',
  validate(promoteEvolvedSkillSchema),
  async (req, res) => {
    const { orgId, userId } = req.auth;
    const skill = await EvolvedSkillService.promote(req.params.id, orgId, userId);
    res.json({ success: true, data: skill });
  }
);

export default router;
```

### 2. Agent 路由扩展（统计 + 配置）

```typescript
// apps/api/src/routes/v1/agents.ts — 新增端点

// 6. 获取进化统计
router.get('/:agentId/evolution/stats',
  validate(getEvolutionStatsSchema),
  async (req, res) => {
    const { orgId } = req.auth;
    const stats = await EvolvedSkillService.getStats(req.params.agentId, orgId);
    res.json({ success: true, data: stats });
  }
);

// 7. 更新 Agent 进化配置
router.put('/:agentId/evolution',
  validate(updateEvolutionConfigSchema),
  async (req, res) => {
    const { orgId } = req.auth;
    const config = await EvolvedSkillService.updateConfig(
      req.params.agentId, orgId, req.body
    );
    res.json({ success: true, data: config });
  }
);
```

### 3. Service 层

```typescript
// apps/api/src/services/evolved-skill.service.ts

import { logger } from '@/lib/logger';
import { createError } from '@/lib/errors';
import { EvolvedSkillRepository } from '@/repositories/evolved-skill.repository';

export class EvolvedSkillService {

  static async list(orgId: string, options: ListOptions) {
    return EvolvedSkillRepository.findByOrg(orgId, options);
  }

  static async getById(id: string, orgId: string) {
    const skill = await EvolvedSkillRepository.findByIdAndOrg(id, orgId);
    if (!skill) {
      throw createError(404, 'EVOLVED_SKILL_NOT_FOUND', '进化技能不存在');
    }
    return skill;
  }

  static async review(id: string, orgId: string, userId: string, input: ReviewInput) {
    const skill = await this.getById(id, orgId);

    // 只有 pending_review 状态可审核
    if (skill.status !== 'pending_review') {
      throw createError(400, 'INVALID_STATUS',
        `当前状态 ${skill.status} 不可审核，仅 pending_review 状态可审核`);
    }

    const updated = await EvolvedSkillRepository.updateReviewStatus(
      id, input.action, userId, input.comment
    );

    logger.info('[EvolvedSkill] 审核完成', {
      skillId: id, action: input.action, reviewedBy: userId,
    });

    // 触发 Webhook 事件
    // await emitEvent(`evolution.skill_${input.action}d`, updated);

    return updated;
  }

  static async deprecate(id: string, orgId: string, userId: string) {
    const skill = await this.getById(id, orgId);
    await EvolvedSkillRepository.softDelete(id, userId);

    logger.info('[EvolvedSkill] 已废弃', { skillId: id, deletedBy: userId });
  }

  static async promote(id: string, orgId: string, userId: string) {
    const skill = await this.getById(id, orgId);

    // 只有 approved / auto_approved 可提升
    if (!['approved', 'auto_approved'].includes(skill.status)) {
      throw createError(400, 'INVALID_STATUS',
        `当前状态 ${skill.status} 不可提升，仅 approved/auto_approved 可提升`);
    }

    // 转换为正式技能（写入 skills 表）
    const formalSkill = await this._convertToFormalSkill(skill, userId);

    logger.info('[EvolvedSkill] 已提升为正式技能', {
      evolvedSkillId: id, formalSkillId: formalSkill.id,
    });

    return formalSkill;
  }

  static async getStats(agentId: string, orgId: string) {
    const stats = await EvolvedSkillRepository.getStatsByAgent(agentId, orgId);
    const topSkills = await EvolvedSkillRepository.getTopSkills(agentId, orgId, 5);

    return {
      totalEvolved: stats.total,
      approvedCount: stats.approved,
      rejectedCount: stats.rejected,
      pendingCount: stats.pending,
      approvalRate: stats.total > 0
        ? (stats.approved + stats.autoApproved) / stats.total
        : 0,
      totalReuseCount: stats.totalReuse,
      avgQualityScore: stats.avgQuality,
      topSkills,
    };
  }

  static async updateConfig(agentId: string, orgId: string, config: EvolutionConfigInput) {
    // 更新 agents.config.evolution JSONB 字段
    // 使用 sql.json() 写入
    ...
  }

  private static async _convertToFormalSkill(evolvedSkill: EvolvedSkill, userId: string) {
    // 将 evolved_skill 转换为 skills 表记录
    // source_type = 'evolved'
    ...
  }
}
```

### 4. 路由注册

```typescript
// apps/api/src/routes/v1/index.ts — 新增

import evolvedSkillsRouter from './evolved-skills';

router.use('/evolved-skills', authMiddleware, evolvedSkillsRouter);
```

### 5. shared-types DTO

```typescript
// packages/shared-types/src/dto.ts — 新增

export interface CreateEvolvedSkillInput {
  orgId: string;
  agentId: string;
  sessionId: string;
  name: string;
  description: string;
  triggerKeywords?: string[];
  steps: EvolvedSkillStep[];
  toolsUsed: string[];
  parameters?: Record<string, EvolvedSkillParam>;
  preconditions?: Record<string, unknown>;
  expectedOutcome?: string;
  qualityScore: number;
  reusabilityScore: number;
  status: EvolvedSkillStatus;
}

export interface ReviewEvolvedSkillInput {
  action: 'approve' | 'reject';
  comment?: string;
}

export interface UpdateEvolutionConfigInput {
  enabled?: boolean;
  autoApprove?: boolean;
  minQualityScore?: number;
  maxEvolvePerHour?: number;
  cooldownMinutes?: number;
}

export interface EvolutionStatsResponse {
  totalEvolved: number;
  approvedCount: number;
  rejectedCount: number;
  pendingCount: number;
  approvalRate: number;
  totalReuseCount: number;
  avgQualityScore: number;
  topSkills: TopEvolvedSkill[];
}

export interface TopEvolvedSkill {
  id: string;
  name: string;
  useCount: number;
  successRate: number;
}
```

---

## 修复清单

- [ ] 创建 `apps/api/src/routes/v1/evolved-skills.ts` — 5 个路由 + Zod Schema
- [ ] 修改 `apps/api/src/routes/v1/agents.ts` — 新增 2 个端点（统计 + 配置）
- [ ] 创建 `apps/api/src/services/evolved-skill.service.ts` — 业务逻辑
- [ ] 修改 `apps/api/src/routes/v1/index.ts` — 注册路由
- [ ] 更新 `packages/shared-types/src/dto.ts` — 新增 DTO 类型
- [ ] 实现审核状态前置检查（只有 pending_review 可审核）
- [ ] 实现提升状态前置检查（只有 approved/auto_approved 可提升）
- [ ] 实现统计聚合查询
- [ ] 实现进化配置更新（`sql.json()` 写入 JSONB）
- [ ] 所有端点包含 `org_id` 租户隔离

---

## 完成标准

- [ ] 7 个 API 端点全部可用
- [ ] 所有输入使用 Zod Schema 验证
- [ ] 响应格式符合 `ApiResponse<T>` 标准
- [ ] 字段命名统一 camelCase
- [ ] 错误响应包含明确错误码和提示
- [ ] 代码审查通过

---

## 相关文档

- [进化系统设计](docs/design/EVOLUTION.md) 第 6 节
- [API 规范](.claude/rules/api-standards.md)
- [PRD: 进化 API](.agents/PRDS/evolution-api.md)
