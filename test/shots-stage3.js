// 3단계 화면 캡처 (검토용)
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const sql = q => execFileSync('su', ['postgres', '-c', `psql -h /var/tmp/pgtest -d taskhub -At -c "${q.replace(/"/g, '\\"')}"`]).toString().trim();
const U = "'11111111-1111-1111-1111-111111111111'";
const D = sql('select app_today()'), add = n => sql(`select ('${D}'::date + ${n})::text`);
(async () => {
  sql('delete from daily_reviews; delete from tasks;');
  const rows = [['시설보수 견적 회신','active',add(-2),add(-1),'TLC'],['주보 최종 검토','active',D,D,'TLC'],['Arms of Love QC 피드백','active',D,null,'LEVITES'],['사진 선별 확인','active',D,null,'MEDIA'],['택배 반품 접수','active',D,null,'PERSONAL'],['셀 교재 영문판 인쇄 파일','active',add(1),null,'TLC']];
  rows.forEach(([t,s,d,due,a]) => sql(`insert into tasks(user_id,title,status,do_date,due_date,area) values (${U},'${t}','${s}','${d}',${due?`'${due}'`:'null'},'${a}')`));
  sql(`insert into tasks(user_id,title,status,do_date,area) values (${U},'렌탈 장비 반납 확인','active','${D}','ADMIN'); update tasks set status='done' where title='렌탈 장비 반납 확인';`);
  const topId = sql("select id from tasks where title='주보 최종 검토'");
  sql(`insert into daily_reviews(user_id,review_date,top_task_id) values (${U},'${add(-1)}','${topId}')`);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const shots = [['morning','09:00',`#/checkin/morning?d=${D}`],['midday','12:00',`#/checkin/midday?d=${D}`],['evening','18:00',`#/checkin/evening?d=${D}`],['final','21:00',`#/checkin/evening_final?d=${D}`],['review','23:00',`#/review?d=${D}`]];
  for (const [name, hm, hash] of shots) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, timezoneId: 'Asia/Seoul' });
    const p = await ctx.newPage(); await p.clock.install({ time: new Date(`${D}T${hm}:00+09:00`) });
    await p.goto('http://localhost:4400/' + hash); await p.waitForSelector('.top h1'); await new Promise(r => setTimeout(r, 700));
    if (name === 'review') await p.fill('#rvNote', '주보 마감 전에 원고를 먼저 받기');
    await p.screenshot({ path: `/home/claude/shot-${name}.png` }); await ctx.close();
  }
  await b.close();
})();
