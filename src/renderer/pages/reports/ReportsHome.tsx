import type { ReactNode } from 'react';
import { Link } from 'react-router';
import {
  ArrowRight,
  BookOpen,
  CalendarClock,
  ChartColumn,
  Hourglass,
  Landmark,
  NotebookText,
  Scale,
  ScrollText,
  TrendingUp,
  Wallet,
  Waves,
  type LucideIcon,
} from 'lucide-react';
import { Page, PageHeader } from '../../components/ui';
import { useAuth, useFeatures, type Features } from '../../auth';
import type { Permission } from '../../../shared/permissions';
import './reports.css';

interface ReportCard {
  to: string;
  title: string;
  description: string;
  icon: LucideIcon;
  perm: Permission | Permission[];
  /** Shown only for businesses using this optional feature. */
  feature?: (f: Features) => boolean;
}

interface ReportGroup {
  title: string;
  description: string;
  cards: ReportCard[];
}

const GROUPS: ReportGroup[] = [
  {
    title: 'Financial statements',
    description: 'Straight from your books, so they always agree with your accounts.',
    cards: [
      { to: '/reports/profit-loss', title: 'Profit & loss', description: 'Sales, purchases and expenses, and what you earned. Compare with an earlier period.', icon: TrendingUp, perm: 'reports.financial' },
      { to: '/reports/balance-sheet', title: 'Balance sheet', description: 'What the business owns and owes on any date: capital, loans, cash, bank, dues.', icon: Scale, perm: 'reports.financial' },
      { to: '/reports/trial-balance', title: 'Trial balance', description: 'Every account with opening, debit, credit and closing balances. For your accountant.', icon: ScrollText, perm: 'reports.financial' },
      { to: '/reports/cash-flow', title: 'Cash flow', description: 'Where your cash and bank money came from and where it went.', icon: Waves, perm: 'reports.financial' },
    ],
  },
  {
    title: 'Sales',
    description: 'How the counter is doing.',
    cards: [
      { to: '/reports/sales?tab=day', title: 'Sales by day', description: 'Bills, discounts, returns and net sales after discounts for each day.', icon: ChartColumn, perm: 'reports.sales' },
      { to: '/reports/sales?tab=month', title: 'Sales by month', description: 'Month-wise sales through the financial year.', icon: CalendarClock, perm: 'reports.sales' },
      { to: '/reports/sales?tab=item', title: 'Sales by item', description: 'Best-selling items, quantities sold and returned.', icon: NotebookText, perm: 'reports.sales' },
      { to: '/reports/sales?tab=customer', title: 'Sales by customer', description: 'Your best customers; walk-in sales grouped together.', icon: BookOpen, perm: 'reports.sales' },
      { to: '/reports/sales?tab=mode', title: 'Sales by payment mode', description: 'Cash, UPI, bank and credit received at billing.', icon: Wallet, perm: 'reports.sales' },
    ],
  },
  {
    title: 'GST',
    description: 'Summaries for filing your GST returns.',
    cards: [
      { to: '/reports/gst?tab=summary', title: 'GST summary', description: 'Tax collected, input tax credit and tax payable (GSTR-3B).', icon: Landmark, perm: 'reports.financial', feature: (f) => f.gst === 'regular' },
      { to: '/reports/gst?tab=sales', title: 'GST sales register', description: 'Every tax invoice and credit note, B2B and B2C (GSTR-1).', icon: ScrollText, perm: 'reports.financial', feature: (f) => f.gst === 'regular' },
      { to: '/reports/gst?tab=hsn', title: 'HSN summary', description: 'Sales by HSN code and GST rate.', icon: NotebookText, perm: 'reports.financial', feature: (f) => f.gst === 'regular' },
      { to: '/reports/gst?tab=purchases', title: 'GST purchase register', description: 'Purchases with GST and the credit claimed.', icon: BookOpen, perm: 'reports.financial', feature: (f) => f.gst === 'regular' },
      { to: '/reports/gst', title: 'Composition scheme', description: 'Turnover and the composition tax to pay each quarter (CMP-08).', icon: Landmark, perm: 'reports.financial', feature: (f) => f.gst === 'composition' },
    ],
  },
  {
    title: 'Receivables & payables',
    description: 'Money to collect and money to pay, by how old it is.',
    cards: [
      { to: '/reports/receivables-ageing', title: 'Receivables ageing', description: 'Who owes you, split into 0-30, 31-60, 61-90 and over 90 days.', icon: Hourglass, perm: ['reports.financial', 'customers.view'] },
      { to: '/reports/payables-ageing', title: 'Payables ageing', description: 'Whom you owe, by age, so you can plan payments.', icon: Hourglass, perm: ['reports.financial', 'suppliers.view'] },
    ],
  },
  {
    title: 'Books',
    description: 'Day-to-day registers of every entry.',
    cards: [
      { to: '/accounts/cash-book', title: 'Cash book', description: 'Cash in and out, day by day, with running balance.', icon: Wallet, perm: 'accounts.view' },
      { to: '/accounts/bank-book', title: 'Bank & UPI book', description: 'Money in and out of your bank and UPI accounts.', icon: Landmark, perm: 'accounts.view' },
      { to: '/accounts/day-book', title: 'Day book', description: 'Every voucher entered, in date order.', icon: BookOpen, perm: 'accounts.view' },
      { to: '/accounts/ledger', title: 'Ledgers', description: 'The full account of any customer, supplier, employee or account.', icon: ScrollText, perm: 'accounts.view' },
    ],
  },
];

function Card({ card }: { card: ReportCard }): ReactNode {
  const Icon = card.icon;
  return (
    <Link to={card.to} className="rp-home-card">
      <span className="rp-home-icon">
        <Icon size={18} />
      </span>
      <span className="rp-home-text">
        <span className="rp-home-title">
          {card.title}
          <ArrowRight size={14} className="rp-home-arrow" aria-hidden />
        </span>
        <span className="rp-home-desc">{card.description}</span>
      </span>
    </Link>
  );
}

export function ReportsHomePage() {
  const { can, canAny } = useAuth();
  const features = useFeatures();
  const allowed = (p: Permission | Permission[]) => (Array.isArray(p) ? canAny(p) : can(p));
  const groups = GROUPS.map((g) => ({ ...g, cards: g.cards.filter((c) => allowed(c.perm) && (!c.feature || c.feature(features))) })).filter((g) => g.cards.length);
  return (
    <Page wide>
      <PageHeader title="Reports" subtitle="Every report has a date filter and can be saved as Excel, CSV or PDF, or printed." />
      {groups.map((g) => (
        <section key={g.title} className="rp-home-group">
          <div className="rp-home-head">
            <h2>{g.title}</h2>
            <span>{g.description}</span>
          </div>
          <div className="rp-home-grid">
            {g.cards.map((c) => (
              <Card key={c.to} card={c} />
            ))}
          </div>
        </section>
      ))}
    </Page>
  );
}
