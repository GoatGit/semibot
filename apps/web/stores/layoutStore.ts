import { create } from 'zustand'
import { PATHS_WITHOUT_DETAIL, HOME_PATH } from '@/constants/config'

/**
 * Layout Store - 布局状态管理
 *
 * 根据 ARCHITECTURE.md 设计:
 * - navBarExpanded: 导航栏展开状态
 * - detailCanvasMode: 详情画布模式 (collapsed/normal/maximized)
 * - hasDetailContent: 是否有详情内容（控制自动折叠）
 * - currentPath: 当前路由路径（用于自动控制布局）
 */

export type DetailCanvasMode = 'collapsed' | 'normal' | 'maximized'

export interface DetailCanvasContent {
  kind: 'markdown'
  title: string
  filename?: string
  sourceUrl?: string
  content: string
}

export interface RuntimeSessionDetailContent {
  kind: 'runtime-session'
  title: string
  sessionId: string
  attemptId?: string
  latestRevision?: number
  latestCheckpointRevision?: number
  latestCheckpointStatus?: string
  pendingEventOutboxCount?: number
  pendingCheckpointOutboxCount?: number
  terminalReason?: string
  statusLabel: string
  actionLabel: string
  summary: string
  lastSeenAt: string
  idleFor: string
  failures: number
  loopAlerts: number
  drUpgrades: number
  totalTokens: string
  toolName?: string
  routeMode?: string
  routeReason?: string
  routeAt?: string
  drStatus?: string
  drReason?: string
  drAt?: string
  upgradeAt?: string
  upgradeReason?: string
  initialFocusedIncidentId?: string
  pathTransitions: Array<{
    id: string
    title: string
    detail: string
    createdAt: string
    variant: 'default' | 'success' | 'warning' | 'error'
  }>
  incidents: Array<{
    id: string
    type: string
    title: string
    detail: string
    createdAt: string
    raw?: Record<string, unknown>
  }>
}

export interface RuntimeAttemptDetailContent {
  kind: 'runtime-attempt'
  title: string
  attemptId: string
  sessionId: string
  userMessageId: string
  status: string
  executionMode: string
  latestRevision: number
  resumeCount: number
  approvalSetRevision: number
  terminalReason?: string
  latestCheckpoint: {
    checkpointId: string
    revision: number
    status: string
    createdAt: string
  } | null
  pendingEventOutboxCount: number
  pendingCheckpointOutboxCount: number
  notices: Array<{
    kind: string
    message: string
  }>
}

export interface DocumentChunkDetailContent {
  kind: 'document-chunk'
  title: string
  sessionId: string
  docId: string
  docTitle: string
  version: number
  totalChunks: number
  chunks: Array<{
    chunkId: string
    content: string
  }>
  selectedChunkId: string
}

export type DetailCanvasPayload =
  | DetailCanvasContent
  | RuntimeSessionDetailContent
  | RuntimeAttemptDetailContent
  | DocumentChunkDetailContent

interface LayoutState {
  // 状态
  navBarExpanded: boolean
  detailCanvasMode: DetailCanvasMode
  hasDetailContent: boolean
  currentPath: string
  detailContent: DetailCanvasPayload | null

  // 动作
  toggleNavBar: () => void
  expandNavBar: () => void
  collapseNavBar: () => void

  collapseDetail: () => void
  expandDetail: () => void
  maximizeDetail: () => void
  exitMaximize: () => void

  setHasDetailContent: (hasContent: boolean) => void
  setCurrentPath: (path: string) => void
  openDetailContent: (content: DetailCanvasPayload) => void
  clearDetailContent: () => void
}

export const useLayoutStore = create<LayoutState>((set) => ({
  // 初始状态
  navBarExpanded: true,
  detailCanvasMode: 'collapsed',
  hasDetailContent: false,
  currentPath: '/',
  detailContent: null,

  // 导航栏动作
  toggleNavBar: () =>
    set((state) => ({
      navBarExpanded: !state.navBarExpanded,
    })),

  expandNavBar: () =>
    set({
      navBarExpanded: true,
    }),

  collapseNavBar: () =>
    set({
      navBarExpanded: false,
    }),

  // 详情画布动作
  collapseDetail: () =>
    set({
      detailCanvasMode: 'collapsed',
    }),

  expandDetail: () =>
    set({
      detailCanvasMode: 'normal',
    }),

  maximizeDetail: () =>
    set({
      detailCanvasMode: 'maximized',
    }),

  exitMaximize: () =>
    set({
      detailCanvasMode: 'normal',
    }),

  // 详情内容状态
  setHasDetailContent: (hasContent) =>
    set((state) => ({
      hasDetailContent: hasContent,
      // 无内容时自动折叠
      detailCanvasMode: hasContent ? state.detailCanvasMode : 'collapsed',
    })),

  openDetailContent: (content) =>
    set((state) => ({
      detailContent: content,
      hasDetailContent: true,
      detailCanvasMode: state.detailCanvasMode === 'collapsed' ? 'normal' : state.detailCanvasMode,
    })),

  clearDetailContent: () =>
    set({
      detailContent: null,
      hasDetailContent: false,
      detailCanvasMode: 'collapsed',
    }),

  // 路由变更时更新布局
  setCurrentPath: (path) =>
    set(() => {
      const isHome = path === HOME_PATH
      const needsDetail = !PATHS_WITHOUT_DETAIL.some((p) => path.startsWith(p))

      return {
        currentPath: path,
        // 首页展开导航栏，其他页面收起
        navBarExpanded: isHome,
        // 路由切换时始终折叠，由页面组件主动调用 setHasDetailContent(true) 展开
        detailCanvasMode: 'collapsed',
        hasDetailContent: false,
        detailContent: null,
      }
    }),
}))
