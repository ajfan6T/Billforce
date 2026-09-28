import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Loader2 } from 'lucide-react';
import { formatDrCr, formatINR } from '../../shared/money';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'link';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  loading?: boolean;
  /** Keyboard shortcut hint shown in the button, e.g. "F9". */
  kbd?: string;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, kbd, block, className = '', children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`btn btn-${variant} btn-${size}${block ? ' btn-block' : ''} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="spin" size={16} /> : icon}
      {children && <span>{children}</span>}
      {kbd && <kbd>{kbd}</kbd>}
    </button>
  );
});

export function IconButton({ label, icon, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: ReactNode }) {
  return (
    <button type="button" className={`icon-btn ${className}`} title={label} aria-label={label} {...rest}>
      {icon}
    </button>
  );
}

export function LinkButton({ to, children, icon, variant = 'secondary', size = 'md' }: { to: string; children?: ReactNode; icon?: ReactNode; variant?: ButtonVariant; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <Link to={to} className={`btn btn-${variant} btn-${size}`}>
      {icon}
      {children && <span>{children}</span>}
    </Link>
  );
}

export function Spinner({ size = 20, label }: { size?: number; label?: string }) {
  return (
    <span className="spinner" role="status">
      <Loader2 className="spin" size={size} />
      {label && <span>{label}</span>}
    </span>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading-block">
      <Spinner label={label} />
    </div>
  );
}

export function Card({ title, actions, children, className = '', padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-header">
          {title && <h3 className="card-title">{title}</h3>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'card-body' : ''}>{children}</div>
    </section>
  );
}

export type Tone = 'neutral' | 'blue' | 'green' | 'red' | 'amber' | 'purple';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: string }) {
  return (
    <div className="page-header">
      <div>
        {back && (
          <Link to={back} className="back-link">
            ← Back
          </Link>
        )}
        <h1 className="page-title">{title}</h1>
        {subtitle && <div className="page-subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

/** Standard page wrapper: header + content with consistent padding. */
export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={`page${wide ? ' page-wide' : ''}`}>{children}</div>;
}

export function Toolbar({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`toolbar ${className}`}>{children}</div>;
}

export function EmptyState({ icon, title, message, action }: { icon?: ReactNode; title: string; message?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {message && <div className="empty-msg">{message}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Alert({ tone = 'blue', title, children, icon }: { tone?: Tone; title?: ReactNode; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'red' ? 'alert' : undefined}>
      {icon}
      <div>
        {title && <div className="alert-title">{title}</div>}
        {children && <div className="alert-body">{children}</div>}
      </div>
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <Alert tone="red" title="Something went wrong">
      {error}
      {onRetry && (
        <div style={{ marginTop: 8 }}>
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </Alert>
  );
}

export interface TabItem {
  key: string;
  label: ReactNode;
  count?: number;
}

export function Tabs({ tabs, value, onChange }: { tabs: TabItem[]; value: string; onChange: (key: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" type="button" aria-selected={value === t.key} className={`tab${value === t.key ? ' active' : ''}`} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** A key figure: label + big value (+ optional hint), used on dashboards and summaries. */
export function Stat({ label, value, hint, tone, icon, onClick }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: Tone; icon?: ReactNode; onClick?: () => void }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ''}${onClick ? ' clickable' : ''}`} onClick={onClick} role={onClick ? 'button' : undefined}>
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        {icon && <span className="stat-icon">{icon}</span>}
      </div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="stat-grid">{children}</div>;
}

/** Money in paise, formatted ₹1,23,456.00; negative values in red. */
export function Money({ value, symbol = true, colored = false, className = '' }: { value: number | null | undefined; symbol?: boolean; colored?: boolean; className?: string }) {
  const v = value ?? 0;
  const tone = colored ? (v < 0 ? ' neg' : v > 0 ? ' pos' : '') : v < 0 ? ' neg' : '';
  return <span className={`money${tone} ${className}`}>{formatINR(v, { symbol })}</span>;
}

/** Ledger balance with Dr / Cr. */
export function DrCr({ value }: { value: number }) {
  return <span className="money">{formatDrCr(value)}</span>;
}

/** Label / value list for detail panels. */
export function KeyValues({ items, columns = 2 }: { items: Array<[ReactNode, ReactNode] | null | false>; columns?: number }) {
  return (
    <dl className="kv" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {items.filter(Boolean).map((it, i) => {
        const [k, v] = it as [ReactNode, ReactNode];
        return (
          <div key={i} className="kv-item">
            <dt>{k}</dt>
            <dd>{v === null || v === undefined || v === '' ? '—' : v}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

export function Divider() {
  return <hr className="divider" />;
}
