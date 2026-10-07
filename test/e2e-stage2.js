// 2단계 E2E: 해시 라우팅 + 날짜 변경 처리 (Playwright 가짜 시계로 자정 넘기기)
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');

const BASE = 'http://localhost:4400/';
const sql = q => execFileSync('su', ['postgres', '-c', `psql -h /var/tmp/pgtest -d taskhub -At -c "${q.replace(/"/g, '\\"')}"`]).toString().trim();
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const D = '2026-10-08', D1 = '2026-10-09';
const U = "'11111111-1111-1111-1111-111111111111'";

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const newPage = async (startTime) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    if (startTime) await page.clock.install({ time: new Date(startTime) });
    return page;
  };
  const idle = page => page.waitForFunction(() => window.__taskhub && window.__taskhub.pending === 0);
  const h1 = page => page.textContent('.top h1');

  // ---------- 라우팅 ----------
  sql('delete from tasks; delete from recent_waiting;');
  sql(`insert into tasks(user_id,title,status) values (${U},'인박스 업무','inbox');`);
  let page = await newPage();
  await page.goto(BASE + '#/inbox'); await page.waitForSelector('.top h1');
  check('#/inbox로 바로 열기', (await h1(page)) === '인박스' && await page.getAttribute('[data-tab="inbox"]', 'aria-current') === 'page');
  await page.click('[data-tab="waiting"]'); await page.waitForFunction(() => location.hash === '#/waiting');
  check('하단 탭 → 주소 #/waiting', (await h1(page)) === '대기');
  await page.goBack(); await page.waitForFunction(() => location.hash === '#/inbox');
  check('뒤로 가기 → 인박스', (await h1(page)) === '인박스');
  await page.click('[data-tab="today"]'); await page.waitForFunction(() => location.hash === '#/today');
  const lenBefore = await page.evaluate(() => history.length);
  await page.click('.seg [data-mode="week"]'); await page.waitForFunction(() => location.hash === '#/today/week');
  check('이번 주 전환 → #/today/week (뒤로 가기 기록 안 늘림)', (await page.evaluate(() => history.length)) === lenBefore);
  await page.reload(); await page.waitForSelector('.top h1');
  check('새로고침해도 이번 주 보기 유지', (await page.getAttribute('.seg [data-mode="week"]', 'aria-pressed')) === 'true');
  await page.goto(BASE + '#/archive/done'); await page.waitForSelector('.top h1');
  check('#/archive/done → 보관 · 완료', (await h1(page)) === '보관' && (await page.getAttribute('.seg [data-arch="done"]', 'aria-pressed')) === 'true');
  await page.goto(BASE + '#/없는주소'); await page.waitForSelector('.top h1');
  check('없는 주소 → #/today로', (await page.evaluate(() => location.hash)) === '#/today');
  await page.context().close();

  // ---------- 자정 넘기기 ----------
  sql('delete from tasks;');
  sql(`insert into tasks(user_id,title,status,do_date) values (${U},'A 오늘 업무','active','${D}'), (${U},'B 내일 업무','active','${D1}');`);
  sql(`insert into tasks(user_id,title,status,due_date) values (${U},'C 내일 마감 인박스','inbox','${D1}');`);
  page = await newPage('2026-10-08T23:59:20+09:00');
  await page.goto(BASE + '#/today'); await page.waitForSelector('.row');
  let titles = await page.locator('#main .row-title').allTextContents();
  check('자정 전: 10월 8일, 오늘 업무만', (await h1(page)).startsWith('10월 8일') && titles.join() === 'A 오늘 업무', titles.join(' / '));
  await page.clock.runFor(45_000); await idle(page);
  await page.waitForFunction(() => document.querySelector('.top h1').textContent.startsWith('10월 9일'));
  titles = await page.locator('#main .row-title').allTextContents();
  check('자정 지나면 자동으로 10월 9일', true, await h1(page));
  check('내일 업무·내일 마감이 오늘로 올라옴', ['A 오늘 업무', 'B 내일 업무', 'C 내일 마감 인박스'].every(t => titles.includes(t)), titles.join(' / '));
  check('어제 업무는 "1일째 남음"', await page.locator('.row', { hasText: 'A 오늘 업무' }).locator('text=1일째 남음').isVisible());
  check('인박스 업무에 "오늘 마감" 표시', await page.locator('.row', { hasText: 'C 내일 마감 인박스' }).locator('text=오늘 마감').isVisible());

  // 빠른 추가 시트가 열린 채 자정 → 닫히고 안내
  // 시간만 다음 날 밤으로 옮김 (자정 타이머는 하루 뒤로 잡혀 있으므로 1분 간격 확인이 처리하는지 검증)
  await page.clock.setSystemTime('2026-10-09T23:59:40+09:00');
  await page.click('#addBtn'); await page.waitForSelector('#addTitle');
  await page.clock.runFor(70_000);
  await page.waitForFunction(() => document.getElementById('sheet').hidden);
  check('빠른 추가 열린 채 자정 → 시트 닫힘', await page.locator('#sheet').isHidden());
  check('"날짜가 바뀌었어요" 안내', (await page.textContent('#toastMsg')) === '날짜가 바뀌었어요');
  await page.context().close();

  // 상세에서 메모 입력 중 자정 → 입력 내용 저장, 상세 유지
  page = await newPage('2026-10-08T23:59:50+09:00');
  await page.goto(BASE + '#/today'); await page.waitForSelector('.row');
  await page.locator('.row', { hasText: 'A 오늘 업무' }).locator('.row-title').click();
  await page.click('#dMemo'); await page.keyboard.type('자정 직전 메모');
  await page.clock.runFor(15_000); await idle(page);
  await page.waitForFunction(() => document.querySelector('.top h1').textContent.startsWith('10월 9일'));
  check('메모 입력 중 자정 → 상세 시트 유지', await page.locator('#dMemo').isVisible());
  check('입력하던 메모 화면에 그대로', (await page.inputValue('#dMemo')) === '자정 직전 메모');
  await page.waitForTimeout(300); await idle(page);
  check('입력하던 메모 DB 저장', sql("select memo from tasks where title='A 오늘 업무'") === '자정 직전 메모');
  check('상세의 "할 날" 칩이 새 날짜 기준', (await page.getAttribute('#dDo [data-do]', 'data-do')) === D1, await page.getAttribute('#dDo [data-do]', 'data-do'));
  await page.click('.sheet-foot [data-close]');
  await page.context().close();

  // 백그라운드에 있다가 돌아왔을 때 (타이머가 멈춰 있던 경우)
  page = await newPage('2026-10-08T10:00:00+09:00');
  await page.goto(BASE + '#/today'); await page.waitForSelector('.top h1');
  await page.clock.pauseAt('2026-10-08T10:00:05+09:00');
  await page.clock.setSystemTime('2026-10-09T08:30:00+09:00');   // 타이머 실행 없이 시간만 점프
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => document.querySelector('.top h1').textContent.startsWith('10월 9일'));
  check('다음 날 앱으로 돌아오면 날짜 갱신', true, await h1(page));
  await page.clock.resume();

  // 다른 기기에서 추가한 업무가 앱으로 돌아올 때 보임 (30초 이상 지난 경우)
  sql(`insert into tasks(user_id,title,status,do_date) values (${U},'D 다른 기기에서 추가','active','${D1}');`);
  await page.clock.setSystemTime('2026-10-09T08:31:00+09:00');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForSelector('.row:has-text("D 다른 기기에서 추가")', { timeout: 5000 }).catch(() => {});
  check('돌아올 때 서버 변경 반영', await page.locator('.row', { hasText: 'D 다른 기기에서 추가' }).isVisible());
  await page.context().close();

  check('브라우저 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const pass = results.filter(r => r.ok).length;
  console.log(`\n${pass} / ${results.length} 통과`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
