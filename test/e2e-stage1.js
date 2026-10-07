// 1단계 E2E: 실제 브라우저(모바일 크기) → 로컬 PostgREST → PostgreSQL(최종 스키마 + RLS)
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');

const BASE = 'http://localhost:4400/';
const PG = ['-h', '/var/tmp/pgtest', '-d', 'taskhub', '-At', '-c'];
const sql = q => execFileSync('su', ['postgres', '-c', `psql ${PG.slice(0, 4).join(' ')} -At -c "${q.replace(/"/g, '\\"')}"`]).toString().trim();
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  sql("delete from tasks; delete from recent_waiting;");
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: false, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/\[taskhub\]/.test(m.text())) console.log('   app log:', m.text().slice(0, 200)); else if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const patches = [];
  page.on('request', r => { if (r.url().includes('/rest/v1/tasks') && r.method() === 'PATCH') patches.push(r.url()); });

  const idle = async () => { await page.waitForFunction(() => window.__taskhub && window.__taskhub.pending === 0); await sleep(150); };

  // 1. 첫 화면
  await page.goto(BASE);
  await page.waitForSelector('.top h1');
  check('앱 로드 · 빈 TODAY', await page.locator('text=오늘 할 일 없음').isVisible());

  // 2. 빠른 추가 (오늘 기본) 연속 3개
  await page.click('#addBtn');
  for (const t of ['주보 최종 검토', '사진 선별 확인', 'OBS 오디오 재확인']) { await page.fill('#addTitle', t); await page.press('#addTitle', 'Enter'); await idle(); }
  // 인박스로 1개
  await page.click('[data-when="inbox"]'); await page.fill('#addTitle', '인스타 하이라이트 시안'); await page.press('#addTitle', 'Enter'); await idle();
  await page.click('.sheet [data-close].btn');
  check('빠른 추가 4건 DB 저장', sql("select count(*) from tasks") === '4', sql("select string_agg(status||':'||title, ', ' order by created_at) from tasks"));
  check('오늘로 추가한 업무 do_date = 한국 오늘', sql("select count(*) from tasks where status='active' and do_date = app_today()") === '3');
  check('인박스 배지 1', (await page.textContent('#inboxBadge')) === '1');

  // 3. 완료 + 되돌리기
  const row = page.locator('.row', { hasText: 'OBS 오디오 재확인' });
  await row.locator('.check').click(); await idle();
  check('완료 → DB done + done_at', sql("select status||'|'||(done_at is not null) from tasks where title='OBS 오디오 재확인'") === 'done|true');
  await page.click('#toastUndo'); await idle();
  check('완료 되돌리기 → DB active', sql("select status||'|'||(done_at is null) from tasks where title='OBS 오디오 재확인'") === 'active|true');

  // 4. 반복 설정 후 완료 → 다음 회차 생성
  await sleep(1000);
  await page.locator('.row', { hasText: '사진 선별 확인' }).locator('.row-title').click();
  await page.click('details.more summary');
  await page.click('[data-rp="weekly"]'); await idle();
  await page.click('.sheet-foot [data-close]'); await idle();
  check('반복 설정 → series 자동 생성', sql("select (repeat_rule='weekly' and series_id is not null)::text from tasks where title='사진 선별 확인'") === 'true');
  await page.locator('.row', { hasText: '사진 선별 확인' }).locator('.check').click(); await idle();
  const toastText = await page.textContent('#toastMsg');
  check('반복 완료 → 다음 회차 1개', sql("select count(*) from tasks where title='사진 선별 확인' and status='active' and do_date = app_today()+7 and source='repeat'") === '1', toastText);

  // 5. 왼쪽 밀기 → 미루기 → 내일
  await sleep(1000);
  await page.waitForSelector('.row:has-text("주보 최종 검토")');
  const box = await page.locator('.row', { hasText: '주보 최종 검토' }).boundingBox();
  await page.mouse.move(box.x + box.width - 30, box.y + box.height / 2); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width - 30 - i * 15, box.y + box.height / 2);
  await page.mouse.up();
  await page.waitForSelector('.sheet h2:has-text("미루기")');
  await page.click('[data-label="내일"]'); await idle();
  check('밀어서 내일로 미루기', sql("select (do_date = app_today()+1)::text from tasks where title='주보 최종 검토'") === 'true');
  await page.click('#toastUndo'); await idle();
  check('미루기 되돌리기', sql("select (do_date = app_today())::text from tasks where title='주보 최종 검토'") === 'true');

  // 6. 대기 전환 → 확인일 기본 3일 후, 최근 대상 저장
  await sleep(300);
  await page.locator('.row', { hasText: 'OBS 오디오 재확인' }).locator('.row-title').click();
  await page.click('[data-st="waiting"]');
  await page.fill('#whoInput', '준석'); await page.click('#wDone'); await idle();
  check('대기 전환 (준석, 3일 후)', sql("select waiting_for||'|'||(follow_up_date = app_today()+3) from tasks where title='OBS 오디오 재확인'") === '준석|true');
  check('최근 대기 대상 기록', sql("select string_agg(name, ',') from recent_waiting") === '준석');
  await page.click('.sheet-foot [data-close]'); await idle();

  // 7. 대기 해제 → 대기 정보 비움 (상세에서 진행)
  await page.click('[data-tab="waiting"]');
  await page.locator('.row', { hasText: 'OBS 오디오 재확인' }).locator('.row-title').click();
  await page.click('[data-st="active"]'); await idle();
  await page.click('.sheet-foot [data-close]'); await idle();
  check('대기 → 진행: 대기 정보 비움 + 오늘', sql("select coalesce(waiting_for,'∅')||'|'||coalesce(follow_up_date::text,'∅')||'|'||(do_date=app_today()) from tasks where title='OBS 오디오 재확인'") === '∅|∅|true');

  // 8. 메모 입력은 지연 저장 (글자마다 요청하지 않음)
  await page.click('[data-tab="today"]');
  await page.locator('.row', { hasText: '주보 최종 검토' }).locator('.row-title').click();
  const before = patches.length;
  await page.click('#dMemo'); await page.keyboard.type('성원 전도사님 체크 후 확정', { delay: 40 });
  await sleep(800); await idle();
  const memoPatches = patches.length - before;
  check('메모 15자 입력 → 저장 요청 1~2회', memoPatches >= 1 && memoPatches <= 2, `${memoPatches}회`);
  check('메모 DB 반영', sql("select memo from tasks where title='주보 최종 검토'") === '성원 전도사님 체크 후 확정');
  // 입력 직후 바로 닫아도 저장
  await page.click('#dMemo'); await page.keyboard.type(' (금)'); await page.click('.sheet-foot [data-close]'); await idle();
  check('입력 직후 닫아도 저장', sql("select memo from tasks where title='주보 최종 검토'") === '성원 전도사님 체크 후 확정 (금)');

  // 9. 인박스 정리
  await page.click('.banner'); await page.click('[data-tr="today"]'); await idle();
  check('인박스 정리 → 오늘', sql("select status||'|'||(do_date=app_today()) from tasks where title='인스타 하이라이트 시안'") === 'active|true');

  // 10. 삭제 + 되돌리기 (soft delete)
  await page.locator('.row', { hasText: '인스타 하이라이트 시안' }).locator('.row-title').click();
  await page.click('#dDel'); await idle();
  check('삭제 → deleted_at 기록 (행은 남음)', sql("select (deleted_at is not null)::text from tasks where title='인스타 하이라이트 시안'") === 'true');
  await page.click('#toastUndo'); await idle();
  check('삭제 되돌리기', sql("select (deleted_at is null)::text from tasks where title='인스타 하이라이트 시안'") === 'true');

  // 11. 새로고침 후 유지
  await page.reload(); await page.waitForSelector('.row');
  const titles = await page.locator('.row-title').allTextContents();
  check('새로고침 후 서버 데이터 그대로', titles.length === 3 && titles.some(x => x.includes('OBS')) && titles.some(x => x.includes('주보')), titles.join(' / '));

  // 12. 저장 실패 처리: 네트워크 끊김 → 화면 되돌림 + 저장 실패 표시
  await page.route('**/rest/v1/tasks**', r => r.request().method() === 'PATCH' ? r.abort('internetdisconnected') : r.continue());
  const b2 = await page.locator('.row', { hasText: '주보 최종 검토' }).boundingBox();
  await page.mouse.move(b2.x + b2.width - 30, b2.y + b2.height / 2); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(b2.x + b2.width - 30 - i * 15, b2.y + b2.height / 2);
  await page.mouse.up();
  await page.click('[data-label="내일"]'); await idle();
  check('끊김 시 토스트 안내', /연결이 끊겨|저장하지 못했어요/.test(await page.textContent('#toastMsg')), await page.textContent('#toastMsg'));
  check('끊김 시 화면 원래대로', await page.locator('.row', { hasText: '주보 최종 검토' }).isVisible());
  check('끊김 시 "저장 실패" 표시', (await page.textContent('.top .saved')) === '저장 실패');
  check('끊김 시 DB 변경 없음', sql("select (do_date=app_today())::text from tasks where title='주보 최종 검토'") === 'true');
  await page.unroute('**/rest/v1/tasks**');

  // 13. 다른 사용자: 내 업무가 안 보임
  const page2 = await ctx.newPage();
  await page2.route('**/config.js', r => r.continue({ url: BASE + 'config.js?u=b' }));
  await page2.goto(BASE); await page2.waitForSelector('.top h1');
  check('다른 사용자 화면: 업무 0건', (await page2.locator('.row').count()) === 0);

  check('브라우저 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  const pass = results.filter(r => r.ok).length;
  console.log(`\n${pass} / ${results.length} 통과`);
  require('fs').writeFileSync(__dirname + '/stage1-results.json', JSON.stringify(results, null, 2));
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
