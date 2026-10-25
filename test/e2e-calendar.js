// 캘린더(A안) E2E: 설정에서 연결 → 오늘 화면 일정 → 지금 불러오기 → 연결 해제, 함수 권한, 아침 알림 한 줄
// 실제 DB + calendar-today(Deno, 8001) + 가짜 iCal 서버(4600). 구글 주소 대신 Vault 값을 로컬 주소로 바꿔 끼움
const { chromium } = require('playwright');
const { execFileSync, spawn } = require('child_process');
const http = require('http'), path = require('path');
const jwt = require('jsonwebtoken');

const BASE = 'http://localhost:4400/';
const ROOT = path.join(__dirname, '..');
const DENO = process.env.DENO || path.join(ROOT, 'node_modules/.bin/deno');
const SECRET = 'test-secret-test-secret-test-secret-32';
const sql = q => execFileSync('su', ['postgres', '-c', `psql -h /var/tmp/pgtest -d taskhub -At -q -c "${q.replace(/"/g, '\\"')}"`]).toString().trim();
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
const GOOGLE = 'https://calendar.google.com/calendar/ical/dh%40gmail.com/private-0123456789abcdef0123456789abcdef/basic.ics';
const kill = () => { try { execFileSync('bash', ['-c', "ps -eo pid,args | awk '$2 ~ /deno$/ && /calendar-today|index\\.ts/ {print $1}' | xargs -r kill"]); } catch {} };

(async () => {
  kill(); await sleep(300);
  const D = sql('select app_today()'), Dc = D.replaceAll('-', '');
  const next = sql(`select to_char(date '${D}' + 1, 'YYYYMMDD')`);
  sql(`delete from public.calendar_feeds; delete from vault.secrets where name like 'steward_ical_%'; delete from tasks;`);

  // ---------- 가짜 iCal 서버 ----------
  let icsHits = 0, icsMode = 'ok';
  const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'X-WR-TIMEZONE:Asia/Seoul',
    'BEGIN:VEVENT', `DTSTART;VALUE=DATE:${Dc}`, `DTEND;VALUE=DATE:${next}`, 'UID:a1', 'SUMMARY:사진팀 선별 마감', 'END:VEVENT',
    'BEGIN:VEVENT', `DTSTART;TZID=Asia/Seoul:${Dc}T000000`, `DTEND;TZID=Asia/Seoul:${Dc}T000100`, 'UID:a2', 'SUMMARY:새벽 확인', 'END:VEVENT',
    'BEGIN:VEVENT', `DTSTART;TZID=Asia/Seoul:${Dc}T235500`, `DTEND;TZID=Asia/Seoul:${Dc}T235900`, 'UID:a3', 'SUMMARY:<b>교역자</b> 회의 & 기도', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
  const ics = http.createServer((req, res) => { icsHits++; if (icsMode === 'down') { res.writeHead(500); return res.end(); } res.writeHead(200, { 'content-type': 'text/calendar' }); res.end(ICS); }).listen(4600);

  // ---------- calendar-today ----------
  const service = jwt.sign({ role: 'service_role' }, SECRET, { expiresIn: '1h' });
  const fnLog = [];
  const fn = spawn(DENO, ['run', '--allow-net', '--allow-env', '--node-modules-dir=none', 'index.ts'], {
    cwd: path.join(ROOT, 'supabase/functions/calendar-today'),
    env: { ...process.env, DENO_DIR: '/var/tmp/denotest/.deno', SUPABASE_URL: 'http://localhost:4400', SUPABASE_SERVICE_ROLE_KEY: service, PORT: '8001' },
  });
  fn.stdout.on('data', d => fnLog.push(d.toString())); fn.stderr.on('data', d => fnLog.push(d.toString()));
  // Deno.serve 기본 포트 8000 → 테스트에서는 8000을 그대로 쓰고 8001로 중계
  const relay = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await fetch('http://127.0.0.1:8000' + req.url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }).catch(() => null);
    if (!r) { res.writeHead(502); return res.end(); }
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' }); res.end(Buffer.from(await r.arrayBuffer()));
  }).listen(8001);
  for (let i = 0; i < 120; i++) { try { await fetch('http://localhost:8000/', { method: 'OPTIONS' }); break; } catch { await sleep(500); } }
  const call = async (token, body = {}) => { const r = await fetch('http://localhost:4400/functions/v1/calendar-today', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const userTok = sub => jwt.sign({ sub, role: 'authenticated', aud: 'authenticated' }, SECRET, { expiresIn: '1h' });

  // ---------- 함수 권한 ----------
  check('토큰 없으면 401', (await call(null)).status === 401);
  check('가짜 토큰이면 401', (await call('nope')).status === 401);
  check('익명 키로는 401', (await call(jwt.sign({ role: 'anon' }, SECRET))).status === 401);
  check('연결 전: connected=false', (await call(userTok(A))).json?.connected === false);
  check('service_role인데 user_id 없으면 401', (await call(service, {})).status === 401);

  // ---------- 브라우저 ----------
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  // 새 안내가 뜰 때까지 (이전 안내가 아직 떠 있어도 구분)
  let lastToast = '';
  const toastText = async () => {
    await page.waitForFunction(prev => { const t = document.querySelector('#toast'); return t && !t.hidden && document.querySelector('#toastMsg').textContent !== prev; }, lastToast, { timeout: 20000 });
    lastToast = await page.textContent('#toastMsg'); return lastToast;
  };

  await page.goto(BASE + '#/today'); await page.waitForSelector('.top h1');
  await sleep(800);
  check('연결 전 오늘 화면: 일정 칸 없음', !(await page.$('.cal-row')) && !(await page.textContent('#main')).includes('오늘 일정'));

  await page.goto(BASE + '#/settings'); await page.waitForSelector('#calUrl');
  check('설정: 구글 캘린더 칸과 찾는 법', (await page.textContent('#main')).includes('구글 캘린더') && (await page.textContent('.cal-help')).includes('iCal 형식의 비공개 주소'));
  await page.fill('#calUrl', 'https://calendar.google.com/calendar/ical/dh%40gmail.com/public/basic.ics'); await page.click('[data-set="cal-save"]');
  check('공개 주소는 안내 후 저장 안 함', (await toastText()).includes('비공개 주소') && sql(`select count(*) from calendar_feeds`) === '0');
  await page.fill('#calUrl', 'https://example.com/a.ics'); await page.click('[data-set="cal-save"]');
  check('다른 주소도 안내 후 저장 안 함', (await toastText()).includes('확인해 주세요') && sql(`select count(*) from calendar_feeds`) === '0');

  // 실제 구글 주소 형식으로 저장 → 함수는 구글에서 못 받음(가짜 토큰) → 오류 안내
  await page.fill('#calUrl', GOOGLE); await page.click('[data-set="cal-save"]');
  const t1 = await toastText();
  check('형식 맞는 주소는 저장, Vault에만', sql(`select count(*) from calendar_feeds where user_id='${A}'`) === '1' && sql(`select decrypted_secret from vault.decrypted_secrets where name='steward_ical_${A}'`) === GOOGLE, t1);
  check('구글에서 못 받으면 연결 후 안내', t1.includes('불러오지 못했어요'), t1);
  await page.waitForSelector('[data-set="cal-off"]');
  check('설정: 연결됨 + 오류 안내 + 주소는 화면에 없음', (await page.textContent('#main')).includes('연결되어 있어요') && (await page.$('.set-note.warn')) !== null && !(await page.content()).includes('private-0123456789'));

  // Vault 값을 로컬 가짜 서버로 바꿔 끼우고 다시 불러오기
  sql(`update vault.secrets set secret='http://127.0.0.1:4600/basic.ics' where name='steward_ical_${A}'`);
  await page.click('[data-set="cal-test"]');
  const t2 = await toastText();
  check('지금 불러오기 → 오늘 일정 3개', t2.includes('3개'), t2);
  await page.waitForSelector('[data-set="cal-off"]');
  check('설정: 마지막 확인 시각, 오류 안내 사라짐', (await page.textContent('#main')).includes('마지막 확인') && !(await page.$('.set-note.warn')));

  await page.goto(BASE + '#/today'); await page.waitForSelector('.cal-row');
  const rows = await page.$$eval('.cal-row', els => els.map(e => [e.querySelector('.cal-time').textContent, e.querySelector('.cal-title').textContent, e.classList.contains('past')]));
  check('오늘 화면: 종일 → 시간순', rows.map(r => r[1]).join('|') === '사진팀 선별 마감|새벽 확인|<b>교역자</b> 회의 & 기도', JSON.stringify(rows));
  check('제목은 글자 그대로 (HTML로 해석 안 함)', !(await page.$('.cal-title b')));
  check('시간 표시: 종일 / 시작·끝', rows[0][0] === '종일' && rows[1][0] === '00:0000:01' && rows[2][0] === '23:5523:59', JSON.stringify(rows.map(r => r[0])));
  check('지난 일정은 흐리게', rows[1][2] === true && rows[2][2] === false);
  check('오늘 일정 칸 제목과 개수', (await page.textContent('.sec-h')).replace(/\s+/g, ' ').trim() === '오늘 일정 3');
  const hitsBefore = icsHits;
  await page.click('[data-tab="inbox"]'); await page.click('[data-tab="today"]'); await page.waitForSelector('.cal-row');
  check('탭을 오가도 5분 안에는 다시 받지 않음', icsHits === hitsBefore, `${hitsBefore}→${icsHits}`);
  await page.click('[data-mode="week"]'); await sleep(200);
  check('이번 주 보기에는 일정 칸 없음', !(await page.$('.cal-row')));
  await page.click('[data-mode="today"]');

  // 다른 사용자·service_role
  check('다른 사용자(B)는 연결 안 됨', (await call(userTok(B))).json?.connected === false);
  const svc = await call(service, { user_id: A, date: D });
  check('아침 알림용 호출(service_role + user_id) → 같은 일정', svc.json?.connected === true && svc.json.total === 3, JSON.stringify(svc.json));
  check('다른 날짜를 물으면 그날 기준', (await call(userTok(A), { date: sql(`select (date '${D}' + 3)::text`) })).json?.total === 0);

  // 함수 로그에 주소·일정 제목 없음
  await sleep(200);
  const logs = fnLog.join('');
  check('함수 로그에 주소·일정 제목 없음', !logs.includes('basic.ics') && !logs.includes('private-') && !logs.includes('교역자') && !logs.includes('4600'), logs.slice(0, 200));

  // 해제
  await page.goto(BASE + '#/settings'); await page.waitForSelector('[data-set="cal-off"]');
  await page.click('[data-set="cal-off"]');
  check('연결 해제', (await toastText()).includes('해제') && sql(`select count(*) from calendar_feeds`) === '0' && sql(`select count(*) from vault.secrets where name like 'steward_ical_%'`) === '0');
  await page.waitForSelector('#calUrl');
  await page.goto(BASE + '#/today'); await sleep(500);
  check('해제 후 오늘 화면에 일정 없음', !(await page.$('.cal-row')));

  // 함수가 아직 배포 안 됐을 때(404)도 화면은 그대로
  kill(); await sleep(500);
  const page2 = await ctx.newPage(); const err2 = []; page2.on('pageerror', e => err2.push(e.message));
  await page2.goto(BASE + '#/today'); await page2.waitForSelector('.top h1'); await sleep(800);
  check('함수가 없어도 오늘 화면 정상, 오류 없음', !(await page2.$('.cal-row')) && err2.length === 0 && (await page2.$('.empty-big, .sec')) !== null, err2.join(' '));

  check('페이지 오류 없음', errors.filter(e => !/Failed to load resource|calendar/.test(e)).length === 0, errors.join(' | '));
  await page.screenshot({ path: '/var/tmp/taskhub-test/cal-today.png' }).catch(() => {});
  await browser.close(); ics.close(); relay.close();
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass} / ${results.length} 통과`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); kill(); process.exit(2); });
