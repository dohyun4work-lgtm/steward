// 3단계 E2E: 체크인 화면 4종 + 하루 복기 (가짜 시계로 시간대 맞춤, 결과는 DB에서 확인)
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');

const BASE = 'http://localhost:4400/';
const sql = q => execFileSync('su', ['postgres', '-c', `psql -h /var/tmp/pgtest -d taskhub -At -c "${q.replace(/"/g, '\\"')}"`]).toString().trim();
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const U = "'11111111-1111-1111-1111-111111111111'";
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 서버 RPC(복기 저장)는 실제 날짜를 쓰므로 테스트 날짜도 서버의 오늘에 맞춤
const D = sql('select app_today()');
const add = (d, n) => sql(`select ('${d}'::date + ${n})::text`);
const D0 = add(D, -1), D1 = add(D, 1), D2 = add(D, -2);
const at = (day, hm) => `${day}T${hm}:00+09:00`;
const ins = (title, cols) => sql(`insert into tasks(user_id,title,${Object.keys(cols).join(',')}) values (${U},'${title}',${Object.values(cols).map(v => `'${v}'`).join(',')}) returning id`).split('\n')[0];
const reset = () => sql('delete from daily_reviews; delete from tasks; delete from recent_waiting;');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const open = async (time, hash) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.clock.install({ time: new Date(time) });
    await page.goto(BASE + hash); await page.waitForSelector('.top h1');
    await page.waitForFunction(() => window.__taskhub && window.__taskhub.pending === 0);
    return page;
  };
  const idle = async page => { await page.waitForFunction(() => window.__taskhub.pending === 0); await page.clock.runFor(300); await sleep(150); };
  const hash = page => page.evaluate(() => location.hash);
  const sheetTitles = page => page.locator('#sheet .row-title').allTextContents();

  // ---------- 09:00 아침 ----------
  reset();
  const top = ins('주보 최종 검토', { status: 'active', do_date: D });
  ins('사진 선별 확인', { status: 'active', do_date: D });
  sql(`insert into daily_reviews(user_id,review_date,note,top_task_id) values (${U},'${D0}','어제 한 줄','${top}')`);
  let page = await open(at(D, '09:00'), `#/checkin/morning?d=${D}&n=test`);
  check('아침: TODAY + 아침 카드', await page.locator('.cc-card').isVisible() && (await page.textContent('.top h1')).includes('일'));
  check('아침: 어제 정한 "오늘 가장 중요한 일" 표시', (await page.locator('.cc-card').textContent()).includes('주보 최종 검토'));
  check('아침: 개수 요약', (await page.textContent('.cc-counts')).includes('오늘 2'), await page.textContent('.cc-counts'));
  await page.click('[data-act="cc-close"]');
  check('아침: 닫기 → 카드 사라짐, 주소 #/today', !(await page.locator('.cc-card').count()) && (await hash(page)) === '#/today');
  await page.reload(); await page.waitForSelector('.row');
  check('아침: 다시 열어도 카드 안 나옴', !(await page.locator('.cc-card').count()));
  await page.goto(BASE + `#/checkin/morning?d=${D0}`); await sleep(300);
  check('지난 알림(어제 날짜) → 오늘 화면 + 안내', (await hash(page)) === '#/today' && (await page.textContent('#toastMsg')).includes('어제 알림'), await page.textContent('#toastMsg'));
  await page.context().close();

  // ---------- 12:00 중간 체크 ----------
  reset();
  ins('기한 지난 견적', { status: 'active', do_date: D2, due_date: D0 });
  ins('주보 최종 검토', { status: 'active', do_date: D });
  ins('오늘 마감 인박스', { status: 'inbox', due_date: D });
  ins('내일 업무', { status: 'active', do_date: D1 });
  page = await open(at(D, '12:00'), `#/checkin/midday?d=${D}`);
  let t = await sheetTitles(page);
  check('중간 체크: 남은 업무만 (기한 초과 먼저)', t.length === 3 && t[0] === '기한 지난 견적' && !t.includes('내일 업무'), t.join(' / '));
  await page.fill('#ciAddTitle', '점심에 생각난 일'); await page.press('#ciAddTitle', 'Enter'); await idle(page);
  check('중간 체크: 바로 추가 → 오늘 할 일로 저장', sql(`select status||'|'||(do_date='${D}') from tasks where title='점심에 생각난 일'`) === 'active|true');
  check('중간 체크: 추가 후 목록 갱신 + 입력창 유지', (await sheetTitles(page)).length === 4 && await page.locator('#ciAddTitle').isVisible());
  await page.locator('#sheet .row', { hasText: '주보 최종 검토' }).locator('.check').click(); await idle(page);
  check('중간 체크: 시트 안에서 완료', sql("select status from tasks where title='주보 최종 검토'") === 'done' && (await page.textContent('#sheet .progress')).includes('완료 1'));
  await page.locator('#sheet .row-title', { hasText: '오늘 마감 인박스' }).click(); await page.waitForSelector('#dTitle');
  await page.click('.sheet-foot [data-close]'); await sleep(200);
  check('중간 체크: 상세 보고 닫으면 중간 체크로 복귀', await page.locator('#sheet h2', { hasText: '중간 체크' }).isVisible());
  await page.click('#ciDone'); await sleep(200);
  check('중간 체크: 확인 완료 → 닫힘, 주소 #/today', (await page.locator('#sheet').isHidden()) && (await hash(page)) === '#/today');
  await page.context().close();

  // ---------- 18:00 저녁 재조정 ----------
  reset();
  ins('A 기한 초과', { status: 'active', do_date: D2, due_date: D0 });
  ins('B 오늘 업무', { status: 'active', do_date: D });
  ins('C 오늘 업무2', { status: 'active', do_date: D });
  page = await open(at(D, '18:00'), `#/checkin/evening?d=${D}`);
  check('저녁 재조정: 한 장씩 1 / 3, 첫 버튼 "오늘 유지"', (await page.textContent('#sheet .progress')) === '1 / 3' && (await page.locator('.triage-actions .btn').first().textContent()) === '오늘 유지');
  check('저녁 재조정: 기한 초과가 먼저', (await page.textContent('.triage-card .t')) === 'A 기한 초과');
  await page.click('[data-ev="keep"]');
  await page.click('[data-ev="wait"]'); await page.fill('#whoInput', '준석'); await page.click('#wDone'); await idle(page);
  check('저녁 재조정: 대기 → 대상·확인일 저장', sql("select status||'|'||waiting_for from tasks where title='B 오늘 업무'") === 'waiting|준석');
  check('저녁 재조정: 대기 처리 후 다음 카드로', (await page.textContent('#sheet .progress')) === '3 / 3' && (await page.textContent('.triage-card .t')) === 'C 오늘 업무2');
  await page.click('[data-ev="tomorrow"]'); await idle(page);
  check('저녁 재조정: 내일 → 할 날 내일', sql(`select (do_date='${D1}')::text from tasks where title='C 오늘 업무2'`) === 'true');
  check('저녁 재조정: 끝나면 닫힘 + "오늘 1개 남김"', (await page.locator('#sheet').isHidden()) && (await page.textContent('#toastMsg')).includes('1개 남김'), await page.textContent('#toastMsg'));
  check('저녁 재조정: 오늘 유지한 업무는 그대로', sql("select (do_date < app_today())::text from tasks where title='A 기한 초과'") === 'true');
  await page.context().close();

  // ---------- 21:00 오늘 마무리 ----------
  reset();
  ins('X 기한 초과', { status: 'active', do_date: D2, due_date: D0 });
  ins('Y 오늘 업무', { status: 'active', do_date: D });
  ins('Z 오늘 마감', { status: 'active', do_date: D, due_date: D });
  ins('W 오늘 업무2', { status: 'active', do_date: D });
  page = await open(at(D, '21:00'), `#/checkin/evening_final?d=${D}`);
  check('마무리: 목록 한 화면 (4개), 행마다 내일·대기·다른 날', (await sheetTitles(page)).length === 4 && (await page.locator('#sheet [data-fin="other"]').count()) === 4);
  await page.locator('#sheet .row', { hasText: 'Y 오늘 업무' }).locator('[data-fin="tomorrow"]').click(); await idle(page);
  check('마무리: 개별 "내일" → 목록에서 빠짐', sql(`select (do_date='${D1}')::text from tasks where title='Y 오늘 업무'`) === 'true' && (await sheetTitles(page)).length === 3);
  await page.click('[data-fin="all"]');
  check('마무리: 마감 업무 섞이면 경고 (기한 초과 1 · 오늘 마감 1)', (await page.textContent('#sheet .ci-sub')).includes('기한 초과 1') && (await page.textContent('#sheet .ci-sub')).includes('오늘 마감 1'));
  check('마무리: 경고의 첫 버튼은 "마감 있는 것 빼고 옮기기"', (await page.locator('[data-mv]').first().textContent()) === '마감 있는 것 빼고 옮기기');
  await page.click('[data-mv="safe"]'); await idle(page);
  t = await sheetTitles(page);
  check('마무리: 마감 없는 것만 옮김, 마감 업무는 남음', sql(`select (do_date='${D1}')::text from tasks where title='W 오늘 업무2'`) === 'true' && t.length === 2 && t.includes('X 기한 초과') && t.includes('Z 오늘 마감'), t.join(' / '));
  await page.click('[data-fin="all"]'); await page.click('[data-mv="all"]'); await idle(page);
  check('마무리: 모두 내일로 → 할 날만 내일, 마감일은 그대로', sql(`select string_agg(title||':'||(do_date='${D1}')||':'||due_date, ',' order by title) from tasks where title in ('X 기한 초과','Z 오늘 마감')`) === `X 기한 초과:true:${D0},Z 오늘 마감:true:${D}`);
  check('마무리: 다 넘기면 "오늘 마무리 완료"', await page.locator('#sheet', { hasText: '오늘 마무리 완료' }).isVisible());
  await page.click('#toastUndo'); await idle(page);
  check('마무리: 되돌리기 → 원래 날짜로', sql(`select string_agg(do_date::text, ',' order by title) from tasks where title in ('X 기한 초과','Z 오늘 마감')`) === `${D2},${D}`);
  await page.context().close();

  // ---------- 23:00 하루 복기 ----------
  reset();
  sql(`insert into tasks(user_id,title,status,do_date) values (${U},'끝낸 일','active','${D}')`);
  sql(`update tasks set status='done' where title='끝낸 일'`);   // done_at = 지금(서버) = 오늘
  ins('남은 일', { status: 'active', do_date: D });
  const tomorrowTask = ins('내일 일', { status: 'active', do_date: D1 });
  page = await open(at(D, '23:00'), `#/review?d=${D}`);
  check('복기: 요약 (완료 1 · 남음 1)', (await page.textContent('#sheet .ci-sub')) === '완료 1 · 남음 1', await page.textContent('#sheet .ci-sub'));
  const cands = await page.locator('.rv-cand span').allTextContents();
  check('복기: 후보 = 남은 일 + 내일 일', cands.includes('남은 일') && cands.includes('내일 일'), cands.join(' / '));
  await page.fill('#rvNote', '주보 마감 전에 원고를 먼저 받기');
  await page.locator('.rv-cand', { hasText: '내일 일' }).click();
  await page.click('#rvSave'); await idle(page);
  check('복기: 저장 (한 줄 + 내일 가장 중요한 일)', sql(`select note||'|'||(top_task_id='${tomorrowTask}')||'|'||done_count from daily_reviews where review_date='${D}'`) === '주보 마감 전에 원고를 먼저 받기|true|1');
  check('복기: 저장 후 닫힘 + 주소 #/today', (await page.locator('#sheet').isHidden()) && (await hash(page)) === '#/today');
  await page.goto(BASE + `#/review?d=${D}`); await page.waitForSelector('#rvNote');
  check('복기: 다시 열면 저장한 내용 그대로', (await page.inputValue('#rvNote')) === '주보 마감 전에 원고를 먼저 받기' && await page.locator('.rv-cand', { hasText: '내일 일' }).locator('input').isChecked());
  await page.fill('#rvNew', '셀 교재 영문판 확인');
  check('복기: 새로 입력하면 선택 해제', !(await page.locator('.rv-cand', { hasText: '내일 일' }).locator('input').isChecked()));
  await page.click('#rvSave'); await idle(page);
  check('복기: 새로 입력 → 내일 할 일로 생성 + 지정', sql(`select (t.status='active' and t.do_date='${D1}')::text from daily_reviews r join tasks t on t.id=r.top_task_id where r.review_date='${D}'`) === 'true' && sql("select title from tasks t join daily_reviews r on t.id=r.top_task_id") === '셀 교재 영문판 확인');
  await page.context().close();

  // ---------- 복기 중 자정 넘김 ----------
  page = await open(at(D, '23:59') .replace(':00+', ':30+'), `#/review?d=${D}`);
  await page.fill('#rvNote', '자정 넘기는 중');
  await page.clock.runFor(60_000); await sleep(300);
  check('자정 넘김: 복기 시트 유지, 날짜는 그대로', await page.locator('#sheet h2', { hasText: md(D) }).isVisible() && (await page.inputValue('#rvNote')) === '자정 넘기는 중');
  check('자정 넘김: "내일" 대신 날짜로 표시 (쓰던 한 줄은 유지)', (await page.locator('#sheet', { hasText: `${md(D1)} 가장 중요한 일` }).count()) === 1 && (await page.inputValue('#rvNote')) === '자정 넘기는 중');
  await page.click('#rvSave'); await idle(page);
  check('자정 넘김: 저장은 원래 날짜로', sql(`select note from daily_reviews where review_date='${D}'`) === '자정 넘기는 중');
  await page.context().close();

  // ---------- 다음 날 아침 카드 ----------
  page = await open(at(D1, '09:00'), `#/checkin/morning?d=${D1}`);
  check('다음 날 아침: 복기에서 정한 일이 카드에', (await page.locator('.cc-card').textContent()).includes('셀 교재 영문판 확인'));
  await page.context().close();

  // ---------- 보안 ----------
  const other = sql("set role authenticated; select set_config('request.jwt.claims', '{\"sub\":\"22222222-2222-2222-2222-222222222222\"}', false); select count(*) from daily_reviews;").split('\n').pop();
  check('다른 사용자는 복기 0건', other === '0', other);

  check('브라우저 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const pass = results.filter(r => r.ok).length;
  console.log(`\n${pass} / ${results.length} 통과`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });

function md(s) { const [, m, d] = s.split('-').map(Number); return `${m}/${d}`; }
