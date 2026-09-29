import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CheckCircle2, Plus, Save, X } from 'lucide-react';
import { Alert, Button, Card, ErrorBox, IconButton, LinkButton, Loading, Page, PageHeader } from '../../components/ui';
import { DateInput, Field, MoneyInput, TextInput } from '../../components/forms';
import { AccountSelect, CustomerPicker, EmployeeSelect, SupplierPicker, type CustomerOption, type SupplierOption } from '../../components/pickers';
import { useHotkeys, useMutation, useQuery } from '../../hooks';
import { useDialogs, useToast, useUnsavedWarning } from '../../feedback';
import { formatINR } from '../../../shared/money';
import { todayISO } from '../../../shared/dates';
import type { PartyType } from '../../../shared/constants';
import './accounts.css';

/** Stock in Hand follows the stock movements, so journals cannot post to it. */
const HIDDEN_ACCOUNTS = ['STOCK'];

interface Party {
  type: PartyType;
  id: number;
  name: string;
}

interface LineState {
  key: number;
  accountId: number | null;
  party: Party | null;
  debit: number | null;
  credit: number | null;
  memo: string;
}

let nextKey = 1;
const blank = (): LineState => ({ key: nextKey++, accountId: null, party: null, debit: null, credit: null, memo: '' });

/** New journal (/accounts/journals/new) or edit an existing manual entry (/accounts/journals/:id/edit). */
export function JournalFormPage() {
  const params = useParams();
  const entryId = params.id ? Number(params.id) : null;
  const editing = entryId !== null;
  const navigate = useNavigate();
  const toast = useToast();
  const dialogs = useDialogs();
  const existing = useQuery('journals.get', editing && entryId ? { entryId } : null);
  const accounts = useQuery('accounts.list', {});
  const create = useMutation('journals.create');
  const update = useMutation('journals.update');
  const [date, setDate] = useState(todayISO());
  const [narration, setNarration] = useState('');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<LineState[]>(() => [blank(), blank()]);
  const [dirty, setDirty] = useState(false);
  const loaded = useRef(false);
  useUnsavedWarning(dirty);

  useEffect(() => {
    const d = existing.data;
    if (!d || loaded.current) return;
    loaded.current = true;
    setDate(d.date);
    setNarration(d.narration ?? '');
    setLines([
      ...d.lines.map((l) => ({
        key: nextKey++,
        accountId: l.accountId,
        party: l.partyType && l.partyId ? { type: l.partyType, id: l.partyId, name: l.partyName ?? '' } : null,
        debit: l.debit || null,
        credit: l.credit || null,
        memo: l.memo ?? '',
      })),
      blank(),
    ]);
  }, [existing.data]);

  // Accounts already on the entry being edited stay in the lists even if deactivated since.
  const savedAccountIds = useMemo(() => (existing.data ? [...new Set(existing.data.lines.map((l) => l.accountId))] : undefined), [existing.data]);

  const partyTypeOf = useMemo(() => {
    const m = new Map<number, PartyType | null>();
    for (const a of accounts.data ?? []) m.set(a.id, a.partyType);
    return m;
  }, [accounts.data]);

  const totalDr = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const totalCr = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  const diff = totalDr - totalCr;
  const used = lines.filter((l) => l.accountId && (l.debit || l.credit));
  const missingAccount = lines.some((l) => !l.accountId && (l.debit || l.credit));
  const missingParty = used.find((l) => partyTypeOf.get(l.accountId!) && !l.party);
  const problem = missingAccount
    ? 'Choose an account for every line with an amount.'
    : missingParty
      ? `Choose the ${partyTypeOf.get(missingParty.accountId!)} for line ${lines.indexOf(missingParty) + 1}.`
      : used.length < 2 || !totalDr || !totalCr
        ? 'Add at least one debit line and one credit line.'
        : diff !== 0
          ? 'Debits and credits must be equal.'
          : !narration.trim()
            ? 'Write a narration: what is this entry for?'
            : null;
  const busy = create.loading || update.loading;
  const error = create.error || update.error;

  const change = (key: number, patch: Partial<LineState>) => {
    setDirty(true);
    setLines((ls) => {
      const next = ls.map((l) => (l.key === key ? { ...l, ...patch } : l));
      const last = next[next.length - 1];
      if (last.accountId || last.debit || last.credit) next.push(blank());
      return next;
    });
  };

  const pickAccount = (l: LineState, id: number | null) => {
    const patch: Partial<LineState> = { accountId: id };
    if (id && partyTypeOf.get(id) !== (l.party?.type ?? null)) patch.party = null;
    // Fill in the amount that balances the entry, like a ledger clerk would.
    if (id && !l.debit && !l.credit && diff !== 0) {
      if (diff > 0) patch.credit = diff;
      else patch.debit = -diff;
    }
    change(l.key, patch);
  };

  const removeLine = (key: number) => {
    setDirty(true);
    setLines((ls) => {
      const next = ls.filter((l) => l.key !== key);
      while (next.length < 2) next.push(blank());
      return next;
    });
  };

  const save = async () => {
    if (problem || busy) return;
    const payload = {
      date,
      narration: narration.trim(),
      lines: used.map((l) => ({
        accountId: l.accountId!,
        debit: l.debit ?? 0,
        credit: l.credit ?? 0,
        partyType: l.party?.type ?? null,
        partyId: l.party?.id ?? null,
        memo: l.memo.trim() || null,
      })),
    };
    try {
      const res = editing ? await update.run({ ...payload, entryId: entryId!, reason: reason.trim() || null }) : await create.run(payload);
      setDirty(false);
      toast.success(editing ? `Saved ${res.voucherNo}` : `Saved journal ${res.voucherNo} for ${formatINR(res.totalDebit)}`);
      for (const w of res.warnings) toast.warning(w);
      navigate(`/accounts/journals/${res.id}`, { replace: editing });
    } catch {
      /* shown below */
    }
  };

  const leave = async () => {
    if (dirty && !(await dialogs.confirm({ title: 'Discard this entry?', message: 'The changes you made will be lost.', confirmText: 'Discard', danger: true }))) return;
    setDirty(false);
    navigate(editing ? `/accounts/journals/${entryId}` : '/accounts/journals');
  };

  useHotkeys({ 'ctrl+s': () => void save(), Escape: () => void leave() }, [problem, busy, lines, narration, date, reason, dirty]);

  if (editing) {
    if (existing.error) return <Page><PageHeader title="Edit journal" back="/accounts/journals" /><ErrorBox error={existing.error} onRetry={existing.reload} /></Page>;
    if (!existing.data) return <Loading />;
    if (!existing.data.canEdit) {
      return (
        <Page>
          <PageHeader title={`Edit ${existing.data.voucherNo ?? 'entry'}`} back={`/accounts/journals/${entryId}`} />
          <Alert tone="amber" title="This entry cannot be edited here">
            {existing.data.lockedReason ?? (existing.data.isVoid ? 'This entry is cancelled.' : 'You do not have permission to edit journal entries.')}
          </Alert>
        </Page>
      );
    }
  }

  const title = editing ? `Edit ${existing.data?.voucherLabel.toLowerCase() ?? 'journal'} ${existing.data?.voucherNo ?? ''}` : 'New journal entry';

  return (
    <Page>
      <PageHeader
        title={title}
        back={editing ? `/accounts/journals/${entryId}` : '/accounts/journals'}
        subtitle={editing ? 'Change the lines below. The voucher keeps its number and the old version stays in the history.' : 'Record anything that is not a bill, purchase or expense: adjustments, write-offs, corrections.'}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Card padded={false}>
          <div className="card-body">
            <div className={`ac-jv-head${editing ? ' with-reason' : ''}`}>
              <Field label="Date" required>
                <DateInput value={date} max={todayISO()} onChange={(v) => { setDate(v); setDirty(true); }} />
              </Field>
              <Field label="Narration" required hint="What is this entry for? It is shown in the books and ledgers.">
                <TextInput
                  value={narration}
                  autoFocus={!editing}
                  maxLength={500}
                  placeholder="e.g. Bad debt written off - Ramesh Stores"
                  onChange={(e) => {
                    setNarration(e.target.value);
                    setDirty(true);
                  }}
                />
              </Field>
              {editing && (
                <Field label="Reason for change" hint="Optional. Saved in the history.">
                  <TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong amount" maxLength={500} />
                </Field>
              )}
            </div>
          </div>
          <div className="ac-lines">
            <div className="ac-line ac-line-head">
              <span>#</span>
              <span>Account</span>
              <span>Customer / supplier / employee</span>
              <span className="r">Debit</span>
              <span className="r">Credit</span>
              <span>Memo</span>
              <span />
            </div>
            {lines.map((l, i) => {
              const pt = l.accountId ? (partyTypeOf.get(l.accountId) ?? null) : null;
              return (
                <div className="ac-line" key={l.key}>
                  <span className="ac-line-no">{i + 1}</span>
                  <AccountSelect value={l.accountId} onChange={(id) => pickAccount(l, id)} alsoShow={savedAccountIds} hideSystem={HIDDEN_ACCOUNTS} placeholder="Choose account…" />
                  <div>
                    {pt === 'customer' ? (
                      <CustomerPicker
                        value={l.party ? ({ id: l.party.id, name: l.party.name, phone: null, balance: 0, creditLimit: null } as unknown as CustomerOption) : null}
                        onChange={(c) => change(l.key, { party: c ? { type: 'customer', id: c.id, name: c.name } : null })}
                        placeholder="Choose customer…"
                        showBalance={false}
                      />
                    ) : pt === 'supplier' ? (
                      <SupplierPicker
                        value={l.party ? ({ id: l.party.id, name: l.party.name, phone: null, payable: 0 } as unknown as SupplierOption) : null}
                        onChange={(s) => change(l.key, { party: s ? { type: 'supplier', id: s.id, name: s.name } : null })}
                        placeholder="Choose supplier…"
                      />
                    ) : pt === 'employee' ? (
                      <EmployeeSelect
                        value={l.party?.id ?? null}
                        includeInactive
                        onChange={(id) => change(l.key, { party: id ? { type: 'employee', id, name: '' } : null })}
                      />
                    ) : (
                      <span className="ac-no-party">{l.accountId ? '—' : ''}</span>
                    )}
                  </div>
                  <MoneyInput value={l.debit} aria-label={`Debit line ${i + 1}`} onChange={(v) => change(l.key, { debit: v, credit: v ? null : l.credit })} />
                  <MoneyInput value={l.credit} aria-label={`Credit line ${i + 1}`} onChange={(v) => change(l.key, { credit: v, debit: v ? null : l.debit })} />
                  <TextInput value={l.memo} maxLength={200} placeholder="Optional" aria-label={`Memo line ${i + 1}`} onChange={(e) => change(l.key, { memo: e.target.value })} />
                  <IconButton label="Remove line" icon={<X size={15} />} onClick={() => removeLine(l.key)} tabIndex={-1} />
                </div>
              );
            })}
          </div>
          <div className="ac-line-foot">
            <div className="ac-totals">
              <Button size="sm" variant="ghost" icon={<Plus size={15} />} onClick={() => setLines((ls) => [...ls, blank()])}>
                Add line
              </Button>
              <span>
                <span className="lbl">Total debit</span>
                <b className="money">{formatINR(totalDr)}</b>
              </span>
              <span>
                <span className="lbl">Total credit</span>
                <b className="money">{formatINR(totalCr)}</b>
              </span>
              {totalDr === 0 && totalCr === 0 ? (
                <span className="ac-diff none">Enter the amounts</span>
              ) : diff === 0 ? (
                <span className="ac-diff ok">
                  <CheckCircle2 size={15} /> Balanced
                </span>
              ) : (
                <span className="ac-diff bad">Difference {formatINR(Math.abs(diff))} {diff > 0 ? '(more debit)' : '(more credit)'}</span>
              )}
            </div>
            <div className="row">
              <LinkButton to={editing ? `/accounts/journals/${entryId}` : '/accounts/journals'} variant="ghost">
                Cancel
              </LinkButton>
              <Button type="submit" variant="primary" icon={<Save size={16} />} kbd="Ctrl+S" loading={busy} disabled={!!problem} title={problem ?? undefined}>
                {editing ? 'Save changes' : 'Save journal'}
              </Button>
            </div>
          </div>
        </Card>
        {(error || (problem && dirty && totalDr > 0 && diff === 0)) && (
          <div className="ac-form-error">
            <Alert tone={error ? 'red' : 'amber'}>{error ?? problem}</Alert>
          </div>
        )}
      </form>
    </Page>
  );
}
