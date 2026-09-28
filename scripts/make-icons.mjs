// Renders the app icon (SVG) to PNGs with the pre-installed Chromium and packs a multi-size .ico.
//   node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#1e3a8a"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#g)"/>
  <path d="M58 58 q0 -14 14 -14 h112 q14 0 14 14 V204 l-17.5 14 -17.5 -14 -17.5 14 -17.5 -14 -17.5 14 -17.5 -14 -17.5 14 -17.5 -14 Z" fill="#ffffff"/>
  <rect x="84" y="62" width="88" height="9" rx="4.5" fill="#bfdbfe"/>
  <text x="128" y="178" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="800" font-size="112" fill="#1d4ed8">₹</text>
</svg>`;

const out = path.resolve('build');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.svg'), SVG);

const sizes = [16, 24, 32, 48, 64, 128, 256];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const pngs = {};
for (const s of sizes) {
  await page.setViewportSize({ width: s, height: s });
  await page.setContent(`<html><body style="margin:0;background:transparent">${SVG.replace('<svg ', `<svg width="${s}" height="${s}" `)}</body></html>`);
  pngs[s] = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } });
}
await page.setViewportSize({ width: 512, height: 512 });
await page.setContent(`<html><body style="margin:0;background:transparent">${SVG.replace('<svg ', '<svg width="512" height="512" ')}</body></html>`);
fs.writeFileSync(path.join(out, 'icon.png'), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: 512, height: 512 } }));
await browser.close();

// ICO container with PNG-compressed images (supported since Windows Vista).
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
const entries = [];
let offset = 6 + 16 * sizes.length;
for (const s of sizes) {
  const e = Buffer.alloc(16);
  e.writeUInt8(s >= 256 ? 0 : s, 0);
  e.writeUInt8(s >= 256 ? 0 : s, 1);
  e.writeUInt8(0, 2);
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[s].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[s].length;
  entries.push(e);
}
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([header, ...entries, ...sizes.map((s) => pngs[s])]));
console.log('Wrote build/icon.svg, build/icon.png, build/icon.ico');
