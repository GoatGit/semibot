'use client'

import clsx from 'clsx'

type BotToneName =
  | 'primary'
  | 'info'
  | 'success'
  | 'warning'
  | 'error'
  | 'violet'
  | 'teal'
  | 'rose'

interface AgentBotAvatarProps {
  agentId?: string | null
  agentName?: string | null
  tone?: BotToneName | string | null
  size?: number
  iconScale?: number
  monochrome?: boolean
  color?: string
  className?: string
}

type BotTone = {
  icon: string
}

const BOT_TONES: Record<BotToneName, BotTone> = {
  primary: {
    icon: '#caa4ea',
  },
  info: {
    icon: '#67b4ff',
  },
  success: {
    icon: '#5fd0a5',
  },
  warning: {
    icon: '#f0b35f',
  },
  error: {
    icon: '#f17d90',
  },
  violet: {
    icon: '#9f8cff',
  },
  teal: {
    icon: '#56c2c9',
  },
  rose: {
    icon: '#e98b9f',
  },
}

const HASH_TONES: BotToneName[] = ['primary', 'info', 'success', 'warning', 'error', 'violet', 'teal', 'rose']

function hashAgentKey(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0
  }
  return hash
}

function resolveTone(agentId?: string | null, agentName?: string | null, tone?: string | null): BotTone {
  if (tone && tone in BOT_TONES) {
    return BOT_TONES[tone as BotToneName]
  }
  const key = `${agentId || ''}::${agentName || ''}`.trim() || 'semibot'
  return BOT_TONES[HASH_TONES[hashAgentKey(key) % HASH_TONES.length]]
}

export function AgentBotAvatar({
  agentId,
  agentName,
  tone,
  size = 32,
  iconScale = 0.58,
  monochrome = false,
  color,
  className,
}: AgentBotAvatarProps) {
  const resolvedTone = resolveTone(agentId, agentName, tone)
  const iconSize = Math.max(14, Math.round(size * iconScale))

  return (
    <div
      className={clsx(
        'relative inline-flex items-center justify-center',
        className
      )}
      style={{
        width: size,
        height: size,
        background: 'transparent',
        boxShadow: 'none',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: iconSize,
          height: iconSize,
          backgroundColor: color || (monochrome ? 'currentColor' : resolvedTone.icon),
          filter: monochrome ? 'none' : 'drop-shadow(0 0 10px rgba(255,255,255,0.03))',
          WebkitMaskImage: "url('/bot.svg')",
          maskImage: "url('/bot.svg')",
          WebkitMaskPosition: 'center',
          maskPosition: 'center',
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
          WebkitMaskSize: 'contain',
          maskSize: 'contain',
        }}
      />
    </div>
  )
}
