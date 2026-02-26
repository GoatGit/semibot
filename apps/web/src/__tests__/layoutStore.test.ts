/**
 * Layout Store 测试
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useLayoutStore } from '@/stores/layoutStore'
import { HOME_PATH } from '@/constants/config'

describe('Layout Store', () => {
  beforeEach(() => {
    // 重置 store 状态
    useLayoutStore.setState({
      navBarExpanded: true,
      detailCanvasMode: 'collapsed',
      hasDetailContent: false,
      currentPath: HOME_PATH,
    })
  })

  describe('初始状态', () => {
    it('should have correct initial state', () => {
      const state = useLayoutStore.getState()

      expect(state.navBarExpanded).toBe(true)
      expect(state.detailCanvasMode).toBe('collapsed')
      expect(state.hasDetailContent).toBe(false)
      expect(state.currentPath).toBe(HOME_PATH)
    })
  })

  describe('toggleNavBar', () => {
    it('should toggle nav bar state', () => {
      expect(useLayoutStore.getState().navBarExpanded).toBe(true)

      useLayoutStore.getState().toggleNavBar()
      expect(useLayoutStore.getState().navBarExpanded).toBe(false)

      useLayoutStore.getState().toggleNavBar()
      expect(useLayoutStore.getState().navBarExpanded).toBe(true)
    })
  })

  describe('expandNavBar', () => {
    it('should expand nav bar', () => {
      useLayoutStore.setState({ navBarExpanded: false })

      useLayoutStore.getState().expandNavBar()
      expect(useLayoutStore.getState().navBarExpanded).toBe(true)
    })
  })

  describe('collapseNavBar', () => {
    it('should collapse nav bar', () => {
      useLayoutStore.getState().collapseNavBar()
      expect(useLayoutStore.getState().navBarExpanded).toBe(false)
    })
  })

  describe('collapseDetail', () => {
    it('should collapse detail canvas', () => {
      useLayoutStore.setState({ detailCanvasMode: 'normal' })

      useLayoutStore.getState().collapseDetail()
      expect(useLayoutStore.getState().detailCanvasMode).toBe('collapsed')
    })
  })

  describe('expandDetail', () => {
    it('should expand detail canvas to normal', () => {
      useLayoutStore.getState().expandDetail()
      expect(useLayoutStore.getState().detailCanvasMode).toBe('normal')
    })
  })

  describe('maximizeDetail', () => {
    it('should maximize detail canvas', () => {
      useLayoutStore.getState().maximizeDetail()
      expect(useLayoutStore.getState().detailCanvasMode).toBe('maximized')
    })
  })

  describe('exitMaximize', () => {
    it('should exit maximize and return to normal', () => {
      useLayoutStore.setState({ detailCanvasMode: 'maximized' })

      useLayoutStore.getState().exitMaximize()
      expect(useLayoutStore.getState().detailCanvasMode).toBe('normal')
    })
  })

  describe('setHasDetailContent', () => {
    it('should set hasDetailContent', () => {
      useLayoutStore.getState().setHasDetailContent(true)
      expect(useLayoutStore.getState().hasDetailContent).toBe(true)
    })

    it('should collapse detail when no content', () => {
      useLayoutStore.setState({ detailCanvasMode: 'normal', hasDetailContent: true })

      useLayoutStore.getState().setHasDetailContent(false)

      expect(useLayoutStore.getState().hasDetailContent).toBe(false)
      expect(useLayoutStore.getState().detailCanvasMode).toBe('collapsed')
    })
  })

  describe('setCurrentPath', () => {
    it('should set current path and expand nav bar on home', () => {
      useLayoutStore.setState({ navBarExpanded: false })

      useLayoutStore.getState().setCurrentPath(HOME_PATH)

      expect(useLayoutStore.getState().currentPath).toBe(HOME_PATH)
      expect(useLayoutStore.getState().navBarExpanded).toBe(true)
    })

    it('should collapse nav bar on non-home paths', () => {
      useLayoutStore.getState().setCurrentPath('/chat/123')

      expect(useLayoutStore.getState().currentPath).toBe('/chat/123')
      expect(useLayoutStore.getState().navBarExpanded).toBe(false)
    })

    it('should collapse detail on settings path', () => {
      useLayoutStore.setState({ detailCanvasMode: 'normal' })

      useLayoutStore.getState().setCurrentPath('/settings')

      expect(useLayoutStore.getState().detailCanvasMode).toBe('collapsed')
    })
  })
})
