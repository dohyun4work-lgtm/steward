// 로컬 테스트 서버: 앱 정적 파일 + /rest/v1 → PostgREST 프록시 + 테스트용 config.js
const http = require('http'), fs = require('fs'), path = require('path');
const jwt = require('jsonwebtoken');
const ROOT = path.resolve(__dirname, '..');
const SECRET = 'test-secret-test-secret-test-secret-32';
const PORT = Number(process.env.PORT || 4400);
const users = { a: '11111111-1111-1111-1111-111111111111', b: '22222222-2222-2222-2222-222222222222' };
const token = sub => jwt.sign({ sub, role: 'authenticated', aud: 'authenticated', email: 'dh@example.com' }, SECRET, { expiresIn: '2h' });
const anon = jwt.sign({ role: 'anon' }, SECRET, { expiresIn: '2h' });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/functions/v1/')) {   // 로컬에서 띄운 Edge Function (Deno, 8000)
    const r = await fetch('http://127.0.0.1:8000' + url.pathname.replace(/^\/functions\/v1\/[^/]+/, '') + url.search, { method: req.method }).catch(() => null);
    if (!r) { res.writeHead(502); return res.end(); }
    const h = {}; r.headers.forEach((v, k) => { if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(k)) h[k] = v; });
    res.writeHead(r.status, h); return res.end(Buffer.from(await r.arrayBuffer()));
  }
  if (url.pathname.startsWith('/rest/v1/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
    const r = await fetch('http://127.0.0.1:3300' + url.pathname.slice(8) + url.search, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const out = Buffer.from(await r.arrayBuffer());
    const h = {}; r.headers.forEach((v, k) => { if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(k)) h[k] = v; });
    res.writeHead(r.status, h); return res.end(out);
  }
  if (url.pathname === '/config.js') {
    const who = url.searchParams.get('u') || 'a';
    res.writeHead(200, { 'content-type': types['.js'] });
    return res.end(`window.TASKHUB_CONFIG = { supabaseUrl: 'http://localhost:${PORT}', supabaseAnonKey: '${anon}', testAccessToken: '${token(users[who])}', testEmail: 'dh@example.com' };`);
  }
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log('test server on', PORT));
