/* Steward — service worker
 * 1) 앱 화면(셸) 캐시: 온라인이면 항상 최신 파일(네트워크 우선), 끊겼을 때만 캐시로 열림
 * 2) 푸시 수신 → 알림 표시 (5단계 Edge Function이 보내는 내용: { title, body, url, tag })
 * 3) 알림 누르기 → 이미 열린 앱이 있으면 그 창에서 해당 주소로, 없으면 새로 열기
 * Supabase(다른 도메인) 요청과 업무 데이터는 캐시하지 않음.
 */
const VERSION = '2026-10-08.2';
const CACHE = 'steward-shell-' + VERSION;
const SHELL = [
  './', './index.html', './app.js', './styles.css', './config.js', './vendor/supabase.js', './manifest.webmanifest',
  './icons/favicon-32.png', './icons/favicon-64.png', './icons/apple-touch-icon.png', './icons/icon-192.png',
  './icons/icon-512.png', './icons/mark-128.png', './icons/badge-96.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('steward-shell-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // Supabase·글꼴 등은 브라우저가 직접 처리
  if (/\/(rest|auth|functions|storage|realtime)\/v1\//.test(url.pathname)) return;   // 데이터 요청은 절대 가로채지 않음
  event.respondWith((async () => {
    try {
      // 서버에 바뀌었는지 확인 후 받음. 페이지 이동 요청은 옵션을 붙여 다시 만들 수 없어 주소로 요청
      const res = await fetch(req.mode === 'navigate' ? req.url : new Request(req, { cache: 'no-cache' }),
                              req.mode === 'navigate' ? { cache: 'no-cache', credentials: 'same-origin' } : undefined);
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    } catch (err) {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      if (req.mode === 'navigate') return caches.match('./index.html');
      throw err;
    }
  })());
});

// ---------- 푸시 ----------
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'Steward';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || 'steward',              // 같은 tag는 하나로 덮어씀 (중복 방지 5번째 겹)
    renotify: false,                         // 덮어쓸 때 다시 울리지 않음
    icon: './icons/icon-192.png',
    badge: './icons/badge-96.png',
    lang: 'ko',
    data: { url: data.url || './#/today' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './#/today', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const scope = self.registration.scope;
    const win = wins.find(w => w.url.startsWith(scope));
    if (win) {
      // 열린 앱은 새로고침 없이 주소(해시)만 바꿈 → 작성 중인 내용이 사라지지 않음
      win.postMessage({ type: 'steward:open', url: target });
      return win.focus();
    }
    return self.clients.openWindow(target);
  })());
});
