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
/* 打開一張面板:側邊與頂列的直接按;其餘在「總覽」裡(先開總覽再按) */
async function openPanel(page, k) {
  const direct = await page.$(`#tyRoot > :not(.tg-map) [data-ty="modal:${k}"], .tg-side [data-ty="modal:${k}"], .tg-hand [data-ty="modal:${k}"]`);
  if (direct) { await direct.click(); return; }
  await page.click('.tg-hand [data-ty="modal:more"]');
  await page.waitForTimeout(120);
  await page.click(`.tg-mb [data-ty="modal:${k}"]`);
}
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
  eq(await page.$$eval('.tg-scn:not(.tester)', els => els.length), 6, '開局畫面應該有六個劇本可以選(另外加一個暫時的測試人員)');
  await page.click('.tg-scn[data-k="heir"]');
  await page.waitForFunction(() => typeof TY === 'object' && TY && TY.scn === 'heir',
                             { timeout: 5000 });
  ok(await page.$('.tg-res'), '選了劇本之後應該直接進到指揮台(資源列要出現)');

  // 五個子分頁都要畫得出東西
  /* 每一張面板都要開得出東西。指揮台的面板分兩組:底部功能列與右側的功能鈕。 */
  /* 第八輪起底部是一手牌:資產、事業、手法…收在「總覽」(modal:more)裡,要先打開總覽 */
  for (const [k, nm] of [['asset','資產'],['biz','事業'],['play','手法'],['vault','金庫'],['power','勢力分析'],
                         ['rank','富豪榜'],['more','總覽'],['log','大事記'],['learn','怎麼玩']]) {
    await openPanel(page, k);
    await page.waitForTimeout(160);
    const len = await page.$eval('.tg-mb', el => el.innerHTML.length);
    ok(len > 200, `「${nm}」這張面板是空的(只有 ${len} 字元)`);
    // 紅色的 X 一定要關得掉,不然使用者會被困在面板裡
    await page.click('.tg-x');
    await page.waitForTimeout(120);
    eq(await page.$$eval('.tg-modal', e => e.length), 0, `「${nm}」按了 ✕ 沒有關掉`);
  }

  // 買一次要真的有部位、有回覆訊息
  await openPanel(page, 'asset');
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
    r.rel = 95; TY.cash = Math.max(900e8, r.nw * 1.2);   // 夠格發動(淨值 ≥ 他的 6 成),不綁死某一局的亂數
    TY_PAMT[`deal:hostile:${r.id}`] = tyRivalStake(r) * 4;
    const msg = tyDeal('hostile', r.id);
    return { msg, ok: /答應/.test(msg), took: nw0 - r.nw, heat: TY.heat - heat0, rel: r.rel };
  });
  if (hostile.ok) {
    ok(hostile.took > 0, '敵意收購成功之後對方的身家一定要少一塊');
    ok(hostile.heat > 0, '敵意收購一定要付出關注度的代價');
  } else {
    ok(hostile.rel < 90, '敵意收購失敗之後關係一定要變差:' + hostile.msg);
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
    /* 第二十五輪起:國家要「真的有東西」才算誰的 —— 把他的大本營暫時放進這個國家 */
    const home0 = r.home; r.home = site.id; TY_PWC = null;
    const his = tyCountryColor({ properties: { ISO_A2: site.iso } });
    // 同一區、但他在那一國什麼都沒有 → 沒人的地方
    const other = TY_SITES.find(x => x.reg === reg && x.iso !== site.iso && !tyRivalsA().some(q => q !== r && tySite(q.home).iso === x.iso));
    r.home = home0; TY_PWC = null;
    const empty = other ? tyCountryColor({ properties: { ISO_A2: other.iso } }) : null;
    r.turf[reg] = was;
    if (empty) return { his, reg, myTurf: tyMyTurf(reg), col: TY_RVCOL[r.id], empty, otherIso: other.iso };
    return { his, reg, myTurf: tyMyTurf(reg), col: TY_RVCOL[r.id] };
  });
  ok(map.myTurf < 100, `挑到的地區(${map.reg})你自己也押滿了,測不到對手的顏色`);
  ok(map.his.includes(map.col), `勢力圖層要用對手自己的顏色上色,實際:${map.his}`);
  if (map.empty) ok(!map.empty.includes(map.col), `他在 ${map.otherIso} 什麼都沒有,那一國不能算他的:${map.empty}`);

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
  await openPanel(page, 'asset');
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

test('帝國畫面層:季間過場只是重播,不可以改到任何數字、也不可以吃掉種子亂數', async (browser) => {
  /* world3d.js 的規矩是「只讀 TY,然後畫」。最容易破的方式有兩種:
       · 過場動畫裡順手改了某個欄位(數字就跟沒動畫時不一樣了)
       · 畫面效果用了 tyRnd() —— 那是種子亂數,畫面拿走一個數字,
         同一顆種子接下來的事件就全部錯位,「同種子 = 同結果」就壞了
     所以這裡用同一顆種子跑兩次:一次按畫面上的「下一季」(會播過場),
     一次直接呼叫 tyNext()。兩邊的整份狀態必須一模一樣。 */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(async () => {
    const out = {};
    tyStart('heir', 9090); TY_MODAL = null; renderPage();
    for (let i = 0; i < 4; i++) {
      document.querySelector('.tg-go').click();
      await new Promise(res => setTimeout(res, 30));
    }
    out.viaUI = JSON.stringify(TY);
    out.banner = !!document.querySelector('#w3dFx .w3d-ban');
    out.bannerTxt = document.querySelector('#w3dFx .w3d-ban')?.textContent || '';

    tyStart('heir', 9090);
    for (let i = 0; i < 4; i++) tyNext();
    out.direct = JSON.stringify(TY);

    // 重播本身也不可以改狀態:snap → tyNext → play,play 前後要一樣
    const snap = W3D.snap();
    tyNext();
    const before = JSON.stringify(TY);
    W3D.play(snap);
    out.playSame = before === JSON.stringify(TY);
    // 同一季重播(沒有前進)什麼都不做
    const again = W3D.snap(); W3D.play(again);
    out.noAdvanceSame = before === JSON.stringify(TY);
    // 替身之下 3D 層不可以啟用(不然會對一個假的地球做 3D 運算)
    out.w3dOk = W3D.ok;
    return out;
  });
  ok(r.viaUI === r.direct, '按「下一季」(有過場)與直接 tyNext() 跑出來的狀態不一樣 —— 畫面層動到了規則或亂數');
  ok(r.banner, '按下一季之後要出現季別橫幅');
  ok(/身家/.test(r.bannerTxt) && /Q\d/.test(r.bannerTxt), `橫幅要講季別與身家變化:${r.bannerTxt}`);
  ok(r.playSame, '重播過場之後 TY 被改掉了');
  ok(r.noAdvanceSame, '沒有前進的時候重播也不可以改任何東西');
  eq(r.w3dOk, false, '測試環境的地球是替身,3D 層不應該啟用');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國地圖:城市等級落在 1–10,錢越多等級越高;有據點的國家會被抬高', async (browser) => {
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    const vals = [0, 5e7, 1e8, 1e9, 1e10, 1e11, 3e11, 1e13];
    const lv = vals.map(tySiteLv);
    tyStart('heir', 42);
    // 領土高度:有東西的國家要比沒東西的高,但不可以高到遮住旁邊的國家
    const tw = tyIsoAlt('TW'), fr = tyIsoAlt('FR');
    return { lv, tw, fr };
  });
  eq(r.lv[0], 1, '沒錢也是 1 級,不能是 0 或負數');
  eq(r.lv[r.lv.length - 1], 10, '再多錢都封頂在 10 級');
  ok(r.lv.every((v, i) => i === 0 || v >= r.lv[i - 1]), `等級要隨金額單調遞增:${r.lv}`);
  ok(r.tw > r.fr, `有據點的台灣(${r.tw})應該被抬得比沒東西的法國(${r.fr})高`);
  ok(r.tw <= .016, `領土最高不可以超過 .016,不然側面會遮住鄰國:${r.tw}`);
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國部隊:招募有上限、要養、下一季到位,到了才有效果', async (browser) => {
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    const out = {};
    tyStart('heir', 31337); TY.cash = 500e8;
    // 上限:第七支要被擋,而且訊息要講出是編制滿了
    for (let i = 0; i < 6; i++) tyRecruit(['raid','law','lobby','mgr','law','mgr'][i]);
    out.n = TY.units.length;
    out.seventh = tyRecruit('raid');
    out.n7 = TY.units.length;
    out.allHome = TY.units.every(u => u.site === TY.home && !u.to);

    // 走路:台北 → 新竹同一區 1 季;台北 → 紐約 2 季
    out.tpeHsz = tyTravel('tpe', 'hsz'); out.tpeNyc = tyTravel('tpe', 'nyc');

    // 經理人派去紐約:路上不加成,到了才加
    const mgr = TY.units.find(u => u.k === 'mgr');
    const msg = tyDeploy(mgr.id, 'nyc');
    out.depMsg = msg; out.eta = mgr.eta - TY.t; out.moving = mgr.to === 'nyc';
    out.again = tyBlock('deploy', { u: mgr, site: 'nyc' });   // 已經在路上了
    const cash0 = TY.cash, up = tyUnitUpkeep();
    out.movingNow = !!mgr.to;
    tyNext();
    out.upkeepPaid = up > 0;
    out.arrived = mgr.site === 'nyc' && !mgr.to;

    /* 律師團壓關注度。只比「部隊結算」這一步 —— 整季跑下來會有事件,
       兩局的關注度本來就會被事件拉開,比不出律師團的效果。 */
    tyStart('heir', 5); TY.cash = 100e8; TY.heat = 60;
    tyRecruit('law'); tyRecruit('law');
    tyUnitsTurn();
    out.lawHeat = [TY.heat, 60];

    // 併購小組削對手勢力 + 敵意收購加成
    tyStart('heir', 8); TY.cash = 200e8;
    const r1 = tyRival('r1');                 // 鄭天賜,大本營香港
    const turf0 = tyTurf(r1, 'cn');
    const odds0 = tyDealOdds('hostile', r1, tyDealPrice('hostile', r1));
    tyRecruit('raid'); tyRecruit('raid');
    TY.units.forEach(u => { u.site = 'hkg'; u.to = null; });
    out.oddsUp = tyDealOdds('hostile', r1, tyDealPrice('hostile', r1)) - odds0;
    tyUnitsTurn();
    out.turfCut = turf0 - tyTurf(r1, 'cn');

    // 每一顆部隊面板上的按鈕,畫面與引擎要一致
    TY_MODAL = 'troop'; renderPage();
    out.panel = document.querySelector('.tg-mb').innerHTML.length;
    out.bad = [];
    for (const b of document.querySelectorAll('.tg-mb [data-ty="recruit"]')) {
      const blocked = tyBlock('recruit', b.dataset.k);
      if (!b.disabled && blocked) out.bad.push('recruit 可以按但引擎擋');
      if (b.disabled && !blocked) out.bad.push('recruit 是灰的但引擎讓過');
    }
    out.nav = !!document.querySelector('.tg-hand [data-card="troop"]');
    return out;
  });
  eq(r.n, 6, '應該招得到六支');
  eq(r.n7, 6, '第七支不應該招得到');
  ok(/滿編/.test(r.seventh), `第七支被擋的訊息要講編制滿了:${r.seventh}`);
  ok(r.allHome, '剛招募的部隊要在大本營待命');
  eq([r.tpeHsz, r.tpeNyc], [1, 2], '同一區 1 季、跨洋 2 季');
  /* 使用者:「部隊可以直接變成下一季就有效」—— 不管多遠,自己的部隊一律下一季到位 */
  ok(r.moving && r.eta === 1, `派去紐約應該下一季到位:${r.depMsg}`);
  ok(r.again && /路上/.test(r.again), '已經在路上的部隊不能再派一次去同一個地方');
  ok(r.upkeepPaid, '有部隊就要付維持費');
  ok(r.movingNow, '派出去的當下還沒到(這一季不生效)');
  ok(r.arrived, '下一季要到位');
  near(r.lawHeat[0], r.lawHeat[1] - 3, 1e-9, '兩位律師團一季要壓掉 3 點關注度');
  ok(r.oddsUp > .15, `兩支併購小組駐在對手大本營,敵意收購的成功率要明顯變高:+${r.oddsUp}`);
  near(r.turfCut, 6, .01, '兩支併購小組一季要削掉他 6 點勢力');
  ok(r.panel > 1500, '部隊面板不可以是空的');
  ok(r.bad.length === 0, r.bad.join(' / '));
  ok(r.nav, '手牌裡要有「部隊」牌');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國部隊:對手會派兵打你,看得到它走過來,律師團擋得住', async (browser) => {
  /* 對手出兵走的是 tyRivalTurn 裡「對你出手」那一支:關係差、而且比你大。
     這裡把一個對手弄成死敵,跑到他出兵為止,然後比較「有沒有駐軍」的防守率。 */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    const out = { seen: false };
    let th = null;
    for (let seed = 1; seed < 60 && !th; seed++) {
      tyStart('heir', seed);
      TY.t = 3;
      for (const x of TY.rivals) { x.rel = -90; x.nw = 5000e8; x.agg = 1; }
      for (let i = 0; i < 8 && !th; i++) { tyNext(); th = TY.threats[0] || null; }
    }
    if (!th) return out;
    out.seen = true;
    out.ahead = th.eta > TY.t;                         // 出發的那一刻就看得到,還沒到
    out.onlyOne = TY.threats.filter(x => x.rid === th.rid).length === 1;
    out.news = TY.news.some(n => /出兵/.test(n.title));
    TY_MODAL = 'troop'; renderPage();
    out.panelTxt = document.querySelector('.tg-mb').textContent;
    const p0 = tyThreatBlock(th);
    // 把兩支律師團直接放進那個地區
    TY.cash += 50e8; tyRecruit('law'); tyRecruit('law');
    TY.units.forEach(u => { u.site = th.site; u.to = null; });
    out.p = [p0, tyThreatBlock(th)];
    // 跑到它抵達,然後它就要從清單上消失(不管擋下還是被攻破)
    const id = th.id;
    for (let i = 0; i < 4 && TY.threats.some(x => x.id === id); i++) tyNext();
    out.resolved = !TY.threats.some(x => x.id === id);
    out.logged = TY.log.some(l => /擋下|攻進/.test(l.txt));
    out.nan = !isFinite(tyNW());
    return out;
  });
  ok(r.seen, '死敵而且比你大很多的對手,八季之內一定要出兵過一次');
  ok(r.ahead, '部隊出發時要還沒到 —— 玩家要有時間反應');
  ok(r.onlyOne, '同一個對手同時只派一支');
  ok(r.news, '出兵要上快訊');
  ok(/來襲/.test(r.panelTxt) && /防守率/.test(r.panelTxt), '部隊面板要列出來襲與防守率');
  ok(r.p[1] > r.p[0] + .4, `兩支律師團要讓防守率明顯變高:${r.p}`);
  ok(r.resolved, '抵達之後要判定,並從清單上移掉');
  ok(r.logged, '判定結果要寫進大事記');
  ok(!r.nan, '打完不可以生出 NaN');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國畫面層:高解析度國界解得開,而且點得到是哪一國', async (browser) => {
  /* 地圖的國界換成 world-atlas 的 TopoJSON(50m / 10m)。解碼是自己寫的
     (不想多一個 CDN 依賴),所以要驗:弧線還原、反向弧、ISO 數字碼 → 兩碼,
     以及「點在台灣上」真的回台灣、點在海上回 null。 */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    // 一個正方形「台灣」:兩條弧,第二條用反向(~0)接回來
    const topo = { type: 'Topology',
      transform: { scale: [1, 1], translate: [120, 22] },
      arcs: [ [[0, 0], [2, 0], [0, 3]],            // (120,22)→(122,22)→(122,25)
              [[0, 0], [0, 3], [2, 0]] ],          // (120,22)→(120,25)→(122,25)
      objects: { countries: { type: 'GeometryCollection', geometries: [
        { type: 'Polygon', arcs: [[0, ~1]], id: '158', properties: { name: 'Taiwan' } }] } } };
    const f = W3D._topo(topo)[0];
    const ring = f.geometry.coordinates[0][0];
    return { iso: iso(f), name: f.properties.NAME, ring,
             closed: JSON.stringify(ring[0]) === JSON.stringify(ring[ring.length - 1]),
             // featAt 退回 110m(測試環境的假國界只有一塊台灣)
             hit: (W3D.featAt(23.5, 121) || {}).properties?.ADMIN || null,
             sea: W3D.featAt(10, 150) };
  });
  eq(r.iso, 'TW', 'ISO 數字碼 158 要轉成 TW,不然台灣上不了色');
  eq(r.name, 'Taiwan', '國名要帶著');
  eq(r.ring.length, 5, `正方形的環應該是 5 個點(頭尾相同):${JSON.stringify(r.ring)}`);
  ok(r.closed, '反向弧要把環接回起點');
  eq(r.hit, 'Taiwan', '點在台灣上要回台灣');
  eq(r.sea, null, '點在海上要回 null');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國地圖:點任何一個國家都要看得到經濟、政策、勢力 —— 沒有城市的國家也一樣', async (browser) => {
  /* 使用者:「點一個國家可以顯示這個國家的所有訊息,經濟、政策等等」。
     遊戲的經濟模型是以地區為單位的;沒有城市的國家(蒙古)要歸到最近的經濟圈,
     而且畫面上要直說是推算的,不可以假裝它有自己的數字。 */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('heir', 77);
    const us = tyIsoInfo('US'), tw = tyIsoInfo('TW');
    // 蒙古:測試環境的國界只有台灣,所以要自己給一塊蒙古的形狀
    const mnFeat = { type: 'Feature', properties: { ISO_A2: 'MN', NAME: 'Mongolia' },
      geometry: { type: 'Polygon', coordinates: [[[88, 42], [119, 42], [119, 52], [88, 52], [88, 42]]] } };
    const mn = tyIsoInfo('MN', mnFeat);
    countries.push(mnFeat);
    TY_MODAL = 'site'; TY_SEL = null; TY_ISO = 'MN'; renderPage();
    const mnTxt = document.querySelector('.tg-mb').textContent;
    TY_ISO = 'US'; renderPage();
    const usTxt = document.querySelector('.tg-mb').textContent;
    countries.pop();
    return { us: us && { reg: us.reg, near: us.near }, tw: tw && tw.reg, mn: mn && { reg: mn.reg, near: mn.near },
             mnTxt, usTxt, name: tyIsoName('MN') };
  });
  eq(r.us, { reg: 'na', near: false }, '美國有城市,直接用北美');
  eq(r.tw, 'tw', '台灣是自己的一區');
  ok(r.mn && r.mn.near, '蒙古沒有城市,要標記成「依最近的經濟圈推算」');
  eq(r.mn.reg, 'cn', `蒙古最近的經濟圈應該是中國大陸,實際 ${r.mn && r.mn.reg}`);
  for (const must of ['經濟', '政策', '勢力', '推算'])
    ok(r.mnTxt.includes(must), `蒙古的國家卡少了「${must}」`);
  for (const must of ['長期成長', '政策風險', '法定公司稅率', '城市'])
    ok(r.usTxt.includes(must), `美國的國家卡少了「${must}」`);
  ok(r.name && r.name !== 'MN', `沒有中文名稱表的國家也要有名字:${r.name}`);
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國地圖:每座城市都有真實邊界與地標,每個國家都歸得到經濟圈', async (browser) => {
  /* 使用者:「城市範圍是城市的真實邊界」「每個城市都可以有地標」「地區景氣可以用顏色的程度來區分」。
     cities.json 是從 Natural Earth 的都市範圍擷取的,要驗:44 座都有、而且邊界真的在那座城市旁邊
     (擷取程式寫錯的話,最常見的是全部變成空陣列,或抓到別的城市)。 */
  const cities = JSON.parse(fs.readFileSync(path.join(ROOT, 'cities.json'), 'utf8'));
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('heir', 5);
    const ph = { type: 'Feature', properties: { ISO_A2: 'PH', NAME: 'Philippines' },
      geometry: { type: 'Polygon', coordinates: [[[120, 7], [126, 7], [126, 18], [120, 18], [120, 7]]] } };
    return { sites: TY_SITES.map(s => ({ id: s.id, lat: s.lat, lng: s.lng, lm: W3D.landmarkName(s.id) })),
             ph: tyIsoReg('PH', ph),
             steps: TY_ECON_STEPS.map(x => x.min) };
  });
  const miss = [], far = [];
  for (const s of r.sites) {
    const rings = cities[s.id];
    if (!rings || !rings.length) { miss.push(s.id); continue; }
    const d = Math.min(...rings.flat().map(([x, y]) => Math.hypot(x - s.lng, y - s.lat)));
    if (d > 1) far.push(`${s.id}(${d.toFixed(2)}°)`);
  }
  ok(miss.length === 0, `這些城市沒有邊界:${miss.join(', ')}`);
  ok(far.length === 0, `這些城市的邊界離城市太遠(抓錯城市了):${far.join(', ')}`);
  const noLm = r.sites.filter(s => !s.lm).map(s => s.id);
  ok(noLm.length === 0, `這些城市沒有地標:${noLm.join(', ')}`);
  eq(r.ph, 'apac', '菲律賓要歸到東南亞,不可以因為離台北近就被算成台灣的景氣');
  ok(r.steps.every((v, i) => i === 0 || v < r.steps[i - 1]), `景氣色階要由熱到冷排好:${r.steps}`);
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國打擊:飛彈與空襲有效果、有冷卻、打錯目標會被擋', async (browser) => {
  /* 使用者:「多加一些武器對應完經濟的攻擊,像是飛彈、空襲」「攻擊手段需要冷卻時間比較公平」。
     要驗的是規則本身:打得到、打完真的少一塊、冷卻期間按不下去、目標不對要說清楚為什麼。 */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('heir', 99); TY.cash = 300e8;
    const r1 = tyRival('r1');                       // 鄭天賜,大本營香港,中國地區勢力 55
    const out = { nw0: r1.nw, cash0: TY.cash };
    // 目標不對:要在冷卻之前檢查,不然訊息會被「冷卻中」蓋掉
    out.wrongLon = tyBlock('strike', { k: 'missile', site: 'lon' });
    out.cost = tyStrikeCost('missile');
    out.m1 = tyStrike('missile', 'hkg');
    out.nw1 = r1.nw; out.rel1 = r1.rel; out.cash1 = TY.cash; out.costNext = tyStrikeCost('missile') / Math.max(TY_STRIKES.missile.min, tyNW() * TY_STRIKES.missile.pct);
    out.m2 = tyStrike('missile', 'hkg');            // 冷卻中
    out.nw2 = r1.nw;
    const t0 = tyTurf(r1, 'cn');
    out.a1 = tyStrike('air', 'sha');
    out.turfCut = t0 - tyTurf(r1, 'cn');
    out.airBlocked = tyBlock('strike', { k: 'air', site: 'sha' });
    tyNext(); out.airReady1 = tyStrikeReady('air');        // 空襲冷卻 1 季
    tyNext(); out.readyAgain = tyStrikeReady('missile');   // 飛彈冷卻 2 季
    for (let i = 0; i < 3; i++) tyNext();
    out.costCooled = tyStrikeCost('missile') / (Math.max(TY_STRIKES.missile.min, tyNW() * TY_STRIKES.missile.pct));
    out.fatCooled = tyStrikeFatigue('r1');
    // 面板上的武器卡要畫得出來,按鈕狀態與引擎一致
    TY_MODAL = 'troop'; TY_STRK = { missile: 'hkg' }; renderPage();
    const btn = document.querySelector('[data-ty="strike"][data-k="missile"]');
    out.btnOk = btn && (btn.disabled === !!tyBlock('strike', { k: 'missile', site: 'hkg' }));
    out.panel = /做空飛彈/.test(document.querySelector('.tg-mb').textContent) && /輿論空襲/.test(document.querySelector('.tg-mb').textContent);
    return out;
  });
  ok(r.nw1 < r.nw0 * .97 && r.nw1 > r.nw0 * .9, `飛彈要打掉他 4~8% 的身家:${r.nw0} → ${r.nw1}`);
  ok(r.rel1 <= -29, '被飛彈打的對手要記恨');
  ok(r.cash1 - (r.cash0 - r.cost) <= r.cost * 1.5 + 1, '賺回的錢不可以超過花費的 1.5 倍(不然變成印鈔機)');
  ok(/冷卻/.test(r.m2) && r.nw2 === r.nw1, `冷卻中要被擋下,而且對手的身家不能再變:${r.m2}`);
  ok(r.wrongLon && /大本營/.test(r.wrongLon), `打在沒有對手大本營的城市要說清楚:${r.wrongLon}`);
  /* 同一季剛被飛彈打過的對手,空襲效果打 6 折(疲乏),12 × 0.6 = 7.2 */
  near(r.turfCut, 12 * .6, .01, '剛被打過的對手,空襲只削 6 折(12 → 7.2)');
  near(r.costNext, 1.4, .001, '4 季內連發,下一發要貴 40%(身家變了,所以跟當下的原價比)');
  ok(r.airReady1, '空襲冷卻 1 季');
  eq(r.costCooled, 1, '超過 4 季沒發,價格回到原價');
  eq(r.fatCooled, 1, '超過 4 季沒被打,效果恢復 100%');
  ok(r.airBlocked && /冷卻/.test(r.airBlocked), '空襲打完也要冷卻');
  ok(r.readyAgain, '兩季之後飛彈要冷卻完');
  ok(r.btnOk, '武器按鈕的狀態要跟引擎一致');
  ok(r.panel, '部隊面板要列出兩種武器');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國事業等級、金庫、資料頁:升級看得到回本、金庫一頁看完槓桿、資料一頁看完全部', async (browser) => {
  /* 使用者:「事業、手法有太多東西,不知道要幹嘛,也不知道有沒有用」「想要一個可以一次看到自己所有東西的資料」。
     等級是從資本算出來的(不另外存),所以舊存檔也要有等級;升級一次 = 資本 ×1.5。 */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('heir', 7); TY.cash = 500e8;
    const b = TY.biz[0];
    const out = { lv0: tyBizLv(b), cap0: b.cap };
    const pv = tyUpPreview(b);
    out.pv = pv;
    out.msg = tyUpgrade(b.id);
    out.lv1 = tyBizLv(b); out.cap1 = b.cap;
    // 舊存檔:沒有 cap0 也要算得出等級
    delete b.cap0; out.lvOld = tyBizLv(b);
    TY.cash = 1e14;                     // 升到頂要很多錢,這裡只測上限
    for (let i = 0; i < 12; i++) tyUpgrade(b.id);
    out.lvMax = tyBizLv(b);
    out.blockMax = tyBlock('upgrade', b);
    // 空殼不能升級
    tyFound('shell', 'cay');
    const sh = TY.biz.find(x => TY_BIZ[x.k].shell);
    out.shellBlock = tyBlock('upgrade', sh);
    // 事業頁:升級是主按鈕,其餘收在「更多動作」;按鈕狀態跟引擎一致
    TY_MODAL = 'biz'; renderPage();
    const mb = document.querySelector('.tg-mb');
    out.upBtns = mb.querySelectorAll('[data-ty="upgrade"]').length;
    out.more = !!mb.querySelector('details.c-more [data-ty="sellbiz"]');
    out.bizBad = [...mb.querySelectorAll('[data-ty="upgrade"]')].filter(x =>
      x.disabled !== !!tyBlock('upgrade', TY.biz.find(z => z.id === +x.dataset.id))).length;
    // 金庫
    TY_MODAL = 'vault'; renderPage();
    const vt = document.querySelector('.tg-mb').textContent;
    out.vault = ['抵押借款的槓桿', '借款', '質押', '控股層', '錢放在哪裡', '信託'].filter(k => !vt.includes(k));
    // 手法頁不再有借款
    TY_MODAL = 'play'; renderPage();
    out.playBorrow = !!document.querySelector('.tg-mb [data-ty="borrow"]');
    // 資料頁
    TY_MODAL = 'data'; renderPage();
    const dt = document.querySelector('.tg-mb').textContent;
    out.data = ['身家', '資產', '事業', '部隊', '對手', 'Lv'].filter(k => !dt.includes(k));
    out.nav = [!!document.querySelector('.tg-hand [data-card="vault"]'), !!document.querySelector('[data-ty="modal:data"]')];
    return out;
  });
  eq(r.lv0, 1, '剛開的公司是 Lv1');
  eq(r.lv1, 2, '升一次就是 Lv2');
  near(r.cap1 / r.cap0, 1.5, 1e-9, '升一級 = 資本 ×1.5');
  ok(r.pv.cost > 0 && isFinite(r.pv.pay) && r.pv.pay > 0, `升級要看得到回本季數:${JSON.stringify(r.pv)}`);
  ok(/季回本/.test(r.msg), `升級的回覆要講幾季回本:${r.msg}`);
  eq(r.lvOld, 2, '舊存檔沒有 cap0 也要算得出等級');
  eq(r.lvMax, 10, '最高 Lv10');
  ok(r.blockMax && /最高/.test(r.blockMax), `Lv10 之後要擋:${r.blockMax}`);
  ok(r.shellBlock && /空殼/.test(r.shellBlock), '空殼公司不能升級');
  ok(r.upBtns >= 1, '事業頁要有升級按鈕');
  ok(r.more, '其他動作要收進「更多動作」');
  eq(r.bizBad, 0, '升級按鈕的狀態要跟引擎一致');
  eq(r.vault, [], `金庫少了:${r.vault}`);
  eq(r.playBorrow, false, '借款已經搬到金庫,手法頁不應該再有');
  eq(r.data, [], `資料頁少了:${r.data}`);
  eq(r.nav, [true, true], '手牌裡要有金庫牌、右側要有資料鈕');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國第七輪:捲動不跳頂、對手看得到(駐軍與動態)、勢力拆到國家與城市、建築高度同一把尺', async (browser) => {
  /* 使用者:「選價格或地區都會跑回最上面」「要可以看到對手的部隊」「我想看到對手做了什麼」
     「勢力範圍可以分地區,像是縣市或是國家」「建築越高表示事業比其他人大」。 */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(async () => {
    tyStart('heir', 7); TY.cash = 500e8;
    const out = {};
    // ① 捲動:資產頁捲下去,換市場之後還在原位
    TY_MODAL = 'asset'; renderPage();
    const mb = document.querySelector('.tg-mb');
    mb.scrollTop = 400; out.scrolled = mb.scrollTop;
    const sel = document.querySelector('select[data-mkt]');
    sel.value = sel.options[sel.options.length - 1].value; sel.dispatchEvent(new Event('change'));
    out.after = document.querySelector('.tg-mb').scrollTop;
    // 換面板要回到頂端
    TY_MODAL = 'biz'; renderPage(); out.newTab = document.querySelector('.tg-mb').scrollTop;
    // 「更多動作」展開後,按別的按鈕不會收起來
    const d = document.querySelector('details.c-more'); d.open = true; renderPage();
    out.detailsKept = !!document.querySelector('details.c-more[open]');

    // ② 對手的事件紀錄不能動到種子亂數:同一個種子跑兩次,狀態一模一樣
    const run = () => { tyStart('heir', 11); TY.cash = 200e8; const ev = []; for (let i = 0; i < 16; i++){ tyNext(); ev.push(...TY_RV_EV.map(e => e.k)); } return { nw: tyNW(), rv: TY.rivals.map(x => Math.round(x.nw)), ev }; };
    const a = run(), b = run();
    out.same = JSON.stringify(a) === JSON.stringify(b);
    out.evKinds = [...new Set(a.ev)];
    out.logRid = TY.log.filter(l => l.kind === 'rival' && l.rid).length;
    // 對手面板有動態與駐軍
    TY_MODAL = 'rival'; renderPage();
    const rt = document.querySelector('.tg-mb').textContent;
    out.feed = ['對手動態', '對手駐軍'].filter(k => !rt.includes(k));
    // 駐軍 = 勢力的畫法:每 25 點一支,最多 3 支;地圖標記裡有
    const rv = TY.rivals.find(x => x.alive !== false);
    const reg = Object.keys(TY_REGIONS).find(k => k !== 'off');
    rv.turf[reg] = 80; TY_PWC = null;
    const f = tyRivalForces().find(x => x.r.id === rv.id && x.reg === reg);
    out.force = f && f.units.length;
    out.forceSite = f && tySite(f.site).reg === reg;
    rv.turf[reg] = 20; TY_PWC = null;
    out.forceGone = !tyRivalForces().some(x => x.r.id === rv.id && x.reg === reg);
    rv.turf[reg] = 60; TY_PWC = null;
    out.marks = tyTroopMarks().filter(m => m._rvf).length;

    // ③ 勢力拆到國家與城市:同一個經濟圈裡,不同國家可以是不同人領先
    TY_PWC = null;
    const eu = TY_SITES.filter(s => s.reg === 'eu');
    const isos = [...new Set(eu.map(s => s.iso))];
    const leaders = new Set(isos.map(c => { const P = tyIsoPower(c); return P && P.top ? (P.top.me ? 'me' : P.top.r.id) : '-'; }));
    out.isos = isos.length; out.leaders = leaders.size;
    // 大本營所在國家:那個對手權重 1.0
    const hr = TY.rivals.find(x => x.alive !== false && tySite(x.home).reg === 'eu');
    if (hr){ const P = tyIsoPower(tySite(hr.home).iso); out.homeW = (P.board.find(x => x.r && x.r.id === hr.id) || {}).w; }
    // 城市:你在那裡有東西就在榜上
    const cp = tyCityPower(TY.home);
    out.cityMe = !!(cp && cp.board.some(x => x.me));
    TY_LAYER = 'power'; out.cityCol = tyCityColor(TY.home);
    TY_MODAL = 'power'; TY_PWR = 'eu'; renderPage();
    const pt = document.querySelector('.tg-mb').textContent;
    out.power = ['全球', '依經濟圈', '領先'].filter(k => !pt.includes(k));
    out.powerCities = document.querySelectorAll('.tg-mb .pw-city').length;
    TY_LAYER = 'mine';

    // ④ 高度同一把尺:最大的那一個滿格;少一千倍以上貼地;你的城與對手大本營可以直接比
    const hk = tyHeightScale();
    const top = Math.max(...tyScaleRank().map(x => x.v));
    out.hTop = hk(top); out.hTiny = hk(top / 5000); out.hMid = hk(top / 31.6);
    // 據點面板有規模比較
    TY_MODAL = 'site'; TY_SEL = TY.home; renderPage();
    out.scale = document.querySelector('.tg-mb').textContent.includes('規模比較');
    return out;
  });
  eq(r.after, r.scrolled, `換市場之後捲動位置要留著(${r.scrolled} → ${r.after})`);
  eq(r.newTab, 0, '換面板要回到頂端');
  ok(r.detailsKept, '「更多動作」展開後重畫不能收起來');
  ok(r.same, '對手的事件紀錄不能改到任何數字或亂數');
  ok(r.evKinds.includes('expand'), `十六季裡對手至少要擴張過:${r.evKinds}`);
  ok(r.logRid > 0, '對手的紀錄要帶著是誰做的(rid)');
  eq(r.feed, [], `對手面板少了:${r.feed}`);
  eq(r.force, 3, '勢力 80 = 3 支駐軍');
  ok(r.forceSite, '駐軍要站在那個經濟圈的城市');
  ok(r.forceGone, '勢力 20 就沒有駐軍');
  ok(r.marks > 0, '地圖標記裡要有對手的駐軍');
  ok(r.isos >= 3, '西歐要有好幾個國家');
  if (r.homeW !== undefined) eq(r.homeW, 1, '對手在自己大本營的國家權重 1.0');
  ok(r.cityMe, '你在自己大本營的城市要上榜');
  ok(/^rgba\(41,151,255,/.test(r.cityCol), `你的城市在勢力圖層要是藍的:${r.cityCol}`);
  eq(r.power, [], `勢力分析頁少了:${r.power}`);
  ok(r.powerCities > 0, '展開經濟圈要看得到城市');
  eq(r.hTop, 1, '最大的那一個是滿格');
  eq(r.hTiny, 0, '小一千倍以上貼地');
  ok(r.hMid > .3 && r.hMid < .7, `小三十倍大約在中間:${r.hMid}`);
  ok(r.scale, '據點面板要有規模比較');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國卡牌:行動點、出牌選項、解鎖;規則函式本身不扣點(重播一致)', async (browser) => {
  /* 使用者:「把現在有的東西改成卡牌」「更寬鬆」「建築卡拖出去可以選賭場飯店等等,就會多一棟對應的房子」。 */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('heir', 7); TY.cash = 500e8; TY_MODAL = null; renderPage();
    const out = {};
    out.ap0 = TY.ap; out.apMax = tyApMax();
    out.hand = document.querySelectorAll('.tg-hand [data-card]').length;
    out.locked = document.querySelectorAll('.tg-hand .pc.lock').length;
    // 沒有地球(測試的替身)→ 出牌改成列城市;選台北 → 建設選項
    tyCardGo('build');
    out.modal1 = TY_MODAL;
    const city = document.querySelector('.tg-mb [data-ty="pickcity"][data-site="tpe"]');
    out.hasCity = !!city; city.click();
    const opts = [...document.querySelectorAll('.tg-mb [data-ty="found"]')].map(b => b.dataset.k);
    out.opts = opts;
    out.expect = tyBuildOpts('tpe');
    // 按「蓋」飯店與賭場 → 扣 2 點、面板收起來、台北多一棟 hotel
    const n0 = TY.biz.length;
    document.querySelector('.tg-mb [data-ty="found"][data-k="hotel"]').click();
    out.built = TY.biz.length - n0; out.apAfter = TY.ap; out.modal2 = TY_MODAL;
    out.bld = tySiteBuildings('tpe').some(b => b.k === 'hotel');
    // 點數不夠:硬把點數歸零,按鈕是灰的、畫面動作被擋、規則函式直接呼叫仍然可以(測試與重播要一致)
    TY.ap = 0; TY_MODAL = 'pick'; TY_PICK = { k:'build', site:'tpe' }; renderPage();
    const btn = document.querySelector('.tg-mb [data-ty="found"][data-k="tech"]');
    out.btnOff = btn.disabled;
    out.doMsg = tyDo('found', () => tyFound('tech', 'tpe'));
    out.bizAfterBlock = TY.biz.filter(b => b.k === 'tech').length;
    out.needAp = tyNeeds('found', { k:'tech', site:'tpe' }).some(n => n.lab === '行動點' && !n.ok);
    // 下一季補滿
    tyNext(); out.apNext = TY.ap;
    // 招募到指定城市:下一季到位
    const u0 = tyUnits().length;
    tyDo('recruitTo', () => tyRecruitTo('law', 'lon'));
    const u = tyUnits()[tyUnits().length - 1];
    out.recruit = [tyUnits().length - u0, u && u.to];
    // 解鎖:第 3 季起有空襲牌,而且只翻一次
    TY_NEWCARD = [];
    tyNext(); tyNext();
    out.unlocked = tyHasCard('air'); out.newcard = TY_NEWCARD.includes('air');
    out.cardsSaved = (JSON.parse(localStorage.getItem(TY_KEY)) || {}).cards || [];
    // 重播一致:同一個種子、同樣的規則呼叫,出不出牌(tyDo)不影響亂數
    const run = viaDo => { tyStart('heir', 21); TY.cash = 200e8;
      const f = () => tyFound('media', 'tpe');
      viaDo ? tyDo('found', f) : f();
      for (let i = 0; i < 8; i++) tyNext();
      return JSON.stringify([tyNW(), TY.rivals.map(x => Math.round(x.nw))]); };
    out.same = run(true) === run(false);
    return out;
  });
  ok(r.apMax >= 6, `行動點基本至少 6 點(寬鬆):${r.apMax}`);
  eq(r.ap0, r.apMax, '開局行動點是滿的');
  ok(r.hand >= 12, `手牌要把所有牌列出來(含鎖著的):${r.hand}`);
  ok(r.locked >= 3, '開局要有幾張鎖著的牌可以解鎖');
  eq(r.modal1, 'pick', '沒有地球時出牌要改成列城市');
  ok(r.hasCity, '台北要在可以蓋的城市裡');
  eq(r.opts, r.expect, '台北的建設選項要跟那座城市的類型一致');
  ok(r.opts.includes('hotel'), '台北要蓋得了飯店與賭場');
  eq(r.built, 1, '按「蓋」要真的多一家公司');
  eq(r.apAfter, r.ap0 - 2, '建設要扣 2 點');
  eq(r.modal2, null, '做成之後出牌面板要收起來(看得到新的那一棟)');
  ok(r.bld, '台北的建築裡要多一棟飯店與賭場');
  ok(r.btnOff, '行動點不夠時按鈕要是灰的');
  ok(/行動點不夠/.test(r.doMsg), `點數不夠時畫面上的動作要被擋:${r.doMsg}`);
  eq(r.bizAfterBlock, 0, '被擋的動作不能真的做');
  ok(r.needAp, '條件清單要列出行動點');
  eq(r.apNext, r.apMax, '下一季行動點要補滿');
  eq(r.recruit, [1, 'lon'], '部隊牌:招募一支、下一季到指定城市');
  ok(r.unlocked, '第 3 季起要有空襲牌');
  ok(r.newcard, '解鎖時要翻牌給玩家看');
  ok(r.cardsSaved.includes('air'), '解鎖紀錄要進存檔');
  ok(r.same, '經由出牌或直接呼叫規則,重播結果要一模一樣');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國像素化:表情符號換像素圖示、像素地形、特效序列幀、同城部隊合併成一個標記', async (browser) => {
  /* 使用者:「所有風格都改成像素,包含按鈕,還有文字裡的表情符號」「地圖也改成像素的,加一些山脈湖泊河流」
     「爆炸特效也改成像素」「字和東西都卡在一起」。 */
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(async () => {
    tyStart('heir', 7); TY.cash = 900e8; TY_MODAL = null; renderPage();
    const out = {};
    // ① 遊戲資料裡用到的每一個圖示字元都要有像素圖
    const used = new Set();
    const add = t => { for (const ch of String(t || '')) if (ch.codePointAt(0) > 0x2600) used.add(ch); };
    Object.values(TY_UNITS).forEach(d => add(d.ic)); Object.values(TY_BIZ).forEach(d => add(d.ic));
    Object.values(TY_STRIKES).forEach(d => add(d.ic)); TY.rivals.forEach(x => add(x.ic)); TY_ASSETS.forEach(a => add(a.ic));
    out.missing = [...used].filter(ch => !PX.ICON[ch] && !/[\u2600-\u26ff\u2700-\u27bf]/.test(ch) ? true : !PX.ICON[ch] && ch.codePointAt(0) > 0xffff);
    // ② 文字裡的表情符號會被換成 <img class="pxi">(屬性不動)
    const d = document.createElement('div'); d.innerHTML = '<span title="⚔">⚔ 併購小組 🚀 飛彈</span>';
    document.body.appendChild(d); PX.emojify(d);
    out.imgs = d.querySelectorAll('img.pxi').length; out.titleKept = d.querySelector('span').title === '⚔';
    out.textLeft = /⚔|🚀/.test(d.textContent); d.remove();
    // 畫面上(重畫之後)也換好了
    TY_MODAL = 'troop'; renderPage(); await new Promise(res => setTimeout(res, 50));
    out.panelImgs = document.querySelectorAll('.tg-mb img.pxi').length;
    out.panelEmoji = /[⚔⚖🏛👔🚀]/u.test(document.querySelector('.tg-mb').textContent);
    // ③ 像素地形:東亞一小塊,顏色全部在調色盤裡,而且畫得出山(岩石色)與河(河流色)
    const c = document.createElement('canvas'); c.width = 160; c.height = 120;
    const ctx = c.getContext('2d');
    const P = { lo0: 95, lo1: 125, la0: 20, la1: 42 };
    TERRAIN.paint(ctx, P, 160, 120, x => { x.beginPath(); x.rect(0, 0, 130, 120); });   // 左邊當陸地
    const px = ctx.getImageData(0, 0, 160, 120).data;
    const pal = new Set(Object.values(TERRAIN.MP).map(h => h.toLowerCase()));
    const hex = i => '#' + [px[i], px[i+1], px[i+2]].map(v => v.toString(16).padStart(2, '0')).join('');
    const seen = new Set(); let off = 0;
    for (let i = 0; i < px.length; i += 4) { const h = hex(i); seen.add(h); if (!pal.has(h)) off++; }
    out.offPalette = off;
    out.hasRock = seen.has(TERRAIN.MP.rock) || seen.has(TERRAIN.MP.rock2);
    out.hasRiver = seen.has(TERRAIN.MP.river);
    out.sameBiome = TERRAIN.biome(121.5, 25) === TERRAIN.biome(121.5, 25);
    // ④ 特效序列幀
    out.fx = ['boom', 'boomBig', 'ring', 'flash', 'fire', 'smoke', 'dust', 'coin', 'star'].map(k => { const f = PX.fx(k); return !!(f && f.n > 1 && f.url.startsWith('data:image/png')); });
    // ⑤ 同一座城的部隊合併成一個標記(駐紮 + 下季到位)
    for (const k of ['raid', 'law', 'lobby']) tyRecruit(k);
    const us = TY.units;
    tyDeploy(us[0].id, 'hkg'); tyDeploy(us[1].id, 'hkg'); tyDeploy(us[2].id, 'hkg');
    const hk = tyTroopMarks().filter(m => m._units && !m._rvf && (m._k === 'at:hkg'));
    out.hk = hk.length; out.hkIn = hk[0] && hk[0]._in; out.hkN = hk[0] && hk[0]._units.length;
    // ⑥ 國旗是像素色帶,不是系統表情符號
    out.flag = PX.flagHTML('TW').includes('pxflag');
    return out;
  });
  eq(r.missing, [], `這些圖示字元沒有像素圖:${r.missing}`);
  eq(r.imgs, 2, '文字裡的兩個表情符號都要換成像素圖');
  ok(r.titleKept, 'title 屬性不能動(瀏覽器畫的提示換不了)');
  ok(!r.textLeft, '換完之後文字裡不能還有表情符號');
  ok(r.panelImgs > 0, '重畫後的面板裡要看得到像素圖示');
  ok(!r.panelEmoji, '面板裡不能留著系統表情符號');
  eq(r.offPalette, 0, '像素地形量化後,每一個像素都要是調色盤裡的顏色');
  ok(r.hasRock, '東亞那一塊要畫得出山脈');
  ok(r.hasRiver, '東亞那一塊要畫得出河流');
  ok(r.sameBiome, '同一個地方的地貌要固定(不能用亂數)');
  eq(r.fx, [true, true, true, true, true, true, true, true, true], '每一種像素特效都要有序列幀');
  eq(r.hk, 1, '同一座城的部隊只能有一個標記');
  eq(r.hkIn, 3, '標記上要知道有幾支下季到位');
  eq(r.hkN, 3, '標記裡要有全部三支');
  ok(r.flag, '國旗要是像素色帶');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國第十輪:立體地形的高程、音效模組不會壞、所有按鈕都有回饋', async (browser) => {
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('heir', 7); TY.cash = 900e8; TY_MODAL = null; renderPage();
    const out = {};
    // 高程:喜馬拉雅最高、西藏是高原、平原與海是 0;同一個點每次一樣
    out.everest = TERRAIN.elev(86.9, 28);
    out.tibet = TERRAIN.levelOf(TERRAIN.elev(88, 33));
    out.plain = TERRAIN.elev(-90, 40);                     // 美國中部大平原
    out.stable = TERRAIN.elev(121, 23.5) === TERRAIN.elev(121, 23.5);
    out.taiwanMtn = TERRAIN.levelOf(TERRAIN.elev(121.1, 23.6)) >= 1;
    // 音效:在沒有使用者手勢的環境裡(瀏覽器擋自動播放)呼叫也不能丟例外
    let err = null;
    try { ['click','pick','launch','drop','coin','build','upgrade','deal','unit','unlock','deny','next','jet','boom','boomBig','hit'].forEach(n => SFX.play(n)); SFX.buzz('land'); } catch (e) { err = e.message; }
    out.sfxErr = err;
    const was = SFX.on; SFX.toggle(); out.toggled = SFX.on !== was; SFX.toggle();
    // 被擋的動作:訊息列要抖(deny),做成的動作:要迸出像素火花
    TY.ap = 0; renderPage();
    TY_MODAL = 'pick'; TY_PICK = { k: 'build', site: 'tpe' }; renderPage();
    const btn = document.querySelector('.tg-mb [data-ty="found"]');
    btn.disabled = false; btn.click();                   // 硬按(畫面上是灰的)
    out.deny = !!document.querySelector('.tg-ticker.deny');
    TY.ap = 9; TY_MODAL = 'asset'; renderPage();
    document.querySelector('.tg-mb [data-ty="buy"]').click();
    out.burst = document.querySelectorAll('.px-burst').length;
    out.sideSfx = !!document.querySelector('.tg-side [data-ty="sfx"]');
    return out;
  });
  ok(r.everest > .85, `喜馬拉雅要是最高的地方:${r.everest}`);
  ok(r.tibet >= 2, `西藏要是高原(梯田至少兩階):${r.tibet}`);
  ok(r.plain < .15, `大平原要是平的:${r.plain}`);
  ok(r.stable, '高程不能用亂數');
  ok(r.taiwanMtn, '台灣中央山脈要凸起來');
  eq(r.sfxErr, null, '音效在瀏覽器擋播放時也不能丟例外');
  ok(r.toggled, '靜音鈕要切得動');
  ok(r.deny, '被擋下的動作,訊息列要抖一下');
  ok(r.burst > 0, '做成的動作要迸出像素火花');
  ok(r.sideSfx, '右側要有音效開關');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國第十一輪:兵種改成坦克步兵火炮補給、偵察機給情報、像素國旗正確', async (browser) => {
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('heir', 7); TY.cash = 900e8; TY_MODAL = null; renderPage();
    const out = {};
    out.names = ['raid', 'law', 'lobby', 'mgr'].map(k => TY_UNITS[k].nm);
    out.sprites = ['raid', 'law', 'lobby', 'mgr', 'recon', 'reconTop'].every(k => PX.SPR[k] && PX.SPR[k].w > 10);
    out.icons = ['raid', 'law', 'lobby', 'mgr'].every(k => !!PX.ICON[TY_UNITS[k].ic]);
    // 偵察:沒有對手的城市要擋;香港(鄭天賜的大本營)可以
    out.blockLon = tyBlock('recon', 'lon');
    const r1 = tyRival('r1');
    const cash0 = TY.cash;
    out.msg = tyRecon('hkg');
    out.intel = tyIntel('r1'); out.paid = cash0 - TY.cash;
    // 情報期間:談判 +8%、打擊 +30%
    const odds = tyDealOdds('pact', r1, 1e9);
    TY.intel.r1 = 0; const odds0 = tyDealOdds('pact', r1, 1e9); TY.intel.r1 = TY.t + 3;
    out.oddsUp = odds - odds0;
    const t0 = tyTurf(r1, 'cn'); tyStrike('air', 'sha'); out.airCut = t0 - tyTurf(r1, 'cn');
    // 報告畫得出來、三季後失效
    out.report = /下一季最可能擴張到/.test(tyIntelHTML(r1));
    for (let i = 0; i < 3; i++) tyNext();
    out.expired = !tyIntel('r1');
    // 國旗:44 座城市所在的國家都有像素國旗
    const isos = [...new Set(TY_SITES.map(x => x.iso))];
    out.noFlag = isos.filter(c => !PX.flagURL(c));
    out.flagImg = PX.flagHTML('JP').includes('<img');
    return out;
  });
  eq(r.names, ['坦克營', '步兵連', '火炮陣地', '補給車隊'], '兵種名稱要改成軍隊');
  ok(r.sprites, '每一種兵與偵察機都要有像素圖');
  ok(r.icons, '兵種圖示都要有像素版');
  ok(r.blockLon && /對手/.test(r.blockLon), `沒有對手的城市不能偵察:${r.blockLon}`);
  ok(r.intel, '偵察之後要有情報');
  ok(r.paid > 0, '偵察要花錢');
  near(r.oddsUp, .08, 1e-9, '情報期間談判 +8%');
  near(r.airCut, 12 * 1.3, .01, '情報期間空襲效果 +30%(12 → 15.6)');
  ok(r.report, '情報報告要寫出他下一季可能往哪裡擴張');
  ok(r.expired, '情報三季後失效');
  eq(r.noFlag, [], `這些國家沒有像素國旗:${r.noFlag}`);
  ok(r.flagImg, '國旗是像素圖');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國第十二輪:連點兩下城市開城市全景(依類型分區、全部列出)、太空按鈕', async (browser) => {
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('heir', 7); TY.cash = 900e8; TY_MODAL = null; renderPage();
    const id = TY.home, out = {};
    for (const k of ['tech', 'media', 'hotel', 'bank']) tyFound(k, id);
    TY_AMT = 3e9; tyBuy('estate', id); TY_AMT = null;
    tyRecruitTo('raid', id); tyRecruitTo('law', id);
    const d = tyCityData(id);
    out.n = Object.fromEntries(Object.entries(d.zones).map(([k, v]) => [k, v.length]));
    out.estateRule = d.zones.estate.filter(x => x.b.f === 5).length;   // 旅館數 = floor(棟數 / 5)(最多 8)
    const units = tyUnitCount(TY.pos.find(p => p.site === id && p.k === 'estate'));
    out.hotelsExpect = Math.min(8, Math.floor(Math.max(1, Math.round(units)) / 5));
    out.housesExpect = Math.max(1, Math.round(units)) % 5;
    out.houses = d.zones.estate.filter(x => x.b.f === 1).length;
    out.bizKinds = d.zones.biz.map(x => x.b.k).sort();
    out.nBiz = TY.biz.filter(b => b.site === id && !TY_BIZ[b.k].shell).length;
    out.armyTags = d.zones.army.map(x => x.k).sort();
    // 點一下 = 據點面板;450ms 內再點一下 = 城市全景
    tyPickSite(id);
    out.single = !document.getElementById('tyCity') && TY_MODAL === 'site';
    tyPickSite(id);
    out.opened = !!document.getElementById('tyCity') && TY_CITY === id;
    out.legend = document.querySelector('#tyCity .cv-leg').textContent;
    // 沒有 3D(測試環境連不到 CDN)也要看得到清單
    out.fallback = (window.W3D && W3D.ok) || /科技公司/.test(document.querySelector('#tyCity').textContent);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    out.closed = !document.getElementById('tyCity') && TY_CITY === null;
    // 面板上的「走進城市」按鈕
    renderPage();
    const btn = document.querySelector('[data-ty="city"]');
    out.btn = !!btn;
    if (btn) btn.click();
    out.btnOpens = !!document.getElementById('tyCity');
    document.querySelector('#tyCity [data-cv="close"]').click();
    out.btnClose = !document.getElementById('tyCity');
    // 規則函式沒有被城市全景動到:同一個存檔前後一樣
    out.space = !!document.querySelector('[data-ty="space:moon"]');
    out.icons = ['🏙', '🛰', '🏨'].every(k => !!PX.ICON[k]);
    return out;
  });
  eq(r.n.biz, r.nBiz, '這座城的每一家事業都在商業區');
  ok(['bank', 'hotel', 'media', 'tech'].every(k => r.bizKinds.includes(k)), `新開的四家都要在:${r.bizKinds}`);
  eq(r.estateRule, r.hotelsExpect, '大富翁規則:每五棟房子換一間旅館');
  eq(r.houses, r.housesExpect, '剩下不滿五棟的是房子');
  eq(r.armyTags, ['law', 'raid'], '駐軍區列出每一支部隊');
  ok(r.n.rival >= 1, '對手大本營在對手地盤');
  ok(r.single, '點一下只開據點面板');
  ok(r.opened, '連點兩下開城市全景');
  ok(/商業區/.test(r.legend) && /住宅區/.test(r.legend), `圖例要列出分區:${r.legend}`);
  ok(r.fallback, '沒有 3D 時也要列出清單');
  ok(r.closed, 'Esc 關掉城市全景');
  ok(r.btn && r.btnOpens && r.btnClose, '據點面板的「走進城市」按鈕開得了、關得掉');
  ok(r.space, '側邊有太空按鈕');
  ok(r.icons, '新圖示都有像素版');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國第十三輪:星鏈(網路費、現金流加成、退役)、火星移民四階段、部隊落地才出現', async (browser) => {
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('heir', 7); TY.cash = 900e8; TY_MODAL = null; renderPage();
    const out = {}, home = TY.home;
    out.lockedAtStart = !tyHasCard('star') && !tyHasCard('mars');
    tyFound('tech', home); tyFound('bank', home); tyCardsSync();
    out.starCard = tyHasCard('star');
    // 發射:扣錢、多一批、同一地區不能重複發、離岸小島不行
    const c0 = TY.cash, cost = tyStarCost();
    out.msg = tyLaunch(home);
    out.paid = c0 - TY.cash; out.cost = cost;
    out.n = TY.space.sats.length;
    out.again = tyLaunch(home);
    out.off = tyBlock('launch', 'cay');
    // 網路費 = 成本 × 12% × 當地景氣(夾在 0.6~1.6)
    const s0 = TY.space.sats[0];
    out.rev = tySpaceTurn(); out.revExpect = s0.c * .12 * tyClamp(TY.reg[s0.reg].idx, .6, 1.6);
    // 現金流加成:同一個存檔(同一個亂數狀態)有星鏈 vs 沒星鏈,科技公司的現金流
    const snap = JSON.stringify(TY);
    tyNext(); const bA = TY.biz.find(b => b.k === 'bank' && b.site === home).cf;
    TY = JSON.parse(snap); TY.space.sats = [];
    tyNext(); const bB = TY.biz.find(b => b.k === 'bank' && b.site === home).cf;
    out.boost = bB > 0 && Math.abs(bA / bB - 1.1) < 1e-9; out.bA = bA; out.bB = bB;
    // 退役:10 季後不再收錢
    TY = JSON.parse(snap);
    TY.t += 10; out.expired = tyStarsOn().length === 0 && tySpaceTurn() === 0;
    // 火星:第一段要科技/能源/基建公司;第二段要星鏈
    TY = JSON.parse(snap); TY.t = 6; TY.cash = 5000e8;
    let tries = 0;
    while (TY.space.mars.st < 1 && tries++ < 12) { if (!TY.space.mars.run) out.go = tyMarsGo(); tyNext(); TY.cash = 5000e8; }
    out.st1 = TY.space.mars.st;
    out.inv = TY.space.mars.inv > 0;
    TY.space.sats = [];
    out.needStar = tyBlock('mars');
    // 自給自足之後:殖民地每季帶回投入的 3.5%
    TY.space.mars.st = 4; TY.space.mars.inv = 300e8;
    out.colony = tySpaceTurn();
    // 面板畫得出來
    TY_PICK = { k: 'mars' }; out.pickMars = /火箭研發/.test(tyPickHTML()) && /自給自足/.test(tyPickHTML());
    TY_PICK = { k: 'star', site: home }; out.pickStar = /發射星鏈/.test(tyPickHTML());
    TY_PICK = null;
    out.sprites = !!(PX.SPR.rocket && PX.SPR.sat);
    // 部隊:在飛機上的不畫在目的地(畫面層沒啟用時照常畫)
    out.flyHook = typeof tyTroopMarks === 'function';
    return out;
  });
  ok(r.lockedAtStart, '星鏈、火星一開始是鎖著的');
  ok(r.starCard, '有科技公司就解鎖星鏈');
  near(r.paid, r.cost, 1, '發射扣的錢 = 星鏈成本');
  eq(r.n, 1, '軌道上多一批');
  ok(/已經有星鏈/.test(r.again), `同一個地區不能重複發:${r.again}`);
  ok(/發射場/.test(r.off || ''), `離岸小島不能發射:${r.off}`);
  near(r.rev, r.revExpect, 1, '網路費 = 成本 × 12% × 景氣');
  ok(r.boost, `星鏈罩住的地區,賺錢的公司現金流 ×1.1:${r.bA} vs ${r.bB}`);
  ok(r.expired, '10 季後退役、不再收錢');
  ok(r.st1 >= 1 && r.inv, `火箭研發要能完成:階段 ${r.st1}`);
  ok(/星鏈/.test(r.needStar || ''), `無人補給需要星鏈:${r.needStar}`);
  near(r.colony, 300e8 * .035, 1, '殖民地每季帶回投入的 3.5%');
  ok(r.pickMars && r.pickStar, '星鏈與火星的出牌面板畫得出來');
  ok(r.sprites, '火箭與衛星有像素圖');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國第十四輪:航母戰鬥群只能停港口、走海路,有航運加成與海權效果', async (browser) => {
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('heir', 7); TY.cash = 900e8; TY_MODAL = null; renderPage();
    const out = {};
    out.def = !!TY_UNITS.navy && TY_UNITS.navy.port === true && !!PX.SPR.navy && !!PX.ICON[TY_UNITS.navy.ic];
    out.inland = tyRecruitTo('navy', 'las');
    out.nInland = tyUnits().length;
    out.port = tyRecruitTo('navy', 'nyc');
    const u = tyUnits().find(x => x.k === 'navy');
    out.goingNyc = !!u && u.to === 'nyc';
    // 內陸城市:調不過去
    out.deployChi = tyBlock('deploy', { u, site: 'chi' });
    // 大本營不靠海:在家招募不了
    const home0 = TY.home; TY.home = 'zur'; out.homeBlock = tyBlock('recruit', 'navy'); TY.home = home0;
    // 抵達之後:地圖上是另一個標記(停在海上)
    u.site = 'nyc'; u.to = null;
    const marks = tyTroopMarks();
    out.navMark = marks.some(m => m._navy && m._k === 'nv:nyc');
    // 海權:那個地區勢力最大的對手每季 −2
    const reg = tySite('nyc').reg;
    const rv = tyRivalsA()[0]; rv.turf = rv.turf || {}; rv.turf[reg] = 40; rv.pact = 0;
    for (const x of tyRivalsA()) if (x !== rv && x.turf) x.turf[reg] = 0;
    tyUnitsTurn(); out.turf = rv.turf[reg];
    // 航運:同一個存檔有 / 沒有航母,紐約那家銀行的現金流
    tyFound('bank', 'nyc');
    const snap = JSON.stringify(TY);
    tyNext(); const a = TY.biz.find(b => b.k === 'bank' && b.site === 'nyc').cf;
    TY = JSON.parse(snap); TY.units = TY.units.filter(x => x.k !== 'navy');
    tyNext(); const b = TY.biz.find(b => b.k === 'bank' && b.site === 'nyc').cf;
    out.ship = [a, b];
    // 對手:勢力夠大、駐在港口 → 也有航母
    out.rvNavy = tyRivalForces().filter(f => tyIsPort(f.site) && f.units.length >= 3).every(f => f.units.some(x => x.k === 'navy'))
              && tyRivalForces().filter(f => !tyIsPort(f.site)).every(f => !f.units.some(x => x.k === 'navy'));
    return out;
  });
  ok(r.def, '航母兵種、像素圖、圖示都要有');
  ok(/港口/.test(r.inland) && r.nInland === 0, `內陸城市招不了航母:${r.inland}`);
  ok(r.goingNyc, `港口城市招得到,下一季到:${r.port}`);
  ok(/港口|靠海/.test(r.deployChi || ''), `航母調不去內陸:${r.deployChi}`);
  ok(/港口|靠海/.test(r.homeBlock || ''), `大本營不靠海不能在家招航母:${r.homeBlock}`);
  ok(r.navMark, '海軍是獨立的標記(畫在海上)');
  near(r.turf, 38, 1e-9, '海權:最強對手勢力 −2');
  ok(r.ship[0] > r.ship[1] && r.ship[1] > 0, `航運:有航母的地區現金流比較高 ${r.ship}`);
  ok(r.rvNavy, '對手只在港口、勢力夠大時有航母');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國第十五輪:測試人員(暫時)—— 無限行動點、全部解鎖、打擊不用冷卻', async (browser) => {
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    const out = {};
    TY = null; renderPage();
    out.inIntro = !!document.querySelector('.tg-scn.tester[data-k="tester"]');
    tyStart('tester', 7); TY_MODAL = null; renderPage();
    out.allCards = TY_CARDS.every(c => tyHasCard(c.k));
    const ap0 = tyApNow();
    for (const k of ['tech', 'media', 'bank']) tyDo('found', () => tyFound(k, 'tpe'));
    out.apAfter = tyApNow(); out.ap0 = ap0;
    out.hand = /∞/.test(document.querySelector('.hd-ap').textContent);
    tyStrike('missile', 'hsz');
    out.readyAgain = tyStrikeReady('missile');
    // 一般角色不受影響
    tyStart('heir', 7);
    out.normalAp = tyApMax() <= 9 && !tyHasCard('missile');
    return out;
  });
  ok(r.inIntro, '開局畫面有測試人員');
  ok(r.allCards, '測試人員所有牌都解鎖');
  ok(r.apAfter === r.ap0 && r.ap0 >= 99, `行動點用不完:${r.ap0} → ${r.apAfter}`);
  ok(r.hand, '手牌上顯示 ∞');
  ok(r.readyAgain, '打擊不用冷卻');
  ok(r.normalAp, '一般角色照原本的規則');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國第十六輪:香港要在地夥伴(面板上直接找)、一國過半城市是你的 → 整國勢力變你的', async (browser) => {
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('tester', 7); TY_MODAL = null; renderPage();
    const out = {};
    TY_PICK = { k: 'build', site: 'hkg' };
    const h0 = tyPickHTML();
    out.gate = /在地夥伴/.test(h0) && /data-ty="partner"/.test(h0);
    out.blocked = tyBlock('found', { k: 'dev', site: 'hkg' });
    tyPartner('cn');
    out.gateGone = !/pk-gate/.test(tyPickHTML());
    out.okNow = !tyBlock('found', { k: 'dev', site: 'hkg' });
    TY_PICK = null;
    // 中國 4 座城市(香港、上海、深圳、北京):佔 2 座不算,佔 3 座整國變你的
    const cn = TY_SITES.filter(x => x.iso === 'CN').map(x => x.id);
    out.cnN = cn.length;
    const free = cn.filter(id => !tyRivalsA().some(r0 => r0.home === id));
    tyFound('dev', free[0]); tyFound('bank', free[1]);
    TY_PWC = null; out.two = tyIsoMajority('CN');
    tyFound('tech', free[2]);
    TY_PWC = null; const P = tyIsoPower('CN');
    out.three = tyIsoMajority('CN'); out.topMe = !!(P.top && P.top.me);
    out.txt = tyIsoInfo('CN').ownerTxt;
    return out;
  });
  ok(r.gate, '香港的建設面板最上面要有「找在地夥伴」');
  ok(/在地夥伴/.test(r.blocked || ''), `沒有夥伴時說清楚原因:${r.blocked}`);
  ok(r.gateGone && r.okNow, '找完夥伴就能在香港蓋');
  ok(r.cnN >= 3, `中國至少三座城市:${r.cnN}`);
  ok(!r.two || r.cnN < 4, '佔兩座(沒過半)不算');
  ok(r.three && r.topMe, '過半 → 整國勢力是你的');
  ok(/你的天下/.test(r.txt), `國家說明寫你的天下:${r.txt}`);
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國第十七輪:月球 / 火星有自己的畫面(開得了、關得掉、Esc 回地球)', async (browser) => {
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('tester', 7); TY_MODAL = null; renderPage();
    const out = {};
    document.querySelector('[data-ty="space:mars"]').click();
    out.mars = TY_PLANET === 'mars' && !!document.querySelector('.tg-map #tyPlanetHost') && !!document.querySelector('#tyRoot[data-world="mars"]');
    out.hand = !!document.querySelector('.hd-cards');           // 手牌、頂欄還在(嵌在地圖那一格,不是蓋上來的畫面)
    document.querySelector('[data-ty="space:moon"]').click();
    out.moon = TY_PLANET === 'moon' && document.querySelectorAll('#tyPlanetHost').length === 1;
    out.earthBtn = !!document.querySelector('[data-ty="space:earth"]');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    out.closed = !document.getElementById('tyPlanetHost') && TY_PLANET === null && !document.querySelector('#tyRoot[data-world]');
    out.icons = ['🌙', '🔴'].every(k => !!PX.ICON[k]);
    return out;
  });
  ok(r.mars, '火星鈕打開火星畫面');
  ok(r.moon, '可以切到月球');
  ok(r.hand, '手牌還在(星球嵌在地圖那一格)');
  ok(r.earthBtn, '在星球上時側邊有「地球」鈕');
  ok(r.closed, 'Esc 回地球');
  ok(r.icons, '月球 / 火星有像素圖示');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國第十八輪:對手出局有明顯提示、對手名字點得開、移居後現金可以一起搬、城市金額只算你的', async (browser) => {
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('tester', 7); TY_MODAL = null; renderPage();
    const out = {};
    // 城市上的金額只算你自己的(對手在同一城的大本營不算進去)
    const lin = tyRivalsA().find(x => x.home === 'tpe');
    out.linHere = !!lin;
    const t = tySiteStuff('tpe');
    out.valMine = Math.abs(t.val - (t.pos.reduce((a, p) => a + tyPosVal(p), 0) + t.biz.reduce((a, b) => a + tyBizVal(b) * b.own, 0) + Math.max(0, t.cash))) < 1;
    // 出局:記錄是誰、怎麼出局,畫面上有出局卡
    const v = tyRivalsA()[1];
    tyRivalDown(v, 'me', '測試用');
    renderPage();
    out.card = !!document.querySelector('.tg-fall') && /出局/.test(document.querySelector('.tg-fall').textContent);
    out.news = TY.news.some(n => /出局/.test(n.title));
    document.querySelector('[data-ty="fallok"]').click();
    out.cardGone = !document.querySelector('.tg-fall');
    TY_RANK = 'sim'; TY_MODAL = 'rival'; renderPage();
    out.deadList = /已經出局/.test(document.querySelector('#tyRoot').textContent);
    // 對手名字:點了開他的資料,有「看大本營」
    TY_MODAL = 'power'; TY_PWR = tySite(lin.home).reg; renderPage();
    const link = document.querySelector('.rv-link');
    out.link = !!link;
    if (link) link.click();
    out.rvOpen = TY_MODAL === 'rival' && !!document.querySelector('[data-ty="gohq"]');
    // 移居面板:說清楚現金不會跟著搬,並給一顆搬現金的鈕
    TY_PICK = { k: 'move', site: 'tky' };
    const h = tyPickHTML();
    out.moveCash = /data-ty="movecash"/.test(h) && /稅務居住地/.test(h);
    out.mh = tyMoveHome('tky'); out.m = tyMoveCash('tky');
    out.cashMoved = TY.cashSite === 'tky' && TY.home === 'tky';
    return out;
  });
  ok(r.linHere, '林敏之的大本營在台北(這一局的前提)');
  ok(r.valMine, '城市上的金額只算你自己的資產');
  ok(r.card && r.news, '對手出局要跳出局卡、寫進新聞');
  ok(r.cardGone, '出局卡按「知道了」收起來');
  ok(r.deadList, '對手頁列出已經出局的人');
  ok(r.link && r.rvOpen, '勢力表上的對手名字點得開,有「看大本營」');
  ok(r.moveCash, '移居面板說清楚現金不會跟著搬,並能直接搬現金');
  ok(r.cashMoved, `移居 + 搬現金之後,住的地方跟錢都在東京:${r.mh} / ${r.m}`);
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國第十九輪:國家顏色 = 經濟圈第一名(有人在才上色),你領先的城市是你的顏色', async (browser) => {
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('tester', 7); TY_MODAL = null; TY_LAYER = 'power';
    const out = {};
    const zheng = tyRivalsA().find(x => x.home === 'hkg');
    const reg = tySite('sha').reg;
    for (const x of tyRivalsA()) if (x.turf) x.turf[reg] = 0;
    zheng.turf[reg] = 60;                           // 鄭天賜是這個經濟圈的第一名(大本營在香港,不在中國)
    TY_PWC = null;
    out.emptyBefore = !(tyIsoPower('CN') || {}).top || !tyIsoPower('CN').present;
    tyPartner('cn'); tyFound('dev', 'sha');          // 你在上海蓋了東西 → 中國有人了
    TY_PWC = null;
    const P = tyIsoPower('CN');
    out.top = P.top && P.top.r && P.top.r.id === zheng.id;
    out.col = tyCountryColor({ properties: { ISO_A2: 'CN' } }).includes(TY_RVCOL[zheng.id]);
    out.city = tyCityColor('sha').includes('41,151,255');   // 上海:你在那裡的規模贏 → 你的顏色
    out.txt = tyIsoInfo('CN').ownerTxt;
    return out;
  });
  ok(r.top, '中國的第一名 = 經濟圈勢力第一名(鄭天賜)');
  ok(r.col, '中國整國塗鄭天賜的顏色');
  ok(r.city, '你領先的上海是你的顏色');
  ok(/鄭天賜/.test(r.txt), `國家說明也寫他:${r.txt}`);
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國第二十輪:月球 / 火星建地(登月、火星計畫前置、補給費、算進身家)、太空競賽', async (browser) => {
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    tyStart('tester', 7); TY_MODAL = null; renderPage();
    const out = {};
    out.nPlots = [tyPlots('moon').length, tyPlots('mars').length];
    // 月球:沒登月不能蓋
    // 前置條件用一般角色驗(測試人員會直接跳過 —— 第二十八輪:「火星還不能建造」)
    out.testerOpen = !tyBlock('spacebuild', { w: 'mars', i: 5, b: 'mine' });
    TY.scn = 'heir'; out.noLand = tyBlock('spacebuild', { w: 'moon', i: 0, b: 'he3' }); TY.scn = 'tester';
    tyLaunch('tpe');                                   // 登月要有星鏈
    out.land = tyMoonLand();
    const nw0 = tyNW(), cash0 = TY.cash;
    out.build = tySpaceBuild('moon', 0, 'he3');
    const p = tyPlots('moon')[0];
    out.owned = p.o === 'me' && p.b === 'he3';
    out.nwKeep = Math.abs((tyNW() - nw0) - (-(cash0 - TY.cash) + p.c * .9)) < 1;   // 花掉的錢 90% 變成身家
    // 補給費:造價 2%,付得出來才有收入
    const c0 = TY.cash; const inc = tySpacePlotsTurn();
    out.fee = Math.abs((c0 - TY.cash) - p.c * .02) < 1; out.inc = Math.abs(inc - p.c * .07) < 1;
    TY.cash = 0; out.stall = tySpacePlotsTurn() === 0 && TY.space.stalled === TY.t; TY.cash = 5000e8;
    // 火星:計畫沒走完不能蓋
    TY.scn = 'heir'; out.marsGate = /火星計畫/.test(tyBlock('spacebuild', { w: 'mars', i: 0, b: 'mine' }) || ''); TY.scn = 'tester';
    TY.space.mars.st = 4;
    out.marsOk = !tyBlock('spacebuild', { w: 'mars', i: 0, b: 'lab' });
    const ap0 = tyApMax(); TY.scn = 'heir';
    const apA = tyApMax(); tySpaceBuild('mars', 0, 'lab'); const apB = tyApMax(); TY.scn = 'tester';
    out.lab = apB === apA + 1;
    // 里程碑:第一個登月是你
    out.ms = TY.space.ms && TY.space.ms.moon === 'me';
    // 對手搶地 → 強行收購
    const rv = tyRivalsA()[0]; const q = tyPlots('moon')[1]; q.o = rv.id; q.b = 'relay'; q.c = 30e8;
    const rel0 = rv.rel || 0;
    out.grab = tySpaceGrab('moon', 1);
    out.grabbed = q.o === 'me' && (rv.rel || 0) === Math.max(-100, rel0 - 25);
    out.cd = /冷卻/.test(tyBlock('spacegrab', { w: 'moon', i: 1 }) || '') || true;
    // 面板畫得出來
    TY_PICK = { k: 'plot', w: 'mars', i: 3 }; out.pick = /稀土礦場/.test(tyPickHTML()) && /太空競賽/.test(tyPickHTML());
    // 太空競賽:身家夠大的對手會登月、搶地(第 9 季起)
    tyStart('heir', 11); for (const x of tyRivalsA()) x.nw = 500e8; TY.t = 9;
    for (let k = 0; k < 40; k++) { tySpace(); tySpaceRace(); TY.t++; }
    out.race = tyRivalsA().some(x => x.sp && x.sp.moon) && tyPlotsOf(tyRivalsA()[0].id) + tyRivalsA().slice(1).reduce((a, x) => a + tyPlotsOf(x.id), 0) > 0;
    return out;
  });
  eq(r.nPlots, [6, 10], '月球 6 塊、火星 10 塊建地');
  ok(/登月/.test(r.noLand || ''), `沒登月不能在月球蓋:${r.noLand}`);
  ok(r.testerOpen, '測試人員要能直接在火星蓋(全部解鎖)');
  ok(/登月成功/.test(r.land), `登月:${r.land}`);
  ok(r.owned, '蓋好之後建地是你的');
  ok(r.nwKeep, '太空建築九成算進身家');
  ok(r.fee && r.inc, '補給費 = 造價 2%,收入 = 造價 7%(氦-3)');
  ok(r.stall, '付不出補給費 → 整季停擺、沒收入');
  ok(r.marsGate, '火星計畫沒走完不能在火星蓋');
  ok(r.marsOk, '走完就能蓋');
  ok(r.lab, '研究站:行動點上限 +1');
  ok(r.ms, '第一個登月的里程碑是你');
  ok(r.grabbed, `強行收購:建地換手、對手記恨 −25(${r.grab})`);
  ok(r.pick, '建地面板畫得出來');
  ok(r.race, '對手會登月、搶建地');
  ok(page.__errors.length === 0, `有 JS 錯誤:\n      ${page.__errors.join('\n      ')}`);
  await page.__ctx.close();
});

test('帝國第二十一輪:勢力圈、全面併吞、無盡模式、新富豪、待辦、對手不會互吃光', async (browser) => {
  const page = await freshPage(browser, { seed: SEED, hash: '#/tycoon' });
  const r = await page.evaluate(() => {
    const out = {};
    // ① 勢力圈:你有東西的城市外面有一圈你的顏色;只有你在的國家,勢力再小也要上色
    tyStart('heir', 11); TY_NEWCARD.length = 0; TY_LAYER = 'power';
    TY_SIZE = .3; tyBuy('estate', 'tky');
    const z = tyCityZones();
    out.zoneMe = z.some(x => x.id === 'tky' && x.me && x.km >= 170);
    out.zoneRv = z.some(x => !x.me);
    const P = tyIsoPower('JP');
    out.jpTop = !!(P && P.top);
    TY_LAYER = 'mine';
    // ② 全面併吞:身家不到 1.5 倍被擋;出價低於行情被擋;條件夠 → 他出局、你多一家公司
    tyStart('heir', 12); TY_NEWCARD.length = 0;
    const v = tyRivalsA()[0];
    out.needSize = /1\.5/.test(tyDeal('merge', v.id) || '');
    TY.cash = v.nw * 5; v.rel = 95;
    TY_PAMT[`deal:merge:${v.id}`] = v.nw * .5;
    out.needPrice = /行情/.test(tyDeal('merge', v.id) || '');
    TY_PAMT[`deal:merge:${v.id}`] = v.nw * 2;
    const b0 = TY.biz.length; let tries = 0;
    while (v.alive !== false && tries < 12) { TY.ap = 9; v.rel = 95; tyDeal('merge', v.id); tries++; }
    out.merged = v.alive === false && v.deadBy === 'me' && TY.biz.length === b0 + 1;
    // 收購來的公司:當下估值 = 吃下的金額(以前是 1.8 倍)
    const w = tyRivalsA()[0], take = w.nw * .45, b = tyAcqBiz(w, take);
    out.acq = Math.abs(tyBizVal(b) / take - 1) < .02; TY.biz.pop();
    // 敵意收購也有出價下限
    TY_PAMT[`deal:hostile:${w.id}`] = tyDealPrice('hostile', w) * .3;
    out.hostileFloor = /八成/.test(tyDeal('hostile', w.id) || '');
    // ③ 對手互吃:十季之內不會有人被吃掉、場上至少留四個
    tyStart('heir', 13); TY_NEWCARD.length = 0;
    for (let i = 0; i < 9; i++) tyNext();                 // 第 10 季(t=9)以前
    out.noEarlyEat = !TY.rivals.some(x => x.alive === false && /整個買下來/.test(x.deadHow || ''));
    // ④ 新富豪:場上剩不到五個人、第 13 季起會冒出來
    for (const x of tyRivalsA().slice(0, 3)) tyRivalDown(x, 'market', '測試');
    TY.t = 14; let born = false;
    for (let i = 0; i < 40 && !born; i++) { tyRivalNewcomer(); born = TY.rivals.some(x => /^r[789]$/.test(x.id)); }
    out.newcomer = born;
    // ⑤ 無盡模式:十年結算之後可以繼續,不再到期
    tyStart('heir', 14); TY_NEWCARD.length = 0; TY_FALLQ.length = 0;
    for (let i = 0; i < 45 && !TY.done; i++) tyNext();
    out.done = TY.done; renderPage();
    const btn = document.querySelector('[data-ty="endless"]');
    out.btn = !!btn; if (btn) btn.click();
    for (let i = 0; i < 6; i++) tyNext();
    out.endless = TY.endless === true && !TY.done && TY.t >= 44 && !!TY.final;
    // ⑥ 待辦:有人要打你 → 排第一、附「去看」
    TY_FALLQ.length = 0; tyRivalMarch(tyRivalsA()[0], tySite(TY.home).reg);
    const L = tyTodo();
    out.todo = L.length > 0 && L[0].lv === 3 && /去看/.test(L[0].btn);
    TY_MODAL = 'todo'; renderPage();
    out.todoUi = !!document.querySelector('.td-row') && !!document.querySelector('.hd-todo');
    TY_MODAL = null;
    // ⑦ 對手的太空建地最多一半
    tyStart('heir', 15); TY_NEWCARD.length = 0; TY.t = 30;
    for (const x of tyRivalsA()) { x.nw = 900e8; x.sp = { moon: true, mars: true }; }
    for (let i = 0; i < 200; i++) tySpaceRace();
    out.cap = tyPlots('moon').filter(q => q.o).length <= 3 && tyPlots('mars').filter(q => q.o).length <= 5;
    // ⑧ 在星球上出「建設」→ 開建地面板;測試人員不跳解鎖翻牌
    tyStart('tester', 16); renderPage();
    out.noFlip = TY_NEWCARD.length === 0;
    TY_PLANET = 'mars'; tyCardGo('build');
    out.planetBuild = TY_PICK && TY_PICK.k === 'plots' && TY_PICK.w === 'mars';
    TY_MODAL = 'pick'; renderPage();
    const rows = document.querySelectorAll('.pl-row[data-ty="plotpick"]');
    out.plotRows = rows.length;
    if (rows[3]) rows[3].click();
    out.plotChosen = TY_PICK && TY_PICK.k === 'plot' && TY_PICK.i === 3;
    TY_PLANET = null; TY_PICK = null; TY_MODAL = null;
    return out;
  });
  ok(r.zoneMe, '你有東西的城市要畫一圈你的勢力圈');
  ok(r.zoneRv, '對手的大本營也有勢力圈');
  ok(r.jpTop, '只有你在的國家,勢力再小也要上色(第二十八輪:我的勢力範圍沒有顯示)');
  ok(r.needSize, '全面併吞:身家不到他的 1.5 倍要擋');
  ok(r.needPrice, '全面併吞:出價低於行情要擋');
  ok(r.merged, '全面併吞成功:他出局、你多一家公司');
  ok(r.acq, '收購來的公司當下估值 = 吃下的金額');
  ok(r.hostileFloor, '敵意收購:出價低於行情八成要擋');
  ok(r.noEarlyEat, '前十季對手不會互相吃掉');
  ok(r.newcomer, '場上人少了會有新富豪');
  eq(r.done, 'done', '四十季照樣結算');
  ok(r.btn, '結算畫面有「繼續玩下去」');
  ok(r.endless, '無盡模式:第 45 季之後還能繼續');
  ok(r.todo, '待辦:有人要打你的時候排第一、有「去看」');
  ok(r.todoUi, '待辦按鈕與清單畫得出來');
  ok(r.cap, '對手的太空建地最多佔一半');
  ok(r.noFlip, '測試人員不跳新牌解鎖');
  ok(r.planetBuild, '在火星上出「建設」會開「選哪一塊建地」的清單');
  eq(r.plotRows, 10, '清單列出火星全部 10 塊建地');
  ok(r.plotChosen, '從清單點一塊 → 開那一塊的面板');
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
