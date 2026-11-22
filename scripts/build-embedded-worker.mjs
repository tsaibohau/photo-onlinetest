// 把 dist/ 內所有檔案內嵌成單一 Worker 腳本（.worker-embedded/index.js）。
// 用於無法使用 Workers Static Assets 上傳的情況（例如透過 API Token 從 CI/雲端直接部署）。
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const DIST = 'dist';
const OUT = '.worker-embedded';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.olt': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm',
};
const TEXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.olt', '.txt']);

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = {};
for (const f of walk(DIST)) {
  const rel = '/' + relative(DIST, f).split('\\').join('/');
  if (rel === '/_headers') continue;
  const ext = extname(f);
  const buf = readFileSync(f);
  files[rel] = TEXT.has(ext)
    ? { t: TYPES[ext] ?? 'text/plain; charset=utf-8', s: buf.toString('utf8') }
    : { t: TYPES[ext] ?? 'application/octet-stream', b: buf.toString('base64') };
}

const src = `const FILES = ${JSON.stringify(files)};
const cache = new Map();
function body(f) {
  if (f.s !== undefined) return f.s;
  let v = cache.get(f);
  if (!v) { const bin = atob(f.b); v = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) v[i] = bin.charCodeAt(i); cache.set(f, v); }
  return v;
}
export default {
  async fetch(req) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    let f = FILES[path];
    if (!f && !/\\.[a-z0-9]+$/i.test(path)) f = FILES['/index.html'];
    if (!f) return new Response('Not found', { status: 404 });
    const h = new Headers({ 'content-type': f.t, 'x-content-type-options': 'nosniff' });
    h.set('cache-control', path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    return new Response(req.method === 'HEAD' ? null : body(f), { headers: h });
  },
};
`;
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'index.js'), src);
console.log(`embedded ${Object.keys(files).length} files, ${(src.length / 1024).toFixed(0)} KB`);
