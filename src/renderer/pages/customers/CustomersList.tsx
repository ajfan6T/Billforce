import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { IndianRupee, UserPlus, Users } from 'lucide-react';
import { Button, Card, EmptyState, ErrorBox, Page, PageHeader, Stat, StatGrid, Toolbar } from '../../components/ui';
import { Checkbox, SearchInput } from '../../components/forms';
import { DataTable, type Column } from '../../components/table';
import { ExportButtons } from '../../components/report';
import { useDebounced, useHotkeys, useQuery, useStoredState } from '../../hooks';
import { useAuth } from '../../auth';
import type { ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { formatDate, todayISO } from '../../../shared/dates';
import { BalanceText, countText, InactiveBadge, listReport } from './common';
import { CustomerFormModal } from './CustomerFormModal';
import { ReceiptModal } from './ReceiptModal';

type Row = ApiOutput<'customers.list'>[number];

export function CustomersListPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [onlyWithBalance, setOnlyWithBalance] = useStoredState('customers.onlyWithBalance', false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const dq = useDebounced(q, 200);
  const list = useQuery('customers.list', { q: dq || null, onlyWithBalance, includeInactive });
  const [adding, setAdding] = useState(false);
  const [receiving, setReceiving] = useState(false);

  useHotkeys({
    'alt+n': () => can('customers.manage') && setAdding(true),
    'alt+r': () => can('customers.receive') && setReceiving(true),
  });

  const rows = list.data;
  const totals = useMemo(() => {
    const t = { due: 0, advance: 0, withDue: 0, billed: 0 };
    for (const r of rows ?? []) {
      if (r.balance > 0) {
        t.due += r.balance;
        t.withDue++;
      } else t.advance += -r.balance;
      t.billed += r.billedThisFy;
    }
    return t;
  }, [rows]);

  const columns: Array<Column<Row>> = [
    {
      key: 'name',
      label: 'Customer',
      render: (r) => (
        <div>
          <div className="party-name-cell">
            {r.name}
            {!r.isActive && <InactiveBadge />}
          </div>
          {r.address && <span className="cell-sub">{r.address}</span>}
        </div>
      ),
    },
    { key: 'phone', label: 'Phone', render: (r) => r.phone ?? <span className="faint">—</span> },
    { key: 'balance', label: 'Balance', type: 'money', align: 'right', render: (r) => <BalanceText value={r.balance} /> },
    { key: 'creditLimit', label: 'Credit limit', type: 'money', render: (r) => (r.creditLimit === null ? <span className="faint">—</span> : formatINR(r.creditLimit)) },
    { key: 'lastBillDate', label: 'Last bill', type: 'date' },
    { key: 'billedThisFy', label: 'Billed this year', type: 'money' },
  ];

  const report = useMemo(
    () =>
      rows &&
      listReport(
        'Customers',
        `As on ${formatDate(todayISO())}${q ? ` · matching "${q}"` : ''}`,
        [
          { key: 'name', label: 'Customer', width: 26, get: (r: Row) => r.name + (r.isActive ? '' : ' (inactive)') },
          { key: 'phone', label: 'Phone', width: 14, nowrap: true, get: (r) => r.phone },
          { key: 'address', label: 'Address', width: 30, get: (r) => r.address },
          { key: 'balance', label: 'Balance', type: 'drcr', width: 14, get: (r) => r.balance },
          { key: 'lastBill', label: 'Last bill', type: 'date', width: 11, get: (r) => r.lastBillDate },
          { key: 'billed', label: 'Billed this year', type: 'money', width: 14, get: (r) => r.billedThisFy },
        ],
        rows,
        {
          summary: [
            { label: 'Customers', value: rows.length, type: 'number' },
            { label: 'Total due', value: totals.due, type: 'money' },
            { label: 'Advances held', value: totals.advance, type: 'money' },
          ],
          link: (r) => ({ kind: 'customer', id: r.id }),
        },
      ),
    [rows, q, totals],
  );

  const noneYet = !list.loading && !dq && !onlyWithBalance && !includeInactive && rows?.length === 0;

  return (
    <Page>
      <PageHeader
        title="Customers"
        subtitle={rows ? countText(rows.length, 'customer') : undefined}
        actions={
          <>
            {can('customers.receive') && (
              <Button icon={<IndianRupee size={16} />} kbd="Alt+R" onClick={() => setReceiving(true)}>
                Receive payment
              </Button>
            )}
            {can('customers.manage') && (
              <Button variant="primary" icon={<UserPlus size={16} />} kbd="Alt+N" onClick={() => setAdding(true)}>
                Add customer
              </Button>
            )}
          </>
        }
      />
      <StatGrid>
        <Stat label="Customers owe you" value={formatINR(totals.due)} tone={totals.due ? 'red' : undefined} hint={`${totals.withDue} customer${totals.withDue === 1 ? '' : 's'} with dues`} />
        <Stat label="Advances held" value={formatINR(totals.advance)} tone={totals.advance ? 'green' : undefined} hint="Money received before billing" />
        <Stat label="Billed this year" value={formatINR(totals.billed)} hint="To the customers listed" />
      </StatGrid>
      <Card padded={false} className="list-card">
        <div className="tab-toolbar">
          <Toolbar className="mb-0">
            <SearchInput value={q} onChange={setQ} placeholder="Search name, phone or address…" autoFocus />
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
            icon={<Users size={36} />}
            title="No customers yet"
            message="Add the customers who buy on credit or who you want to track. Walk-in customers do not need a record."
            action={
              can('customers.manage') && (
                <Button variant="primary" icon={<UserPlus size={16} />} onClick={() => setAdding(true)}>
                  Add customer
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
            onRowClick={(r) => navigate(`/customers/${r.id}`)}
            empty={dq ? `No customers match "${dq}"` : onlyWithBalance ? 'No customer has a balance' : 'No customers'}
            rowClassName={(r) => (r.isActive ? '' : 'muted')}
            footer={
              rows && rows.length > 1
                ? {
                    name: countText(rows.length, 'customer'),
                    balance: <span className="money">{formatINR(totals.due - totals.advance)}</span>,
                    billedThisFy: <span className="money">{formatINR(totals.billed)}</span>,
                  }
                : undefined
            }
          />
        )}
      </Card>
      <CustomerFormModal
        open={adding}
        initialName={q}
        onClose={() => setAdding(false)}
        onSaved={(c) => {
          setAdding(false);
          navigate(`/customers/${c.id}`);
        }}
      />
      <ReceiptModal open={receiving} onClose={() => setReceiving(false)} onSaved={() => void list.reload()} />
    </Page>
  );
}
