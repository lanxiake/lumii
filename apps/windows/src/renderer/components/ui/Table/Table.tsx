import React, { ReactNode } from 'react';
import clsx from 'clsx';
import Loading from '../Loading';
import Empty from '../Empty';
import styles from './Table.module.css';

export interface TableColumn<T = any> {
  key: string;
  title: string;
  width?: string | number;
  render?: (record: T, index: number) => ReactNode;
}

export interface TableProps<T = any> {
  columns: TableColumn<T>[];
  data: T[];
  loading?: boolean;
  emptyText?: string;
  emptyDescription?: string;
  rowKey?: string | ((record: T) => string);
  onRowClick?: (record: T, index: number) => void;
  className?: string;
}

function Table<T extends Record<string, any>>({
  columns,
  data,
  loading = false,
  emptyText = '暂无数据',
  emptyDescription,
  rowKey = 'id',
  onRowClick,
  className = '',
}: TableProps<T>) {
  const getRowKey = (record: T, index: number): string => {
    if (typeof rowKey === 'function') {
      return rowKey(record);
    }
    return record[rowKey] ?? `row-${index}`;
  };

  const getCellContent = (
    column: TableColumn<T>,
    record: T,
    index: number
  ): ReactNode => {
    if (column.render) {
      return column.render(record, index);
    }
    return record[column.key];
  };

  if (loading) {
    return (
      <div className={clsx(styles['table-loading'], className)}>
        <Loading size="md" text="加载中..." />
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className={clsx(styles['table-empty'], className)}>
        <Empty title={emptyText} description={emptyDescription} />
      </div>
    );
  }

  return (
    <div className={clsx(styles['table-container'], className)}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className={styles['table-th']}
                style={col.width ? { width: col.width } : undefined}
              >
                {col.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((record, index) => (
            <tr
              key={getRowKey(record, index)}
              className={onRowClick ? styles['table-row-clickable'] : undefined}
              onClick={() => onRowClick?.(record, index)}
            >
              {columns.map((col) => (
                <td key={col.key} className={styles['table-td']}>
                  {getCellContent(col, record, index)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export { Table };
export default Table;
