# Billforce

Billing, accounts and business management for small businesses in India. It is a Windows desktop app that works
completely offline, and all data stays on your PC.

- **Sales & billing**: fast counter billing with item search and quick-repeat of past items. Supports discounts,
  round-off, and Cash / UPI / Bank / Credit or split payments. Prints on 80 mm or 58 mm thermal printers, with an
  optional UPI QR on the receipt. Old bills can be reprinted (marked DUPLICATE). Sales returns and credit notes are
  supported. Every bill edit or cancellation is kept in a full audit history.
- **Customers**: credit sales, payments received, outstanding balances and printable statements.
- **Suppliers & purchases**: purchase bills, payments made and amounts payable.
- **Accounts**: double-entry books with a chart of accounts and journal entries. Includes the cash book, UPI/bank
  book, day book and ledgers, plus expenses, owner capital and drawings, loans, and year-end closing. Every bill,
  payment, purchase, expense and salary posts to the accounts automatically.
- **Reports**: Profit & Loss, Balance Sheet, Trial Balance and Cash Flow. Sales insights by day, month, item,
  customer and payment mode, plus receivables and payables ageing. Every report has date filters and exports to
  Excel, CSV and PDF.
- **Users & security**: Owner, Manager and Cashier roles with editable permissions, an activity log, auto-lock, and an
  owner recovery code.
- **Employees**: employee records, attendance, salary slips and advances.
- **Settings & data**: business and receipt details, automatic daily backups, manual backup and restore, and import
  from Excel/CSV.

Stock/inventory and GST are intentionally not included.

## Installing (for the shop owner)

1. Download **`Billforce-Setup-<version>.exe`** from the project's GitHub *Releases* page (or from the build
   artifacts of the latest run on the *Actions* tab).
2. Double-click it. Billforce installs for the current Windows user. No administrator password is needed, and it
   adds a desktop shortcut and starts automatically.
3. On first start, enter your business details and create the owner login. **Write down the recovery code** that
   is shown; it lets you reset the owner password if you ever forget it.

If you don't want to install anything, there is also **`Billforce-Portable-<version>.exe`**, which runs directly
when double-clicked.

Windows may show a "Windows protected your PC" screen for new, unsigned apps. Click *More info → Run anyway*.

### Where is my data?

- Data file: `%APPDATA%\Billforce\billforce.db`. Uninstalling Billforce does **not** delete it.
- Automatic backups: `Documents\Billforce Backups` (one per day, the newest 30 are kept). You can change the folder,
  back up to a pen drive, or restore from *Settings & data → Backup & restore*.

### Receipt printer

Install your thermal printer's Windows driver (most 80 mm printers show up as "POS-80" or similar). Then go to
*Settings → Receipt & printer*, choose the printer and click **Test print**. When a printer is chosen, bills print
straight away without a dialog. Choose *Ask every time* to get the normal Windows print dialog instead.

## Main technical decisions

| Decision | Why |
| --- | --- |
| **Electron** desktop app, built as a per-user NSIS installer plus a portable exe | Starts with a double-click on Windows 10/11 x64 with no setup or admin rights. Chromium gives silent printing to a chosen thermal printer and exact PDF export. |
| **SQLite through Electron's built-in `node:sqlite`** | A single file on the PC with no native add-ons to compile. WAL mode with `synchronous=FULL` survives power cuts. Backups are consistent `VACUUM INTO` snapshots, gzip-compressed. |
| **Money stored as integer paise** | Totals never drift the way floating-point amounts can. Indian formatting (₹1,23,456.00, lakh/crore words) is done in one shared module. |
| **One posting engine for all accounting** | Every module posts through `ledger.ts`, which enforces balanced entries, party sub-ledgers for customers, suppliers and employees, and locks closed financial years. Reports read only the ledger, so the books always agree. |
| **Cancel, never delete** | A cancelled document keeps its number, and its journal entry is voided. Each change stores a full revision snapshot and writes to the activity log. |
| **Typed API between UI and core** | The UI calls named routes over IPC. Each route checks the user's permission and validates its input with zod, and every change runs in a single transaction together with its audit log entry. |
| **Generic report format** | Every report returns one structure that the app can show on screen or export as Excel (with Indian number formats), CSV (UTF-8 with BOM) or PDF. |
| **Purchases are treated as expenses** | Stock is out of scope, so Profit & Loss treats purchases as expenses when they are made, and the report says so. |

See `docs/ARCHITECTURE.md` for the full design and the accounting posting rules.

## Development

Requirements: Node.js 22+.

```bash
npm install
npm run dev          # Vite + Electron with live reload
npm test             # core tests (vitest, in-memory SQLite)
npm run typecheck
npm run build        # renderer + main process bundles
npm run dist:win     # release/Billforce-Setup-<version>.exe and Billforce-Portable-<version>.exe
```

`node dist/web/server.cjs --port 4173 --data ./.e2e-data` runs the same core behind a local web server, so the UI can
be tested in an ordinary browser (Playwright). It is not part of the shipped app.

The GitHub Actions workflow (`.github/workflows/build.yml`) runs the tests on Linux and Windows, builds the
installer, and smoke-tests the packaged `Billforce.exe` (`--smoke-test`). It uploads the installers as artifacts and
publishes them to a GitHub Release for `v*` tags.
