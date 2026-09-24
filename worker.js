/* -----------------------------------------------------------------------------
   worker.js — Cloudflare Worker 進入點

   這個專案只有一條 API:/api/rich。其餘一律轉交給靜態資產(index.html)。

   為什麼需要它:
     帝國裡本來有六個虛構對手,但一個虛構的第一名沒辦法回答那個真正有意思的
     問題 ——「我這一局跑出來的身家,放到真實世界排第幾?」那個問題只有真資料
     回答得了,而且它是整個遊戲裡唯一可以查證的數字。

   ⚠ 沒有這個後端,遊戲照樣玩得起來 —— 前端抓不到就退回虛構對手,而且會在
     畫面上直說。所以你可以先純靜態部署,想要真榜單再接。

   安全性:這裡沒有任何 API key,也沒有任何使用者資料。
   ----------------------------------------------------------------------------- */

const UA = 'Mozilla/5.0 (compatible; empire-sim/1.0)';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=21600',        // 6 小時
};

const j = (obj, headers, status = 200) =>
  new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status, headers });

/* ---------------------------------------------------------------------------
   /api/rich —— 真實的富豪榜

   來源與但書(前端畫面上也會照樣寫一次):
     · Forbes 即時富豪榜的 JSON 端點。它是**非官方的**:Forbes 沒有公開 API
       文件,這條網址隨時可能改或關掉。所以失敗一律回錯誤,前端會退回虛構
       對手,而不是拿一份過期的假資料充數。
     · finalWorth 的單位是**百萬美元**,照原樣傳,換算留給前端做。
     · 快取六小時 —— 一份一天只變幾次的榜單,沒有理由每次都去打它。
   --------------------------------------------------------------------------- */
const RICH_URL = 'https://www.forbes.com/forbesapi/person/rtb/0/position/true.json'
  + '?fields=personName,finalWorth,countryOfCitizenship,source,industries,rank';

async function handleRich(url) {
  const n = Math.min(500, Math.max(10, +url.searchParams.get('n') || 200));
  try {
    const r = await fetch(RICH_URL, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!r.ok) return j({ error: `上游回應 ${r.status}` }, CORS, 502);
    const d = await r.json();
    const list = d?.personList?.personsLists;
    if (!Array.isArray(list)) return j({ error: '上游回傳的不是預期的格式(端點可能改了)' }, CORS, 502);
    const rows = list.slice(0, n).map(p => ({
      n: p.personName,
      w: Math.round(p.finalWorth || 0),                    // 百萬美元
      c: p.countryOfCitizenship || '',
      s: p.source || '',
      i: Array.isArray(p.industries) ? p.industries[0] : (p.industries || ''),
    })).filter(x => x.n && x.w > 0);
    if (!rows.length) return j({ error: '上游回了空清單' }, CORS, 502);
    return j({ at: Date.now(), src: 'forbes-rtb', unit: 'USD_M', n: rows.length, rows }, CORS);
  } catch (e) {
    return j({ error: String(e?.message || e) }, CORS, 504);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/'))
      return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/api/rich') return handleRich(url);
    // 其餘一律當成靜態檔案(index.html 等)
    return env.ASSETS.fetch(request);
  },
};
