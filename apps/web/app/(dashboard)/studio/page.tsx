"use client"

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Clapperboard, Plus, Trash2, Loader2, Play } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardContent } from '@/components/ui/Card'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { apiClient } from '@/lib/api'
import { toast } from '@/stores/toastStore'
import { useLocale } from '@/components/providers/LocaleProvider'
import type { Studio } from '@/types'

export default function StudioListPage() {
  const router = useRouter()
  const { t } = useLocale()
  const [studios, setStudios] = useState<Studio[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<Studio | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const loadStudios = useCallback(async () => {
    try {
      setIsLoading(true)
      const res = await apiClient.get<{ success: boolean; data: Studio[] }>('/studios')
      if (res.success && res.data) setStudios(res.data)
    } catch {
      toast.error(t('studio.error.load'))
    } finally {
      setIsLoading(false)
    }
  }, [t])

  useEffect(() => { loadStudios() }, [loadStudios])

  const handleCreate = async () => {
    if (!createName.trim()) return
    try {
      setIsCreating(true)
      const res = await apiClient.post<{ success: boolean; data: Studio }>('/studios', {
        name: createName.trim(),
        description: createDesc.trim() || undefined,
      })
      if (res.success && res.data) {
        setShowCreate(false)
        setCreateName('')
        setCreateDesc('')
        router.push(`/studio/${res.data.id}`)
      }
    } catch {
      toast.error(t('studio.error.create'))
    } finally {
      setIsCreating(false)
    }
  }

  const handleDelete = async () => {
    if (!confirmDelete) return
    try {
      setIsDeleting(true)
      await apiClient.delete(`/studios/${confirmDelete.id}`)
      setConfirmDelete(null)
      await loadStudios()
      toast.success(t('studio.deleted'))
    } catch {
      toast.error(t('studio.error.delete'))
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
      <div className="p-6 max-w-5xl mx-auto w-full">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Clapperboard size={22} className="text-primary" />
            <h1 className="text-xl font-semibold">{t('nav.studio')}</h1>
          </div>
          <Button onClick={() => setShowCreate(true)}>
            <Plus size={16} className="mr-1" />
            {t('studio.create')}
          </Button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 size={24} className="animate-spin text-muted-foreground" />
          </div>
        ) : studios.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Clapperboard size={40} className="mx-auto mb-3 opacity-30" />
            <p>{t('studio.empty')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {studios.map((studio) => (
              <Card key={studio.id} className="hover:shadow-md transition-shadow">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/studio/${studio.id}`} className="flex-1 min-w-0">
                      <h3 className="font-medium truncate hover:text-primary">{studio.name}</h3>
                      {studio.description && (
                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{studio.description}</p>
                      )}
                      <p className="text-xs text-muted-foreground mt-2">
                        {studio.nodes.length} {t('studio.nodes')} · {studio.edges.length} {t('studio.edges')}
                      </p>
                    </Link>
                    <div className="flex gap-1 shrink-0">
                      <Button
                        variant="tertiary"
                        size="sm"
                        onClick={() => router.push(`/studio/${studio.id}/runs`)}
                        title={t('studio.runs')}
                      >
                        <Play size={14} />
                      </Button>
                      <Button
                        variant="tertiary"
                        size="sm"
                        onClick={() => setConfirmDelete(studio)}
                        title={t('common.delete')}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

      <Modal
        open={showCreate}
        onClose={() => { setShowCreate(false); setCreateName(''); setCreateDesc('') }}
        title={t('studio.create')}
      >
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-1 block">{t('studio.name')}</label>
            <Input
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder={t('studio.namePlaceholder')}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">{t('studio.description')}</label>
            <Input
              value={createDesc}
              onChange={(e) => setCreateDesc(e.target.value)}
              placeholder={t('studio.descriptionPlaceholder')}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="tertiary" onClick={() => setShowCreate(false)}>{t('common.cancel')}</Button>
            <Button onClick={handleCreate} disabled={!createName.trim() || isCreating}>
              {isCreating && <Loader2 size={14} className="mr-1 animate-spin" />}
              {t('common.create')}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title={t('studio.deleteConfirm')}
      >
        <p className="text-sm text-muted-foreground mb-4">
          {t('studio.deleteWarning', { name: confirmDelete?.name ?? '' })}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="tertiary" onClick={() => setConfirmDelete(null)}>{t('common.cancel')}</Button>
          <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
            {isDeleting && <Loader2 size={14} className="mr-1 animate-spin" />}
            {t('common.delete')}
          </Button>
        </div>
      </Modal>
      </div>
    </div>
  )
}
