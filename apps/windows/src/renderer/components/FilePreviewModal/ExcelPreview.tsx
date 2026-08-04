/**
 * ExcelPreview — 使用 SheetJS 将 .xlsx/.xls 渲染为 HTML 表格
 *
 * 每个 sheet 转为 HTML 表格（真实 DOM，单元格文字可框选复制），多 sheet 顶部标签切换。
 */

import React, { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import styles from './ExcelPreview.module.css'

export interface ExcelPreviewProps {
  /** Excel 原始字节 */
  bytes: Uint8Array
  fileName: string
}

export const ExcelPreview: React.FC<ExcelPreviewProps> = ({ bytes }) => {
  const [error, setError] = useState<string | null>(null)
  const [sheetNames, setSheetNames] = useState<string[]>([])
  const [activeSheet, setActiveSheet] = useState(0)
  const [htmlBySheet, setHtmlBySheet] = useState<string[]>([])

  useEffect(() => {
    setError(null)
    try {
      const wb = XLSX.read(bytes, { type: 'array' })
      const names = wb.SheetNames
      const htmls = names.map((n) => XLSX.utils.sheet_to_html(wb.Sheets[n], { editable: false }))
      setSheetNames(names)
      setHtmlBySheet(htmls)
      setActiveSheet(0)
    } catch (e) {
      setError(e instanceof Error ? e.message : '解析 Excel 失败')
    }
  }, [bytes])

  const activeHtml = useMemo(() => htmlBySheet[activeSheet] ?? '', [htmlBySheet, activeSheet])

  if (error) {
    return (
      <div className={styles.status}>
        <p className={styles.err}>{error}</p>
      </div>
    )
  }

  return (
    <div className={styles.wrap}>
      {sheetNames.length > 1 && (
        <div className={styles.tabs}>
          {sheetNames.map((name, i) => (
            <button
              key={name}
              className={i === activeSheet ? styles.tabActive : styles.tab}
              onClick={() => setActiveSheet(i)}
              title={name}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <div
        className={styles.table}
        // SheetJS 输出为受控的表格 HTML；限制在隔离容器内渲染
        dangerouslySetInnerHTML={{ __html: activeHtml }}
      />
    </div>
  )
}
