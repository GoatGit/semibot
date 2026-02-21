export type SkillPackage = {
  skill_id: string
  version: string
  files: Array<{ path: string; content: string; encoding: string }>
}

export type SkillIndexEntry = {
  id: string
  version?: string
  name?: string
}

export class SkillLoader {
  private readonly index = new Map<string, SkillIndexEntry>()
  private readonly loaded = new Map<string, SkillPackage>()

  hydrateFromIndex(index: unknown): void {
    this.index.clear()
    if (!Array.isArray(index)) return
    for (const item of index) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      const id = String(row.id ?? '')
      if (!id) continue
      this.index.set(id, {
        id,
        version: row.version ? String(row.version) : undefined,
        name: row.name ? String(row.name) : undefined,
      })
    }
  }

  nextRequiredSkill(): SkillIndexEntry | null {
    for (const [id, entry] of this.index.entries()) {
      if (!this.loaded.has(id)) return entry
    }
    return null
  }

  markLoaded(pkg: SkillPackage): void {
    this.loaded.set(pkg.skill_id, pkg)
  }

  load(skillId: string): SkillPackage | null {
    return this.loaded.get(skillId) ?? null
  }

  loadedCount(): number {
    return this.loaded.size
  }
}
