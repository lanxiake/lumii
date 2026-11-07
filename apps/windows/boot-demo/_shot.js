const { chromium } = require('playwright');
const path = require('path');
const CHROME = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1148/chrome-win/chrome.exe';
const FILE = 'file:///E:/my-project/open-source/lumii/apps/windows/boot-demo/xianxia.html';
(async () => {
  const acts = process.argv.slice(2);
  const b = await chromium.launch({ executablePath: CHROME });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  for (const a of acts) {
    await p.goto(FILE + '?freeze=' + a, { waitUntil: 'load' });
    await p.waitForTimeout(2600);
    await p.screenshot({ path: path.join(__dirname, 'x_' + a + '.png') });
    console.log('shot', a);
  }
  console.log(errs.length ? errs.join('\n') : 'NO ERRORS');
  await b.close();
})();
