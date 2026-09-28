import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { formatDrCr, formatINR, formatQty, formatIndianNumber } from '../../shared/money';
import { formatDate, formatDateTime } from '../../shared/dates';
import { Loading } from './ui';

export type ColumnType = 'text' | 'money' | 'drcr' | 'number' | 'qty' | 'date' | 'datetime' | 'percent';

export interface Column<T> {
  key: string;
  label: ReactNode;
  /** Value used for sorting and default rendering. Defaults to row[key]. */
  value?: (row: T) => string | number | null | undefined;
  render?: (row: T) => ReactNode;
  type?: ColumnType;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  sortable?: boolean;
  className?: string;
}

export interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[] | undefined;
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  empty?: ReactNode;
  /** Footer cells keyed by column key (e.g. totals). */
  footer?: Record<string, ReactNode>;
  rowClassName?: (row: T) => string;
  /** Default sort. */
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  compact?: boolean;
  stickyHeader?: boolean;
  maxHeight?: number | string;
}

export function formatCell(type: ColumnType | undefined, v: unknown): ReactNode {
  if (v === null || v === undefined || v === '') return '';
  switch (type) {
    case 'money':
      return <span className={`money${(v as number) < 0 ? ' neg' : ''}`}>{formatINR(v as number)}</span>;
    case 'drcr':
      return <span className="money">{formatDrCr(v as number)}</span>;
    case 'number':
      return formatIndianNumber(v as number, Number.isInteger(v) ? 0 : 2);
    case 'qty':
      return formatQty(v as number);
    case 'percent':
      return `${(v as number).toFixed(1)}%`;
    case 'date':
      return formatDate(v as string);
    case 'datetime':
      return formatDateTime(v as string);
    default:
      return String(v);
  }
}

const NUMERIC: ColumnType[] = ['money', 'drcr', 'number', 'qty', 'percent'];

/** Sortable table with typed columns, footer totals and row click. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  loading,
  empty = 'Nothing to show',
  footer,
  rowClassName,
  initialSort,
  compact,
  stickyHeader = true,
  maxHeight,
}: DataTableProps<T>) {
  const [sort, setSort] = useState(initialSort ?? null);
  const sorted = useMemo(() => {
    if (!rows || !sort) return rows ?? [];
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const get = col.value ?? ((r: T) => (r as any)[col.key]);
    const out = [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return va - vb;
      return String(va).localeCompare(String(vb), 'en-IN', { numeric: true, sensitivity: 'base' });
    });
    return sort.dir === 'desc' ? out.reverse() : out;
  }, [rows, sort, columns]);

  const alignOf = (c: Column<T>) => c.align ?? (c.type && NUMERIC.includes(c.type) ? 'right' : 'left');

  return (
    <div className={`table-wrap${stickyHeader ? ' sticky' : ''}`} style={maxHeight ? { maxHeight, overflow: 'auto' } : undefined}>
      <table className={`table${compact ? ' compact' : ''}${onRowClick ? ' clickable' : ''}`}>
        <thead>
          <tr>
            {columns.map((c) => {
              const sortable = c.sortable !== false;
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  style={{ width: c.width, textAlign: alignOf(c) }}
                  className={`${sortable ? 'sortable' : ''} ${c.className ?? ''}`}
                  onClick={() => sortable && setSort(active && sort?.dir === 'asc' ? { key: c.key, dir: 'desc' } : active && sort?.dir === 'desc' ? null : { key: c.key, dir: 'asc' })}
                >
                  {c.label}
                  {active && (sort?.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading && !rows?.length ? (
            <tr>
              <td colSpan={columns.length}>
                <Loading />
              </td>
            </tr>
          ) : !sorted.length ? (
            <tr>
              <td colSpan={columns.length} className="table-empty">
                {empty}
              </td>
            </tr>
          ) : (
            sorted.map((row) => (
              <tr key={rowKey(row)} className={rowClassName?.(row) ?? ''} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                {columns.map((c) => (
                  <td key={c.key} style={{ textAlign: alignOf(c) }} className={c.className}>
                    {c.render ? c.render(row) : formatCell(c.type, c.value ? c.value(row) : (row as any)[c.key])}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
        {footer && sorted.length > 0 && (
          <tfoot>
            <tr>
              {columns.map((c) => (
                <td key={c.key} style={{ textAlign: alignOf(c) }}>
                  {footer[c.key] ?? ''}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
