function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return undefined
}

/**
 * V2 前端固定为单用户无鉴权模式。
 *
 * 兼容旧环境变量：
 * - NEXT_PUBLIC_AUTH_DISABLED
 * - SEMIBOT_DISABLE_AUTH
 *
 * 说明：
 * - 不再读取 NEXT_PUBLIC_ENABLE_AUTH / SEMIBOT_ENABLE_AUTH，避免旧配置导致
 *   前端误跳转登录页。
 */
export function isAuthDisabled(): boolean {
  const explicitDisable =
    parseBooleanEnv(process.env.NEXT_PUBLIC_AUTH_DISABLED) ??
    parseBooleanEnv(process.env.SEMIBOT_DISABLE_AUTH)
  if (explicitDisable !== undefined) return explicitDisable

  return true
}

export const AUTH_DISABLED = isAuthDisabled()
