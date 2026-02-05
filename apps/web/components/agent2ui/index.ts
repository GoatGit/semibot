/**
 * Agent2UI 组件库
 *
 * Semibot 的核心渲染系统
 * 根据 ARCHITECTURE.md 2.1.3 Agent2UI 渲染规范设计
 *
 * 设计理念：后端只传输结构化 JSON 数据，前端组件负责智能渲染
 */

// ═══════════════════════════════════════════════════════════════
// 核心渲染器
// ═══════════════════════════════════════════════════════════════
export {
  Agent2UIRenderer,
  Agent2UIMessageList,
  type Agent2UIRendererProps,
  type Agent2UIMessageListProps,
} from './Agent2UIRenderer'

// ═══════════════════════════════════════════════════════════════
// 组件注册中心
// ═══════════════════════════════════════════════════════════════
export {
  ComponentRegistry,
  getComponent,
  registerComponent,
} from './ComponentRegistry'

// ═══════════════════════════════════════════════════════════════
// 文本类组件
// ═══════════════════════════════════════════════════════════════
export { TextBlock, type TextBlockProps } from './text/TextBlock'
export { MarkdownBlock, type MarkdownBlockProps } from './text/MarkdownBlock'
export { CodeBlock, type CodeBlockProps } from './text/CodeBlock'

// ═══════════════════════════════════════════════════════════════
// 数据类组件
// ═══════════════════════════════════════════════════════════════
export { DataTable, type DataTableProps } from './data/DataTable'
export { Chart, type ChartProps } from './data/Chart'

// ═══════════════════════════════════════════════════════════════
// 过程类组件
// ═══════════════════════════════════════════════════════════════
export { PlanView, type PlanViewProps } from './process/PlanView'
export { ToolCallView, type ToolCallViewProps } from './process/ToolCallView'
export { ThinkingView, type ThinkingViewProps } from './process/ThinkingView'
export { ProgressView, type ProgressViewProps } from './process/ProgressView'

// ═══════════════════════════════════════════════════════════════
// 报告类组件
// ═══════════════════════════════════════════════════════════════
export { ReportView, type ReportViewProps } from './report/ReportView'

// ═══════════════════════════════════════════════════════════════
// 反馈类组件
// ═══════════════════════════════════════════════════════════════
export { ErrorView, type ErrorViewProps } from './feedback/ErrorView'
export {
  LoadingView,
  SkeletonCard,
  SkeletonTable,
  type LoadingViewProps,
  type SkeletonCardProps,
  type SkeletonTableProps,
} from './feedback/LoadingView'
