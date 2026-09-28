// Development: Vite dev server for the UI + esbuild watch for main + Electron.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const server = await createServer({ configFile: 'vite.config.mts' });
await server.listen();
const url = server.resolvedUrls.local[0];

const esbuild = spawn(process.execPath, ['scripts/build-main.mjs', '--watch'], { stdio: 'inherit' });
const { default: electronPath } = await import('electron');
await new Promise((r) => setTimeout(r, 1500));
const electron = spawn(electronPath, ['.'], { stdio: 'inherit', env: { ...process.env, BILLFORCE_DEV_URL: url } });
electron.on('exit', () => {
  esbuild.kill();
  server.close();
  process.exit(0);
});
