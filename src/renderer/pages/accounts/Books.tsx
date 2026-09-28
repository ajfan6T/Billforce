import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Card, Page, PageHeader, Toolbar } from '../../components/ui';
import { Select } from '../../components/forms';
import { DateRangePicker, ExportButtons, ReportView } from '../../components/report';
import { useQuery } from '../../hooks';
import { useOpenLink } from '../../links';
import { call } from '../../api';
import { formatINR } from '../../../shared/money';
import { describeRange } from '../../../shared/dates';
import type { VoucherType } from '../../../shared/constants';
import { PageBar, usePage, useRange, VOUCHER_OPTIONS } from './common';

const BOOK_HEIGHT = 'calc(100vh - 330px)';

/** Cash book and Bank & UPI book: all accounts of the group, or one. */
function GroupBook({ kind }: { kind: 'cash' | 'bank' }) {
  const openLink = useOpenLink();
  const [params, setParams] = useSearchParams();
  const accountId = params.get('account') ? Number(params.get('account')) : null;
  const [range, setRange] = useRange(`${kind}Book.range`, 'this_month');
  const [page, setPage] = usePage(`${range.from}|${range.to}|${accountId}`);
  const route = kind === 'cash' ? 'books.cashBook' : 'books.bankBook';
  const input = { from: range.from, to: range.to, accountId, page };
  const book = useQuery(route, input);
  const accounts = useQuery('accounts.list', { groups: [kind], withBalances: true, asOf: range.to, includeInactive: true });
  const list = (accounts.data ?? []).filter((a) => a.isActive || a.balance);
  const total = list.reduce((s, a) => s + (a.balance ?? 0), 0);
  // While another period / page loads, show nothing rather than the old figures under the new heading.
  const d = book.data && !book.loading && book.data.from === range.from && book.data.to === range.to && book.data.accountId === accountId ? book.data : undefined;
  const pick = (id: number | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('account', String(id));
    else next.delete('account');
    setParams(next, { replace: true });
  };
  const title = kind === 'cash' ? 'Cash book' : 'Bank & UPI book';
  const loadAll = d && d.pageCount > 1 ? async () => (await call(route, { ...input, page: null, all: true })).report : undefined;

  return (
    <Page>
      <PageHeader
        title={title}
        subtitle={kind === 'cash' ? 'Every rupee that came into or went out of your cash, day by day' : 'Money in and out of your bank and UPI accounts'}
        actions={<ExportButtons report={d?.report} load={loadAll} />}
      />
      {list.length > 1 && (
        <div className="ac-book-accounts">
          <button type="button" className={`ac-book-account${accountId ? '' : ' active'}`} onClick={() => pick(null)}>
            <div className="n">{kind === 'cash' ? 'All cash accounts' : 'All bank & UPI accounts'}</div>
            <div className="v">{formatINR(total)}</div>
          </button>
          {list.map((a) => (
            <button type="button" key={a.id} className={`ac-book-account${accountId === a.id ? ' active' : ''}`} onClick={() => pick(a.id)}>
              <div className="n">{a.name}</div>
              <div className="v">{formatINR(a.balance ?? 0)}</div>
            </button>
          ))}
        </div>
      )}
      <Card padded={false} className="ac-report-card ac-book">
        <div className="ac-filters">
          <Toolbar>
            <DateRangePicker value={range} onChange={setRange} />
            {list.length > 1 && (
              <Select<number>
                value={accountId ?? 0}
                onChange={(id) => pick(id || null)}
                aria-label="Account"
                options={[{ value: 0, label: kind === 'cash' ? 'All cash accounts' : 'All bank & UPI accounts' }, ...list.map((a) => ({ value: a.id, label: a.name }))]}
              />
            )}
            <span className="spacer" />
            <span className="small muted">{d ? `${d.entryCount.toLocaleString('en-IN')} ${d.entryCount === 1 ? 'entry' : 'entries'} · ${describeRange(d)}` : book.loading ? 'Loading…' : ''}</span>
          </Toolbar>
        </div>
        <PageBar info={d} total={d?.entryCount ?? 0} what="entries" onPage={setPage} />
        <ReportView report={d?.report} loading={book.loading} error={book.error} onRetry={book.reload} onLink={openLink} hideTitle maxHeight={BOOK_HEIGHT} />
        <PageBar info={d} total={d?.entryCount ?? 0} what="entries" onPage={setPage} bottom />
      </Card>
    </Page>
  );
}

export function CashBookPage() {
  return <GroupBook kind="cash" />;
}

export function BankBookPage() {
  return <GroupBook kind="bank" />;
}

export function DayBookPage() {
  const openLink = useOpenLink();
  const [range, setRange] = useRange('dayBook.range', 'today');
  const [type, setType] = useState<VoucherType | ''>('');
  const [page, setPage] = usePage(`${range.from}|${range.to}|${type}`);
  const input = { from: range.from, to: range.to, voucherType: type || null, page };
  const book = useQuery('books.dayBook', input);
  const d = book.data && !book.loading && book.data.from === range.from && book.data.to === range.to && book.data.voucherType === (type || null) ? book.data : undefined;
  const loadAll = d && d.pageCount > 1 ? async () => (await call('books.dayBook', { ...input, page: null, all: true })).report : undefined;
  return (
    <Page>
      <PageHeader
        title="Day book"
        subtitle="Every voucher entered in the period, with the accounts it touched"
        actions={<ExportButtons report={d?.report} load={loadAll} />}
      />
      <Card padded={false} className="ac-report-card ac-book">
        <div className="ac-filters">
          <Toolbar>
            <DateRangePicker value={range} onChange={setRange} />
            <Select<VoucherType | ''> value={type} onChange={setType} aria-label="Voucher type" options={[{ value: '', label: 'All vouchers' }, ...VOUCHER_OPTIONS]} />
            <span className="spacer" />
            <span className="small muted">{d ? `${d.voucherCount.toLocaleString('en-IN')} ${d.voucherCount === 1 ? 'voucher' : 'vouchers'} · ${describeRange(d)}` : book.loading ? 'Loading…' : ''}</span>
          </Toolbar>
        </div>
        <PageBar info={d} total={d?.voucherCount ?? 0} what="vouchers" onPage={setPage} figuresNote={false} />
        <ReportView
          report={d?.report}
          loading={book.loading}
          error={book.error}
          onRetry={book.reload}
          onLink={openLink}
          hideTitle
          maxHeight={BOOK_HEIGHT}
          emptyMessage="No vouchers were entered in this period."
        />
        <PageBar info={d} total={d?.voucherCount ?? 0} what="vouchers" onPage={setPage} figuresNote={false} bottom />
      </Card>
    </Page>
  );
}
