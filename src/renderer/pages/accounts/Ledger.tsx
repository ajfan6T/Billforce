import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { BookOpenText } from 'lucide-react';
import { Card, EmptyState, Page, PageHeader, Toolbar } from '../../components/ui';
import { SegmentedControl } from '../../components/forms';
import { AccountSelect, CustomerPicker, EmployeeSelect, SupplierPicker, type CustomerOption, type SupplierOption } from '../../components/pickers';
import { DateRangePicker, ExportButtons, ReportView } from '../../components/report';
import { useQuery } from '../../hooks';
import { useOpenLink } from '../../links';
import { formatDrCr } from '../../../shared/money';
import type { PartyType } from '../../../shared/constants';
import { useRange } from './common';

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
  const q = useQuery('books.ledger', selected ? { from: range.from, to: range.to, accountId: accountId ?? null, partyType: party?.type ?? null, partyId: party?.id ?? null } : null);
  const accounts = useQuery('accounts.list', {});
  const quick = useMemo(() => (accounts.data ?? []).filter((a) => a.systemKey && QUICK_KEYS.includes(a.systemKey)), [accounts.data]);

  const go = (next: { account?: number | null; party?: { type: PartyType; id: number } | null; kind?: Kind }) => {
    const p = new URLSearchParams();
    if (next.account) p.set('account', String(next.account));
    if (next.party) p.set('party', `${next.party.type}:${next.party.id}`);
    if (next.kind && !next.account && !next.party) p.set('kind', next.kind);
    setParams(p);
  };

  const d = q.data;
  const pickedParty = d?.party && party ? d.party : null;

  return (
    <Page>
      <PageHeader
        title={d ? `Ledger: ${d.title}` : 'Ledgers'}
        subtitle={
          d?.account ? (
            <>
              {d.account.code ? `${d.account.code} · ` : ''}
              {d.account.groupName} · Closing balance <b>{formatDrCr(d.closing)}</b>
            </>
          ) : d?.party ? (
            <>
              {d.party.phone ? `${d.party.phone} · ` : ''}Closing balance <b>{formatDrCr(d.closing)}</b> ·{' '}
              <Link to={`/${d.party.type === 'customer' ? 'customers' : d.party.type === 'supplier' ? 'suppliers' : 'employees'}/${d.party.id}`}>Open {d.party.type}</Link>
            </>
          ) : (
            'The full history of any account, customer, supplier or employee'
          )
        }
        actions={<ExportButtons report={d?.report} />}
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
                  value={pickedParty ? ({ id: pickedParty.id, name: pickedParty.name, phone: pickedParty.phone, balance: d!.closing, creditLimit: null } as unknown as CustomerOption) : null}
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
          <ReportView report={d?.report} loading={q.loading} error={q.error} onRetry={q.reload} onLink={openLink} hideTitle maxHeight="calc(100vh - 300px)" />
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
