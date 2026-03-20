"use client"

import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node,
  type Edge,
  type DefaultEdgeOptions,
  MarkerType,
  Panel,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { CloudUpload, Zap, ArrowLeft, UserPlus, Loader2, History } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { apiClient } from '@/lib/api'
import { toast } from '@/stores/toastStore'
import { useLocale } from '@/components/providers/LocaleProvider'
import { useTheme } from '@/components/providers/ThemeProvider'
import { AgentNodeComponent } from '@/components/studio/AgentNodeComponent'
import type { Studio, Agent, AgentNode, StudioEdge } from '@/types'

const nodeTypes = { agent: AgentNodeComponent }

const defaultEdgeOptions: DefaultEdgeOptions = {
  type: 'bezier',
  style: { strokeWidth: 2 },
  animated: false,
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
}

function toFlowNodes(nodes: AgentNode[], agentMap: Map<string, Agent>): Node[] {
  return nodes.map((n) => {
    const agent = agentMap.get(n.agentId)
    const config = agent?.config as unknown as Record<string, unknown> | undefined
    return {
      id: n.id,
      type: 'agent',
      position: n.position,
      data: {
        agentName: agent?.name ?? n.agentId,
        agentId: n.agentId,
        studioInputs: config?.studioSchema
          ? (config.studioSchema as { inputs: { label: string }[] }).inputs
          : undefined,
      },
    }
  })
}

function toFlowEdges(edges: StudioEdge[]): Edge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: 'bezier',
    style: { strokeWidth: 2 },
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    animated: false,
  }))
}

export default function StudioCanvasPage() {
  const { studioId } = useParams<{ studioId: string }>()
  const router = useRouter()
  const { t } = useLocale()
  const { theme } = useTheme()
  const resolvedColorMode = (theme === 'light' ? 'light' : 'dark') as 'light' | 'dark'

  const [studio, setStudio] = useState<Studio | null>(null)
  const [agentMap, setAgentMap] = useState<Map<string, Agent>>(new Map())
  const [agents, setAgents] = useState<Agent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [showAddAgent, setShowAddAgent] = useState(false)
  const [showRunModal, setShowRunModal] = useState(false)
  const [runInputs, setRunInputs] = useState('')
  const [isRunning, setIsRunning] = useState(false)

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const nodeIdCounter = useRef(0)

  const loadStudio = useCallback(async () => {
    try {
      setIsLoading(true)
      const [studioRes, agentsRes] = await Promise.all([
        apiClient.get<{ success: boolean; data: Studio }>(`/studios/${studioId}`),
        apiClient.get<{ success: boolean; data: Agent[] }>('/agents'),
      ])
      if (studioRes.success && studioRes.data) {
        const s = studioRes.data
        setStudio(s)
        const map = new Map<string, Agent>()
        if (agentsRes.success && agentsRes.data) {
          agentsRes.data.forEach((a) => map.set(a.id, a))
          setAgents(agentsRes.data)
        }
        setAgentMap(map)
        setNodes(toFlowNodes(s.nodes, map))
        setEdges(toFlowEdges(s.edges))
      }
    } catch {
      toast.error(t('studio.error.load'))
    } finally {
      setIsLoading(false)
    }
  }, [studioId, t, setNodes, setEdges])

  useEffect(() => { loadStudio() }, [loadStudio])

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge(connection, eds)),
    [setEdges]
  )

  const handleSave = async () => {
    if (!studio) return
    try {
      setIsSaving(true)
      const studioNodes: AgentNode[] = nodes.map((n) => ({
        id: n.id,
        agentId: (n.data as { agentId: string }).agentId,
        position: n.position,
      }))
      const studioEdges: StudioEdge[] = edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
      }))
      await apiClient.put(`/studios/${studioId}`, { nodes: studioNodes, edges: studioEdges })
      toast.success(t('studio.saved'))
    } catch {
      toast.error(t('studio.error.save'))
    } finally {
      setIsSaving(false)
    }
  }

  const handleAddAgent = (agent: Agent) => {
    const id = `node_${Date.now()}_${nodeIdCounter.current++}`
    const config = agent.config as unknown as Record<string, unknown> | undefined
    const newNode: Node = {
      id,
      type: 'agent',
      position: { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 },
      data: {
        agentName: agent.name,
        agentId: agent.id,
        studioInputs: config?.studioSchema
          ? (config.studioSchema as { inputs: { label: string }[] }).inputs
          : undefined,
      },
    }
    setNodes((nds) => [...nds, newNode])
    setShowAddAgent(false)
  }

  const handleRun = async () => {
    try {
      setIsRunning(true)
      let inputs: Record<string, unknown> = {}
      if (runInputs.trim()) {
        try { inputs = JSON.parse(runInputs) } catch { toast.error(t('studio.error.invalidJson')); return }
      }
      const res = await apiClient.post<{ success: boolean; data: { runId: string } }>(`/studios/${studioId}/runs`, { inputs })
      if (res.success && res.data) {
        setShowRunModal(false)
        router.push(`/studio/${studioId}/runs/${res.data.runId}`)
      }
    } catch {
      toast.error(t('studio.error.run'))
    } finally {
      setIsRunning(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* 顶部工具栏 */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border bg-card shrink-0">
        <Button variant="secondary" size="sm" onClick={() => router.push('/studio')} title={t('common.back')}>
          <ArrowLeft size={15} />
        </Button>
        <span className="font-medium text-sm px-1 text-foreground">{studio?.name}</span>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => setShowAddAgent(true)}>
          <UserPlus size={14} className="mr-1.5" />
          {t('studio.addAgent')}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => router.push(`/studio/${studioId}/runs`)} title={t('studio.runs')}>
          <History size={14} className="mr-1.5" />
          {t('studio.runs')}
        </Button>
        <Button variant="secondary" size="sm" onClick={handleSave} disabled={isSaving} title={t('studio.save')}>
          {isSaving ? <Loader2 size={14} className="animate-spin" /> : <CloudUpload size={14} />}
        </Button>
        <Button size="sm" onClick={() => setShowRunModal(true)}>
          <Zap size={14} className="mr-1.5" />
          {t('studio.run')}
        </Button>
      </div>

      {/* 画布 */}
      <div className="flex-1 min-h-0 w-full h-full">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          colorMode={resolvedColorMode}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.3}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} />
          <Controls
            style={{
              background: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              borderRadius: '8px',
              overflow: 'hidden',
            }}
          />
          <MiniMap
            nodeColor="hsl(var(--muted))"
            maskColor="rgba(0,0,0,0.5)"
            style={{
              background: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              borderRadius: '8px',
            }}
          />
          <Panel position="bottom-center">
            <p className="text-xs text-muted-foreground bg-card/80 px-2 py-1 rounded">
              {t('studio.canvasHint')}
            </p>
          </Panel>
        </ReactFlow>
      </div>

      {/* 添加 Agent 弹窗 */}
      <Modal open={showAddAgent} onClose={() => setShowAddAgent(false)} title={t('studio.addAgent')}>
        <div className="space-y-1">
          {agents.filter((a) => a.isActive).length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">{t('agents.empty')}</p>
          )}
          {agents.filter((a) => a.isActive).map((agent) => (
            <button
              key={agent.id}
              className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-accent transition-colors border border-transparent hover:border-border"
              onClick={() => handleAddAgent(agent)}
            >
              <div className="font-medium text-sm">{agent.name}</div>
              {agent.description && (
                <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{agent.description}</div>
              )}
            </button>
          ))}
        </div>
      </Modal>

      {/* 运行弹窗 */}
      <Modal open={showRunModal} onClose={() => setShowRunModal(false)} title={t('studio.run')}>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-1 block">{t('studio.runInputs')}</label>
            <textarea
              className="w-full h-32 text-sm font-mono border border-border rounded p-2 bg-background resize-none focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder='{"key": "value"}'
              value={runInputs}
              onChange={(e) => setRunInputs(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-1">{t('studio.runInputsHint')}</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="tertiary" onClick={() => setShowRunModal(false)}>{t('common.cancel')}</Button>
            <Button onClick={handleRun} disabled={isRunning}>
              {isRunning && <Loader2 size={14} className="mr-1 animate-spin" />}
              <Zap size={14} className="mr-1" />
              {t('studio.run')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
