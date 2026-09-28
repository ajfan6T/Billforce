import { useEffect, useState } from 'react';
import { AlertTriangle, DatabaseBackup, FolderOpen, FolderSearch, HardDriveDownload, History, RotateCcw, ShieldCheck, Usb } from 'lucide-react';
import { Alert, Badge, Button, Card, EmptyState, ErrorBox, IconButton, Loading, Page, PageHeader, type Tone } from '../../components/ui';
import { Field, NumberInput, Switch, TextInput } from '../../components/forms';
import { DataTable, type Column } from '../../components/table';
import { Modal } from '../../components/modal';
import { useMutation, useQuery } from '../../hooks';
import { useToast } from '../../feedback';
import { useAuth } from '../../auth';
import { call, type ApiOutput } from '../../api';
import { formatDate, formatDateTime } from '../../../shared/dates';
import { formatIndianNumber } from '../../../shared/money';
import { formatBytes, hoursSince, timeAgo, WhenText } from './common';
import './admin.css';

type Status = ApiOutput<'backup.status'>;
type BackupRow = Status['backups'][number];
type Inspection = ApiOutput<'backup.inspect'>;

/** Colour per kind; the words come from the backup itself (b.label), e.g. "Before year-end close" for a safety copy. */
const KIND_TONE: Record<BackupRow['kind'], Tone> = { auto: 'blue', manual: 'green', safety: 'amber', other: 'neutral' };

const CONFIRM_WORD = 'RESTORE';

/** Folder part of a Windows or POSIX path. */
const folderOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '') || p;

/** Shows what is inside a backup, then asks the user to type RESTORE before replacing all data. */
function RestoreModal({ path, onClose }: { path: string | null; onClose: () => void }) {
  const info = useQuery('backup.inspect', path ? { path } : null);
  const restore = useMutation('backup.restore');
  const [word, setWord] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    setWord('');
    setDone(false);
    restore.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const run = async () => {
    if (!path || word.trim().toUpperCase() !== CONFIRM_WORD) return;
    try {
      await restore.run({ path });
      setDone(true);
      // The app reloads to the login screen on the "database-replaced" event (instant in the desktop app).
      // Fallback in case that event never arrives; the first reload cancels this timer.
      setTimeout(() => window.location.reload(), 8000);
    } catch {
      /* shown below */
    }
  };

  const d: Inspection | undefined = info.data;
  const ready = word.trim().toUpperCase() === CONFIRM_WORD;
  return (
    <Modal
      open={!!path}
      title={done ? 'Data restored' : 'Restore from backup'}
      onClose={onClose}
      width={600}
      locked={restore.loading || done}
      footer={
        done ? undefined : info.error ? (
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="danger" icon={<RotateCcw size={16} />} loading={restore.loading} disabled={!d || !ready} onClick={run}>
              Replace my data with this backup
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="import-done">
          <div className="auth-icon ok">
            <ShieldCheck size={28} />
          </div>
          <div className="backup-hero-title">The backup has been restored</div>
          <p className="muted mt-0">Billforce is restarting. Please log in again.</p>
        </div>
      ) : info.error ? (
        <div className="stack">
          <Alert tone="red" title="This file cannot be restored">
            {info.error}
          </Alert>
          <p className="muted mt-0 mb-0">Choose a file ending in .bfbackup made by Billforce (from the backup folder or your pen drive). Your current data has not been changed.</p>
        </div>
      ) : !d ? (
        <Loading label="Reading the backup…" />
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <div>
            <div className="backup-hero-title">{d.businessName || 'Billforce data'}</div>
            <div className="muted small">
              {d.fileName} · {formatBytes(d.sizeBytes)}
            </div>
          </div>
          <div className="restore-facts">
            <div className="restore-fact">
              <div className="rf-label">Backup taken</div>
              <div className="rf-value">{d.backupAt ? formatDateTime(d.backupAt) : 'Unknown'}</div>
            </div>
            <div className="restore-fact">
              <div className="rf-label">Bills</div>
              <div className="rf-value">{formatIndianNumber(d.counts.bills, 0)}</div>
            </div>
            <div className="restore-fact">
              <div className="rf-label">Last bill</div>
              <div className="rf-value">{d.lastBillDate ? formatDate(d.lastBillDate) : 'None'}</div>
            </div>
            <div className="restore-fact">
              <div className="rf-label">Customers</div>
              <div className="rf-value">{formatIndianNumber(d.counts.customers, 0)}</div>
            </div>
            <div className="restore-fact">
              <div className="rf-label">Suppliers</div>
              <div className="rf-value">{formatIndianNumber(d.counts.suppliers, 0)}</div>
            </div>
            <div className="restore-fact">
              <div className="rf-label">Items</div>
              <div className="rf-value">{formatIndianNumber(d.counts.items, 0)}</div>
            </div>
          </div>
          {!d.healthy && <Alert tone="amber">This backup did not pass the quick health check. Billforce will check it fully before restoring.</Alert>}
          <Alert tone="red" icon={<AlertTriangle size={18} />} title="All current data will be replaced">
            Everything entered after {d.backupAt ? formatDateTime(d.backupAt) : 'this backup was made'} will be lost from the books. A safety copy of your current data is saved
            first, so you can undo this by restoring that copy. Everyone will be logged out.
          </Alert>
          <Field label={<>Type <span className="confirm-word">{CONFIRM_WORD}</span> to confirm</>}>
            <TextInput value={word} onChange={(e) => setWord(e.target.value)} autoFocus autoComplete="off" placeholder={CONFIRM_WORD} />
          </Field>
          {restore.error && <Alert tone="red">{restore.error}</Alert>}
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  );
}

export function BackupPage() {
  const { can } = useAuth();
  const status = useQuery('backup.status', undefined);
  const update = useMutation('settings.update');
  const toast = useToast();
  const [busy, setBusy] = useState<'now' | 'copy' | 'folder' | 'pick' | null>(null);
  const [restorePath, setRestorePath] = useState<string | null>(null);
  const [keep, setKeep] = useState<number | null>(null);
  const canBackup = can('data.backup');
  const canRestore = can('data.restore');

  useEffect(() => {
    if (status.data) setKeep(status.data.keepCount);
  }, [status.data]);

  const act = async (what: typeof busy, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const backupNow = () =>
    act('now', async () => {
      const b = await call('backup.create', {});
      toast.success(`Backup saved (${formatBytes(b.sizeBytes)})`, { label: 'Show', onClick: () => void call('files.showInFolder', { path: b.path }) });
      await status.reload();
    });
  const saveCopy = () =>
    act('copy', async () => {
      const r = await call('backup.saveAs');
      if (r.path) {
        toast.success(`Copy saved to ${r.path}`);
        await status.reload();
      }
    });
  const chooseFolder = () =>
    act('folder', async () => {
      const r = await call('backup.chooseFolder');
      if (r.changed) {
        toast.success(`Backups will be saved in ${r.folder}`);
        await status.reload();
      }
    });
  const pickFile = () =>
    act('pick', async () => {
      const r = await call('backup.pickFile');
      if (r.path) setRestorePath(r.path);
    });
  const setOption = async (values: { autoBackup?: boolean; keepCount?: number }) => {
    try {
      await update.run({ section: 'backup', values });
      toast.success(values.autoBackup === undefined ? `Keeping the last ${values.keepCount} automatic backups` : values.autoBackup ? 'Automatic daily backup is on' : 'Automatic backup is off');
      await status.reload();
    } catch (e) {
      toast.error(e);
      if (status.data) setKeep(status.data.keepCount);
    }
  };

  if (status.error) {
    return (
      <Page>
        <PageHeader title="Backup & restore" />
        <ErrorBox error={status.error} onRetry={status.reload} />
      </Page>
    );
  }
  const s = status.data;
  if (!s) return <Loading />;

  const age = hoursSince(s.lastBackup?.at);
  const stale = age === null || age > 36;
  const keepProblem = keep === null || keep < 3 || keep > 365 ? 'Between 3 and 365' : null;

  const columns: Array<Column<BackupRow>> = [
    { key: 'at', label: 'Date & time', render: (b) => <WhenText ts={b.at} /> },
    {
      key: 'kind',
      label: 'Type',
      value: (b) => (b.damaged ? `${b.label} (damaged)` : b.label),
      render: (b) => (
        <div className="status-list">
          <Badge tone={KIND_TONE[b.kind]}>{b.label}</Badge>
          {b.damaged && <Badge tone="red">Damaged</Badge>}
        </div>
      ),
    },
    { key: 'sizeBytes', label: 'Size', align: 'right', className: 'nowrap', render: (b) => formatBytes(b.sizeBytes) },
    {
      key: 'fileName',
      label: 'File',
      render: (b) => (
        <div>
          <span className="path-text">{b.fileName}</span>
          {!b.inFolder && <span className="cell-note">Saved in {folderOf(b.path)}</span>}
          {b.note && <span className="cell-note">{b.note}</span>}
          {b.damaged && <span className="cell-note danger">This file is incomplete (for example the disk was full when it was saved) and cannot be restored.</span>}
        </div>
      ),
    },
    {
      key: 'actions',
      label: '',
      sortable: false,
      align: 'right',
      render: (b) => (
        <div className="admin-actions">
          <IconButton label="Show in folder" icon={<FolderSearch size={16} />} onClick={() => void call('files.showInFolder', { path: b.path }).catch((e) => toast.error(e))} />
          {canRestore && s.canRestore && !b.damaged && (
            <Button size="sm" icon={<RotateCcw size={14} />} onClick={() => setRestorePath(b.path)}>
              Restore
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Backup & restore"
        subtitle="Keep a copy of your data safe, and bring it back if something goes wrong"
        actions={
          <>
            {canBackup && (
              <Button icon={<Usb size={16} />} loading={busy === 'copy'} onClick={saveCopy}>
                Save a copy to…
              </Button>
            )}
            {canBackup && (
              <Button variant="primary" icon={<DatabaseBackup size={16} />} loading={busy === 'now'} onClick={backupNow}>
                Back up now
              </Button>
            )}
          </>
        }
      />
      <div className="backup-grid">
        <Card>
          <div className="backup-hero">
            <div className={`backup-hero-icon${stale ? ' warn' : ''}`}>{stale ? <AlertTriangle size={24} /> : <ShieldCheck size={24} />}</div>
            <div className="backup-hero-main">
              {s.lastBackup ? (
                <>
                  <div className="backup-hero-title">Last backup {timeAgo(s.lastBackup.at)}</div>
                  <div className="muted">{formatDateTime(s.lastBackup.at)}</div>
                  {s.lastBackup.path && <div className="path-text mt-1">{s.lastBackup.path}</div>}
                  {!s.lastBackup.exists && <Alert tone="amber">That backup file is no longer there (it may have been on a pen drive that was removed).</Alert>}
                  {s.lastBackup.exists && s.lastBackup.damaged && <Alert tone="red">That backup file is incomplete and cannot be restored. Press "Back up now".</Alert>}
                </>
              ) : (
                <>
                  <div className="backup-hero-title">No backup yet</div>
                  <div className="muted">Take one now - it only takes a few seconds.</div>
                </>
              )}
              {stale && s.lastBackup && <div className="muted small mt-1">It has been more than a day. Press "Back up now", or keep automatic backup on.</div>}
            </div>
          </div>
          <div className="mt-2">
            <Alert tone="neutral">
              Also keep a copy away from this computer: use <b>Save a copy to…</b> and choose a pen drive, so your data is safe even if the computer is lost or damaged.
            </Alert>
          </div>
        </Card>
        <Card title="Automatic backup">
          <div className="setting-line">
            <div>
              <div className="label">Back up every day</div>
              <div className="hint">Once a day while Billforce is open, and when you close it after making changes</div>
            </div>
            <Switch checked={s.autoBackup} disabled={!canBackup || update.loading} onChange={(v) => void setOption({ autoBackup: v })} />
          </div>
          <div className="setting-line">
            <div style={{ minWidth: 0 }}>
              <div className="label">Backup folder{s.isDefaultFolder ? ' (standard)' : ''}</div>
              <div className="path-text">{s.folder}</div>
            </div>
            <div className="row">
              {canBackup && (
                <Button size="sm" loading={busy === 'folder'} onClick={chooseFolder}>
                  Change…
                </Button>
              )}
              <Button size="sm" icon={<FolderOpen size={15} />} onClick={() => void call('backup.openFolder').catch((e) => toast.error(e))}>
                Open
              </Button>
            </div>
          </div>
          <div className="setting-line">
            <div>
              <div className="label">Automatic backups to keep</div>
              <div className="hint">Older automatic backups are deleted. Manual backups are always kept.</div>
            </div>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (!keepProblem && keep !== s.keepCount) void setOption({ keepCount: keep! });
              }}
            >
              <Field error={keepProblem}>
                <NumberInput value={keep} decimals={0} style={{ width: 80 }} disabled={!canBackup} onChange={setKeep} aria-label="Automatic backups to keep" />
              </Field>
              {keep !== s.keepCount && (
                <Button size="sm" type="submit" variant="primary" disabled={!!keepProblem} loading={update.loading}>
                  Save
                </Button>
              )}
            </form>
          </div>
        </Card>
      </div>

      <Card
        title="Backups"
        padded={false}
        actions={
          canRestore && s.canRestore ? (
            <Button size="sm" icon={<HardDriveDownload size={15} />} loading={busy === 'pick'} onClick={pickFile}>
              Restore from a file…
            </Button>
          ) : undefined
        }
      >
        <div style={{ height: 12 }} />
        {s.backups.length ? (
          <DataTable columns={columns} rows={s.backups} rowKey={(b) => b.path} maxHeight={480} />
        ) : (
          <EmptyState icon={<History size={32} />} title="No backups in this folder yet" message='Press "Back up now" to make the first one.' />
        )}
      </Card>
      {!s.canRestore && <p className="muted small">Restoring is not available in this test mode.</p>}
      <RestoreModal
        path={restorePath}
        onClose={() => {
          if (!restorePath) return;
          setRestorePath(null);
        }}
      />
    </Page>
  );
}
