import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { BookOpenText } from 'lucide-react';
import { Card, EmptyState, Page, PageHeader, Toolbar } from '../../components/ui';
import { SegmentedControl } from '../../components/forms';
import { AccountSelect, CustomerPicker, EmployeeSelect, SupplierPicker, type CustomerOption, type SupplierOption } from '../../components/pickers';
import { DateRangePicker, ExportButtons, ReportView } from '../../components/report';
import { useQuery } from '../../hooks';
import { keepPeriod, useOpenLink } from '../../links';
import { call } from '../../api';
import { formatDrCr } from '../../../shared/money';
import type { PartyType } from '../../../shared/constants';
import { PageBar, usePage, useRange } from './common';

type Kind = 'account' | PartyType;

const QUICK_KEYS = ['CASH', 'BANK', 'UPI', 'SALES', 'PURCHASES', 'CAPITAL', 'DRAWINGS', 'AR', 'AP'];

/** Ledger of any account (?account=12) or party (?party=customer:5). */
export function LedgerPage() {
  const openLink = useOpenLink();
  const [params, setParams] = useSearchParams();
  const [range, setRange] = useRange('ledger.range', 'this_fy');
  const accountId = params.get('account') ? Number(params.get('account')) : null;
  const partyParam = params.get('party');
  const [pType, pId] = partyParam ? (partyParam.split(':') as [PartyType, string]) : [null, null];
  const party = pType && ['customer', 'supplier', 'employee'].includes(pType) && Number(pId) > 0 ? { type: pType, id: Number(pId) } : null;
  const kind: Kind = (params.get('kind') as Kind | null) ?? (party ? party.type : 'account');
  const selected = accountId || party;
  const [page, setPage] = usePage(`${range.from}|${range.to}|${accountId}|${partyParam}`);
  const input = { from: range.from, to: range.to, accountId: accountId ?? null, partyType: party?.type ?? null, partyId: party?.id ?? null, page };
  const q = useQuery('books.ledger', selected ? input : null);
  const accounts = useQuery('accounts.list', {});
  const quick = useMemo(() => (accounts.data ?? []).filter((a) => a.systemKey && QUICK_KEYS.includes(a.systemKey)), [accounts.data]);

  const go = (next: { account?: number | null; party?: { type: PartyType; id: number } | null; kind?: Kind }) => {
    // Keep a drill-down's period (?from=&to=) when switching to another account or party.
    const p = keepPeriod(params, new URLSearchParams());
    if (next.account) p.set('account', String(next.account));
    if (next.party) p.set('party', `${next.party.type}:${next.party.id}`);
    if (next.kind && !next.account && !next.party) p.set('kind', next.kind);
    setParams(p);
  };

  // The account / party shown (kept while another period loads) ...
  const meta = q.data && (q.data.account?.id ?? null) === (accountId ?? null) && (q.data.party?.id ?? null) === (party?.id ?? null) ? q.data : undefined;
  // ... and its figures: while another ledger, period or page loads, show none rather than the old figures under the new heading.
  const d = meta && !q.loading && meta.from === range.from && meta.to === range.to ? meta : undefined;
  const loadAll = d && d.pageCount > 1 ? async () => (await call('books.ledger', { ...input, page: null, all: true })).report : undefined;
  const pickedParty = meta?.party && party ? meta.party : null;
  const closing = d ? <b>{formatDrCr(d.closing)}</b> : <span className="faint">…</span>;

  return (
    <Page>
      <PageHeader
        title={meta ? `Ledger: ${meta.title}` : 'Ledgers'}
        subtitle={
          meta?.account ? (
            <>
              {meta.account.code ? `${meta.account.code} · ` : ''}
              {meta.account.groupName} · Closing balance {closing}
            </>
          ) : meta?.party ? (
            <>
              {meta.party.phone ? `${meta.party.phone} · ` : ''}Closing balance {closing} ·{' '}
              <Link to={`/${meta.party.type === 'customer' ? 'customers' : meta.party.type === 'supplier' ? 'suppliers' : 'employees'}/${meta.party.id}`}>Open {meta.party.type}</Link>
            </>
          ) : (
            'The full history of any account, customer, supplier or employee'
          )
        }
        actions={<ExportButtons report={d?.report} load={loadAll} />}
      />
      <Card padded={false} className="ac-report-card ac-book">
        <div className="ac-filters">
          <div className="ac-ledger-pick">
            <SegmentedControl<Kind>
              size="sm"
              value={kind}
              onChange={(k) => go({ kind: k })}
              options={[
                { value: 'account', label: 'Account' },
                { value: 'customer', label: 'Customer' },
                { value: 'supplier', label: 'Supplier' },
                { value: 'employee', label: 'Employee' },
              ]}
            />
            <div className="ac-pick-box">
              {kind === 'account' ? (
                <AccountSelect value={accountId} onChange={(id) => go({ account: id })} placeholder="Choose an account…" />
              ) : kind === 'customer' ? (
                <CustomerPicker
                  value={pickedParty ? ({ id: pickedParty.id, name: pickedParty.name, phone: pickedParty.phone, balance: meta!.closing, creditLimit: null } as unknown as CustomerOption) : null}
                  onChange={(c) => go(c ? { party: { type: 'customer', id: c.id } } : { kind: 'customer' })}
                  allowCreate={false}
                  showBalance={false}
                />
              ) : kind === 'supplier' ? (
                <SupplierPicker
                  value={pickedParty ? ({ id: pickedParty.id, name: pickedParty.name, phone: pickedParty.phone, payable: 0 } as unknown as SupplierOption) : null}
                  onChange={(s) => go(s ? { party: { type: 'supplier', id: s.id } } : { kind: 'supplier' })}
                  allowCreate={false}
                />
              ) : (
                <EmployeeSelect value={party?.type === 'employee' ? party.id : null} includeInactive onChange={(id) => go(id ? { party: { type: 'employee', id } } : { kind: 'employee' })} />
              )}
            </div>
          </div>
          <Toolbar>
            <DateRangePicker value={range} onChange={setRange} />
          </Toolbar>
        </div>
        {selected ? (
          <>
            <PageBar info={d} total={d?.entryCount ?? 0} what="entries" onPage={setPage} />
            <ReportView report={d?.report} loading={q.loading} error={q.error} onRetry={q.reload} onLink={openLink} hideTitle maxHeight="calc(100vh - 300px)" />
            <PageBar info={d} total={d?.entryCount ?? 0} what="entries" onPage={setPage} bottom />
          </>
        ) : (
          <EmptyState
            icon={<BookOpenText size={34} />}
            title="Choose an account, customer, supplier or employee"
            message="You will see the opening balance, every entry with a running balance, and the closing balance."
            action={
              quick.length > 0 && (
                <div className="ac-quick-accounts">
                  {quick.map((a) => (
                    <button key={a.id} type="button" className="pill" onClick={() => go({ account: a.id })}>
                      {a.name}
                    </button>
                  ))}
                </div>
              )
            }
          />
        )}
      </Card>
    </Page>
  );
}
