"use client"

import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { ChevronRight } from 'lucide-react'
import { AgentBotAvatar } from '@/components/ui/AgentBotAvatar'
import type { StudioInputHint } from '@/types'

export interface AgentNodeData {
  agentName: string
  agentId: string
  studioInputs?: StudioInputHint[]
}

export const AgentNodeComponent = memo(function AgentNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as AgentNodeData

  return (
    <div
      className={`
        relative rounded-xl shadow-lg min-w-[180px] max-w-[240px] overflow-hidden
        border transition-all duration-150
        ${selected
          ? 'border-primary shadow-primary/20 shadow-lg'
          : 'border-white/10 hover:border-white/20'
        }
      `}
      style={{ background: 'hsl(var(--card))' }}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!w-2.5 !h-2.5 !bg-primary !border-2 !border-background"
      />

      {/* Header accent bar */}
      <div className="h-0.5 w-full bg-gradient-to-r from-primary/60 via-primary to-primary/60" />

      <div className="px-3 py-2.5 flex items-center gap-2">
        <AgentBotAvatar
          agentId={nodeData.agentId}
          agentName={nodeData.agentName}
          size={28}
          iconScale={0.64}
          monochrome
          className="shrink-0 text-primary"
        />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-sm truncate leading-tight">{nodeData.agentName}</div>
          <div className="text-[10px] text-muted-foreground font-mono truncate mt-0.5">
            {nodeData.agentId.slice(0, 8)}…
          </div>
        </div>
      </div>

      {nodeData.studioInputs && nodeData.studioInputs.length > 0 && (
        <div className="px-3 pb-2.5 border-t border-white/5">
          <div className="text-[10px] text-muted-foreground mt-2 mb-1 uppercase tracking-wide font-medium">
            期望输入
          </div>
          <ul className="space-y-0.5">
            {nodeData.studioInputs.map((hint, i) => (
              <li key={i} className="text-xs flex items-center gap-1 text-muted-foreground">
                <ChevronRight size={10} className="text-primary/60 shrink-0" />
                <span>{hint.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-2.5 !h-2.5 !bg-primary !border-2 !border-background"
      />
    </div>
  )
})
