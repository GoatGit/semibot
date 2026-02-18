/**
 * Repository 泛型基类
 *
 * 提供 findById、findByIdAndOrg、countByOrg、softDelete、findByIds 等通用方法。
 * 子类只需定义表名和 toEntity 转换，以及特殊查询。
 */

import { sql } from '../lib/db'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface PaginatedResult<T> {
  data: T[]
  meta: {
    total: number
    page: number
    limit: number
    totalPages: number
  }
}

// ═══════════════════════════════════════════════════════════════
// 基类
// ═══════════════════════════════════════════════════════════════

export abstract class BaseRepository<TRow, TEntity = TRow> {
  protected readonly sql = sql

  constructor(
    protected readonly tableName: string,
  ) {}

  /**
   * 行数据 → 实体转换（子类必须实现）
   */
  protected abstract toEntity(row: TRow): TEntity

  /**
   * 按 ID 查询
   */
  async findById(id: string): Promise<TEntity | null> {
    const rows = await sql`
      SELECT * FROM ${sql(this.tableName)}
      WHERE id = ${id} AND deleted_at IS NULL
    `

    if (rows.length === 0) return null
    return this.toEntity(rows[0] as TRow)
  }

  /**
   * 按 ID + org_id 查询（租户隔离）
   */
  async findByIdAndOrg(id: string, orgId: string): Promise<TEntity | null> {
    const rows = await sql`
      SELECT * FROM ${sql(this.tableName)}
      WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL
    `

    if (rows.length === 0) return null
    return this.toEntity(rows[0] as TRow)
  }

  /**
   * 按 org_id 计数
   */
  async countByOrg(orgId: string): Promise<number> {
    const result = await sql`
      SELECT COUNT(*) as count FROM ${sql(this.tableName)}
      WHERE org_id = ${orgId} AND deleted_at IS NULL
    `
    return parseInt((result[0] as { count: string }).count, 10)
  }

  /**
   * 软删除
   */
  async softDelete(id: string, orgId: string, deletedBy?: string): Promise<boolean> {
    const result = await sql`
      UPDATE ${sql(this.tableName)}
      SET deleted_at = NOW(),
          deleted_by = ${deletedBy ?? null}
      WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL
      RETURNING id
    `
    return result.length > 0
  }

  /**
   * 批量查询（避免 N+1）
   */
  async findByIds(ids: string[]): Promise<TEntity[]> {
    if (ids.length === 0) return []

    const rows = await sql`
      SELECT * FROM ${sql(this.tableName)}
      WHERE id = ANY(${ids}::uuid[]) AND deleted_at IS NULL
    `
    return rows.map((row) => this.toEntity(row as TRow))
  }
}
