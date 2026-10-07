const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 2, timezoneId: 'Asia/Seoul' })).newPage();
  await p.goto('http://localhost:4400/'); await p.waitForSelector('.row'); await new Promise(r => setTimeout(r, 500));
  await p.screenshot({ path: process.argv[2] });
  await b.close();
})();
