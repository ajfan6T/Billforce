import { useState } from 'react';
import { CalendarCheck, Check, Lock, ShieldCheck, Unlock } from 'lucide-react';
import { Alert, Badge, Button, Card, ErrorBox, Loading, Page, PageHeader } from '../../components/ui';
import { Checkbox, Field, TextInput } from '../../components/forms';
import { DataTable, type Column } from '../../components/table';
import { Modal } from '../../components/modal';
import { useQuery } from '../../hooks';
import { useDialogs, useToast } from '../../feedback';
import { call, errorMessage, type ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { formatDate, formatDateTime, todayISO } from '../../../shared/dates';
import { PostingTable } from './common';
import './accounts.css';

type Year = ApiOutput<'yearEnd.list'>[number];

export function YearEndPage() {
  const toast = useToast();
  const dialogs = useDialogs();
  const years = useQuery('yearEnd.list', undefined);
  const [closing, setClosing] = useState<Year | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reopen = async (y: Year) => {
    const reason = await dialogs.prompt({
      title: `Re-open financial year ${y.name}?`,
      message: (
        <>
          The closing entry will be cancelled and entries dated {formatDate(y.start)} to {formatDate(y.end)} can be added and changed again. A safety backup is taken
          first. Close the year again when you are done.
        </>
      ),
      label: 'Reason',
      placeholder: 'e.g. a purchase bill of March was missed',
      required: true,
      confirmText: 'Re-open year',
      danger: true,
    });
    if (!reason) return;
    setBusy(y.start);
    try {
      await call('yearEnd.reopen', { fyStart: y.start, reason });
      toast.success(`Financial year ${y.name} is open again`);
      void years.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const columns: Array<Column<Year>> = [
    {
      key: 'name',
      label: 'Financial year',
      sortable: false,
      render: (y) => (
        <div>
          <span className="ac-strong">{y.name}</span>
          <span className="ac-sub">
            {formatDate(y.start)} to {formatDate(y.end)}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      width: 120,
      sortable: false,
      render: (y) =>
        y.isClosed ? (
          <Badge tone="neutral">
            <Lock size={11} /> Closed
          </Badge>
        ) : y.status === 'current' ? (
          <Badge tone="blue">Current year</Badge>
        ) : (
          <Badge tone="amber">Open</Badge>
        ),
    },
    { key: 'income', label: 'Income', type: 'money', width: 130, sortable: false },
    { key: 'expenses', label: 'Expenses', type: 'money', width: 130, sortable: false },
    {
      key: 'netProfit',
      label: 'Net profit / loss',
      width: 150,
      align: 'right',
      sortable: false,
      render: (y) => <span className={`money ac-strong ${y.netProfit < 0 ? 'neg' : y.netProfit > 0 ? 'pos' : ''}`}>{y.netProfit < 0 ? `Loss ${formatINR(-y.netProfit)}` : formatINR(y.netProfit)}</span>,
    },
    { key: 'drawings', label: 'Drawings', type: 'money', width: 120, sortable: false },
    {
      key: 'closedAt',
      label: 'Closed by',
      width: 170,
      sortable: false,
      render: (y) =>
        y.isClosed ? (
          <span className="small">
            {y.closedBy ?? '—'}
            <span className="ac-sub">{formatDateTime(y.closedAt)}</span>
          </span>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: 'action',
      label: '',
      width: 230,
      align: 'right',
      sortable: false,
      render: (y) =>
        y.canClose ? (
          <Button size="sm" variant="primary" icon={<Lock size={14} />} onClick={() => setClosing(y)}>
            Close year…
          </Button>
        ) : y.canReopen ? (
          <Button size="sm" variant="ghost" icon={<Unlock size={14} />} loading={busy === y.start} onClick={() => reopen(y)}>
            Re-open
          </Button>
        ) : !y.isClosed && y.closeBlockedReason ? (
          <span className="small faint">
            {y.end >= todayISO() ? (
              <>
                Can be closed after <span className="nowrap">{formatDate(y.end)}</span>
              </>
            ) : (
              y.closeBlockedReason
            )}
          </span>
        ) : null,
    },
  ];

  return (
    <Page>
      <PageHeader title="Year-end closing" subtitle="After 31 March, close the financial year to lock it and carry the profit to the owner's capital" />
      <div className="stack">
        <Alert tone="blue" icon={<CalendarCheck size={18} />} title="What closing a year does">
          Income and expense accounts start the new year at zero, the year's net profit (or loss) is added to Owner's Capital, and nothing dated in that year can be added, edited
          or cancelled any more. Your customers', suppliers', cash and bank balances carry forward as they are. A safety backup is taken first, and the latest closed year can be
          re-opened if needed.
        </Alert>
        {years.error ? (
          <ErrorBox error={years.error} onRetry={years.reload} />
        ) : (
          <Card padded={false} className="ac-list-card">
            <DataTable columns={columns} rows={years.data} loading={years.loading} rowKey={(y) => y.start} empty="No financial years yet" />
          </Card>
        )}
      </div>
      {closing && (
        <CloseYearModal
          year={closing}
          onClose={() => setClosing(null)}
          onDone={() => {
            setClosing(null);
            void years.reload();
          }}
        />
      )}
    </Page>
  );
}

function CloseYearModal({ year, onClose, onDone }: { year: Year; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [step, setStep] = useState<1 | 2>(1);
  const [transferDrawings, setTransferDrawings] = useState(true);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useQuery('yearEnd.preview', { fyStart: year.start, transferDrawings });
  const p = preview.data;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call('yearEnd.close', { fyStart: year.start, transferDrawings });
      toast.success(`Financial year ${year.name} closed. Safety backup saved to ${r.backup.path}`);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const profit = p?.netProfit ?? year.netProfit;
  return (
    <Modal
      open
      title={`Close financial year ${year.name}`}
      onClose={onClose}
      width={720}
      locked={busy}
      footer={
        step === 1 ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!p} onClick={() => setStep(2)}>
              Next
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setStep(1)}>
              Back
            </Button>
            <Button variant="danger" icon={<Lock size={16} />} loading={busy} disabled={confirmText.trim() !== year.name} onClick={run}>
              Close year {year.name}
            </Button>
          </>
        )
      }
    >
      <div className="ac-steps">
        <div className={`ac-step ${step === 1 ? 'active' : 'done'}`}>
          <span className="ac-step-dot">{step === 2 ? <Check size={13} /> : 1}</span> Check the figures
        </div>
        <div className={`ac-step ${step === 2 ? 'active' : ''}`}>
          <span className="ac-step-dot">2</span> Confirm and close
        </div>
      </div>
      {step === 1 ? (
        !p ? (
          preview.error ? <ErrorBox error={preview.error} onRetry={preview.reload} /> : <Loading />
        ) : (
          <div className="stack">
            <div className="ac-figures">
              <div className="ac-figure">
                <div className="n">Income</div>
                <div className="v">{formatINR(p.year.income)}</div>
              </div>
              <div className="ac-figure">
                <div className="n">Expenses</div>
                <div className="v">{formatINR(p.year.expenses)}</div>
              </div>
              <div className="ac-figure">
                <div className="n">{profit < 0 ? 'Net loss' : 'Net profit'}</div>
                <div className={`v ${profit < 0 ? 'neg' : 'pos'}`}>{formatINR(Math.abs(profit))}</div>
              </div>
            </div>
            <Checkbox
              checked={transferDrawings}
              onChange={setTransferDrawings}
              disabled={!p.drawingsBalance}
              label={p.drawingsBalance ? `Move drawings of ${formatINR(p.drawingsBalance)} into ${p.capitalAccountName}` : 'No drawings to move into capital'}
              hint="Usual practice: the owner's capital shows what is left after the money taken out."
            />
            <div>
              <div className="section-title" style={{ marginTop: 4 }}>
                Closing entry dated {formatDate(p.entryDate)}
              </div>
              {p.lines.length ? (
                <div className="ac-scroll">
                  <PostingTable lines={p.lines.map((l) => ({ accountId: l.accountId, accountName: l.accountName, debit: l.debit, credit: l.credit, memo: l.memo }))} linkAccounts={false} />
                </div>
              ) : (
                <Alert tone="neutral">There is no income, expense or drawings balance in this year. The year will simply be locked.</Alert>
              )}
            </div>
          </div>
        )
      ) : (
        <div className="stack">
          <Alert tone="amber" title="Please read before closing">
            <ul className="ac-checklist">
              <li>
                <ShieldCheck size={14} style={{ verticalAlign: -2 }} /> A safety backup of all your data is taken first.
              </li>
              <li>
                {profit < 0 ? 'The net loss' : 'The net profit'} of <b>{formatINR(Math.abs(profit))}</b> moves to {p?.capitalAccountName ?? "Owner's Capital"}
                {transferDrawings && p?.drawingsBalance ? `, and drawings of ${formatINR(p.drawingsBalance)} are taken out of it` : ''}.
              </li>
              <li>
                Bills, purchases, expenses and vouchers dated <b>{formatDate(year.start)}</b> to <b>{formatDate(year.end)}</b> can no longer be added, edited or cancelled.
              </li>
              <li>Balances of cash, bank, customers, suppliers and loans carry forward to the next year unchanged.</li>
              <li>If you find a mistake later, the owner can re-open this year (only the latest closed year).</li>
            </ul>
          </Alert>
          <Field label={`Type ${year.name} to confirm`}>
            <TextInput
              autoFocus
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={year.name}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && confirmText.trim() === year.name && !busy) void run();
              }}
            />
          </Field>
          {error && <Alert tone="red">{error}</Alert>}
        </div>
      )}
    </Modal>
  );
}
