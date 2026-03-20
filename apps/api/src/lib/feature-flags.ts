function parseBooleanFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return defaultValue
}

export function isChannelsFeatureEnabled(): boolean {
  return parseBooleanFlag(process.env.SEMIBOT_CHANNELS_ENABLED, true)
}

export function isWebhooksFeatureEnabled(): boolean {
  return parseBooleanFlag(process.env.SEMIBOT_WEBHOOKS_ENABLED, true)
}

