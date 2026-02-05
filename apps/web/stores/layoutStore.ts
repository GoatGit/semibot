import { create } from 'zustand'

/**
 * Layout Store - 布局状态管理
 *
 * 根据 ARCHITECTURE.md 设计:
 * - navBarExpanded: 导航栏展开状态
 * - detailCanvasMode: 详情画布模式 (collapsed/normal/maximized)
 * - hasDetailContent: 是否有详情内容（控制自动折叠）
 */

export type DetailCanvasMode = 'collapsed' | 'normal' | 'maximized'

interface LayoutState {
  // 状态
  navBarExpanded: boolean
  detailCanvasMode: DetailCanvasMode
  hasDetailContent: boolean

  // 动作
  toggleNavBar: () => void
  expandNavBar: () => void
  collapseNavBar: () => void

  collapseDetail: () => void
  expandDetail: () => void
  maximizeDetail: () => void
  exitMaximize: () => void

  setHasDetailContent: (hasContent: boolean) => void
}

export const useLayoutStore = create<LayoutState>((set) => ({
  // 初始状态
  navBarExpanded: true,
  detailCanvasMode: 'normal',
  hasDetailContent: true,

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
}))
