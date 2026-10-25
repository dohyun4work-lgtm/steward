// Steward — calendar-today (Supabase Edge Function)
// 구글 캘린더 「iCal 비공개 주소」에서 하루치 일정을 읽어 돌려줌. 읽기만 하고 아무것도 저장하지 않음 (007)
//
// 부르는 쪽
//   앱:          POST { date? }            Authorization: 로그인 토큰 → 그 사용자의 일정
//   send-checkins: POST { user_id, date }  Authorization: service_role 키 → 아침 알림용
// 돌려줌: { connected, events: [{ title, start, end, allDay }], total }  (start/end는 서울 시각 'HH:MM', 종일은 null)
//
// 비공개 주소·일정 내용은 로그에 남기지 않음. 오류는 종류만 기록 (record_calendar_result)
// 환경 변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (Supabase가 자동으로 넣어 줌)
import ICAL from 'npm:ical.js@2.2.1';

const env = (k: string) => Deno.env.get(k) ?? '';
const SUPABASE_URL = env('SUPABASE_URL');
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const TZ = 'Asia/Seoul';
const FETCH_TIMEOUT_MS = 8_000;
const MAX_BYTES = 8 * 1024 * 1024;     // 아주 큰 캘린더 방지
const MAX_EVENTS = 30;
const MAX_STEPS = 20_000;              // 반복 일정 하나당 펼쳐 볼 최대 횟수
const CACHE_MS = 3 * 60_000;           // 같은 사용자는 3분 동안 다시 받지 않음 (함수가 살아 있는 동안만)

export type CalEvent = { title: string; start: string | null; end: string | null; allDay: boolean };

// ---------- DB (service_role) ----------
async function rpc(fn: string, args: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`db ${fn} ${res.status}`);
  return text ? JSON.parse(text) : null;
}
// 로그인 토큰 → 사용자 id (Supabase Auth가 직접 확인)
async function userFromToken(token: string): Promise<string | null> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } });
  if (!res.ok) { await res.body?.cancel(); return null; }
  const u = await res.json().catch(() => null);
  return typeof u?.id === 'string' ? u.id : null;
}

// ---------- 날짜 (서울) ----------
const seoulDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const seoulHM = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const dayStart = (ymd: string) => new Date(`${ymd}T00:00:00+09:00`);
const addDay = (ymd: string, n: number) => seoulDate(new Date(dayStart(ymd).getTime() + n * 86_400_000 + 3_600_000));
// deno-lint-ignore no-explicit-any
type Any = any;
const ymdOf = (t: Any) => `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;

// ---------- iCal → 그날 일정 ----------
export function eventsForDay(icsText: string, ymd: string): { events: CalEvent[]; total: number } {
  const root = new ICAL.Component(ICAL.parse(icsText));
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try { ICAL.TimezoneService.register(new ICAL.Timezone(tz)); } catch (_) { /* 이미 등록됨 */ }
  }
  const from = dayStart(ymd).getTime(), to = dayStart(addDay(ymd, 1)).getTime();
  const nextYmd = addDay(ymd, 1);

  // 반복 일정의 예외(한 번만 바꾼 일정)를 원래 일정에 묶음
  const masters = new Map<string, Any>();
  const exceptions: Any[] = [];
  for (const c of root.getAllSubcomponents('vevent')) {
    if (c.hasProperty('recurrence-id')) exceptions.push(c);
    else masters.set(String(c.getFirstPropertyValue('uid') ?? Math.random()), new ICAL.Event(c));
  }
  for (const c of exceptions) {
    const m = masters.get(String(c.getFirstPropertyValue('uid')));
    if (m) m.relateException(c);
    else masters.set(String(Math.random()), new ICAL.Event(c));   // 원래 일정이 없으면 단독 일정으로
  }

  const out: (CalEvent & { sort: number })[] = [];
  const add = (item: Any, start: Any, end: Any) => {
    if (String(item.component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED') return;
    const title = String(item.summary ?? '').trim() || '(제목 없음)';
    if (start.isDate) {
      // 종일: [시작일, 끝일) 안에 그날이 있으면
      const s = ymdOf(start), e = end ? ymdOf(end) : addDay(s, 1);
      if (s <= ymd && ymd < (e > s ? e : addDay(s, 1))) out.push({ title, start: null, end: null, allDay: true, sort: 0 });
      return;
    }
    const s = start.toJSDate().getTime();
    const e = end ? end.toJSDate().getTime() : s;
    if (!(s < to && (e > from || (e === s && s >= from)))) return;
    out.push({
      title,
      start: s >= from ? seoulHM(new Date(s)) : null,        // 전날부터 이어지면 시작 시각 없이
      end: e < to && e > s ? seoulHM(new Date(e)) : null,
      allDay: false,
      sort: Math.max(s, from),
    });
  };

  for (const ev of masters.values()) {
    if (!ev.isRecurring()) { add(ev, ev.startDate, ev.endDate); continue; }
    const it = ev.iterator();
    let next: Any, steps = 0;
    while ((next = it.next()) && steps++ < MAX_STEPS) {
      if (next.isDate) {
        const s = ymdOf(next);
        if (s > ymd) break;
        const det = ev.getOccurrenceDetails(next);
        if (s >= addDay(ymd, -31)) add(det.item, det.startDate, det.endDate);   // 31일보다 긴 종일 반복은 없다고 봄
        continue;
      }
      const t = next.toJSDate().getTime();
      if (t >= to) break;
      if (t < from - 2 * 86_400_000) continue;                // 이틀보다 이전 시작은 볼 필요 없음
      const det = ev.getOccurrenceDetails(next);
      add(det.item, det.startDate, det.endDate);
    }
  }
  out.sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title));
  return { events: out.slice(0, MAX_EVENTS).map(({ sort: _s, ...e }) => e), total: out.length };
}

// ---------- 주소에서 받기 ----------
async function fetchIcs(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: 'text/calendar' } });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`http ${res.status}`); }
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) { await res.body?.cancel(); throw new Error('too large'); }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new Error('too large');
  const text = new TextDecoder().decode(buf);
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('not a calendar');
  return text;
}

const cache = new Map<string, { at: number; text: string }>();
export async function dayForUser(user: string, ymd: string) {
  const url: string | null = await rpc('get_calendar_feed', { p_user: user });
  if (!url) return { connected: false, events: [], total: 0 };
  let text: string;
  const hit = cache.get(user);
  if (hit && Date.now() - hit.at < CACHE_MS) text = hit.text;
  else {
    try { text = await fetchIcs(url); }
    catch (e) {
      const kind = e instanceof Error ? (e.name === 'TimeoutError' ? 'timeout' : e.message.slice(0, 60)) : 'fetch';
      await rpc('record_calendar_result', { p_user: user, p_ok: false, p_error: kind }).catch(() => {});
      throw new Error('fetch ' + kind);
    }
    cache.set(user, { at: Date.now(), text });
  }
  try {
    const r = eventsForDay(text, ymd);
    await rpc('record_calendar_result', { p_user: user, p_ok: true }).catch(() => {});
    return { connected: true, ...r };
  } catch (_) {
    cache.delete(user);
    await rpc('record_calendar_result', { p_user: user, p_ok: false, p_error: 'parse' }).catch(() => {});
    throw new Error('parse');
  }
}

// ---------- 요청 ----------
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401);
  const body = await req.json().catch(() => ({}));
  const ymd = typeof body?.date === 'string' && YMD.test(body.date) ? body.date : seoulDate();

  let user: string | null;
  if (SERVICE_KEY && token === SERVICE_KEY) user = typeof body?.user_id === 'string' && UUID.test(body.user_id) ? body.user_id : null;   // send-checkins
  else user = await userFromToken(token);                                                                                              // 앱
  if (!user) return json({ error: 'unauthorized' }, 401);

  try { return json(await dayForUser(user, ymd)); }
  catch (e) {
    console.log(`calendar-today: failed (${e instanceof Error ? e.message : 'unknown'})`);   // 주소·일정 내용 없음
    return json({ connected: true, error: 'unavailable', events: [], total: 0 }, 502);
  }
}

Deno.serve(handler);
