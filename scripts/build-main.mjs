// Bundles the Electron main process, preload script and the browser test server with esbuild.
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'linked',
  // Runtime dependencies (exceljs, qrcode, zod, papaparse) are loaded from node_modules.
  packages: 'external',
  external: ['electron'],
  logLevel: 'info',
};

const targets = [
  { ...common, entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' }, outdir: 'dist/main', outExtension: { '.js': '.cjs' } },
  { ...common, entryPoints: { server: 'scripts/web-server.ts' }, outdir: 'dist/web', outExtension: { '.js': '.cjs' } },
];

if (watch) {
  for (const t of targets) {
    const ctx = await context(t);
    await ctx.watch();
  }
} else {
  await Promise.all(targets.map((t) => build(t)));
}
