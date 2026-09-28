import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Ban, ExternalLink, Lock, Pencil, Plus } from 'lucide-react';
import { Alert, Button, Card, ErrorBox, KeyValues, LinkButton, Loading, Money, Page, PageHeader } from '../../components/ui';
import { ExportButtons } from '../../components/report';
import { useHotkeys, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { useDialogs, useToast } from '../../feedback';
import { call } from '../../api';
import { linkPath } from '../../links';
import { formatINR } from '../../../shared/money';
import { formatDate, formatDateTime } from '../../../shared/dates';
import type { ReportData } from '../../../shared/report';
import { CancelledBadge, JOURNAL_DIFF, PostingTable, RevisionHistory, VoucherBadge } from './common';

const OPEN_LABELS: Record<string, string> = {
  bill: 'Open bill',
  credit_note: 'Open credit note',
  receipt: 'Open payment received',
  purchase: 'Open purchase bill',
  supplier_payment: 'Open supplier payment',
  expense: 'Open expense',
  salary: 'Open salary slip',
  advance: 'Open employee advances',
  loan: 'Open loan',
};

/** Any journal entry: lines, where it came from, and (for manual ones) edit / cancel / history. */
export function JournalViewPage() {
  const id = Number(useParams().id);
  const valid = Number.isInteger(id) && id > 0;
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const dialogs = useDialogs();
  const q = useQuery('journals.get', valid ? { entryId: id } : null);
  const d = q.data;

  useHotkeys({ e: () => d?.canEdit && !d.isVoid && navigate(`/accounts/journals/${id}/edit`) }, [d?.canEdit, d?.isVoid, id]);

  const report = useMemo<ReportData | undefined>(() => {
    if (!d) return undefined;
    return {
      title: `${d.voucherLabel} ${d.voucherNo ?? `#${d.id}`}`,
      subtitle: `${formatDate(d.date)}${d.isVoid ? ' · CANCELLED' : ''}`,
      columns: [
        { key: 'account', label: 'Account', width: 32 },
        { key: 'party', label: 'Party', width: 22 },
        { key: 'memo', label: 'Memo', width: 22 },
        { key: 'debit', label: 'Debit', type: 'money', width: 14 },
        { key: 'credit', label: 'Credit', type: 'money', width: 14 },
      ],
      rows: [
        ...d.lines.map((l) => ({ cells: { account: l.accountName, party: l.partyName, memo: l.memo, debit: l.debit || null, credit: l.credit || null } })),
        { cells: { account: 'Total', party: null, memo: null, debit: d.totalDebit, credit: d.totalCredit }, style: 'total' as const },
      ],
      notes: [d.narration ? `Narration: ${d.narration}` : '', `Entered by ${d.createdBy ?? '—'} on ${formatDateTime(d.createdAt)}`].filter(Boolean),
    };
  }, [d]);

  if (!valid) return <Page><ErrorBox error="This entry link is not valid." /></Page>;
  if (q.error) return <Page><PageHeader title="Journal entry" back="/accounts/journals" /><ErrorBox error={q.error} onRetry={q.reload} /></Page>;
  if (!d) return <Loading />;

  const cancel = async () => {
    const reason = await dialogs.prompt({
      title: `Cancel ${d.voucherLabel.toLowerCase()} ${d.voucherNo ?? ''}?`,
      message: `The ${formatINR(d.totalDebit)} entry will stop counting in every balance and report. It keeps its number and stays in the history.`,
      label: 'Reason for cancelling',
      placeholder: 'e.g. entered twice, wrong account',
      required: true,
      confirmText: 'Cancel entry',
      danger: true,
    });
    if (!reason) return;
    try {
      await call('journals.cancel', { entryId: d.id, reason });
      toast.success(`${d.voucherNo ?? 'Entry'} cancelled`);
      void q.reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const openLabel = d.loan ? 'Open loan' : OPEN_LABELS[d.link.kind];
  const openPath = d.loan ? `/accounts/loans/${d.loan.id}` : d.fromDocument ? linkPath(d.link) : null;

  return (
    <Page>
      <PageHeader
        back="/accounts/journals"
        title={
          <span className="row">
            {d.voucherLabel} {d.voucherNo ?? `#${d.id}`}
            {d.isVoid ? <CancelledBadge /> : <VoucherBadge type={d.voucherType} label={d.sourceLabel} />}
          </span>
        }
        subtitle={`${formatDate(d.date)} · ${formatINR(d.totalDebit)}`}
        actions={
          <>
            <ExportButtons report={report} />
            {openPath && openLabel && (
              <LinkButton to={openPath} icon={<ExternalLink size={16} />}>
                {openLabel}
              </LinkButton>
            )}
            {d.canEdit && !d.isVoid && (
              <>
                <Button icon={<Pencil size={16} />} kbd="E" onClick={() => navigate(`/accounts/journals/${d.id}/edit`)}>
                  Edit
                </Button>
                <Button variant="ghost" icon={<Ban size={16} />} onClick={cancel}>
                  Cancel entry
                </Button>
              </>
            )}
            {can('accounts.manage') && d.voucherType === 'journal' && (
              <LinkButton to="/accounts/journals/new" icon={<Plus size={16} />}>
                New journal
              </LinkButton>
            )}
          </>
        }
      />
      <div className="stack">
        {d.isVoid && (
          <Alert tone="red" title={`Cancelled${d.updatedBy ? ` by ${d.updatedBy}` : ''}${d.updatedAt ? ` on ${formatDateTime(d.updatedAt)}` : ''}`}>
            {d.voidReason ? `Reason: ${d.voidReason}. ` : ''}This entry no longer affects any balance or report.
          </Alert>
        )}
        {!d.isVoid && d.lockedReason && (
          <Alert tone="blue" icon={<Lock size={16} />}>
            {d.lockedReason}
          </Alert>
        )}
        <div className="ac-split">
          <div className="stack">
            <Card title="Entry">
              <PostingTable lines={d.lines} voided={d.isVoid} />
            </Card>
            {d.revisions.length > 0 && (
              <Card title="History">
                <RevisionHistory revisions={d.revisions} fields={JOURNAL_DIFF} />
              </Card>
            )}
          </div>
          <Card title="Details">
            <KeyValues
              columns={1}
              items={[
                ['Date', formatDate(d.date)],
                ['Voucher', `${d.voucherLabel}${d.voucherNo ? ` · ${d.voucherNo}` : ''}`],
                ['Narration', d.narration],
                ['Amount', <Money value={d.totalDebit} className="bold" />],
                ['Made from', d.fromDocument && openPath ? <Link to={openPath}>{d.sourceLabel}</Link> : d.loan ? <Link to={`/accounts/loans/${d.loan.id}`}>Loan: {d.loan.name}</Link> : d.sourceLabel],
                ['Entered by', `${d.createdBy ?? '—'} · ${formatDateTime(d.createdAt)}`],
                d.updatedAt && !d.isVoid ? ['Last changed', `${d.updatedBy ?? '—'} · ${formatDateTime(d.updatedAt)}`] : null,
              ]}
            />
          </Card>
        </div>
      </div>
    </Page>
  );
}
