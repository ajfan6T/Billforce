import { useEffect, useMemo, useState } from 'react';
import { PackageOpen, Save } from 'lucide-react';
import { Alert, Button, Card, EmptyState, ErrorBox, Loading, Page, PageHeader } from '../../components/ui';
import { MoneyInput, NumberInput, SearchInput } from '../../components/forms';
import { useMutation, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { useToast, useUnsavedWarning } from '../../feedback';
import { formatINR, lineAmount } from '../../../shared/money';
import { formatDate } from '../../../shared/dates';
import './stock.css';

interface Row {
  itemId: number;
  name: string;
  unit: string;
  qty: number | null;
  unitCost: number | null;
}

/** Opening stock: what was in the shop on the books start date, at cost (an opening balance of the books). */
export function OpeningStockPage() {
  const q = useQuery('stock.opening', undefined);
  const m = useMutation('stock.saveOpening');
  const toast = useToast();
  const { can } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    if (q.data) setRows(q.data.lines.map((l) => ({ itemId: l.itemId, name: l.name, unit: l.unit, qty: l.qty || null, unitCost: l.unitCost || null })));
  }, [q.data]);
  const saved = useMemo(() => new Map((q.data?.lines ?? []).map((l) => [l.itemId, l])), [q.data]);
  const changed = rows.filter((r) => (r.qty ?? 0) !== (saved.get(r.itemId)?.qty ?? 0) || (r.unitCost ?? 0) !== (saved.get(r.itemId)?.unitCost ?? 0));
  useUnsavedWarning(changed.length > 0);
  if (q.error) return <Page><ErrorBox error={q.error} onRetry={q.reload} /></Page>;
  if (!q.data) return <Loading />;
  const locked = q.data.lockedReason;
  const showCost = !q.data.costHidden;
  const canEdit = !locked && can('stock.manage') && can('accounts.manage');
  const total = rows.reduce((s, r) => s + (r.qty && r.unitCost ? lineAmount(r.qty, r.unitCost) : 0), 0);
  const missingCost = rows.filter((r) => r.qty && !r.unitCost);
  const shown = rows.filter((r) => !filter.trim() || r.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const set = (id: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.itemId === id ? { ...r, ...patch } : r)));
  const save = async () => {
    try {
      await m.run({ lines: rows.map((r) => ({ itemId: r.itemId, qty: r.qty ?? 0, unitCost: r.unitCost ?? 0 })) });
      toast.success('Opening stock saved');
      void q.reload();
    } catch {
      /* shown below */
    }
  };
  return (
    <Page>
      <PageHeader
        title="Opening stock"
        subtitle={`What was in the shop on ${formatDate(q.data.date)}, when your books start, at cost price`}
        back="/stock"
        actions={
          canEdit && (
            <Button variant="primary" icon={<Save size={16} />} loading={m.loading} disabled={!changed.length || missingCost.length > 0} onClick={() => void save()}>
              Save opening stock
            </Button>
          )
        }
      />
      <div className="stack">
        {locked ? (
          <Alert tone="neutral">{locked}</Alert>
        ) : (
          <Alert tone="blue">
            Opening stock is an opening balance of your books, like opening cash. Started tracking stock later? Use a <b>stock count</b> on the day you counted
            instead.
          </Alert>
        )}
        {missingCost.length > 0 && <Alert tone="amber">Enter the cost price of {missingCost.map((r) => r.name).slice(0, 3).join(', ')}{missingCost.length > 3 ? ` and ${missingCost.length - 3} more` : ''}.</Alert>}
        {m.error && <Alert tone="red">{m.error}</Alert>}
        <Card padded={false} title={showCost ? <span>Items · total <b className="money">{formatINR(total)}</b></span> : 'Items'} actions={<SearchInput value={filter} onChange={setFilter} placeholder="Find item…" />}>
          {!rows.length ? (
            <EmptyState icon={<PackageOpen size={30} />} title="No items are tracked" message='Turn on "Track stock" for your items in Sales > Items & rates.' />
          ) : (
            <div className="table-wrap">
              <table className="table compact st-opening-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Quantity</th>
                    {showCost && <th className="num">Cost per unit</th>}
                    {showCost && <th className="num">Value</th>}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.itemId}>
                      <td>
                        <span className="sl-cell-main">{r.name}</span> <span className="faint small">{r.unit}</span>
                      </td>
                      <td className="num">
                        <NumberInput value={r.qty} onChange={(v) => set(r.itemId, { qty: v })} disabled={!canEdit} aria-label={`Opening quantity of ${r.name}`} />
                      </td>
                      {showCost && (
                        <td className="num">
                          <MoneyInput value={r.unitCost} onChange={(v) => set(r.itemId, { unitCost: v })} disabled={!canEdit} aria-label={`Cost per unit of ${r.name}`} />
                        </td>
                      )}
                      {showCost && <td className="num money">{r.qty && r.unitCost ? formatINR(lineAmount(r.qty, r.unitCost)) : ''}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}
