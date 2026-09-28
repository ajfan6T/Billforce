import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Eye, EyeOff, Pencil, Plus, Trash2, Wallet } from 'lucide-react';
import { Alert, Badge, Button, Card, DrCr, ErrorBox, IconButton, Loading, Page, PageHeader } from '../../components/ui';
import { Field, FormGrid, MoneyInput, SegmentedControl, Select, Switch, TextArea, TextInput } from '../../components/forms';
import { ExportButtons } from '../../components/report';
import { Modal } from '../../components/modal';
import { useHotkeys, useMutation, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { useDialogs, useToast } from '../../feedback';
import { call, type ApiOutput } from '../../api';
import { formatDrCr } from '../../../shared/money';
import { formatDate, todayISO } from '../../../shared/dates';
import { ACCOUNT_TYPE_LABELS, DEBIT_NATURE, type AccountType } from '../../../shared/constants';
import type { ReportData, ReportRow } from '../../../shared/report';
import './accounts.css';

type Chart = ApiOutput<'accounts.chart'>;
type ChartAccount = Chart['types'][number]['groups'][number]['accounts'][number];
type Group = ApiOutput<'accounts.groups'>[number];

const MODE_NAMES: Record<string, string> = { cash: 'Cash', upi: 'UPI', bank: 'Bank' };

export function ChartOfAccountsPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const dialogs = useDialogs();
  const [showInactive, setShowInactive] = useState(false);
  const chart = useQuery('accounts.chart', { includeInactive: showInactive });
  const groups = useQuery('accounts.groups', undefined);
  const [editing, setEditing] = useState<{ id: number | null; groupCode?: string } | null>(null);
  const canEdit = can('accounts.chart');

  useHotkeys({ 'alt+n': () => canEdit && setEditing({ id: null }) });

  const reload = () => {
    void chart.reload();
    void groups.reload();
  };

  const deactivate = async (a: ChartAccount) => {
    const ok = await dialogs.confirm({
      title: a.isActive ? `Deactivate "${a.name}"?` : `Re-activate "${a.name}"?`,
      message: a.isActive
        ? 'It will no longer appear in account lists for new entries. Its past entries stay in the books. You can re-activate it any time.'
        : 'It will appear again in account lists for new entries.',
      confirmText: a.isActive ? 'Deactivate' : 'Re-activate',
    });
    if (!ok) return;
    try {
      await call('accounts.setActive', { id: a.id, active: !a.isActive });
      toast.success(a.isActive ? `Deactivated "${a.name}"` : `Re-activated "${a.name}"`);
      reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const remove = async (a: ChartAccount) => {
    const ok = await dialogs.confirm({
      title: `Delete "${a.name}"?`,
      message: 'This account has no entries, so it can be deleted permanently.',
      confirmText: 'Delete account',
      danger: true,
    });
    if (!ok) return;
    try {
      await call('accounts.remove', { id: a.id });
      toast.success(`Deleted "${a.name}"`);
      reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const report = useMemo<ReportData | undefined>(() => {
    if (!chart.data) return undefined;
    const rows: ReportRow[] = [];
    for (const t of chart.data.types) {
      rows.push({ cells: { code: null, name: t.label, group: null, balance: t.balance }, style: 'section' });
      for (const g of t.groups) {
        for (const a of g.accounts) {
          rows.push({ cells: { code: a.code, name: a.name, group: g.name, balance: a.balance }, indent: 1, link: { kind: 'account', id: a.id } });
        }
      }
    }
    rows.push({ cells: { code: null, name: 'Total debit balances', group: null, balance: chart.data.totalDebit }, style: 'total' });
    rows.push({ cells: { code: null, name: 'Total credit balances', group: null, balance: -chart.data.totalCredit }, style: 'total' });
    return {
      title: 'Chart of accounts',
      subtitle: `Balances as on ${formatDate(todayISO())}`,
      columns: [
        { key: 'code', label: 'Code', width: 9 },
        { key: 'name', label: 'Account', width: 34 },
        { key: 'group', label: 'Group', width: 26 },
        { key: 'balance', label: 'Balance', type: 'drcr', width: 18 },
      ],
      rows,
    };
  }, [chart.data]);

  return (
    <Page>
      <PageHeader
        title="Chart of accounts"
        subtitle="All the accounts your transactions are recorded in. Click an account to see its ledger."
        actions={
          <>
            <Switch checked={showInactive} onChange={setShowInactive} label="Show inactive" />
            <ExportButtons report={report} />
            {canEdit && (
              <Button variant="primary" icon={<Plus size={16} />} kbd="Alt+N" onClick={() => setEditing({ id: null })}>
                Add account
              </Button>
            )}
          </>
        }
      />
      {chart.error ? (
        <ErrorBox error={chart.error} onRetry={chart.reload} />
      ) : !chart.data ? (
        <Loading />
      ) : (
        <div className="ac-split">
          <div className="stack">
            {chart.data.types.map((t) => (
              <Card key={t.type} title={t.label} padded={false} actions={<span className="ac-type-total">{formatDrCr(t.balance)}</span>}>
                <table className="ac-tree">
                  <tbody>
                    {t.groups.map((g) => (
                      <GroupRows
                        key={g.code}
                        group={g}
                        profitAndLoss={t.type === 'income' || t.type === 'expense'}
                        canEdit={canEdit}
                        onAdd={() => setEditing({ id: null, groupCode: g.code })}
                        onOpen={(a) => navigate(`/accounts/ledger?account=${a.id}`)}
                        onEdit={(a) => setEditing({ id: a.id })}
                        onToggle={deactivate}
                        onDelete={remove}
                      />
                    ))}
                  </tbody>
                </table>
              </Card>
            ))}
          </div>
          <div className="stack">
            <PaymentAccountsCard canEdit={canEdit} onSaved={reload} />
            <Card title="Check">
              <div className="stack-sm">
                <div className="row-between">
                  <span className="muted">Total debit balances</span>
                  <DrCr value={chart.data.totalDebit} />
                </div>
                <div className="row-between">
                  <span className="muted">Total credit balances</span>
                  <DrCr value={-chart.data.totalCredit} />
                </div>
                {chart.data.totalDebit === chart.data.totalCredit ? (
                  <Alert tone="green">Your books are balanced.</Alert>
                ) : (
                  <Alert tone="red">Debits and credits do not agree. Please contact support.</Alert>
                )}
                <p className="small muted mt-0">
                  <b>Dr</b> (debit) balances are what the business owns or spent; <b>Cr</b> (credit) balances are what it owes, earned or the owner put in.
                </p>
              </div>
            </Card>
          </div>
        </div>
      )}
      {editing && groups.data && (
        <AccountFormModal
          accountId={editing.id}
          initialGroup={editing.groupCode}
          groups={groups.data}
          booksStartDate={chart.data?.booksStartDate ?? ''}
          openingLockedReason={chart.data?.openingLockedReason ?? null}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </Page>
  );
}

function GroupRows({
  group,
  profitAndLoss,
  canEdit,
  onAdd,
  onOpen,
  onEdit,
  onToggle,
  onDelete,
}: {
  group: Chart['types'][number]['groups'][number];
  /** Income / expense heads can be deactivated with a balance (they stay in the reports). */
  profitAndLoss: boolean;
  canEdit: boolean;
  onAdd: () => void;
  onOpen: (a: ChartAccount) => void;
  onEdit: (a: ChartAccount) => void;
  onToggle: (a: ChartAccount) => void;
  onDelete: (a: ChartAccount) => void;
}) {
  return (
    <>
      <tr className="ac-group">
        <td className="ac-code" />
        <td className="ac-name">
          {group.name}
          {group.description && <span className="ac-sub">{group.description}</span>}
        </td>
        <td className="ac-bal money">{group.accounts.length ? formatDrCr(group.balance) : ''}</td>
        <td className="ac-actions">
          {canEdit && group.allowUserAccounts && <IconButton label={`Add account under ${group.name}`} icon={<Plus size={16} />} onClick={onAdd} />}
        </td>
      </tr>
      {group.accounts.length === 0 && (
        <tr className="ac-empty">
          <td colSpan={4}>No accounts yet</td>
        </tr>
      )}
      {group.accounts.map((a) => {
        const canDelete = !a.isSystem && !a.loanId && a.entryCount === 0 && a.defaultFor.length === 0;
        const canToggle = !a.isSystem && !a.loanId && a.defaultFor.length === 0 && (!a.isActive || a.balance === 0 || profitAndLoss);
        const toggleTitle = a.isSystem
          ? 'Built-in accounts cannot be deactivated'
          : a.loanId
            ? 'Close the loan from Accounts > Loans'
            : a.defaultFor.length
              ? 'Used for payments: choose another payment account first'
              : a.isActive && a.balance !== 0 && !profitAndLoss
                ? 'Only accounts with a zero balance can be deactivated'
                : a.isActive
                  ? 'Deactivate'
                  : 'Re-activate';
        const deleteTitle = a.isSystem ? 'Built-in accounts cannot be deleted' : a.entryCount ? 'Accounts with entries cannot be deleted' : a.loanId ? 'Loan accounts are managed from Loans' : 'Delete';
        return (
          <tr key={a.id} className={`ac-acct${a.isActive ? '' : ' inactive'}`} onClick={() => onOpen(a)} title="Open ledger">
            <td className="ac-code">{a.code}</td>
            <td className="ac-name">
              {a.name}
              <span className="ac-badges">
                {a.isSystem && <Badge tone="blue">System</Badge>}
                {a.loanId && <Badge tone="purple">Loan</Badge>}
                {a.defaultFor.length > 0 && <Badge tone="green">{a.defaultFor.map((m) => MODE_NAMES[m]).join(' / ')} payments</Badge>}
                {!a.isActive && <Badge>Inactive</Badge>}
              </span>
            </td>
            <td className={`ac-bal money${a.balance ? '' : ' faint'}`}>{formatDrCr(a.balance)}</td>
            <td className="ac-actions" onClick={(e) => e.stopPropagation()}>
              {canEdit && (
                <>
                  <IconButton label="Edit" icon={<Pencil size={15} />} onClick={() => onEdit(a)} />
                  <IconButton label={toggleTitle} icon={a.isActive ? <EyeOff size={15} /> : <Eye size={15} />} disabled={!canToggle} onClick={() => onToggle(a)} />
                  <IconButton label={deleteTitle} className="danger" icon={<Trash2 size={15} />} disabled={!canDelete} onClick={() => onDelete(a)} />
                </>
              )}
            </td>
          </tr>
        );
      })}
    </>
  );
}

/* ------------------------------ Add / edit account ------------------------------ */

function AccountFormModal({
  accountId,
  initialGroup,
  groups,
  booksStartDate,
  openingLockedReason,
  onClose,
  onSaved,
}: {
  accountId: number | null;
  initialGroup?: string;
  groups: Group[];
  booksStartDate: string;
  /** Set when the first financial year is closed: opening balances can no longer be entered. */
  openingLockedReason: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const existing = useQuery('accounts.get', accountId ? { id: accountId } : null);
  const create = useMutation('accounts.create');
  const update = useMutation('accounts.update');
  const selectable = groups.filter((g) => g.allowUserAccounts);
  const [name, setName] = useState('');
  const [groupCode, setGroupCode] = useState(initialGroup ?? 'indirect_expenses');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [opening, setOpening] = useState<number | null>(null);
  const [side, setSide] = useState<'debit' | 'credit'>('debit');
  const [touchedSide, setTouchedSide] = useState(false);
  const d = existing.data;

  useEffect(() => {
    if (!d) return;
    setName(d.name);
    setGroupCode(d.groupCode);
    setCode(d.code ?? '');
    setDescription(d.description ?? '');
    setOpening(d.openingBalance ? Math.abs(d.openingBalance) : null);
    setSide((d.openingBalance ?? 0) < 0 ? 'credit' : (d.openingBalance ?? 0) > 0 ? 'debit' : DEBIT_NATURE[d.type] ? 'debit' : 'credit');
  }, [d]);

  const group = groups.find((g) => g.code === groupCode);
  const type: AccountType | undefined = d?.type ?? group?.type;
  useEffect(() => {
    if (!accountId && group && !touchedSide) setSide(DEBIT_NATURE[group.type] ? 'debit' : 'credit');
  }, [accountId, group, touchedSide]);
  const canHaveOpening = accountId ? d?.openingBalance !== null && d?.openingBalance !== undefined : type === 'asset' || type === 'liability' || type === 'equity';
  const locked = canHaveOpening ? (accountId ? (d?.openingLockedReason ?? null) : openingLockedReason) : null;
  const openingAllowed = canHaveOpening && !locked;
  const busy = create.loading || update.loading;
  const error = create.error || update.error;
  const fields = { ...create.fields, ...update.fields };

  const save = async () => {
    const openingBalance = openingAllowed ? (opening ? { amount: opening, side } : null) : undefined;
    try {
      if (accountId) {
        const res = await update.run({ id: accountId, name, code: code || null, description: description || null, groupCode, openingBalance });
        toast.success(`Saved "${res.name}"`);
      } else {
        const res = await create.run({ name, groupCode, code: code || null, description: description || null, openingBalance });
        toast.success(`Added account "${res.name}" (${res.code})`);
      }
      onSaved();
    } catch {
      /* shown in the form */
    }
  };

  const byType = (['asset', 'liability', 'equity', 'income', 'expense'] as AccountType[])
    .map((t) => ({ type: t, groups: selectable.filter((g) => g.type === t) }))
    .filter((x) => x.groups.length);

  return (
    <Modal
      open
      title={accountId ? `Edit account${d ? ` "${d.name}"` : ''}` : 'Add account'}
      onClose={onClose}
      width={560}
      locked={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || (accountId !== null && !d)} onClick={save}>
            {accountId ? 'Save changes' : 'Add account'}
          </Button>
        </>
      }
    >
      {accountId && !d ? (
        existing.error ? <ErrorBox error={existing.error} /> : <Loading />
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void save();
          }}
        >
          {d?.isSystem && (
            <Alert tone="blue">Billforce posts to this built-in account automatically. You can rename it, but it cannot be moved, deactivated or deleted.</Alert>
          )}
          <Field label="Account name" required error={fields.name}>
            <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Shop Rent, Petty Cash, ICICI Current A/c" maxLength={80} />
          </Field>
          <FormGrid cols={2}>
            <Field label="Group" required error={fields.groupCode} hint={d && !d.canChangeGroup ? d.groupChangeBlockedReason : group?.description}>
              <select className="input select" value={groupCode} disabled={!!d && !d.canChangeGroup} onChange={(e) => setGroupCode(e.target.value)}>
                {d && !selectable.some((g) => g.code === d.groupCode) && <option value={d.groupCode}>{d.groupName}</option>}
                {byType.map((t) => (
                  <optgroup key={t.type} label={ACCOUNT_TYPE_LABELS[t.type]}>
                    {t.groups.map((g) => (
                      <option key={g.code} value={g.code}>
                        {g.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </Field>
            <Field label="Code" error={fields.code} hint={accountId ? 'Letters, numbers and dashes' : `Leave blank for the next number (${group?.nextCode ?? ''})`}>
              <TextInput value={code} onChange={(e) => setCode(e.target.value)} placeholder={group?.nextCode} maxLength={20} />
            </Field>
          </FormGrid>
          <Field label="Description">
            <TextArea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="Optional note about what goes into this account" />
          </Field>
          {openingAllowed ? (
            <Field
              label={`Opening balance on ${formatDate(booksStartDate || d?.booksStartDate)}`}
              hint="The balance this account had when you started using Billforce. Leave blank if none."
              error={fields.openingBalance}
            >
              <div className="row">
                <MoneyInput value={opening} onChange={setOpening} style={{ width: 200 }} />
                <SegmentedControl<'debit' | 'credit'>
                  size="sm"
                  value={side}
                  onChange={(v) => {
                    setSide(v);
                    setTouchedSide(true);
                  }}
                  options={[
                    { value: 'debit', label: 'Dr (you have / own)' },
                    { value: 'credit', label: 'Cr (you owe)' },
                  ]}
                />
              </div>
            </Field>
          ) : locked ? (
            <div className="small muted">
              {d?.openingBalance ? (
                <>
                  Opening balance on {formatDate(d.booksStartDate)}: <b>{formatDrCr(d.openingBalance)}</b>.{' '}
                </>
              ) : null}
              {locked}
            </div>
          ) : (
            d?.openingBlockedReason && <div className="small muted">{d.openingBlockedReason}</div>
          )}
          {error && <Alert tone="red">{error}</Alert>}
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  );
}

/* ------------------------------ Payment accounts ------------------------------ */

function PaymentAccountsCard({ canEdit, onSaved }: { canEdit: boolean; onSaved: () => void }) {
  const toast = useToast();
  const q = useQuery('accounts.paymentAccounts', undefined);
  const m = useMutation('accounts.setPaymentDefaults');
  const [v, setV] = useState<{ cash: number; upi: number; bank: number } | null>(null);
  useEffect(() => {
    if (q.data) setV(q.data.defaults);
  }, [q.data]);
  if (!q.data || !v) return <Card title="Payment accounts">{q.error ? <ErrorBox error={q.error} /> : <Loading />}</Card>;
  const cash = q.data.cash.map((a) => ({ value: a.id, label: a.name }));
  const bank = q.data.bank.map((a) => ({ value: a.id, label: a.name }));
  const dirty = v.cash !== q.data.defaults.cash || v.upi !== q.data.defaults.upi || v.bank !== q.data.defaults.bank;
  const save = async () => {
    try {
      await m.run({ cashAccountId: v.cash, upiAccountId: v.upi, bankAccountId: v.bank });
      toast.success('Payment accounts saved');
      await q.reload();
      onSaved();
    } catch {
      /* shown below */
    }
  };
  return (
    <Card
      title={
        <span className="row">
          <Wallet size={16} /> Payment accounts
        </span>
      }
    >
      <div className="stack-sm">
        <p className="small muted mt-0">Where money goes when a bill, expense or payment is marked Cash, UPI or Bank.</p>
        <Field label="Cash">
          <Select<number> value={v.cash} onChange={(id) => setV({ ...v, cash: id })} options={cash} disabled={!canEdit} />
        </Field>
        <Field label="UPI">
          <Select<number> value={v.upi} onChange={(id) => setV({ ...v, upi: id })} options={bank} disabled={!canEdit} />
        </Field>
        <Field label="Bank">
          <Select<number> value={v.bank} onChange={(id) => setV({ ...v, bank: id })} options={bank} disabled={!canEdit} />
        </Field>
        {m.error && <Alert tone="red">{m.error}</Alert>}
        {canEdit && (
          <div className="row-between">
            <span className="small faint">Add more under Cash-in-Hand or Bank & UPI.</span>
            <Button variant="primary" size="sm" disabled={!dirty} loading={m.loading} onClick={save}>
              Save
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
