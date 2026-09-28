// Build the UI + browser test server into .build-test/<name>/ so several people (or agents)
// can test at once without overwriting each other's dist/.
//   node scripts/build-test.mjs sales
//   node .build-test/sales/web/server.cjs --port 4201 --data /tmp/sales-work/data
// With --electron the Electron main process and preload are built too (.build-test/<name>/main/main.cjs),
// to try the real desktop app: BILLFORCE_DATA_DIR=/tmp/x xvfb-run node_modules/electron/dist/electron --no-sandbox .build-test/<name>/main/main.cjs
import path from 'node:path';
import { build as viteBuild } from 'vite';
import { build } from 'esbuild';

const name = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'default';
const withElectron = process.argv.includes('--electron');
const out = path.resolve('.build-test', name);
await viteBuild({ configFile: 'vite.config.mts', logLevel: 'warn', build: { outDir: path.join(out, 'renderer'), emptyOutDir: true } });
await build({
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'external',
  external: ['electron'],
  logLevel: 'warning',
  entryPoints: { server: 'scripts/web-server.ts' },
  outdir: path.join(out, 'web'),
  outExtension: { '.js': '.cjs' },
});
if (withElectron) {
  await build({
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    packages: 'external',
    external: ['electron'],
    logLevel: 'warning',
    entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts' },
    outdir: path.join(out, 'main'),
    outExtension: { '.js': '.cjs' },
  });
}
console.log(`Built ${out}. Start: node ${path.relative(process.cwd(), path.join(out, 'web/server.cjs'))} --port 4200 --data /tmp/${name}-data`);
