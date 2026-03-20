'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { useLayoutStore } from '@/stores/layoutStore'

/**
 * useLayoutSync - 同步路由与布局状态
 *
 * 根据当前路由自动调整:
 * - 导航栏展开/收起（首页展开，其他页面收起）
 * - 详情画布显示/隐藏（设置页、agents 页等不显示）
 */
export function useLayoutSync() {
  const pathname = usePathname()
  const setCurrentPath = useLayoutStore((state) => state.setCurrentPath)

  useEffect(() => {
    setCurrentPath(pathname)
  }, [pathname, setCurrentPath])
}

export default useLayoutSync
