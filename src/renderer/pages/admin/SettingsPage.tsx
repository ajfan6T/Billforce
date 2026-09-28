import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { FolderOpen, Save } from 'lucide-react';
import { Alert, Button, Card, ErrorBox, KeyValues, Loading, Page, PageHeader, Tabs } from '../../components/ui';
import { Field, FormGrid, NumberInput, SegmentedControl, Switch, TextArea, TextInput } from '../../components/forms';
import { useHotkeys, useQuery } from '../../hooks';
import { useDialogs, useToast, useUnsavedWarning } from '../../feedback';
import { useAuth } from '../../auth';
import { call } from '../../api';
import { PAYMENT_MODE_LABELS, PAYMENT_MODES, SEQUENCE_KEYS, SEQUENCE_LABELS, type PaymentMode, type SequenceKey } from '../../../shared/constants';
import { formatDate, formatDateTime, fyOf, todayISO } from '../../../shared/dates';
import type { AppSettings } from '../../../shared/settings';
import { useSectionForm } from './useSectionForm';
import { LivePreview, ReceiptTab } from './ReceiptTab';
import { SwitchRow, formatBytes } from './common';
import './admin.css';

type TabKey = 'business' | 'receipt' | 'billing' | 'security' | 'about';
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'business', label: 'Business' },
  { key: 'receipt', label: 'Receipt & printer' },
  { key: 'billing', label: 'Billing' },
  { key: 'security', label: 'Security' },
  { key: 'about', label: 'About' },
];

interface TabProps<K extends keyof AppSettings> {
  settings: AppSettings;
  onSaved: (v: AppSettings[K]) => void;
  onDirty: (d: boolean) => void;
}

function SaveBar({ dirty, saving, onUndo, disabled }: { dirty: boolean; saving: boolean; onUndo: () => void; disabled?: boolean }) {
  return (
    <div className="settings-save">
      {dirty && <span className="unsaved-dot">Unsaved changes</span>}
      {dirty && (
        <Button variant="ghost" onClick={onUndo}>
          Undo changes
        </Button>
      )}
      <Button type="submit" variant="primary" icon={<Save size={16} />} kbd="Ctrl+S" loading={saving} disabled={!dirty || disabled}>
        Save
      </Button>
    </div>
  );
}

const UPI_RE = /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9]{1,63}$/;

function BusinessTab({ settings, onSaved, onDirty }: TabProps<'business'>) {
  const { refresh } = useAuth();
  const f = useSectionForm('business', settings.business, onSaved);
  useEffect(() => onDirty(f.dirty), [f.dirty, onDirty]);
  const save = async () => {
    if (await f.save('Business details saved')) await refresh();
  };
  useHotkeys({ 'ctrl+s': () => void save() }, [f.save]);
  const d = f.draft;
  if (!d) return null;
  const upiProblem = d.upiId.trim() && !UPI_RE.test(d.upiId.trim()) ? 'Enter a valid UPI ID, e.g. sharmastore@okaxis' : null;
  return (
    <div className="settings-layout">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Card title="Your business">
          <div className="stack">
            <Field label="Business name" required hint="Printed at the top of every bill" error={f.err('name') ?? (!d.name.trim() ? 'Enter the business name' : null)}>
              <TextInput value={d.name} maxLength={120} onChange={(e) => f.set('name', e.target.value)} autoFocus />
            </Field>
            <Field label="Address" error={f.err('address')}>
              <TextArea rows={3} value={d.address} maxLength={500} onChange={(e) => f.set('address', e.target.value)} placeholder="Shop no, street, city, PIN" />
            </Field>
            <FormGrid>
              <Field label="Phone" error={f.err('phone')}>
                <TextInput value={d.phone} maxLength={40} inputMode="tel" onChange={(e) => f.set('phone', e.target.value)} placeholder="98xxxxxxxx" />
              </Field>
              <Field label="Email" error={f.err('email')}>
                <TextInput value={d.email} maxLength={120} type="email" onChange={(e) => f.set('email', e.target.value)} />
              </Field>
            </FormGrid>
          </div>
        </Card>
        <Card title="UPI payments">
          <div className="stack">
            <p className="muted mt-0 mb-0">With a UPI ID, bills can carry a QR code that customers scan with GPay, PhonePe, Paytm or BHIM to pay the exact amount.</p>
            <FormGrid>
              <Field label="UPI ID" hint="As shown in your UPI app, e.g. sharmastore@okaxis" error={f.err('upiId') ?? upiProblem}>
                <TextInput value={d.upiId} maxLength={100} onChange={(e) => f.set('upiId', e.target.value.trim())} placeholder="name@bank" />
              </Field>
              <Field label="Payee name" hint="Name customers see when they pay (blank = business name)" error={f.err('upiName')}>
                <TextInput value={d.upiName} maxLength={60} onChange={(e) => f.set('upiName', e.target.value)} placeholder={d.name} />
              </Field>
            </FormGrid>
            {d.upiId && settings.receipt.upiQr === 'never' && (
              <Alert tone="blue">To print the QR code on bills, turn it on in the Receipt &amp; printer tab.</Alert>
            )}
          </div>
        </Card>
        {f.error && <Alert tone="red">{f.error}</Alert>}
        <SaveBar dirty={f.dirty} saving={f.saving} onUndo={f.reset} disabled={!d.name.trim() || !!upiProblem} />
      </form>
      <div className="preview-col">
        <LivePreview business={d} showDuplicateToggle={false} />
      </div>
    </div>
  );
}

const PREFIX_RE = /^[A-Z0-9]{1,8}$/;

function BillingTab({ settings, onSaved, onDirty }: TabProps<'billing'>) {
  const f = useSectionForm('billing', settings.billing, onSaved);
  // The real next number of each series (bills already made this year count), not always 0001.
  const numbers = useQuery('settings.nextNumbers', undefined);
  useEffect(() => onDirty(f.dirty), [f.dirty, onDirty]);
  useHotkeys({ 'ctrl+s': () => void f.save('Billing settings saved') }, [f.save]);
  const d = f.draft;
  if (!d) return null;
  const fyShort = numbers.data?.fyShort ?? fyOf(todayISO()).short;
  const nextOf = (k: SequenceKey) => (numbers.data ? String(numbers.data.next[k]).padStart(4, '0') : '…');
  const problems: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const k of SEQUENCE_KEYS) {
    const p = d.prefixes[k] ?? '';
    if (!PREFIX_RE.test(p)) problems[k] = '1 to 8 letters or digits';
    else if (seen.has(p)) problems[k] = `Also used for ${seen.get(p)!.toLowerCase()}`;
    else seen.set(p, SEQUENCE_LABELS[k]);
  }
  const hasProblem = Object.keys(problems).length > 0;
  return (
    <form
      className="stack settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!hasProblem) void f.save('Billing settings saved');
      }}
    >
      <Card title="Bills">
        <div className="switch-list">
          <SwitchRow title="Round off bill totals" hint="Round each bill to the nearest rupee (₹1,332.75 → ₹1,333.00)">
            <Switch checked={d.roundOff} onChange={(v) => f.set('roundOff', v)} />
          </SwitchRow>
          <SwitchRow title="Default payment mode" hint="Selected when a new bill opens">
            <SegmentedControl<PaymentMode> size="sm" value={d.defaultPaymentMode} onChange={(v) => f.set('defaultPaymentMode', v)} options={PAYMENT_MODES.map((m) => ({ value: m, label: PAYMENT_MODE_LABELS[m] }))} />
          </SwitchRow>
          <SwitchRow title="Stop bills over the credit limit" hint="Refuse a credit bill that takes a customer over their credit limit. Customers without a credit limit can then buy on credit only after the owner (or a user allowed to set credit limits) gives them one.">
            <Switch checked={d.enforceCreditLimit} onChange={(v) => f.set('enforceCreditLimit', v)} />
          </SwitchRow>
        </div>
      </Card>
      <Card title="Document numbers" padded={false}>
        <div className="card-body" style={{ paddingBottom: 6 }}>
          <p className="muted mt-0 mb-0">
            Numbers restart every financial year (April to March). Each series needs its own short prefix; changing it affects only new documents.
          </p>
        </div>
        <div className="table-wrap">
          <table className="table prefix-table">
            <thead>
              <tr>
                <th>Series</th>
                <th>Prefix</th>
                <th>Next number</th>
              </tr>
            </thead>
            <tbody>
              {SEQUENCE_KEYS.map((k) => {
                const err = problems[k] ?? f.err(`prefixes.${k}`);
                return (
                  <tr key={k}>
                    <td>{SEQUENCE_LABELS[k]}</td>
                    <td>
                      <Field error={err}>
                        <TextInput
                          aria-label={`${SEQUENCE_LABELS[k]} prefix`}
                          value={d.prefixes[k] ?? ''}
                          maxLength={8}
                          onChange={(e) => f.set('prefixes', { ...d.prefixes, [k]: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })}
                        />
                      </Field>
                    </td>
                    <td className="prefix-example">{`${d.prefixes[k] || '???'}/${fyShort}/${nextOf(k)}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {f.error && <Alert tone="red">{f.error}</Alert>}
      <SaveBar dirty={f.dirty} saving={f.saving} onUndo={f.reset} disabled={hasProblem} />
    </form>
  );
}

const LOCK_PRESETS = [0, 5, 10, 15, 30, 60];

function SecurityTab({ settings, onSaved, onDirty }: TabProps<'security'>) {
  const { refresh } = useAuth();
  const f = useSectionForm('security', settings.security, onSaved);
  useEffect(() => onDirty(f.dirty), [f.dirty, onDirty]);
  const save = async () => {
    if (await f.save('Security settings saved')) await refresh();
  };
  useHotkeys({ 'ctrl+s': () => void save() }, [f.save]);
  const d = f.draft;
  if (!d) return null;
  const bad = d.autoLockMinutes < 0 || d.autoLockMinutes > 240 || !Number.isInteger(d.autoLockMinutes);
  return (
    <form
      className="stack settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!bad) void save();
      }}
    >
      <Card title="Lock the screen when nobody is using it">
        <div className="stack">
          <p className="muted mt-0 mb-0">After this many minutes without a key press or mouse movement, Billforce asks for the password again. Useful at a shared counter.</p>
          <div className="pill-list">
            {LOCK_PRESETS.map((m) => (
              <button type="button" key={m} className={`pill${d.autoLockMinutes === m ? ' active' : ''}`} onClick={() => f.set('autoLockMinutes', m)}>
                {m === 0 ? 'Never' : `${m} min`}
              </button>
            ))}
          </div>
          <FormGrid cols={3}>
            <Field label="Minutes (0 = never)" error={f.err('autoLockMinutes') ?? (bad ? 'Between 0 and 240 minutes' : null)}>
              <NumberInput value={d.autoLockMinutes} decimals={0} onChange={(v) => f.set('autoLockMinutes', v ?? 0)} />
            </Field>
          </FormGrid>
        </div>
      </Card>
      <Card title="Logins and passwords">
        <p className="muted mt-0 mb-0">
          Give every person their own login in <Link to="/admin/users">Users &amp; permissions</Link>, so the activity log shows who did what. After 5 wrong passwords a login is locked
          for a minute. The owner can reset anyone's password; the owner's own password can be reset with the recovery code.
        </p>
      </Card>
      {f.error && <Alert tone="red">{f.error}</Alert>}
      <SaveBar dirty={f.dirty} saving={f.saving} onUndo={f.reset} disabled={bad} />
    </form>
  );
}

function AboutTab() {
  const q = useQuery('settings.about', undefined);
  const toast = useToast();
  const open = async (path: string) => {
    try {
      await call('files.open', { path });
    } catch (e) {
      toast.error(e);
    }
  };
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  const a = q.data;
  return (
    <div className="stack settings-form">
      <Card title="Billforce">
        <KeyValues
          items={[
            ['Version', a.version],
            ['Set up on', a.setupAt ? formatDateTime(a.setupAt) : '—'],
            ['Books start', formatDate(a.booksStartDate)],
            ['Size of your data', formatBytes(a.dbSizeBytes)],
          ]}
        />
      </Card>
      <Card title="Where your data is kept">
        <div className="stack">
          <p className="muted mt-0 mb-0">Everything is stored on this computer only. Nothing is sent over the internet.</p>
          <div className="setting-line">
            <div>
              <div className="label">Data folder</div>
              <div className="path-text">{a.dataDir}</div>
            </div>
            <Button size="sm" icon={<FolderOpen size={15} />} onClick={() => void open(a.dataDir)}>
              Open
            </Button>
          </div>
          <div className="setting-line">
            <div>
              <div className="label">Backups folder</div>
              <div className="path-text">{a.backupFolder}</div>
            </div>
            <Button size="sm" icon={<FolderOpen size={15} />} onClick={() => void call('backup.openFolder').catch((e) => toast.error(e))}>
              Open
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab') as TabKey | null;
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? tabParam! : 'business';
  const q = useQuery('settings.get', undefined);
  const dialogs = useDialogs();
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  useUnsavedWarning(dirty);
  const onDirty = useCallback((d: boolean) => setDirty(d), []);

  const change = async (k: string) => {
    if (k === tab) return;
    if (dirtyRef.current) {
      const ok = await dialogs.confirm({ title: 'Leave without saving?', message: 'Your changes on this tab have not been saved.', confirmText: 'Discard changes', danger: true });
      if (!ok) return;
    }
    setDirty(false);
    setParams({ tab: k }, { replace: true });
  };

  const saved = <K extends keyof AppSettings>(section: K) => (v: AppSettings[K]) => q.data && q.setData({ ...q.data, [section]: v });

  return (
    <Page wide>
      <PageHeader title="Business settings" subtitle="Your business details, receipts, bill numbers and security" />
      <Tabs tabs={TABS} value={tab} onChange={(k) => void change(k)} />
      {q.error ? (
        <ErrorBox error={q.error} onRetry={q.reload} />
      ) : !q.data ? (
        <Loading />
      ) : tab === 'business' ? (
        <BusinessTab settings={q.data} onSaved={saved('business')} onDirty={onDirty} />
      ) : tab === 'receipt' ? (
        <ReceiptTab settings={q.data} onSaved={saved('receipt')} onDirty={onDirty} />
      ) : tab === 'billing' ? (
        <BillingTab settings={q.data} onSaved={saved('billing')} onDirty={onDirty} />
      ) : tab === 'security' ? (
        <SecurityTab settings={q.data} onSaved={saved('security')} onDirty={onDirty} />
      ) : (
        <AboutTab />
      )}
    </Page>
  );
}

