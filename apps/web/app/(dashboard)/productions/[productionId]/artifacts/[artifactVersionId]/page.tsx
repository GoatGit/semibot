"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, Copy, FileJson, GitCompare, Loader2, Share2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardContent } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { useLocale } from '@/components/providers/LocaleProvider'
import { apiClient } from '@/lib/api'
import { toast } from '@/stores/toastStore'
import type { ArtifactDiffSummary, ArtifactLineageSummary, ArtifactVersion } from '@/types'

interface ArtifactContentResponse {
  success: boolean
  data: {
    artifact: ArtifactVersion
    content: string
  }
}

interface ArtifactLineageResponse {
  success: boolean
  data: ArtifactLineageSummary
}

interface ArtifactDiffResponse {
  success: boolean
  data: ArtifactDiffSummary
}

function parseJsonContent(content: string): unknown | null {
  try {
    return JSON.parse(content)
  } catch {
    return null
  }
}

function detectPreviewMode(artifact: ArtifactVersion, content: string): 'json' | 'markdown' | 'text' {
  if (artifact.artifactType.toLowerCase().includes('json')) return 'json'
  if (parseJsonContent(content) !== null) return 'json'
  if (artifact.artifactType.toLowerCase().includes('markdown') || /^\s*(#|- |\* )/m.test(content)) return 'markdown'
  return 'text'
}

function JsonPreview({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (depth > 3) {
    return <div className="text-xs text-muted-foreground">…</div>
  }
  if (Array.isArray(value)) {
    return (
      <div className="space-y-2">
        {value.map((item, index) => (
          <div key={index} className="rounded-lg border border-border/60 bg-background/40 p-3">
            <div className="mb-2 text-xs text-muted-foreground">[{index}]</div>
            <JsonPreview value={item} depth={depth + 1} />
          </div>
        ))}
      </div>
    )
  }
  if (value && typeof value === 'object') {
    return (
      <div className="space-y-2">
        {Object.entries(value).map(([key, child]) => (
          <div key={key} className="rounded-lg border border-border/60 bg-background/40 p-3">
            <div className="mb-2 text-xs font-medium text-muted-foreground">{key}</div>
            <JsonPreview value={child} depth={depth + 1} />
          </div>
        ))}
      </div>
    )
  }
  return <div className="text-sm text-foreground">{String(value ?? '--')}</div>
}

function MarkdownPreview({ content }: { content: string }) {
  const lines = content.split('\n')
  return (
    <div className="space-y-3">
      {lines.map((line, index) => {
        const trimmed = line.trim()
        if (!trimmed) return <div key={index} className="h-2" />
        if (trimmed.startsWith('# ')) return <h3 key={index} className="text-lg font-semibold">{trimmed.slice(2)}</h3>
        if (trimmed.startsWith('## ')) return <h4 key={index} className="text-base font-semibold">{trimmed.slice(3)}</h4>
        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
          return <div key={index} className="pl-4 text-sm text-foreground">• {trimmed.slice(2)}</div>
        }
        return <p key={index} className="text-sm leading-6 text-foreground">{line}</p>
      })}
    </div>
  )
}

export default function ProductionArtifactPage() {
  const { t } = useLocale()
  const params = useParams<{ productionId: string; artifactVersionId: string }>()
  const productionId = params.productionId
  const artifactVersionId = params.artifactVersionId
  const [artifact, setArtifact] = useState<ArtifactVersion | null>(null)
  const [content, setContent] = useState('')
  const [lineage, setLineage] = useState<ArtifactLineageSummary | null>(null)
  const [diff, setDiff] = useState<ArtifactDiffSummary | null>(null)
  const [selectedBaseId, setSelectedBaseId] = useState('')
  const [summaryDraft, setSummaryDraft] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSavingSummary, setIsSavingSummary] = useState(false)

  const load = useCallback(async () => {
    try {
      setIsLoading(true)
      const [contentRes, lineageRes] = await Promise.all([
        apiClient.get<ArtifactContentResponse>(`/productions/${productionId}/artifacts/${artifactVersionId}/content`),
        apiClient.get<ArtifactLineageResponse>(`/productions/${productionId}/artifacts/${artifactVersionId}/lineage`),
      ])
      if (contentRes.success && contentRes.data) {
        setArtifact(contentRes.data.artifact)
        setContent(contentRes.data.content || '')
        setSummaryDraft(contentRes.data.artifact.summary || '')
      }
      if (lineageRes.success && lineageRes.data) {
        setLineage(lineageRes.data)
        setSelectedBaseId(lineageRes.data.previous?.id || '')
      }
    } catch (error) {
      console.error('[APS] load artifact workspace failed', error)
      toast.error(t('aps.errors.loadArtifactWorkspace'))
    } finally {
      setIsLoading(false)
    }
  }, [artifactVersionId, productionId, t])

  const loadDiff = useCallback(async (baseArtifactVersionId?: string) => {
    try {
      const query = baseArtifactVersionId ? `?baseArtifactVersionId=${encodeURIComponent(baseArtifactVersionId)}` : ''
      const res = await apiClient.get<ArtifactDiffResponse>(
        `/productions/${productionId}/artifacts/${artifactVersionId}/diff${query}`,
      )
      if (res.success && res.data) setDiff(res.data)
    } catch (error) {
      console.error('[APS] load artifact diff failed', error)
      toast.error(t('aps.errors.loadArtifactDiff'))
    }
  }, [artifactVersionId, productionId, t])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!artifact) return
    void loadDiff(selectedBaseId || undefined)
  }, [artifact, loadDiff, selectedBaseId])

  const compareCandidates = useMemo(
    () => (lineage?.related || []).filter((item) => item.id !== artifactVersionId).sort((a, b) => b.version - a.version),
    [artifactVersionId, lineage],
  )
  const previewMode = useMemo(() => (artifact ? detectPreviewMode(artifact, content) : 'text'), [artifact, content])
  const parsedJson = useMemo(() => (previewMode === 'json' ? parseJsonContent(content) : null), [content, previewMode])

  const handleCopy = async (value: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(successMessage)
    } catch {
      toast.error(t('aps.errors.copy'))
    }
  }

  const handleSaveSummary = async () => {
    try {
      setIsSavingSummary(true)
      const res = await apiClient.post<{ success: boolean; data: ArtifactVersion }>(
        `/productions/${productionId}/artifacts/${artifactVersionId}/summary`,
        { summary: summaryDraft },
      )
      if (res.success && res.data) {
        setArtifact(res.data)
        toast.success(t('aps.toast.artifactSummarySaved'))
      }
    } catch (error) {
      console.error('[APS] save artifact summary failed', error)
      toast.error(t('aps.errors.saveArtifactSummary'))
    } finally {
      setIsSavingSummary(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!artifact) {
    return <div className="flex flex-1 items-center justify-center text-muted-foreground">{t('aps.empty.artifactNotFound')}</div>
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
      <div className="p-6 max-w-7xl mx-auto w-full space-y-6">
        <div className="space-y-2">
          <Link href={`/productions/${productionId}`} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft size={14} />
            {t('aps.buttons.backToProductionDetail')}
          </Link>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <FileJson size={18} className="text-primary" />
                <h1 className="text-xl font-semibold">{artifact.artifactKey} v{artifact.version}</h1>
                <Badge variant="outline">{artifact.reviewState}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{artifact.artifactType} · schema={artifact.schemaVersion}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => void handleCopy(content, t('aps.toast.artifactContentCopied'))}>
                <Copy size={16} className="mr-1" />
                {t('aps.buttons.copyContent')}
              </Button>
              <Button variant="secondary" onClick={() => void handleCopy(JSON.stringify(artifact, null, 2), t('aps.toast.artifactMetadataCopied'))}>
                <Share2 size={16} className="mr-1" />
                {t('aps.buttons.copyMetadata')}
              </Button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.fields.artifactKey')}</div><div className="mt-2 font-medium">{artifact.artifactKey}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.fields.version')}</div><div className="mt-2 font-medium">{artifact.version}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.fields.createdByTask')}</div><div className="mt-2 text-sm break-all">{artifact.createdByTaskId || '--'}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t('aps.fields.storage')}</div><div className="mt-2 text-sm break-all">{artifact.storageUri}</div></CardContent></Card>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-6">
          <Card>
            <CardContent className="p-5 space-y-3">
              <div>
                <h2 className="font-semibold">{t('aps.artifact.contentTitle')}</h2>
                <p className="text-sm text-muted-foreground mt-1">{t('aps.artifact.contentHint')}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{t(`aps.artifact.previewMode.${previewMode}`)}</Badge>
                <span className="text-xs text-muted-foreground">schema={artifact.schemaVersion}</span>
              </div>
              <div className="min-h-[360px] overflow-auto rounded-xl border border-border bg-background/60 p-4">
                {!content ? (
                  <div className="text-sm text-muted-foreground">{t('aps.empty.noArtifactContent')}</div>
                ) : previewMode === 'json' && parsedJson !== null ? (
                  <JsonPreview value={parsedJson} />
                ) : previewMode === 'markdown' ? (
                  <MarkdownPreview content={content} />
                ) : (
                  <pre className="whitespace-pre-wrap break-words text-sm text-foreground">{content}</pre>
                )}
              </div>
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardContent className="p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <GitCompare size={16} className="text-primary" />
                  <h2 className="font-semibold">{t('aps.artifact.lineageTitle')}</h2>
                </div>
                <div className="space-y-3">
                  {(lineage?.related || [artifact]).map((item) => (
                    <Link
                      key={item.id}
                      href={`/productions/${productionId}/artifacts/${item.id}`}
                      className={`block rounded-xl border p-3 ${item.id === artifact.id ? 'border-primary/40 bg-primary/5' : 'border-border hover:border-primary/20'}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-medium">{item.artifactKey} v{item.version}</div>
                          <div className="text-xs text-muted-foreground mt-1">{item.reviewState}</div>
                        </div>
                        {item.id === lineage?.previous?.id ? <Badge variant="outline">{t('aps.labels.previousVersion')}</Badge> : null}
                      </div>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">{t('aps.artifact.diffTitle')}</h2>
                    <p className="text-sm text-muted-foreground mt-1">{t('aps.artifact.diffHint')}</p>
                  </div>
                  <select
                    value={selectedBaseId}
                    onChange={(e) => setSelectedBaseId(e.target.value)}
                    className="rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary focus:border-primary-500 focus:shadow-glow-primary focus:outline-none"
                  >
                    <option value="">{t('aps.artifact.autoSelectPrevious')}</option>
                    {compareCandidates.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.artifactKey} v{candidate.version}
                      </option>
                    ))}
                  </select>
                </div>

                {diff ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-3 gap-3">
                      <div className="rounded-xl border border-border p-3">
                        <div className="text-xs text-muted-foreground">{t('aps.fields.base')}</div>
                        <div className="mt-1 text-sm">{diff.baseArtifact ? `${diff.baseArtifact.artifactKey} v${diff.baseArtifact.version}` : t('aps.empty.noBaseVersion')}</div>
                      </div>
                      <div className="rounded-xl border border-border p-3">
                        <div className="text-xs text-muted-foreground">{t('aps.fields.added')}</div>
                        <div className="mt-1 text-sm">{diff.stats.added}</div>
                      </div>
                      <div className="rounded-xl border border-border p-3">
                        <div className="text-xs text-muted-foreground">{t('aps.fields.removed')}</div>
                        <div className="mt-1 text-sm">{diff.stats.removed}</div>
                      </div>
                    </div>
                    <div className="max-h-[420px] overflow-auto rounded-xl border border-border bg-background/60">
                      {diff.lines.length === 0 ? (
                        <div className="p-4 text-sm text-muted-foreground">{t('aps.empty.noArtifactDiff')}</div>
                      ) : (
                        <div className="divide-y divide-border">
                          {diff.lines.map((line, index) => (
                            <div
                              key={`${line.type}-${index}`}
                              className={`px-4 py-2 text-sm whitespace-pre-wrap break-words ${
                                line.type === 'added'
                                  ? 'bg-emerald-500/10 text-emerald-300'
                                  : line.type === 'removed'
                                    ? 'bg-rose-500/10 text-rose-300'
                                    : 'text-muted-foreground'
                              }`}
                            >
                              <span className="mr-2 opacity-70">
                                {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                              </span>
                              {line.content || ' '}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">{t('aps.empty.noArtifactDiffData')}</div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 space-y-4">
                <div>
                  <h2 className="font-semibold">{t('aps.artifact.summaryTitle')}</h2>
                  <p className="text-sm text-muted-foreground mt-1">{t('aps.artifact.summaryHint')}</p>
                </div>
                <textarea
                  value={summaryDraft}
                  onChange={(e) => setSummaryDraft(e.target.value)}
                  className="w-full min-h-28 rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-primary-500 focus:shadow-glow-primary focus:outline-none"
                  placeholder={t('aps.artifact.summaryPlaceholder')}
                />
                <div className="flex justify-end">
                  <Button onClick={() => void handleSaveSummary()} disabled={isSavingSummary}>
                    {isSavingSummary ? <Loader2 size={16} className="mr-1 animate-spin" /> : null}
                    {t('aps.buttons.saveSummary')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
