// 004 검증: 실제 pg_cron 1.6 + Vault·pg_net 흉내(test/supabase-stubs.sql)
// 004 파일을 두 번 실행해 중복·오류가 없는지, 비밀값·헤더 확인·발송 호출·교체를 확인
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const runFile = f => { try { execFileSync('su', ['postgres', '-c', `psql -h /var/tmp/pgtest -d taskhub -q -v ON_ERROR_STOP=1 -f ${f}`], { stdio: ['ignore', 'pipe', 'pipe'] }); return 'ok'; } catch (e) { return 'ERR: ' + e.stderr.toString().split('\n')[0]; } };
const run = (q, role, full) => {
  const pre = role === 'a' ? "set role authenticated; select set_config('request.jwt.claims','{\"sub\":\"11111111-1111-1111-1111-111111111111\"}',false);"
            : role === 'anon' ? 'set role anon;' : role === 'svc' ? 'set role service_role;' : '';
  try {
    const r = execFileSync('su', ['postgres', '-c', `psql -h /var/tmp/pgtest -d taskhub -At -q -c "${(pre + q).replace(/"/g, '\\"')}"`], { stdio: ['ignore', 'pipe', 'pipe'] });
    return full ? r.toString() : r.toString().trim().split('\n').pop();
  } catch (e) { return 'ERR: ' + e.stderr.toString().split('\n')[0]; }
};
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

// 준비: 흉내 스키마 + 004 (pg_net 확장 줄만 제외)
fs.copyFileSync(path.join(__dirname, 'supabase-stubs.sql'), '/var/tmp/pgtest/stubs.sql');
fs.writeFileSync('/var/tmp/pgtest/004.sql', fs.readFileSync(path.join(ROOT, 'supabase/migrations/004_cron.sql'), 'utf8').replace('create extension if not exists pg_net;', '-- (로컬: pg_net 대신 흉내 함수)'));
execFileSync('chown', ['postgres', '/var/tmp/pgtest/stubs.sql', '/var/tmp/pgtest/004.sql']);
run("select cron.unschedule(jobid) from cron.job where jobname='steward-checkins'");
run("delete from vault.secrets where name like 'steward_%'; delete from net.calls;");
check('흉내 스키마 준비', runFile('/var/tmp/pgtest/stubs.sql') === 'ok');

// ---------- 반복 실행 ----------
check('004 첫 실행', runFile('/var/tmp/pgtest/004.sql') === 'ok');
const secret1 = run("select decrypted_secret from vault.decrypted_secrets where name='steward_cron_secret'");
check('004 두 번째 실행도 오류 없음', runFile('/var/tmp/pgtest/004.sql') === 'ok');
check('004 세 번째 실행도 오류 없음', runFile('/var/tmp/pgtest/004.sql') === 'ok');
check('예약은 1개 (중복 없음), 매분, 내용 맞음', run("select count(*)||'|'||min(schedule)||'|'||min(command)||'|'||bool_and(active) from cron.job where jobname='steward-checkins'") === '1|* * * * *|select public.dispatch_checkins()|true');
run("update cron.job set active=false where jobname='steward-checkins'");   // 아래 수동 테스트와 겹치지 않게 멈춤
check('비밀값: 64자리 16진수 (256비트)', /^[0-9a-f]{64}$/.test(secret1));
check('다시 실행해도 비밀값 유지', run("select decrypted_secret from vault.decrypted_secrets where name='steward_cron_secret'") === secret1);
check('비밀값 1개만', run("select count(*) from vault.secrets where name='steward_cron_secret'") === '1');
check('발송 주소 등록', run("select decrypted_secret from vault.decrypted_secrets where name='steward_send_url'") === 'https://mqmcpsuaurpajsfjryon.supabase.co/functions/v1/send-checkins');

// ---------- 헤더 확인 ----------
check('맞는 값 → true', run(`select public.verify_cron_secret('${secret1}')`, 'svc') === 't');
check('틀린 값·빈 값·짧은 값 → false', ['x'.repeat(64), '', secret1.slice(0, 32)].every(v => run(`select public.verify_cron_secret('${v}')`, 'svc') === 'f') && run('select public.verify_cron_secret(null)', 'svc') === 'f');
check('앱·비로그인은 확인 함수 실행 불가', run(`select public.verify_cron_secret('${secret1}')`, 'a').startsWith('ERR') && run(`select public.verify_cron_secret('${secret1}')`, 'anon').startsWith('ERR'));
check('앱·비로그인은 발송 함수 실행 불가', run('select public.dispatch_checkins()', 'a').startsWith('ERR') && run('select public.dispatch_checkins()', 'anon').startsWith('ERR'));

// ---------- 발송 호출 ----------
run('delete from notification_log; delete from push_subscriptions; delete from checkin_slots; delete from notification_prefs; delete from net.calls;');
const nowSlot = run("select to_char(date_trunc('hour', now() at time zone 'Asia/Seoul') + floor(extract(minute from now() at time zone 'Asia/Seoul') / 5) * interval '5 min', 'HH24:MI')");
run(`insert into notification_prefs(user_id) values ('11111111-1111-1111-1111-111111111111')`);
run(`insert into checkin_slots(user_id, kind, local_time) values ('11111111-1111-1111-1111-111111111111', 'midday', '${nowSlot}')`);
run(`insert into push_subscriptions(user_id, endpoint, p256dh, auth) values ('11111111-1111-1111-1111-111111111111', 'https://push.example/1', '${'B'.repeat(87)}', '${'y'.repeat(22)}')`);
check('보낼 게 있으면 1건 선점 + Edge Function 1번 호출', run('select public.dispatch_checkins()') === '1' && run('select count(*) from net.calls') === '1', '슬롯 ' + nowSlot);
const call = JSON.parse(run('select row_to_json(c) from net.calls c'));
check('호출 헤더에 비밀값, 본문에 선점한 기록 id', call.headers['x-steward-cron'] === secret1 && call.body.log_ids.length === 1 && call.body.log_ids[0] === run('select id from notification_log'));
check('호출 주소 = Vault의 send-checkins', call.url.endsWith('/functions/v1/send-checkins'));
check('보낼 게 없으면 호출 안 함', run('select public.dispatch_checkins()') === '0' && run('select count(*) from net.calls') === '1');

// 비밀값이 없으면: 호출 안 함, 기록은 claimed로 남아 3분 뒤 재시도, 경고에 비밀값 없음
run("delete from notification_log; delete from net.calls; update vault.secrets set name='steward_send_url_off' where name='steward_send_url'");
const out = run('select public.dispatch_checkins()', null, true) + ' ' + (() => { try { execFileSync('su', ['postgres', '-c', 'psql -h /var/tmp/pgtest -d taskhub -At -c "select public.dispatch_checkins()"'], { stdio: ['ignore', 'pipe', 'pipe'] }); return ''; } catch (e) { return e.stderr.toString(); } })();
check('주소가 없으면 호출 안 함, 선점 기록은 claimed로 남음', run('select count(*) from net.calls') === '0' && run('select status from notification_log') === 'claimed');
check('경고·오류 메시지에 비밀값이 나오지 않음', !out.includes(secret1));
run("update vault.secrets set name='steward_send_url' where name='steward_send_url_off'");

// ---------- 교체 ----------
run("select vault.update_secret((select id from vault.secrets where name='steward_cron_secret'), encode(extensions.gen_random_bytes(32), 'hex'))");
const secret2 = run("select decrypted_secret from vault.decrypted_secrets where name='steward_cron_secret'");
check('교체: 한 줄로 새 값, 이전 값은 바로 거부', secret2 !== secret1 && /^[0-9a-f]{64}$/.test(secret2) && run(`select public.verify_cron_secret('${secret1}')`, 'svc') === 'f' && run(`select public.verify_cron_secret('${secret2}')`, 'svc') === 't');
check('교체 후 004를 다시 실행해도 새 값 유지', runFile('/var/tmp/pgtest/004.sql') === 'ok' && run("select decrypted_secret from vault.decrypted_secrets where name='steward_cron_secret'") === secret2);

// 정리: 로컬에서 매분 도는 예약은 끔
run("update cron.job set active=false where jobname='steward-checkins'");
run('delete from notification_log; delete from push_subscriptions; delete from checkin_slots; delete from notification_prefs; delete from net.calls;');
const pass = results.filter(Boolean).length;
console.log(`\n${pass} / ${results.length} 통과`);
process.exit(pass === results.length ? 0 : 1);
