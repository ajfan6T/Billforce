import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Plus, Truck, Wallet } from 'lucide-react';
import { Button, Card, EmptyState, ErrorBox, Page, PageHeader, Stat, StatGrid, Toolbar } from '../../components/ui';
import { Checkbox, SearchInput } from '../../components/forms';
import { DataTable, type Column } from '../../components/table';
import { ExportButtons } from '../../components/report';
import { useDebounced, useHotkeys, useQuery, useStoredState } from '../../hooks';
import { useAuth } from '../../auth';
import type { ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { formatDate, todayISO } from '../../../shared/dates';
import { InactiveBadge, listReport, PayableText } from '../customers/common';
import { SupplierFormModal } from './SupplierFormModal';
import { SupplierPaymentModal } from './SupplierPaymentModal';

type Row = ApiOutput<'suppliers.list'>[number];

export function SuppliersListPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [onlyWithBalance, setOnlyWithBalance] = useStoredState('suppliers.onlyWithBalance', false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const dq = useDebounced(q, 200);
  const list = useQuery('suppliers.list', { q: dq || null, onlyWithBalance, includeInactive });
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState(false);

  useHotkeys({ 'alt+n': () => can('suppliers.manage') && setAdding(true) });

  const rows = list.data;
  const totals = useMemo(() => {
    const t = { payable: 0, advance: 0, owed: 0, purchased: 0 };
    for (const r of rows ?? []) {
      if (r.payable > 0) {
        t.payable += r.payable;
        t.owed++;
      } else t.advance += -r.payable;
      t.purchased += r.purchasedThisFy;
    }
    return t;
  }, [rows]);

  const columns: Array<Column<Row>> = [
    {
      key: 'name',
      label: 'Supplier',
      render: (r) => (
        <div>
          <div className="party-name-cell">
            {r.name}
            {!r.isActive && <InactiveBadge />}
          </div>
          {r.contactPerson && <span className="cell-sub">{r.contactPerson}</span>}
        </div>
      ),
    },
    { key: 'phone', label: 'Phone', render: (r) => r.phone ?? <span className="faint">—</span> },
    { key: 'payable', label: 'Balance', type: 'money', render: (r) => <PayableText value={r.payable} zero="Settled" /> },
    { key: 'lastPurchaseDate', label: 'Last purchase', type: 'date' },
    { key: 'purchasedThisFy', label: 'Purchased this year', type: 'money' },
  ];

  const report = useMemo(
    () =>
      rows &&
      listReport(
        'Suppliers',
        `As on ${formatDate(todayISO())}`,
        [
          { key: 'name', label: 'Supplier', width: 26, get: (r: Row) => r.name + (r.isActive ? '' : ' (inactive)') },
          { key: 'contact', label: 'Contact person', width: 18, get: (r) => r.contactPerson },
          { key: 'phone', label: 'Phone', width: 14, get: (r) => r.phone },
          { key: 'payable', label: 'Payable', type: 'money', width: 14, get: (r) => r.payable },
          { key: 'last', label: 'Last purchase', type: 'date', width: 12, get: (r) => r.lastPurchaseDate },
          { key: 'fy', label: 'Purchased this year', type: 'money', width: 14, get: (r) => r.purchasedThisFy },
        ],
        rows,
        {
          summary: [
            { label: 'Suppliers', value: rows.length, type: 'number' },
            { label: 'Total payable', value: totals.payable, type: 'money' },
            { label: 'Advances paid', value: totals.advance, type: 'money' },
          ],
          link: (r) => ({ kind: 'supplier', id: r.id }),
        },
      ),
    [rows, totals],
  );

  const noneYet = !list.loading && !dq && !onlyWithBalance && !includeInactive && rows?.length === 0;

  return (
    <Page>
      <PageHeader
        title="Suppliers"
        subtitle={rows ? `${rows.length} supplier${rows.length === 1 ? '' : 's'}` : undefined}
        actions={
          <>
            {can('suppliers.pay') && (
              <Button icon={<Wallet size={16} />} onClick={() => setPaying(true)}>
                Pay supplier
              </Button>
            )}
            {can('suppliers.manage') && (
              <Button variant="primary" icon={<Plus size={16} />} kbd="Alt+N" onClick={() => setAdding(true)}>
                Add supplier
              </Button>
            )}
          </>
        }
      />
      <StatGrid>
        <Stat label="You owe suppliers" value={formatINR(totals.payable)} tone={totals.payable ? 'red' : undefined} hint={`${totals.owed} supplier${totals.owed === 1 ? '' : 's'}`} />
        <Stat label="Advances paid" value={formatINR(totals.advance)} tone={totals.advance ? 'green' : undefined} />
        <Stat label="Purchased this year" value={formatINR(totals.purchased)} hint="From the suppliers listed" />
      </StatGrid>
      <Card padded={false} className="list-card">
        <div className="tab-toolbar">
          <Toolbar>
            <SearchInput value={q} onChange={setQ} placeholder="Search name, phone or contact…" autoFocus />
            <Checkbox checked={onlyWithBalance} onChange={setOnlyWithBalance} label="Has balance" />
            <Checkbox checked={includeInactive} onChange={setIncludeInactive} label="Show inactive" />
          </Toolbar>
          <ExportButtons report={report} />
        </div>
        {list.error ? (
          <div className="card-body">
            <ErrorBox error={list.error} onRetry={list.reload} />
          </div>
        ) : noneYet ? (
          <EmptyState
            icon={<Truck size={36} />}
            title="No suppliers yet"
            message="Add the wholesalers and vendors you buy from, so you can track purchases on credit and payments."
            action={
              can('suppliers.manage') && (
                <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
                  Add supplier
                </Button>
              )
            }
          />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            loading={list.loading}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/suppliers/${r.id}`)}
            rowClassName={(r) => (r.isActive ? '' : 'muted')}
            empty={dq ? `No suppliers match "${dq}"` : 'No supplier has a balance'}
            footer={
              rows && rows.length > 1
                ? {
                    name: `${rows.length} suppliers`,
                    payable: <span className="money">{formatINR(totals.payable - totals.advance)}</span>,
                    purchasedThisFy: <span className="money">{formatINR(totals.purchased)}</span>,
                  }
                : undefined
            }
          />
        )}
      </Card>
      <SupplierFormModal
        open={adding}
        initialName={q}
        onClose={() => setAdding(false)}
        onSaved={(s) => {
          setAdding(false);
          navigate(`/suppliers/${s.id}`);
        }}
      />
      <SupplierPaymentModal open={paying} onClose={() => setPaying(false)} onSaved={() => void list.reload()} />
    </Page>
  );
}
