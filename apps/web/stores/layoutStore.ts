import { create } from 'zustand'

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

// 不需要显示详情画布的路径
const PATHS_WITHOUT_DETAIL = ['/settings', '/agents']

// 首页路径（导航栏展开）
const HOME_PATH = '/'

interface LayoutState {
  // 状态
  navBarExpanded: boolean
  detailCanvasMode: DetailCanvasMode
  hasDetailContent: boolean
  currentPath: string

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
}

export const useLayoutStore = create<LayoutState>((set) => ({
  // 初始状态
  navBarExpanded: true,
  detailCanvasMode: 'collapsed',
  hasDetailContent: false,
  currentPath: '/',

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

  // 路由变更时更新布局
  setCurrentPath: (path) =>
    set(() => {
      const isHome = path === HOME_PATH
      const needsDetail = !PATHS_WITHOUT_DETAIL.some((p) => path.startsWith(p))

      return {
        currentPath: path,
        // 首页展开导航栏，其他页面收起
        navBarExpanded: isHome,
        // 不需要详情的页面自动收起
        detailCanvasMode: needsDetail ? 'collapsed' : 'collapsed',
        hasDetailContent: false,
      }
    }),
}))
