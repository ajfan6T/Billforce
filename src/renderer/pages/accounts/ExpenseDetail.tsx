import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Ban, Lock, Pencil } from 'lucide-react';
import { Alert, Button, Card, ErrorBox, KeyValues, Loading, Money, Page, PageHeader } from '../../components/ui';
import { Field, TextInput } from '../../components/forms';
import { Modal } from '../../components/modal';
import type { SupplierOption } from '../../components/pickers';
import { useHotkeys, useMutation, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { useDialogs, useToast } from '../../feedback';
import { call, type ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { formatDate, formatDateTime } from '../../../shared/dates';
import { CancelledBadge, fmtDate, fmtMode, fmtMoney, ModeBadge, PostingTable, RevisionHistory, type DiffField } from './common';
import { expensePayload, expenseProblem, ExpenseFields, type ExpenseDraft } from './ExpenseFields';

type Expense = ApiOutput<'expenses.get'>;

const EXPENSE_DIFF: DiffField[] = [
  { key: 'date', label: 'Date', format: fmtDate },
  { key: 'accountName', label: 'Expense head' },
  { key: 'amount', label: 'Amount', format: fmtMoney },
  { key: 'mode', label: 'Paid by', format: fmtMode },
  { key: 'payAccountName', label: 'Paid from' },
  { key: 'supplierName', label: 'Supplier' },
  { key: 'payee', label: 'Paid to' },
  { key: 'reference', label: 'Ref no' },
  { key: 'remarks', label: 'Remarks' },
];

export function ExpenseDetailPage() {
  const id = Number(useParams().id);
  const valid = Number.isInteger(id) && id > 0;
  const { can } = useAuth();
  const toast = useToast();
  const dialogs = useDialogs();
  const q = useQuery('expenses.get', valid ? { id } : null);
  const [editing, setEditing] = useState(false);
  const d = q.data;
  const canManage = can('expenses.manage');

  useHotkeys({ e: () => canManage && d?.status === 'active' && !d.lockedReason && setEditing(true) }, [canManage, d?.status, d?.lockedReason]);

  if (!valid) return <Page><ErrorBox error="This expense link is not valid." /></Page>;
  if (q.error) return <Page><PageHeader title="Expense" back="/accounts/expenses" /><ErrorBox error={q.error} onRetry={q.reload} /></Page>;
  if (!d) return <Loading />;
  const active = d.status === 'active';
  const changeable = active && !d.lockedReason;

  const cancel = async () => {
    const reason = await dialogs.prompt({
      title: `Cancel expense ${d.expenseNo}?`,
      message: `${d.accountName} ${formatINR(d.amount)} will be removed from the accounts${d.mode === 'credit' ? ` and from what you owe ${d.supplierName}` : ''}. It keeps its number and stays in the history.`,
      label: 'Reason for cancelling',
      placeholder: 'e.g. entered twice, wrong amount',
      required: true,
      confirmText: 'Cancel expense',
      danger: true,
    });
    if (!reason) return;
    try {
      await call('expenses.cancel', { id: d.id, reason });
      toast.success(`Expense ${d.expenseNo} cancelled`);
      void q.reload();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Page>
      <PageHeader
        back="/accounts/expenses"
        title={
          <span className="row">
            Expense {d.expenseNo}
            {!active && <CancelledBadge />}
          </span>
        }
        subtitle={`${formatDate(d.date)} · ${d.accountName} · ${formatINR(d.amount)}`}
        actions={
          canManage &&
          changeable && (
            <>
              <Button icon={<Pencil size={16} />} kbd="E" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button variant="ghost" icon={<Ban size={16} />} onClick={cancel}>
                Cancel expense
              </Button>
            </>
          )
        }
      />
      <div className="stack">
        {active && d.lockedReason && (
          <Alert tone="blue" icon={<Lock size={16} />}>
            {d.lockedReason}
          </Alert>
        )}
        {!active && (
          <Alert tone="red" title={`Cancelled by ${d.cancelledBy ?? 'unknown'} on ${formatDateTime(d.cancelledAt)}`}>
            Reason: {d.cancelReason}. This expense no longer counts in your accounts.
          </Alert>
        )}
        <div className="ac-split">
          <div className="stack">
            <Card title="Expense details">
              <KeyValues
                columns={3}
                items={[
                  ['Date', formatDate(d.date)],
                  ['Expense head', can('accounts.view') ? <Link to={`/accounts/ledger?account=${d.accountId}`}>{d.accountName}</Link> : d.accountName],
                  ['Amount', <Money value={d.amount} className="bold" />],
                  ['Paid by', <ModeBadge mode={d.mode} />],
                  [d.mode === 'credit' ? 'Owed to' : 'Paid from', d.mode === 'credit' ? d.supplierName : d.payAccountName],
                  ['Paid to', d.mode === 'credit' ? null : (d.supplierName ?? d.payee)],
                  ['Bill / ref no', d.reference],
                  ['Remarks', d.remarks],
                  ['Group', d.groupName],
                  ['Entered by', `${d.createdBy ?? '—'} · ${formatDateTime(d.createdAt)}`],
                  d.updatedAt ? ['Last edited', `${d.updatedBy ?? '—'} · ${formatDateTime(d.updatedAt)}`] : null,
                  d.journalEntryId && can('accounts.view') ? ['Journal entry', <Link to={`/accounts/journals/${d.journalEntryId}`}>View entry</Link>] : null,
                ]}
              />
            </Card>
            <Card title="How this is recorded in your accounts">
              <PostingTable lines={d.posting} voided={!active} />
            </Card>
          </div>
          <Card title="History">
            <RevisionHistory revisions={d.revisions} fields={EXPENSE_DIFF} />
          </Card>
        </div>
      </div>
      {editing && (
        <EditExpenseModal
          expense={d}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void q.reload();
          }}
        />
      )}
    </Page>
  );
}

function EditExpenseModal({ expense, onClose, onSaved }: { expense: Expense; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const m = useMutation('expenses.update');
  const [draft, setDraft] = useState<ExpenseDraft>(() => ({
    date: expense.date,
    accountId: expense.accountId,
    amount: expense.amount,
    pay: { mode: expense.mode, accountId: expense.mode === 'credit' ? null : expense.payAccountId },
    supplier: expense.supplierId ? ({ id: expense.supplierId, name: expense.supplierName ?? '', phone: null, payable: 0 } as unknown as SupplierOption) : null,
    payee: expense.payee ?? '',
    reference: expense.reference ?? '',
    remarks: expense.remarks ?? '',
  }));
  const [reason, setReason] = useState('');
  const problem = expenseProblem(draft);
  const save = async () => {
    if (problem) return;
    try {
      const r = await m.run({ ...expensePayload(draft), id: expense.id, reason: reason.trim() || null });
      toast.success(`Saved expense ${r.expenseNo}`);
      for (const w of r.warnings) toast.warning(w);
      onSaved();
    } catch {
      /* shown below */
    }
  };
  return (
    <Modal
      open
      title={`Edit expense ${expense.expenseNo}`}
      onClose={onClose}
      width={760}
      locked={m.loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.loading} disabled={!!problem} onClick={save}>
            Save changes
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <ExpenseFields value={draft} onChange={setDraft} fields={m.fields} layout="modal" />
        <Field label="Reason for change" hint="Optional. Saved in the history with the old and new details.">
          <TextInput value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. amount typed wrong" />
        </Field>
        {m.error && <Alert tone="red">{m.error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
