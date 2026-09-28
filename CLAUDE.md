# Billforce

Offline Windows desktop ERP for small Indian businesses (Electron + node:sqlite + React). Read `docs/ARCHITECTURE.md`
before changing code — it defines conventions, the accounting posting contract and cross-module routes.

Key rules:
- Money = integer paise; dates = `YYYY-MM-DD`; use helpers in `src/shared/` and `today(ctx)`/`now(ctx)` in core.
- Only `src/core/accounting/ledger.ts` writes journal tables. Documents are cancelled (voided), never deleted.
- Every mutation logs activity (`logActivity`) and documents record revisions (`recordRevision`).
- Core must not import Electron; the renderer imports only *types* from `src/core`.
- Out of scope: stock/inventory, GST/tax invoices.

Commands:
- `npm test` — vitest (core, in-memory SQLite)
- `npm run typecheck` — tsc for core/electron and renderer
- `npm run build` — renderer (vite) + main/preload/web-server (esbuild)
- `node dist/web/server.cjs --port 4173 --data <dir>` — run the app in a normal browser for UI testing (Playwright:
  `chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })`)
- `npm run dist:win` — Windows installer + portable exe (electron-builder)
