// 5단계: send-checkins Edge Function 검증
// 실제와 같은 방식(Deno 서버)으로 함수를 띄우고, 가짜 푸시 서비스(HTTPS)로 받은 메시지를 구독 키로 직접 복호화해 확인
const { execFileSync, spawn } = require('child_process');
const https = require('https'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const jwt = require('jsonwebtoken'), webpush = require('web-push'), ece = require('http_ece');

const ROOT = path.join(__dirname, '..');
const DENO = process.env.DENO || '/tmp/claude-0/-home-claude/67b0715b-db09-5926-96b5-20cb6992ef70/scratchpad/node_modules/.bin/deno';
const sql = q => execFileSync('su', ['postgres', '-c', `psql -h /var/tmp/pgtest -d taskhub -At -q -c "${q.replace(/"/g, '\\"')}"`]).toString().trim();
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64u = buf => Buffer.from(buf).toString('base64url');
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';

(async () => {
  // 이전 실행에서 남은 함수 프로세스 정리 (포트 8000)
  try { execFileSync('bash', ['-c', "ps -eo pid,args | awk '$2 ~ /deno$/ && /send-checkins|index\\.ts/ {print $1}' | xargs -r kill"]); } catch {}
  await sleep(500);
  // ---------- 가짜 푸시 서비스 ----------
  const received = [];
  const certs = '/var/tmp/taskhub-test/certs';
  const push = https.createServer({ key: fs.readFileSync(`${certs}/key.pem`), cert: fs.readFileSync(`${certs}/cert.pem`) }, (req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(req.url.startsWith('/ok') ? 201 : req.url.startsWith('/gone') ? 410 : 500); res.end();
    });
  }).listen(4500);

  // ---------- 구독 키 (실제 브라우저처럼 생성) ----------
  const mkSub = () => { const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); return { ecdh, p256dh: b64u(ecdh.getPublicKey()), auth: b64u(crypto.randomBytes(16)) }; };
  const okA = mkSub(), goneA = mkSub(), failB = mkSub();

  // ---------- DB 준비 ----------
  sql('delete from notification_log; delete from push_subscriptions; delete from checkin_slots; delete from notification_prefs; delete from tasks; delete from net.calls;');
  sql("update cron.job set active=false where jobname='steward-checkins'");
  const slot = sql("select to_char(date_trunc('hour', now() at time zone 'Asia/Seoul') + floor(extract(minute from now() at time zone 'Asia/Seoul') / 5) * interval '5 min', 'HH24:MI')");
  const D = sql('select app_today()');
  sql(`insert into notification_prefs(user_id) values ('${A}'),('${B}')`);
  sql(`insert into checkin_slots(user_id, kind, local_time) values ('${A}','evening_final','${slot}'),('${B}','midday','${slot}')`);
  sql(`insert into push_subscriptions(user_id, endpoint, p256dh, auth, device_label) values
       ('${A}','https://localhost:4500/ok/a','${okA.p256dh}','${okA.auth}','iPhone'),
       ('${A}','https://localhost:4500/gone/a','${goneA.p256dh}','${goneA.auth}','옛 기기'),
       ('${B}','https://localhost:4500/fail/b','${failB.p256dh}','${failB.auth}','PC')`);
  sql(`insert into tasks(user_id,title,status,do_date,due_date) values ('${A}','x','active','${D}',null),('${A}','y','active','${D}',(date '${D}' - 1)),('${A}','z','inbox',null,'${D}')`);
  const secret = sql("select decrypted_secret from vault.decrypted_secrets where name='steward_cron_secret'");
  const ids = sql('select string_agg(log_id::text, \',\') from public.claim_due_checkins()').split(',');
  const logA = sql(`select id from notification_log where user_id='${A}'`), logB = sql(`select id from notification_log where user_id='${B}'`);
  check('준비: 두 사용자 알림 선점', ids.length === 2 && ids.includes(logA) && ids.includes(logB), `슬롯 ${slot}`);

  // ---------- Edge Function 실행 (Supabase와 같이 Deno.serve) ----------
  sql("delete from vault.secrets where name='steward_vapid'");
  const service = jwt.sign({ role: 'service_role' }, 'test-secret-test-secret-test-secret-32', { expiresIn: '1h' });
  const fnLog = [];
  const fn = spawn(DENO, ['run', '--allow-net', '--allow-env', '--unsafely-ignore-certificate-errors=localhost', '--node-modules-dir=none', 'index.ts'], {
    cwd: path.join(ROOT, 'supabase/functions/send-checkins'),
    env: { ...process.env, DENO_DIR: '/var/tmp/denotest/.deno', SUPABASE_URL: 'http://localhost:4400', SUPABASE_SERVICE_ROLE_KEY: service },
  });
  fn.stdout.on('data', d => fnLog.push(d.toString())); fn.stderr.on('data', d => fnLog.push(d.toString()));
  const call = async (headers, body) => { const r = await fetch('http://localhost:8000/', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
  for (let i = 0; i < 60; i++) { try { await fetch('http://localhost:8000/'); break; } catch { await sleep(500); } }

  // ---------- 푸시 서명 키 (함수가 처음 필요할 때 만들어 Vault에 저장) ----------
  // 동시에 처음 요청이 여러 개 들어와도 모두 Vault에 실제 저장된 같은 키를 씀
  const firstKeys = await Promise.all(Array.from({ length: 6 }, () => fetch('http://localhost:8000/?vapid=public').then(r => r.json())));
  const vaultPub = JSON.parse(sql("select decrypted_secret from vault.decrypted_secrets where name='steward_vapid'") || '{}').publicKey;
  check('처음 요청 6개가 동시에 와도 모두 Vault에 저장된 같은 키', firstKeys.every(k => k.publicKey === vaultPub) && sql("select count(*) from vault.secrets where name='steward_vapid'") === '1');
  const k1 = await (await fetch('http://localhost:8000/?vapid=public')).json();
  const k2r = await fetch('http://localhost:8000/?vapid=public'); const k2 = await k2r.json();
  const stored = JSON.parse(sql("select decrypted_secret from vault.decrypted_secrets where name='steward_vapid'") || '{}');
  check('공개키 요청 → 키 쌍 생성·Vault 저장, 공개키만 응답', /^[A-Za-z0-9_-]{87}$/.test(k1.publicKey) && stored.publicKey === k1.publicKey && !!stored.privateKey && !('privateKey' in k1));
  check('다시 요청해도 같은 키 (덮어쓰지 않음), 앱에서 부를 수 있게 CORS 허용', k2.publicKey === k1.publicKey && k2r.headers.get('access-control-allow-origin') === '*');
  check('앱·비로그인은 키 함수 직접 실행 불가', ['anon', 'authenticated'].every(role => sql(`select has_function_privilege('${role}', 'public.get_vapid_keys()', 'execute')`) === 'f'));
  check('키 저장은 처음 한 번만 (다른 키로 다시 불러도 기존 공개키)', sql(`set role service_role; select public.store_vapid_keys('${'A'.repeat(87)}', '${'B'.repeat(43)}')`).split('\n').pop() === k1.publicKey);

  // ---------- 보호 ----------
  check('헤더 없으면 401', (await call({}, { log_ids: ids })).status === 401);
  check('틀린 비밀값이면 401', (await call({ 'x-steward-cron': 'f'.repeat(64) }, { log_ids: ids })).status === 401);
  check('401이면 아무것도 보내지 않음 (기록 그대로 claimed)', received.length === 0 && sql('select string_agg(distinct status, \',\') from notification_log') === 'claimed');
  check('잘못된 본문이면 400', (await call({ 'x-steward-cron': secret }, { log_ids: ['nope'] })).status === 400);

  // ---------- 발송 ----------
  const r = await call({ 'x-steward-cron': secret }, { log_ids: ids });
  check('맞는 비밀값 → 200, 2건 처리', r.status === 200 && r.json.processed === 2, JSON.stringify(r.json?.results?.map(x => `${x.kind}:${x.status}`)));
  check('푸시 서비스로 3건 전송 (A 기기 2 + B 기기 1)', received.length === 3);
  const okReq = received.find(x => x.path === '/ok/a');
  check('푸시 헤더: 암호화 방식·유효 시간·긴급도·topic·VAPID 서명(저장된 공개키)', okReq.headers['content-encoding'] === 'aes128gcm' && okReq.headers.ttl === '1800' && okReq.headers.urgency === 'high' && okReq.headers.topic === `evening_final${D.replaceAll('-', '')}` && okReq.headers.authorization === undefined ? false : okReq.headers.authorization.endsWith('k=' + k1.publicKey));
  check('본문은 암호화되어 있음 (평문 없음)', !okReq.body.toString('utf8').includes('Steward') && !okReq.body.toString('utf8').includes('남은'));
  const payload = JSON.parse(ece.decrypt(okReq.body, { version: 'aes128gcm', privateKey: okA.ecdh, authSecret: okA.auth }).toString('utf8'));
  check('기기 키로 복호화한 내용: 개수만 담긴 문구', payload.title === 'Steward' && payload.body === '남은 업무 3개 · 내일로 넘기고 오늘을 마무리해요', payload.body);
  check('복호화한 내용: 열 주소(날짜·기록 id)와 tag', payload.url === `./#/checkin/evening_final?d=${D}&n=${logA}` && payload.tag === `evening_final-${D}`, payload.url);
  check('업무 제목은 알림에 없음', !['x', 'y', 'z'].some(t => payload.body.includes(`${t} `)) && !JSON.stringify(payload).includes('"x"'));

  // ---------- 결과 기록 ----------
  check('A: 1대 성공·1대 만료 → partial, 성공 1대', sql(`select status||'|'||devices_sent from notification_log where id='${logA}'`) === 'partial|1');
  check('만료(410) 기기는 비활성, 성공 기기는 마지막 성공 시각 기록', sql("select string_agg(device_label||':'||(disabled_at is not null)||':'||(last_success_at is not null), ',' order by device_label) from push_subscriptions where user_id='11111111-1111-1111-1111-111111111111'") === 'iPhone:false:true,옛 기기:true:false');
  check('B: 전부 실패 → failed, 2분 뒤 재시도 예정, 실패 횟수 +1', sql(`select status||'|'||(next_attempt_at > now() + interval '100 seconds') from notification_log where id='${logB}'`) === 'failed|true' && sql(`select failure_count from push_subscriptions where user_id='${B}'`) === '1');

  // ---------- 중복 ----------
  const before = received.length;
  const again = await call({ 'x-steward-cron': secret }, { log_ids: ids });
  check('같은 목록으로 다시 불려도 다시 보내지 않음', again.status === 200 && again.json.processed === 0 && received.length === before);

  // ---------- 로그 ----------
  await sleep(300);
  const logs = fnLog.join('');
  check('함수 로그에 비밀값·구독 주소·키·서명 개인키가 없음', !logs.includes(secret) && !logs.includes('localhost:4500') && !logs.includes(okA.p256dh) && !logs.includes(okA.auth) && !logs.includes(stored.privateKey), logs.trim().split('\n').pop());

  require('fs').writeFileSync('/var/tmp/taskhub-test/fn.log', fnLog.join(''));
  fn.kill(); push.close();
  sql('delete from notification_log; delete from push_subscriptions; delete from checkin_slots; delete from notification_prefs; delete from tasks;');
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass} / ${results.length} 통과`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); try { execFileSync('bash', ['-c', "ps -eo pid,args | awk '$2 ~ /deno$/ && /index\\.ts/ {print $1}' | xargs -r kill"]); } catch {} process.exit(2); });
