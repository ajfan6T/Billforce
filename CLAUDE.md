# Billforce

Offline Windows desktop ERP for small Indian businesses (Electron + node:sqlite + React). Read `docs/ARCHITECTURE.md`
before changing code — it defines conventions, the accounting posting contract and cross-module routes.

Key rules:
- Money = integer paise; dates = `YYYY-MM-DD`; use helpers in `src/shared/` and `today(ctx)`/`now(ctx)` in core.
- Only `src/core/accounting/ledger.ts` writes journal tables. Documents are cancelled (voided), never deleted.
- Every mutation logs activity (`logActivity`) and documents record revisions (`recordRevision`).
- Core must not import Electron; the renderer imports only *types* from `src/core`.
- Optional features are off by default and invisible when off (`useFeatures()` in the UI, `app.status.features`):
  GST (Settings > GST: unregistered / regular / composition; `gstConfig(ctx)`), stock tracking (Settings > Stock & menu;
  `stockEnabled(ctx)`) and the restaurant menu (dishes with recipes; `menuEnabled(ctx)`). Each document keeps the mode
  it was made with (`gst_mode`, `stock_tracked`).
- Stock movements are derived data (`stock_moves`, written only through `modules/stock/service.ts`); stock is valued
  at average cost and enters the books by the periodic method (see docs/ARCHITECTURE.md).

Commands:
- `npm test` — vitest (core, in-memory SQLite)
- `npm run typecheck` — tsc for core/electron and renderer
- `npm run build` — renderer (vite) + main/preload/web-server (esbuild)
- `node dist/web/server.cjs --port 4173 --data <dir>` — run the app in a normal browser for UI testing (Playwright:
  `chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })`)
- `npm run dist:win` — Windows installer + portable exe (electron-builder)
