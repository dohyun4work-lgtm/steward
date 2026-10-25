// 007 검증 (DB만): 캘린더 비공개 주소는 Vault에만, 앱은 상태만, 함수 권한
const { execFileSync } = require('child_process');
const run = (q, role) => {
  const pre = role === 'a' ? "set role authenticated; select set_config('request.jwt.claims','{\"sub\":\"11111111-1111-1111-1111-111111111111\"}',false);"
            : role === 'b' ? "set role authenticated; select set_config('request.jwt.claims','{\"sub\":\"22222222-2222-2222-2222-222222222222\"}',false);"
            : role === 'anon' ? 'set role anon;' : role === 'svc' ? 'set role service_role;' : '';
  try { return execFileSync('su', ['postgres', '-c', `psql -h /var/tmp/pgtest -d taskhub -At -q -c "${(pre + q).replace(/"/g, '\\"')}"`], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim().split('\n').pop(); }
  catch (e) { return 'ERR: ' + e.stderr.toString().split('\n')[0]; }
};
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
const URL1 = 'https://calendar.google.com/calendar/ical/dh%40gmail.com/private-0123456789abcdef0123456789abcdef/basic.ics';
const URL2 = 'https://calendar.google.com/calendar/ical/dh%40gmail.com/private-ffffffffffffffffffffffffffffffff/basic.ics';

run(`delete from public.calendar_feeds; delete from vault.secrets where name like 'steward_ical_%';`);

// 주소 형식
check('공개 주소는 거부', run(`select public.set_calendar_feed('https://calendar.google.com/calendar/ical/dh%40gmail.com/public/basic.ics')`, 'a').startsWith('ERR'));
check('다른 사이트 주소는 거부', run(`select public.set_calendar_feed('https://evil.example.com/calendar/ical/x/private-0123456789abcdef/basic.ics')`, 'a').startsWith('ERR'));
check('http 주소는 거부', run(`select public.set_calendar_feed('${URL1.replace('https', 'http')}')`, 'a').startsWith('ERR'));
check('빈 값은 거부', run(`select public.set_calendar_feed('')`, 'a').startsWith('ERR') && run(`select public.set_calendar_feed(null)`, 'a').startsWith('ERR'));
check('비로그인은 저장 불가', run(`select public.set_calendar_feed('${URL1}')`, 'anon').startsWith('ERR'));

// 저장
check('비공개 주소 저장 (앞뒤 공백 무시)', !run(`select public.set_calendar_feed('  ${URL1}  ')`, 'a').startsWith('ERR'));
check('Vault에 저장됨', run(`select decrypted_secret from vault.decrypted_secrets where name='steward_ical_${A}'`) === URL1);
check('앱은 상태만 봄 (주소 칸 없음)', run(`select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name='calendar_feeds'`) === 'user_id,connected_at,last_ok_at,last_error,last_error_at');
check('앱은 본인 상태 1행', run(`select count(*) from calendar_feeds`, 'a') === '1' && run(`select count(*) from calendar_feeds`, 'b') === '0');
check('앱은 Vault를 직접 못 읽음', run(`select count(*) from vault.decrypted_secrets`, 'a').startsWith('ERR'));
check('앱은 주소 읽기 함수 실행 불가', run(`select public.get_calendar_feed('${A}')`, 'a').startsWith('ERR') && run(`select public.get_calendar_feed('${A}')`, 'anon').startsWith('ERR'));
check('앱은 상태를 직접 못 고침', run(`update calendar_feeds set last_error=null`, 'a').startsWith('ERR') && run(`insert into calendar_feeds(user_id) values ('${B}')`, 'b').startsWith('ERR'));
check('발송 함수는 주소를 읽음', run(`select public.get_calendar_feed('${A}')`, 'svc') === URL1);
check('다른 사용자 주소는 없음', run(`select coalesce(public.get_calendar_feed('${B}'), 'none')`, 'svc') === 'none');

// 결과 기록
run(`select public.record_calendar_result('${A}', false, 'http 404')`, 'svc');
check('실패 기록', run(`select last_error||'|'||(last_error_at is not null)||'|'||(last_ok_at is null) from calendar_feeds`, 'a') === 'http 404|true|true');
run(`select public.record_calendar_result('${A}', true)`, 'svc');
check('성공하면 오류 지움', run(`select coalesce(last_error,'-')||'|'||(last_ok_at is not null) from calendar_feeds`, 'a') === '-|true');
check('앱은 결과 기록 함수 실행 불가', run(`select public.record_calendar_result('${A}', true)`, 'a').startsWith('ERR'));

// 주소 바꾸기 → Vault 1개, 새 주소, 상태 초기화
run(`select public.set_calendar_feed('${URL2}')`, 'a');
check('다시 저장하면 주소 교체, Vault 1개, 상태 초기화', run(`select count(*)||'|'||max(decrypted_secret) from vault.decrypted_secrets where name='steward_ical_${A}'`) === `1|${URL2}` && run(`select (last_ok_at is null)::text from calendar_feeds`, 'a') === 'true');

// B 연결 → 서로 독립
run(`select public.set_calendar_feed('${URL1}')`, 'b');
check('사용자마다 따로 저장', run(`select public.get_calendar_feed('${B}')`, 'svc') === URL1 && run(`select public.get_calendar_feed('${A}')`, 'svc') === URL2);

// 해제
run(`select public.remove_calendar_feed()`, 'a');
check('연결 해제 → 주소·상태 삭제, 다른 사용자는 그대로', run(`select count(*) from vault.secrets where name='steward_ical_${A}'`) === '0' && run(`select count(*) from calendar_feeds`, 'a') === '0' && run(`select public.get_calendar_feed('${B}')`, 'svc') === URL1);
check('해제 후 다시 해제해도 오류 없음', !run(`select public.remove_calendar_feed()`, 'a').startsWith('ERR'));
check('비로그인은 해제 불가', run(`select public.remove_calendar_feed()`, 'anon').startsWith('ERR'));
run(`delete from public.calendar_feeds; delete from vault.secrets where name like 'steward_ical_%';`);

const pass = results.filter(Boolean).length;
console.log(`\n${pass} / ${results.length} 통과`);
process.exit(pass === results.length ? 0 : 1);
