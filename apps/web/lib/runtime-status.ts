export function formatRuntimeStatusError(error?: string, source?: string): string | undefined {
  if (!error || !error.trim()) return undefined
  const text = error.trim()

  if (
    text.includes('fetch failed') ||
    text.includes('Failed to fetch') ||
    text.includes('ECONNREFUSED') ||
    text.includes('runtime unreachable')
  ) {
    return `无法连接 Runtime（${source || '未配置地址'}）。请确认 Runtime 已启动，并检查 RUNTIME_URL / 端口（推荐 8765）。`
  }

  if (text.includes('aborted') || text.includes('timeout')) {
    return `连接 Runtime 超时（${source || '未配置地址'}）。请检查 Runtime 进程和网络。`
  }

  if (text.includes('runtime returned')) {
    return `Runtime 服务可达，但接口异常：${text}。`
  }

  return text
}
