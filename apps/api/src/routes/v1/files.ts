import { Router, type Response } from 'express'
import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { authenticate, type AuthRequest } from '../../middleware/auth'

const router: Router = Router()

const GENERATED_FILES_DIR = path.resolve(
  process.env.GENERATED_FILES_DIR ?? '/tmp/semibot/generated-files'
)
const FILE_ID_PATTERN = /^[a-f0-9]{32}$/i

async function resolveStoredFile(fileId: string): Promise<{ absPath: string; filename: string } | null> {
  if (!FILE_ID_PATTERN.test(fileId)) return null

  const candidateDir = path.resolve(GENERATED_FILES_DIR, fileId)
  if (!candidateDir.startsWith(`${GENERATED_FILES_DIR}${path.sep}`)) return null

  let entries: Dirent<string>[]
  try {
    entries = await fs.readdir(candidateDir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return null
  }

  const fileEntry = entries.find((entry) => entry.isFile())
  if (!fileEntry) return null

  const absPath = path.resolve(candidateDir, fileEntry.name)
  if (!absPath.startsWith(`${candidateDir}${path.sep}`)) return null
  return { absPath, filename: fileEntry.name }
}

router.get(
  '/:fileId',
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const { fileId } = req.params
    const resolved = await resolveStoredFile(fileId)
    if (!resolved) {
      res.status(404).json({
        success: false,
        error: { code: 'FILE_NOT_FOUND', message: '文件不存在或已过期' },
      })
      return
    }

    res.download(resolved.absPath, resolved.filename, (err) => {
      if (!err) return
      if (res.headersSent) return
      res.status(500).json({
        success: false,
        error: { code: 'FILE_DOWNLOAD_FAILED', message: '文件下载失败' },
      })
    })
  }
)

export default router
