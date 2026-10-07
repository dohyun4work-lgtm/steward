// Steward — send-checkins (Supabase Edge Function)
// Cron(dispatch_checkins)이 매분 보낼 알림이 있을 때만 호출. 설계: docs/notifications-impl.md
//
// 보호: JWT 검증 끔(--no-verify-jwt). 대신 헤더 x-steward-cron을 DB의 verify_cron_secret()으로 확인
// 비밀값·구독 주소·키는 로그에 남기지 않음
//
// 환경 변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (Supabase가 자동으로 넣어 줌), VAPID_SUBJECT (선택)
// 푸시 서명 키(VAPID): 처음 필요할 때 이 함수가 직접 만들어 Vault에 저장 (005). 사람이 다루지 않음
//   GET ?vapid=public → 앱이 기기 구독에 쓸 공개키 (공개 정보, 비밀값 확인 없음)
import webpush from 'npm:web-push@3.6.7';

const env = (k: string, d?: string) => Deno.env.get(k) ?? d ?? '';
const SUPABASE_URL = env('SUPABASE_URL');
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const VAPID_SUBJECT = env('VAPID_SUBJECT', 'https://dohyun4work-lgtm.github.io/steward/');
type Vapid = { subject: string; publicKey: string; privateKey: string };
let vapidCache: Vapid | null = null;
const PUSH_TIMEOUT_MS = 10_000;
const MAX_LOGS = 100;

type Log = { log_id: string; user_id: string; kind: string; local_date: string };
type Summary = { overdue: number; remaining: number; done: number; followup: number };
type Sub = { id: string; endpoint: string; p256dh: string; auth: string };

// ---------- DB (PostgREST, service_role) ----------
async function db(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`db ${path.split('?')[0]} ${res.status}`);   // 응답 본문은 남기지 않음
  return text ? JSON.parse(text) : null;
}
const rpc = (fn: string, args: Record<string, unknown>) => db(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

// ---------- 알림 문구 (개수만, 업무 제목 없음) ----------
const COPY: Record<string, (s: Summary) => string> = {
  morning: s => `오늘 할 일 ${s.remaining}개` + (s.overdue ? ` · 기한 초과 ${s.overdue}` : ''),
  midday: s => s.remaining ? `남은 업무 ${s.remaining}개 · 지금 정리하거나 추가하세요` : '오늘 남은 업무가 없어요 · 생각난 일을 적어 두세요',
  evening: s => s.remaining ? `남은 업무 ${s.remaining}개 · 오늘 안에 할 것만 남겨요` : '오늘 남은 업무가 없어요 · 오늘은 여기까지',
  evening_final: s => s.remaining ? `남은 업무 ${s.remaining}개 · 내일로 넘기고 오늘을 마무리해요` : '오늘 마무리 완료 · 23시에 하루를 돌아봐요',
  review: s => `오늘 완료 ${s.done}개 · 하루를 1분만 돌아봐요`,
};
export function buildPayload(log: Log, s: Summary) {
  const route = log.kind === 'review' ? '#/review' : `#/checkin/${log.kind}`;
  return {
    title: 'Steward',
    body: (COPY[log.kind] ?? COPY.midday)(s),
    url: `./${route}?d=${log.local_date}&n=${log.log_id}`,
    tag: `${log.kind}-${log.local_date}`,                  // 기기에서 같은 tag는 하나로 덮어씀
  };
}
const pushOptions = (log: Log, vapid: Vapid) => ({
  vapidDetails: vapid,
  TTL: log.kind === 'review' ? 7200 : 1800,                // 기기가 꺼져 있다 늦게 켜져도 지난 알림이 몰리지 않게
  urgency: 'high' as const,
  topic: `${log.kind}${log.local_date.replaceAll('-', '')}`, // 푸시 서비스에 대기 중인 같은 알림도 하나로
});

// ---------- 발송 ----------
// ---------- VAPID 키: Vault에서 읽고, 없으면 만들어 저장 (동시에 만들어져도 먼저 저장된 쪽으로 통일) ----------
async function loadVapid(): Promise<Vapid> {
  if (vapidCache) return vapidCache;
  let keys = await rpc('get_vapid_keys', {});
  if (!keys?.publicKey) {
    const fresh = webpush.generateVAPIDKeys();
    await rpc('store_vapid_keys', { p_public: fresh.publicKey, p_private: fresh.privateKey });
    keys = await rpc('get_vapid_keys', {});
  }
  vapidCache = { subject: VAPID_SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey };
  return vapidCache;
}

async function pushOne(sub: Sub, payload: string, log: Log, vapid: Vapid): Promise<'ok' | 'gone' | 'fail'> {
  try {
    const d = webpush.generateRequestDetails({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, pushOptions(log, vapid));
    const res = await fetch(d.endpoint, { method: d.method, headers: d.headers, body: d.body, signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
    await res.body?.cancel();
    if (res.status === 404 || res.status === 410) return 'gone';      // 만료된 구독
    return res.ok ? 'ok' : 'fail';
  } catch (_) {
    return 'fail';
  }
}

async function sendLog(log: Log, vapid: Vapid) {
  try {
    const summary: Summary = await rpc('checkin_summary', { p_user: log.user_id, p_date: log.local_date });
    const subs: Sub[] = await db(`push_subscriptions?select=id,endpoint,p256dh,auth&user_id=eq.${log.user_id}&disabled_at=is.null`);
    const payload = JSON.stringify(buildPayload(log, summary));
    const outcomes = await Promise.all(subs.map(async sub => {
      const r = await pushOne(sub, payload, log, vapid);
      await rpc('record_push_result', { p_subscription_id: sub.id, p_ok: r === 'ok', p_gone: r === 'gone' });
      return r;
    }));
    const sent = outcomes.filter(r => r === 'ok').length, failed = outcomes.length - sent;
    const error = failed ? `gone ${outcomes.filter(r => r === 'gone').length}, fail ${outcomes.filter(r => r === 'fail').length}` : (subs.length ? null : 'no active subscription');
    const status = await rpc('finish_sending', { p_log_id: log.log_id, p_sent: sent, p_failed: subs.length ? failed : 1, p_error: error });
    return { log_id: log.log_id, kind: log.kind, status, sent, failed };
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 200) : 'unknown';
    try { await rpc('finish_sending', { p_log_id: log.log_id, p_sent: 0, p_failed: 1, p_error: 'internal: ' + msg }); } catch (_) { /* sending timeout이 처리 */ }
    return { log_id: log.log_id, kind: log.kind, status: 'failed', sent: 0, failed: 0, error: msg };
  }
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' };
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } });

export async function handler(req: Request): Promise<Response> {
  // 공개키 (앱이 기기 구독할 때). 공개 정보라 비밀값 확인 없음
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method === 'GET' && new URL(req.url).searchParams.get('vapid') === 'public') {
    try { return json({ publicKey: (await loadVapid()).publicKey }, 200, { ...CORS, 'Cache-Control': 'public, max-age=3600' }); }
    catch (_) { return json({ error: 'unavailable' }, 503, CORS); }
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const secret = req.headers.get('x-steward-cron') ?? '';
  let authorized = false;
  try { authorized = secret.length === 64 && (await rpc('verify_cron_secret', { p_secret: secret })) === true; } catch (_) { authorized = false; }
  if (!authorized) return json({ error: 'unauthorized' }, 401);

  const body = await req.json().catch(() => null);
  const ids = body?.log_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_LOGS || !ids.every(i => typeof i === 'string' && /^[0-9a-f-]{36}$/.test(i))) {
    return json({ error: 'bad request' }, 400);
  }
  let vapid: Vapid;
  try { vapid = await loadVapid(); }
  catch (_) { console.error('send-checkins: VAPID 키를 불러오지 못함'); return json({ error: 'not configured' }, 500); }   // 기록은 claimed → 3분 뒤 재시도
  const logs: Log[] = await rpc('begin_sending', { p_log_ids: ids });      // claimed → sending 에 성공한 것만
  const results = [];
  for (const log of logs) results.push(await sendLog(log, vapid));
  console.log(`send-checkins: ${results.map(r => `${r.kind}=${r.status}(${r.sent}/${r.sent + r.failed})`).join(', ') || 'nothing to send'}`);
  return json({ processed: results.length, results });
}

Deno.serve(handler);
