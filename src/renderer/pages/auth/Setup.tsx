import { useState } from 'react';
import { Building2, Check, KeyRound, Wallet, ShieldCheck, Copy } from 'lucide-react';
import { Button, Alert } from '../../components/ui';
import { DateInput, Field, FormGrid, MoneyInput, TextArea, TextInput, Checkbox } from '../../components/forms';
import { useMutation } from '../../hooks';
import { useAuth } from '../../auth';
import { fyOf, formatDate, todayISO } from '../../../shared/dates';

const STEPS = [
  { key: 'business', label: 'Your business', icon: Building2 },
  { key: 'owner', label: 'Owner login', icon: KeyRound },
  { key: 'books', label: 'Opening balances', icon: Wallet },
] as const;

/** First-run wizard: business details, owner account, books start date and opening balances. */
export function SetupWizard() {
  const { refresh } = useAuth();
  const [step, setStep] = useState(0);
  const [business, setBusiness] = useState({ name: '', address: '', phone: '', email: '' });
  const [owner, setOwner] = useState({ fullName: '', username: 'owner', password: '', confirm: '' });
  const today = todayISO();
  const [booksStartDate, setBooksStart] = useState(fyOf(today).start);
  const [openingCash, setCash] = useState<number | null>(null);
  const [openingBank, setBank] = useState<number | null>(null);
  const [openingUpi, setUpi] = useState<number | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [savedCode, setSavedCode] = useState(false);
  const m = useMutation('setup.complete');

  const ownerProblem =
    !owner.fullName.trim()
      ? 'Enter your name'
      : !/^[A-Za-z0-9._-]{2,40}$/.test(owner.username)
        ? 'Username: letters, numbers, dot, dash or underscore (2+ characters)'
        : owner.password.length < 4
          ? 'Password must be at least 4 characters'
          : owner.password !== owner.confirm
            ? 'Passwords do not match'
            : null;

  const finish = async () => {
    try {
      const res = await m.run({
        business: { name: business.name, address: business.address, phone: business.phone, email: business.email },
        owner: { fullName: owner.fullName, username: owner.username, password: owner.password },
        booksStartDate,
        openingCash: openingCash ?? 0,
        openingBank: openingBank ?? 0,
        openingUpi: openingUpi ?? 0,
      });
      setRecoveryCode(res.recoveryCode);
    } catch {
      /* error shown */
    }
  };

  if (recoveryCode) {
    return (
      <div className="auth-screen">
        <div className="auth-card wide">
          <div className="auth-icon ok">
            <ShieldCheck size={30} />
          </div>
          <h1>Billforce is ready</h1>
          <p className="muted">
            Write down this <b>recovery code</b> and keep it somewhere safe. If you ever forget the owner password, you can use it to set a new one. It will
            not be shown again.
          </p>
          <div className="recovery-code">
            {recoveryCode}
            <button className="icon-btn" title="Copy" onClick={() => navigator.clipboard?.writeText(recoveryCode)}>
              <Copy size={16} />
            </button>
          </div>
          <Checkbox checked={savedCode} onChange={setSavedCode} label="I have written down the recovery code" />
          <Button variant="primary" size="lg" block disabled={!savedCode} onClick={() => void refresh()}>
            Start using Billforce
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card wide">
        <div className="setup-brand">
          <div className="brand-mark big">₹</div>
          <div>
            <h1>Welcome to Billforce</h1>
            <p className="muted">Let's set up your business. This takes about a minute. Everything stays on this computer.</p>
          </div>
        </div>
        <ol className="steps">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            return (
              <li key={s.key} className={i === step ? 'active' : i < step ? 'done' : ''}>
                <span className="step-dot">{i < step ? <Check size={14} /> : <Icon size={14} />}</span>
                {s.label}
              </li>
            );
          })}
        </ol>

        {step === 0 && (
          <div className="stack">
            <Field label="Business name" required hint="Printed at the top of every bill">
              <TextInput autoFocus value={business.name} onChange={(e) => setBusiness({ ...business, name: e.target.value })} placeholder="e.g. Sharma General Store" />
            </Field>
            <Field label="Address">
              <TextArea rows={2} value={business.address} onChange={(e) => setBusiness({ ...business, address: e.target.value })} placeholder="Shop no, street, city, PIN" />
            </Field>
            <FormGrid>
              <Field label="Phone">
                <TextInput value={business.phone} onChange={(e) => setBusiness({ ...business, phone: e.target.value })} placeholder="98xxxxxxxx" />
              </Field>
              <Field label="Email (optional)">
                <TextInput value={business.email} onChange={(e) => setBusiness({ ...business, email: e.target.value })} />
              </Field>
            </FormGrid>
            <div className="auth-actions">
              <span />
              <Button variant="primary" size="lg" disabled={!business.name.trim()} onClick={() => setStep(1)}>
                Next
              </Button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="stack">
            <Alert tone="blue">You are the <b>Owner</b>: you can see everything and add Manager and Cashier logins later.</Alert>
            <FormGrid>
              <Field label="Your name" required>
                <TextInput autoFocus value={owner.fullName} onChange={(e) => setOwner({ ...owner, fullName: e.target.value })} />
              </Field>
              <Field label="Username" required hint="Used to log in">
                <TextInput value={owner.username} onChange={(e) => setOwner({ ...owner, username: e.target.value.trim() })} />
              </Field>
              <Field label="Password" required hint="At least 4 characters">
                <TextInput type="password" value={owner.password} onChange={(e) => setOwner({ ...owner, password: e.target.value })} />
              </Field>
              <Field label="Confirm password" required>
                <TextInput type="password" value={owner.confirm} onChange={(e) => setOwner({ ...owner, confirm: e.target.value })} />
              </Field>
            </FormGrid>
            {owner.confirm && ownerProblem && <div className="field-error">{ownerProblem}</div>}
            <div className="auth-actions">
              <Button variant="ghost" onClick={() => setStep(0)}>
                Back
              </Button>
              <Button variant="primary" size="lg" disabled={!!ownerProblem} onClick={() => setStep(2)}>
                Next
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="stack">
            <Field label="Start date for your accounts" hint={`Bills and entries can be recorded from this date. Financial year ${fyOf(booksStartDate || today).name}.`}>
              <DateInput value={booksStartDate} onChange={setBooksStart} max={today} />
            </Field>
            <p className="muted small">Money you already have on {booksStartDate ? formatDate(booksStartDate) : 'that date'} (leave blank if none). Customer and supplier balances can be added when you create them.</p>
            <FormGrid cols={3}>
              <Field label="Cash in hand">
                <MoneyInput value={openingCash} onChange={setCash} />
              </Field>
              <Field label="Bank account balance">
                <MoneyInput value={openingBank} onChange={setBank} />
              </Field>
              <Field label="UPI account balance" hint="If UPI money goes to a separate account">
                <MoneyInput value={openingUpi} onChange={setUpi} />
              </Field>
            </FormGrid>
            {m.error && <Alert tone="red">{m.error}</Alert>}
            <div className="auth-actions">
              <Button variant="ghost" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button variant="primary" size="lg" loading={m.loading} disabled={!booksStartDate} onClick={finish}>
                Finish setup
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
