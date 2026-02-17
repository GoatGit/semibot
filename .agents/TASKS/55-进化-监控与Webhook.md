# 任务：进化系统 — 监控与 Webhook

**优先级**: 🟢 P2 - 一般
**类型**: 功能实现
**预估工时**: 1-2 天
**影响范围**: apps/api/src/metrics/、apps/api/src/events/、runtime/src/evolution/

---

## 问题描述

进化系统需要可观测性支持，包括 Prometheus 监控指标和 Webhook 事件通知。监控指标用于运维监控和告警，Webhook 事件用于外部系统集成和通知。

---

## 详细实现

### 1. Prometheus 指标定义

```typescript
// apps/api/src/metrics/evolution.metrics.ts

import { Counter, Histogram, Gauge } from 'prom-client';

// 进化触发总次数
export const evolutionTriggeredTotal = new Counter({
  name: 'evolution_triggered_total',
  help: '进化触发总次数',
  labelNames: ['org_id', 'agent_id'],
});

// 进化成功次数
export const evolutionSuccessTotal = new Counter({
  name: 'evolution_success_total',
  help: '进化成功次数',
  labelNames: ['org_id', 'agent_id'],
});

// 技能质量分布
export const evolutionSkillQuality = new Histogram({
  name: 'evolution_skill_quality',
  help: '技能质量评分分布',
  labelNames: ['org_id'],
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
});

// 进化技能被复用次数
export const evolvedSkillReuseTotal = new Counter({
  name: 'evolved_skill_reuse_total',
  help: '进化技能被复用次数',
  labelNames: ['org_id', 'skill_id'],
});

// 复用成功率
export const evolvedSkillReuseSuccessRate = new Gauge({
  name: 'evolved_skill_reuse_success_rate',
  help: '进化技能复用成功率',
  labelNames: ['org_id', 'skill_id'],
});

// 进化流程耗时
export const evolutionDurationSeconds = new Histogram({
  name: 'evolution_duration_seconds',
  help: '进化流程耗时（秒）',
  labelNames: ['org_id', 'stage'],
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
});

// 进化消耗的 Token
export const evolutionTokensTotal = new Counter({
  name: 'evolution_tokens_total',
  help: '进化消耗的 Token 总数',
  labelNames: ['org_id', 'stage'],
});
```

### 2. 指标采集集成（Runtime 侧）

```python
# runtime/src/evolution/metrics.py

import time
from src.utils.logging import get_logger

logger = get_logger(__name__)


class EvolutionMetrics:
    """进化指标采集器"""

    def __init__(self, metrics_client=None):
        self.client = metrics_client

    def record_triggered(self, org_id: str, agent_id: str) -> None:
        """记录进化触发"""
        if self.client:
            self.client.increment(
                'evolution_triggered_total',
                labels={'org_id': org_id, 'agent_id': agent_id}
            )

    def record_success(self, org_id: str, agent_id: str) -> None:
        """记录进化成功"""
        if self.client:
            self.client.increment(
                'evolution_success_total',
                labels={'org_id': org_id, 'agent_id': agent_id}
            )

    def record_quality(self, org_id: str, quality_score: float) -> None:
        """记录技能质量"""
        if self.client:
            self.client.observe(
                'evolution_skill_quality',
                quality_score,
                labels={'org_id': org_id}
            )

    def record_reuse(self, org_id: str, skill_id: str) -> None:
        """记录技能复用"""
        if self.client:
            self.client.increment(
                'evolved_skill_reuse_total',
                labels={'org_id': org_id, 'skill_id': skill_id}
            )

    def record_duration(self, org_id: str, stage: str, duration_seconds: float) -> None:
        """记录阶段耗时"""
        if self.client:
            self.client.observe(
                'evolution_duration_seconds',
                duration_seconds,
                labels={'org_id': org_id, 'stage': stage}
            )

    def record_tokens(self, org_id: str, stage: str, tokens: int) -> None:
        """记录 Token 消耗"""
        if self.client:
            self.client.increment(
                'evolution_tokens_total',
                tokens,
                labels={'org_id': org_id, 'stage': stage}
            )
```

### 3. Webhook 事件定义

```typescript
// apps/api/src/events/evolution.events.ts

export const EVOLUTION_EVENTS = {
  TRIGGERED: 'evolution.triggered',
  SKILL_CREATED: 'evolution.skill_created',
  SKILL_APPROVED: 'evolution.skill_approved',
  SKILL_REJECTED: 'evolution.skill_rejected',
  SKILL_DEPRECATED: 'evolution.skill_deprecated',
  SKILL_PROMOTED: 'evolution.skill_promoted',
} as const;

export type EvolutionEventType = typeof EVOLUTION_EVENTS[keyof typeof EVOLUTION_EVENTS];

export interface EvolutionEvent {
  type: EvolutionEventType;
  timestamp: string;
  orgId: string;
  data: EvolutionEventData;
}

export interface EvolutionEventData {
  agentId: string;
  sessionId?: string;
  skillId?: string;
  skillName?: string;
  qualityScore?: number;
  status?: string;
  reviewedBy?: string;
  comment?: string;
}
```

### 4. Webhook 事件触发

```typescript
// apps/api/src/events/evolution.emitter.ts

import { logger } from '@/lib/logger';
import { EVOLUTION_EVENTS, EvolutionEvent, EvolutionEventData } from './evolution.events';

export class EvolutionEventEmitter {

  static async emit(
    type: string,
    orgId: string,
    data: EvolutionEventData
  ): Promise<void> {
    const event: EvolutionEvent = {
      type: type as any,
      timestamp: new Date().toISOString(),
      orgId,
      data,
    };

    logger.info('[Evolution] Webhook 事件触发', {
      type: event.type,
      orgId,
      skillId: data.skillId,
    });

    // 发送到 Webhook 订阅者
    try {
      await WebhookService.dispatch(orgId, event);
    } catch (error) {
      logger.error('[Evolution] Webhook 发送失败', {
        type: event.type,
        error: (error as Error).message,
      });
      // Webhook 失败不影响主流程
    }
  }

  // 便捷方法
  static async emitSkillCreated(orgId: string, skill: any): Promise<void> {
    await this.emit(EVOLUTION_EVENTS.SKILL_CREATED, orgId, {
      agentId: skill.agentId,
      sessionId: skill.sessionId,
      skillId: skill.id,
      skillName: skill.name,
      qualityScore: skill.qualityScore,
      status: skill.status,
    });
  }

  static async emitSkillApproved(orgId: string, skill: any, reviewedBy: string): Promise<void> {
    await this.emit(EVOLUTION_EVENTS.SKILL_APPROVED, orgId, {
      agentId: skill.agentId,
      skillId: skill.id,
      skillName: skill.name,
      reviewedBy,
    });
  }

  static async emitSkillRejected(
    orgId: string, skill: any, reviewedBy: string, comment?: string
  ): Promise<void> {
    await this.emit(EVOLUTION_EVENTS.SKILL_REJECTED, orgId, {
      agentId: skill.agentId,
      skillId: skill.id,
      skillName: skill.name,
      reviewedBy,
      comment,
    });
  }

  static async emitSkillDeprecated(orgId: string, skill: any): Promise<void> {
    await this.emit(EVOLUTION_EVENTS.SKILL_DEPRECATED, orgId, {
      agentId: skill.agentId,
      skillId: skill.id,
      skillName: skill.name,
    });
  }

  static async emitSkillPromoted(orgId: string, skill: any): Promise<void> {
    await this.emit(EVOLUTION_EVENTS.SKILL_PROMOTED, orgId, {
      agentId: skill.agentId,
      skillId: skill.id,
      skillName: skill.name,
    });
  }
}
```

### 5. 集成到现有代码

在以下位置调用指标采集和事件触发：

- `EvolutionEngine._evolve()` — 触发 `evolution.triggered`，记录 `evolution_triggered_total`
- `EvolutionEngine._register()` — 触发 `evolution.skill_created`，记录 `evolution_success_total` 和 `evolution_skill_quality`
- `EvolvedSkillService.review()` — 触发 `evolution.skill_approved` 或 `evolution.skill_rejected`
- `EvolvedSkillService.deprecate()` — 触发 `evolution.skill_deprecated`
- `EvolvedSkillService.promote()` — 触发 `evolution.skill_promoted`
- `plan_node` 技能复用时 — 记录 `evolved_skill_reuse_total`
- 每个进化阶段 — 记录 `evolution_duration_seconds` 和 `evolution_tokens_total`

---

## 修复清单

- [ ] 创建 `apps/api/src/metrics/evolution.metrics.ts` — 7 个 Prometheus 指标
- [ ] 创建 `runtime/src/evolution/metrics.py` — Runtime 侧指标采集器
- [ ] 创建 `apps/api/src/events/evolution.events.ts` — 6 个 Webhook 事件定义
- [ ] 创建 `apps/api/src/events/evolution.emitter.ts` — 事件触发器
- [ ] 在 `EvolutionEngine` 中集成指标采集
- [ ] 在 `EvolvedSkillService` 中集成 Webhook 事件触发
- [ ] 在 `plan_node` 中集成复用指标
- [ ] 注册指标到 `apps/api/src/metrics/index.ts`
- [ ] 注册事件到 `apps/api/src/events/index.ts`
- [ ] Webhook 失败不影响主流程（try-catch 包裹）

---

## 完成标准

- [ ] 7 个 Prometheus 指标正确采集
- [ ] 6 个 Webhook 事件在对应操作时正确触发
- [ ] 指标和事件包含正确的 label（org_id、agent_id 等）
- [ ] Webhook 发送失败不影响主流程
- [ ] 代码审查通过

---

## 相关文档

- [进化系统设计](docs/design/EVOLUTION.md) 第 8、9 节
- [PRD: 进化质量治理](.agents/PRDS/evolution-quality-governance.md)
