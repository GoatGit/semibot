/**
 * 压缩包解压工具
 *
 * 支持 .zip 和 .tar.gz/.tgz 格式
 * 包含 Zip Slip 路径遍历防护
 */

import * as path from 'path'
import * as fs from 'fs-extra'
import AdmZip from 'adm-zip'
import * as tar from 'tar'
import { createError } from '../middleware/errorHandler'
import { SKILL_UPLOAD_EXTRACT_FAILED } from '../constants/errorCodes'
import { createLogger } from '../lib/logger'

const extractLogger = createLogger('archive-extractor')

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

type ArchiveFormat = 'zip' | 'tar.gz'

// ═══════════════════════════════════════════════════════════════
// 格式检测
// ═══════════════════════════════════════════════════════════════

/**
 * 根据扩展名判断压缩包格式
 */
export function detectFormat(filePath: string): ArchiveFormat {
  const lowerPath = filePath.toLowerCase()
  if (lowerPath.endsWith('.zip')) {
    return 'zip'
  }
  if (lowerPath.endsWith('.tar.gz') || lowerPath.endsWith('.tgz')) {
    return 'tar.gz'
  }
  throw createError(SKILL_UPLOAD_EXTRACT_FAILED, `无法识别的压缩包格式: ${path.basename(filePath)}`)
}

// ═══════════════════════════════════════════════════════════════
// ZIP 解压
// ═══════════════════════════════════════════════════════════════

/** 需要跳过的文件/目录 */
const SKIP_PATTERNS = ['__MACOSX', '.DS_Store']

function shouldSkipEntry(entryName: string): boolean {
  return SKIP_PATTERNS.some(
    (pattern) => entryName.includes(pattern)
  )
}

/**
 * 解压 ZIP 文件
 *
 * 包含 Zip Slip 路径遍历防护：检查每个 entry 的 resolve 路径是否在 destDir 内
 */
export async function extractZip(archivePath: string, destDir: string): Promise<void> {
  try {
    const zip = new AdmZip(archivePath)
    const entries = zip.getEntries()

    await fs.ensureDir(destDir)
    const resolvedDest = path.resolve(destDir)

    for (const entry of entries) {
      if (shouldSkipEntry(entry.entryName)) {
        continue
      }

      const resolvedEntryPath = path.resolve(destDir, entry.entryName)

      // Zip Slip 防护：确保解压路径在目标目录内
      if (!resolvedEntryPath.startsWith(resolvedDest + path.sep) && resolvedEntryPath !== resolvedDest) {
        extractLogger.warn('检测到路径遍历攻击，跳过条目', {
          entryName: entry.entryName,
          resolvedPath: resolvedEntryPath,
          destDir: resolvedDest,
        })
        continue
      }

      if (entry.isDirectory) {
        await fs.ensureDir(resolvedEntryPath)
      } else {
        await fs.ensureDir(path.dirname(resolvedEntryPath))
        await fs.writeFile(resolvedEntryPath, entry.getData())
      }
    }

    extractLogger.info('ZIP 解压完成', {
      archivePath,
      destDir,
      entryCount: entries.length,
    })
  } catch (error) {
    if ((error as any)?.code === SKILL_UPLOAD_EXTRACT_FAILED) {
      throw error
    }
    extractLogger.error('ZIP 解压失败', error as Error)
    throw createError(SKILL_UPLOAD_EXTRACT_FAILED, `ZIP 解压失败: ${(error as Error).message}`)
  }
}

// ═══════════════════════════════════════════════════════════════
// TAR.GZ 解压
// ════════════════════════════════════════════════════════════��══

/**
 * 解压 tar.gz 文件
 *
 * tar 库内置路径遍历防护
 */
export async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  try {
    await fs.ensureDir(destDir)

    await tar.extract({
      file: archivePath,
      cwd: destDir,
      filter: (entryPath: string) => !shouldSkipEntry(entryPath),
    })

    extractLogger.info('tar.gz 解压完成', {
      archivePath,
      destDir,
    })
  } catch (error) {
    extractLogger.error('tar.gz 解压失败', error as Error)
    throw createError(SKILL_UPLOAD_EXTRACT_FAILED, `tar.gz 解压失败: ${(error as Error).message}`)
  }
}

// ═══════════════════════════════════════════════════════════════
// 统一入口
// ═══════════════════════════════════════════════════════════════

/**
 * 解压压缩包（自动检测格式）
 */
export async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  const format = detectFormat(archivePath)

  if (format === 'zip') {
    await extractZip(archivePath, destDir)
  } else {
    await extractTarGz(archivePath, destDir)
  }
}

// ═══════════════════════════════════════════════════════════════
// 包根目录检测
// ═══════════════════════════════════════════════════════════════

/** 技能包标识文件 */
const PACKAGE_MARKERS = ['SKILL.md', 'manifest.json']

/**
 * 智能检测包根目录
 *
 * 如果解压后只有一个顶层目录，则进入该目录
 * 检查 SKILL.md 或 manifest.json 确认包根目录
 */
export async function findPackageRoot(extractedDir: string): Promise<string> {
  // 检查当前目录是否包含标识文件
  for (const marker of PACKAGE_MARKERS) {
    if (await fs.pathExists(path.join(extractedDir, marker))) {
      return extractedDir
    }
  }

  // 检查是否只有一个顶层目录
  const entries = await fs.readdir(extractedDir)
  const nonHiddenEntries = entries.filter((e) => !e.startsWith('.'))

  if (nonHiddenEntries.length === 1) {
    const singleEntry = path.join(extractedDir, nonHiddenEntries[0])
    const stat = await fs.stat(singleEntry)

    if (stat.isDirectory()) {
      // 检查子目录是否包含标识文件
      for (const marker of PACKAGE_MARKERS) {
        if (await fs.pathExists(path.join(singleEntry, marker))) {
          return singleEntry
        }
      }
      // 即使没有标识文件，也返回唯一的子目录
      return singleEntry
    }
  }

  // 默认返回解压目录本身
  return extractedDir
}
