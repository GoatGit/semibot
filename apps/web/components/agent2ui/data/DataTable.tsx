'use client'

import { useState, useMemo, useCallback } from 'react'
import clsx from 'clsx'
import { ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, ChevronRight } from 'lucide-react'
import type { TableData, TableColumn } from '@/types'

/**
 * DataTable - 数据表格组件
 *
 * 支持排序和分页功能
 */

export interface DataTableProps {
  data: TableData
  className?: string
  onPageChange?: (page: number) => void
}

type SortDirection = 'asc' | 'desc' | null

interface SortState {
  column: string | null
  direction: SortDirection
}

export function DataTable({ data, className, onPageChange }: DataTableProps) {
  const [sortState, setSortState] = useState<SortState>({
    column: null,
    direction: null,
  })

  // 排序逻辑
  const sortedRows = useMemo(() => {
    if (!sortState.column || !sortState.direction) {
      return data.rows
    }

    const column = data.columns.find((col: TableColumn) => col.key === sortState.column)
    if (!column) return data.rows

    return [...data.rows].sort((a, b) => {
      const aVal = a[sortState.column as string]
      const bVal = b[sortState.column as string]

      if (aVal === null || aVal === undefined) return 1
      if (bVal === null || bVal === undefined) return -1

      let comparison = 0
      if (column.type === 'number') {
        comparison = (Number(aVal) || 0) - (Number(bVal) || 0)
      } else if (column.type === 'date') {
        comparison = new Date(String(aVal)).getTime() - new Date(String(bVal)).getTime()
      } else {
        comparison = String(aVal).localeCompare(String(bVal))
      }

      return sortState.direction === 'desc' ? -comparison : comparison
    })
  }, [data.rows, data.columns, sortState])

  const handleSort = useCallback((columnKey: string) => {
    setSortState((prev) => {
      if (prev.column !== columnKey) {
        return { column: columnKey, direction: 'asc' }
      }
      if (prev.direction === 'asc') {
        return { column: columnKey, direction: 'desc' }
      }
      return { column: null, direction: null }
    })
  }, [])

  const renderSortIcon = (columnKey: string) => {
    if (sortState.column !== columnKey) {
      return <ArrowUpDown className="w-4 h-4 opacity-50" />
    }
    if (sortState.direction === 'asc') {
      return <ArrowUp className="w-4 h-4 text-primary-500" />
    }
    return <ArrowDown className="w-4 h-4 text-primary-500" />
  }

  const formatCellValue = (value: unknown, column: TableColumn): string => {
    if (value === null || value === undefined) return '-'

    if (column.type === 'date') {
      try {
        return new Date(String(value)).toLocaleDateString('zh-CN')
      } catch {
        return String(value)
      }
    }

    if (column.type === 'number') {
      const num = Number(value)
      if (!isNaN(num)) {
        return num.toLocaleString('zh-CN')
      }
    }

    return String(value)
  }

  const { pagination } = data
  const totalPages = pagination
    ? Math.ceil(pagination.total / pagination.pageSize)
    : 1

  return (
    <div className={clsx('overflow-hidden rounded-lg border border-border-subtle', className)}>
      {/* 表格容器 */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-bg-elevated border-b border-border-subtle">
              {data.columns.map((column: TableColumn) => (
                <th
                  key={column.key}
                  className={clsx(
                    'px-4 py-3 text-left font-medium text-text-secondary',
                    'whitespace-nowrap',
                    'cursor-pointer select-none',
                    'transition-colors duration-fast',
                    'hover:bg-interactive-hover hover:text-text-primary'
                  )}
                  onClick={() => handleSort(column.key)}
                >
                  <div className="flex items-center gap-2">
                    <span>{column.title}</span>
                    {renderSortIcon(column.key)}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row: Record<string, unknown>, rowIndex: number) => (
              <tr
                key={rowIndex}
                className={clsx(
                  'border-b border-border-subtle last:border-b-0',
                  'transition-colors duration-fast',
                  'hover:bg-interactive-hover'
                )}
              >
                {data.columns.map((column: TableColumn) => (
                  <td
                    key={column.key}
                    className={clsx(
                      'px-4 py-3 text-text-primary',
                      column.type === 'number' && 'text-right font-mono'
                    )}
                  >
                    {formatCellValue(row[column.key], column)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 分页 */}
      {pagination && totalPages > 1 && (
        <div
          className={clsx(
            'flex items-center justify-between',
            'px-4 py-3',
            'bg-bg-elevated border-t border-border-subtle'
          )}
        >
          <span className="text-sm text-text-secondary">
            共 {pagination.total} 条，第 {pagination.page} / {totalPages} 页
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onPageChange?.(pagination.page - 1)}
              disabled={pagination.page <= 1}
              className={clsx(
                'p-1.5 rounded',
                'text-text-secondary',
                'transition-colors duration-fast',
                'hover:bg-interactive-hover hover:text-text-primary',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
              aria-label="上一页"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={() => onPageChange?.(pagination.page + 1)}
              disabled={pagination.page >= totalPages}
              className={clsx(
                'p-1.5 rounded',
                'text-text-secondary',
                'transition-colors duration-fast',
                'hover:bg-interactive-hover hover:text-text-primary',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
              aria-label="下一页"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

DataTable.displayName = 'DataTable'
