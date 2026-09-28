# Billforce — architecture & module contracts

Billforce is an offline Windows desktop ERP for small Indian businesses: billing,
customers, suppliers & purchases, double-entry accounts, reports, employees,
users & security, settings, backups and import. **No stock/inventory. No GST.**

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Shell | Electron 44 (Chromium 152, Node 24) | Double-click `.exe`, full offline, silent printing to thermal printers, PDF export |
| Database | SQLite via the built-in `node:sqlite` module | No native add-ons to compile; one file on the user's PC; WAL + `synchronous=FULL` survives power cuts |
| Core | TypeScript, synchronous services, zod-validated routes | All business rules in one testable place, independent of Electron |
| UI | React 19 + react-router (HashRouter), plain CSS design system | Fast, no network, keyboard-friendly |
| Excel | exceljs; CSV hand-written with UTF-8 BOM; PDF via Chromium `printToPDF` | |
| Tests | vitest (core, in-memory DB) + Playwright against `dist/web/server.cjs` | |
| Packaging | electron-builder: NSIS per-user installer (no admin) + portable exe | |

## Layout

```
electron/            main process: window, IPC, ElectronPlatform (print/PDF/dialogs)
src/shared/          pure helpers used by core AND UI (money, dates, constants, permissions, settings types, report types)
src/core/            business logic (no Electron imports)
  app.ts             BillforceApp: open DB, migrate, seed, invoke(route, input)
  api/router.ts      route() definition, access checks, zod parsing, transactions
  api/routes.ts      aggregates every module's routes (the renderer imports its TYPE)
  db/schema/*.ts     SQL schema, one file per area (all in migration v1 until release)
  accounting/        chart seeds, ledger posting engine, periods (FY lock), opening balances
  export/            ReportData -> CSV / XLSX / HTML(PDF)
  print/receipt.ts   80/58 mm thermal receipt layout + UPI QR
  modules/<name>/    service.ts (functions) + routes.ts (API)   <- feature code lives here
src/renderer/        React UI
  api.ts hooks.ts auth.tsx feedback.tsx   typed API client, useQuery/useMutation, session, toasts/dialogs
  components/        ui.tsx forms.tsx table.tsx report.tsx modal.tsx pickers.tsx
  pages/<module>/    pages + routes.tsx (the module's page list)
tests/               vitest; helpers.ts gives createTestApp(), ledgerProblems(), systemBalance()
```

## Conventions (all modules)

* **Money is integer paise** everywhere (DB, API, UI state). Use `shared/money.ts`:
  `lineAmount(qty, rate)`, `percentOf`, `roundOffAdjustment`, `formatINR`, `formatDrCr`, `parseMoney`.
  UI inputs: `<MoneyInput value={paise} onChange={...}/>`. Display: `<Money value={paise}/>`.
* **Dates** are `YYYY-MM-DD` strings; timestamps `YYYY-MM-DD HH:MM:SS` local. Display with `formatDate` (DD-MM-YYYY).
  Use `today(ctx)` / `now(ctx)` in core (never `new Date()` directly) so tests can control time.
* **Financial year** April–March (`fyOf(date)`). Document numbers restart each FY: `nextDocNumber(ctx, key, date)` → `INV/26-27/0001`.
* **Routes**: `'<module>.<verb>'`, defined with `route({ access, input: zodSchema, mutation, handler })`.
  * `access`: `'public' | 'user' | Permission | Permission[]` (any-of). Pick the narrowest permission from `shared/permissions.ts`.
    Extra rules (e.g. "discount needs billing.discount") are checked in the service with `can(ctx, p)` / `assertCan`.
  * `mutation: true` wraps the handler in ONE transaction; the handler must be synchronous. Data, ledger entries,
    revisions and the activity log commit or roll back together.
  * Handlers return plain JSON-serialisable objects (camelCase). Never return password hashes.
  * Throw `AppError` (`fail.validation(msg, fields)`, `fail.notFound`, `fail.conflict`) with messages a shopkeeper understands.
* **Audit trail**: every change calls `logActivity(ctx, 'bill.create', 'Created bill INV/26-27/0012 for ₹450.00', { entityType, entityId, details })`.
  Documents (bills, credit notes, receipts, purchases, supplier payments, expenses, journals, salaries) also call
  `recordRevision(ctx, docType, id, 'created'|'edited'|'cancelled', snapshotAfterChange, reason)` — full snapshot after the change.
  Editing/cancelling requires a reason where it matters (bills: cancel reason required, edit reason optional).
* **Cancel, don't delete** documents: set `status='cancelled'`, `cancelled_by/at/reason`, and `voidEntry()` the journal entry.
* **Ledger**: modules never write `journal_*` tables directly. Use `postEntry`, `replaceEntry` (on edit), `voidEntry` (on cancel)
  from `core/accounting/ledger.ts`. Use system keys (`'CASH'`, `'SALES'`, `'AR'`...) or account ids.
  Lines on control accounts need a party: AR→customer, AP→supplier, EMP_ADV/SALARY_PAYABLE→employee.
  Payment modes → accounts via `paymentAccountId(ctx, mode, accountId?)` (cash/upi/bank). "Credit" means the party's control account.
  Every document stores `journal_entry_id`; entries store `source_type`/`source_id` back to the document.
* **Closed years**: `postEntry/replaceEntry/voidEntry` already refuse dates in a closed FY or before books start. Don't bypass.
* **Reports / lists that can be exported** return `ReportData` (`shared/report.ts`) and are shown with `<ReportView/>` +
  `<ExportButtons/>` (Excel / CSV / PDF / Print handled generically by `files.exportReport` / `files.printReport`).
  Every report takes a date filter (`{from, to}` or `{asOf}`); UI uses `<DateRangePicker/>` / `<AsOnPicker/>`.
  Row links: `link: { kind, id }` with kinds `bill | credit_note | receipt | purchase | supplier_payment | expense | journal | salary | advance | customer | supplier | employee | account | loan`.
  Drill-downs keep the period: `useOpenLink(period)` / `linkPath(link, period)` / `withPeriod(path, period)` (`renderer/links.ts`)
  add `?from=&to=&preset=` for ledgers and party accounts; pages read it through `useRange` / `useReportRange` (the address
  wins until the user picks another period) or `useLinkedPeriod()`, and as-on reports through `?asOf=`.
  Never cut a long list silently: opening, totals and closing are SQL aggregates over the whole period; only the rows
  shown are paged (`page`, and `all: true` for exports — see `books.*` / `journals.list`), with `<ExportButtons load>`
  fetching every row. SQLite runs on the main process: check `EXPLAIN QUERY PLAN` on big data and never let a per-entry
  subquery walk a busy account's whole history (use `+l.account_id` or the covering `idx_jl_account_entry`).
* **Printing**: build a `ReceiptDoc` and call `renderReceiptHtml(doc, business, receiptSettings)`; print with
  `ctx.platform.printHtml(html, { printerName, silent: !!printerName, paperWidthMm, copies })` using `getSection(ctx,'receipt')`.
  Provide a `*.receiptHtml` route so the UI can preview with `<ReceiptPreview html/>`.
* **UI**: pages use `<Page>`, `<PageHeader title actions/>`, `<Card>`, `<DataTable>`, `<Toolbar>`, form controls from `forms.tsx`,
  domain pickers from `pickers.tsx`, `useQuery(route, input)` / `useMutation(route)`, `useToast()`, `useDialogs()` (confirm / prompt),
  `useAuth().can(perm)` to hide actions. Keyboard: `useHotkeys` (page shortcuts are off while a dialog is open or the
  screen is locked; shortcuts set up by the component that renders a `<Modal>` work while it is on top).
  Forms with unsaved changes call `useUnsavedWarning(dirty)`: closing the window asks, and the sidebar, `LinkButton`,
  "Back" links and F2 ask before leaving (`{ navigation: false }` when the page keeps its own draft).
  `files.open` / `files.showInFolder` only accept what Billforce saved (via `platform.saveFile`), the data folder and backups.
  Module CSS goes in `pages/<module>/<module>.css` imported by its pages.
  Tone: plain English a shop owner understands ("Payment received", "Amount due", "Cancel bill").
* **Tests**: each module adds `tests/<module>.test.ts` using `createTestApp()`; assert `ledgerProblems(t.app)` is empty after
  every scenario, check postings with `systemBalance`, and test permission denials with `t.loginAs('cashier')`.

## Accounting postings (the contract every module follows)

| Document | Debit | Credit |
| --- | --- | --- |
| Sales bill (total T) | each payment's cash/bank account (paid part); **AR(customer)** for the credit part; **DISCOUNT_ALLOWED** for item + bill discounts; **ROUND_OFF** if rounded down | **SALES** gross (Σ qty×rate); **ROUND_OFF** if rounded up |
| Sales return / credit note (R) | **SALES_RETURNS** | refund cash/bank account, or **AR(customer)** when adjusted in the customer's account |
| Payment received (A, discount D) | cash/bank A; **DISCOUNT_ALLOWED** D | **AR(customer)** A+D |
| Purchase bill (total P) | purchase account (default **PURCHASES**; any expense or fixed-asset account) P | paid part to cash/bank; credit part to **AP(supplier)** |
| Payment to supplier (A, discount D) | **AP(supplier)** A+D | cash/bank A; **DISCOUNT_RECEIVED** D |
| Expense | expense account | cash/bank, or **AP(supplier)** on credit |
| Capital introduced | cash/bank | **CAPITAL** (or another capital-group account) |
| Drawings | **DRAWINGS** | cash/bank |
| Cash/bank transfer | to-account | from-account |
| Loan taken / repaid | cash/bank / loan a/c (principal) + **INTEREST_EXPENSE** | loan a/c / cash/bank |
| Loan given / received back | loan a/c / cash/bank | cash/bank / loan a/c (principal) + **INTEREST_INCOME** |
| Employee advance | **EMP_ADV(employee)** | cash/bank |
| Salary slip (gross G, bonus B, deductions X, advance recovery A, net N) | **SALARY** G+B−X | **EMP_ADV(employee)** A; **SALARY_PAYABLE(employee)** N |
| Salary payment | **SALARY_PAYABLE(employee)** | cash/bank |
| Opening balances | `setPartyOpeningBalance()` / opening entries against **OPENING_EQUITY**, dated books start | |
| Year-end closing (voucher `closing`, FY end date) | each income account's credit balance; **CAPITAL** if loss | each expense account's debit balance; **CAPITAL** if profit; optional: Dr CAPITAL / Cr DRAWINGS |

Reports read only non-void entries (`is_void = 0`). P&L style reports exclude `voucher_type = 'closing'`.
Balance sheet as on D: balance-sheet accounts use all entries ≤ D except closing entries of D's own FY;
"Profit & loss (current year)" = income − expenses from FY start to D excluding closing; unclosed earlier years show as
"Profit & loss (previous years)". This always balances.

## Cross-module CONTRACT routes (already implemented; extend, don't break)

| Route | Input | Output |
| --- | --- | --- |
| `items.search` / `items.recent` / `items.list` / `items.create` ... | see `modules/items/routes.ts` | `Item` (`rate` paise) |
| `customers.search` | `{ q, limit? }` | `{ id, name, phone, balance, creditLimit, balanceHidden? }[]` (balance + = owes you; without `customers.view`/`customers.receive`: balance 0, creditLimit null, balanceHidden true) |
| `customers.quickCreate` | `{ name, phone?, address? }` | same shape |
| `suppliers.search` / `suppliers.quickCreate` | `{ q, limit? }` / `{ name, phone? }` | `{ id, name, phone, payable }` (+ = you owe) |
| `accounts.list` | `{ groups?, types?, includeInactive?, withBalances?, asOf? }` | `AccountListItem[]` |
| `accounts.paymentAccounts` | – | `{ cash[], bank[], defaults: { cash, upi, bank } }` |
| `employees.search` | `{ q?, includeInactive? }` | `{ id, name, phone, designation, isActive }[]` |
| `sales.create` | `{ date?, customerId?, customerName?, customerPhone?, items: [{ itemId?, itemName, unit?, qty, rate, discount?, discountPct? }], billDiscount?, billDiscountPct?, payments: [{ mode: 'cash'|'upi'|'bank', amount, accountId?, reference? }], remarks? }` — credit part = total − Σpayments | `{ id, billNo, total, ... }` |
| `reports.trialBalance` | `{ from?, to }` | `ReportData` |

Core helpers other modules may call: `touchItemUsage`, `searchCustomers`, `quickCreateCustomer`, `searchSuppliers`,
`setPartyOpeningBalance`, `createBackup` / `createBackupAsync` (outside transactions; the async one does not block the app, the sync one is for work that must finish first), `listAccounts`, `paymentAccounts`, `searchEmployees`.
