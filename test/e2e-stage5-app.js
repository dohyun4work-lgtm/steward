// 5단계 앱 E2E: 알림 설정 화면 · 이 기기 구독 · 열람/완료 기록 · 로그아웃 시 구독 해제
// 브라우저 푸시 구독은 headless에서 실제 푸시 서비스가 없어 PushManager만 흉내 냄 (나머지는 실제 DB·Edge Function)
const { chromium } = require('playwright');
const { execFileSync, spawn } = require('child_process');
const path = require('path');
const jwt = require('jsonwebtoken');

const BASE = 'http://localhost:4400/';
const ROOT = path.join(__dirname, '..');
const DENO = process.env.DENO || '/tmp/claude-0/-home-claude/67b0715b-db09-5926-96b5-20cb6992ef70/scratchpad/node_modules/.bin/deno';
const sql = q => execFileSync('su', ['postgres', '-c', `psql -h /var/tmp/pgtest -d taskhub -At -q -c "${q.replace(/"/g, '\\"')}"`]).toString().trim();
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = '11111111-1111-1111-1111-111111111111';

(async () => {
  try { execFileSync('bash', ['-c', "ps -eo pid,args | awk '$2 ~ /deno$/ && /index\\.ts/ {print $1}' | xargs -r kill"]); } catch {}
  sql('delete from notification_log; delete from push_subscriptions; delete from checkin_slots; delete from notification_prefs; delete from tasks; delete from daily_reviews;');
  const service = jwt.sign({ role: 'service_role' }, 'test-secret-test-secret-test-secret-32', { expiresIn: '1h' });
  const fn = spawn(DENO, ['run', '--allow-net', '--allow-env', '--node-modules-dir=none', 'index.ts'], {
    cwd: path.join(ROOT, 'supabase/functions/send-checkins'),
    env: { ...process.env, DENO_DIR: '/var/tmp/denotest/.deno', SUPABASE_URL: 'http://localhost:4400', SUPABASE_SERVICE_ROLE_KEY: service },
  });
  for (let i = 0; i < 60; i++) { try { await fetch('http://localhost:8000/'); break; } catch { await sleep(500); } }

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul' });
  await ctx.grantPermissions(['notifications'], { origin: 'http://localhost:4400' });
  await ctx.addInitScript(() => {
    let current = null; window.__push = { keys: [], unsubscribed: 0 };
    const mk = () => ({ endpoint: 'https://localhost:4500/ok/app', toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'B' + 'x'.repeat(86), auth: 'y'.repeat(22) } }; },
      async unsubscribe() { current = null; window.__push.unsubscribed++; return true; } });
    if (window.PushManager) {
      PushManager.prototype.subscribe = async function (o) { window.__push.keys.push(btoa(String.fromCharCode(...new Uint8Array(o.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')); current = mk(); return current; };
      PushManager.prototype.getSubscription = async function () { return current; };
    }
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  const idle = async () => { await page.waitForFunction(() => window.__taskhub && window.__taskhub.pending === 0); await sleep(250); };
  const slotEl = time => page.locator('.set-slot', { has: page.locator('.set-time', { hasText: time }) });
  const openSlot = async time => { if (!(await slotEl(time).evaluate(e => e.open))) await slotEl(time).locator('summary .set-kind').click(); };

  // ---------- 설정 화면 ----------
  await page.goto(BASE + '#/archive'); await page.waitForSelector('[data-act="settings"]');
  await page.click('[data-act="settings"]'); await page.waitForSelector('.set-slot');
  check('보관 → 알림 설정, 기본 6개 시간', (await page.evaluate(() => location.hash)) === '#/settings' && (await page.locator('.set-time').allTextContents()).join(' ') === '09:00 12:00 15:00 18:00 21:00 23:00');
  check('하단 탭은 보관이 선택된 상태', (await page.getAttribute('[data-tab="archive"]', 'aria-current')) === 'page');
  await slotEl('15:00').locator('input.switch').click(); await idle();
  check('15시 끄기 → 저장, 행 흐리게', sql("select enabled from checkin_slots where local_time='15:00'") === 'f' && await slotEl('15:00').evaluate(e => e.classList.contains('off')));
  check('스위치를 눌러도 행이 펼쳐지지 않음', !(await slotEl('15:00').evaluate(e => e.open)));
  await openSlot('09:00');
  await page.locator('.set-slot[open] input[type=time]').fill('08:30'); await page.locator('.set-slot[open] input[type=time]').dispatchEvent('change'); await idle();
  check('아침 시간 08:30으로 변경 → 저장·정렬', sql("select to_char(local_time,'HH24:MI') from checkin_slots where kind='morning'") === '08:30' && (await page.locator('.set-time').first().textContent()) === '08:30');
  await openSlot('08:30');
  check('저장해도 펼친 행은 그대로 열려 있음', await slotEl('08:30').evaluate(e => e.open));
  await page.locator('.set-slot[open] input[type=time]').fill('08:33'); await page.locator('.set-slot[open] input[type=time]').dispatchEvent('change'); await sleep(300);
  check('5분 단위가 아니면 안내만, 저장 안 함', (await page.textContent('#toastMsg')).includes('5분 단위') && sql("select to_char(local_time,'HH24:MI') from checkin_slots where kind='morning'") === '08:30');
  await page.locator('.set-slot[open] input[type=time]').fill('12:00'); await page.locator('.set-slot[open] input[type=time]').dispatchEvent('change'); await idle();
  check('이미 있는 시각(12:00)이면 "같은 시각" 안내 후 되돌림', (await page.textContent('#toastMsg')).includes('같은 시각') && sql("select to_char(local_time,'HH24:MI') from checkin_slots where kind='morning'") === '08:30' && (await page.locator('.set-time').first().textContent()) === '08:30');
  await openSlot('18:00');
  await slotEl('18:00').locator('[data-day="0"]').click(); await idle(); await slotEl('18:00').locator('[data-day="6"]').click(); await idle();
  check('18시 요일에서 토·일 빼기 → 평일', sql("select weekdays::text from checkin_slots where kind='evening'") === '{1,2,3,4,5}' && (await slotEl('18:00').locator('.set-kind small').textContent()) === '평일');
  await page.click('#setAll'); await idle();
  check('전체 알림 끄기 → 저장', sql('select enabled from notification_prefs') === 'f');

  // ---------- 이 기기 구독 ----------
  check('이 기기: 꺼짐 + 켜기 버튼', await page.locator('[data-set="sub-on"]').isVisible());
  await page.click('[data-set="sub-on"]'); await page.waitForSelector('[data-set="sub-off"]', { timeout: 8000 }).catch(() => {}); await idle();
  const fnKey = await (await fetch('http://localhost:8000/?vapid=public')).json();
  check('켜기 → 서버 공개키로 구독, 기기 등록', (await page.evaluate(() => window.__push.keys[0])) === fnKey.publicKey && sql("select device_label||'|'||(disabled_at is null) from push_subscriptions") === 'Windows PC|true' || sql("select count(*) from push_subscriptions where disabled_at is null") === '1', sql('select device_label from push_subscriptions'));
  check('켜면 전체 알림도 다시 켜짐', sql('select enabled from notification_prefs') === 't');
  check('이 기기: 받는 중 + 끄기·모양 확인 버튼', await page.locator('[data-set="sub-off"]').isVisible() && await page.locator('[data-set="preview"]').isVisible());
  await page.click('[data-set="preview"]'); await sleep(500);
  check('알림 모양 확인 → 기기에 알림 표시', (await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(n => n.tag).join())) === 'steward-preview');
  sql(`insert into push_subscriptions(user_id, endpoint, p256dh, auth, device_label, last_success_at) values ('${A}','https://push.example/other','${'B'.repeat(87)}','${'y'.repeat(22)}','iPad', now())`);
  await page.goto(BASE + '#/today'); await page.goto(BASE + '#/settings'); await page.waitForSelector('.set-dev');
  check('다른 기기 목록 (이 기기는 제외)', (await page.locator('.set-dev b').allTextContents()).join() === 'iPad');
  await page.click('[data-set="dev-del"]'); await idle();
  check('다른 기기 삭제', sql("select count(*) from push_subscriptions where device_label='iPad'") === '0' && !(await page.locator('.set-dev').count()));
  await page.click('[data-set="sub-off"]'); await page.waitForSelector('[data-set="sub-on"]', { timeout: 8000 }).catch(() => {}); await idle();
  check('이 기기 끄기 → 서버에서 삭제 + 브라우저 구독 해제', sql('select count(*) from push_subscriptions') === '0' && (await page.evaluate(() => window.__push.unsubscribed)) === 1);

  // ---------- 알림으로 들어온 체크인 기록 ----------
  const D = sql('select app_today()');
  const slotId = sql("select id from checkin_slots where kind='midday' and local_time='12:00'");
  const logId = sql(`insert into notification_log(user_id, slot_id, kind, local_date, due_at, status) values ('${A}','${slotId}','midday','${D}', now(), 'sent') returning id`).split('\n')[0];
  await page.goto(BASE + `#/checkin/midday?d=${D}&n=${logId}`); await page.waitForSelector('#ciDone'); await sleep(500);
  check('알림으로 열면 열람 기록', sql(`select (opened_at is not null)::text from notification_log where id='${logId}'`) === 'true');
  await page.click('#ciDone'); await sleep(500);
  check('확인 완료 → 완료 기록', sql(`select (completed_at is not null)::text from notification_log where id='${logId}'`) === 'true');
  const mSlot = sql("select id from checkin_slots where kind='morning'");
  const mLog = sql(`insert into notification_log(user_id, slot_id, kind, local_date, due_at, status) values ('${A}','${mSlot}','morning','${D}', now(), 'sent') returning id`).split('\n')[0];
  await page.goto(BASE + `#/checkin/morning?d=${D}&n=${mLog}`); await page.waitForSelector('.cc-card'); await page.click('[data-act="cc-close"]'); await sleep(500);
  check('아침 카드 닫기 → 열람·완료 기록', sql(`select (opened_at is not null and completed_at is not null)::text from notification_log where id='${mLog}'`) === 'true');

  // ---------- 로그아웃하면 이 기기 구독 해제 ----------
  await page.goto(BASE + '#/settings'); await page.waitForSelector('[data-set="sub-on"]');
  await page.click('[data-set="sub-on"]'); await page.waitForSelector('[data-set="sub-off"]', { timeout: 8000 }).catch(() => {}); await idle();
  const before = sql('select count(*) from push_subscriptions');
  await page.goto(BASE + '#/archive'); await page.waitForSelector('[data-act="signout"]'); await page.click('[data-act="signout"]'); await sleep(800);
  check('로그아웃 → 이 기기 구독 해제', before === '1' && sql('select count(*) from push_subscriptions') === '0');
  await ctx.close();

  // ---------- iPhone 브라우저 ----------
  const ios = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const ip = await ios.newPage(); await ip.goto(BASE + '#/settings'); await ip.waitForSelector('.set-card');
  check('iPhone Safari면 "홈 화면 앱에서만" 안내, 켜기 버튼 없음', (await ip.textContent('.set-card')).includes('홈 화면에 추가한 Steward 앱') && !(await ip.locator('[data-set="sub-on"]').count()));
  await ios.close();

  check('브라우저 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close(); fn.kill();
  sql('delete from notification_log; delete from push_subscriptions; delete from checkin_slots; delete from notification_prefs;');
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass} / ${results.length} 통과`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); try { execFileSync('bash', ['-c', "ps -eo pid,args | awk '$2 ~ /deno$/ && /index\\.ts/ {print $1}' | xargs -r kill"]); } catch {} process.exit(2); });
