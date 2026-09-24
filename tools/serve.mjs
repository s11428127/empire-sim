/* -----------------------------------------------------------------------------
   tools/serve.mjs — 本機開發伺服器

   為什麼不能直接用瀏覽器開 index.html:
     file:// 沒有後端,所以台股 / 海外報價 / K 線一定失敗,而且 Web Crypto
     在 file:// 底下也不給用 —— 跨裝置同步整個功能都測不了。

   這支跑起來之後開 http://localhost:8787 就跟正式部署一樣:
     · 靜態檔案照常送
     · /api/* 轉發到真正的上游(跟 worker.js 同一套邏輯,只是跑在 Node)
     · /api/sync 存在本機的 .orbit-dev-kv.json,不會動到你雲端那份

   用法:node tools/serve.mjs   或   npm run dev
   ----------------------------------------------------------------------------- */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 8787;
const KV_FILE = path.join(ROOT, '.orbit-dev-kv.json');

const UA = 'Mozilla/5.0 (compatible; orbit-dev/1.0)';
const readKV  = () => { try { return JSON.parse(fs.readFileSync(KV_FILE, 'utf8')); } catch { return {}; } };
const writeKV = (o) => fs.writeFileSync(KV_FILE, JSON.stringify(o, null, 1));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

/* 上游位址跟 worker.js 保持一致。這裡只做「轉一手」,不加任何 key。 */
const UPSTREAM = {
  twse: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  tpex: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
};

async function proxyQuotes(url) {
  const src = url.searchParams.get('src') || 'twse';
  if (src === 'crypto') {
    const ids = url.searchParams.get('ids') || '';
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price'
      + `?ids=${encodeURIComponent(ids)}&vs_currencies=usd&include_24hr_change=true`,
      { headers: { 'User-Agent': UA } });
    return [r.status, await r.text()];
  }
  if (src === 'yahoo') {
    const syms = (url.searchParams.get('symbols') || '').split(',').map(s => s.trim()).filter(Boolean);
    const out = {};
    await Promise.all(syms.slice(0, 30).map(async s => {
      try {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=5d&interval=1d`,
          { headers: { 'User-Agent': UA } });
        if (!r.ok) return;
        const res = (await r.json())?.chart?.result?.[0];
        const m = res?.meta;
        if (!m || !isFinite(m.regularMarketPrice)) return;
        const closes = (res?.indicators?.quote?.[0]?.close || []).filter(v => typeof v === 'number');
        out[s] = { px: m.regularMarketPrice,
                   prev: closes.length >= 2 ? closes[closes.length - 2] : (m.previousClose ?? null),
                   ccy: m.currency || null, mkt: m.fullExchangeName || null };
      } catch { /* 單一標的失敗不影響其他的 */ }
    }));
    return [200, JSON.stringify(out)];
  }
  const up = UPSTREAM[src];
  if (!up) return [400, JSON.stringify({ error: 'src 不支援' })];
  const r = await fetch(up, { headers: { 'User-Agent': UA } });
  return [r.status, await r.text()];
}

async function handleApi(req, res, url) {
  const send = (status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  try {
    if (url.pathname === '/api/sync') {
      const id = url.searchParams.get('id') || '';
      if (!/^[0-9a-f]{32}$/.test(id)) return send(400, JSON.stringify({ error: 'id 格式不正確' }));
      const kv = readKV();
      const key = 'pf:' + id;
      if (req.method === 'GET') {
        const v = kv[key];
        if (!v) return send(404, JSON.stringify({ error: '這個 id 還沒有任何資料' }));
        if (url.searchParams.get('rev') === 'prev') {
          return v.prev ? send(200, JSON.stringify(v.prev))
                        : send(404, JSON.stringify({ error: '沒有上一版' }));
        }
        return send(200, JSON.stringify({ blob: v.blob, at: v.at, prevAt: v.prev?.at ?? null }));
      }
      if (req.method === 'PUT') {
        let body = '';
        for await (const c of req) body += c;
        const old = kv[key];
        const rec = { blob: body, at: Date.now() };
        if (old?.blob && old.blob !== body) rec.prev = { blob: old.blob, at: old.at };
        else if (old?.prev) rec.prev = old.prev;
        kv[key] = rec; writeKV(kv);
        return send(200, JSON.stringify({ ok: true, at: rec.at }));
      }
      return send(405, JSON.stringify({ error: '只支援 GET / PUT' }));
    }
    if (url.pathname === '/api/quotes') {
      const [status, body] = await proxyQuotes(url);
      return send(status, body);
    }
    // 其餘的 API 直接打到已部署的 Worker,省得在這裡再實作一次
    const remote = process.env.ORBIT_UPSTREAM;
    if (remote) {
      const r = await fetch(remote.replace(/\/$/, '') + url.pathname + url.search,
                            { headers: { 'User-Agent': UA } });
      return send(r.status, await r.text());
    }
    return send(501, JSON.stringify({
      error: `本機伺服器沒有實作 ${url.pathname}。設 ORBIT_UPSTREAM=https://你的網址 就會轉過去。` }));
  } catch (e) {
    send(502, JSON.stringify({ error: String(e?.message || e) }));
  }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);

  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.resolve(ROOT, '.' + rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('nope'); }
  let buf = null;
  try { buf = fs.readFileSync(file); } catch { /* 沒這個檔 */ }
  if (!buf) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(rel)] || 'text/plain; charset=utf-8',
                       'cache-control': 'no-store' });
  res.end(buf);
}).listen(PORT, () => {
  console.log(`ORBIT 開發伺服器  http://localhost:${PORT}`);
  console.log(`  · 報價與同步都能用(同步存在本機 ${path.basename(KV_FILE)},不會動到雲端)`);
  console.log(`  · K 線 / 五檔 / 新聞要設 ORBIT_UPSTREAM=https://你的網址 才會轉發`);
});
