/* Steward — app.js (A daily rhythm for faithful work.)
 * 1단계: 프로토타입 v2 UI 그대로, 데이터는 Supabase.
 * 모든 변경은 patch() / insertTask() / completeTask() / uncompleteTask()를 거친다.
 */
(() => {
'use strict';

const CFG = window.TASKHUB_CONFIG || {};
const AREAS = ['TLC', 'LEVITES', 'MEDIA', 'ADMIN', 'PERSONAL'];
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const TZ = 'Asia/Seoul';
const TEXT_SAVE_DELAY = 400;   // 제목·메모·다음 행동 입력 후 저장까지 (ms)
const DONE_DAYS = 60;          // 완료 목록은 최근 60일만 불러옴

// ---------- dates (모두 한국 시간 기준 YYYY-MM-DD) ----------
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return fmt(d); };
const seoulDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const T = () => seoulDate();
const dowOf = s => parse(s).getDay();
const weekEnd = s => addDays(s, (7 - dowOf(s)) % 7);
const nextMonday = s => addDays(weekEnd(s), 1);
const md = s => { const d = parse(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
const mdw = s => `${md(s)} (${DOW[dowOf(s)]})`;
const diff = (a, b) => Math.round((parse(a) - parse(b)) / 86400000);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- supabase ----------
const clientOpts = { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } };
if (CFG.testAccessToken) clientOpts.accessToken = async () => CFG.testAccessToken;   // 로컬 테스트 전용
const db = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, clientOpts);

// ---------- state ----------
let tasks = [];
let recentWho = [];
let reviews = {};          // review_date → daily_reviews 행 (어제·오늘만)
let userEmail = '';
const byId = id => tasks.find(t => t.id === id);
const live = () => tasks.filter(t => !t.deleted_at);
const norm = r => Object.assign(r, { next_action: r.next_action ?? '', memo: r.memo ?? '', waiting_for: r.waiting_for ?? '' });
const upsertLocal = row => { norm(row); const i = tasks.findIndex(t => t.id === row.id); if (i >= 0) tasks[i] = row; else tasks.push(row); };
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }));

// ---------- save status ----------
let pending = 0, failed = false, savedTimer;
// passive: 화면을 다시 그릴 때는 '저장 중/저장 실패'만 유지하고 '저장됨'은 띄우지 않음
function showSave(passive = false) {
  if (passive && pending === 0 && !failed) return;
  document.querySelectorAll('.saved').forEach(el => {
    el.classList.remove('on', 'fail', 'pending');
    if (pending > 0) { el.textContent = '저장 중'; el.classList.add('on', 'pending'); }
    else if (failed) { el.textContent = '저장 실패'; el.classList.add('on', 'fail'); }
    else { el.textContent = '저장됨'; el.classList.add('on'); }
  });
  clearTimeout(savedTimer);
  if (pending === 0 && !failed) savedTimer = setTimeout(() => document.querySelectorAll('.saved').forEach(el => el.classList.remove('on')), 1100);
}
async function track(promise) {
  pending++; showSave();
  try {
    const r = await promise;
    if (r && r.error) throw r.error;       // supabase-js는 오류를 throw하지 않고 { error }로 돌려줌
    failed = false; return r;
  } catch (e) { failed = true; throw e; }
  finally { pending--; showSave(); }
}
function saveError(e) {
  console.error('[taskhub]', e);
  const msg = e?.message || '';
  toast(/fetch|network|Failed/i.test(msg) ? '연결이 끊겨 저장하지 못했어요' : '저장하지 못했어요 · 다시 시도해 주세요');
}
const unwrap = ({ data, error }) => { if (error) throw error; return data; };

// ---------- data: load ----------
async function loadAll() {
  const since = new Date(Date.now() - DONE_DAYS * 86400000).toISOString();
  const [open, done, who, rev] = await Promise.all([
    db.from('tasks').select('*').is('deleted_at', null).neq('status', 'done'),
    db.from('tasks').select('*').is('deleted_at', null).eq('status', 'done').gte('done_at', since),
    db.from('recent_waiting').select('name').order('last_used_at', { ascending: false }).limit(8),
    db.from('daily_reviews').select('*').gte('review_date', addDays(T(), -1)),
  ]);
  reviews = Object.fromEntries(unwrap(rev).map(x => [x.review_date, x]));
  tasks = [...unwrap(open), ...unwrap(done)].map(norm);
  recentWho = unwrap(who).map(r => r.name);
  // 아직 저장 전인 입력(제목·메모·다음 행동)은 새로 불러온 값 위에 다시 얹음
  textTimers.forEach(e => { const t = byId(e.id); if (t) t[e.field] = e.value; });
  lastLoadAt = Date.now();
}
let lastLoadAt = 0, refreshing = false;
// 저장 중인 요청이 끝난 뒤에 불러와야 방금 바꾼 내용이 옛 값으로 덮이지 않음
const whenIdle = () => new Promise(res => { const tick = () => pending === 0 ? res() : setTimeout(tick, 50); tick(); });
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    await whenIdle(); await loadAll(); render();
    if (!sheet.hidden && sheetKind === 'detail' && detailId) openDetail(detailId, detailBack);
    else if (!sheet.hidden && sheetKind === 'review' && reviewRedraw) reviewRedraw();   // 자정이 지나면 "내일" → 날짜 표기로
  }
  catch (e) { console.error('[taskhub] refresh', e); }
  finally { refreshing = false; }
}

// ---------- data: writes ----------
// patch: 화면에 먼저 반영 → 서버 저장 → 서버 값(트리거 정규화 결과)으로 교체. 실패하면 되돌림.
async function patch(id, fields, { rerender = true } = {}) {
  const t = byId(id); if (!t) return null;
  const prev = {};
  Object.keys(fields).forEach(k => { prev[k] = t[k]; });
  Object.assign(t, fields);
  if (rerender) render();
  const body = { ...fields };
  ['next_action', 'waiting_for'].forEach(k => { if (k in body && body[k] === '') body[k] = null; });
  try {
    const row = unwrap(await track(db.from('tasks').update(body).eq('id', id).select().single()));
    upsertLocal(row);
    if (rerender) render();
    return prev;
  } catch (e) {
    Object.assign(t, prev);
    render(); saveError(e);
    return null;
  }
}
async function insertTask(fields) {
  const row = norm({ id: newId(), title: '', status: 'inbox', area: null, do_date: null, due_date: null, starred: false,
    next_action: '', waiting_for: '', follow_up_date: null, memo: '', repeat_rule: null, source: 'manual',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), done_at: null, deleted_at: null, ...fields });
  tasks.push(row); render();
  const body = { id: row.id, title: row.title, status: row.status, area: row.area, do_date: row.do_date };
  try {
    upsertLocal(unwrap(await track(db.from('tasks').insert(body).select().single())));
    render(); return true;
  } catch (e) {
    tasks = tasks.filter(x => x.id !== row.id); render(); saveError(e); return false;
  }
}
async function completeTask(id, rowEl) {
  const t = byId(id); if (!t || t.status === 'done' || t._busy) return;
  t._busy = true;
  if (rowEl) { rowEl.classList.add('is-done'); rowEl.querySelectorAll('button').forEach(b => b.disabled = true); }
  const prev = { status: t.status, done_at: t.done_at };
  try {
    const res = unwrap(await track(db.rpc('complete_task', { p_id: id })));
    t.status = 'done'; t.done_at = new Date().toISOString();
    await loadAll();
    setTimeout(render, rowEl ? 900 : 0);
    toast(res?.next_date ? `완료 · 다음 ${mdw(res.next_date)} 생성` : '완료했어요', () => uncompleteTask(id));
  } catch (e) {
    Object.assign(t, prev); render(); saveError(e);
  } finally { t._busy = false; }
}
async function uncompleteTask(id) {
  try {
    unwrap(await track(db.rpc('uncomplete_task', { p_id: id })));
    await loadAll(); render();
  } catch (e) { saveError(e); }
}
// 일반 변경 + 되돌리기 토스트
async function change(id, fields, label) {
  const prev = await patch(id, fields);
  if (prev && label) toast(label, () => patch(id, prev));
  return prev;
}
// 상태 전환 규칙 (설계 v2): 다른 상태 → 진행은 오늘로, 대기 해제 시 대기 정보 비움
function statusFields(t, s) {
  const f = { status: s };
  if (s === 'active' && (t.status !== 'active' || !t.do_date)) f.do_date = T();
  if (s !== 'waiting' && t.status === 'waiting') { f.waiting_for = ''; f.follow_up_date = null; }
  return f;
}

// 텍스트 입력 지연 저장
const textTimers = new Map();
function saveTextLater(id, field, value) {
  const t = byId(id); if (!t) return;
  t[field] = value;
  const key = id + ':' + field;
  clearTimeout(textTimers.get(key)?.timer);
  textTimers.set(key, { id, field, value, timer: setTimeout(() => flushText(key), TEXT_SAVE_DELAY) });
}
function flushText(key) {
  const entry = textTimers.get(key); if (!entry) return;
  clearTimeout(entry.timer); textTimers.delete(key);
  if (!byId(entry.id)) return;
  let v = entry.value;
  if (entry.field === 'title' && !String(v).trim()) v = '제목 없음';
  patch(entry.id, { [entry.field]: v }, { rerender: false });
}
const flushAllText = () => [...textTimers.keys()].forEach(flushText);
window.addEventListener('pagehide', flushAllText);

// ---------- selectors ----------
const OPEN = new Set(['inbox', 'active', 'waiting', 'later']);
const isOverdue = t => OPEN.has(t.status) && t.due_date && t.due_date < T();
const isDueToday = t => OPEN.has(t.status) && t.due_date === T();
const overdue = () => live().filter(isOverdue).sort((a, b) => a.due_date.localeCompare(b.due_date));
const todayList = () => live().filter(t => !isOverdue(t) && ((t.status === 'active' && t.do_date && t.do_date <= T()) || isDueToday(t))).sort(sortTask);
const followUps = () => live().filter(t => t.status === 'waiting' && t.follow_up_date && t.follow_up_date <= T() && !isOverdue(t) && !isDueToday(t)).sort((a, b) => a.follow_up_date.localeCompare(b.follow_up_date));
const inbox = () => live().filter(t => t.status === 'inbox').sort((a, b) => a.created_at.localeCompare(b.created_at));
function sortTask(a, b) { return (b.starred - a.starred) || (a.do_date || '').localeCompare(b.do_date || '') || a.created_at.localeCompare(b.created_at); }

// ---------- ui state ----------
const ui = { tab: 'today', todayMode: 'today', archMode: 'later', showLaterWeek: false, morningCard: false };
const top = document.getElementById('top'), main = document.getElementById('main');

// ---------- rendering ----------
function rowHTML(t, opts = {}) {
  const meta = [];
  if (t.area) meta.push(`<span class="tag a-${t.area}">${t.area}</span>`);
  const today = T();
  if (t.status !== 'active' && t.status !== 'done' && (isOverdue(t) || isDueToday(t))) meta.push(`<span class="meta warn">${{ inbox: '인박스', waiting: '대기 중', later: '나중에' }[t.status]}</span>`);
  if (OPEN.has(t.status) && t.due_date) {
    if (t.due_date < today) meta.push(`<span class="meta danger">마감 ${md(t.due_date)} · ${diff(today, t.due_date)}일 지남</span>`);
    else if (t.due_date === today) meta.push(`<span class="meta danger">오늘 마감</span>`);
    else meta.push(`<span class="meta">마감 ${md(t.due_date)}</span>`);
  }
  if (opts.showDo && t.do_date) meta.push(`<span class="meta">${mdw(t.do_date)}</span>`);
  if (t.status === 'active' && t.do_date && t.do_date < today && !isOverdue(t)) meta.push(`<span class="meta warn">${diff(today, t.do_date)}일째 남음</span>`);
  if (t.repeat_rule) meta.push(`<span class="meta">↻ ${t.repeat_rule === 'weekly' ? '매주' : '매월'}</span>`);
  if (opts.waiting && t.follow_up_date) {
    const d = diff(t.follow_up_date, today);
    meta.push(`<span class="meta ${d <= 0 ? 'warn' : ''}">확인 ${d < 0 ? md(t.follow_up_date) + ' 지남' : d === 0 ? '오늘' : md(t.follow_up_date)}</span>`);
  }
  if (opts.done && t.done_at) meta.push(`<span class="meta">완료 ${md(seoulDate(new Date(t.done_at)))}</span>`);
  const sub = (opts.subWho || (t.status === 'waiting' && !t.next_action)) && t.waiting_for ? `${esc(t.waiting_for)} 기다리는 중` : (t.next_action ? esc(t.next_action) : '');
  const actions = opts.extra || (opts.followup ? `<div class="row-actions"><button class="btn primary" data-act="received">받음</button><button class="btn" data-act="refollow">다시 미루기</button></div>` : '');
  const checkCls = opts.done ? 'check filled' : 'check';
  return `<div class="row" data-id="${t.id}" ${opts.noswipe ? 'data-noswipe' : ''}>
    <div class="swipe-bg"><span class="l">완료</span><span class="r">미루기</span></div>
    <div class="row-inner">
      <button class="${checkCls}" data-act="${opts.done ? 'undone' : 'done'}" aria-label="${opts.done ? '완료 취소' : '완료'}"></button>
      <div class="row-main">
        <div class="row-title">${t.starred ? '<span class="star" aria-label="중요">★</span>' : ''}${esc(t.title)}</div>
        ${sub ? `<div class="row-sub">${sub}</div>` : ''}
        ${meta.length ? `<div class="row-meta">${meta.join('')}</div>` : ''}
        ${actions}
      </div>
    </div></div>`;
}
const listHTML = (arr, opts) => `<div class="list">${arr.map(t => rowHTML(t, opts)).join('')}</div>`;
const sec = (label, arr, opts = {}, cls = '') => arr.length ? `<section class="sec"><h2 class="sec-h ${cls}">${label} <span class="n">${arr.length}</span></h2>${listHTML(arr, opts)}</section>` : '';

function header(title, sub, right = '') {
  top.innerHTML = `<div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
    <div style="display:flex;align-items:center;gap:10px"><span class="saved"></span>${right}</div>`;
}

function renderToday() {
  const t = T();
  const seg = `<div class="seg" role="group" aria-label="보기"><button data-mode="today" aria-pressed="${ui.todayMode === 'today'}">오늘</button><button data-mode="week" aria-pressed="${ui.todayMode === 'week'}">이번 주</button></div>`;
  header(`${parse(t).getMonth() + 1}월 ${parse(t).getDate()}일 (${DOW[dowOf(t)]})`, '', seg);
  const n = inbox().length;
  let html = (ui.morningCard && ui.todayMode === 'today') ? morningCardHTML() : '';
  html += n ? `<button class="banner" data-act="triage"><span>인박스 ${n}개 정리하기</span><span aria-hidden="true">›</span></button>` : '';
  if (ui.todayMode === 'today') {
    const o = overdue(), d = todayList(), f = followUps();
    html += sec('기한 초과', o, {}, 'danger') + sec('오늘', d) + sec('확인 필요', f, { followup: true, subWho: true, waiting: true, noswipe: true });
    if (!o.length && !d.length && !f.length) html += `<div class="empty-big"><b>오늘 할 일 없음</b><button class="more-toggle" data-mode="week">이번 주 보기 ›</button></div>`;
  } else {
    const we = weekEnd(t);
    html += sec('기한 초과', overdue(), {}, 'danger');
    let day = t;
    while (day <= we) {
      const items = day === t ? todayList() : live().filter(x => !isOverdue(x) && ((x.status === 'active' && x.do_date === day) || (OPEN.has(x.status) && x.status !== 'active' && x.due_date === day))).sort(sortTask);
      html += `<div class="day-h ${day === t ? 'today' : ''}"><span>${day === t ? '오늘' : DOW[dowOf(day)] + '요일'}</span><span class="d">${md(day)}</span></div>`;
      html += items.length ? listHTML(items, {}) : `<div class="list"><div class="empty">—</div></div>`;
      day = addDays(day, 1);
    }
    const later = live().filter(x => x.status === 'active' && !isOverdue(x) && x.do_date > we).sort(sortTask);
    if (later.length) {
      html += `<button class="more-toggle" data-act="toggleLaterWeek">다음 주 이후 ${later.length}개 ${ui.showLaterWeek ? '접기' : '보기'}</button>`;
      if (ui.showLaterWeek) html += listHTML(later, { showDo: true });
    }
  }
  main.innerHTML = html;
}

function renderInbox() {
  const items = inbox();
  header('인박스', items.length ? `${items.length}개` : '', items.length ? `<button class="btn primary" data-act="triage">하나씩 정리</button>` : '');
  main.innerHTML = items.length
    ? `<section class="sec">${listHTML(items, {})}</section><p class="foot-note">행을 왼쪽으로 밀면 날짜를 정할 수 있어요.</p>`
    : `<div class="empty-big"><b>인박스가 비었어요</b>생각난 일은 ＋로 바로 기록하세요.</div>`;
}

function renderWaiting() {
  const items = live().filter(t => t.status === 'waiting').sort((a, b) => (a.follow_up_date || '').localeCompare(b.follow_up_date || ''));
  header('대기', items.length ? `${items.length}개` : '');
  if (!items.length) { main.innerHTML = `<div class="empty-big"><b>기다리는 일이 없어요</b>업무를 왼쪽으로 밀어 ‘대기로’를 고르면 여기에 모여요.</div>`; return; }
  const groups = {};
  items.forEach(t => { const k = t.waiting_for || '대상 미정'; (groups[k] = groups[k] || []).push(t); });
  main.innerHTML = Object.entries(groups).map(([who, arr]) =>
    `<div class="group-person">${esc(who)} <span class="n">${arr.length}</span></div>${listHTML(arr, { waiting: true, noswipe: true })}`).join('');
}

function renderArchive() {
  const seg = `<div class="seg" role="group" aria-label="보관 보기"><button data-arch="later" aria-pressed="${ui.archMode === 'later'}">나중에</button><button data-arch="done" aria-pressed="${ui.archMode === 'done'}">완료</button></div>`;
  header('보관', '', seg);
  let html = '';
  if (ui.archMode === 'later') {
    const items = live().filter(t => t.status === 'later').sort(sortTask);
    html = items.length ? `<section class="sec">${listHTML(items, {})}</section>` : `<div class="empty-big"><b>나중에 할 일이 없어요</b></div>`;
  } else {
    const items = live().filter(t => t.status === 'done').sort((a, b) => (b.done_at || '').localeCompare(a.done_at || ''));
    const groups = {};
    items.forEach(t => { const k = seoulDate(new Date(t.done_at || t.updated_at)); (groups[k] = groups[k] || []).push(t); });
    html = items.length ? Object.entries(groups).map(([d, arr]) => `<div class="day-h"><span>${d === T() ? '오늘' : mdw(d)}</span><span class="d">${arr.length}</span></div>${listHTML(arr, { done: true, noswipe: true })}`).join('')
      : `<div class="empty-big"><b>완료한 일이 없어요</b></div>`;
    if (items.length) html += `<p class="foot-note">초록 체크를 누르면 완료가 취소돼요. 최근 ${DONE_DAYS}일만 보여요.</p>`;
  }
  html += installHintHTML();
  html += `<div class="foot-note"><span class="account">${esc(userEmail)}<span class="brandline">Steward · A daily rhythm for faithful work.</span></span><span class="foot-actions"><button class="btn" data-act="settings">알림 설정</button><button class="btn" data-act="signout">로그아웃</button></span></div>`;
  main.innerHTML = html;
}

function render() {
  if (document.body.classList.contains('signed-out')) return;
  ({ today: renderToday, inbox: renderInbox, waiting: renderWaiting, archive: renderArchive, settings: renderSettings })[ui.tab]();
  const navTab = ui.tab === 'settings' ? 'archive' : ui.tab;   // 설정은 보관 탭 아래
  document.querySelectorAll('.nav [data-tab]').forEach(b => { if (b.dataset.tab === navTab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  const n = inbox().length, badge = document.getElementById('inboxBadge');
  badge.textContent = n; badge.hidden = !n;
  showSave(true);
}
// ---------- 라우팅 (해시) ----------
// #/today  #/today/week  #/inbox  #/waiting  #/archive  #/archive/done
// 체크인: #/checkin/morning|midday|evening|evening_final?d=날짜&n=알림기록  #/review?d=날짜
const ROUTES = {
  '/today':        { tab: 'today', todayMode: 'today' },
  '/today/week':   { tab: 'today', todayMode: 'week' },
  '/inbox':        { tab: 'inbox' },
  '/waiting':      { tab: 'waiting' },
  '/archive':      { tab: 'archive', archMode: 'later' },
  '/archive/done': { tab: 'archive', archMode: 'done' },
  '/settings':     { tab: 'settings' },
};
const pathOf = () => (location.hash.replace(/^#/, '').split('?')[0] || '/today');
const paramsOf = () => new URLSearchParams(location.hash.split('?')[1] || '');
const CHECKIN_KINDS = ['morning', 'midday', 'evening', 'evening_final'];
function pathForUi() {
  if (ui.tab === 'today') return ui.todayMode === 'week' ? '/today/week' : '/today';
  if (ui.tab === 'archive') return ui.archMode === 'done' ? '/archive/done' : '/archive';
  return '/' + ui.tab;
}
function applyRoute() {
  const path = pathOf();
  ui.morningCard = false;
  if (path.startsWith('/checkin/') || path === '/review') return applyCheckinRoute(path);
  const r = ROUTES[path];
  if (!r) { history.replaceState(null, '', '#/today'); Object.assign(ui, ROUTES['/today']); }
  else Object.assign(ui, r);
  if (sheetKind === 'checkin' || sheetKind === 'review') closeSheet();
  if (ui.tab === 'settings') settings.loaded = false;   // 들어올 때마다 최신으로
  render();
}
// replace: 같은 화면 안의 보기 전환(오늘/이번 주, 나중에/완료)은 뒤로 가기 기록을 남기지 않음
function navigate(path, { replace = false } = {}) {
  if (location.hash === '#' + path) return applyRoute();
  if (replace) { history.replaceState(null, '', '#' + path); applyRoute(); }
  else location.hash = path;
}
window.addEventListener('hashchange', () => { applyRoute(); window.scrollTo(0, 0); });
function go(tab) { navigate(tab === 'today' ? (ui.todayMode === 'week' ? '/today/week' : '/today') : tab === 'archive' ? (ui.archMode === 'done' ? '/archive/done' : '/archive') : '/' + tab); }
function setMode(fields) { Object.assign(ui, fields); navigate(pathForUi(), { replace: true }); }

// ---------- 날짜 변경 감지 ----------
// 앱을 오래 열어둬도 자정이 지나면 오늘 기준으로 다시 그림. 앱으로 돌아올 때 서버 데이터도 다시 불러옴.
let currentDay = T(), midnightTimer;
function msToSeoulMidnight() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  return (86400 - (p.hour * 3600 + p.minute * 60 + p.second)) * 1000 + 1500;
}
function scheduleMidnight() { clearTimeout(midnightTimer); midnightTimer = setTimeout(() => checkDay('midnight'), msToSeoulMidnight()); }
function checkDay(reason) {
  if (document.body.classList.contains('signed-out')) return;
  const d = T();
  if (d !== currentDay) { currentDay = d; onDayChange(); }
  else if (reason === 'visible' && pending === 0 && Date.now() - lastLoadAt > 30000) refresh();
  scheduleMidnight();
}
function onDayChange() {
  // 상세와 하루 복기(날짜가 주소에 고정됨)는 유지, 나머지 시트는 닫음
  if (!sheet.hidden && sheetKind !== 'detail' && sheetKind !== 'review') { closeSheet(); toast('날짜가 바뀌었어요'); }
  flushAllText();
  render();          // 우선 화면 날짜부터 바로 갱신
  refresh();         // 서버 기준으로 다시 불러오기 (상세 시트는 열린 채 새 날짜로 다시 그림)
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkDay('visible'); });
window.addEventListener('pageshow', () => checkDay('visible'));
window.addEventListener('focus', () => checkDay('visible'));
setInterval(() => checkDay('tick'), 60000);

// ---------- toast ----------
const toastEl = document.getElementById('toast'), toastMsg = document.getElementById('toastMsg'), toastUndo = document.getElementById('toastUndo');
let toastTimer, undoFn = null;
function toast(msg, undo) {
  toastMsg.textContent = msg; undoFn = undo || null; toastUndo.hidden = !undo; toastEl.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; undoFn = null; }, 5000);
}
toastUndo.addEventListener('click', () => { const f = undoFn; undoFn = null; toastEl.hidden = true; if (f) f(); });

// ---------- sheets ----------
const scrim = document.getElementById('scrim'), sheet = document.getElementById('sheet');
let sheetClose = null, lastFocus = null, sheetKind = null, detailId = null, detailBack = null, reviewRedraw = null;
function openSheet(html, onClose, kind = 'other') {
  sheetKind = kind; if (kind !== 'detail') { detailId = null; detailBack = null; } if (kind !== 'review') reviewRedraw = null;
  lastFocus = document.activeElement;
  sheet.innerHTML = `<button class="grab" data-close aria-label="닫기"><span></span></button>` + html;
  sheet.onclick = null; sheet.hidden = false; scrim.hidden = false; sheetClose = onClose || null; sheet.scrollTop = 0;
}
function closeSheet() {
  if (sheet.hidden) return;
  flushAllText();
  sheet.hidden = true; scrim.hidden = true; sheet.innerHTML = ''; sheetKind = null; detailId = null; detailBack = null; reviewRedraw = null;
  const f = sheetClose; sheetClose = null; if (f) f(); render();
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}
scrim.addEventListener('click', closeSheet);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
(() => { let y0 = null;
  sheet.addEventListener('pointerdown', e => { if (e.target.closest('.grab')) y0 = e.clientY; });
  sheet.addEventListener('pointerup', e => { if (y0 !== null && e.clientY - y0 > 40) closeSheet(); y0 = null; });
})();

// Quick add
function openAdd() {
  let when = ui.tab === 'today' ? (ui.todayMode === 'week' ? 'week' : 'today') : 'inbox', area = null;
  const t = T();
  const whenOpts = [['inbox', '인박스', ''], ['today', '오늘', ''], ['tomorrow', '내일', md(addDays(t, 1))], ['week', '이번 주', md(weekEnd(t))]];
  const draw = () => {
    sheet.querySelector('#whenChips').innerHTML = whenOpts.map(([k, l, s]) => `<button class="chip" data-when="${k}" aria-pressed="${when === k}">${l}${s ? `<small>${s}</small>` : ''}</button>`).join('');
    sheet.querySelector('#areaChips').innerHTML = AREAS.map(a => `<button class="chip" data-area="${a}" aria-pressed="${area === a}">${a}</button>`).join('');
  };
  openSheet(`<h2>빠른 추가</h2>
    <form id="addForm" class="add-row" autocomplete="off">
      <input class="input" id="addTitle" placeholder="무엇을 해야 하나요?" enterkeyhint="done" maxlength="500">
      <button class="btn primary" type="submit">추가</button>
    </form>
    <div class="added" id="addedMsg" aria-live="polite"></div>
    <div class="field"><span class="lbl">언제</span><div class="chips" id="whenChips"></div></div>
    <div class="field"><span class="lbl">분야 · 선택</span><div class="chips" id="areaChips"></div></div>
    <div class="sheet-foot"><span class="meta">엔터로 계속 추가할 수 있어요</span><button class="btn ghost" data-close>닫기</button></div>`);
  draw();
  const input = sheet.querySelector('#addTitle');
  setTimeout(() => input.focus(), 30);
  sheet.querySelector('#whenChips').addEventListener('click', e => { const b = e.target.closest('[data-when]'); if (b) { when = b.dataset.when; draw(); input.focus(); } });
  sheet.querySelector('#areaChips').addEventListener('click', e => { const b = e.target.closest('[data-area]'); if (b) { area = area === b.dataset.area ? null : b.dataset.area; draw(); input.focus(); } });
  sheet.querySelector('#addForm').addEventListener('submit', async e => {
    e.preventDefault();
    const title = input.value.trim(); if (!title) return;
    const map = { inbox: [null, 'inbox'], today: [t, 'active'], tomorrow: [addDays(t, 1), 'active'], week: [weekEnd(t), 'active'] };
    const [d, s] = map[when];
    input.value = '';
    input.focus();
    const msg = sheet.querySelector('#addedMsg');
    const label = whenOpts.find(w => w[0] === when)[1];
    if (msg) msg.textContent = `추가 중 · ${title}`;
    const ok = await insertTask({ title, status: s, do_date: d, area });
    const m2 = sheet.querySelector('#addedMsg');
    if (m2) m2.textContent = ok ? `추가됨 · ${title} → ${label}` : `추가하지 못했어요 · ${title}`;
    if (!ok && !input.value) input.value = title;
  });
}

// Postpone
function openPostpone(id, back) {
  const t = byId(id); if (!t) return; const d = T();
  const opts = [['tomorrow', '내일', addDays(d, 1)], ['week', '이번 주', weekEnd(d)], ['nextweek', '다음 주', nextMonday(d)]];
  openSheet(`<h2>미루기</h2><div class="row-sub" style="margin-top:-6px">${esc(t.title)}</div>
    <div class="field"><div class="chips">
      ${opts.map(([k, l, v]) => `<button class="chip" data-pp="${v}" data-label="${l}">${l}<small>${mdw(v)}</small></button>`).join('')}
      <button class="chip" data-pp="later">나중에</button>
      <button class="chip" data-pp="waiting">대기로</button>
    </div></div>
    <div class="field"><label for="ppDate">날짜 선택</label><div class="date-inline"><input type="date" class="input" id="ppDate" min="${d}"><button class="btn" id="ppGo">적용</button></div></div>`,
    back ? () => setTimeout(back, 0) : null);
  const setDo = (date, label) => {
    const f = t.status === 'active' ? { do_date: date } : { ...statusFields(t, 'active'), do_date: date };
    closeSheet(); change(id, f, label);
  };
  sheet.onclick = e => {
    const b = e.target.closest('[data-pp]');
    if (b) {
      const v = b.dataset.pp;
      if (v === 'waiting') return openWaiting(id, back);
      if (v === 'later') { closeSheet(); return change(id, statusFields(t, 'later'), '나중에로 옮겼어요'); }
      return setDo(v, `${b.dataset.label}(${mdw(v)})로 미뤘어요`);
    }
    if (e.target.id === 'ppGo') {
      const v = sheet.querySelector('#ppDate').value; if (!v) return;
      setDo(v, `${mdw(v)}로 미뤘어요`);
    }
  };
}

// Waiting
function openWaiting(id, back) {
  const t = byId(id); if (!t) return; const d = T();
  const recent = recentWho.slice(0, 5);
  let who = t.waiting_for || '', fu = addDays(d, 3);
  const fuOpts = [['내일', addDays(d, 1)], ['3일 후', addDays(d, 3)], ['다음 주', nextMonday(d)]];
  const draw = () => {
    sheet.querySelector('#whoChips').innerHTML = recent.map(n => `<button class="chip" data-who="${esc(n)}" aria-pressed="${who === n}">${esc(n)}</button>`).join('');
    sheet.querySelector('#fuChips').innerHTML = fuOpts.map(([l, v]) => `<button class="chip" data-fu="${v}" aria-pressed="${fu === v}">${l}<small>${mdw(v)}</small></button>`).join('');
    sheet.querySelector('#wDone').disabled = !who.trim();
  };
  openSheet(`<h2>대기로 넘기기</h2><div class="row-sub" style="margin-top:-6px">${esc(t.title)}</div>
    <div class="field"><label for="whoInput">누구를 기다리나요?</label><div class="chips" id="whoChips" style="margin-bottom:8px"></div>
      <input class="input" id="whoInput" placeholder="직접 입력" maxlength="100" value="${esc(who)}"></div>
    <div class="field"><span class="lbl">언제 다시 확인할까요?</span><div class="chips" id="fuChips"></div></div>
    <div class="sheet-foot"><button class="btn ghost" data-close>취소</button><button class="btn primary" id="wDone">완료</button></div>`,
    back ? () => setTimeout(back, 0) : null);
  draw();
  const input = sheet.querySelector('#whoInput');
  input.addEventListener('input', () => { who = input.value; draw(); });
  sheet.querySelector('#whoChips').addEventListener('click', e => { const b = e.target.closest('[data-who]'); if (b) { who = b.dataset.who; input.value = who; draw(); } });
  sheet.querySelector('#fuChips').addEventListener('click', e => { const b = e.target.closest('[data-fu]'); if (b) { fu = b.dataset.fu; draw(); } });
  sheet.querySelector('#wDone').addEventListener('click', async () => {
    const name = who.trim();
    closeSheet();
    const prev = await change(id, { status: 'waiting', waiting_for: name, follow_up_date: fu });
    if (prev) {
      recentWho = [name, ...recentWho.filter(x => x !== name)].slice(0, 8);
      toast(`${name} 대기 · ${mdw(fu)} 확인`, () => patch(id, prev));
    }
  });
}

// Re-follow-up
function openRefollow(id) {
  const t = byId(id); const d = T();
  const opts = [['내일', addDays(d, 1)], ['3일 후', addDays(d, 3)], ['다음 주', nextMonday(d)]];
  openSheet(`<h2>다시 확인할 날</h2><div class="row-sub" style="margin-top:-6px">${esc(t.title)} · ${esc(t.waiting_for)}</div>
    <div class="field"><div class="chips">${opts.map(([l, v]) => `<button class="chip" data-rf="${v}">${l}<small>${mdw(v)}</small></button>`).join('')}</div></div>`);
  sheet.querySelector('.chips').addEventListener('click', e => {
    const b = e.target.closest('[data-rf]'); if (!b) return;
    closeSheet(); change(id, { follow_up_date: b.dataset.rf }, `${mdw(b.dataset.rf)}에 다시 확인`);
  });
}

// Triage
function openTriage() {
  const queue = inbox().map(t => t.id); const total = queue.length; if (!total) return;
  let done = 0;
  const step = () => {
    while (queue.length && byId(queue[0])?.status !== 'inbox') queue.shift();
    if (!queue.length) { closeSheet(); go('today'); return toast(`인박스 ${done}개 정리 완료`); }
    const t = byId(queue[0]);
    openSheet(`<div class="sheet-foot" style="margin-top:0;margin-bottom:12px"><h2 style="margin:0">인박스 정리</h2><span class="progress">${done + 1} / ${total}</span></div>
      <div class="triage-card"><div class="t">${esc(t.title)}</div><div class="c">${md(seoulDate(new Date(t.created_at)))} 추가</div></div>
      <div class="triage-actions">
        <button class="btn primary" data-tr="today">오늘</button>
        <button class="btn" data-tr="week">이번 주</button>
        <button class="btn" data-tr="later">나중에</button>
        <button class="btn danger" data-tr="del">삭제</button>
      </div>
      <div class="field"><span class="lbl">분야 · 선택</span><div class="chips">${AREAS.map(a => `<button class="chip" data-tarea="${a}" aria-pressed="${t.area === a}">${a}</button>`).join('')}</div></div>
      <div class="sheet-foot"><button class="btn ghost" data-close>그만하기</button><button class="btn ghost" data-tr="skip">건너뛰기</button></div>`);
    sheet.onclick = e => {
      const ab = e.target.closest('[data-tarea]');
      if (ab) {
        const area = t.area === ab.dataset.tarea ? null : ab.dataset.tarea;
        patch(t.id, { area }, { rerender: false });
        sheet.querySelectorAll('[data-tarea]').forEach(c => c.setAttribute('aria-pressed', c.dataset.tarea === area));
        return;
      }
      const b = e.target.closest('[data-tr]'); if (!b) return;
      const k = b.dataset.tr;
      sheet.onclick = null;
      if (k === 'skip') { queue.push(queue.shift()); return step(); }
      const f = k === 'today' ? { status: 'active', do_date: T() }
              : k === 'week' ? { status: 'active', do_date: weekEnd(T()) }
              : k === 'later' ? { status: 'later' }
              : { deleted_at: new Date().toISOString() };
      queue.shift(); done += 1;
      patch(t.id, f, { rerender: false });
      step();
    };
  };
  step();
}

// Detail
function openDetail(id, back) {
  const t = byId(id); if (!t) return;
  const draw = () => {
    const d = T();
    const cur = byId(id); if (!cur) return closeSheet();
    const keep = sheet.hidden ? 0 : sheet.scrollTop;
    const st = [['inbox', '인박스'], ['active', '진행'], ['waiting', '대기'], ['later', '나중'], ['done', '완료']];
    const doOpts = [['오늘', d], ['내일', addDays(d, 1)], ['이번 주', weekEnd(d)], ['다음 주', nextMonday(d)]];
    const links = (cur.memo.match(/https?:\/\/[^\s]+/g) || []);
    openSheet(`
      <div class="title-row"><input class="title-input" id="dTitle" value="${esc(cur.title)}" aria-label="업무명" maxlength="500">
        <button class="star-btn" id="dStar" aria-pressed="${cur.starred}" aria-label="중요 표시">${cur.starred ? '★' : '☆'}</button></div>
      <div class="field"><span class="lbl">상태</span><div class="chips" id="dStatus">${st.filter(([k]) => k !== 'inbox' || cur.status === 'inbox').map(([k, l]) => `<button class="chip" data-st="${k}" aria-pressed="${cur.status === k}">${l}</button>`).join('')}</div></div>
      ${cur.status === 'waiting' ? `<div class="field"><span class="lbl">대기</span><div class="row-sub">${esc(cur.waiting_for || '대상 미정')} · ${cur.follow_up_date ? mdw(cur.follow_up_date) + ' 확인' : ''}</div><button class="btn" id="dWaitEdit" style="margin-top:8px">대상·확인일 바꾸기</button></div>` : ''}
      ${cur.status === 'active' ? `<div class="field"><span class="lbl">할 날 ${cur.do_date ? `· ${mdw(cur.do_date)}` : ''}</span><div class="chips" id="dDo">${doOpts.map(([l, v]) => `<button class="chip" data-do="${v}" aria-pressed="${cur.do_date === v}">${l}</button>`).join('')}
        </div><div class="date-inline" style="margin-top:8px"><input type="date" class="input" id="dDoDate" value="${cur.do_date || ''}" aria-label="할 날 직접 선택"></div></div>` : ''}
      <div class="field"><label for="dDue">마감</label><div class="date-inline"><input type="date" class="input" id="dDue" value="${cur.due_date || ''}">${cur.due_date ? '<button class="btn ghost" id="dDueClear">마감 없음</button>' : ''}</div>${cur.status === 'active' && cur.do_date && cur.due_date && cur.do_date > cur.due_date ? `<div class="meta warn" style="margin-top:6px">할 날(${md(cur.do_date)})이 마감(${md(cur.due_date)})보다 늦어요</div>` : ''}</div>
      <div class="field"><span class="lbl">분야</span><div class="chips" id="dArea">${AREAS.map(a => `<button class="chip" data-ar="${a}" aria-pressed="${cur.area === a}">${a}</button>`).join('')}</div></div>
      <div class="field"><label for="dMemo">메모</label><textarea class="textarea" id="dMemo" placeholder="링크도 여기에" maxlength="10000">${esc(cur.memo)}</textarea>
        ${links.length ? `<div class="links">${links.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`).join('')}</div>` : ''}</div>
      <details class="more" ${cur.next_action || cur.repeat_rule ? 'open' : ''}><summary>더보기</summary>
        <div class="field"><label for="dNext">다음 행동</label><input class="input" id="dNext" value="${esc(cur.next_action)}" placeholder="예: 3팀 폴더만 남음"></div>
        <div class="field"><span class="lbl">반복</span><div class="chips" id="dRepeat">${[[null, '없음'], ['weekly', '매주'], ['monthly', '매월']].map(([k, l]) => `<button class="chip" data-rp="${k}" aria-pressed="${cur.repeat_rule === k}">${l}</button>`).join('')}</div></div>
        <div class="metaline">만든 날 ${md(seoulDate(new Date(cur.created_at)))} · 출처 ${cur.source}</div>
      </details>
      <div class="sheet-foot"><button class="btn danger" id="dDel">삭제</button><span class="saved"></span><button class="btn primary" data-close>닫기</button></div>`, back ? () => setTimeout(back, 0) : null, 'detail');
    detailId = id; detailBack = back || null;
    bind(cur);
    sheet.scrollTop = keep;
    showSave(true);
  };
  // 칩·날짜 같은 명시적 선택: 즉시 저장 후 다시 그림
  const set = async fields => { flushAllText(); await patch(id, fields, { rerender: false }); draw(); };
  const bind = cur => {
    const q = s => sheet.querySelector(s);
    q('#dTitle').addEventListener('input', e => saveTextLater(id, 'title', e.target.value));
    q('#dTitle').addEventListener('blur', () => flushText(id + ':title'));
    q('#dStar').addEventListener('click', () => set({ starred: !cur.starred }));
    q('#dStatus').addEventListener('click', e => {
      const b = e.target.closest('[data-st]'); if (!b || b.dataset.st === cur.status) return;
      if (b.dataset.st === 'waiting') { flushAllText(); return openWaiting(id, () => openDetail(id, back)); }
      if (b.dataset.st === 'done') { closeSheet(); return completeTask(id, null); }
      if (cur.status === 'done') { closeSheet(); return uncompleteTask(id); }
      set(statusFields(cur, b.dataset.st));
    });
    q('#dWaitEdit')?.addEventListener('click', () => { flushAllText(); openWaiting(id, () => openDetail(id, back)); });
    q('#dDo')?.addEventListener('click', e => { const b = e.target.closest('[data-do]'); if (b) set({ do_date: b.dataset.do }); });
    q('#dDoDate')?.addEventListener('change', e => { if (e.target.value) set({ do_date: e.target.value }); });
    q('#dDue').addEventListener('change', e => set({ due_date: e.target.value || null }));
    q('#dDueClear')?.addEventListener('click', () => set({ due_date: null }));
    q('#dArea').addEventListener('click', e => { const b = e.target.closest('[data-ar]'); if (b) set({ area: cur.area === b.dataset.ar ? null : b.dataset.ar }); });
    q('#dMemo').addEventListener('input', e => saveTextLater(id, 'memo', e.target.value));
    q('#dMemo').addEventListener('blur', () => flushText(id + ':memo'));
    q('#dNext').addEventListener('input', e => saveTextLater(id, 'next_action', e.target.value));
    q('#dNext').addEventListener('blur', () => flushText(id + ':next_action'));
    q('#dRepeat').addEventListener('click', e => { const b = e.target.closest('[data-rp]'); if (b) set({ repeat_rule: b.dataset.rp === 'null' ? null : b.dataset.rp }); });
    q('#dDel').addEventListener('click', () => { closeSheet(); change(id, { deleted_at: new Date().toISOString() }, '삭제했어요'); });
  };
  draw();
}

// ---------- 체크인 (설계: docs/checkin-design.md v2) ----------
// 09 morning: TODAY + 아침 카드 / 12·15 midday: 남은 업무 + 빠른 추가
// 18 evening: 한 장씩 재조정 (오늘 유지 첫 버튼) / 21 evening_final: 목록 + 모두 내일로
// 23 review: 요약 + 한 줄 복기 + 내일 가장 중요한 일
const clockNow = () => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
// day 기준으로 아직 끝나지 않은 일: 할 날이 지났거나 오늘인 진행 업무 + 상태와 관계없이 마감이 지났거나 오늘인 업무
const remainingOn = day => live().filter(t => OPEN.has(t.status) && ((t.status === 'active' && t.do_date && t.do_date <= day) || (t.due_date && t.due_date <= day)))
  .sort((a, b) => ((a.due_date && a.due_date < day) ? 0 : 1) - ((b.due_date && b.due_date < day) ? 0 : 1) || sortTask(a, b));
const doneOn = day => live().filter(t => t.status === 'done' && t.done_at && seoulDate(new Date(t.done_at)) === day);
const moveFields = (t, date) => t.status === 'active' ? { do_date: date } : { ...statusFields(t, 'active'), do_date: date };
const cardMeta = t => [t.area,
  t.due_date ? (t.due_date < T() ? `마감 ${md(t.due_date)} 지남` : t.due_date === T() ? '오늘 마감' : `마감 ${md(t.due_date)}`) : '',
  t.status !== 'active' ? { inbox: '인박스', waiting: '대기 중', later: '나중에' }[t.status] : ''].filter(Boolean).join(' · ');
// 체크인 시트를 닫으면 주소를 오늘로 (뒤로 가기 기록은 남기지 않음)
const leaveCheckin = () => { if (/^#\/(checkin|review)/.test(location.hash)) history.replaceState(null, '', '#/today'); };

function applyCheckinRoute(path) {
  const today = T();
  let d = paramsOf().get('d');
  const n = paramsOf().get('n');
  ui.checkinLog = /^[0-9a-f-]{36}$/.test(n || '') ? n : null;
  if (ui.checkinLog) markCheckin('opened');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '') || d > today) d = today;
  Object.assign(ui, ROUTES['/today']);
  if (!sheet.hidden) { sheetClose = null; closeSheet(); }   // 이전 시트의 '주소 되돌리기'가 새 주소를 덮지 않게
  if (path === '/review') {
    if (d < addDays(today, -7)) d = today;
    render(); return openReview(d);
  }
  const kind = path.slice('/checkin/'.length);
  if (!CHECKIN_KINDS.includes(kind)) { history.replaceState(null, '', '#/today'); return render(); }
  // 체크인 알림을 다음 날 눌렀으면 정리 화면 대신 오늘 화면만
  if (d < today) { history.replaceState(null, '', '#/today'); render(); return toast(d === addDays(today, -1) ? '어제 알림이에요 · 오늘 화면을 보여드려요' : '지난 알림이에요 · 오늘 화면을 보여드려요'); }
  if (kind === 'morning') { ui.morningCard = true; return render(); }
  render();
  if (kind === 'midday') openMidday();
  else if (kind === 'evening') openEvening();
  else openEveningFinal();
}

// 09:00 아침 카드
function morningCardHTML() {
  const rv = reviews[addDays(T(), -1)];
  const topTask = rv?.top_task_id ? byId(rv.top_task_id) : null;
  let topHTML = '';
  if (topTask && !topTask.deleted_at) {
    topHTML = topTask.status === 'done'
      ? `<div class="cc-label">★ 어제 정한 「${esc(topTask.title)}」은 이미 끝냈어요</div>`
      : `<div class="cc-label">★ 오늘 가장 중요한 일</div>${listHTML([topTask], { noswipe: true })}`;
  }
  return `<section class="cc-card" aria-label="아침 체크인">
    <div class="cc-head"><b>좋은 아침이에요</b><span class="cc-counts">기한 초과 ${overdue().length} · 오늘 ${todayList().length} · 확인 필요 ${followUps().length}</span></div>
    ${topHTML}
    <div class="cc-actions"><button class="btn primary" data-act="cc-add">＋ 추가</button><button class="btn ghost" data-act="cc-close">닫기</button></div>
  </section>`;
}
function dismissMorning() { ui.morningCard = false; markCheckin('completed'); leaveCheckin(); render(); }

// 12:00 · 15:00 중간 체크
function openMidday() {
  let draft = '';
  const draw = (focusAdd = false) => {
    const today = T(), rem = remainingOn(today), keep = sheet.hidden ? 0 : sheet.scrollTop;
    openSheet(`<div class="ci-head"><h2>중간 체크</h2><span class="progress">남음 ${rem.length} · 완료 ${doneOn(today).length}</span></div>
      <p class="ci-sub">${clockNow()} · 남은 업무를 확인하고, 생각난 일은 바로 적어 두세요.</p>
      ${rem.length ? `<div class="list ci-list">${rem.map(t => rowHTML(t, { noswipe: true })).join('')}</div>` : `<div class="list"><div class="empty">오늘 남은 업무가 없어요.</div></div>`}
      <form class="add-row ci-add" id="ciAdd" autocomplete="off"><input class="input" id="ciAddTitle" placeholder="생각난 일 바로 추가…" maxlength="500" enterkeyhint="done" value="${esc(draft)}"><button class="btn" type="submit">추가</button></form>
      <div class="sheet-foot"><span class="saved"></span><button class="btn primary" id="ciDone">확인 완료</button></div>`, leaveCheckin, 'checkin');
    sheet.scrollTop = keep;
    const input = sheet.querySelector('#ciAddTitle');
    if (focusAdd) input.focus();
    input.addEventListener('input', () => { draft = input.value; });
    sheet.querySelector('#ciAdd').addEventListener('submit', async e => {
      e.preventDefault();
      const title = input.value.trim(); if (!title) return;
      draft = ''; input.value = '';
      await insertTask({ title, status: 'active', do_date: T() });
      if (sheetKind === 'checkin') draw(true);
    });
    sheet.querySelector('#ciDone').addEventListener('click', () => { markCheckin('completed'); closeSheet(); toast('중간 체크 완료'); });
    sheet.onclick = async e => {
      const row = e.target.closest('.row'); if (!row) return;
      const id = row.dataset.id;
      if (e.target.closest('.check')) { await completeTask(id, null); if (sheetKind === 'checkin') draw(); return; }
      openDetail(id, () => draw());
    };
  };
  draw();
}

// 18:00 저녁 재조정 — 한 장씩
function openEvening() {
  const queue = remainingOn(T()).map(t => t.id), total = queue.length, handled = new Set();
  let kept = 0;
  if (!total) {
    return openSheet(`<h2>저녁 재조정</h2><div class="empty-big"><b>오늘 남은 업무가 없어요</b>오늘은 여기까지 해도 좋아요.</div>
      <div class="sheet-foot"><span></span><button class="btn primary" data-close>닫기</button></div>`, leaveCheckin, 'checkin');
  }
  const alive = id => { const t = byId(id); return t && !t.deleted_at && t.status !== 'done'; };
  const step = () => {
    while (queue.length && (handled.has(queue[0]) || !alive(queue[0]))) queue.shift();
    if (!queue.length) { markCheckin('completed'); closeSheet(); return toast(kept ? `저녁 재조정 끝 · 오늘 ${kept}개 남김` : '저녁 재조정 끝'); }
    const t = byId(queue[0]);
    openSheet(`<div class="ci-head"><h2>저녁 재조정</h2><span class="progress">${total - queue.length + 1} / ${total}</span></div>
      <p class="ci-sub">오늘 안에 할 수 있나요?</p>
      <div class="triage-card"><div class="t">${esc(t.title)}</div><div class="c">${esc(cardMeta(t)) || '&nbsp;'}</div></div>
      <div class="triage-actions">
        <button class="btn primary" data-ev="keep">오늘 유지</button>
        <button class="btn" data-ev="tomorrow">내일</button>
        <button class="btn" data-ev="wait">대기</button>
        <button class="btn" data-ev="done">완료</button>
      </div>
      <div class="sheet-foot"><button class="btn ghost" data-close>그만하기</button><button class="btn ghost" data-ev="skip">건너뛰기 ›</button></div>`, leaveCheckin, 'checkin');
    sheet.onclick = async e => {
      const b = e.target.closest('[data-ev]'); if (!b) return;
      const k = b.dataset.ev, id = queue[0];
      sheet.onclick = null;
      if (k === 'keep') { handled.add(id); kept++; return step(); }
      if (k === 'skip') { queue.push(queue.shift()); return step(); }
      if (k === 'tomorrow') { handled.add(id); patch(id, moveFields(t, addDays(T(), 1)), { rerender: false }); return step(); }
      if (k === 'wait') return openWaiting(id, () => { if (byId(id)?.status === 'waiting') handled.add(id); step(); });
      if (k === 'done') { handled.add(id); await completeTask(id, null); return step(); }
    };
  };
  step();
}

// 21:00 오늘 마무리 — 목록 한 화면
function openEveningFinal() {
  const handled = new Set();
  const finalActions = `<div class="row-actions"><button class="btn" data-fin="tomorrow">내일</button><button class="btn" data-fin="wait">대기</button><button class="btn" data-fin="other">다른 날</button></div>`;
  const draw = () => {
    const today = T(), tm = addDays(today, 1);
    const rem = remainingOn(today).filter(t => !handled.has(t.id)), doneN = doneOn(today).length;
    const keep = sheet.hidden ? 0 : sheet.scrollTop;
    if (!rem.length) {
      markCheckin('completed');
      return openSheet(`<h2>오늘 마무리</h2><div class="empty-big"><b>오늘 마무리 완료</b>완료 ${doneN}개 · 23시에 하루를 1분만 돌아봐요.</div>
        <div class="sheet-foot"><span></span><button class="btn primary" data-close>닫기</button></div>`, leaveCheckin, 'checkin');
    }
    openSheet(`<div class="ci-head"><h2>오늘 마무리</h2><span class="progress">완료 ${doneN} · 남음 ${rem.length}</span></div>
      <p class="ci-sub">남은 업무를 넘기고 오늘을 마무리해요.</p>
      <div class="list ci-list">${rem.map(t => rowHTML(t, { noswipe: true, extra: finalActions })).join('')}</div>
      <div class="ci-stack"><button class="btn primary" data-fin="all">남은 ${rem.length}개 모두 내일로</button></div>
      <button class="more-toggle" data-close data-fin-later>오늘 밤에 끝낼 거예요 ›</button>`, leaveCheckin, 'checkin');
    sheet.scrollTop = keep;
    sheet.onclick = async e => {
      if (e.target.closest('[data-fin-later]')) return markCheckin('completed');
      const b = e.target.closest('[data-fin]');
      if (b?.dataset.fin === 'all') { sheet.onclick = null; return confirmMoveAll(rem.map(t => t.id), today, draw, handled); }
      const row = e.target.closest('.row'); if (!row) return;
      const id = row.dataset.id, t = byId(id); if (!t) return;
      if (e.target.closest('.check')) { handled.add(id); await completeTask(id, null); if (sheetKind === 'checkin') draw(); return; }
      if (b) {
        const k = b.dataset.fin;
        if (k === 'tomorrow') { handled.add(id); patch(id, moveFields(t, tm), { rerender: false }); return draw(); }
        if (k === 'wait') return openWaiting(id, () => { if (byId(id)?.status === 'waiting') handled.add(id); draw(); });
        if (k === 'other') {
          const before = t.status + '|' + t.do_date;
          return openPostpone(id, () => { const x = byId(id); if (x && x.status + '|' + x.do_date !== before) handled.add(id); draw(); });
        }
        return;
      }
      openDetail(id, draw);
    };
  };
  draw();
}

// "모두 내일로" — 마감 있는 업무가 섞여 있으면 같은 시트 안에서 한 번 확인 (21시·23시 공통)
function confirmMoveAll(ids, baseDay, back, handled) {
  const tm = addDays(baseDay, 1);
  const doMove = async list => {
    list.forEach(id => handled?.add(id));
    const prevs = [];
    await Promise.all(list.map(id => { const t = byId(id); return t ? patch(id, moveFields(t, tm), { rerender: false }).then(p => { if (p) prevs.push([id, p]); }) : null; }));
    back();
    if (prevs.length) toast(`${prevs.length}개를 ${mdw(tm)}로 옮겼어요`, async () => {
      prevs.forEach(([id]) => handled?.delete(id));
      await Promise.all(prevs.map(([id, p]) => patch(id, p, { rerender: false })));
      if (sheetKind === 'checkin' || sheetKind === 'review') back(); else render();
    });
  };
  const withDue = ids.filter(id => { const t = byId(id); return t?.due_date && t.due_date <= baseDay; });
  if (!withDue.length) return doMove(ids);
  const today = T(), over = withDue.filter(id => byId(id).due_date < today).length, dueToday = withDue.length - over;
  const kind = sheetKind;
  openSheet(`<h2>마감이 있는 업무가 있어요</h2>
    <p class="ci-sub">${[over ? `기한 초과 ${over}` : '', dueToday ? `오늘 마감 ${dueToday}` : ''].filter(Boolean).join(' · ')}</p>
    <ul class="ci-due">${withDue.map(id => { const t = byId(id); return `<li><span>${esc(t.title)}</span><span class="meta danger">${t.due_date < today ? md(t.due_date) + ' 마감' : '오늘 마감'}</span></li>`; }).join('')}</ul>
    <p class="ci-note">내일로 옮겨도 마감일은 바뀌지 않고, 내일 TODAY에 기한 초과로 표시돼요.</p>
    <div class="ci-stack">
      <button class="btn primary" data-mv="safe">마감 있는 것 빼고 옮기기</button>
      <button class="btn" data-mv="all">모두 내일로</button>
      <button class="btn ghost" data-mv="cancel">취소</button>
    </div>`, leaveCheckin, kind);
  sheet.onclick = e => {
    const b = e.target.closest('[data-mv]'); if (!b) return;
    sheet.onclick = null;
    if (b.dataset.mv === 'safe') { const rest = ids.filter(id => !withDue.includes(id)); return rest.length ? doMove(rest) : back(); }
    if (b.dataset.mv === 'all') return doMove(ids);
    back();
  };
}

// 23:00 하루 복기 — d는 알림 주소의 날짜 (자정 넘어 열어도 그날 기준, "내일" = d + 1)
function openReview(d, st = { note: null, top: undefined, newTitle: '' }) {
  const tm = addDays(d, 1), rv = reviews[d];
  if (st.note === null) st.note = rv?.note || '';
  if (st.top === undefined) st.top = rv?.top_task_id || null;
  const doneList = doneOn(d), rem = remainingOn(d);
  const remIds = new Set(rem.map(t => t.id));
  const cands = live().filter(t => t.status === 'active' && (t.do_date === tm || remIds.has(t.id))).sort(sortTask);
  if (st.top && !cands.some(t => t.id === st.top)) st.top = null;
  const redraw = () => openReview(d, st);
  const keep = sheet.hidden ? 0 : sheet.scrollTop;
  const remActions = `<div class="row-actions"><button class="btn" data-rv="tomorrow">${d === T() ? '내일' : md(tm)}</button><button class="btn" data-rv="wait">대기</button></div>`;
  openSheet(`<div class="ci-head"><h2>${md(d)} (${DOW[dowOf(d)]}) 돌아보기</h2></div>
    <p class="ci-sub">완료 ${doneList.length} · 남음 ${rem.length}</p>
    ${doneList.length ? `<details class="more rv-done"><summary>완료한 일 ${doneList.length}</summary><ul class="rv-list">${doneList.map(t => `<li>${esc(t.title)}</li>`).join('')}</ul></details>` : ''}
    ${rem.length ? `<section class="rv-sec"><div class="lbl">남은 일 ${rem.length}</div>
      <div class="list ci-list">${rem.map(t => rowHTML(t, { noswipe: true, extra: remActions })).join('')}</div>
      <button class="more-toggle" data-rv="all">남은 것 모두 ${d === T() ? '내일로' : md(tm) + '로'}</button></section>` : ''}
    <div class="field"><label for="rvNote">오늘 한 줄</label>
      <textarea class="textarea rv-note" id="rvNote" maxlength="300" placeholder="오늘 기억하고 싶은 것 한 줄 (선택)">${esc(st.note)}</textarea></div>
    <div class="field"><span class="lbl">${d === T() ? '내일' : md(tm)} 가장 중요한 일</span>
      <div class="rv-cands">${cands.map(t => `<label class="rv-cand"><input type="radio" name="rvTop" value="${t.id}" ${st.top === t.id && !st.newTitle ? 'checked' : ''}><span>${esc(t.title)}</span></label>`).join('') || `<div class="empty">${d === T() ? '내일' : md(tm)} 할 일로 잡힌 업무가 없어요.</div>`}</div>
      <input class="input rv-new" id="rvNew" placeholder="새로 입력…" maxlength="500" value="${esc(st.newTitle)}"></div>
    <div class="sheet-foot"><button class="btn ghost" data-close>닫기</button><span class="saved"></span><button class="btn primary" id="rvSave">저장하고 마치기</button></div>`, leaveCheckin, 'review');
  sheet.scrollTop = keep;
  reviewRedraw = redraw;
  const q = sel => sheet.querySelector(sel);
  q('#rvNote').addEventListener('input', e => { st.note = e.target.value; });
  q('#rvNew').addEventListener('input', e => {
    st.newTitle = e.target.value;
    if (st.newTitle.trim()) sheet.querySelectorAll('[name=rvTop]').forEach(r => { r.checked = false; });
  });
  sheet.querySelectorAll('[name=rvTop]').forEach(r => r.addEventListener('change', () => { st.top = r.value; st.newTitle = ''; q('#rvNew').value = ''; }));
  q('#rvSave').addEventListener('click', async e => {
    const btn = e.currentTarget; btn.disabled = true;
    const newTitle = st.newTitle.trim();
    try {
      unwrap(await track(db.rpc('save_daily_review', { p_date: d, p_note: st.note.trim() || null, p_top_task_id: newTitle ? null : st.top, p_new_title: newTitle || null })));
      await loadAll();
      closeSheet();
      markCheckin('completed');
      toast('하루 복기를 저장했어요');
    } catch (err) { btn.disabled = false; saveError(err); }
  });
  sheet.onclick = async e => {
    const b = e.target.closest('[data-rv]');
    if (b?.dataset.rv === 'all') { sheet.onclick = null; return confirmMoveAll(rem.map(t => t.id), d, redraw); }
    const row = e.target.closest('.row'); if (!row) return;
    const id = row.dataset.id, t = byId(id); if (!t) return;
    if (e.target.closest('.check')) { await completeTask(id, null); if (sheetKind === 'review') redraw(); return; }
    if (b?.dataset.rv === 'tomorrow') { await patch(id, moveFields(t, tm), { rerender: false }); return redraw(); }
    if (b?.dataset.rv === 'wait') return openWaiting(id, redraw);
    if (b) return;
    openDetail(id, redraw);
  };
}

// ---------- 알림 설정 (#/settings) · 기기 구독 ----------
const KIND_LABEL = { morning: '아침 · 오늘 할 일', midday: '중간 체크', evening: '저녁 재조정', evening_final: '오늘 마무리', review: '하루 복기' };
const DAY_CHIPS = [[1, '월'], [2, '화'], [3, '수'], [4, '목'], [5, '금'], [6, '토'], [0, '일']];
const SUB_KEY = 'steward.push.subscriptionId';
const store = { get: k => { try { return localStorage.getItem(k); } catch (_) { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) {} } };
const settings = { loaded: false, loading: false, slots: [], prefs: null, devices: [], device: 'unknown', busy: false, openSlot: null };
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const deviceLabel = () => /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad'
  : /Android/.test(navigator.userAgent) ? 'Android' : /Mac/.test(navigator.platform) ? 'Mac' : /Win/.test(navigator.platform) ? 'Windows PC' : '이 기기';
const daysText = w => { const s = [...w].sort().join(); return s === '0,1,2,3,4,5,6' ? '매일' : s === '1,2,3,4,5' ? '평일' : s === '0,6' ? '주말' : DAY_CHIPS.filter(([n]) => w.includes(n)).map(([, l]) => l).join(''); };
const b64ToBytes = b64 => { const p = '='.repeat((4 - b64.length % 4) % 4); const raw = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, c => c.charCodeAt(0)); };

function markCheckin(what) {
  const id = ui.checkinLog; if (!id) return;
  if (what === 'completed') ui.checkinLog = null;
  db.rpc('mark_checkin', { p_log_id: id, p_what: what }).then(r => { if (r.error) console.error('[taskhub] mark', r.error); });
}

async function vapidPublicKey() {
  const cached = store.get('steward.vapidPublicKey'); if (cached) return cached;
  const r = await fetch(`${CFG.supabaseUrl}/functions/v1/send-checkins?vapid=public`);
  if (!r.ok) throw new Error('vapid ' + r.status);
  const { publicKey } = await r.json();
  store.set('steward.vapidPublicKey', publicKey);
  return publicKey;
}
async function currentBrowserSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration(); if (!reg) return null;
  return reg.pushManager.getSubscription();
}
async function registerSub(sub) {
  const j = sub.toJSON();
  const id = unwrap(await track(db.rpc('register_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_label: deviceLabel() })));
  store.set(SUB_KEY, id);
  return id;
}
// 이 기기 상태: unsupported | ios-browser | denied | on | off
async function detectDevice() {
  if (isIOS() && !isStandalone()) return 'ios-browser';
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const sub = await currentBrowserSub();
  return sub && store.get(SUB_KEY) ? 'on' : 'off';
}
async function subscribeThisDevice() {
  // 권한 요청은 버튼을 눌렀을 때만
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { settings.device = perm === 'denied' ? 'denied' : 'off'; return render(); }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(await vapidPublicKey()) });
  await registerSub(sub);
  if (settings.prefs && !settings.prefs.enabled) await setPrefs(true);
}
async function unsubscribeThisDevice() {
  const id = store.get(SUB_KEY);
  if (id) { await db.rpc('remove_push_subscription', { p_id: id }); store.set(SUB_KEY, null); }
  const sub = await currentBrowserSub(); if (sub) await sub.unsubscribe();
}
// 앱을 열 때 이 기기 구독을 서버와 맞춤 (주소가 바뀌었거나 만료 처리됐어도 다시 활성)
async function syncThisDevice() {
  try { if (Notification.permission !== 'granted') return; const sub = await currentBrowserSub(); if (sub) await registerSub(sub); } catch (_) {}
}

async function loadSettings() {
  if (settings.loading) return; settings.loading = true;
  try {
    unwrap(await db.rpc('ensure_default_slots'));
    const [slots, prefs, devices] = await Promise.all([
      db.from('checkin_slots').select('id,kind,local_time,weekdays,enabled').order('local_time'),
      db.from('notification_prefs').select('enabled').maybeSingle(),
      db.from('push_subscriptions').select('id,device_label,created_at,last_success_at,disabled_at').order('created_at'),
    ]);
    settings.slots = unwrap(slots).map(x => { const r = { ...x, local_time: x.local_time.slice(0, 5) }; r._saved = { local_time: r.local_time, weekdays: r.weekdays, enabled: r.enabled }; return r; });
    settings.prefs = unwrap(prefs) || { enabled: true };
    settings.devices = unwrap(devices);
    settings.device = await detectDevice();
    settings.loaded = true;
  } catch (e) { console.error('[taskhub] settings', e); settings.error = true; }
  finally { settings.loading = false; }
  if (ui.tab === 'settings') render();
}
async function setPrefs(enabled) {
  const prev = settings.prefs.enabled; settings.prefs.enabled = enabled; render();
  try { unwrap(await track(db.from('notification_prefs').update({ enabled }).not('user_id', 'is', null).select())); }   // 보안 규칙상 본인 행만 바뀜
  catch (e) { settings.prefs.enabled = prev; render(); saveError(e); }
}
// 실패하면 '서버가 마지막으로 확인한 값'(_saved)으로 되돌림 → 저장이 겹쳐도 화면 값만 믿고 되돌리지 않음
async function updateSlot(id, fields, revertMsg) {
  const slot = settings.slots.find(x => x.id === id);
  Object.assign(slot, fields); render();
  try {
    const row = unwrap(await track(db.from('checkin_slots').update(fields).eq('id', id).select('id,kind,local_time,weekdays,enabled').single()));
    Object.assign(slot, row, { local_time: row.local_time.slice(0, 5) });
    slot._saved = { local_time: slot.local_time, weekdays: slot.weekdays, enabled: slot.enabled };
    settings.slots.sort((a, b) => a.local_time.localeCompare(b.local_time)); render();
  } catch (e) {
    Object.assign(slot, slot._saved); settings.slots.sort((a, b) => a.local_time.localeCompare(b.local_time)); render();
    if (e.code === '23505' || /checkin_slots_time_uniq|duplicate/i.test(e.message || '')) toast('같은 시각의 알림이 이미 있어요'); else if (revertMsg) toast(revertMsg); else saveError(e);
  }
}

function renderSettings() {
  header('알림 설정', 'Steward 체크인');
  if (!settings.loaded) {
    main.innerHTML = settings.error ? `<div class="empty-big"><b>불러오지 못했어요</b>연결을 확인하고 다시 열어 주세요.</div>` : `<div class="loading">불러오는 중…</div>`;
    if (!settings.loading && !settings.error) loadSettings();
    return;
  }
  const thisId = store.get(SUB_KEY);
  const others = settings.devices.filter(d => d.id !== thisId);
  const dev = settings.device;
  const deviceHTML = {
    'ios-browser': `<p class="set-note">iPhone은 <b>홈 화면에 추가한 Steward 앱</b>에서만 알림을 켤 수 있어요.<br>Safari 공유 버튼 → 홈 화면에 추가 → 홈 화면 아이콘으로 열기</p>`,
    unsupported: `<p class="set-note">이 브라우저는 알림을 지원하지 않아요.</p>`,
    denied: `<p class="set-note">알림이 차단되어 있어요. 기기 설정 → 알림 → Steward(또는 브라우저)에서 허용한 뒤 다시 열어 주세요.</p>`,
    off: `<p class="set-note">이 기기에서는 알림이 꺼져 있어요.</p><button class="btn primary" data-set="sub-on" ${settings.busy ? 'disabled' : ''}>이 기기에서 알림 켜기</button>`,
    on: `<p class="set-note">이 기기(${esc(deviceLabel())})에서 알림을 받고 있어요.</p>
         <div class="set-btns"><button class="btn" data-set="preview">알림 모양 확인</button><button class="btn" data-set="sub-off" ${settings.busy ? 'disabled' : ''}>이 기기 알림 끄기</button></div>`,
    unknown: '',
  }[dev];
  main.innerHTML = `
    <section class="set-sec">
      <label class="set-row"><span><b>전체 알림</b><small>끄면 모든 기기에서 체크인 알림을 보내지 않아요</small></span>
        <input type="checkbox" class="switch" id="setAll" role="switch" ${settings.prefs.enabled ? 'checked' : ''}></label>
    </section>
    <section class="set-sec"><h2 class="sec-h">이 기기</h2><div class="set-card">${deviceHTML}</div></section>
    ${others.length ? `<section class="set-sec"><h2 class="sec-h">다른 기기 <span class="n">${others.length}</span></h2><div class="list">${others.map(d => `
      <div class="set-dev"><span><b>${esc(d.device_label || '기기')}</b><small>${d.disabled_at ? '꺼짐 · 구독이 만료됐어요' : d.last_success_at ? `마지막 수신 ${md(seoulDate(new Date(d.last_success_at)))}` : `등록 ${md(seoulDate(new Date(d.created_at)))}`}</small></span>
        <button class="btn ghost danger" data-set="dev-del" data-id="${d.id}">삭제</button></div>`).join('')}</div></section>` : ''}
    <section class="set-sec"><h2 class="sec-h">알림 시간</h2><div class="list">${settings.slots.map(sl => `
      <details class="set-slot ${sl.enabled ? '' : 'off'}" data-id="${sl.id}" ${settings.openSlot === sl.id ? 'open' : ''}>
        <summary><span class="set-time">${sl.local_time}</span><span class="set-kind"><b>${KIND_LABEL[sl.kind]}</b><small>${daysText(sl.weekdays)}</small></span>
          <input type="checkbox" class="switch" role="switch" aria-label="${KIND_LABEL[sl.kind]} ${sl.local_time} 켜기" data-set="slot-on" ${sl.enabled ? 'checked' : ''}></summary>
        <div class="set-slot-body">
          <label class="lbl" for="t-${sl.id}">시간</label>
          <input type="time" class="input set-time-input" id="t-${sl.id}" step="300" max="23:35" value="${sl.local_time}" data-set="slot-time">
          <span class="lbl">요일</span>
          <div class="chips">${DAY_CHIPS.map(([n, l]) => `<button class="chip" data-set="slot-day" data-day="${n}" aria-pressed="${sl.weekdays.includes(n)}">${l}</button>`).join('')}</div>
        </div>
      </details>`).join('')}</div>
      <p class="foot-note">시간은 5분 단위, 23:35까지. 바꾸면 바로 저장돼요.</p></section>`;
}

// 설정 화면 입력 처리
// 펼친 시간 행은 저장 후 다시 그려도 펼친 채로
main.addEventListener('toggle', e => {
  if (ui.tab !== 'settings' || !e.target.matches?.('.set-slot')) return;
  if (e.target.open) settings.openSlot = e.target.dataset.id; else if (settings.openSlot === e.target.dataset.id) settings.openSlot = null;
}, true);
main.addEventListener('change', e => {
  if (ui.tab !== 'settings') return;
  if (e.target.id === 'setAll') return setPrefs(e.target.checked);
  const slotEl = e.target.closest('.set-slot'); if (!slotEl) return;
  const id = slotEl.dataset.id;
  if (e.target.dataset.set === 'slot-on') return updateSlot(id, { enabled: e.target.checked });
  if (e.target.dataset.set === 'slot-time') {
    const v = e.target.value; const [h, m] = v.split(':').map(Number);
    if (!v || m % 5 || v > '23:35') { toast('5분 단위, 23:35까지 고를 수 있어요'); return render(); }
    return updateSlot(id, { local_time: v }, '시간을 바꾸지 못했어요');
  }
});
main.addEventListener('click', async e => {
  if (ui.tab !== 'settings') return;
  if (e.target.closest('summary') && e.target.matches('input.switch')) { e.stopPropagation(); return; }   // 스위치는 펼치지 않음
  const b = e.target.closest('[data-set]'); if (!b || b.matches('input')) return;
  const k = b.dataset.set;
  if (k === 'slot-day') {
    const sl = settings.slots.find(x => x.id === b.closest('.set-slot').dataset.id); const day = Number(b.dataset.day);
    const next = sl.weekdays.includes(day) ? sl.weekdays.filter(x => x !== day) : [...sl.weekdays, day].sort();
    if (!next.length) return toast('요일은 하나 이상 골라야 해요');
    return updateSlot(sl.id, { weekdays: next });
  }
  if (k === 'sub-on' || k === 'sub-off') {
    settings.busy = true; render();
    try { if (k === 'sub-on') await subscribeThisDevice(); else await unsubscribeThisDevice(); toast(k === 'sub-on' ? '이 기기에서 알림을 받아요' : '이 기기 알림을 껐어요'); }
    catch (err) { console.error('[taskhub] push', err); toast(k === 'sub-on' ? '알림을 켜지 못했어요 · 잠시 후 다시 시도해 주세요' : '알림을 끄지 못했어요'); }
    settings.busy = false; settings.loaded = false; return loadSettings();
  }
  if (k === 'preview') {
    const reg = await navigator.serviceWorker.ready;
    return reg.showNotification('Steward', { body: '남은 업무 3개 · 오늘 안에 할 것만 남겨요', tag: 'steward-preview', icon: './icons/icon-192.png', badge: './icons/badge-96.png', data: { url: './#/today' } });
  }
  if (k === 'dev-del') {
    try { unwrap(await track(db.rpc('remove_push_subscription', { p_id: b.dataset.id }))); settings.devices = settings.devices.filter(d => d.id !== b.dataset.id); render(); toast('기기를 삭제했어요'); }
    catch (err) { saveError(err); }
  }
});

// ---------- events ----------
sheet.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); });
document.querySelector('.nav').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'addBtn') return openAdd();
  go(b.dataset.tab);
});
top.addEventListener('click', e => {
  const m = e.target.closest('[data-mode]'); if (m) return setMode({ todayMode: m.dataset.mode });
  const a = e.target.closest('[data-arch]'); if (a) return setMode({ archMode: a.dataset.arch });
  if (e.target.closest('[data-act="triage"]')) openTriage();
});

let suppressClick = false;
main.addEventListener('click', e => {
  if (suppressClick) return;
  const act = e.target.closest('[data-act]');
  if (act) {
    const k = act.dataset.act;
    if (k === 'triage') return openTriage();
    if (k === 'toggleLaterWeek') { ui.showLaterWeek = !ui.showLaterWeek; return render(); }
    if (k === 'signout') return signOut();
    if (k === 'settings') return navigate('/settings');
    if (k === 'cc-add') return openAdd();
    if (k === 'cc-close') return dismissMorning();
    if (k === 'install') return promptInstall();
    const row = act.closest('.row'); const id = row?.dataset.id; if (!id) return;
    if (k === 'done') return completeTask(id, row);
    if (k === 'undone') return uncompleteTask(id).then(() => toast('완료를 취소했어요'));
    if (k === 'received') { const t = byId(id); return change(id, statusFields(t, 'active'), '받음 · 오늘 할 일로 옮겼어요'); }
    if (k === 'refollow') return openRefollow(id);
  }
  const m = e.target.closest('[data-mode]'); if (m) return setMode({ todayMode: m.dataset.mode });
  const row = e.target.closest('.row'); if (row) openDetail(row.dataset.id);
});

// swipe: right = 완료, left = 미루기
(() => {
  let s = null;
  main.addEventListener('pointerdown', e => {
    const row = e.target.closest('.row'); if (!row || row.hasAttribute('data-noswipe') || e.target.closest('button')) return;
    s = { row, inner: row.querySelector('.row-inner'), x: e.clientX, y: e.clientY, dx: 0, on: false, pid: e.pointerId };
  });
  main.addEventListener('pointermove', e => {
    if (!s || e.pointerId !== s.pid) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (!s.on) { if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.3) { s.on = true; s.inner.classList.remove('snap'); try { s.row.setPointerCapture(e.pointerId); } catch (_) {} } else if (Math.abs(dy) > 10) { s = null; return; } else return; }
    s.dx = Math.max(-140, Math.min(140, dx));
    s.inner.style.transform = `translateX(${s.dx}px)`;
    s.row.classList.toggle('sw-right', s.dx > 0); s.row.classList.toggle('sw-left', s.dx < 0);
  });
  const end = () => {
    if (!s) return; const cur = s; s = null;
    if (!cur.on) return;
    suppressClick = true; setTimeout(() => suppressClick = false, 60);
    cur.inner.classList.add('snap'); cur.inner.style.transform = '';
    setTimeout(() => cur.row.classList.remove('sw-right', 'sw-left'), 180);
    if (cur.dx > 80) completeTask(cur.row.dataset.id, cur.row);
    else if (cur.dx < -80) openPostpone(cur.row.dataset.id);
  };
  main.addEventListener('pointerup', end); main.addEventListener('pointercancel', end);
})();

// ---------- auth ----------
// 이메일 + 비밀번호 (메일 발송 없음 → SMTP 설정 불필요, iPhone 홈 화면 앱에서도 동작)
function renderLogin(email = '', err = '') {
  document.body.classList.add('signed-out');
  top.innerHTML = '';
  main.innerHTML = `
    <form class="login" id="loginForm" autocomplete="on">
      <div class="brand">
        <img src="icons/mark-128.png" alt="" width="64" height="64">
        <h1>Steward</h1>
        <p class="tagline">A daily rhythm for faithful work.</p>
      </div>
      <p>등록된 계정으로 로그인하세요.</p>
      <label class="lbl" for="loginEmail" style="font-size:12px;font-weight:700;color:var(--muted)">이메일</label>
      <input class="input" id="loginEmail" name="email" type="email" inputmode="email" autocomplete="username" required value="${esc(email)}">
      <label class="lbl" for="loginPw" style="font-size:12px;font-weight:700;color:var(--muted)">비밀번호</label>
      <input class="input" id="loginPw" name="password" type="password" autocomplete="current-password" required>
      <div class="err" role="alert">${esc(err)}</div>
      <button class="btn primary" type="submit">로그인</button>
    </form>`;
  const f = main.querySelector('form');
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = f.querySelector('[type=submit]'); btn.disabled = true; btn.textContent = '로그인 중…';
    const em = f.querySelector('#loginEmail').value.trim();
    const { error } = await db.auth.signInWithPassword({ email: em, password: f.querySelector('#loginPw').value });
    if (error) {
      const msg = /invalid login credentials/i.test(error.message) ? '이메일 또는 비밀번호가 맞지 않아요.'
                : /fetch|network/i.test(error.message) ? '연결을 확인하고 다시 시도해 주세요.'
                : '로그인하지 못했어요. 잠시 후 다시 시도해 주세요.';
      renderLogin(em, msg);
    }
  });
  setTimeout(() => f.querySelector(email ? '#loginPw' : '#loginEmail')?.focus(), 30);
}
async function signOut() {
  flushAllText();
  await unsubscribeThisDevice().catch(() => {});   // 로그아웃하면 이 기기 알림도 끔 (구독 이전 정책: docs/notifications-impl.md 1-1)
  if (!CFG.testAccessToken) await db.auth.signOut();   // 로컬 테스트는 고정 토큰이라 로그아웃 호출 없음
  tasks = []; recentWho = [];
  renderLogin();
}
let started = false;
let loadFailed = false;
async function startApp(session) {
  userEmail = session?.user?.email || CFG.testEmail || '';
  if (started) return;
  started = true;
  document.body.classList.remove('signed-out');
  await firstLoad();
}
async function firstLoad() {
  if (navigator.onLine === false) {   // 이미 끊긴 게 확실하면 기다리지 않고 바로 안내
    loadFailed = true;
    main.innerHTML = `<div class="empty-big"><b>오프라인이에요</b>인터넷에 다시 연결되면 자동으로 불러올게요.</div>`;
    return;
  }
  main.innerHTML = `<div class="loading">불러오는 중…</div>`;
  try { await loadAll(); loadFailed = false; }
  catch (e) {
    console.error('[taskhub] load', e); loadFailed = true;
    main.innerHTML = navigator.onLine === false
      ? `<div class="empty-big"><b>오프라인이에요</b>인터넷에 다시 연결되면 자동으로 불러올게요.</div>`
      : `<div class="empty-big"><b>불러오지 못했어요</b>연결을 확인하고 다시 열어 주세요.</div>`;
    return;
  }
  currentDay = T();
  applyRoute();
  scheduleMidnight();
  syncThisDevice();
}
// 다시 연결되면: 처음 불러오기에 실패했으면 다시 시도, 아니면 최신 데이터로
window.addEventListener('online', () => { if (!started) return; if (loadFailed) firstLoad(); else refresh(); });

// ---------- PWA ----------
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; if (ui.tab === 'archive') render(); });
window.addEventListener('appinstalled', () => { installPrompt = null; if (ui.tab === 'archive') render(); });
// 보관 탭 아래: 아직 홈 화면 앱이 아니면 설치 방법 안내 (알림은 홈 화면 앱에서만 받을 수 있음)
function installHintHTML() {
  if (isStandalone()) return '';
  const how = isIOS()
    ? 'Safari 아래쪽 <b>공유</b> 버튼 → <b>홈 화면에 추가</b>'
    : installPrompt ? '' : '브라우저 메뉴 → <b>앱 설치</b> 또는 <b>홈 화면에 추가</b>';
  return `<div class="install-hint">
    <div><b>홈 화면에 추가하기</b><p>앱처럼 바로 열리고, 체크인 알림도 받을 수 있어요.${how ? `<br>${how}` : ''}</p></div>
    ${installPrompt ? '<button class="btn primary" data-act="install">앱 설치</button>' : ''}
  </div>`;
}
async function promptInstall() {
  if (!installPrompt) return;
  const p = installPrompt; installPrompt = null;
  p.prompt();
  try { await p.userChoice; } catch (_) {}
  render();
}
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(e => console.error('[taskhub] sw', e)); });
  // 알림을 눌렀는데 앱이 이미 열려 있으면, 서비스 워커가 주소만 보내옴 → 새로고침 없이 이동
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type !== 'steward:open') return;
    const hash = new URL(e.data.url, location.href).hash || '#/today';
    if (location.hash === hash) applyRoute(); else location.hash = hash;
  });
}

async function boot() {
  if (!CFG.supabaseUrl || !CFG.supabaseAnonKey) {
    main.innerHTML = `<div class="empty-big"><b>설정이 필요해요</b>config.js에 Supabase 주소와 공개 키를 넣어 주세요.</div>`; return;
  }
  if (CFG.testAccessToken) return startApp(null);
  db.auth.onAuthStateChange((event, session) => {
    if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) startApp(session);
    if (event === 'SIGNED_OUT' || (event === 'INITIAL_SESSION' && !session)) { started = false; renderLogin(); }
  });
}

// 테스트에서 상태 확인용 (읽기 전용)
window.__taskhub = { get tasks() { return tasks; }, get pending() { return pending; }, get day() { return currentDay; }, refresh };

boot();
})();
