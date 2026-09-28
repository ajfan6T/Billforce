import { Link } from 'react-router';
import { Ban } from 'lucide-react';
import { Alert, Badge, Button, ErrorBox, KeyValues, Loading, Money } from '../../components/ui';
import { Modal } from '../../components/modal';
import { useQuery } from '../../hooks';
import { useDialogs, useToast } from '../../feedback';
import { call } from '../../api';
import { formatINR } from '../../../shared/money';
import { formatDate, formatDateTime } from '../../../shared/dates';
import { ModeBadge, PostingTable, RevisionList } from './common';

/** One advance: details, accounting entry, history and cancel. */
export function AdvanceDetailModal({ id, onClose, onChanged }: { id: number | null; onClose: () => void; onChanged: () => void }) {
  const q = useQuery('advances.get', id ? { id } : null);
  const dialogs = useDialogs();
  const toast = useToast();
  const a = q.data && q.data.id === id ? q.data : undefined;

  const cancel = async () => {
    if (!a) return;
    const reason = await dialogs.prompt({
      title: `Cancel advance ${a.advanceNo}?`,
      message: `The ${formatINR(a.amount)} advance to ${a.employeeName} will be removed from the accounts (the money is treated as returned). It keeps its number and stays in the history.`,
      label: 'Reason for cancelling',
      placeholder: 'e.g. returned by employee, entered twice',
      required: true,
      confirmText: 'Cancel advance',
      danger: true,
    });
    if (!reason) return;
    try {
      await call('advances.cancel', { id: a.id, reason });
      toast.success(`Advance ${a.advanceNo} cancelled`);
      void q.reload();
      onChanged();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Modal
      open={id !== null}
      title={a ? `Advance ${a.advanceNo}` : 'Advance'}
      onClose={onClose}
      width={620}
      footer={
        <>
          {a?.status === 'active' && (
            <Button variant="ghost" icon={<Ban size={16} />} onClick={cancel}>
              Cancel advance
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {q.error ? (
        <ErrorBox error={q.error} onRetry={q.reload} />
      ) : !a ? (
        <Loading />
      ) : (
        <div className="stack">
          {a.status === 'cancelled' && (
            <Alert tone="red" title={`Cancelled by ${a.cancelledBy ?? 'unknown'} on ${formatDateTime(a.cancelledAt)}`}>
              Reason: {a.cancelReason}
            </Alert>
          )}
          <KeyValues
            columns={3}
            items={[
              ['Employee', <Link to={`/employees/${a.employeeId}`} onClick={onClose}>{a.employeeName}</Link>],
              ['Date', formatDate(a.date)],
              ['Amount', <Money value={a.amount} className="bold" />],
              ['Paid by', <ModeBadge mode={a.mode} />],
              ['Account', a.accountName],
              ['Status', a.status === 'active' ? <Badge tone="green">Active</Badge> : <Badge tone="red">Cancelled</Badge>],
              ['Advance outstanding today', <Money value={a.currentAdvance} />],
              ['Remarks', a.remarks],
              ['Entered by', `${a.createdBy ?? '—'} · ${formatDateTime(a.createdAt)}`],
            ]}
          />
          <div>
            <div className="section-title mb-1">How this is recorded in your accounts</div>
            <PostingTable lines={a.posting.map((l) => ({ ...l, void: a.status === 'cancelled' }))} />
          </div>
          <div>
            <div className="section-title mb-1">History</div>
            <RevisionList revisions={a.revisions} />
          </div>
        </div>
      )}
    </Modal>
  );
}
