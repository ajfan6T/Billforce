# Billforce — architecture & module contracts

Billforce is an offline Windows desktop ERP for small Indian businesses: billing,
customers, suppliers & purchases, double-entry accounts, reports, employees,
users & security, settings, backups and import, with optional **GST** (regular or composition), optional
**stock / inventory** tracking and an optional **restaurant menu** (dishes with recipes).

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
  print/receipt.ts   80/58 mm thermal receipt layout + UPI QR (+ GSTIN lines and GST table)
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
  Call `assertCancelKeepsClosedAccounts(ctx, entryId, 'this bill')` (`modules/accounting/common.ts`) first: an inactive
  cash / bank account (deactivated only at zero) or a closed loan must never gain a balance from a cancel.
* **Ledger**: modules never write `journal_*` tables directly. Use `postEntry`, `replaceEntry` (on edit), `voidEntry` (on cancel)
  from `core/accounting/ledger.ts`. Use system keys (`'CASH'`, `'SALES'`, `'AR'`...) or account ids.
  Lines on control accounts need a party: AR→customer, AP→supplier, EMP_ADV/SALARY_PAYABLE→employee.
  Payment modes → accounts via `paymentAccountId(ctx, mode, accountId?)` (cash/upi/bank). "Credit" means the party's control account.
  Every document stores `journal_entry_id`; entries store `source_type`/`source_id` back to the document.
* **Closed years**: `postEntry/replaceEntry/voidEntry` already refuse dates in a closed FY or before books start. Don't bypass.
* **Reports / lists that can be exported** return `ReportData` (`shared/report.ts`) and are shown with `<ReportView/>` +
  `<ExportButtons/>` (Excel / CSV / PDF / Print handled generically by `files.exportReport` / `files.printReport`).
  In PDF / print, date columns never wrap; mark short code columns (bill / voucher numbers, phone) `nowrap: true` so
  the long text (particulars, items) wraps instead. Every report takes a date filter (`{from, to}` or `{asOf}`); UI uses `<DateRangePicker/>` / `<AsOnPicker/>`.
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
  Forms with unsaved changes call `useUnsavedWarning(dirty)`: closing the window asks "Leave without saving?", and every
  in-app link (`href="#/…"`, caught by `useLinkGuard` in `App`), the sidebar, `LinkButton`, "Back" links and F2 ask before
  leaving. Cancel / Back buttons navigate with `useGuardedNavigate().go(path | -1)`; after a successful save use the plain
  `navigate()`. `{ navigation: false }` when the page keeps its own draft: leaving does not ask, and closing the desktop app
  says the draft will be kept (Close / Stay) instead of "will be lost".
  `files.open` / `files.showInFolder` only accept what Billforce saved (via `platform.saveFile`), the data folder and backups.
  Platforms write saved files with `writeFileSafely` (core/platform.ts: "<name>.partial", fsync, size check, rename), so a
  full or pulled-out pen drive never keeps a cut-short file; it throws `SaveFileError` with plain words.
  Module CSS goes in `pages/<module>/<module>.css` imported by its pages. The look ("Fresh": teal on soft white,
  rounded cards, light sidebar) lives in the CSS variables at the top of `styles/app.css`; module CSS uses those
  variables instead of its own colours. `--primary` (buttons, links) keeps white text readable (WCAG AA);
  `--accent` is the brighter teal for charts and icons.
  Tone: plain English a shop owner understands ("Payment received", "Amount due", "Cancel bill").
* **Optional features** (GST, stock, restaurant menu): off by default and invisible when off. Core: `gstConfig(ctx)`
  (`modules/gst/common.ts`) gives the mode of new documents; `app.status.features` tells the UI, which hides menu
  items (`feature` in `nav.ts`), report cards and form fields with `useFeatures()`. A document stores the mode it was
  made with (`gst_mode`), so turning a feature on or off never changes old documents, and edits keep the saved mode.
  GST fields sent by a form are optional in the API: left out = unchanged (forms of unregistered businesses omit them).
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
| Sales bill with GST (regular) | as above, but **DISCOUNT_ALLOWED** = discounts without tax | **SALES** = Σ qty×rate without tax; **GST_OUT_CGST + GST_OUT_SGST** (same state) or **GST_OUT_IGST**; ROUND_OFF |
| Return against a GST bill | **SALES_RETURNS** = refund less tax; **GST_OUT_*** = tax taken back (the line's share; all that is left on a fully returned line) | refund account / AR |
| Purchase with GST and input tax credit | purchase account = total − tax; **GST_IN_CGST + GST_IN_SGST** or **GST_IN_IGST** | cash/bank / AP (without the credit the tax stays in the purchase account) |
| Pay GST (voucher `gst_payment`, source `manual`) | **GST_OUT_*** (set off + paid) | **GST_IN_*** (credit used, legal order: IGST first; CGST/SGST never for each other); cash/bank (paid) |
| Pay composition tax (`gst_payment`) | **COMPOSITION_TAX** (expense) = turnover × rate | cash/bank |
| Opening stock (stock tracking) | **STOCK** | **OPENING_EQUITY** |
| Year-end closing with stock tracking | **STOCK** the rise in stock (or Cr the fall), included in the profit moved to CAPITAL | |

**GST** (`src/shared/gst.ts`, `calcBill(…, gst)` in `src/shared/billing.ts`, `purchaseTotals(…, gst)`): per line, the
bill discount is shared over the lines first; with "rates include GST" the tax is taken out of the value
(`lineTax(value, rate, inclusive, interState)`), otherwise added on top; CGST = SGST = half, rounded per line. The
till and the core use the same functions, so the preview is what gets saved. Place of supply = the customer's /
supplier's state (from the GSTIN, else `state_code`, else the business's own state); a different state means IGST.
GST accounts (Output / Input CGST, SGST, IGST under current liabilities / current assets, Composition Tax) are created
by `ensureGstAccounts` only when the business registers, so unregistered charts have none. Composition businesses
print a "Bill of supply" without tax (posted like an unregistered bill) and pay tax on turnover. Credit notes without
goods carry no GST. GST reports (`modules/gst/reports.ts`) read the documents (`gst_mode`), not the ledger. After the
registration changes, GST left in the books (earlier tax invoices, composition bills) can still be reported and paid
(`gstKinds`, `features.gstRegular / gstComposition`).

**Stock** (optional, Settings > Stock & menu; `modules/stock/`): items with "Track stock" move stock. Every document
made while tracking is on (`stock_tracked`) writes its `stock_moves` through `writeDocumentMoves` (bills −qty, returns
+qty, purchase lines that name an item +qty at their cost after the discount and without claimed GST, counts /
adjustments ±qty) and rewrites them when edited; cancelling removes them. An edited document keeps to the items it
moved before plus tracked items it did not have (`before`), so ticking "Track stock" later never changes old documents;
an item with stock cannot be unticked, and an item with stock history cannot change its unit. Rewritten moves reuse
the old move ids, so an edited document keeps its place in the day. A return against a bill brings back only items
that bill took out. Selling below zero is allowed with a warning (`shortStockWarnings`).
Value = quantity × **moving average cost**: each move stores the running quantity and average after it
(`bal_qty`, `avg_cost`, kept by `revalueStock` in `stock/running.ts` from the changed date on; order = opening stock
first, then date, id). Costed receipts (opening stock, purchases, stock added or counted at a cost) re-average; other
moves go at the average; below zero is valued at nothing and new stock restarts at its own cost. The value on a date is
one look-up per item (`stock/valuation.ts`), whatever the item's tracking flag today.
The books use the periodic method (`stock/accounting.ts`): purchases stay an expense; P&L cost of goods sold =
opening stock + purchases + direct expenses − closing stock; the balance sheet shows "Stock in hand" at its value on
the date and the profit lines carry the change since the ledger balance of **STOCK** ("Stock in Hand", created when
tracking is turned on); year-end closing posts the change to STOCK (with the profit to CAPITAL), so STOCK holds the
last closing stock. Opening stock (on the books start date) is an opening balance: Dr STOCK, Cr OPENING_EQUITY
(`stock.saveOpening`, needs `stock.manage` + `accounts.manage`). Journals cannot post to STOCK. Stock items can only
be bought into Purchases or a direct expense (a fixed asset or running expense would count them twice). Turning
tracking off hides the stock screens and takes the stock left out with a system adjustment dated that day
(`writeOffStockLeft`; again, dated today, whenever editing or cancelling an older document brings stock back while
tracking is off; adjustments cannot be cancelled while it is off), so profit stops counting it and the next closing
clears STOCK; the accounting keeps working
while any stock history exists (`stockInBooks`). Cost prices (average cost, stock value, opening cost, recipe cost)
are shown only with `stock.manage`, `purchases.manage`, `suppliers.view` or `reports.financial` (`stock/costs.ts`);
cashiers see quantities.

**Restaurant menu** (optional, Settings > Stock & menu; `modules/menu/`): a dish is an item with `items.menu = 1` and a
recipe (`recipe_items`: ingredient, quantity and unit for one plate). Ingredients are items with `sellable = 0`: kept
in stock, bought in purchase bills, never offered by `items.search` / `items.recent`. Dishes are never stock-tracked
themselves (`updateItem` and `trackAllItems` keep `track_stock = 0`). While the menu and stock tracking are on, a bill's
stock moves (`billStockMoves` in sales) add one `sale` move per ingredient per dish line: −(qty sold × recipe qty
converted with `convertQty`, g→kg, ml→ltr), noted "Butter Chicken x 2" (the note marks an ingredient move);
short-stock warnings include them. An edited bill keeps its recorded ingredient moves while its dishes and
quantities are unchanged, else uses today's recipes (also with the menu off, once it took ingredients out);
cancelling removes them; returns of dishes move nothing. Recipe amounts must be countable in the ingredient's unit
(3 decimals); an ingredient's unit cannot change to one its recipes cannot convert to; items with stock or
ingredients cannot be put on the menu. Recipe
costs use the ingredients' average cost (`menu.costing`). Turning the menu off hides its screens; dishes stay
ordinary items and their bills stop moving ingredients.

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
| `accounts.list` | `{ groups?, types?, includeInactive?, withBalances?, asOf? }` | `AccountListItem[]` (income / expense balances are for asOf's financial year, like the trial balance) |
| `accounts.paymentCheck` | `{ mode, accountId?, amount, date?, entryId? }` | `{ accountId, accountName, date, balance \| null, warning }` — show the balance next to "Paid from" and ask before saving a payment that takes it below zero (`pages/accounts/PaymentBalance.tsx`) |
| `accounts.paymentAccounts` | – | `{ cash[], bank[], defaults: { cash, upi, bank } }` |
| `employees.search` | `{ q?, includeInactive? }` | `{ id, name, phone, designation, isActive }[]` |
| `sales.create` | `{ date?, customerId?, customerName?, customerPhone?, items: [{ itemId?, itemName, unit?, qty, rate, discount?, discountPct?, gstRate?, hsn? }], billDiscount?, billDiscountPct?, payments: [{ mode: 'cash'|'upi'|'bank', amount, accountId?, reference? }], remarks? }` — credit part = total − Σpayments; `gstRate`/`hsn` only for one-time lines (catalogue items use the item's rate) | `{ id, billNo, total, gst: { mode, taxable, cgst, sgst, igst, ... }, ... }` |
| `gst.summary` / `gst.salesRegister` / `gst.hsnSummary` / `gst.purchaseRegister` / `gst.compositionSummary` | `{ from, to }` | `ReportData` |
| `gst.due` / `gst.pay` | `{ upTo, from? }` / `+ { date?, mode, accountId?, reference? }` | set-off and cash per head / the voucher (`EntryDetail`) |
| `menu.list` / `menu.save` / `menu.ingredients` / `menu.createIngredient` / `menu.addItems` / `menu.costing` | see `modules/menu/routes.ts` (`menu.save`: `{ id?, name, rate, unit?, category?, recipe: [{ ingredientId, qty, unit, note? }] }`) | `Dish` (`item`, `recipe`, `recipeCost`, `foodCostPct`) / `Ingredient[]` / `ReportData` |
| `reports.trialBalance` | `{ from?, to }` | `ReportData` |

Core helpers other modules may call: `touchItemUsage`, `searchCustomers`, `quickCreateCustomer`, `searchSuppliers`,
`setPartyOpeningBalance`, `createBackup` / `createBackupAsync` (outside transactions; the async one does not block the app, the sync one is for work that must finish first), `listAccounts`, `paymentAccounts`, `searchEmployees`.

## Money controls (enforced in core, mirrored in the UI)

| Rule | Where |
| --- | --- |
| Discounts need `billing.discount`; a catalogue item billed at other than its list rate, or any one-time (free-text) line, needs `billing.rate` | `sales.create` / `sales.update` |
| Backdated bills and payments need `billing.backdate`; future dates are refused; the POS always saves today's date unless the user picked one | sales, receipts |
| A return refunds at most what the customer paid for each unit (line + bill discount + round-off shares); all returns on a bill never exceed the bill total, and the return that settles the bill refunds exactly what is left | `returns.create` (`src/shared/billing.ts` helpers) |
| Money back (cash / UPI / bank) is limited to the money received for the bill: at the counter, plus the money of later payments (not their discounts, credit notes or write-offs) shared out oldest dues first, once the customer no longer owes that part; the rest must be adjusted in the customer's account. Cancelling or cutting a payment that such a refund relied on returns a warning | `returns.billReturnable`, `receipts.cancel` / `receipts.update` |
| Credit notes without goods need `returns.adjust` | returns |
| Customer credit limits / opening balances need `customers.credit`; supplier opening balances need `accounts.manage`; employee opening advances need `employees.salary` | customers, suppliers, employees; the import preview shows such rows as errors |
| With "Stop bills over the credit limit" on, a credit bill over the limit is refused, and customers without a limit can buy on credit only when a user with `customers.credit` bills them | `sales.create` |
| Receipt discounts need `billing.discount`; reprints need `billing.reprint` and are marked DUPLICATE | receipts, bills, salary slips |
| Payments that would take a cash / bank account below zero are allowed but warned (`negativeBalanceWarning`) | all outflows |
| Inactive accounts never gain a balance (cancels / opening edits that would do so are refused) | accounting `common.ts` guards |

## Schema changes

Migration 1 is the release schema. Migration 2 brings data files from pre-release builds up to it (adds late
columns and rebuilds changed indexes; a no-op on fresh files). Migration 3 adds the GST columns
(`db/schema/gst.ts`), each with a default meaning "no GST", so older data reads exactly as before. Migration 4 adds
stock (`db/schema/stock.ts`: item stock settings, purchase line item link, `stock_moves`, stock adjustments). Migration 5
adds the restaurant menu (`db/schema/menu.ts`: `items.sellable` default 1, `items.menu` default 0, `recipe_items`).
Migration 6 adds the running quantity and average cost to `stock_moves` and fills them in (`revalueAllStock`). Every future
change is a new migration — never edit a released one. `seedReferenceData` runs on every start and grants default permissions only for permissions
a data file has not seen before (`meta.known_permissions`), so the owner's choices survive upgrades and restores.
