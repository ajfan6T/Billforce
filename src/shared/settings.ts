import { DEFAULT_PREFIXES, type PaymentMode, type SequenceKey } from './constants';
import type { GstRegistration } from './gst';

export interface BusinessSettings {
  name: string;
  address: string;
  phone: string;
  email: string;
  /** UPI ID (VPA) such as shopname@okbank, used for the payment QR on receipts. */
  upiId: string;
  /** Payee name shown in UPI apps; defaults to business name. */
  upiName: string;
}

export interface ReceiptSettings {
  /** Extra lines printed under the business details (e.g. tagline, timings). */
  header: string;
  /** Lines printed at the end of the receipt (e.g. "Thank you! Visit again"). */
  footer: string;
  paperWidth: 80 | 58;
  fontSize: 'small' | 'normal' | 'large';
  /** Windows printer name. Empty = ask every time (system print dialog). */
  printerName: string;
  copies: number;
  /** Print the receipt automatically when a bill is saved. */
  autoPrint: boolean;
  showCustomer: boolean;
  showCashier: boolean;
  showAmountInWords: boolean;
  /** When to print a UPI QR code for the bill amount. */
  upiQr: 'never' | 'unpaid' | 'always';
  /** Label reprinted receipts as "DUPLICATE". */
  markDuplicate: boolean;
}

export interface BillingSettings {
  /** Round bill totals to the nearest rupee. */
  roundOff: boolean;
  defaultPaymentMode: PaymentMode;
  prefixes: Record<SequenceKey, string>;
  /** Warn when a customer's balance would exceed their credit limit. */
  enforceCreditLimit: boolean;
}

export interface AccountSettings {
  /** First date for which transactions can be entered; opening balances are dated this day. */
  booksStartDate: string;
  /** Default account used for "Cash" payments. */
  cashAccountId: number | null;
  /** Default account used for "UPI" payments. */
  upiAccountId: number | null;
  /** Default account used for "Bank" payments. */
  bankAccountId: number | null;
}

export interface BackupSettings {
  autoBackup: boolean;
  /** Folder for backups. Empty = Documents\Billforce Backups. */
  folder: string;
  /** Number of automatic backups to keep. */
  keepCount: number;
  lastAutoBackupAt: string | null;
  lastBackupAt: string | null;
  lastBackupPath: string | null;
}

export interface SecuritySettings {
  /** Lock the screen after this many idle minutes. 0 = never. */
  autoLockMinutes: number;
}

export interface GstSettings {
  /** Unregistered businesses bill exactly as before: no GST anywhere. */
  registration: GstRegistration;
  /** The business's GSTIN; its first two digits are the state of the business. */
  gstin: string;
  /** Item rates include GST (tax is taken out of the price) instead of being added on top. */
  ratesIncludeGst: boolean;
  /** GST rate (percent) for new items and one-time lines. */
  defaultRate: number;
  /** Composition scheme: tax rate on turnover (percent). */
  compositionRate: number;
}

export interface StockSettings {
  /** Track stock: bills take goods out, purchases and returns bring them in (off = as before, no stock screens). */
  enabled: boolean;
}

export interface MenuSettings {
  /** Restaurant menu: dishes with recipes; with stock on, selling a dish takes its ingredients out of stock. */
  enabled: boolean;
}

export interface AppSettings {
  business: BusinessSettings;
  gst: GstSettings;
  stock: StockSettings;
  menu: MenuSettings;
  receipt: ReceiptSettings;
  billing: BillingSettings;
  accounts: AccountSettings;
  backup: BackupSettings;
  security: SecuritySettings;
}

export type SettingsSection = keyof AppSettings;

export function defaultSettings(today: string): AppSettings {
  return {
    business: { name: '', address: '', phone: '', email: '', upiId: '', upiName: '' },
    gst: { registration: 'unregistered', gstin: '', ratesIncludeGst: true, defaultRate: 18, compositionRate: 1 },
    stock: { enabled: false },
    menu: { enabled: false },
    receipt: {
      header: '',
      footer: 'Thank you! Visit again.',
      paperWidth: 80,
      fontSize: 'normal',
      printerName: '',
      copies: 1,
      autoPrint: true,
      showCustomer: true,
      showCashier: true,
      showAmountInWords: false,
      upiQr: 'never',
      markDuplicate: true,
    },
    billing: {
      roundOff: true,
      defaultPaymentMode: 'cash',
      prefixes: { ...DEFAULT_PREFIXES },
      enforceCreditLimit: false,
    },
    accounts: { booksStartDate: today, cashAccountId: null, upiAccountId: null, bankAccountId: null },
    backup: { autoBackup: true, folder: '', keepCount: 30, lastAutoBackupAt: null, lastBackupAt: null, lastBackupPath: null },
    security: { autoLockMinutes: 0 },
  };
}
