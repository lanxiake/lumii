/**
 * A2UI DataTable 组件 — 支持排序、筛选、分页的数据表格
 */

import React, { useMemo, useState } from 'react'
import styles from './A2UIRenderer.module.css'
import type { A2UIDataTable } from './types'

type SortOrder = 'asc' | 'desc' | null

interface SortState {
  key: string | null
  order: SortOrder
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return -1
  if (b === null || b === undefined) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

export const DataTableComponent: React.FC<A2UIDataTable> = ({
  columns,
  rows,
  pageSize = 20,
  filterable = false,
}) => {
  const [sort, setSort] = useState<SortState>({ key: null, order: null })
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(0)

  const toggleSort = (key: string) => {
    setSort((prev) => {
      if (prev.key !== key) return { key, order: 'asc' }
      if (prev.order === 'asc') return { key, order: 'desc' }
      return { key: null, order: null }
    })
    setPage(0)
  }

  const filteredRows = useMemo(() => {
    if (!filter.trim()) return rows
    const lower = filter.toLowerCase()
    return rows.filter((row) =>
      columns.some((col) => String(row[col.key] ?? '').toLowerCase().includes(lower)),
    )
  }, [rows, filter, columns])

  const sortedRows = useMemo(() => {
    if (!sort.key || !sort.order) return filteredRows
    const key = sort.key
    const multiplier = sort.order === 'asc' ? 1 : -1
    return [...filteredRows].sort((a, b) => compareValues(a[key], b[key]) * multiplier)
  }, [filteredRows, sort])

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize))
  const currentPage = Math.min(page, totalPages - 1)
  const pagedRows = sortedRows.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
  const showPagination = sortedRows.length > pageSize

  const renderSortIcon = (col: { key: string; sortable?: boolean }) => {
    if (!col.sortable) return null
    if (sort.key !== col.key) return <span className={styles['data-table-sort-icon']}>⇅</span>
    return (
      <span className={styles['data-table-sort-icon-active']}>
        {sort.order === 'asc' ? '↑' : '↓'}
      </span>
    )
  }

  return (
    <div className={styles['data-table-wrap']}>
      {filterable && (
        <div className={styles['data-table-toolbar']}>
          <input
            type="text"
            className={styles['data-table-filter']}
            placeholder="筛选…"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value)
              setPage(0)
            }}
          />
          <span className={styles['data-table-count']}>
            {sortedRows.length} / {rows.length} 行
          </span>
        </div>
      )}
      <div className={styles['data-table-scroll']}>
        <table className={styles['data-table']}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={col.sortable ? styles['data-table-th-sortable'] : undefined}
                  onClick={col.sortable ? () => toggleSort(col.key) : undefined}
                >
                  <span>{col.label}</span>
                  {renderSortIcon(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pagedRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className={styles['data-table-empty']}>
                  暂无数据
                </td>
              </tr>
            ) : (
              pagedRows.map((row, i) => (
                <tr key={i}>
                  {columns.map((col) => (
                    <td key={col.key}>{String(row[col.key] ?? '')}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {showPagination && (
        <div className={styles['data-table-pagination']}>
          <button
            className={styles['data-table-page-btn']}
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            上一页
          </button>
          <span className={styles['data-table-page-info']}>
            {currentPage + 1} / {totalPages}
          </span>
          <button
            className={styles['data-table-page-btn']}
            disabled={currentPage >= totalPages - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            下一页
          </button>
        </div>
      )}
    </div>
  )
}
