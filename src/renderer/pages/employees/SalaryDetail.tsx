import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Ban, IndianRupee, Info, Printer, Undo2 } from 'lucide-react';
import { Alert, Button, Card, ErrorBox, IconButton, KeyValues, Loading, Money, Page, PageHeader } from '../../components/ui';
import { DataTable, type Column } from '../../components/table';
import { ReceiptPreview } from '../../components/pickers';
import { useHotkeys, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { useDialogs, useToast } from '../../feedback';
import { call, type ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { formatDate, formatDateTime } from '../../../shared/dates';
import { PAYMENT_MODE_LABELS } from '../../../shared/constants';
import { AttendanceChips, ModeBadge, PostingTable, RevisionList, SalaryStatusBadge, fmtDays, salaryLabel } from './common';
import { PaySalaryModal } from './PaySalaryModal';

type Payment = ApiOutput<'salary.get'>['payments'][number];

export function SalaryDetailPage() {
  const id = Number(useParams().id);
  const valid = Number.isInteger(id) && id > 0;
  const { can } = useAuth();
  const toast = useToast();
  const dialogs = useDialogs();
  const q = useQuery('salary.get', valid ? { id } : null);
  const preview = useQuery('salary.slipHtml', valid ? { id } : null);
  const [paying, setPaying] = useState(false);
  const [printing, setPrinting] = useState(false);
  const s = q.data;

  const reload = () => {
    void q.reload();
    void preview.reload();
  };

  const print = async () => {
    if (!s) return;
    setPrinting(true);
    try {
      const res = await call('salary.print', { id: s.id });
      if (res.printed) toast.success(`Printed salary slip ${s.salaryNo}`);
      else if (res.message) toast.warning(res.message);
    } catch (e) {
      toast.error(e);
    } finally {
      setPrinting(false);
    }
  };

  const cancel = async () => {
    if (!s) return;
    const paid = s.payments.filter((p) => p.status === 'active');
    const reason = await dialogs.prompt({
      title: `Cancel salary slip ${s.salaryNo}?`,
      message: (
        <>
          The salary of {formatINR(s.net)} for {s.employeeName} ({s.monthLabel}) will be removed from the accounts
          {paid.length > 0 && (
            <>
              , together with {paid.length === 1 ? 'the payment' : `all ${paid.length} payments`} of {formatINR(s.paid)}
            </>
          )}
          {s.advanceRecovery > 0 && <>. The {formatINR(s.advanceRecovery)} recovered from the advance becomes outstanding again</>}. The slip keeps its number
          and stays in the history. You can then process {s.monthLabel} again.
        </>
      ),
      label: 'Reason for cancelling',
      placeholder: 'e.g. wrong attendance, bonus missed',
      required: true,
      confirmText: 'Cancel salary slip',
      danger: true,
    });
    if (!reason) return;
    try {
      await call('salary.cancel', { salaryId: s.id, reason });
      toast.success(`Salary slip ${s.salaryNo} cancelled`);
      reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const cancelPayment = async (p: Payment) => {
    if (!s) return;
    const reason = await dialogs.prompt({
      title: `Cancel payment of ${formatINR(p.amount)}?`,
      message: `The ${formatINR(p.amount)} paid on ${formatDate(p.date)} by ${PAYMENT_MODE_LABELS[p.mode]} will be removed from the accounts and shown as salary due again.`,
      label: 'Reason',
      placeholder: 'e.g. entered twice',
      required: true,
      confirmText: 'Cancel payment',
      danger: true,
    });
    if (!reason) return;
    try {
      await call('salary.cancelPayment', { paymentId: p.id, reason });
      toast.success('Payment cancelled');
      reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const active = s?.status !== 'cancelled';
  const canPay = !!s && active && s.balance > 0 && can('employees.salary');
  useHotkeys({ 'ctrl+p': () => void print(), 'alt+p': () => canPay && setPaying(true) }, [s?.id, canPay]);

  if (!valid) return <Page><ErrorBox error="This salary slip link is not valid." /></Page>;
  if (q.error) return <Page><PageHeader title="Salary slip" back="/employees/salary" /><ErrorBox error={q.error} onRetry={q.reload} /></Page>;
  if (!s) return <Loading />;

  const payColumns: Array<Column<Payment>> = [
    { key: 'date', label: 'Date', type: 'date', width: 110 },
    { key: 'mode', label: 'Mode', render: (p) => <ModeBadge mode={p.mode} /> },
    { key: 'accountName', label: 'Account' },
    { key: 'remarks', label: 'Remarks', render: (p) => p.remarks ?? (p.cancelReason ? <span className="muted small">Cancelled: {p.cancelReason}</span> : <span className="faint">—</span>) },
    { key: 'amount', label: 'Amount', type: 'money' },
    {
      key: 'x',
      label: '',
      sortable: false,
      align: 'right',
      render: (p) =>
        p.status === 'cancelled' ? (
          <span className="small muted">Cancelled</span>
        ) : active ? (
          <IconButton label="Cancel this payment" icon={<Undo2 size={15} />} onClick={() => void cancelPayment(p)} />
        ) : null,
    },
  ];

  const partial = s.daysEmployed !== null && s.daysEmployed < s.daysInMonth;
  const posting = s.posting.map((l) => ({
    ...l,
    group: l.entry === 'salary' ? `Salary slip · ${formatDate(l.date)}` : `Payment · ${formatDate(l.date)}`,
  }));

  return (
    <Page>
      <PageHeader
        back="/employees/salary"
        title={
          <span className="row">
            Salary slip {s.salaryNo}
            <SalaryStatusBadge status={s.status} />
          </span>
        }
        subtitle={
          <>
            <Link to={`/employees/${s.employeeId}`}>{s.employeeName}</Link>
            {s.designation ? ` · ${s.designation}` : ''} · {s.monthLabel} · dated {formatDate(s.date)}
          </>
        }
        actions={
          <>
            {canPay && (
              <Button variant="primary" icon={<IndianRupee size={16} />} kbd="Alt+P" onClick={() => setPaying(true)}>
                Pay {formatINR(s.balance)}
              </Button>
            )}
            <Button icon={<Printer size={16} />} kbd="Ctrl+P" loading={printing} onClick={print}>
              Print slip
            </Button>
            {active && (
              <Button variant="ghost" icon={<Ban size={16} />} onClick={cancel}>
                Cancel slip
              </Button>
            )}
          </>
        }
      />
      {!active && (
        <div className="emp-banner">
          <Alert tone="red" title={`Cancelled by ${s.cancelledBy ?? 'unknown'} on ${formatDateTime(s.cancelledAt)}`}>
            Reason: {s.cancelReason}. This salary and its payments no longer count in the accounts. You can process {s.monthLabel} again from the Salary page.
          </Alert>
        </div>
      )}
      <div className="emp-detail-grid">
        <div className="stack">
          <Card title={`Salary for ${s.monthLabel}`}>
            <div className="process-grid">
              <div className="stack-sm">
                {s.counts && <AttendanceChips counts={s.counts} />}
                <table className="calc-table">
                  <tbody>
                    <tr>
                      <td>{s.salaryType === 'monthly' ? 'Monthly salary' : 'Daily wage'}</td>
                      <td className="money">{salaryLabel(s.salaryType, s.rate)}</td>
                    </tr>
                    <tr>
                      <td>Days in month</td>
                      <td>{s.daysInMonth}</td>
                    </tr>
                    {partial && s.employedFrom && s.employedTo && (
                      <tr>
                        <td>
                          Worked here {formatDate(s.employedFrom)} to {formatDate(s.employedTo)}
                        </td>
                        <td>{s.daysEmployed} days</td>
                      </tr>
                    )}
                    <tr>
                      <td>Paid days</td>
                      <td>
                        <b>{fmtDays(s.paidDays)}</b>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <Alert tone="blue" icon={<Info size={16} className="emp-alert-icon" />}>
                  <div className="salary-rule">
                    {s.rule.rule}
                    <div className="mt-1">
                      <b>{s.rule.working}</b>
                    </div>
                  </div>
                </Alert>
              </div>
              <table className="calc-table">
                <tbody>
                  <tr>
                    <td>Salary earned</td>
                    <td className="money">{formatINR(s.gross)}</td>
                  </tr>
                  {s.bonus > 0 && (
                    <tr>
                      <td>Add: bonus</td>
                      <td className="money">{formatINR(s.bonus)}</td>
                    </tr>
                  )}
                  {s.deductions > 0 && (
                    <tr className="sub">
                      <td>Less: deductions</td>
                      <td className="money">-{formatINR(s.deductions)}</td>
                    </tr>
                  )}
                  {s.advanceRecovery > 0 && (
                    <tr className="sub">
                      <td>Less: advance recovered</td>
                      <td className="money">-{formatINR(s.advanceRecovery)}</td>
                    </tr>
                  )}
                  <tr className="total">
                    <td>Net salary</td>
                    <td className="money">{formatINR(s.net)}</td>
                  </tr>
                  {active && (
                    <>
                      <tr>
                        <td>Paid</td>
                        <td className="money">{formatINR(s.paid)}</td>
                      </tr>
                      <tr>
                        <td>
                          <b>Still to pay</b>
                        </td>
                        <td className={`money bold${s.balance > 0 ? ' emp-due' : ''}`}>{formatINR(s.balance)}</td>
                      </tr>
                    </>
                  )}
                  <tr className="sub">
                    <td>Advance outstanding today</td>
                    <td className="money">{formatINR(s.currentAdvance)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Payments" padded={false}>
            <DataTable
              columns={payColumns}
              rows={s.payments}
              rowKey={(p) => p.id}
              rowClassName={(p) => (p.status === 'cancelled' ? 'cancelled' : '')}
              empty={active ? 'Nothing paid yet' : 'No payments'}
            />
          </Card>
          <Card title="How this is recorded in your accounts">
            <PostingTable lines={posting} />
          </Card>
          <Card title="Details & history">
            <KeyValues
              columns={2}
              items={[
                ['Entered by', `${s.createdBy ?? '—'} · ${formatDateTime(s.createdAt)}`],
                ['Remarks', s.remarks],
                ['Net salary', <Money value={s.net} />],
                ['Salary date', formatDate(s.date)],
              ]}
            />
            <div className="mt-2">
              <RevisionList revisions={s.revisions} />
            </div>
          </Card>
        </div>
        <Card title="Salary slip" actions={<span className="small muted">80 mm receipt</span>}>
          <ReceiptPreview html={preview.data?.html} height={620} />
        </Card>
      </div>
      <PaySalaryModal
        open={paying}
        slip={{ id: s.id, salaryNo: s.salaryNo, employeeName: s.employeeName, monthLabel: s.monthLabel, date: s.date, net: s.net, balance: s.balance }}
        onClose={() => setPaying(false)}
        onSaved={() => {
          setPaying(false);
          reload();
        }}
      />
    </Page>
  );
}
