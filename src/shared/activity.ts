/**
 * Human-readable labels for activity-log actions ("bill.create" -> "Created bill")
 * and the module groups used to filter the activity log. Unknown actions fall
 * back to a readable version of the key, so new modules never show raw codes.
 */

export const ACTIVITY_LABELS: Record<string, string> = {
  // Setup, login & users
  'setup.complete': 'Set up Billforce',
  'user.login': 'Logged in',
  'user.logout': 'Logged out',
  'user.login_failed': 'Failed login',
  'user.change_password': 'Changed own password',
  'user.recovered': 'Reset owner password with recovery code',
  'user.recovery_failed': 'Wrong recovery code entered',
  'user.recovery_regenerated': 'Generated new recovery code',
  'user.create': 'Added user',
  'user.update': 'Updated user',
  'user.activate': 'Re-activated user',
  'user.deactivate': 'Deactivated user',
  'user.reset_password': 'Reset user password',
  'role.update': 'Changed role permissions',

  // Sales & billing
  'bill.create': 'Created bill',
  'bill.edit': 'Edited bill',
  'bill.cancel': 'Cancelled bill',
  'bill.print': 'Printed bill',
  'bill.reprint': 'Reprinted bill',
  'return.create': 'Recorded sales return',
  'return.cancel': 'Cancelled sales return',
  'credit_note.create': 'Issued credit note',
  'credit_note.cancel': 'Cancelled credit note',
  'credit_note.print': 'Printed credit note',
  'credit_note.reprint': 'Reprinted credit note',
  'item.create': 'Added item',
  'item.update': 'Updated item',
  'item.delete': 'Deleted item',
  'item.activate': 'Re-activated item',
  'item.deactivate': 'Deactivated item',

  // Customers
  'customer.create': 'Added customer',
  'customer.update': 'Updated customer',
  'customer.delete': 'Deleted customer',
  'customer.activate': 'Re-activated customer',
  'customer.deactivate': 'Deactivated customer',
  'receipt.create': 'Payment received',
  'receipt.update': 'Edited payment received',
  'receipt.cancel': 'Cancelled payment received',
  'receipt.print': 'Printed payment receipt',

  // Suppliers & purchases
  'supplier.create': 'Added supplier',
  'supplier.update': 'Updated supplier',
  'supplier.delete': 'Deleted supplier',
  'supplier.activate': 'Re-activated supplier',
  'supplier.deactivate': 'Deactivated supplier',
  'purchase.create': 'Entered purchase bill',
  'purchase.update': 'Edited purchase bill',
  'purchase.cancel': 'Cancelled purchase bill',
  'supplier_payment.create': 'Paid supplier',
  'supplier_payment.update': 'Edited supplier payment',
  'supplier_payment.cancel': 'Cancelled supplier payment',
  'supplier_payment.print': 'Printed supplier payment',

  // Accounts
  'expense.create': 'Recorded expense',
  'expense.update': 'Edited expense',
  'expense.cancel': 'Cancelled expense',
  'journal.create': 'Entered journal voucher',
  'journal.update': 'Edited journal voucher',
  'journal.cancel': 'Cancelled journal voucher',
  'capital.add': 'Capital introduced',
  'drawings.add': 'Recorded drawings',
  'transfer.create': 'Cash / bank transfer',
  'loan.create': 'Added loan',
  'loan.update': 'Updated loan',
  'loan.transaction': 'Loan transaction',
  'loan.transaction_edit': 'Edited loan transaction',
  'loan.transaction_cancel': 'Cancelled loan transaction',
  'account.create': 'Added account',
  'account.update': 'Updated account',
  'account.delete': 'Deleted account',
  'account.activate': 'Re-activated account',
  'account.deactivate': 'Deactivated account',
  'account.payment_defaults': 'Changed default payment accounts',
  'year.close': 'Closed financial year',
  'year.reopen': 'Re-opened financial year',

  // Employees
  'employee.create': 'Added employee',
  'employee.update': 'Updated employee',
  'employee.activate': 'Re-activated employee',
  'employee.leave': 'Marked employee as left',
  'attendance.mark': 'Marked attendance',
  'attendance.clear': 'Cleared attendance',
  'salary.process': 'Processed salary',
  'salary.update': 'Edited salary slip',
  'salary.cancel': 'Cancelled salary slip',
  'salary.pay': 'Paid salary',
  'salary.payment_cancel': 'Cancelled salary payment',
  'salary.print': 'Printed salary slip',
  'advance.create': 'Gave advance',
  'advance.cancel': 'Cancelled advance',

  // Settings & data
  'settings.update': 'Changed settings',
  'backup.create': 'Backed up data',
  'backup.auto': 'Automatic backup',
  'backup.copy': 'Saved a backup copy',
  'backup.folder': 'Changed backup folder',
  'backup.failed': 'Backup failed',
  'backup.restore': 'Restored data from backup',
  'import.items': 'Imported items',
  'import.customers': 'Imported customers',
  'import.suppliers': 'Imported suppliers',
  'import.employees': 'Imported employees',
  'report.export': 'Exported report',
};

const VERBS: Record<string, string> = {
  create: 'Added',
  add: 'Added',
  update: 'Updated',
  edit: 'Edited',
  cancel: 'Cancelled',
  delete: 'Deleted',
  remove: 'Removed',
  activate: 'Re-activated',
  deactivate: 'Deactivated',
  print: 'Printed',
  reprint: 'Reprinted',
  restore: 'Restored',
  close: 'Closed',
  reopen: 'Re-opened',
  pay: 'Paid',
  export: 'Exported',
  import: 'Imported',
  mark: 'Marked',
  clear: 'Cleared',
};

const words = (s: string) => s.replace(/[_-]+/g, ' ').trim();
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "bill.create" -> "Created bill"; unknown keys become readable text ("stock_item.merge" -> "Stock item: merge"). */
export function activityLabel(action: string): string {
  const known = ACTIVITY_LABELS[action];
  if (known) return known;
  const dot = action.indexOf('.');
  if (dot < 0) return capitalize(words(action));
  const entity = words(action.slice(0, dot));
  const verb = action.slice(dot + 1);
  const v = VERBS[verb];
  if (v) return `${v} ${entity}`;
  return `${capitalize(entity)}: ${words(verb)}`;
}

export interface ActivityModule {
  key: string;
  label: string;
  /** Action prefixes (e.g. "bill.") or exact actions that belong to the group. */
  prefixes: string[];
}

/** Groups for the "What" filter of the activity log. */
export const ACTIVITY_MODULES: ActivityModule[] = [
  { key: 'sales', label: 'Bills, returns & items', prefixes: ['bill.', 'return.', 'credit_note.', 'item.'] },
  { key: 'customers', label: 'Customers & payments received', prefixes: ['customer.', 'receipt.'] },
  { key: 'purchases', label: 'Suppliers & purchases', prefixes: ['supplier.', 'purchase.', 'supplier_payment.'] },
  { key: 'accounts', label: 'Accounts & expenses', prefixes: ['expense.', 'journal.', 'capital.', 'drawings.', 'transfer.', 'loan.', 'account.', 'year.'] },
  { key: 'employees', label: 'Employees & salary', prefixes: ['employee.', 'attendance.', 'salary.', 'advance.'] },
  { key: 'logins', label: 'Logins & passwords', prefixes: ['user.login', 'user.logout', 'user.change_password', 'user.recover'] },
  { key: 'users', label: 'Users & permissions', prefixes: ['user.create', 'user.update', 'user.activate', 'user.deactivate', 'user.reset_password', 'role.'] },
  { key: 'settings', label: 'Settings, backups & imports', prefixes: ['settings.', 'backup.', 'import.', 'setup.', 'report.'] },
];

/** Activity actions whose entity no longer exists (no link to open). */
export function isDeleteAction(action: string): boolean {
  return /\.(delete|remove)$/.test(action);
}
