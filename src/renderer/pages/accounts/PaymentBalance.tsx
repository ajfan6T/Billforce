/**
 * The balance of the cash / bank account a payment is made from, shown next to
 * "Paid from" before saving, and a question before money is paid out that the
 * books say is not there. Used by the expense, drawings, salary and advance forms.
 */
import { useCallback, useRef } from 'react';
import { useQuery } from '../../hooks';
import { useDialogs } from '../../feedback';
import { call, type ApiInput } from '../../api';
import { formatINR } from '../../../shared/money';
import { formatDate, todayISO } from '../../../shared/dates';
import type { PaymentMode } from '../../../shared/constants';
import './accounts.css';

export interface PaymentToCheck {
  /** 'credit' (nothing paid now) is never checked. */
  mode: PaymentMode;
  accountId: number | null;
  amount: number | null;
  date?: string | null;
  /** The saved ledger entry of the document being edited (left out of the balance). */
  entryId?: number | null;
}

function checkInput(p: PaymentToCheck | null): ApiInput<'accounts.paymentCheck'> | null {
  if (!p || p.mode === 'credit') return null;
  return { mode: p.mode, accountId: p.accountId, amount: p.amount ?? 0, date: p.date || todayISO(), entryId: p.entryId ?? null };
}

/** "Cash in Hand on 28-09-2026: ₹8,000.00", in red with the shortfall when the payment is more than that. */
export function PaymentBalanceHint({ payment }: { payment: PaymentToCheck | null }) {
  const input = checkInput(payment);
  const q = useQuery('accounts.paymentCheck', input);
  const d = input ? q.data : undefined;
  if (!d || (d.balance === null && !d.warning)) return null;
  return (
    <div className={`ac-pay-balance small${d.warning ? ' short' : ''}`} role={d.warning ? 'alert' : undefined} data-testid="payment-balance">
      {d.balance !== null && (
        <span>
          {d.accountName} on {formatDate(d.date)}: <b className="money">{formatINR(d.balance)}</b>
        </span>
      )}
      {d.warning && <span className="ac-pay-short">{d.warning}</span>}
    </div>
  );
}

/**
 * Ask before a payment takes a cash / bank account below zero. Resolves with the
 * warnings the user accepted (so the form does not repeat them after saving),
 * or null when the user chose not to save.
 */
export function useShortfallConfirm(): (p: PaymentToCheck | null) => Promise<string[] | null> {
  const dialogs = useDialogs();
  // A second Enter while the question is open must not start another save.
  const asking = useRef(false);
  return useCallback(
    async (p: PaymentToCheck | null) => {
      if (asking.current) return null;
      const input = checkInput(p);
      if (!input || !input.amount) return [];
      asking.current = true;
      try {
        let warning: string | null = null;
        try {
          warning = (await call('accounts.paymentCheck', input)).warning;
        } catch {
          return []; // The save itself reports any problem.
        }
        if (!warning) return [];
        const ok = await dialogs.confirm({
          title: 'Not enough money in the account',
          message: `${warning} Save anyway?`,
          confirmText: 'Save anyway',
        });
        return ok ? [warning] : null;
      } finally {
        asking.current = false;
      }
    },
    [dialogs],
  );
}
