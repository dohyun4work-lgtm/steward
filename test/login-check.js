const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 2 })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: "window.TASKHUB_CONFIG={supabaseUrl:'http://localhost:4400',supabaseAnonKey:'x'};" }));
  await p.route('**/auth/v1/token**', r => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }) }));
  await p.goto('http://localhost:4400/'); await p.waitForSelector('#loginForm');
  console.log('nav hidden:', !(await p.locator('.nav').isVisible()));
  await p.fill('#loginEmail', 'dh@example.com'); await p.fill('#loginPw', 'wrong'); await p.click('[type=submit]');
  await p.waitForSelector('.err:has-text("맞지 않아요")');
  console.log('error msg:', await p.textContent('.err'), '| email kept:', await p.inputValue('#loginEmail'));
  await p.screenshot({ path: '/home/claude/stage1-login.png' });
  console.log('page errors:', errs.length);
  await b.close();
})();
