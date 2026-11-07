const { chromium } = require('playwright');
const path = require('path');
const CHROME = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1148/chrome-win/chrome.exe';
const FILE = 'file:///E:/my-project/open-source/lumii/apps/windows/boot-demo/xianxia.html';
(async () => {
  const b = await chromium.launch({ executablePath: CHROME });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await p.goto(FILE, { waitUntil: 'load' });
  const marks = [1500, 4000, 6500, 9000, 11500, 14500, 17000, 19500];
  let prev = 0;
  for (const t of marks) {
    await p.waitForTimeout(t - prev); prev = t;
    const s = await p.evaluate(() => ({
      act: document.getElementById('boot').dataset.act,
      slips: document.getElementById('slips').children.length,
      last: (document.querySelector('.slip.now')||{}).textContent || '',
    }));
    await p.screenshot({ path: path.join(__dirname, 's_' + t + '.png') });
    console.log(t, s.act, 'slips=' + s.slips, s.last);
  }
  console.log(errs.length ? errs.join('\n') : 'NO ERRORS');
  await b.close();
})();
