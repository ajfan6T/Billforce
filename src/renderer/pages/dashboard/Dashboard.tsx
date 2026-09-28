import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, HandCoins, Landmark, PiggyBank, Plus, Receipt, ShoppingCart, Truck, Wallet, WalletCards } from 'lucide-react';
import { Alert, Badge, Button, Card, EmptyState, ErrorBox, LinkButton, Loading, Page, Stat, type Tone } from '../../components/ui';
import { DataTable, type Column } from '../../components/table';
import { BarList, ColumnChart, MODE_COLORS, ShareBar } from '../../components/charts';
import { useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { formatINR, formatQty } from '../../../shared/money';
import { formatDate, formatTime, weekdayShort } from '../../../shared/dates';
import type { ApiOutput } from '../../api';
import './dashboard.css';

type Summary = ApiOutput<'dashboard.summary'>;
type Bill = NonNullable<Summary['recentBills']>['bills'][number];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MODE_LABEL: Record<string, string> = { cash: 'Cash', upi: 'UPI', bank: 'Bank', credit: 'Credit', split: 'Split' };
const MODE_TONE: Record<string, Tone> = { cash: 'green', upi: 'purple', bank: 'blue', credit: 'amber', split: 'neutral' };

/** "Monday, 28 September 2026" */
function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${WEEKDAYS[new Date(y, m - 1, d).getDay()]}, ${d} ${MONTHS[m - 1]} ${y}`;
}

/** "28 Sep" */
function shortDay(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1].slice(0, 3)}`;
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function QuickActions() {
  const { can } = useAuth();
  return (
    <div className="db-actions">
      {can('billing.create') && (
        <LinkButton to="/billing/new" variant="primary" icon={<ShoppingCart size={16} />}>
          New bill
        </LinkButton>
      )}
      {can('customers.receive') && (
        <LinkButton to="/customers/receipts" icon={<HandCoins size={16} />}>
          Receive payment
        </LinkButton>
      )}
      {can('expenses.manage') && (
        <LinkButton to="/accounts/expenses" icon={<Plus size={16} />}>
          Add expense
        </LinkButton>
      )}
      {can('purchases.manage') && (
        <LinkButton to="/purchases/new" icon={<Truck size={16} />}>
          New purchase
        </LinkButton>
      )}
    </div>
  );
}

function MonthDelta({ month }: { month: NonNullable<Summary['month']> }) {
  if (month.changePct === null) return <span className="muted">No sales in the same days of last month</span>;
  const up = month.changePct >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`db-delta ${up ? 'up' : 'down'}`}>
      <Icon size={14} aria-hidden />
      {up ? '+' : ''}
      {month.changePct.toFixed(1)}% vs the same days last month ({formatINR(month.lastMonthToDate)})
    </span>
  );
}

function TrendCard({ d, loading }: { d: Summary; loading: boolean }) {
  if (!d.trend || !d.month) return null;
  return (
    <Card
      className="db-card"
      title="Sales in the last 30 days"
      actions={
        <Link to="/reports/sales?tab=day" className="small">
          Sales insights
        </Link>
      }
    >
      <div className="db-month">
        <div>
          <div className="db-month-label">This month</div>
          <div className="db-month-value">{formatINR(d.month.thisMonth)}</div>
        </div>
        <div className="db-month-meta">
          <MonthDelta month={d.month} />
          <span className="muted">Last month in full: {formatINR(d.month.lastMonth)}</span>
        </div>
      </div>
      <ColumnChart
        labels={d.trend.dates.map(shortDay)}
        values={d.trend.values}
        seriesName="Net sales"
        tooltipTitles={d.trend.dates.map((x) => `${weekdayShort(x)}, ${formatDate(x)}`)}
        height={170}
        emptyMessage="No sales in the last 30 days"
        loading={loading}
      />
    </Card>
  );
}

function ModesCard({ today }: { today: NonNullable<Summary['todaySales']> }) {
  return (
    <Card className="db-card" title="Today by payment mode">
      <ShareBar
        legendColumns={1}
        emptyMessage="No bills yet today"
        items={(['cash', 'upi', 'bank', 'credit'] as const).map((m) => ({
          key: m,
          label: m === 'credit' ? 'Credit (on account)' : MODE_LABEL[m],
          value: today.byMode[m],
          color: MODE_COLORS[m],
        }))}
      />
      {today.returns > 0 && <div className="small muted db-note">Returns today: {formatINR(today.returns)} (not included above)</div>}
    </Card>
  );
}

function TopItemsCard({ items }: { items: NonNullable<Summary['topItems']> }) {
  return (
    <Card
      className="db-card"
      title="Top items this month"
      actions={
        <Link to="/reports/sales?tab=item" className="small">
          All items
        </Link>
      }
    >
      <BarList
        emptyMessage="No items sold this month yet"
        items={items.map((i, k) => ({ key: k, label: i.name, value: i.amount, sub: `${formatQty(i.qty)} ${i.unit ?? ''}`.trim() }))}
      />
    </Card>
  );
}

function BillsCard({ recent, today }: { recent: NonNullable<Summary['recentBills']>; today: string }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const columns: Array<Column<Bill>> = [
    { key: 'billNo', label: 'Bill', render: (b) => <span className="db-billno">{b.billNo}</span> },
    { key: 'when', label: 'When', value: (b) => b.createdAt, render: (b) => (b.date === today ? formatTime(b.createdAt) : formatDate(b.date)) },
    { key: 'customerName', label: 'Customer', render: (b) => b.customerName ?? <span className="muted">Walk-in</span> },
    {
      key: 'paymentMode',
      label: 'Paid by',
      render: (b) =>
        b.status === 'cancelled' ? <Badge tone="red">Cancelled</Badge> : <Badge tone={MODE_TONE[b.paymentMode] ?? 'neutral'}>{MODE_LABEL[b.paymentMode] ?? b.paymentMode}</Badge>,
    },
    { key: 'total', label: 'Amount', type: 'money' },
  ];
  return (
    <Card
      className="db-card"
      padded={false}
      title={recent.todayOnly ? "Today's bills" : 'Recent bills'}
      actions={
        <Link to="/sales/bills" className="small">
          All bills
        </Link>
      }
    >
      {recent.bills.length ? (
        <DataTable<Bill>
          columns={columns}
          rows={recent.bills}
          rowKey={(b) => b.id}
          onRowClick={(b) => navigate(`/sales/bills/${b.id}`)}
          rowClassName={(b) => (b.status === 'cancelled' ? 'cancelled' : '')}
          compact
          stickyHeader={false}
        />
      ) : (
        <EmptyState
          icon={<Receipt size={30} />}
          title={recent.todayOnly ? 'No bills yet today' : 'No bills yet'}
          message="Bills you make will show up here."
          action={
            can('billing.create') ? (
              <LinkButton to="/billing/new" variant="primary" icon={<ShoppingCart size={16} />}>
                Make a bill
              </LinkButton>
            ) : undefined
          }
        />
      )}
    </Card>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const { can, canAny } = useAuth();
  const q = useQuery('dashboard.summary', undefined);
  const reload = q.reload;
  // Figures change all day: refresh when the user comes back to the window.
  useEffect(() => {
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  if (q.error && !q.data) {
    return (
      <Page>
        <ErrorBox error={q.error} onRetry={q.reload} />
      </Page>
    );
  }
  const d = q.data;
  if (!d) return <Loading label="Loading your dashboard…" />;
  const firstName = d.user.name.split(' ')[0] || d.user.name;
  const t = d.todaySales;
  const statCount = (t ? 1 : 0) + (d.balances ? 2 : 0) + (d.dues ? 2 : 0) + (d.profit ? 1 : 0);
  const modes = t ? <ModesCard today={t} /> : null;
  const items = d.topItems ? <TopItemsCard items={d.topItems} /> : null;
  const bills = d.recentBills ? <BillsCard recent={d.recentBills} today={d.today} /> : null;
  const nothing = !statCount && !bills && !items;

  return (
    <Page wide>
      <div className="db-head">
        <div>
          <h1 className="db-greeting">
            {greeting()}, {firstName}
          </h1>
          <div className="db-date">
            {longDate(d.today)} · Financial year {d.fyName}
          </div>
        </div>
        <QuickActions />
      </div>

      {d.alerts.map((a) => (
        <div className="db-alert" key={a.kind}>
          <Alert tone={a.tone} icon={<AlertTriangle size={18} />} title={a.title}>
            <div className="db-alert-body">
              <span>{a.message}</span>
              <Button size="sm" variant={a.kind === 'backup' ? 'primary' : 'secondary'} onClick={() => navigate(a.path)}>
                {a.action}
              </Button>
            </div>
          </Alert>
        </div>
      ))}

      {statCount > 0 && (
        <div className={`db-stats${statCount >= 4 ? ` cols-${statCount}` : ''}${q.loading ? ' is-loading' : ''}`}>
          {t && (
            <Stat
              label="Today's sales"
              value={formatINR(t.netSales)}
              tone="blue"
              icon={<Receipt size={16} />}
              hint={`${t.bills} bill${t.bills === 1 ? '' : 's'}${t.returns ? ` · returns ${formatINR(t.returns)}` : ''}`}
              onClick={() => navigate(can('reports.sales') ? '/reports/sales?tab=day' : '/sales/bills')}
            />
          )}
          {d.balances && (
            <>
              <Stat label="Cash in hand" value={formatINR(d.balances.cash)} icon={<Wallet size={16} />} hint="Cash book" onClick={can('accounts.view') ? () => navigate('/accounts/cash-book') : undefined} />
              <Stat label="Bank & UPI" value={formatINR(d.balances.bank)} icon={<Landmark size={16} />} hint="Bank & UPI book" onClick={can('accounts.view') ? () => navigate('/accounts/bank-book') : undefined} />
            </>
          )}
          {d.dues && (
            <>
              <Stat
                label="To collect"
                value={formatINR(d.dues.receivables)}
                icon={<HandCoins size={16} />}
                hint={`from ${d.dues.receivableCustomers} customer${d.dues.receivableCustomers === 1 ? '' : 's'}`}
                onClick={canAny(['reports.financial', 'customers.view']) ? () => navigate('/reports/receivables-ageing') : undefined}
              />
              <Stat
                label="To pay"
                value={formatINR(d.dues.payables)}
                icon={<WalletCards size={16} />}
                hint={`to ${d.dues.payableSuppliers} supplier${d.dues.payableSuppliers === 1 ? '' : 's'}`}
                onClick={canAny(['reports.financial', 'suppliers.view']) ? () => navigate('/reports/payables-ageing') : undefined}
              />
            </>
          )}
          {d.profit && (
            <Stat
              label={d.profit.thisMonth >= 0 ? 'Profit this month' : 'Loss this month'}
              value={formatINR(Math.abs(d.profit.thisMonth))}
              tone={d.profit.thisMonth >= 0 ? 'green' : 'red'}
              icon={<PiggyBank size={16} />}
              hint={
                <>
                  <span className="db-hint-line" title="Net profit this financial year">
                    FY {d.profit.thisFy < 0 ? 'loss ' : ''}
                    {formatINR(Math.abs(d.profit.thisFy))}
                  </span>
                  {d.expensesThisMonth !== null && (
                    <span className="db-hint-line" title="Expenses this month (purchases not included)">
                      Expenses {formatINR(d.expensesThisMonth)}
                    </span>
                  )}
                </>
              }
              onClick={() => navigate('/reports/profit-loss')}
            />
          )}
        </div>
      )}

      {d.trend ? (
        <>
          <div className="db-grid">
            <TrendCard d={d} loading={q.loading} />
            {modes}
          </div>
          {(items || bills) && (
            <div className="db-grid pair">
              {items}
              {bills}
            </div>
          )}
        </>
      ) : (
        (modes || bills) && (
          <div className="db-grid pair">
            {modes}
            {bills}
          </div>
        )
      )}

      {nothing && <EmptyState title="Welcome to Billforce" message="Use the menu on the left to get started. Ask the owner if you need access to more screens." />}
    </Page>
  );
}
