import { useCallback } from 'react';
import { call } from '../../api';
import { useToast } from '../../feedback';
import { Alert, Badge, Button, LinkButton, type Tone } from '../../components/ui';
import { BILL_PAYMENT_MODE_LABELS, type BillPaymentMode } from '../../../shared/billing';
import { PAYMENT_MODE_LABELS, type PaymentMode } from '../../../shared/constants';
import { formatQty, parseMoney } from '../../../shared/money';
import './sales.css';

const MODE_TONE: Record<BillPaymentMode, Tone> = { cash: 'green', upi: 'purple', bank: 'blue', credit: 'amber', split: 'neutral' };

export function ModeBadge({ mode }: { mode: BillPaymentMode }) {
  return <Badge tone={MODE_TONE[mode]}>{BILL_PAYMENT_MODE_LABELS[mode]}</Badge>;
}

export function RefundBadge({ mode }: { mode: PaymentMode }) {
  return mode === 'credit' ? <Badge tone="amber">Adjusted in account</Badge> : <Badge tone={MODE_TONE[mode]}>{PAYMENT_MODE_LABELS[mode]} refund</Badge>;
}

export function StatusBadge({ status }: { status: 'active' | 'cancelled' }) {
  return status === 'cancelled' ? <Badge tone="red">Cancelled</Badge> : <Badge tone="green">Active</Badge>;
}

/** A page that could not be opened (not found, not allowed, ...). */
export function LoadError({ title, error, back, backLabel = 'Back', onRetry }: { title: string; error: string; back: string; backLabel?: string; onRetry?: () => void }) {
  return (
    <Alert tone="amber" title={title}>
      {error}
      <div className="row mt-1">
        <LinkButton to={back} size="sm">
          {backLabel}
        </LinkButton>
        {onRetry && (
          <Button size="sm" variant="ghost" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    </Alert>
  );
}

export function qtyUnit(qty: number, unit: string | null | undefined): string {
  return `${formatQty(qty)}${unit ? ` ${unit}` : ''}`;
}

/** Print a bill or a return on the receipt printer with a toast for the result. */
export function usePrintDoc() {
  const toast = useToast();
  return useCallback(
    /** quiet: only tell the user when printing did not work. */
    async (kind: 'bill' | 'return', id: number, opts: { quiet?: boolean } = {}): Promise<boolean> => {
      try {
        const r = kind === 'bill' ? await call('sales.print', { id }) : await call('returns.print', { id });
        if (r.printed) {
          if (!opts.quiet) toast.success(r.message);
        } else toast.warning(r.message);
        return r.printed;
      } catch (e) {
        toast.error(e);
        return false;
      }
    },
    [toast],
  );
}

/** Line discount typed as "10%" (percentage) or "25" (rupees). */
export interface DiscountValue {
  discount: number | null;
  discountPct: number | null;
  valid: boolean;
}

export function parseDiscountText(text: string): DiscountValue {
  const t = text.trim();
  if (!t) return { discount: null, discountPct: null, valid: true };
  if (t.endsWith('%')) {
    const n = Number(t.slice(0, -1).trim());
    if (!Number.isFinite(n) || n < 0 || n > 100) return { discount: null, discountPct: null, valid: false };
    return { discount: null, discountPct: n || null, valid: true };
  }
  const p = parseMoney(t);
  if (p === null || p < 0) return { discount: null, discountPct: null, valid: false };
  return { discount: p || null, discountPct: null, valid: true };
}

export function discountToText(discount: number | null | undefined, discountPct: number | null | undefined): string {
  if (discountPct) return `${formatQty(discountPct)}%`;
  if (discount) return String(discount / 100);
  return '';
}

/**
 * Quick entry in the item search box: "2*sugar", "2 x sugar", "1.5x rice".
 * Returns the quantity (default 1) and the text to search for.
 */
export function parseQuickEntry(text: string): { qty: number; name: string; hasQty: boolean } {
  const m = /^\s*(\d+(?:\.\d{1,3})?)\s*[*xX×]\s*(\D.*)$/.exec(text);
  if (m) {
    const qty = Number(m[1]);
    if (qty > 0) return { qty, name: m[2].trim(), hasQty: true };
  }
  return { qty: 1, name: text.trim(), hasQty: false };
}
