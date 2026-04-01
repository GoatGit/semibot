import { sql } from '../lib/db'
import { logPaginationLimit } from '../lib/logger'

export interface PaginatedMeta {
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface PaginatedResult<T> {
  data: T[]
  meta: PaginatedMeta
}

const MAX_LIMIT = 100

type BaseRow = {
  id: string
  org_id: string
}

export abstract class BaseRepository<TRow extends BaseRow, TEntity> {
  constructor(private readonly tableName: string) {}

  protected abstract toEntity(row: TRow): TEntity

  async findById(id: string): Promise<TEntity | null> {
    const rows = (await sql`SELECT * FROM ${sql(this.tableName)} WHERE id = ${id} AND deleted_at IS NULL LIMIT 1`) as TRow[]
    return rows[0] ? this.toEntity(rows[0]) : null
  }

  async findByIdAndOrg(id: string, orgId: string): Promise<TEntity | null> {
    const rows = (await sql`SELECT * FROM ${sql(this.tableName)} WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL LIMIT 1`) as TRow[]
    return rows[0] ? this.toEntity(rows[0]) : null
  }

  async countByOrg(orgId: string): Promise<number> {
    const rows = (await sql`SELECT COUNT(*) as count FROM ${sql(this.tableName)} WHERE org_id = ${orgId} AND deleted_at IS NULL`) as Array<{ count: string | number }>
    return Number(rows[0]?.count ?? 0)
  }

  async findByOrg(orgId: string, page = 1, limit = 20): Promise<PaginatedResult<TEntity>> {
    const safePage = Math.max(1, Math.trunc(page) || 1)
    const requestedLimit = Math.trunc(limit) || 1
    const safeLimit = Math.max(1, Math.min(MAX_LIMIT, requestedLimit))
    if (safeLimit !== requestedLimit) {
      logPaginationLimit(this.tableName, requestedLimit, safeLimit, MAX_LIMIT)
    }
    const total = await this.countByOrg(orgId)
    const offset = (safePage - 1) * safeLimit
    const rows = (await sql`
      SELECT * FROM ${sql(this.tableName)}
      WHERE org_id = ${orgId} AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${safeLimit} OFFSET ${offset}
    `) as TRow[]
    return {
      data: rows.map((row) => this.toEntity(row)),
      meta: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: total === 0 ? 0 : Math.ceil(total / safeLimit),
      },
    }
  }

  async softDelete(id: string, orgId: string, deletedBy?: string): Promise<boolean> {
    const rows = (await sql`
      UPDATE ${sql(this.tableName)}
      SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ${deletedBy ?? null}
      WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL
      RETURNING id
    `) as Array<{ id: string }>
    return rows.length > 0
  }

  async findByIds(ids: string[]): Promise<TEntity[]> {
    if (ids.length === 0) {
      return []
    }
    const rows = (await sql`
      SELECT * FROM ${sql(this.tableName)}
      WHERE id IN ${ids} AND deleted_at IS NULL
    `) as TRow[]
    return rows.map((row) => this.toEntity(row))
  }
}
