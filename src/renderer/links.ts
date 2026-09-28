import { useNavigate } from 'react-router';

export interface AppLink {
  kind: string;
  id: number | string;
}

/** App path for a document / record link (used by report rows, activity log, journal view). */
export function linkPath(link: AppLink): string {
  switch (link.kind) {
    case 'bill':
      return `/sales/bills/${link.id}`;
    case 'credit_note':
      return `/sales/returns/${link.id}`;
    case 'receipt':
      return `/customers/receipts/${link.id}`;
    case 'purchase':
      return `/purchases/${link.id}`;
    case 'supplier_payment':
      return `/purchases/payments/${link.id}`;
    case 'expense':
      return `/accounts/expenses/${link.id}`;
    case 'journal':
      return `/accounts/journals/${link.id}`;
    case 'salary':
      return `/employees/salary/${link.id}`;
    case 'advance':
      return `/employees/advances?id=${link.id}`;
    case 'customer':
      return `/customers/${link.id}`;
    case 'supplier':
      return `/suppliers/${link.id}`;
    case 'employee':
      return `/employees/${link.id}`;
    case 'account':
      return `/accounts/ledger?account=${link.id}`;
    case 'loan':
      return `/accounts/loans/${link.id}`;
    default:
      return '/';
  }
}

/** Returns a function that opens a link (e.g. <ReportView onLink={useOpenLink()} />). */
export function useOpenLink(): (link: AppLink) => void {
  const navigate = useNavigate();
  return (link) => navigate(linkPath(link));
}
