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
const clientOpts = { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' } };
if (CFG.testAccessToken) clientOpts.accessToken = async () => CFG.testAccessToken;   // 로컬 테스트 전용
const db = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, clientOpts);

// ---------- state ----------
let tasks = [];
let recentWho = [];
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
  const [open, done, who] = await Promise.all([
    db.from('tasks').select('*').is('deleted_at', null).neq('status', 'done'),
    db.from('tasks').select('*').is('deleted_at', null).eq('status', 'done').gte('done_at', since),
    db.from('recent_waiting').select('name').order('last_used_at', { ascending: false }).limit(8),
  ]);
  tasks = [...unwrap(open), ...unwrap(done)].map(norm);
  recentWho = unwrap(who).map(r => r.name);
}
async function refresh() {
  try { await loadAll(); render(); } catch (e) { console.error('[taskhub] refresh', e); }
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
  textTimers.set(key, { id, field, timer: setTimeout(() => flushText(key), TEXT_SAVE_DELAY) });
}
function flushText(key) {
  const entry = textTimers.get(key); if (!entry) return;
  clearTimeout(entry.timer); textTimers.delete(key);
  const t = byId(entry.id); if (!t) return;
  let v = t[entry.field];
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
const ui = { tab: 'today', todayMode: 'today', archMode: 'later', showLaterWeek: false };
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
  const actions = opts.followup ? `<div class="row-actions"><button class="btn primary" data-act="received">받음</button><button class="btn" data-act="refollow">다시 미루기</button></div>` : '';
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
  let html = n ? `<button class="banner" data-act="triage"><span>인박스 ${n}개 정리하기</span><span aria-hidden="true">›</span></button>` : '';
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
  html += `<div class="foot-note"><span class="account">${esc(userEmail)}<span class="brandline">Steward · A daily rhythm for faithful work.</span></span><button class="btn" data-act="signout">로그아웃</button></div>`;
  main.innerHTML = html;
}

function render() {
  if (document.body.classList.contains('signed-out')) return;
  ({ today: renderToday, inbox: renderInbox, waiting: renderWaiting, archive: renderArchive })[ui.tab]();
  document.querySelectorAll('.nav [data-tab]').forEach(b => { if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  const n = inbox().length, badge = document.getElementById('inboxBadge');
  badge.textContent = n; badge.hidden = !n;
  showSave(true);
}
function go(tab) { ui.tab = tab; render(); window.scrollTo(0, 0); }

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
let sheetClose = null, lastFocus = null;
function openSheet(html, onClose) {
  lastFocus = document.activeElement;
  sheet.innerHTML = `<button class="grab" data-close aria-label="닫기"><span></span></button>` + html;
  sheet.onclick = null; sheet.hidden = false; scrim.hidden = false; sheetClose = onClose || null; sheet.scrollTop = 0;
}
function closeSheet() {
  if (sheet.hidden) return;
  flushAllText();
  sheet.hidden = true; scrim.hidden = true; sheet.innerHTML = '';
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
function openPostpone(id) {
  const t = byId(id); if (!t) return; const d = T();
  const opts = [['tomorrow', '내일', addDays(d, 1)], ['week', '이번 주', weekEnd(d)], ['nextweek', '다음 주', nextMonday(d)]];
  openSheet(`<h2>미루기</h2><div class="row-sub" style="margin-top:-6px">${esc(t.title)}</div>
    <div class="field"><div class="chips">
      ${opts.map(([k, l, v]) => `<button class="chip" data-pp="${v}" data-label="${l}">${l}<small>${mdw(v)}</small></button>`).join('')}
      <button class="chip" data-pp="later">나중에</button>
      <button class="chip" data-pp="waiting">대기로</button>
    </div></div>
    <div class="field"><label for="ppDate">날짜 선택</label><div class="date-inline"><input type="date" class="input" id="ppDate" min="${d}"><button class="btn" id="ppGo">적용</button></div></div>`);
  const setDo = (date, label) => {
    const f = t.status === 'active' ? { do_date: date } : { ...statusFields(t, 'active'), do_date: date };
    closeSheet(); change(id, f, label);
  };
  sheet.onclick = e => {
    const b = e.target.closest('[data-pp]');
    if (b) {
      const v = b.dataset.pp;
      if (v === 'waiting') return openWaiting(id);
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
function openWaiting(id, fromDetail) {
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
    fromDetail ? () => setTimeout(() => openDetail(id), 0) : null);
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
function openDetail(id) {
  const t = byId(id); if (!t) return;
  const d = T();
  const draw = () => {
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
      <div class="sheet-foot"><button class="btn danger" id="dDel">삭제</button><span class="saved"></span><button class="btn primary" data-close>닫기</button></div>`);
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
      if (b.dataset.st === 'waiting') { flushAllText(); return openWaiting(id, true); }
      if (b.dataset.st === 'done') { closeSheet(); return completeTask(id, null); }
      if (cur.status === 'done') { closeSheet(); return uncompleteTask(id); }
      set(statusFields(cur, b.dataset.st));
    });
    q('#dWaitEdit')?.addEventListener('click', () => { flushAllText(); openWaiting(id, true); });
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

// ---------- events ----------
sheet.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); });
document.querySelector('.nav').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'addBtn') return openAdd();
  go(b.dataset.tab);
});
top.addEventListener('click', e => {
  const m = e.target.closest('[data-mode]'); if (m) { ui.todayMode = m.dataset.mode; return render(); }
  const a = e.target.closest('[data-arch]'); if (a) { ui.archMode = a.dataset.arch; return render(); }
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
    const row = act.closest('.row'); const id = row?.dataset.id; if (!id) return;
    if (k === 'done') return completeTask(id, row);
    if (k === 'undone') return uncompleteTask(id).then(() => toast('완료를 취소했어요'));
    if (k === 'received') { const t = byId(id); return change(id, statusFields(t, 'active'), '받음 · 오늘 할 일로 옮겼어요'); }
    if (k === 'refollow') return openRefollow(id);
  }
  const m = e.target.closest('[data-mode]'); if (m) { ui.todayMode = m.dataset.mode; return render(); }
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
  await db.auth.signOut();
  tasks = []; recentWho = [];
  renderLogin();
}
let started = false;
async function startApp(session) {
  userEmail = session?.user?.email || CFG.testEmail || '';
  if (started) return;
  started = true;
  document.body.classList.remove('signed-out');
  main.innerHTML = `<div class="loading">불러오는 중…</div>`;
  try { await loadAll(); }
  catch (e) { console.error(e); main.innerHTML = `<div class="empty-big"><b>불러오지 못했어요</b>연결을 확인하고 다시 열어 주세요.</div>`; return; }
  render();
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
window.__taskhub = { get tasks() { return tasks; }, get pending() { return pending; }, refresh };

boot();
})();
