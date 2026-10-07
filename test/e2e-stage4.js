// 4단계 E2E: PWA (매니페스트·서비스 워커·오프라인·업데이트·푸시 표시·알림 주소 이동·설치 안내)
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');

const BASE = 'http://localhost:4400/';
const sql = q => execFileSync('su', ['postgres', '-c', `psql -h /var/tmp/pgtest -d taskhub -At -c "${q.replace(/"/g, '\\"')}"`]).toString().trim();
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const U = "'11111111-1111-1111-1111-111111111111'";
const D = sql('select app_today()');

(async () => {
  sql('delete from daily_reviews; delete from tasks;');
  sql(`insert into tasks(user_id,title,status,do_date) values (${U},'주보 최종 검토','active','${D}')`);
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul' });
  await ctx.grantPermissions(['notifications'], { origin: 'http://localhost:4400' });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && /sw|service/i.test(m.text())) errors.push(m.text()); });

  // ---------- 매니페스트 ----------
  await page.goto(BASE); await page.waitForSelector('.row');
  const mf = await page.evaluate(async () => {
    const href = document.querySelector('link[rel=manifest]')?.href; if (!href) return null;
    const m = await (await fetch(href)).json();
    const icons = await Promise.all(m.icons.map(async i => ({ ...i, status: (await fetch(new URL(i.src, href))).status })));
    return { ...m, icons };
  });
  check('매니페스트 연결 + 이름 Steward', mf && mf.name === 'Steward' && mf.short_name === 'Steward');
  check('홈 화면 앱 형태(standalone), 시작 주소 #/today', mf.display === 'standalone' && mf.start_url === './#/today' && mf.scope === './');
  check('아이콘 192·512 + maskable, 모두 열림', ['192x192', '512x512'].every(s => mf.icons.some(i => i.sizes === s && i.purpose === 'any')) && mf.icons.some(i => i.purpose === 'maskable') && mf.icons.every(i => i.status === 200));
  check('iPhone 홈 화면용 설정 (apple-touch-icon, 앱 모드)', await page.evaluate(() => !!document.querySelector('link[rel=apple-touch-icon]') && document.querySelector('meta[name=apple-mobile-web-app-capable]')?.content === 'yes'));

  // ---------- 서비스 워커 ----------
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); await page.waitForSelector('.row');
  check('서비스 워커 등록 + 페이지 제어', await page.evaluate(() => !!navigator.serviceWorker.controller));
  const cached = await page.evaluate(async () => { const k = (await caches.keys()).find(x => x.startsWith('steward-shell-')); const c = await caches.open(k); return (await c.keys()).map(r => new URL(r.url).pathname); });
  check('앱 화면 파일 캐시 (index·app·styles·supabase·아이콘)', ['/index.html', '/app.js', '/styles.css', '/vendor/supabase.js', '/icons/icon-192.png'].every(p => cached.includes(p)), cached.length + '개');

  // ---------- 오프라인 ----------
  await ctx.setOffline(true);
  await page.reload(); await page.waitForSelector('.top, .empty-big', { state: 'attached' }); await sleep(800);
  check('오프라인에서도 앱이 열림 (캐시)', (await page.title()) === 'Steward');
  check('오프라인 안내 문구', (await page.textContent('#main')).includes('오프라인이에요'), (await page.textContent('#main')).trim().slice(0, 40));
  await ctx.setOffline(false);
  await page.waitForSelector('.row', { timeout: 8000 }).catch(() => {});
  check('다시 연결되면 자동으로 불러옴', (await page.locator('.row-title').allTextContents()).includes('주보 최종 검토'));

  // ---------- 업데이트 (온라인이면 항상 최신 파일) ----------
  const cssPath = path.join(__dirname, '..', 'styles.css'); const orig = fs.readFileSync(cssPath, 'utf8');
  fs.writeFileSync(cssPath, orig + '\n/* update-marker-42 */\n');
  try {
    await page.reload(); await page.waitForSelector('.row');
    const css = await page.evaluate(async () => [...document.styleSheets].some(s => { try { return s.href && s.href.endsWith('styles.css'); } catch { return false; } }) && (await (await caches.match('styles.css')).text()).includes('update-marker-42'));
    check('파일을 고치면 다음 열 때 바로 최신으로 (캐시도 갱신)', css);
  } finally { fs.writeFileSync(cssPath, orig); }

  // ---------- 푸시 → 알림 표시 ----------
  const cdp = await ctx.newCDPSession(page);
  let regId = null;
  cdp.on('ServiceWorker.workerRegistrationUpdated', e => { const r = e.registrations.find(x => x.scopeURL === BASE && !x.isDeleted); if (r) regId = r.registrationId; });
  await cdp.send('ServiceWorker.enable'); for (let i = 0; i < 20 && !regId; i++) await sleep(100);
  const push = data => cdp.send('ServiceWorker.deliverPushMessage', { origin: 'http://localhost:4400', registrationId: regId, data: JSON.stringify(data) });
  const msg = { title: 'Steward', body: '남은 업무 4개 · 지금 정리하거나 추가하세요', url: `./#/checkin/midday?d=${D}&n=log-1`, tag: `midday-${D}` };
  await push(msg); await sleep(600);
  let notes = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(n => ({ title: n.title, body: n.body, tag: n.tag, url: n.data?.url, badge: n.badge, icon: n.icon })));
  check('푸시 받으면 알림 표시 (제목·내용)', notes.length === 1 && notes[0].body === msg.body && notes[0].title === 'Steward', JSON.stringify(notes[0] || {}).slice(0, 120));
  check('알림에 열 주소·tag·아이콘', notes[0]?.url === msg.url && notes[0]?.tag === msg.tag && /badge-96/.test(notes[0]?.badge) && /icon-192/.test(notes[0]?.icon));
  await push(msg); await sleep(600);
  notes = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length);
  check('같은 알림이 두 번 와도 하나만 (tag)', notes === 1, notes + '개');

  // ---------- 알림 누름 → 열린 앱에서 주소만 이동 ----------
  await page.evaluate(url => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'steward:open', url } })), new URL(msg.url, BASE).href);
  await page.waitForSelector('#sheet h2:has-text("중간 체크")', { timeout: 4000 }).catch(() => {});
  check('알림 누르면 열린 앱이 해당 체크인으로 이동 (새로고침 없음)', (await page.evaluate(() => location.hash)).startsWith('#/checkin/midday') && await page.locator('#sheet h2', { hasText: '중간 체크' }).isVisible());

  // ---------- 설치 안내 ----------
  await page.click('#sheet [data-close], .scrim', { force: true }).catch(() => {});
  await page.goto(BASE + '#/archive'); await page.waitForSelector('.install-hint');
  check('브라우저에서 열면 보관 탭에 "홈 화면에 추가" 안내', (await page.textContent('.install-hint')).includes('홈 화면에 추가'));
  await ctx.close();
  const ios = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const ip = await ios.newPage(); await ip.goto(BASE + '#/archive'); await ip.waitForSelector('.install-hint');
  check('iPhone이면 Safari 공유 → 홈 화면에 추가 안내', (await ip.textContent('.install-hint')).includes('공유'));
  await ios.close();

  check('브라우저·서비스 워커 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const pass = results.filter(r => r.ok).length;
  console.log(`\n${pass} / ${results.length} 통과`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
