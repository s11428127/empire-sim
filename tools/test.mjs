/* -----------------------------------------------------------------------------
   tools/test.mjs — ORBIT 的自動測試

   為什麼需要這個:
     這個專案是一個 11,000 行的單檔前端,沒有編譯步驟、沒有模組系統,
     所以一般的單元測試框架套不上去。但「算錢的程式沒有測試」是不能接受的 ——
     平均成本算錯、FIFO 配對錯、匯率套錯,畫面上都不會報錯,只會安靜地
     給你一個錯的數字。

   做法:
     用無頭 Chromium 把 index.html 真的開起來,然後在**頁面裡面**呼叫那些
     全域函式(parsePaste、applyTradeToPosition、loadPF…)來對答案。
     等於把整個瀏覽器當成測試執行環境 —— 不用改任何一行產品程式碼,
     測到的也是使用者真正會跑到的那份邏輯。

   用法:
     node tools/test.mjs              跑全部
     node tools/test.mjs sync         只跑名字含 "sync" 的測試
     node tools/test.mjs --headed     開有頭瀏覽器看它跑(除錯用)

   需要:
     Node 18+ 與 playwright(npm i -D playwright,或系統已全域安裝)
   ----------------------------------------------------------------------------- */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 8931;
const FILTER = process.argv.slice(2).find(a => !a.startsWith('-')) || '';
const HEADED = process.argv.includes('--headed');

/* ---------- playwright 的位置 ----------
   本機 npm i、全域安裝、CI 的路徑都不一樣,依序找,找不到就講清楚怎麼裝。 */
function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [
    'playwright',
    '/opt/node22/lib/node_modules/playwright',
    '/usr/lib/node_modules/playwright',
    '/usr/local/lib/node_modules/playwright',
  ];
  for (const c of candidates) {
    try { return require(c); } catch { /* 試下一個 */ }
  }
  console.error('找不到 playwright。請先安裝:\n  npm i -D playwright\n  npx playwright install chromium');
  process.exit(2);
}

/* ---------- 假的後端 ----------
   測試不能依賴真的證交所 / Yahoo / CoinGecko:它們會壞、會限流、會改格式,
   而且回傳的數字每天不一樣 —— 測試就不可能有固定答案。
   這裡回的是固定的假資料,所以每次跑結果都一樣。 */
/* 這個遊戲只會打一條 API:/api/rich(真實富豪榜)。
   另外 probeProxy() 會先 ping /api/quotes 找後端在不在 —— 它只看得到
   狀態碼,回什麼內容都無所謂。

   ⚠ 從 ORBIT 搬過來時這裡原本還有 sync / tw / twlist / kline / news 的罐頭
     資料(含幾檔台股的假報價)。這個專案一條都不會打,留著只會讓人以為
     這個遊戲跟股票資料有關係 —— 整組拿掉了。 */
function apiResponse(url) {
  const p = url.pathname;

  // probeProxy 的探針:有回應就算後端在
  if (p === '/api/quotes') return [200, { ok: true }];

  /* 真實富豪榜:測試環境給一份**固定的假榜單**。
     不是為了測 Forbes,是為了測「把你的模擬淨值插進一份真榜單裡排名」
     這段程式碼 —— 那段有換匯、有排序、有找到自己的位置,每一步都會錯。 */
  if (p === '/api/rich') return [200, { at: 1767225600000, src: 'test', unit: 'USD_M', n: 4,
    rows: [ { n:'A. Rich', w: 200000, c:'United States', s:'Tech', i:'Technology' },
            { n:'B. Wealthy', w: 90000, c:'France', s:'Luxury', i:'Fashion' },
            { n:'C. Loaded', w: 12000, c:'Taiwan', s:'Semiconductors', i:'Manufacturing' },
            { n:'D. Comfortable', w: 1500, c:'Japan', s:'Retail', i:'Retail' } ] }];

  return [502, { error: '測試環境沒有這個 API:' + p }];
}

function startServer() {
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const [status, payload] = apiResponse(url, req.method, body);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    }
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    // 只給 repo 內的檔案,擋掉 ../ 這種路徑
    const file = path.resolve(ROOT, '.' + rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('nope'); }
    let buf = null;
    try { buf = fs.readFileSync(file); } catch { /* 沒這個檔 */ }
    if (!buf) { res.writeHead(404); return res.end('not found'); }
    const type = rel.endsWith('.html') ? 'text/html; charset=utf-8'
               : rel.endsWith('.js') || rel.endsWith('.mjs') ? 'text/javascript; charset=utf-8'
               : rel.endsWith('.json') ? 'application/json; charset=utf-8'
               : rel.endsWith('.png') ? 'image/png'
               : rel.endsWith('.svg') ? 'image/svg+xml'
               : 'text/plain; charset=utf-8';
    res.writeHead(200, { 'content-type': type });
    res.end(buf);
  });
  return new Promise(r => srv.listen(PORT, () => r(srv)));
}

/* globe.gl 是從 unpkg 抓的,測試環境不連外網。
   換成一個「什麼方法都回自己」的替身,讓鏈式呼叫不會炸。 */
const GLOBE_STUB = `
  window.Globe = function(){
    const mk = () => new Proxy(function(){}, {
      get: (t,p) => p === 'then' ? undefined : (t[p] !== undefined ? t[p] : mk()),
      set: () => true,
      apply: () => mk(),
    });
    return mk();
  };`;

/* 國界資料的替身:只有台灣一塊,夠讓 globe.polygonsData() 走完正常那條路。 */
const FAKE_GEO = JSON.stringify({ type:'FeatureCollection', features:[
  { type:'Feature', properties:{ ADMIN:'Taiwan', NAME:'Taiwan', ISO_A2:'TW' },
    geometry:{ type:'Polygon', coordinates:[[[120,22],[122,22],[122,25],[120,25],[120,22]]] } }]});

/* ---------- 測試框架(夠用就好,不引入 jest / vitest) ---------- */
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
let assertions = 0;

function eq(actual, expected, what) {
  assertions++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}\n      預期: ${e}\n      實際: ${a}`);
}
function near(actual, expected, tol, what) {
  assertions++;
  if (!(Math.abs(actual - expected) <= tol))
    throw new Error(`${what}\n      預期: ${expected} (±${tol})\n      實際: ${actual}`);
}
function ok(cond, what) {
  assertions++;
  if (!cond) throw new Error(what);
}

/* ---------- 每個測試拿到的「新分頁」 ---------- */
async function freshPage(browser, { width = 1280, height = 900, seed = null, hash = '#/',
                                    killCdn = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height }, isMobile: width < 600, hasTouch: width < 600,
  });
  // killCdn:模擬「CDN 連不到」——手機訊號差、公司網路擋、或 unpkg 自己掛掉
  /* unpkg 上有兩種東西:globe.gl 本身,以及國界的 geojson。
     以前兩個都回同一份 JS 替身 —— 於是國界永遠解析失敗,測試環境的地球
     其實一直是「掛掉」的狀態,連帶讓依賴左欄的東西(搜尋框)測不到。
     現在照它要什麼給什麼,預設就是「CDN 正常」;要模擬掛掉請用 killCdn。 */
  await ctx.route('**/unpkg.com/**', r => {
    if (killCdn) return r.abort();
    return r.request().url().includes('geojson')
      ? r.fulfill({ contentType: 'application/json', body: FAKE_GEO })
      : r.fulfill({ contentType: 'application/javascript', body: GLOBE_STUB });
  });
  await ctx.route('**/cdn.jsdelivr.net/**', r => r.abort());
  /* seed 這個參數在 ORBIT 是「先塞一份持倉存檔」。這個專案沒有那種東西,
     帝國自己的存檔是 orbit.tycoon.v1,而且每條測試都自己呼叫 tyStart()
     決定要玩哪一局 —— 所以這裡什麼都不用塞,參數留著只是為了讓那二十條
     測試一個字都不用改。 */
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  await page.goto(`http://localhost:${PORT}/${hash}`, { waitUntil: 'load' });
  /* ⚠ 等的東西要是**這個專案真的有的**。
     這份 harness 從 ORBIT 搬過來時原本等 window.loadPF —— 那是資產 App 的
     存檔函式,這裡沒有,於是二十條測試全部卡在 waitForFunction 逾時,
     而錯誤訊息完全看不出真正的原因。 */
  await page.waitForFunction(() => typeof window.tyStart === 'function', { timeout: 15000 });
  await page.waitForTimeout(400);
  // 載入動畫會蓋住整頁,測試裡直接關掉才點得到東西
  await page.evaluate(() => { const l = document.getElementById('load'); if (l) l.style.display = 'none'; });
  /* 關掉所有過場動畫。
     不是為了跑快,是為了**不會忽好忽壞**:面板有 .3s 的 transition,
     剛打開的瞬間去量背景色會量到一個補間的中間值(alpha 甚至是 0.792),
     然後得出「深色模式的面板是淺色的」這種看起來像 bug 的結論。
     機器忙的時候等待時間又不夠,同一條測試就會時好時壞。
     動畫關掉之後,元素永遠是在它的最終狀態上。 */
  await page.addStyleTag({ content:
    '*,*::before,*::after{transition:none!important;animation:none!important}' });
  page.__errors = errors;
  page.__ctx = ctx;
  return page;
}

/* ⚠ 這裡原本有一份 SEED 持倉 fixture(兩檔台股)。
   那是資產 App 的東西 —— 這個專案沒有持倉,freshPage 也不再塞存檔,
   所以整份拿掉了。帝國那二十條測試都是自己呼叫 tyStart() 決定要玩哪一局。
   (freshPage 的 seed 參數留著沒有作用,只是為了讓那二十條一個字都不用改。) */
const SEED = null;

/* =========================================================================
   測試
   ========================================================================= */


/* ═══ 從 ORBIT 帶過來的 20 條帝國測試(內容一字未改) ═══ */

test('帝國:跑滿四十季不會生出 NaN,而且一定有結局', async (browser) => {
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('heir', 12345);
    const bad = [];
    for (let t = 1; t <= 40 && !TY.done; t++) {
      TY_SIZE = .25;
      tyBuy('tech'); tyBuy('estate'); tyBorrow();
      if (t === 3) tyFound('dev');
      if (t === 9) tyFound('media');
      if (t > 12) for (const b of TY.biz) tyIPO(b.id);
      tyNext();
      const nums = [tyNW(), TY.cash, TY.debt, TY.fame, TY.infl, TY.heat, TY.credit,
                    tyBorrowMax(), ...Object.values(TY.px), ...TY.biz.map(b => tyBizVal(b)),
                    ...TY.rivals.map(x => x.nw)];
      if (nums.some(n => !Number.isFinite(n))) bad.push(t);
    }
    return { bad, t: TY.t, qn: TY_QN, done: TY.done, nw: tyNW(),
             bio: tyBio().length, rank: tyRank() };
  });
  eq(r.bad, [], `第 ${r.bad.join(', ')} 季算出 NaN / Infinity`);
  // t 是索引:第 40 季是 t=39。寫錯的話畫面上會出現「第 41 / 40 季」
  eq(r.t, r.qn - 1, `四十季跑完之後 TY.t 應該是 ${r.qn - 1}`);
  ok(r.done, '跑滿四十季之後一定要有結局,不能還停在遊戲中');
  ok(r.bio >= 3, `結算的傳記至少要有三句話,實際只有 ${r.bio}`);
  ok(r.rank >= 1 && r.rank <= 7, `富豪榜名次要在 1~7 之間,實際是 ${r.rank}`);
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國:只准寫自己的那一格存檔', async (browser) => {
  /* 這一條在 ORBIT 裡叫「模擬器不可以碰到真實的持倉與交易紀錄」——
     那是這個遊戲當初唯一「絕對不能出錯」的地方:模擬器裡有三十億、有破產、
     有強制平倉,這些字眼跟真實資產共用一份全域狀態的話,後果是使用者打開
     持倉頁看到一個不是他的數字,而且他不會知道那是遊戲造成的。

     獨立出來之後,這個 repo 裡根本沒有真實資產可以被弄髒 —— 那條風險是
     結構上消失的,不是被測出來的。但規矩本身要留著,因為它才是這個遊戲
     可以被放心塞進別人網站的原因:**它只准碰自己的那一格。**

     所以改成測同一件事的另一面:玩完一整局之後,localStorage 裡除了
     TY_KEY 和佈景設定,不可以多出任何一個 key。 */
  const page = await freshPage(browser, { hash: '#/tycoon' });

  const before = await page.evaluate(() => Object.keys(localStorage).sort());
  await page.evaluate(() => {
    tyStart('raider', 777);
    for (let t = 1; t <= 40 && !TY.done; t++) {
      TY_SIZE = 1; tyBorrow(); tyBuy('crypto'); tyShort('tech');
      if (t === 2) { tyFound('shell', 'cay'); tySetHoldco('cay'); }
      tyNext();
    }
  });
  const after = await page.evaluate(() => ({
    keys: Object.keys(localStorage).sort(),
    own: !!localStorage.getItem('orbit.tycoon.v1'),
    done: !!TY.done,
  }));

  ok(after.own, '這一局要存在 orbit.tycoon.v1 裡');
  ok(after.done, '四十季跑完應該要有結局(不然上面那一局根本沒在跑)');

  /* 允許出現的只有這兩個:遊戲自己的存檔,以及佈景偏好。
     多出任何一個 key,就代表有程式碼在往不屬於它的地方寫東西。 */
  const allowed = new Set(['orbit.tycoon.v1', 'orbit.theme']);
  const extra = after.keys.filter(k => !allowed.has(k) && !before.includes(k));
  eq(extra, [], '玩一局之後多出了不該有的 localStorage key:' + extra.join('、'));
  await page.__ctx.close();
});

test('帝國:破產與起訴這兩個結局真的到得了', async (browser) => {
  /* 一個永遠觸發不了的結局是死程式碼,而且很難發現 —— 畫面上什麼都不會壞。
     這兩條路都實際踩過:破產判定原本被寫在「負債超過抵押上限」那個 if 裡面,
     所以靠放空把淨值做到 -20 億的人會顯示「十年到期」;起訴則是關注度的
     衰減率設得太高,實測十六局一次都沒到過。 */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    const play = (scn, fn, n) => {
      const ends = {};
      for (let s = 0; s < n; s++) {
        /* ⚠ 種子要傳給 tyStart,不可以先 tyStart() 再改 TY.rng ——
           對手是在 tyStart 裡面用亂數發牌的,牌發完才換種子,那一局其實是
           **時鐘**決定的,同一條測試就會忽好忽壞。 */
        tyStart(scn, (s * 31337) | 0);
        for (let t = 1; t <= 40 && !TY.done; t++) { fn(t); tyNext(); }
        ends[TY.done] = (ends[TY.done] || 0) + 1;
      }
      return ends;
    };
    // 滿槓桿押加密貨幣 → 應該有人會破產
    const degen = play('self', () => { TY_SIZE = 1; tyBorrow(); tyBuy('crypto'); }, 16);
    // 境外架構 + 借殼、但完全沒有政商關係 → 應該有人被起訴
    const dirty = play('heir', t => {
      if (t === 1) { tyFound('shell', 'cay'); tyFound('shell', 'vgb'); tySetHoldco('cay'); }
      if (t === 4) for (const b of TY.biz) if (!TY_BIZ[b.k].shell && !b.pub) tyReverse(b.id);
      TY_SIZE = .3; tyBuy('tech');
    }, 16);
    // 同樣的架構,但每季都在經營人脈 → 不該被起訴
    const shielded = play('heir', t => {
      if (t === 1) { tyFound('shell', 'cay'); tySetHoldco('cay'); }
      tyPlayLobby(); if (TY.heat > 70) tyPlayCharity();
      TY_SIZE = .3; tyBuy('tech');
    }, 16);
    // 什麼手法都不用的人,關注度必須是 0
    tyStart('float', 5);
    for (let t = 1; t <= 40 && !TY.done; t++) { TY_SIZE = .3; tyBuy('bond'); tyNext(); }
    const cleanHeat = TY.heat;
    tyClear();
    return { degen, dirty, shielded, cleanHeat };
  });
  ok(r.degen.bankrupt > 0, `滿槓桿押加密貨幣十六局都沒有人破產:${JSON.stringify(r.degen)}`);
  ok(r.dirty.indicted > 0, `境外架構 + 借殼 + 零人脈十六局都沒有人被起訴:${JSON.stringify(r.dirty)}`);
  ok(!r.shielded.indicted, `有人脈當靠山還是被起訴了:${JSON.stringify(r.shielded)}`);
  /* ⚠ 這裡不可以寫死 0。對手有機率去檢舉你(tyRivalTurn 的「對你出手」),
     被檢舉一次關注度就 +7,之後每季慢慢退。那是設計好的行為,不是 bug ——
     所以守的是「不用任何手法的人,關注度不會累積到危險區」,而不是「必須是 0」。
     (起訴的門檻是 88,分案調查是 72。) */
  ok(r.cleanHeat < 20,
     `什麼手法都不用的人,監理關注度竟然累積到 ${r.cleanHeat} —— 乾淨玩家不該被盯上`);
  await page.__ctx.close();
});

test('帝國:每一顆按鈕按下去都要有回應,而且畫面自己會更新', async (browser) => {
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  // 開局前應該是六張劇本卡
  eq(await page.$$eval('.tg-scn', els => els.length), 6, '開局畫面應該有六個劇本可以選');
  await page.click('.tg-scn[data-k="heir"]');
  await page.waitForFunction(() => typeof TY === 'object' && TY && TY.scn === 'heir',
                             { timeout: 5000 });
  ok(await page.$('.tg-res'), '選了劇本之後應該直接進到指揮台(資源列要出現)');

  // 五個子分頁都要畫得出東西
  /* 每一張面板都要開得出東西。指揮台的面板分兩組:底部功能列與右側的功能鈕。 */
  for (const [k, nm] of [['asset','資產'],['biz','事業'],['play','手法'],
                         ['rank','富豪榜'],['more','更多'],['log','大事記'],['learn','怎麼玩']]) {
    await page.click(`[data-ty="modal:${k}"]`);
    await page.waitForTimeout(160);
    const len = await page.$eval('.tg-mb', el => el.innerHTML.length);
    ok(len > 200, `「${nm}」這張面板是空的(只有 ${len} 字元)`);
    // 紅色的 X 一定要關得掉,不然使用者會被困在面板裡
    await page.click('.tg-x');
    await page.waitForTimeout(120);
    eq(await page.$$eval('.tg-modal', e => e.length), 0, `「${nm}」按了 ✕ 沒有關掉`);
  }

  // 買一次要真的有部位、有回覆訊息
  await page.click('[data-ty="modal:asset"]');
  await page.waitForTimeout(150);
  await page.click('[data-ty="buy"][data-k="tech"]');
  await page.waitForTimeout(150);
  const bought = await page.evaluate(() => ({ q: tyQty('tech'), msg: TY_MSG }));
  ok(bought.q > 0, '按了「買進」之後應該真的有部位');
  ok(/買進/.test(bought.msg), `動作要回一句話說明發生了什麼,實際:「${bought.msg}」`);

  // 下一季要真的推進,而且存檔要跟著寫
  const t0 = await page.evaluate(() => TY.t);
  await page.click('[data-ty="next"]');
  await page.waitForTimeout(200);
  const t1 = await page.evaluate(() => ({
    t: TY.t, saved: JSON.parse(localStorage.getItem('orbit.tycoon.v1') || '{}').t }));
  eq(t1.t, t0 + 1, '按了「下一季」季數要 +1');
  eq(t1.saved, t1.t, '每一季都要寫進存檔,重新整理才接得回去');

  // 重新整理之後接得回同一局
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(600);
  const back = await page.evaluate(() => ({ t: TY && TY.t, scn: TY && TY.scn }));
  eq(back, { t: t1.t, scn: 'heir' }, '重新整理之後應該接回同一局,不是回到選劇本');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國:每一顆按鈕都要寫出它的條件,而且畫面說得能按就一定按得動', async (browser) => {
  /* 使用者:「我點上市的時候,如果名氣不夠可以顯示出來,在我這個頁面要看得到」
             「加碼、上市等等的所有功能都要幫我寫所需要的條件」

     這一條盯的是**條件只有一份**這件事。原本每一支動作函式各自寫一次 if,
     畫面上又什麼都不寫,所以規則只能靠試錯發現;而只要有人改了其中一邊,
     就會出現「按鈕看起來可以按,按下去說你不行」——
     或更糟的反過來:按鈕是灰的,但其實做得到。

     所以測兩個方向:
       ① 畫面說可以 → 引擎一定要讓它過(tyBlock 回 null)
       ② 畫面說不行 → 引擎一定要擋(tyBlock 回一句話),而且那句話要說得出
          缺什麼、缺多少。 */
  const page = await freshPage(browser, { width: 390, height: 844, seed: SEED, hash: '#/tycoon' });
  await page.click('.tg-scn[data-k="heir"]');
  /* ⚠ 等「劇本真的開起來了」,不是等一個固定的毫秒數。
     跑整套測試的時候機器很忙,250 毫秒有時候不夠 —— 點擊還沒生效就開始
     跑三十季,於是 tyBuy 全部失敗、抽到的亂數整串偏掉,測試就會忽好忽壞。
     (實際發生過:這一條在單獨跑的時候五次全過,整套跑就偶爾紅一次。) */
  await page.waitForFunction(() => typeof TY === 'object' && TY && TY.scn === 'heir',
                             { timeout: 5000 });

  // 繼承者一開局:名氣 22、有一家 20 億的建設開發 → IPO 要被擋在「名氣」這一關
  const ipo = await page.evaluate(() => {
    TY_MODAL = 'biz'; renderPage();
    const btn = document.querySelector('[data-ty="ipo"]');
    const card = btn.closest('.c-a');
    return {
      fame: TY.fame,
      disabled: btn.disabled,
      chips: [...card.querySelectorAll('.ty-need .n')].map(n => ({
        bad: n.classList.contains('no'), txt: n.textContent.replace(/\s+/g, ' ').trim() })),
      msg: tyIPO(TY.biz[0].id),
    };
  });
  ok(ipo.fame < 35, `這一局的名氣應該不夠 35,實際 ${ipo.fame}`);
  ok(ipo.disabled, '名氣不夠的時候「送上市 IPO」必須是按不下去的');
  const badChip = ipo.chips.find(c => c.bad);
  ok(badChip && /名氣/.test(badChip.txt) && /22/.test(badChip.txt) && /35/.test(badChip.txt),
     `畫面上要直接寫著缺的是名氣、現在幾點、要幾點,實際看到:${JSON.stringify(ipo.chips)}`);
  ok(/名氣/.test(ipo.msg) && /35/.test(ipo.msg),
     `被擋下來的訊息要說出缺什麼缺多少,實際:「${ipo.msg}」`);

  // 名氣補上去之後,同一顆按鈕要真的變成可以按、而且按得動
  const after = await page.evaluate(() => {
    TY.fame = 60; renderPage();
    const btn = document.querySelector('[data-ty="ipo"]');
    return { disabled: btn.disabled, msg: tyIPO(TY.biz[0].id), pub: TY.biz[0].pub };
  });
  eq(after.disabled, false, '名氣夠了之後「送上市 IPO」要變成按得下去');
  ok(after.pub, `名氣夠了還是掛不上去:「${after.msg}」`);

  /* ①②:兩張面板上的每一顆動作按鈕,畫面狀態與引擎守門必須一致 */
  for (const tab of ['biz', 'play']) {
    const bad = await page.evaluate(t => {
      TY_MODAL = t; renderPage();
      const out = [];
      for (const btn of document.querySelectorAll('.tg-mb [data-ty]')) {
        const act = btn.dataset.ty;
        // 只看真的會改變遊戲狀態的動作,不看換頁 / 開面板 / 選金額
        if (!TY_ACT[act]) continue;
        let arg;
        if (btn.dataset.id) arg = TY.biz.find(x => x.id === +btn.dataset.id);
        else if (act === 'found') arg = { k: btn.dataset.k, site: btn.dataset.site };
        else if (btn.dataset.site) arg = btn.dataset.site;
        else if (btn.dataset.reg) arg = btn.dataset.reg;
        const blocked = tyBlock(act, arg);
        if (!btn.disabled && blocked)
          out.push(`${t}/${act}:按鈕可以按,但引擎說「${blocked}」`);
        if (btn.disabled && !blocked && !btn.textContent.includes('已'))
          out.push(`${t}/${act}:按鈕是灰的,但引擎其實讓它過`);
      }
      return out;
    }, tab);
    ok(bad.length === 0, `按鈕與引擎對不上:\n      ${bad.join('\n      ')}`);
  }

  /* 金額真的會被吃進去:借 25% 跟借 75% 借到的錢必須不一樣 */
  const amt = await page.evaluate(() => {
    TY.debt = 0; TY.cash = 10e8;
    TY_PAMT.borrow = tyBorrowMax() * .25; tyBorrow();
    const a = TY.debt;
    TY.debt = 0; TY.cash = 10e8;
    TY_PAMT.borrow = tyBorrowMax() * .75; tyBorrow();
    return { quarter: a, threeQuarters: TY.debt };
  });
  ok(amt.threeQuarters > amt.quarter * 2.4,
     `金額選擇器沒有被吃進去:25% 借到 ${amt.quarter}、75% 借到 ${amt.threeQuarters}`);

  /* 用錢買點數的三個手法:效果要跟著金額走,但**不可以線性** ——
     線性的話身家一大就能一季買滿,後面四十季沒有任何取捨。 */
  const pts = await page.evaluate(() => {
    const base = TY_MONEY.media.def();
    const one = tyBuyPts(base, base, 7, 20);
    const ten = tyBuyPts(base * 10, base, 7, 20);
    return { one, ten, cap: tyBuyPts(base * 1e6, base, 7, 20) };
  });
  ok(pts.ten > pts.one * 1.5, `花十倍的錢應該買到明顯更多:${pts.one} → ${pts.ten}`);
  ok(pts.ten < pts.one * 10, `效果不可以跟金額成正比:${pts.one} → ${pts.ten}`);
  ok(pts.cap <= 20 + 1e-6, `單次效果一定要有上限,實際 ${pts.cap}`);

  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國:每個城市真的不一樣,而且據點面板上就看得到差在哪', async (browser) => {
  /* 使用者:「地圖上可以顯示原本這個城市有的東西,根據他們真實的特色,
             然後那些資產、事業在每個城市都不一樣,都各有優缺點。」

     這一條盯三件事:
       ① 同一家公司開在不同城市,成本 / 現金流 / 估值倍數真的不一樣
       ② 每個城市**同時**有優點與缺點(不是「有些城市比較好」)
       ③ 據點面板上每一顆按鈕都寫著它的加成與它的條件 */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  await page.click('.tg-scn[data-k="heir"]');
  /* ⚠ 等「劇本真的開起來了」,不是等一個固定的毫秒數。
     跑整套測試的時候機器很忙,250 毫秒有時候不夠 —— 點擊還沒生效就開始
     跑三十季,於是 tyBuy 全部失敗、抽到的亂數整串偏掉,測試就會忽好忽壞。
     (實際發生過:這一條在單獨跑的時候五次全過,整套跑就偶爾紅一次。) */
  await page.waitForFunction(() => typeof TY === 'object' && TY && TY.scn === 'heir',
                             { timeout: 5000 });

  const r = await page.evaluate(() => {
    const biz = k => ['hsz','sfo','nyc','lag'].map(s => ({
      s, cost: tyBizCost(k, s), cf: tySpecMul(s,'biz',k,'cf'), mult: tySpecMul(s,'biz',k,'mult') }));
    // 每個城市都要有標籤,而且優點與缺點都要存在於整個世界裡
    const noSpec = TY_SITES.filter(x => !(x.spec||[]).length).map(x => x.id);
    const unknown = TY_SITES.flatMap(x => (x.spec||[])).filter(k => !TY_SPEC[k]);
    const goods = TY_SITES.filter(x => (x.spec||[]).some(k => TY_SPEC[k].good)).length;
    const bads  = TY_SITES.filter(x => (x.spec||[]).some(k => !TY_SPEC[k].good)).length;
    return {
      tech: biz('tech'), noSpec, unknown, goods, bads,
      // 租金回報:東京(房價貴)一定要比大阪(回報高)差
      yldTky: tySpecMul('tky','asset','estate','yld'),
      yldOsa: tySpecMul('osa','asset','estate','yld'),
      // 黃金交易成本:倫敦(金庫)一定要比奈洛比(市場淺)便宜
      feeLon: tySpecMul('lon','asset','gold','fee'),
      feeNbo: tySpecMul('nbo','asset','gold','fee'),
      // 加成一定要夾得住,不可以有城市乘出離譜的倍數
      extreme: TY_SITES.flatMap(x => Object.keys(TY_BIZ).flatMap(k =>
        ['cost','cf','mult'].map(f => tySpecMul(x.id,'biz',k,f))))
        .filter(m => m < .5 - 1e-9 || m > 2 + 1e-9),
    };
  });
  eq(r.noSpec, [], `這些城市沒有任何特色標籤:${r.noSpec.join('、')}`);
  eq(r.unknown, [], `用到了 TY_SPEC 裡沒有的標籤:${r.unknown.join('、')}`);
  eq(r.extreme, [], '城市加成沒有被夾住,乘出了 0.5~2.0 以外的倍數');
  ok(r.goods >= 40, `有優點的城市只有 ${r.goods} 個`);
  ok(r.bads >= 15, `有缺點的城市只有 ${r.bads} 個 —— 「各有優缺點」不能只有優點`);

  const [hsz, sfo, nyc] = r.tech;
  ok(hsz.cost < nyc.cost * .8,
     `新竹開科技公司應該比紐約便宜一截:${hsz.cost} vs ${nyc.cost}`);
  ok(hsz.cf > sfo.cf, `半導體聚落的現金流加成應該比創投聚落高:${hsz.cf} vs ${sfo.cf}`);
  ok(sfo.mult > hsz.mult, `舊金山的估值倍數應該比新竹高:${sfo.mult} vs ${hsz.mult}`);
  ok(r.yldTky < r.yldOsa * .6, `東京的租金回報要明顯比大阪差:${r.yldTky} vs ${r.yldOsa}`);
  ok(r.feeLon < r.feeNbo * .5, `倫敦買黃金要明顯比奈洛比便宜:${r.feeLon} vs ${r.feeNbo}`);

  /* ③ 據點面板:特色卡 + 每一顆按鈕的加成與條件 */
  const panel = await page.evaluate(() => {
    TY_SEL = 'tpe'; TY_ISO = 'TW'; TY_MODAL = 'site'; renderPage();
    const mb = document.querySelector('.tg-mb');
    const acts = [...mb.querySelectorAll('.ty-act')];
    return {
      specs: [...mb.querySelectorAll('.ty-specs .sp')].map(e => ({
        bad: e.classList.contains('bad'),
        nm: e.querySelector('b').textContent.trim() })),
      acts: acts.length,
      withNeed: acts.filter(a => a.querySelector('.ty-need')).length,
      withEdge: acts.filter(a => a.querySelector('.a-edge')).length,
      blocked: acts.filter(a => a.querySelector('.ty-b[disabled]')).map(a =>
        a.querySelector('.ty-need .n.no')?.textContent.replace(/\s+/g,' ').trim() || 'NO-REASON'),
    };
  });
  ok(panel.specs.length >= 2, `台北的特色卡太少:${JSON.stringify(panel.specs)}`);
  ok(panel.specs.some(x => x.bad), '台北應該也要有缺點(房價已經很貴)');
  ok(panel.acts > 8, `據點面板上的動作太少:${panel.acts}`);
  ok(panel.withNeed >= panel.acts - 12, '據點面板上的按鈕大多要寫出它的條件');
  ok(panel.withEdge > 0, '據點面板上至少要有一顆按鈕寫出它在這個城市的加成');
  eq(panel.blocked.filter(x => x === 'NO-REASON'), [],
     '有按鈕被鎖住卻沒說原因 —— 那正是使用者在抱怨的事');

  /* 現金放在長期低利率的城市,借款利率要真的降下來(日圓套利) */
  const carry = await page.evaluate(() => {
    TY.cashSite = 'tpe'; const a = tyRate();
    TY.cashSite = 'tky'; const b = tyRate();
    return { tpe: a, tky: b, note: tyCarry() };
  });
  ok(carry.tky < carry.tpe - .5,
     `現金放東京應該借得比較便宜:${carry.tpe}% vs ${carry.tky}%`);
  ok(/東京/.test(carry.note), `畫面上要說得出這個折扣是哪裡來的:「${carry.note}」`);

  /* 燒錢的公司不可以印成賺錢 —— tySgn 原本把負號吃掉了 */
  const sgn = await page.evaluate(() => ({ neg: tySgn(-13.26e6), pos: tySgn(13.26e6) }));
  ok(/^-/.test(sgn.neg), `負的現金流一定要印出負號,實際:「${sgn.neg}」`);
  ok(/^\+/.test(sgn.pos), `正的現金流要印出正號,實際:「${sgn.pos}」`);

  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國:對手會擴張、互相併購、記恨,而且談得動', async (browser) => {
  /* 使用者:「做出其他富豪可以互相競爭,就像是真實的世界一樣…
             也可以看到對手的勢力,還有可以合作、談條件。」

     第一版的對手只有一個淨值,每季乘一個成長率 —— 那是計分板不是對手。
     這一條盯的是「他們真的在玩同一場遊戲」: */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  await page.click('.tg-scn[data-k="heir"]');
  /* ⚠ 等「劇本真的開起來了」,不是等一個固定的毫秒數。
     跑整套測試的時候機器很忙,250 毫秒有時候不夠 —— 點擊還沒生效就開始
     跑三十季,於是 tyBuy 全部失敗、抽到的亂數整串偏掉,測試就會忽好忽壞。
     (實際發生過:這一條在單獨跑的時候五次全過,整套跑就偶爾紅一次。) */
  await page.waitForFunction(() => typeof TY === 'object' && TY && TY.scn === 'heir',
                             { timeout: 5000 });

  // ① 跑三十季:地盤要長、關係要動、要有人被併掉或倒掉
  const world = await page.evaluate(() => {
    /* ⚠ 重開一局並把種子傳進去。原本是 `TY.rng = 20260101` ——
       但對手是在 tyStart 裡面用亂數發牌的,牌發完才換種子,那一局的對手
       其實是**時鐘**決定的,於是這條測試會忽好忽壞(單獨跑五次全過,
       整套跑偶爾紅一次)。上面那個 click 已經驗過「點劇本進得了指揮台」。 */
    tyStart('heir', 20260101);
    const turf0 = tyRivalsA().reduce((s, r) =>
      s + Object.values(r.turf || {}).reduce((a, b) => a + b, 0), 0);
    for (let i = 0; i < 30; i++) { TY_SIZE = .2; tyBuy('semi'); tyBuy('estate'); tyNext(); }
    const alive = tyRivalsA();
    const turf1 = alive.reduce((s, r) =>
      s + Object.values(r.turf || {}).reduce((a, b) => a + b, 0), 0);
    return {
      turf0, turf1,
      n: alive.length,
      dead: TY.rivals.filter(r => r.alive === false).length,
      rels: alive.map(r => r.rel || 0),
      logs: TY.log.filter(l => l.kind === 'rival').length,
      // 勢力值一定要夾在 0~100,不可以有人長到爆掉
      bad: alive.flatMap(r => Object.values(r.turf || {})).filter(v => v < 0 || v > 100),
      nan: alive.some(r => !isFinite(r.nw) || !isFinite(r.rel || 0)),
    };
  });
  ok(!world.nan, '對手的淨值或關係算出了 NaN');
  eq(world.bad, [], '勢力值跑出了 0~100 之外');
  ok(world.turf1 > world.turf0, `三十季之後對手的地盤總量應該變大:${world.turf0} → ${world.turf1}`);
  ok(world.logs >= 5, `三十季裡對手只做了 ${world.logs} 件事 —— 他們應該一直在動`);
  ok(world.rels.some(v => v !== 0), '沒有任何一個對手對你有態度(關係全是 0)');
  ok(world.n >= 1, '對手不可以全部消失,不然排名沒有意義');

  // ② 談條件:成功率要在 5%~95% 之間,而且加價一定要提高成功率
  const odds = await page.evaluate(() => {
    const r = tyRivalsA()[0];
    const cheap = tyDealOdds('pact', r, tyDealPrice('pact', r) * .3);
    const rich  = tyDealOdds('pact', r, tyDealPrice('pact', r) * 3);
    const hated = (() => { const o = r.rel; r.rel = -90;
                           const v = tyDealOdds('pact', r, tyDealPrice('pact', r)); r.rel = o; return v; })();
    const loved = (() => { const o = r.rel; r.rel = 90;
                           const v = tyDealOdds('pact', r, tyDealPrice('pact', r)); r.rel = o; return v; })();
    const all = Object.keys(TY_DEALS).map(k => tyDealOdds(k, r, tyDealPrice(k, r)));
    return { cheap, rich, hated, loved, min: Math.min(...all), max: Math.max(...all) };
  });
  ok(odds.rich > odds.cheap + .1, `加價要能提高成功率:${odds.cheap} → ${odds.rich}`);
  ok(odds.loved > odds.hated + .3, `關係要能左右成功率:敵對 ${odds.hated} vs 盟友 ${odds.loved}`);
  ok(odds.min >= .05 - 1e-9 && odds.max <= .95 + 1e-9,
     `成功率要夾在 5%~95%:${odds.min} ~ ${odds.max}`);

  // ③ 談成一筆合作,狀態要真的改變(這裡把成功率拉滿,測的是結果不是運氣)
  const deal = await page.evaluate(() => {
    const r = tyRivalsA()[0];
    r.rel = 95; TY.cash = 400e8;
    TY_PAMT[`deal:pact:${r.id}`] = tyDealPrice('pact', r) * 3;
    const msg = tyDeal('pact', r.id);
    return { msg, pact: r.pact, t: TY.t, rel: r.rel };
  });
  ok(/答應|拒絕/.test(deal.msg), `談判要回一句話說明結果:「${deal.msg}」`);
  if (/答應/.test(deal.msg)) ok(deal.pact > deal.t, '談成互不侵犯之後應該有一個到期季別');

  // ④ 敵意收購:條件、代價、以及他真的會少一塊
  const hostile = await page.evaluate(() => {
    const r = tyRivalsA()[0];
    const nw0 = r.nw, heat0 = TY.heat;
    r.rel = 95; TY.cash = 900e8;
    TY_PAMT[`deal:hostile:${r.id}`] = tyRivalStake(r) * 4;
    const msg = tyDeal('hostile', r.id);
    return { msg, ok: /答應/.test(msg), took: nw0 - r.nw, heat: TY.heat - heat0, rel: r.rel };
  });
  if (hostile.ok) {
    ok(hostile.took > 0, '敵意收購成功之後對方的身家一定要少一塊');
    ok(hostile.heat > 0, '敵意收購一定要付出關注度的代價');
  } else {
    ok(hostile.rel < 90, '敵意收購失敗之後關係一定要變差');
  }

  // ⑤ 畫面:勢力條、關係、七種交易與它們的成功率都要畫得出來
  const ui = await page.evaluate(() => {
    TY_MODAL = 'rival'; TY_RIVAL = tyRivalsA()[0].id; TY_DEAL = 'jv'; renderPage();
    const mb = document.querySelector('.tg-mb');
    return {
      cards: mb.querySelectorAll('.ty-card.rv').length,
      turfBars: mb.querySelectorAll('.rv-turf .tf').length,
      rel: !!mb.querySelector('.rv-rel .rl-t'),
      deals: mb.querySelectorAll('.rv-deal').length,
      odds: [...mb.querySelectorAll('.rv-odds')].map(e => e.textContent.trim()),
      dealBtn: !!mb.querySelector('[data-ty="deal:jv"]'),
      amtBox: !!mb.querySelector('.rv-deal.open .ty-money'),
    };
  });
  ok(ui.cards >= 1, '對手面板上一張卡都沒有');
  ok(ui.turfBars > 0, '看不到對手的勢力 —— 那是使用者明確要的東西');
  ok(ui.rel, '看不到跟對手的關係');
  eq(ui.deals, Object.keys(await page.evaluate(() => TY_DEALS)).length,
     '七種可以談的條件沒有全部畫出來');
  ok(ui.odds.every(t => /%$/.test(t)),
     `每一種交易旁邊都要寫著成功率:${JSON.stringify(ui.odds)}`);
  ok(ui.dealBtn && ui.amtBox, '展開的交易要有金額選擇器與一顆真的按得下去的按鈕');

  // ⑥ 地圖:勢力範圍圖層要真的依「誰最強」上色
  const map = await page.evaluate(() => {
    TY_LAYER = 'power';
    const r = tyRivalsA()[0];
    /* ⚠ 要挑一個**你自己幾乎沒有東西**的地區。tyRegOwner 平手時算你的,
       所以如果你在那一區的勢力也是 100,對手就算滿檔也拿不到那個顏色 ——
       第一版直接拿 Object.keys(turf)[0],剛好撞到玩家押滿的那一區。 */
    const reg = Object.keys(TY_REGIONS)
      .filter(g => g !== 'off' && TY_SITES.some(x => x.reg === g))
      .sort((a, b) => tyMyTurf(a) - tyMyTurf(b))[0];
    const site = TY_SITES.find(x => x.reg === reg);
    const was = tyTurf(r, reg);
    r.turf = r.turf || {};
    r.turf[reg] = 100;                        // 讓他在那一區壓倒性領先
    const his = tyCountryColor({ properties: { ISO_A2: site.iso } });
    r.turf[reg] = was;
    return { his, reg, myTurf: tyMyTurf(reg), col: TY_RVCOL[r.id] };
  });
  ok(map.myTurf < 100, `挑到的地區(${map.reg})你自己也押滿了,測不到對手的顏色`);
  ok(map.his.includes(map.col), `勢力圖層要用對手自己的顏色上色,實際:${map.his}`);

  // ⑦ 頂列的淨值走勢圖
  const spark = await page.evaluate(() => {
    TY_MODAL = null; renderPage();
    const el = document.querySelector('.tg-nwp .tg-spark');
    return { has: !!el, paths: el ? el.querySelectorAll('path').length : 0,
             clickable: !!document.querySelector('.tg-nwp[data-ty="modal:rank"]') };
  });
  ok(spark.has && spark.paths >= 2, '頂列應該有一張小小的淨值走勢圖');
  ok(spark.clickable, '走勢圖那一格要點得開富豪榜');

  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國:指揮台的外殼不可以撞到站上既有的 class,面板打開時地圖要整層收起來', async (browser) => {
  /* 這一條抓的是兩個**單元測試看不到、只有肉眼看得到**的 bug,兩個都真的發生過:

     ① 指揮台的容器原本叫 .tg —— 但 .tg 早就是「標籤卡」,帶著
        border:1px solid var(--accent)。於是整個畫面最外圈多了一道藍框,
        沒有任何一行程式碼寫過它。同樣的事在 .cmd 上又發生一次
        (那是走勢比較那一條,帶著 font-family:var(--mono),CJK 字會互相重疊)。
        → 外殼的每一個容器 class,計算後的 border / outline 都必須是 0。

     ② 面板蓋在地圖上的時候,globe.gl 的 HTML 標記還是看得見 ——
        它自己算 z-index,會算到比面板還高,面板的背景色壓不住。
        畫面上就是城市名直接印在面板的文字上。
        → 有面板打開的時候,地球那一層必須是不可見的。 */
  const page = await freshPage(browser, { width: 390, height: 844, seed: SEED, hash: '#/tycoon' });
  await page.click('.tg-scn[data-k="heir"]');
  /* ⚠ 等「劇本真的開起來了」,不是等一個固定的毫秒數。
     跑整套測試的時候機器很忙,250 毫秒有時候不夠 —— 點擊還沒生效就開始
     跑三十季,於是 tyBuy 全部失敗、抽到的亂數整串偏掉,測試就會忽好忽壞。
     (實際發生過:這一條在單獨跑的時候五次全過,整套跑就偶爾紅一次。) */
  await page.waitForFunction(() => typeof TY === 'object' && TY && TY.scn === 'heir',
                             { timeout: 5000 });

  const frame = await page.evaluate(() => {
    const bad = [];
    for (const sel of ['#tyRoot', '.tg-top', '.tg-res', '.tg-map', '.tg-nav']) {
      const el = document.querySelector(sel);
      if (!el) { bad.push(sel + ' 不存在'); continue; }
      const cs = getComputedStyle(el);
      // 邊框只要有一邊不是 0 就算撞到別人的規則(這一層自己完全不畫外框)
      const w = ['Top','Right','Bottom','Left'].map(s => parseFloat(cs['border' + s + 'Width']) || 0);
      if (sel === '#tyRoot' && w.some(x => x > 0))
        bad.push(`${sel} 有邊框 ${w.join('/')} ${cs.borderColor} —— 多半是撞到同名的 class`);
      if (parseFloat(cs.outlineWidth) > 0 && cs.outlineStyle !== 'none')
        bad.push(`${sel} 有 outline ${cs.outline}`);
    }
    // 字型也要是站上的無襯線,撞到等寬的 class 會讓中文擠在一起
    const nm = document.querySelector('.tg-id b');
    if (nm && /mono|Menlo|Consolas/i.test(getComputedStyle(nm).fontFamily))
      bad.push('身分列的名字被套成等寬字 —— 撞到同名的 class');
    return bad;
  });
  ok(frame.length === 0, `指揮台的外殼被別的 class 汙染了:\n      ${frame.join('\n      ')}`);

  // 面板打開 → 地球那一層必須看不見
  await page.click('[data-ty="modal:asset"]');
  await page.waitForTimeout(250);
  const shown = await page.evaluate(() => {
    const root = document.getElementById('tyRoot');
    const slot = document.getElementById('tyGlobeSlot');
    return {
      flagged: !!(root && root.dataset.modal),
      slotVis: slot ? getComputedStyle(slot).visibility : 'none',
    };
  });
  ok(shown.flagged, '面板打開的時候 #tyRoot 要標上 data-modal,CSS 才藏得掉地球');
  eq(shown.slotVis, 'hidden', '面板蓋上來的時候地球那一層必須整層看不見(不然標記會穿透出來)');

  // 關掉之後要回得來,不然地圖就永遠消失了
  await page.click('.tg-x');
  await page.waitForTimeout(250);
  const back = await page.evaluate(() => {
    const slot = document.getElementById('tyGlobeSlot');
    return slot ? getComputedStyle(slot).visibility : 'none';
  });
  eq(back, 'visible', '關掉面板之後地圖要回來');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國:開局之後的畫面在 390px 也不會左右晃', async (browser) => {
  /* 最上面那條「每一頁在 390px 不會橫向溢出」的測試,看到的帝國永遠是**開局前**
     的選劇本畫面 —— 因為它沒有存檔。真正擠的是開局之後:資產列有四欄、
     事業卡有五顆按鈕、手法卡是三欄的格線。那些畫面沒有任何一條測試看得到。 */
  const page = await freshPage(browser, { width: 390, height: 844, seed: SEED, hash: '#/tycoon' });
  await page.evaluate(() => {
    tyStart('heir', 4242);
    for (let t = 1; t <= 12; t++) {
      TY_SIZE = .25; tyBuy('tech'); tyBuy('crypto'); tyShort('oil'); tyBorrow();
      if (t === 2) tyFound('shell', 'cay');
      if (t === 3) tyFound('media');
      if (t === 8) for (const b of TY.biz) tyIPO(b.id);
      tyNext();
    }
    TY_MSG = '已借到 12.4 億,年利率 4.86%。錢是你的,風險也是。';
  });
  for (const [k, nm] of [['asset','資產'],['biz','事業'],['play','手法'],['rank','富豪榜'],['log','大事記']]) {
    await page.evaluate(x => { TY_MODAL = x; renderPage(); }, k);
    await page.waitForTimeout(150);
    const over = await page.evaluate(() => {
      const pg = document.getElementById('page'), bad = [];
      for (const el of pg.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (!r.width || r.right <= window.innerWidth + 1) continue;
        if (getComputedStyle(el).overflowX.match(/auto|scroll/)) continue;
        let p = el.parentElement, scrollable = false;
        while (p && p !== pg) {
          if (getComputedStyle(p).overflowX.match(/auto|scroll/)) { scrollable = true; break; }
          p = p.parentElement;
        }
        if (!scrollable) bad.push(el.tagName + '.' + el.className + ' → right=' + Math.round(r.right));
      }
      return bad.slice(0, 4);
    });
    ok(over.length === 0, `「${nm}」在 390px 有元素超出畫面:\n      ${over.join('\n      ')}`);
  }
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國:每一筆錢都有地址,而且地點會影響它值多少', async (browser) => {
  /* 地理化最容易安靜壞掉的地方是「兩邊算法不一致」:買進時用一個價格
     (全球價 × 當地指數),估值時用另一個。這樣的 bug 不會報錯,只會讓
     你一買進去淨值就跳一下 —— 而那一跳可能是好幾億。 */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('heir', 4242);
    const nw0 = tyNW();
    TY_SIZE = .25;
    const msg = tyBuy('estate', 'dxb');
    const nw1 = tyNW();
    const p = TY.pos.find(x => x.k === 'estate' && x.site === 'dxb');
    // 同一種資產放在兩個地區,指數不同 → 價值就不同
    TY.reg.me.idx = 2;  TY.reg.na.idx = 1;
    tyBuy('estate', 'nyc');
    const dxb = tyPosVal(TY.pos.find(x => x.site === 'dxb'));
    const nyc = tyPosVal(TY.pos.find(x => x.site === 'nyc'));
    return {
      msg, nw0, nw1, q: p ? p.q : 0, site: p ? p.site : null,
      // 買進只該損失手續費,不該憑空生出或蒸發淨值
      slip: (nw1 - nw0) / nw0,
      dxbUp: dxb, nycUp: nyc,
      total: tyVal('estate'), sumPos: TY.pos.reduce((a, x) => a + tyPosVal(x), 0),
      assetVal: tyAssetVal(),
    };
  });
  ok(/杜拜/.test(r.msg), `買進的回覆要講清楚買在哪裡,實際:「${r.msg}」`);
  eq(r.site, 'dxb', '部位要記在買進的那個地點上');
  ok(r.q > 0, '買完之後要真的有數量');
  ok(Math.abs(r.slip) < 0.02, `買進前後淨值差了 ${(r.slip * 100).toFixed(2)}% —— 只該少掉手續費`);
  near(r.assetVal, r.sumPos, 1, '資產總值必須等於每一筆部位加起來');
  ok(r.dxbUp > r.nycUp * 1.5,
     `地區指數 2 倍的地方,同樣的錢買到的部位現在該值比較多(杜拜 ${Math.round(r.dxbUp)} vs 紐約 ${Math.round(r.nycUp)})`);
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國:稅率來自司法管轄區,而且省越多被盯越快', async (browser) => {
  /* 這一頁唯一「查得證」的數字就是各地的法定公司稅率,所以它不能是模型
     算出來的 —— 它必須直接來自 TY_SITES 那份表。 */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    const out = {};
    tyStart('heir', 7);
    out.home = TY.home;
    out.homeTax = tyTaxRate();                 // 沒有架構 → 出身地稅率
    out.tableTax = tySite(TY.home).tax;
    // 沒有空殼公司就設不了控股層
    out.refuse = tySetHoldco('cay');
    tyFound('shell', 'cay');
    out.ok = tySetHoldco('cay');
    out.after = tyTaxRate();
    out.gap = tyTaxGap();
    // 關注度的成長跟「省了幾個百分點」成正比
    const h0 = TY.heat; for (let i = 0; i < 4; i++) tyNext();
    out.heatCay = TY.heat - h0;
    // 換成新加坡(17%)—— 省得少,長得慢
    tyStart('heir', 7);
    tyFound('shell', 'sin'); tySetHoldco('sin');
    const h1 = TY.heat; for (let i = 0; i < 4; i++) tyNext();
    out.heatSin = TY.heat - h1;
    out.sinTax = tyTaxRate();
    tyClear();
    return out;
  });
  eq(r.homeTax, r.tableTax, '沒有控股架構時,稅率就是出身地那一格的法定稅率');
  ok(/空殼/.test(r.refuse), `沒有空殼公司就不該設得成控股層,實際:「${r.refuse}」`);
  eq(r.after, 0, '控股層設在開曼之後,稅率該是 0%');
  eq(r.sinTax, 0.17, '控股層設在新加坡之後,稅率該是 17%');
  ok(r.heatCay > r.heatSin,
     `開曼(省 20 個百分點)累積的關注度要比新加坡(省 3 個)快,實際 ${r.heatCay.toFixed(1)} vs ${r.heatSin.toFixed(1)}`);
  await page.__ctx.close();
});

test('帝國:政策風險高的地方要有在地夥伴才進得去', async (browser) => {
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('heir', 11);
    TY_SIZE = .3;
    const out = {};
    out.blockedBuy = tyBuy('estate', 'sha');        // 上海:大中華,政策風險高
    out.blockedBiz = tyFound('dev', 'sha');
    out.freeBuy = tyBuy('estate', 'tpe');           // 台灣不需要夥伴
    TY.cash = 500e8;
    out.partner = tyPartner('cn');
    out.afterBuy = tyBuy('estate', 'sha');
    out.hasPartner = !!TY.partners.cn;
    // 台灣不能跟中國大陸同一區,不然台北的東西會一直被「徵收」打
    out.twReg = tySite('tpe').reg;
    out.cnReg = tySite('sha').reg;
    out.twPol = TY_REGIONS[tySite('tpe').reg].pol;
    tyClear();
    return out;
  });
  ok(/夥伴/.test(r.blockedBuy), `上海買不動產應該要先有夥伴,實際:「${r.blockedBuy}」`);
  ok(/夥伴/.test(r.blockedBiz), `上海開公司應該要先有夥伴,實際:「${r.blockedBiz}」`);
  ok(/台北/.test(r.freeBuy), `台北不需要夥伴,實際:「${r.freeBuy}」`);
  ok(r.hasPartner, '付了錢之後應該真的有夥伴');
  ok(/上海/.test(r.afterBuy), `有夥伴之後上海應該買得進去,實際:「${r.afterBuy}」`);
  ok(r.twReg !== r.cnReg, '台灣與中國大陸必須是不同的地區');
  ok(r.twPol < 0.5, `台灣的政策風險係數不該跟中國大陸一樣高(現在 ${r.twPol})`);
  await page.__ctx.close();
});

test('帝國地球:切分頁不會一直生出新的 WebGL context', async (browser) => {
  /* renderPage() 每次都會 innerHTML 清空 #page。地球如果直接畫在分頁裡,
     每切一次就是一個新的 WebGL context —— 瀏覽器同時只給十幾個,
     切個幾次整顆地球就再也畫不出來(而且不會報錯,只是變成空白)。
     所以它停在 #page 外面,靠 appendChild 搬進搬出。 */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  await page.evaluate(() => { tyStart('heir'); TY_MODAL = null; renderPage(); });
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => document.querySelectorAll('canvas').length);
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => { TY_MODAL = 'asset'; renderPage(); });
    await page.waitForTimeout(60);
    await page.evaluate(() => { TY_MODAL = null; renderPage(); });
    await page.waitForTimeout(60);
  }
  const r = await page.evaluate(() => ({
    canvases: document.querySelectorAll('canvas').length,
    host: document.getElementById('tyGlobeHost')?.parentElement?.id,
  }));
  eq(r.canvases, before, `切了六次分頁之後 canvas 從 ${before} 變成 ${r.canvases} 個`);
  eq(r.host, 'tyGlobeSlot', '在地圖那一分頁,地球要被搬進去');
  /* 原本這裡是「切到 #/holdings,地球要回停車位」。獨立出來之後這個遊戲
     只有一頁,沒有別的分頁可以切 —— 但要守的那條不變式還在,而且更重要:
     **renderPage() 會 innerHTML 清空 #page,所以地球一定要先被搬出去。**
     切到別的分頁只是觸發它的其中一種方式。
     所以改成直接測那件事:停在地圖分頁的時候重畫,地球必須活下來。 */
  await page.evaluate(() => { renderPage(); });           // 停在地圖分頁重畫
  await page.waitForTimeout(200);
  const alive = await page.evaluate(() => ({
    exists: !!document.getElementById('tyGlobeHost'),
    canvases: document.querySelectorAll('canvas').length,
  }));
  ok(alive.exists, '重畫之後地球的容器不可以消失(那代表它被 innerHTML 清掉了)');
  eq(alive.canvases, before, `重畫之後 canvas 應該還是 ${before} 個,實際 ${alive.canvases} 個`);

  /* 什麼時候地球才真的回停車位?看 bindTycoon 那一行:
       if(TY){ tyGlobeMount(); … } else tyParkGlobe();
     ——是「**這一局還在不在**」決定的,不是哪一個分頁、也不是有沒有開面板。
     (面板打開時地圖只是被 CSS 收起來,地球還掛在槽裡,所以不用重建。)
     所以測的是:放棄這一局、回到選劇本的畫面之後,地球要被收回去。 */
  await page.evaluate(() => { tyClear(); renderPage(); });
  await page.waitForTimeout(200);
  eq(await page.evaluate(() => document.getElementById('tyGlobeHost')?.parentElement?.id),
     'tyGlobePark', '沒有在玩的時候,地球要搬回停車位(不然它會被 innerHTML 清掉)');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國地圖:點國家要列出州 / 省,點據點要列出那裡有什麼', async (browser) => {
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  await page.evaluate(() => {
    tyStart('heir', 99); TY_SIZE = .25;
    tyBuy('estate', 'nyc'); tyBuy('tech', 'tky');
    TY_MODAL = null; renderPage();
  });
  await page.waitForTimeout(300);
  // 世界層(右側的「總覽」鈕):依國家列出來
  await page.click('[data-ty="overview"]');
  await page.waitForTimeout(200);
  const world = await page.$$eval('.ty-geo', els => els.length);
  ok(world >= 2, `世界層應該至少列出兩個國家,實際 ${world}`);

  await page.evaluate(() => tyPickIso('US'));
  await page.waitForTimeout(300);
  const us = await page.evaluate(() => ({
    hd: document.querySelector('.tg-mb .p-hd b')?.textContent,
    subs: [...document.querySelectorAll('.sub-h')].map(x => x.textContent),
    has: [...document.querySelectorAll('.ty-site.has')].length,
    all: [...document.querySelectorAll('.ty-site')].length,
  }));
  eq(us.hd, '美國', '點了美國,標題就該是美國');
  ok(us.subs.includes('紐約州') && us.subs.includes('加州'),
     `美國要依州分組,實際分組:${us.subs.join('、')}`);
  ok(us.all > us.has, '沒進場的城市也要列出來(灰色的那些),不然看不到還能去哪裡');

  await page.evaluate(() => tyPickSite('nyc'));
  await page.waitForTimeout(300);
  const nyc = await page.evaluate(() => ({
    hd: document.querySelector('.tg-mb .p-hd b')?.textContent,
    facts: [...document.querySelectorAll('.ty-facts b')].map(x => x.textContent),
    stuff: [...document.querySelectorAll('.st b')].map(x => x.textContent),
    acts: [...document.querySelectorAll('.ty-acts button')].length,
  }));
  eq(nyc.hd, '紐約', '點了紐約,標題就該是紐約');
  ok(nyc.facts[0] === '21.0%', `紐約那一格要印真實的法定公司稅率,實際「${nyc.facts[0]}」`);
  ok(nyc.stuff.includes('房地產'), `紐約有房地產,面板上就該列出來:${nyc.stuff.join('、')}`);
  ok(nyc.acts > 0, '據點面板要有可以就地執行的動作');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國:真實富豪榜拿得到就排進去,拿不到要直說', async (browser) => {
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  await page.evaluate(() => {
    tyStart('heir', 3);
    TY.cash = 40e12;                 // 直接給一筆很大的錢,才排得進假榜單前面
    TY_MODAL = 'rank'; TY_RANK = 'real'; renderPage(); loadRich();
  });
  await page.waitForFunction(() => RICH.rows.length > 0 || RICH.err, { timeout: 8000 });
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => ({
    err: RICH.err, n: RICH.rows.length,
    names: [...document.querySelectorAll('.ty-lb .nm b')].map(x => x.textContent),
    note: document.querySelector('.tg-mb .expo-note')?.textContent || '',
  }));
  eq(r.err, '', `真實富豪榜應該拿得到(測試環境有假的 /api/rich),錯誤:${r.err}`);
  ok(r.names.includes('你'), `你自己要出現在榜上:${r.names.join('、')}`);
  ok(r.names.includes('A. Rich'), `真實榜單上的人要出現:${r.names.join('、')}`);
  ok(/Forbes/.test(r.note) && /非官方/.test(r.note),
     '一定要寫出資料來源,以及「這是非官方端點」這件事');
  ok(/模擬出來的/.test(r.note), '一定要寫清楚「你那個數字是模擬的」');

  // 拿不到的時候不可以假裝有
  const dead = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  await dead.route('**/api/rich*', route => route.fulfill({ status: 502, body: '{"error":"上游掛了"}' }));
  await dead.evaluate(() => { tyStart('heir'); TY_MODAL = 'rank'; TY_RANK = 'real'; renderPage(); loadRich(); });
  await dead.waitForFunction(() => RICH.err || RICH.rows.length, { timeout: 8000 });
  await dead.waitForTimeout(300);
  const txt = await dead.evaluate(() => document.querySelector('.tg-mb')?.textContent || '');
  ok(/拿不到/.test(txt), `拿不到榜單時要直說,實際畫面:「${txt.slice(0, 60)}」`);
  ok(/不受影響/.test(txt), '要說明模擬器其他部分照常可用');
  await dead.__ctx.close();
  await page.__ctx.close();
});

test('帝國:買之前就看得到會買到幾棟,而且事業可以賣掉', async (browser) => {
  /* 使用者回報的兩件事:
     「買的時候可以選擇要買多少、馬上知道值多少、買幾棟」→ 單位換算 + 成交預覽
     「我的事業可不可以賣掉,在我賺錢之後」→ tySellBiz()
     單位換算最容易錯的地方是「棟數會不會跟著漲價變多」—— 不會,你買了 6 棟,
     房價翻倍之後你還是 6 棟,只是每一棟值兩倍。 */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('heir', 5150);
    const out = {};
    // 指定金額下單(不是比例)
    TY_AMT = 3e8;
    out.amt = tyOrderAmt();
    out.preview = tyBuyPreview('estate', 'tpe');
    tyBuy('estate', 'tpe');
    const p = TY.pos.find(x => x.k === 'estate');
    out.units = tyUnitCount(p);
    out.unitPx = tyUnitPx('estate', 'tpe');
    // 漲價之後棟數不可以變
    TY.px.estate *= 2;
    out.unitsAfter = tyUnitCount(p);
    out.valDoubled = tyPosVal(p);
    TY.px.estate /= 2;
    // 同樣的錢在貴的地方買得比較少
    TY.reg.na.idx = 2;
    TY_AMT = 3e8;
    tyBuy('estate', 'nyc');
    out.nycUnits = tyUnitCount(TY.pos.find(x => x.site === 'nyc'));

    // 事業:賣得掉,而且錢要進來、現金流要消失
    tyNext();                       // 先跑一季,讓它真的賺過錢(「在我賺錢之後」)
    const biz = TY.biz.find(b => !TY_BIZ[b.k].shell);
    const val = tyBizVal(biz) * biz.own, cash0 = TY.cash;
    out.msg = tySellBiz(biz.id);
    out.gained = TY.cash - cash0;
    out.expect = val * 0.94;
    out.gone = !TY.biz.some(b => b.id === biz.id);
    // 空殼如果正在當控股層,不能說賣就賣
    tyFound('shell', 'cay'); tySetHoldco('cay');
    out.holdcoRefuse = tySellBiz(TY.biz.find(b => TY_BIZ[b.k].shell).id);
    TY_AMT = null;
    return out;
  });
  eq(r.amt, 3e8, '打了金額就該用那個金額下單,不是比例');
  ok(/棟/.test(r.preview) && /每棟/.test(r.preview),
     `預覽要講清楚買得到幾棟、每棟多少,實際:「${r.preview.replace(/<[^>]+>/g, '')}」`);
  near(r.units, 3e8 * 0.985 / r.unitPx, 0.2, '買到的棟數要跟預覽算的一樣');
  eq(r.unitsAfter, r.units, '房價漲了棟數不可以跟著變 —— 你還是那幾棟,只是每棟比較貴');
  ok(r.nycUnits < r.units * 0.6,
     `地區指數兩倍的地方,同樣的錢該買到大約一半(台北 ${r.units.toFixed(1)} 棟 vs 紐約 ${r.nycUnits.toFixed(1)} 棟)`);
  near(r.gained, r.expect, r.expect * 0.01, '賣掉事業入帳的錢應該是估值扣掉 6% 交易成本');
  ok(r.gone, '賣掉之後那家公司不該還在清單上');
  ok(/現金流/.test(r.msg), `賣掉的回覆要提醒你失去了什麼,實際:「${r.msg.replace(/<[^>]+>/g, '')}」`);
  ok(/控股層/.test(r.holdcoRefuse), `正在當控股層的空殼不該賣得掉,實際:「${r.holdcoRefuse}」`);
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國:「怎麼玩」那一頁要真的解釋得了每一個名詞', async (browser) => {
  /* 使用者回報「有很多我都沒有看過的名詞,也不知道可以幹嘛」。
     這條測的是最低限度的誠實:畫面上按得到的每一個手法,名詞表裡都要有
     一條在解釋它 —— 不然這一頁只是看起來有教學。 */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('heir'); TY_MODAL = 'learn'; renderPage();
    const terms = TY_TERMS.map(t => t.t).join(' | ');
    return {
      n: TY_TERMS.length,
      books: TY_PLAYBOOKS.length,
      terms,
      // 每一條大師走法都要有可以查證的「他做過什麼」與步驟
      allReal: TY_PLAYBOOKS.every(b => b.real && b.real.length > 40 && b.steps.length >= 4),
      // 步驟的判定式不可以炸
      stepsOk: TY_PLAYBOOKS.every(b => b.steps.every(s => { try { s.d(); return true; } catch (e) { return false; } })),
      html: document.querySelector('.tg-mb').innerHTML.length,
      disclaimer: document.querySelector('.tg-mb').textContent,
    };
  });
  ok(r.n >= 20, `名詞表至少要有二十條,實際 ${r.n}`);
  for (const must of ['槓桿', '放空', '借殼上市', '空殼公司', '控股層', '破產保護',
                      '浮存金', '追繳保證金', '監理關注', '在地夥伴', '品牌授權', '估值倍數(本益比)'])
    ok(r.terms.includes(must), `名詞表少了「${must}」—— 那是畫面上按得到的東西`);
  ok(r.books >= 5, `大師走法至少要五條,實際 ${r.books}`);
  ok(r.allReal, '每一條大師走法都要寫出「他實際做過的事」與至少四個步驟');
  ok(r.stepsOk, '大師走法的進度判定式不可以丟例外');
  ok(r.html > 3000, `「怎麼玩」這一頁太短了(${r.html} 字元)`);
  ok(/不是對任何人的評價/.test(r.disclaimer) && /沒有重來鍵/.test(r.disclaimer),
     '大師走法一定要寫清楚:這不是評價,也不是建議照做');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國:賣掉要繳資本利得稅,質押借款不用 —— buy-borrow-die', async (browser) => {
  /* 這一條測的是整組手法的地基。少了資本利得稅,「不賣改成借」就完全沒有理由,
     而這個模擬器原本正是那樣 —— 賣掉是免費的。 */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    const out = {};
    // 台北:證券資本利得 0%、不動產 20% —— 這正是台灣真實的樣子
    out.tpeSec = tyCg('tpe', 1); out.tpeRe = tyCg('tpe', 0);
    out.nycSec = tyCg('nyc', 1); out.caySec = tyCg('cay', 1);

    // 用一個證券要課稅的居住地開局(紐約),才看得到差別
    tyStart('float', 99); TY.home = 'nyc'; TY.cash = 100e8;
    TY_AMT = 40e8; tyBuy('tech', 'nyc');
    TY.px.tech *= 2;                                   // 漲一倍 → 有未實現獲利
    const un = tyUnreal();
    out.gain = un.gain; out.wouldTax = un.tax;
    ok0 = un.tax > 0;

    // (A) 賣掉一半:要被課稅
    const cash0 = TY.cash, tax0 = TY.taxPaid;
    TY_SIZE = .5; tySell('tech');
    out.sellTax = TY.taxPaid - tax0;
    out.sellMsg = TY_MSG = '';

    // (B) 質押借款:一毛稅都不用繳
    const tax1 = TY.taxPaid, cash1 = TY.cash;
    const msg = tySbl();
    out.borrowed = TY.cash - cash1;
    out.borrowTax = TY.taxPaid - tax1;
    out.msg = msg;
    out.sbl = TY.sbl;
    // 質押的利率要比一般抵押借款低
    out.rate = tyRate(); out.sblRate = tySblRate();

    // (C) 搬到 0% 的地方,證券的稅率就換掉了
    TY.cash = 500e8;
    out.moveMsg = tyMoveHome('sin');
    out.afterMoveSec = tyCg(TY.home, 1);
    // 不動產不會因為搬家而免稅 —— 它由所在國課
    const re = { k: 'estate', site: 'nyc', q: 1, cb: 0 };
    out.reStill = tyCgRate(re);
    tyClear();
    return out;
  });
  eq(r.tpeSec, 0, '台灣賣上市股票停徵所得稅 —— 證券資本利得該是 0%');
  ok(r.tpeRe > 0, '台灣的房地合一稅是真的 —— 不動產處分不該是 0%');
  ok(r.nycSec > 0.2, `美國的證券資本利得該在 20% 以上,實際 ${r.nycSec}`);
  eq(r.caySec, 0, '開曼該是 0%');
  ok(r.gain > 0 && r.wouldTax > 0, '漲了一倍之後應該要有未實現獲利與潛在稅負');
  ok(r.sellTax > 0, '賣出必須課到資本利得稅 —— 沒有它,整組手法就沒有意義');
  ok(r.borrowed > 0, '質押借款要真的借得到錢');
  eq(r.borrowTax, 0, '借來的錢不是所得,一毛稅都不該課 —— 這就是整件事的重點');
  ok(r.sblRate < r.rate - 1, `質押利率該比一般抵押借款低(${r.sblRate.toFixed(2)}% vs ${r.rate.toFixed(2)}%)`);
  ok(/稅/.test(r.msg), '質押的回覆要講清楚稅的差別');
  eq(r.afterMoveSec, 0, '搬到新加坡之後,證券資本利得稅率該變成 0%');
  ok(r.reStill > 0, '不動產的獲利由它所在的國家課 —— 搬家沒有用');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國地圖:建築要照類型上色、照價值長高、照狀態標記', async (browser) => {
  /* 使用者要的是「一眼分辨資產或事業的狀態」。這一條盯的是那個對應關係:
     顏色 = 類型、高度 = 價值、角落的記號 = 狀態。 */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('heir', 3); TY.cash = 400e8; TY_AMT = 60e8;
    tyBuy('estate', 'nyc'); tyBuy('gold', 'zur');
    tyFound('shell', 'cay'); tySetHoldco('cay');
    tyNext();
    const nyc = tySiteBuildings('nyc'), cay = tySiteBuildings('cay'),
          tpe = tySiteBuildings('tpe'), zur = tySiteBuildings('zur');
    const big = tyFloors(200e8), small = tyFloors(2e8);
    return {
      nycC: nyc.map(b => b.c), cayC: cay.map(b => b.c),
      tpeC: tpe.map(b => b.c), zurC: zur.map(b => b.c),
      cayShell: cay.some(b => b.st === 'shell'), cayHold: cay.some(b => b.st === 'hold'),
      earn: tpe.some(b => b.st === 'earn'),
      big, small,
      html: tyBldHTML({ c: 'biz', f: 4, tag: '測試', st: 'pub' }),
      cap: tySiteBuildings('nyc').length <= 5,
    };
  });
  ok(r.nycC.includes('estate'), `紐約買了房地產,那裡就該有一棟琥珀色的:${r.nycC}`);
  ok(r.zurC.includes('gold'), `蘇黎世買了黃金,那裡就該有金色的:${r.zurC}`);
  ok(r.tpeC.includes('biz'), `台北有建設公司,那裡就該有紫色的:${r.tpeC}`);
  ok(r.cayShell && r.cayHold, `開曼有空殼與控股層,兩個狀態都該標出來:${JSON.stringify(r.cayC)}`);
  ok(r.big > r.small, `價值大的要比較高(${r.big} 層 vs ${r.small} 層)`);
  ok(r.big <= 7 && r.small >= 1, '樓層要壓在 1~7 之間,不然最高的那一棟會蓋掉整張地圖');
  ok(/c-biz/.test(r.html) && /f4/.test(r.html) && /st-pub/.test(r.html) && /◈/.test(r.html),
     `建築的 HTML 要帶上類型、樓層與狀態:${r.html}`);
  ok(r.cap, '一個地點最多畫五棟,不然標記會蓋掉半個地球');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國地圖:點單獨一棟積木要開得出它自己的資訊', async (browser) => {
  /* 使用者要的是「點到裡面的積木然後可以顯示他的資訊」。
     所以每一棟建築都要記得自己代表什麼(ref),而且那個 ref 要開得出一張
     只講那一樣東西的卡片 —— 不是整個據點的總表。 */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('heir', 42); TY.cash = 400e8; TY_AMT = 50e8;
    tyBuy('estate', 'nyc'); tyBuy('gold', 'zur');
    tyFound('shell', 'cay'); tySetHoldco('cay');
    tyNext();
    const out = {};
    // 每一棟都要有 ref,而且 ref 要能對回真的東西
    const nyc = tySiteBuildings('nyc'), cay = tySiteBuildings('cay'), tpe = tySiteBuildings('tpe');
    out.refs = [...nyc, ...cay, ...tpe].map(b => b.ref);
    out.allHaveRef = [...nyc, ...cay, ...tpe].every(b => !!b.ref);
    out.htmlHasRef = /data-r="pos:estate"/.test(tyBldHTML(nyc[0]));

    // 點一棟房地產 → 卡片要講數量、成本、未實現獲利、稅
    TY_MODAL = null; tyPickSite('nyc', 'pos:estate');
    out.sel = TY_SEL; out.bld = TY_BLD;
    const card = document.querySelector('.ty-bcard');
    out.cardTxt = card ? card.textContent : '';
    out.cardActs = card ? [...card.querySelectorAll('.ty-b')].map(b => b.textContent.trim()) : [];

    // 點一家公司 → 卡片要換成那家公司的
    tyPickSite('tpe', `biz:${TY.biz.find(b => !TY_BIZ[b.k].shell).id}`);
    out.bizTxt = document.querySelector('.ty-bcard')?.textContent || '';

    // 點控股層
    tyPickSite('cay', 'hold');
    out.holdTxt = document.querySelector('.ty-bcard')?.textContent || '';

    // 同一棟再點一次要收起來
    tyPickSite('cay', 'hold');
    out.closed = TY_BLD;
    // 換國家要把它清掉,不然會殘留在別的地方
    tyPickSite('nyc', 'pos:estate'); tyPickIso('US');
    out.clearedByIso = TY_BLD;
    return out;
  });
  ok(r.allHaveRef, `每一棟建築都要記得自己代表什麼:${JSON.stringify(r.refs)}`);
  ok(r.htmlHasRef, '建築的 HTML 要把 ref 帶出去,不然點下去不知道是誰');
  eq(r.bld, 'pos:estate', '點了房地產,選中的就該是那一筆部位');
  for (const must of ['數量', '市值', '成本', '未實現獲利'])
    ok(r.cardTxt.includes(must), `房地產的卡片少了「${must}」:${r.cardTxt.slice(0, 80)}`);
  ok(r.cardActs.some(t => /再買/.test(t)) && r.cardActs.some(t => /賣出/.test(t)),
     `卡片上要有可以就地做的事:${r.cardActs.join(' / ')}`);
  ok(/投入資本/.test(r.bizTxt) && /估值/.test(r.bizTxt) && /現金流/.test(r.bizTxt),
     `公司的卡片要講投入資本、估值與現金流:${r.bizTxt.slice(0, 80)}`);
  ok(/集團稅率/.test(r.holdTxt) && /關注度/.test(r.holdTxt),
     `控股層的卡片要講稅率與關注度:${r.holdTxt.slice(0, 80)}`);
  eq(r.closed, null, '同一棟再點一次應該要收起來');
  eq(r.clearedByIso, null, '換國家的時候要把點開的那一棟清掉');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

/* =========================================================================
   跑
   ========================================================================= */
const { chromium } = loadPlaywright();
const server = await startServer();
const browser = await chromium.launch({
  headless: !HEADED,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
});

let pass = 0, fail = 0;
const failures = [];
const t0 = Date.now();

for (const t of tests) {
  if (FILTER && !t.name.includes(FILTER)) continue;
  const started = Date.now();
  try {
    await t.fn(browser);
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${t.name} \x1b[90m(${Date.now() - started}ms)\x1b[0m`);
  } catch (e) {
    fail++;
    failures.push({ name: t.name, err: e });
    console.log(`  \x1b[31m✗\x1b[0m ${t.name}`);
    console.log(`      \x1b[31m${String(e.message).split('\n').join('\n      ')}\x1b[0m`);
  }
}

await browser.close();
server.close();

console.log('');
if (fail === 0) {
  console.log(`\x1b[32m全部通過\x1b[0m — ${pass} 個測試 · ${assertions} 個斷言 · ${((Date.now()-t0)/1000).toFixed(1)}s`);
} else {
  console.log(`\x1b[31m${fail} 個失敗\x1b[0m,${pass} 個通過 · ${((Date.now()-t0)/1000).toFixed(1)}s`);
}
process.exit(fail === 0 ? 0 : 1);
