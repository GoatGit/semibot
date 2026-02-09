'use client'

import type { ComponentType } from 'react'
import type { Agent2UIType } from '@/types'

// 文本类组件
import { TextBlock } from './text/TextBlock'
import { MarkdownBlock } from './text/MarkdownBlock'
import { CodeBlock } from './text/CodeBlock'

// 数据类组件
import { DataTable } from './data/DataTable'
import { Chart } from './data/Chart'

// 过程类组件
import { PlanView } from './process/PlanView'
import { ToolCallView } from './process/ToolCallView'
import { ThinkingView } from './process/ThinkingView'
import { ProgressView } from './process/ProgressView'
import { SandboxLogView } from './process/SandboxLogView'
import { SandboxOutputView } from './process/SandboxOutputView'

// 报告类组件
import { ReportView } from './report/ReportView'

// 媒体类组件
import { ImageView } from './media/ImageView'
import { FileDownload } from './media/FileDownload'

// 反馈类组件
import { ErrorView } from './feedback/ErrorView'
// LoadingView is used directly in components, not via registry
// import { LoadingView } from './feedback/LoadingView'

/**
 * ComponentRegistry - 组件注册中心
 *
 * 根据 ARCHITECTURE.md 2.1.4 设计
 * 管理所有 Agent2UI 组件的注册和获取
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Agent2UIComponent = ComponentType<{ data: any; metadata?: Record<string, unknown> }>

/**
 * 默认组件映射表
 */
const defaultComponentMap: Record<Agent2UIType, Agent2UIComponent> = {
  text: TextBlock,
  markdown: MarkdownBlock,
  code: CodeBlock,
  table: DataTable,
  chart: Chart,
  image: ImageView,
  file: FileDownload,
  plan: PlanView,
  progress: ProgressView,
  tool_call: ToolCallView,
  tool_result: ToolCallView, // 复用 ToolCallView
  skill_call: ToolCallView, // 复用 ToolCallView
  skill_result: ToolCallView, // 复用 ToolCallView
  mcp_call: ToolCallView, // 复用 ToolCallView
  mcp_result: ToolCallView, // 复用 ToolCallView
  plan_step: PlanView, // 复用 PlanView
  error: ErrorView,
  thinking: ThinkingView,
  report: ReportView,
  sandbox_log: SandboxLogView,
  sandbox_output: SandboxOutputView,
  sandbox_status: SandboxOutputView, // 复用 SandboxOutputView
}

/**
 * 组件注册表类
 * 支持运行时注册和覆盖组件
 */
class ComponentRegistryClass {
  private components: Map<Agent2UIType, Agent2UIComponent>

  constructor() {
    this.components = new Map(
      Object.entries(defaultComponentMap) as [Agent2UIType, Agent2UIComponent][]
    )
  }

  /**
   * 获取指定类型的组件
   */
  get(type: Agent2UIType): Agent2UIComponent | undefined {
    return this.components.get(type)
  }

  /**
   * 注册或覆盖组件
   */
  register(type: Agent2UIType, component: Agent2UIComponent): void {
    this.components.set(type, component)
  }

  /**
   * 批量注册组件
   */
  registerAll(components: Partial<Record<Agent2UIType, Agent2UIComponent>>): void {
    Object.entries(components).forEach(([type, component]) => {
      if (component) {
        this.components.set(type as Agent2UIType, component)
      }
    })
  }

  /**
   * 检查是否已注册指定类型
   */
  has(type: Agent2UIType): boolean {
    return this.components.has(type)
  }

  /**
   * 获取所有已注册的类型
   */
  getRegisteredTypes(): Agent2UIType[] {
    return Array.from(this.components.keys())
  }

  /**
   * 重置为默认组件映射
   */
  reset(): void {
    this.components = new Map(
      Object.entries(defaultComponentMap) as [Agent2UIType, Agent2UIComponent][]
    )
  }
}

/**
 * 全局组件注册表实例
 */
export const ComponentRegistry = new ComponentRegistryClass()

/**
 * 获取组件的快捷方法
 */
export function getComponent(type: Agent2UIType): Agent2UIComponent | undefined {
  return ComponentRegistry.get(type)
}

/**
 * 注册组件的快捷方法
 */
export function registerComponent(
  type: Agent2UIType,
  component: Agent2UIComponent
): void {
  ComponentRegistry.register(type, component)
}
