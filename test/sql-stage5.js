// 5단계 설계안 검증 (DB만): 슬롯·구독·선점·만료·재시도·권한. 시각은 p_now로 직접 넣음
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
const A = "'11111111-1111-1111-1111-111111111111'";
const D = '2026-10-12';                          // 월요일
const at = hm => `'${D} ${hm}+09'`;
const claim = hm => run(`select count(*) from public.claim_due_checkins(${at(hm)})`);
const logRow = (kind, cols) => run(`select ${cols} from notification_log where kind='${kind}' and local_date='${D}'`);

run('delete from notification_log; delete from push_subscriptions; delete from checkin_slots; delete from notification_prefs; delete from tasks;');

// ---------- 슬롯·설정 ----------
run('select public.ensure_default_slots()', 'a'); run('select public.ensure_default_slots()', 'a');
check('기본 슬롯 6개, 두 번 불러도 6개', run(`select string_agg(to_char(local_time,'HH24:MI')||' '||kind, ', ' order by local_time) from checkin_slots`) === '09:00 morning, 12:00 midday, 15:00 midday, 18:00 evening, 21:00 evening_final, 23:00 review');
check('시간 변경 가능 (09:00 → 08:30)', run("update checkin_slots set local_time='08:30' where kind='morning' returning to_char(local_time,'HH24:MI')", 'a') === '08:30');
run("update checkin_slots set local_time='09:00' where kind='morning'", 'a');
check('종류(kind)는 앱에서 못 바꿈', run("update checkin_slots set kind='review' where kind='morning'", 'a').startsWith('ERR'));
check('5분 단위가 아니면 거부 (09:03)', run("update checkin_slots set local_time='09:03' where kind='morning'", 'a').startsWith('ERR'));
check('23:35 이후는 거부 (발송 창이 자정을 넘지 않게)', run("update checkin_slots set local_time='23:40' where kind='review'", 'a').startsWith('ERR'));
check('같은 시각 두 슬롯 거부', run("update checkin_slots set local_time='12:00' where local_time='15:00'", 'a').startsWith('ERR'));
check('다른 사용자는 내 슬롯 0건', run('select count(*) from checkin_slots', 'b') === '0');
check('비로그인은 슬롯 조회 불가', run('select count(*) from checkin_slots', 'anon').startsWith('ERR'));

// ---------- 구독 ----------
const ep = 'https://fcm.googleapis.com/fcm/send/abc123';
const key = 'B' + 'x'.repeat(86), auth = 'y'.repeat(22);
const sub1 = run(`select public.register_push_subscription('${ep}','${key}','${auth}','iPhone')`, 'a');
check('이 기기 구독 등록', /^[0-9a-f-]{36}$/.test(sub1));
check('같은 기기 다시 등록 → 같은 행 (중복 없음)', run(`select public.register_push_subscription('${ep}','${key}','${auth}',null)`, 'a') === sub1 && run('select count(*) from push_subscriptions') === '1');
check('https가 아닌 주소 거부', run(`select public.register_push_subscription('http://x.com/1','${key}','${auth}')`, 'a').startsWith('ERR'));
check('앱은 구독 키 값을 다시 읽을 수 없음', run('select p256dh from push_subscriptions', 'a').startsWith('ERR') && run('select device_label from push_subscriptions', 'a') === 'iPhone');
check('다른 사용자는 내 기기 삭제 불가', run(`select public.remove_push_subscription('${sub1}')`, 'b') === 'f');

// ---------- 선점 ----------
check('앱·비로그인은 선점 함수 실행 불가', run(`select count(*) from public.claim_due_checkins()`, 'a').startsWith('ERR') && run(`select count(*) from public.claim_due_checkins()`, 'anon').startsWith('ERR'));
check('08:59 → 보낼 것 없음', claim('08:59') === '0');
check('09:00:30 → 아침 1개 선점', claim('09:00:30') === '1' && logRow('morning', 'status') === 'claimed');
check('09:01 다시 → 0개 (같은 슬롯·날짜는 한 번)', claim('09:01') === '0');
const mId = logRow('morning', 'id');
check('발송 시작은 한 번만 (두 번째 호출은 0개)', run(`select count(*) from public.begin_sending(array['${mId}']::uuid[])`, 'svc') === '1' && run(`select count(*) from public.begin_sending(array['${mId}']::uuid[])`, 'svc') === '0');
check('전부 성공 → sent', run(`select public.finish_sending('${mId}',1,0)`, 'svc') === 'sent' && logRow('morning', 'status') === 'sent');
check('12:21 → 0개 (12시 슬롯 시간 창 20분 지남)', claim('12:21') === '0');
run("update checkin_slots set enabled=false where local_time='15:00'", 'a');
check('끈 슬롯(15시)은 선점 안 함', claim('15:00:10') === '0');
run("update checkin_slots set weekdays='{0,2,3,4,5,6}' where kind='evening'", 'a');
check('요일에서 뺀 날(월요일 18시)은 선점 안 함', claim('18:00:10') === '0');
run("update notification_prefs set enabled=false", 'a');
check('전체 알림 끄면 선점 안 함', claim('21:00:10') === '0');
run("update notification_prefs set enabled=true", 'a');
run(`update push_subscriptions set disabled_at=now()`);
check('활성 구독이 없으면 선점 안 함', claim('21:01') === '0');
run(`update push_subscriptions set disabled_at=null`);

// ---------- 발송 시작·완료 ----------

// 21시: 실패 → 2분 뒤 재시도 → 최대 3번 → 시간 창 지나면 expired
check('21:00:20 → 마무리 1개 선점', claim('21:00:20') === '1');
const fId = logRow('evening_final', 'id');
run(`select public.begin_sending(array['${fId}']::uuid[])`, 'svc'); run(`update notification_log set next_attempt_at=null where id='${fId}'`);
run(`select public.finish_sending('${fId}',0,1,'push service 500')`, 'svc');
run(`update notification_log set next_attempt_at=${at('21:02:30')} where id='${fId}'`);   // finish 시각을 21:00:30으로 가정
check('전부 실패 → failed, 2분 뒤 재시도 예정', logRow('evening_final', 'status') === 'failed');
check('2분 전(21:01:30)에는 재시도 안 함', claim('21:01:30') === '0');
check('2분 뒤(21:02:30) 재시도 선점 (2번째)', claim('21:02:30') === '1' && logRow('evening_final', 'attempts') === '2');
run(`select public.begin_sending(array['${fId}']::uuid[])`, 'svc'); run(`select public.finish_sending('${fId}',0,1)`, 'svc');
run(`update notification_log set next_attempt_at=${at('21:05')} where id='${fId}'`);
check('3번째 재시도', claim('21:05') === '1' && logRow('evening_final', 'attempts') === '3');
run(`select public.begin_sending(array['${fId}']::uuid[])`, 'svc'); run(`select public.finish_sending('${fId}',0,1)`, 'svc');
run(`update notification_log set next_attempt_at=${at('21:08')} where id='${fId}'`);
check('3번 실패하면 더 재시도 안 함', claim('21:08') === '0' && logRow('evening_final', 'status') === 'failed');
check('시간 창(20분) 지나면 expired', claim('21:21') === '0' && logRow('evening_final', 'status') === 'expired');

// claimed에서 멈춤 → 3분 뒤 failed → 바로 재시도
check('12:00:10 → 중간 체크 선점', claim('12:00:10') === '1');
check('발송 시작 전 3분 넘게 멈춤 → 실패 처리 후 재시도 선점', claim('12:03:30') === '1' && logRow('midday', 'attempts') === '2' && logRow('midday', 'status') === 'claimed');
// sending에서 멈춤 → 5분 뒤 unknown, 재시도 안 함
const mdId = logRow('midday', 'id');
run(`select public.begin_sending(array['${mdId}']::uuid[])`, 'svc');
run(`update notification_log set sending_started_at=${at('12:04')} where id='${mdId}'`);
check('발송 중 5분 넘게 멈춤 → unknown, 재시도 안 함', claim('12:09:30') === '0' && logRow('midday', 'status') === 'unknown');

// 일부 기기만 성공 → partial, 재시도 안 함
check('23:00:05 → 복기 선점', claim('23:00:05') === '1');
const rId = logRow('review', 'id');
run(`select public.begin_sending(array['${rId}']::uuid[])`, 'svc');
check('일부 기기만 성공 → partial', run(`select public.finish_sending('${rId}',1,1)`, 'svc') === 'partial');
check('partial은 재시도 안 함', claim('23:03') === '0');

// 기기 결과
run(`select public.record_push_result('${sub1}', false, true)`, 'svc');
check('푸시 서비스가 "만료(410)" → 그 기기 비활성', run(`select (disabled_at is not null)::text from push_subscriptions where id='${sub1}'`) === 'true');
run(`select public.register_push_subscription('${ep}','${key}','${auth}')`, 'a');
check('같은 기기에서 다시 켜면 다시 활성', run(`select (disabled_at is null)::text from push_subscriptions where id='${sub1}'`) === 'true');
for (let i = 0; i < 5; i++) run(`select public.record_push_result('${sub1}', false, false)`, 'svc');
check('5번 연속 실패 → 비활성', run(`select failure_count||'|'||(disabled_at is not null) from push_subscriptions where id='${sub1}'`) === '5|true');

// 열람·완료 기록
check('알림 열람 기록 (본인만, 한 번만)', run(`select public.mark_checkin('${mId}','opened')`, 'b') === 'f' && run(`select public.mark_checkin('${mId}','opened')`, 'a') === 't' && run(`select public.mark_checkin('${mId}','opened')`, 'a') === 'f');
check('체크인 완료 기록', run(`select public.mark_checkin('${mId}','completed')`, 'a') === 't');
check('앱은 발송 기록을 직접 못 고침', run(`update notification_log set status='sent'`, 'a').startsWith('ERR'));

// 알림 문구용 개수
run(`insert into tasks(user_id,title,status,do_date,due_date) values (${A},'a','active','2026-10-10','2026-10-11'),(${A},'b','active','${D}',null),(${A},'c','inbox',null,'${D}')`);
check('알림 문구용 개수 (기한 초과·남음)', run(`select public.checkin_summary(${A},'${D}')::text`, 'svc') === '{"done": 0, "overdue": 1, "followup": 0, "remaining": 3}', run(`select public.checkin_summary(${A},'${D}')::text`, 'svc'));
check('앱은 개수 함수 직접 실행 불가', run(`select public.checkin_summary(${A},'${D}')`, 'a').startsWith('ERR'));

const pass = results.filter(Boolean).length;
console.log(`\n${pass} / ${results.length} 통과`);
process.exit(pass === results.length ? 0 : 1);
