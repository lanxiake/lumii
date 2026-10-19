import { chromium } from '../../../node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const outRoot = join(here, 'images');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1120, height: 1120 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('file://' + join(here, '_posters.html').replace(/\\/g, '/'));
await page.waitForLoadState('networkidle');
await page.evaluate(() => document.fonts.ready);

const list = await page.$$eval('[data-out]', els => els.map(e => e.dataset.out));
console.log('posters:', list.length);

for (const out of list) {
  const el = await page.$(`[data-out="${out}"]`);
  const dir = join(outRoot, dirname(out));
  mkdirSync(dir, { recursive: true });
  await el.screenshot({ path: join(outRoot, out + '.png') });
  const box = await el.boundingBox();
  console.log(out, box.width + 'x' + box.height);
}

if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exitCode = 1; }
await browser.close();
