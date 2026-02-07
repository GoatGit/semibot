## Task: 前端沙箱日志展示功能

**ID:** app-web-sandbox-log-display
**Label:** Semibot: 实现沙箱执行日志实时展示
**Description:** 新增 SSE 消息类型和组件，支持沙箱代码执行的实时日志流展示
**Type:** Feature
**Status:** Completed
**Priority:** P1 - High
**Created:** 2026-02-07
**Updated:** 2026-02-07

---

### 背景

当前前端 SSE 消息展示功能缺少沙箱执行日志的实时展示能力：
- `ToolCallView` 组件只展示工具调用的最终结果，不支持实时日志流
- `ExecutionLog` 类型已定义但未被前端组件使用
- 用户无法看到沙箱代码执行过程中的 stdout/stderr 输出

### 目标

1. 支持沙箱执行过程中的实时日志流展示
2. 支持代码执行输出（stdout/stderr）的分类展示
3. 提供清晰的执行状态和时间线追踪

---

### 技术方案

#### Phase 1: 类型定义扩展

**文件:** `apps/web/types/index.ts`

```typescript
// 新增消息类型
export type Agent2UIType =
  | ... // 现有类型
  | 'sandbox_log'      // 沙箱实时日志
  | 'sandbox_output'   // 代码执行输出

// 沙箱日志数据结构
export interface SandboxLogData {
  sandboxId: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  timestamp: string
  source?: string  // 日志来源模块
}

// 沙箱输出数据结构
export interface SandboxOutputData {
  sandboxId: string
  stream: 'stdout' | 'stderr'
  content: string
  timestamp: string
  exitCode?: number  // 执行结束时的退出码
}

// 沙箱状态数据结构
export interface SandboxStatusData {
  sandboxId: string
  status: 'starting' | 'running' | 'success' | 'error' | 'timeout'
  startedAt?: string
  endedAt?: string
  durationMs?: number
  resourceUsage?: {
    cpuPercent?: number
    memoryMb?: number
  }
}
```

#### Phase 2: 组件实现

**2.1 SandboxLogView 组件**

**文件:** `apps/web/components/agent2ui/process/SandboxLogView.tsx`

功能：
- 实时显示沙箱执行日志
- 支持日志级别过滤（debug/info/warn/error）
- 支持日志搜索
- 自动滚动到最新日志
- 支持展开/折叠

```typescript
export interface SandboxLogViewProps {
  data: SandboxLogData
  className?: string
}

export function SandboxLogView({ data, className }: SandboxLogViewProps) {
  // 根据 level 显示不同颜色
  // debug: text-text-tertiary
  // info: text-text-secondary
  // warn: text-warning-500
  // error: text-error-500
}
```

**2.2 SandboxOutputView 组件**

**文件:** `apps/web/components/agent2ui/process/SandboxOutputView.tsx`

功能：
- 分离展示 stdout 和 stderr
- 支持终端风格渲染（黑底绿字/白字）
- 支持 ANSI 颜色码解析
- 显示退出码

```typescript
export interface SandboxOutputViewProps {
  data: SandboxOutputData
  className?: string
}

export function SandboxOutputView({ data, className }: SandboxOutputViewProps) {
  // stdout: 正常输出样式
  // stderr: 错误输出样式（红色）
}
```

**2.3 SandboxExecutionCard 组件（聚合组件）**

**文件:** `apps/web/components/agent2ui/process/SandboxExecutionCard.tsx`

功能：
- 聚合展示单次沙箱执行的完整信息
- 头部显示状态、执行时长
- 可展开查看详细日志和输出
- 支持日志和输出的 Tab 切换

```typescript
export interface SandboxExecutionCardProps {
  sandboxId: string
  status: SandboxStatusData
  logs: SandboxLogData[]
  outputs: SandboxOutputData[]
  className?: string
}
```

#### Phase 3: 组件注册

**文件:** `apps/web/components/agent2ui/ComponentRegistry.tsx`

```typescript
import { SandboxLogView } from './process/SandboxLogView'
import { SandboxOutputView } from './process/SandboxOutputView'

const defaultComponentMap: Record<Agent2UIType, Agent2UIComponent> = {
  // ... 现有映射
  sandbox_log: SandboxLogView,
  sandbox_output: SandboxOutputView,
}
```

#### Phase 4: SSE Hook 扩展

**文件:** `apps/web/hooks/useSSE.ts`

- 确保支持新的消息类型解析
- 无需特殊处理，现有架构已支持

#### Phase 5: 状态管理（可选）

**文件:** `apps/web/stores/sandboxStore.ts`

```typescript
interface SandboxState {
  executions: Map<string, {
    status: SandboxStatusData
    logs: SandboxLogData[]
    outputs: SandboxOutputData[]
  }>
}

// 用于聚合同一 sandboxId 的多条消息
```

---

### Checklist

- [ ] 扩展 `types/index.ts` 添加新类型定义
  - [ ] `SandboxLogData`
  - [ ] `SandboxOutputData`
  - [ ] `SandboxStatusData`
  - [ ] 更新 `Agent2UIType` 联合类型
  - [ ] 更新 `Agent2UIData` 联合类型
- [ ] 创建 `SandboxLogView` 组件
  - [ ] 日志级别颜色区分
  - [ ] 时间戳格式化
  - [ ] 日志来源显示
- [ ] 创建 `SandboxOutputView` 组件
  - [ ] stdout/stderr 区分展示
  - [ ] 终端风格样式
  - [ ] ANSI 颜色码支持（可选）
  - [ ] 退出码展示
- [ ] 创建 `SandboxExecutionCard` 聚合组件
  - [ ] 状态头部展示
  - [ ] Tab 切换（日志/输出）
  - [ ] 展开/折叠功能
  - [ ] 自动滚动到底部
- [ ] 更新 `ComponentRegistry` 注册新组件
- [ ] 创建 `sandboxStore` 状态管理（可选）
- [ ] 编写单元测试
- [ ] 编写 Storybook stories

---

### 相关文件

**新建：**
- `apps/web/types/index.ts` (修改)
- `apps/web/components/agent2ui/process/SandboxLogView.tsx`
- `apps/web/components/agent2ui/process/SandboxOutputView.tsx`
- `apps/web/components/agent2ui/process/SandboxExecutionCard.tsx`
- `apps/web/stores/sandboxStore.ts` (可选)

**修改：**
- `apps/web/components/agent2ui/ComponentRegistry.tsx`

---

### 依赖

- 后端需同步支持发送 `sandbox_log` 和 `sandbox_output` 类型的 SSE 消息
- 沙箱服务需实现日志流推送

### 参考

- 现有 `ToolCallView` 组件实现
- `ExecutionLog` 类型定义
