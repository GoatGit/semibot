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

// 报告类组件
import { ReportView } from './report/ReportView'

// 反馈类组件
import { ErrorView } from './feedback/ErrorView'
import { LoadingView } from './feedback/LoadingView'

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
  image: TextBlock, // TODO: 实现 ImageView 组件
  file: TextBlock, // TODO: 实现 FileDownload 组件
  plan: PlanView,
  progress: ProgressView,
  tool_call: ToolCallView,
  tool_result: ToolCallView, // 复用 ToolCallView
  error: ErrorView,
  thinking: ThinkingView,
  report: ReportView,
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
