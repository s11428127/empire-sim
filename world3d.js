/* =============================================================================
   world3d.js —— 帝國的「畫面層」

   這支檔案只負責「好不好看、動不動得了」，**一條遊戲規則都不碰**：
   不讀寫存檔、不呼叫 tyRnd()（那是可重現的種子亂數，畫面拿去用會讓同一顆
   種子跑出不同結果）、不改 TY 裡的任何一個欄位。它只讀 TY，然後畫。

   它做五件事：
     1. 地球的皮：用國界資料在 canvas 上畫一張「沙盤」貼圖（海、大陸棚、
        依緯度變化的地貌），加一張凹凸貼圖，讓光打上去有起伏
     2. 3D 建築：每個據點一座真的 3D 小城（網格，不是 CSS 方塊），
        高度照價值、顏色照類型，新蓋的會從地上長出來
     3. 傾斜鏡頭：拉遠是整顆地球，拉近會慢慢壓低變成斜看的戰略地圖
     4. 季與季之間的過場：季別橫幅、數字跳動、每個據點浮出這一季賺賠多少、
        對手擴張畫成一條從他大本營射出去的弧線
     5. 光：方向光跟著鏡頭走，建築永遠有亮面與暗面

   ── 為什麼 THREE 是「從現場撿」的 ──
   globe.gl 的 UMD 版沒有把 THREE 匯出來。再從 CDN 載一份 three.js 會變成
   兩份 three 在同一頁（多一個會壞的依賴，而且兩份的物件混用很容易出事）。
   所以這裡從 globe.gl 已經建好的物件身上把建構子拿回來：地球的 Mesh、
   它的材質、它的幾何…… 每一個都用 `.type` 驗明正身，驗不過就整層不啟用，
   地圖退回原本的 CSS 積木 —— 不會壞，只是比較平。

   ── 測試環境 ──
   測試裡的 Globe 是「什麼方法都回自己」的替身。這裡所有入口都先檢查
   `scene.isScene === true`（替身回的是一個函式，不是 true），所以替身之下
   整層安靜地不做事。
   ============================================================================= */
(function(){
'use strict';

const R = 100;                                  // globe.gl 的球半徑
/* 貼到最近時鏡頭壓多低。第一版 56°,使用者說「太斜了,要第一張圖那樣」——
   參考畫面幾乎是正上方俯視,只帶一點點透視。 */
const TILT_MAX = 20 * Math.PI / 180;
const W3D = window.W3D = {
  ok: false,          // 3D 建築層有沒有啟用
  textured: false,    // 地球貼圖畫好了沒
  alt: 2,             // 目前鏡頭高度（邏輯上的，不含傾斜）
  extraArcs: [],      // 過場時臨時加上去的弧線（對手擴張）
  extraRings: [],     // 過場時臨時加上去的光圈
};

let G = null;         // globe.gl 實例
let T = null;         // 撿回來的 THREE 建構子
let MAT = null;       // 建築共用的材質
const OBJS = new Set();            // 目前在場上的建築群（縮放時要一個一個調）
const SEEN = Object.create(null);  // 每個據點上一次長什麼樣（決定要不要播「長出來」）
const GEO_CACHE = new Map();       // 同一個樣子的建築只算一次幾何

/* 畫面用的亂數。**絕對不可以用 tyRnd()** —— 那顆是遊戲的種子亂數，
   畫面拿走一個數字，整局接下來的事件就全部錯位了。 */
function vrand(seed){
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const smooth = x => { x = clamp(x,0,1); return x*x*(3-2*x); };
const reduced = () => { try{ return matchMedia('(prefers-reduced-motion: reduce)').matches; }catch(e){ return false; } };

/* =============================================================================
   0. 從 globe.gl 身上撿回 THREE
   ============================================================================= */
function grabThree(){
  if(T) return T;
  try{
    const scene = G.scene();
    if(!scene || scene.isScene !== true) return null;
    const gm = G.globeMaterial();
    let mesh = null;
    scene.traverse(o => { if(!mesh && o.isMesh === true && o.material === gm) mesh = o; });
    if(!mesh) return null;
    const geo = mesh.geometry;
    let BG = geo.constructor;
    if(geo.type !== 'BufferGeometry') BG = Object.getPrototypeOf(BG);
    const O3 = Object.getPrototypeOf(scene.constructor);
    const t = {
      BG, O3, Mesh: mesh.constructor, Phong: gm.constructor,
      Attr: geo.getAttribute('position').constructor,
      /* ⚠ 有貼圖之後 three-globe 會把 color 設成 null(不要染色),所以要從
         emissive 撿 —— 它一樣是 Color。第一版只看 color,換上貼圖之後整個 3D 層就不見了。 */
      Color: (gm.color || gm.emissive || gm.specular).constructor,
    };
    // 一個一個驗明正身：名字被壓縮器改掉了，只能看 type
    if(new t.BG().type !== 'BufferGeometry') return null;
    if(new t.O3().type !== 'Object3D') return null;
    if(new t.Phong().type !== 'MeshPhongMaterial') return null;
    if(new t.Mesh().type !== 'Mesh') return null;
    T = t;
    return T;
  }catch(e){ return null; }
}

/* =============================================================================
   1. 地球的皮 —— 參考那款遊戲的「綠陸藍海」戰略地圖
   -----------------------------------------------------------------------------
   使用者看完第一版說：「國家陸地的輪廓精細一點」「太斜了，我要第一張圖那樣」。
   第一版的問題有兩個：
     · 國界用的是 1:1.1 億（110m）的資料，台灣只剩一個五邊形
     · 勢力是一塊一塊「抬起來」的半透明多邊形 —— 貼近看像一塊藍色果凍
   所以整個換掉：**國界、海岸線、勢力顏色全部直接畫進貼圖**，地球表面就是一張
   地圖，不再有浮在上面的多邊形。資料換成 world-atlas 的 50m（手機）/ 10m（桌機），
   載不到就退回原本的 110m —— 畫面粗一點，但不會壞。

   貼圖分兩層：
     base  海、大陸棚、陸地的綠色與森林顆粒、海岸線 —— 只畫一次
     top   base + 各國勢力的顏色 + 國界線 —— 圖層或勢力變了才重畫
   ============================================================================= */

/* world-atlas 用 ISO 數字碼，遊戲用兩碼英文（iso() 讀 ISO_A2）。對照表由
   i18n-iso-countries 產生，只收 world-atlas 裡真的出現的國家。 */
const ISO_NUM = Object.fromEntries('360:ID,458:MY,152:CL,68:BO,604:PE,32:AR,196:CY,356:IN,156:CN,376:IL,275:PS,422:LB,231:ET,728:SS,706:SO,404:KE,586:PK,454:MW,834:TZ,760:SY,250:FR,740:SR,328:GY,410:KR,408:KP,504:MA,732:EH,188:CR,558:NI,178:CG,180:CD,64:BT,804:UA,112:BY,516:NA,710:ZA,663:MF,534:SX,512:OM,860:UZ,398:KZ,762:TJ,440:LT,76:BR,858:UY,496:MN,643:RU,203:CZ,276:DE,233:EE,428:LV,578:NO,752:SE,246:FI,704:VN,116:KH,442:LU,784:AE,56:BE,268:GE,807:MK,8:AL,31:AZ,792:TR,724:ES,418:LA,417:KG,51:AM,208:DK,434:LY,788:TN,642:RO,348:HU,703:SK,616:PL,372:IE,826:GB,300:GR,894:ZM,694:SL,324:GN,430:LR,140:CF,729:SD,262:DJ,232:ER,40:AT,368:IQ,380:IT,756:CH,364:IR,528:NL,438:LI,384:CI,688:RS,466:ML,686:SN,566:NG,204:BJ,24:AO,191:HR,705:SI,634:QA,682:SA,72:BW,716:ZW,100:BG,764:TH,674:SM,332:HT,214:DO,148:TD,414:KW,222:SV,320:GT,626:TL,96:BN,492:MC,12:DZ,508:MZ,748:SZ,108:BI,646:RW,104:MM,50:BD,20:AD,4:AF,499:ME,70:BA,800:UG,192:CU,340:HN,218:EC,170:CO,600:PY,620:PT,498:MD,795:TM,400:JO,524:NP,426:LS,120:CM,266:GA,562:NE,854:BF,768:TG,288:GH,624:GW,292:GI,840:US,124:CA,484:MX,84:BZ,591:PA,862:VE,598:PG,818:EG,887:YE,478:MR,226:GQ,270:GM,344:HK,336:VA,10:AQ,36:AU,304:GL,242:FJ,554:NZ,540:NC,450:MG,608:PH,144:LK,531:CW,533:AW,44:BS,796:TC,158:TW,392:JP,666:PM,352:IS,612:PN,258:PF,260:TF,690:SC,296:KI,584:MH,780:TT,308:GD,670:VC,52:BB,662:LC,212:DM,581:UM,500:MS,28:AG,659:KN,850:VI,652:BL,630:PR,660:AI,92:VG,388:JM,136:KY,60:BM,334:HM,654:SH,480:MU,174:KM,678:ST,132:CV,470:MT,832:JE,831:GG,833:IM,248:AX,234:FO,86:IO,702:SG,574:NF,184:CK,776:TO,876:WF,882:WS,90:SB,798:TV,462:MV,520:NR,583:FM,239:GS,238:FK,548:VU,570:NU,16:AS,585:PW,316:GU,580:MP,48:BH,446:MO'.split(',').map(p => p.split(':')));

const ATLAS = small => small
  ? ['https://unpkg.com/world-atlas@2/countries-50m.json',
     'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json']
  : ['https://unpkg.com/world-atlas@2/countries-10m.json',
     'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-10m.json',
     'https://unpkg.com/world-atlas@2/countries-50m.json'];

/* TopoJSON → GeoJSON。不引入 topojson-client：用到的只有「弧線還原」這一件事，
   四十行寫得完，多一個 CDN 依賴就多一個會壞的地方。 */
function topoFeatures(topo){
  const tf = topo.transform, obj = topo.objects.countries;
  const arcs = topo.arcs.map(a => {
    let x = 0, y = 0;
    return a.map(p => tf
      ? [ (x += p[0]) * tf.scale[0] + tf.translate[0], (y += p[1]) * tf.scale[1] + tf.translate[1] ]
      : p);
  });
  const ring = ids => {
    const out = [];
    for(const i of ids){
      const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
      a.forEach((p, k) => { if(k || !out.length) out.push(p); });
    }
    return out;
  };
  return obj.geometries.filter(g => g.arcs).map(g => {
    const polys = g.type === 'Polygon' ? [g.arcs] : g.arcs;
    const a2 = ISO_NUM[String(+g.id)] || null;
    const nm = (g.properties && g.properties.name) || '';
    return { type:'Feature', properties:{ ISO_A2: a2 || '-99', NAME: nm, ADMIN: nm },
             geometry:{ type:'MultiPolygon', coordinates: polys.map(p => p.map(ring)) } };
  });
}

/* 一個環畫成路徑。
   ⚠ 跨換日線的國家（俄羅斯、斐濟）經度會從 179 跳到 −179 —— 直接畫會在整張圖上
     拉出一條橫線。所以先把經度「攤平」成連續的，畫一次，超出邊界的再平移 360° 畫一次。
   ⚠ 繞著極點的環（南極洲）攤平之後頭尾差 360°，要補兩個極點的角，不然填色會填到另一邊。 */
function ringPath(ctx, ring, W, H){
  const pts = []; let off = 0, prev = null;
  for(const [lng, lat] of ring){
    if(prev !== null){ const d = lng + off - prev; if(d > 180) off -= 360; else if(d < -180) off += 360; }
    prev = lng + off; pts.push([prev, lat]);
  }
  const span = pts[pts.length-1][0] - pts[0][0];
  if(Math.abs(span) > 300){
    const pole = pts.reduce((s,p) => s + p[1], 0) / pts.length > 0 ? 90 : -90;
    pts.push([pts[pts.length-1][0], pole], [pts[0][0], pole]);
  }
  let mn = Infinity, mx = -Infinity;
  for(const p of pts){ if(p[0] < mn) mn = p[0]; if(p[0] > mx) mx = p[0]; }
  const X = lng => (lng + 180) / 360 * W, Y = lat => (90 - lat) / 180 * H;
  const draw = sh => pts.forEach(([lng,lat], i) => i ? ctx.lineTo(X(lng+sh), Y(lat)) : ctx.moveTo(X(lng+sh), Y(lat)));
  draw(0); ctx.closePath();
  if(mx > 180){ draw(-360); ctx.closePath(); }
  if(mn < -180){ draw(360); ctx.closePath(); }
}
function featPath(ctx, f, W, H){
  const g = f.geometry; if(!g) return;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  for(const poly of polys) for(const r of poly) if(r.length > 2) ringPath(ctx, r, W, H);
}
function landPath(ctx, feats, W, H){
  ctx.beginPath();
  for(const f of feats) featPath(ctx, f, W, H);
}

let BASE = null, TOP = null, TEX = null, FEATS = null, HI = false, SIG = '';
const texSize = () => {
  const small = Math.min(innerWidth, innerHeight) < 700 || /Mobi|Android|iPhone|iPad/.test(navigator.userAgent);
  /* 8K 貼圖要 170MB 左右的顯示記憶體(含 mipmap)。只給回報得出 16K 貼圖上限的
     顯卡 —— 那通常是獨立顯卡或近幾年的桌機內顯;其餘一律 4K。 */
  let W = 4096;
  try{ const mx = G.renderer().capabilities.maxTextureSize; if(!small && mx >= 16384) W = 8192; }catch(e){}
  if(window.__W3D_TEX) W = window.__W3D_TEX;          // 測試截圖用
  return W;
};

/* 陸地依緯度的色帶(極地偏白、沙漠帶偏黃、赤道偏深綠)。整球底圖與近看的局部地圖
   共用同一組,兩邊的顏色才接得起來。 */
const BAND = [[90,'rgba(236,242,244,.95)'],[70,'rgba(190,206,196,.65)'],[62,'rgba(78,118,70,.25)'],
  [45,'rgba(120,160,80,.2)'],[30,'rgba(176,160,98,.34)'],[22,'rgba(196,172,112,.42)'],
  [12,'rgba(110,150,70,.2)'],[0,'rgba(60,120,56,.35)'],[-12,'rgba(110,150,70,.2)'],
  [-25,'rgba(186,160,104,.36)'],[-40,'rgba(110,150,80,.2)'],[-62,'rgba(190,206,196,.65)'],
  [-90,'rgba(240,244,246,.95)']];
function bandGrad(c, y0, y1, latTop, latBot){
  const g = c.createLinearGradient(0, y0, 0, y1);
  for(const [lat, col] of BAND){
    const t = (latTop - lat) / (latTop - latBot);
    if(t >= 0 && t <= 1) g.addColorStop(t, col);
  }
  // 範圍外的色帶也要補上端點,不然局部地圖的頂端與底端會變透明
  const at = lat => { for(let i = 1; i < BAND.length; i++) if(lat >= BAND[i][0]) return BAND[i-1][1]; return BAND[BAND.length-1][1]; };
  g.addColorStop(0, at(latTop)); g.addColorStop(1, at(latBot));
  return g;
}

/* 底圖：海 + 大陸棚 + 綠色陸地 + 森林顆粒 + 海岸線。 */
function paintBase(feats){
  const W = texSize(), H = W / 2, k = W / 4096;
  const cv = BASE || document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  const rnd = vrand(20260926);

  // 海：參考畫面那種偏亮的藍，兩極稍暗
  const sea = c.createLinearGradient(0, 0, 0, H);
  sea.addColorStop(0, '#24557a'); sea.addColorStop(.28, '#2c6c99');
  sea.addColorStop(.5, '#3178a8'); sea.addColorStop(.72, '#2c6c99'); sea.addColorStop(1, '#24557a');
  c.fillStyle = sea; c.fillRect(0, 0, W, H);
  for(let i = 0; i < 700; i++){            // 深淺斑，讓海不是一片死的顏色
    const x = rnd()*W, y = rnd()*H, r = (0.006 + rnd()*0.03) * W;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rnd() < .5 ? 'rgba(90,170,215,.10)' : 'rgba(10,40,70,.12)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(x-r, y-r, r*2, r*2);
  }
  // 大陸棚：陸地外圍一圈淺藍（淺海），寬窄兩層
  landPath(c, feats, W, H);
  c.save();
  c.fillStyle = '#4a9bc9';
  c.shadowColor = 'rgba(100,190,230,.75)'; c.shadowBlur = 26*k; c.fill();
  c.shadowColor = 'rgba(150,215,240,.8)';  c.shadowBlur = 7*k;  c.fill();
  c.restore();

  // 陸地：綠色為主，極地偏白、沙漠帶帶一點黃 —— 但比例壓低，整體還是一張綠色地圖
  c.save(); landPath(c, feats, W, H); c.clip();
  c.fillStyle = '#6e9a4c'; c.fillRect(0, 0, W, H);
  c.fillStyle = bandGrad(c, 0, H, 90, -90); c.fillRect(0, 0, W, H);
  for(let i = 0; i < 900; i++){             // 高低起伏的大斑塊
    const x = rnd()*W, y = rnd()*H, r = (0.003 + rnd()*rnd()*0.022) * W;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rnd() < .5 ? 'rgba(210,225,160,.16)' : 'rgba(30,60,25,.2)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(x-r, y-r, r*2, r*2);
  }
  /* 森林顆粒:參考畫面陸地上那層「樹」的質感。
     ⚠ 不要在大圖上一顆一顆畫 —— 第一版畫了九萬個小圓,畫布是 GPU 加速的,
       九萬個指令直接觸發 GPU 看門狗,**整顆地球的 WebGL context 掉了**。
       現在只在一張 512 的小圖塊上畫,再用 pattern 鋪滿:指令數少兩百倍。 */
  const tile = document.createElement('canvas'); tile.width = tile.height = 512;
  const tc = tile.getContext('2d');
  for(let i = 0; i < 1400; i++){
    tc.fillStyle = rnd() < .75 ? 'rgba(34,74,30,.30)' : 'rgba(190,215,140,.18)';
    const r = 1 + rnd()*2.2;
    tc.beginPath(); tc.arc(rnd()*512, rnd()*512, r, 0, 6.283); tc.fill();
  }
  const pat = c.createPattern(tile, 'repeat');
  c.save();
  c.scale(k, k);                        // 小點在 4K 與 8K 的貼圖上看起來一樣大
  c.fillStyle = pat;
  const top = H * (24/180) / k, bot = H * (156/180) / k;   // 極圈以內才有樹
  c.fillRect(0, top, W / k, bot - top);
  c.restore();
  c.restore();
  // 海岸線：一道淺色細邊
  landPath(c, feats, W, H);
  c.lineWidth = 1.6*k; c.strokeStyle = 'rgba(225,245,235,.75)'; c.stroke();
  BASE = cv;
}

/* 上層：底圖 + 勢力顏色 + 國界。只有在「誰的顏色」變了才重畫 —— 每一次點擊都重畫
   一張 8K 貼圖，手機會卡。 */
function paintTop(force){
  if(!BASE || !TEX || !FEATS || typeof tyCountryColor !== 'function' || !TY) return;
  const cols = FEATS.map(f => { try{ return tyCountryColor(f); }catch(e){ return ''; } });
  const sig = (typeof TY_LAYER !== 'undefined' ? TY_LAYER : '') + '|' + cols.join('|');
  if(!force && sig === SIG) return;
  SIG = sig;
  const W = BASE.width, H = BASE.height, k = W / 4096;
  const cv = TOP; cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.drawImage(BASE, 0, 0);
  FEATS.forEach((f, i) => {
    const m = /,\s*([\d.]+)\)$/.exec(cols[i] || '');
    if(!m || +m[1] < .09) return;            // 沒人管的國家不上色，維持原本的綠
    c.beginPath(); featPath(c, f, W, H);
    c.fillStyle = cols[i].replace(/,\s*([\d.]+)\)$/, (s, a) => `,${Math.min(.72, +a * 1.6).toFixed(3)})`);
    c.fill();
    // 有主的國家描一圈同色的粗邊 —— 參考畫面裡「這塊是誰的」主要是靠邊框看出來的
    c.lineWidth = 3.2*k; c.strokeStyle = cols[i].replace(/,\s*([\d.]+)\)$/, ',.95)');
    c.stroke();
  });
  // 國界：白色細線，跟參考畫面一樣
  c.beginPath(); for(const f of FEATS) featPath(c, f, W, H);
  c.lineWidth = 1.3*k; c.strokeStyle = 'rgba(255,255,255,.55)'; c.stroke();
  TEX.needsUpdate = true;
}

/* 把 canvas 直接當貼圖。先用一張 2×1 的小圖讓 globe.gl 建好 Texture，
   再從它身上撿回 Texture 建構子 —— 跟撿 THREE 的其他建構子同一招。
   之後每次重畫只要 needsUpdate，不用再轉 dataURL（8K 的 JPEG 編碼要好幾百毫秒）。 */
function mountTex(){
  if(TEX) return true;
  let m; try{ m = G.globeMaterial(); }catch(e){ return false; }
  if(!m || !m.map || !m.map.isTexture) return false;
  const Tex = m.map.constructor;
  TOP = document.createElement('canvas');
  const t = new Tex(TOP);
  t.colorSpace = m.map.colorSpace;
  try{ t.anisotropy = G.renderer().capabilities.getMaxAnisotropy(); }catch(e){}
  m.map = t; m.needsUpdate = true;
  TEX = t;
  return true;
}

let painting = false;
function paintSkin(){
  if(W3D.textured || painting || !G) return;
  if(typeof countries === 'undefined' || !countries || !countries.length) return;
  painting = true;
  const tiny = document.createElement('canvas'); tiny.width = 2; tiny.height = 1;
  G.globeImageUrl(tiny.toDataURL());
  let tries = 0;
  const wait = () => {
    if(mountTex()){
      FEATS = countries; paintBase(FEATS); paintTop(true);
      W3D.textured = true; painting = false;
      W3D.material();
      if(typeof tyPaintGlobe === 'function') tyPaintGlobe();
      loadHiRes();
      return;
    }
    if(++tries < 100) setTimeout(wait, 100); else painting = false;
  };
  setTimeout(wait, 50);
}
/* 高解析度國界在背景抓，抓到了換上去。抓不到就留著 110m —— 不報錯，只是粗一點。 */
async function loadHiRes(){
  if(HI) return; HI = true;
  const small = texSize() <= 4096;
  for(const u of ATLAS(small)){
    try{
      const r = await fetch(u); if(!r.ok) continue;
      const topo = await r.json();
      if(!topo || !topo.objects || !topo.objects.countries) continue;
      const feats = topoFeatures(topo).filter(f => f.properties.NAME !== 'Antarctica');
      if(feats.length < 100) continue;
      FEATS = feats; W3D.hiFeats = feats;
      paintBase(FEATS); paintTop(true);
      patchDirty = true; patchSoon();
      return;
    }catch(e){ /* 換下一個來源 */ }
  }
}

/* =============================================================================
   1.5 近看的高解析度局部地圖
   -----------------------------------------------------------------------------
   使用者截圖:貼近台灣的時候海岸線是一格一格的像素。一張貼圖包整顆地球,
   8K 寬也只有每度 23 個像素 —— 貼近到看得見一個縣的時候一定會糊。
   參考的那款遊戲近看永遠是清楚的線,因為它是**向量**畫的。

   這裡的做法:拉近到一定高度以下,針對「畫面看得到的那一塊」另外畫一張
   2048 的 canvas(同一套配色、同一份國界),貼在一片貼著球面的曲面上。
   那一塊的解析度是整張貼圖的十幾倍;鏡頭移出去或拉近太多就重畫一次。
   邊緣淡出,跟底下的整球貼圖接起來看不到接縫。
   ============================================================================= */
let PATCH = null;          // { mesh, cv, tex, la0, la1, lo0, lo1, alt }
let patchTimer = 0, patchDirty = false;
/* 高於這個高度就不用局部地圖。
   ⚠ 不能太高:範圍一大(超過一百度),曲面的每一格弦會切進球面底下,
     被地球本身擋住,畫面上變成一條橫跨地球的條紋(實際發生過)。 */
const PATCH_ALT = .62;
const FAR_ALT = .95;       // 高於這個高度,部隊改用方形兵種圖示

function featBox(f){
  if(f._box) return f._box;
  let a = 90, b = -90, c = 180, d = -180;
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for(const p of polys) for(const [lng, lat] of p[0]){ if(lat < a) a = lat; if(lat > b) b = lat; if(lng < c) c = lng; if(lng > d) d = lng; }
  return (f._box = [a, b, c, d]);
}
/* 在局部地圖上畫一個環。經度先平移到離這一塊中心 ±180° 以內 ——
   不然跨換日線的那一邊會被畫到畫面另一頭去。 */
function patchRing(ctx, ring, P, W, H){
  const mid = (P.lo0 + P.lo1) / 2;
  const X = lng => { let d = lng - mid; d -= Math.round(d / 360) * 360; return (mid + d - P.lo0) / (P.lo1 - P.lo0) * W; };
  const Y = lat => (P.la1 - lat) / (P.la1 - P.la0) * H;
  ring.forEach(([lng, lat], i) => i ? ctx.lineTo(X(lng), Y(lat)) : ctx.moveTo(X(lng), Y(lat)));
  ctx.closePath();
}
function patchFeatPath(ctx, f, P, W, H){
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for(const poly of polys) for(const r of poly) if(r.length > 2) patchRing(ctx, r, P, W, H);
}
/* 花紋要釘在經緯度上(不是釘在這張 canvas 上),不然鏡頭一動、重畫一次,
   森林就整片跳一下。 */
function anchoredPattern(c, tile, degPerTile, P, W, H){
  const pat = c.createPattern(tile, 'repeat');
  const sx = W / (P.lo1 - P.lo0) * degPerTile / tile.width;
  const sy = H / (P.la1 - P.la0) * degPerTile / tile.height;
  const ox = (-180 - P.lo0) / (P.lo1 - P.lo0) * W, oy = (P.la1 - 90) / (P.la1 - P.la0) * H;
  if(pat.setTransform && typeof DOMMatrix === 'function') pat.setTransform(new DOMMatrix([sx, 0, 0, sy, ox, oy]));
  return pat;
}
let TILE_F = null, TILE_B = null;
function tiles(){
  if(TILE_F) return;
  const rnd = vrand(4242);
  TILE_F = document.createElement('canvas'); TILE_F.width = TILE_F.height = 512;
  const a = TILE_F.getContext('2d');
  /* 貼在邊上的點要在對邊再畫一次,圖塊重複的時候才接得起來 ——
     不然整片陸地會浮出一格一格的方塊接縫。 */
  for(let i = 0; i < 1700; i++){
    a.fillStyle = rnd() < .75 ? 'rgba(34,74,30,.30)' : 'rgba(190,215,140,.18)';
    const x = rnd()*512, y = rnd()*512, r = 1.2 + rnd()*2.6;
    for(const dx of [-512, 0, 512]) for(const dy of [-512, 0, 512]){
      if(x+dx < -r || x+dx > 512+r || y+dy < -r || y+dy > 512+r) continue;
      a.beginPath(); a.arc(x+dx, y+dy, r, 0, 6.283); a.fill();
    }
  }
  TILE_B = document.createElement('canvas'); TILE_B.width = TILE_B.height = 512;
  const b = TILE_B.getContext('2d');
  for(let i = 0; i < 70; i++){
    const x = rnd()*512, y = rnd()*512, r = 14 + rnd()*60;
    for(const dx of [-512, 0, 512]) for(const dy of [-512, 0, 512]){   // 讓圖塊可以無縫重複
      const g = b.createRadialGradient(x+dx, y+dy, 0, x+dx, y+dy, r);
      g.addColorStop(0, rnd() < .5 ? 'rgba(210,225,160,.16)' : 'rgba(30,60,25,.2)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      b.fillStyle = g; b.fillRect(x+dx-r, y+dy-r, r*2, r*2);
    }
  }
}
function paintPatch(P){
  tiles();
  const cv = P.cv, W = cv.width, H = cv.height, c = cv.getContext('2d');
  const ppd = W / (P.lo1 - P.lo0);                         // 每度幾個像素
  const feats = (FEATS || []).filter(f => {
    const [a, b, cc, d] = featBox(f);
    if(b < P.la0 || a > P.la1) return false;
    if(d - cc > 300) return true;                          // 跨換日線的大國:保留,讓 patchRing 處理
    const mid = (P.lo0 + P.lo1) / 2, half = (P.lo1 - P.lo0) / 2;
    let dc = ((cc + d) / 2 - mid); dc -= Math.round(dc / 360) * 360;
    return Math.abs(dc) <= half + (d - cc) / 2;
  });
  // 海
  const sea = c.createLinearGradient(0, 0, 0, H);
  const seaAt = lat => { const t = Math.abs(lat) / 90; return `rgb(${Math.round(49-12*t)},${Math.round(120-33*t)},${Math.round(168-46*t)})`; };
  sea.addColorStop(0, seaAt(P.la1)); sea.addColorStop(1, seaAt(P.la0));
  c.fillStyle = sea; c.fillRect(0, 0, W, H);
  const land = () => { c.beginPath(); for(const f of feats) patchFeatPath(c, f, P, W, H); };
  // 淺海
  land();
  c.save(); c.fillStyle = '#4a9bc9';
  c.shadowColor = 'rgba(100,190,230,.75)'; c.shadowBlur = Math.min(60, ppd * .9); c.fill();
  c.shadowColor = 'rgba(150,215,240,.8)';  c.shadowBlur = Math.min(24, ppd * .25); c.fill();
  c.restore();
  // 陸地:底色 + 依緯度的色帶 + 釘在經緯度上的斑塊與森林
  c.save(); land(); c.clip();
  c.fillStyle = '#6e9a4c'; c.fillRect(0, 0, W, H);
  c.fillStyle = bandGrad(c, 0, H, P.la1, P.la0); c.fillRect(0, 0, W, H);
  c.fillStyle = anchoredPattern(c, TILE_F, 1.2, P, W, H); c.fillRect(0, 0, W, H);
  c.restore();
  // 勢力顏色
  if(typeof tyCountryColor === 'function' && TY){
    for(const f of feats){
      let col = ''; try{ col = tyCountryColor(f); }catch(e){}
      const m = /,\s*([\d.]+)\)$/.exec(col);
      if(!m || +m[1] < .09) continue;
      c.beginPath(); patchFeatPath(c, f, P, W, H);
      c.fillStyle = col.replace(/,\s*([\d.]+)\)$/, (s, a) => `,${Math.min(.72, +a * 1.6).toFixed(3)})`); c.fill();
      c.lineWidth = 3.5; c.strokeStyle = col.replace(/,\s*([\d.]+)\)$/, ',.95)'); c.stroke();
    }
  }
  // 國界與海岸線:固定像素寬,永遠是清楚的細線
  land(); c.lineWidth = 1.6; c.strokeStyle = 'rgba(255,255,255,.6)'; c.stroke();
  // 邊緣淡出,跟整球貼圖接起來
  c.save(); c.globalCompositeOperation = 'destination-in';
  const e = Math.round(Math.min(W, H) * .08);
  const gx = c.createLinearGradient(0, 0, W, 0);
  gx.addColorStop(0, 'rgba(0,0,0,0)'); gx.addColorStop(e / W, '#000'); gx.addColorStop(1 - e / W, '#000'); gx.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = gx; c.fillRect(0, 0, W, H);
  const gy = c.createLinearGradient(0, 0, 0, H);
  gy.addColorStop(0, 'rgba(0,0,0,0)'); gy.addColorStop(e / H, '#000'); gy.addColorStop(1 - e / H, '#000'); gy.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = gy; c.fillRect(0, 0, W, H);
  c.restore();
  P.tex.needsUpdate = true;
}
/* 貼著球面的那一片曲面:經緯度網格,每一點用 getCoords 算 —— 跟建築同一個座標系。 */
function patchGeo(P){
  // 格子依範圍加密:每格不超過 1 度,弦才不會切進球面
  const N = clamp(Math.ceil(Math.max(P.la1 - P.la0, P.lo1 - P.lo0) / 1), 24, 140), pos = [], uv = [], nor = [], idx = [];
  for(let j = 0; j <= N; j++) for(let i = 0; i <= N; i++){
    const lat = P.la0 + (P.la1 - P.la0) * j / N, lng = P.lo0 + (P.lo1 - P.lo0) * i / N;
    const q = G.getCoords(lat, lng, .0004);
    pos.push(q.x, q.y, q.z);
    const l = Math.hypot(q.x, q.y, q.z) || 1; nor.push(q.x/l, q.y/l, q.z/l);
    uv.push(i / N, j / N);
  }
  for(let j = 0; j < N; j++) for(let i = 0; i < N; i++){
    const a = j*(N+1)+i, b = a+1, c = a+N+1, d = c+1;
    idx.push(a, b, d, a, d, c);
  }
  const g = new T.BG();
  g.setAttribute('position', new T.Attr(new Float32Array(pos), 3));
  g.setAttribute('normal', new T.Attr(new Float32Array(nor), 3));
  g.setAttribute('uv', new T.Attr(new Float32Array(uv), 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}
function patchHost(){
  let host = null;
  try{
    const gm = G.globeMaterial();
    G.scene().traverse(o => { if(!host && o.isMesh === true && o.material === gm) host = o.parent; });
  }catch(e){}
  return host;
}
function patchCheck(){
  patchTimer = 0;
  if(!W3D.ok || !TEX || !FEATS) return;
  const alt = W3D.alt;
  if(alt > PATCH_ALT){ if(PATCH) PATCH.mesh.visible = false; return; }
  const pov = W3D.pov(); if(!pov) return;
  const el = G.renderer().domElement, asp = Math.max(.4, (el.clientWidth || 1) / (el.clientHeight || 1));
  const half = clamp(alt * 26.7 * 1.55, 1.2, 40);          // 看得到的半高(度),多留一截給傾斜與邊緣淡出
  const lat = clamp(pov.lat, -80, 80);
  const halfLng = Math.min(170, half * asp / Math.max(.2, Math.cos(lat * Math.PI / 180)));
  if(PATCH && !patchDirty && PATCH.mesh.visible){
    const inLat = Math.abs(lat - (PATCH.la0 + PATCH.la1) / 2) < (PATCH.la1 - PATCH.la0) * .22;
    let dl = pov.lng - (PATCH.lo0 + PATCH.lo1) / 2; dl -= Math.round(dl / 360) * 360;
    const inLng = Math.abs(dl) < (PATCH.lo1 - PATCH.lo0) * .22;
    const r = alt / PATCH.alt;
    if(inLat && inLng && r > .72 && r < 1.35) return;       // 還在這一片裡面,不用重畫
  }
  patchDirty = false;
  const P = PATCH || {};
  P.la0 = clamp(lat - half, -89, 89); P.la1 = clamp(lat + half * 1.25, -89, 89);   // 北邊多留:傾斜時看得比較遠
  P.lo0 = pov.lng - halfLng; P.lo1 = pov.lng + halfLng; P.alt = alt;
  const small = texSize() <= 4096;
  const M = small ? 1536 : 2048;
  const rw = (P.lo1 - P.lo0) * Math.cos(lat * Math.PI / 180), rh = P.la1 - P.la0;
  if(!P.cv){ P.cv = document.createElement('canvas'); }
  P.cv.width = rw >= rh ? M : Math.max(256, Math.round(M * rw / rh));
  P.cv.height = rh >= rw ? M : Math.max(256, Math.round(M * rh / rw));
  if(!P.tex){
    P.tex = new TEX.constructor(P.cv);
    P.tex.colorSpace = TEX.colorSpace;
    try{ P.tex.anisotropy = G.renderer().capabilities.getMaxAnisotropy(); }catch(e){}
    P.mat = new T.Phong({ map: P.tex, transparent: true, shininess: 4,
                          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    P.mat.depthWrite = false;
  }
  paintPatch(P);
  P.tex.needsUpdate = true;
  const geo = patchGeo(P);
  if(!P.mesh){
    P.mesh = new T.Mesh(geo, P.mat);
    P.mesh.renderOrder = 1;
    const host = patchHost(); if(!host){ return; }
    host.add(P.mesh);
  }else{ P.mesh.geometry.dispose(); P.mesh.geometry = geo; }
  P.mesh.visible = true;
  PATCH = P;
}
function patchSoon(){ clearTimeout(patchTimer); patchTimer = setTimeout(patchCheck, 160); }

W3D.repaint = () => { const before = SIG; paintTop(false); if(SIG !== before){ patchDirty = true; patchSoon(); } };
W3D._topo = topoFeatures;            // 給測試用:國界解碼要驗得到

/* 點在球面上的哪一國。高解析度國界到了就用它（岸邊不會點錯國），不然用 110m。 */
function pip(pt, ring){
  let inside = false;
  for(let i = 0, j = ring.length - 1; i < ring.length; j = i++){
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if(((yi > pt[1]) !== (yj > pt[1])) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
W3D.featAt = function(lat, lng){
  const list = FEATS || (typeof countries !== 'undefined' ? countries : []);
  for(const f of list){
    const g = f.geometry; if(!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for(const poly of polys){
      if(!poly[0] || !pip([lng, lat], poly[0])) continue;
      if(poly.slice(1).some(h => pip([lng, lat], h))) continue;   // 在湖（洞）裡
      return f;
    }
  }
  return null;
};

/* 讓貼圖自己的顏色出來：底色白、不自發光。
   參考的那款遊戲沒有「夜晚」—— 整顆球都要看得清楚，所以環境光也開大。 */
W3D.material = function(){
  if(!G || !W3D.textured) return false;
  try{
    const m = G.globeMaterial();
    m.color && m.color.set('#ffffff');
    m.emissive && m.emissive.set('#000000');
    if('shininess' in m) m.shininess = 4;
    if('bumpScale' in m) m.bumpScale = 0;
    m.needsUpdate = true;
    return true;
  }catch(e){ return false; }
};

/* =============================================================================
   2. 3D 建築
   -----------------------------------------------------------------------------
   座標系：每一座小城自己的座標，z 朝天、y 朝北、單位是 globe.gl 的長度
   （球半徑 100）。最後用 lookAt 把 +z 對準地表法線立起來。
   所有東西合併成**一個**網格（一個據點一次 draw call），顏色放在頂點上。
   ============================================================================= */
const PAL = {
  estate:['#e8932a','#ffd27a'], hotel:['#d9463b','#ff9b8c'], roof:['#b8452c','#e0714e'],
  biz:['#8e44c9','#dcaef7'], paper:['#2376c9','#9fd2ff'], gold:['#c9a227','#ffe7a0'],
  cash:['#239a4b','#9ff0b5'], hold:['#c8322a','#ffb3aa'], real:['#7c7f8c','#d4d6de'],
  shell:['#8a8a94','#cfcfd6'], glass:['#7fd0ff','#d8f1ff'],
};
function lin(hex, k){
  const c = new T.Color(hex);
  return [c.r*(k||1), c.g*(k||1), c.b*(k||1)];
}
function GB(){ return { p:[], n:[], c:[] }; }
function tri(g, a, b, c, col){
  const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2], vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
  let nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
  const l = Math.hypot(nx,ny,nz) || 1; nx/=l; ny/=l; nz/=l;
  for(const p of [a,b,c]){ g.p.push(p[0],p[1],p[2]); g.n.push(nx,ny,nz); g.c.push(col[0],col[1],col[2]); }
}
const quad = (g,a,b,c,d,col) => { tri(g,a,b,c,col); tri(g,a,c,d,col); };
/* 一個方塊。側面稍暗、頂面稍亮 —— 光再打上去，就算在很小的螢幕上也看得出是立體的。 */
function box(g, cx, cy, z0, w, d, h, side, top){
  const x0=cx-w/2, x1=cx+w/2, y0=cy-d/2, y1=cy+d/2, z1=z0+h;
  quad(g,[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1], top);
  quad(g,[x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1], side);
  quad(g,[x1,y1,z0],[x0,y1,z0],[x0,y1,z1],[x1,y1,z1], side);
  quad(g,[x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[x1,y0,z1], side);
  quad(g,[x0,y1,z0],[x0,y0,z0],[x0,y0,z1],[x0,y1,z1], side);
  return z1;
}
/* 正 n 邊形柱：地磚（六角）與油槽（八角） */
function prism(g, cx, cy, z0, r, h, n, side, top, rot){
  const z1 = z0 + h, pts = [];
  for(let i = 0; i < n; i++){ const a = (rot||0) + i/n*Math.PI*2; pts.push([cx + Math.cos(a)*r, cy + Math.sin(a)*r]); }
  for(let i = 0; i < n; i++){
    const p = pts[i], q = pts[(i+1)%n];
    quad(g,[p[0],p[1],z0],[q[0],q[1],z0],[q[0],q[1],z1],[p[0],p[1],z1], side);
    tri(g,[cx,cy,z1],[p[0],p[1],z1],[q[0],q[1],z1], top);
  }
  return z1;
}
/* 四角錐屋頂 */
function pyramid(g, cx, cy, z0, w, h, col){
  const x0=cx-w/2, x1=cx+w/2, y0=cy-w/2, y1=cy+w/2, ap=[cx,cy,z0+h];
  tri(g,[x0,y0,z0],[x1,y0,z0],ap,col); tri(g,[x1,y0,z0],[x1,y1,z0],ap,col);
  tri(g,[x1,y1,z0],[x0,y1,z0],ap,col); tri(g,[x0,y1,z0],[x0,y0,z0],ap,col);
}

/* 一棟建築的長相，照 tySiteBuildings() 給的類型（c）與樓層（f）。
   樓層 1–7 已經是 log 壓縮過的（見 tyFloors），這裡直接線性換成高度。 */
function drawBuilding(g, b, x, y, z){
  const P = k => PAL[k] || PAL.shell;
  const S = (k, m) => lin(P(k)[0], m||.82), Tp = (k, m) => lin(P(k)[1], m||1);
  const f = b.f || 1;
  switch(b.c){
    case 'estate':
      if(f >= 5){                                   // 旅館：五棟房子換一間
        const t = box(g, x, y, z, .26, .2, .95, S('hotel'), Tp('hotel'));
        box(g, x, y, t, .18, .12, .06, S('roof'), Tp('roof'));
      }else{                                        // 房子：方塊 + 尖屋頂
        const t = box(g, x, y, z, .2, .2, .16, S('estate'), Tp('estate'));
        pyramid(g, x, y, t, .24, .13, lin(PAL.roof[0]));
      }
      break;
    case 'biz': {                                   // 事業：塔樓 + 退縮 + 天線
      const h = .3 + f*.26;
      const t = box(g, x, y, z, .26, .26, h, S('biz'), Tp('biz'));
      const t2 = box(g, x, y, t, .17, .17, h*.22, S('biz', .95), Tp('biz'));
      box(g, x, y, t2, .025, .025, .18, lin('#e8e8f0'), lin('#ffffff'));
      if(b.st === 'pub') box(g, x, y, t2 + .18, .06, .06, .06, lin('#2997ff', 1.2), lin('#9fd2ff', 1.3));
      break; }
    case 'paper': {                                 // 金融資產：玻璃大樓
      const h = .25 + f*.24;
      const t = box(g, x, y, z, .22, .22, h, S('paper'), Tp('glass'));
      box(g, x, y, t, .12, .12, .05, S('glass'), Tp('glass'));
      break; }
    case 'real': {                                  // 原物料：油槽
      const h = .12 + f*.08;
      prism(g, x, y, z, .12, h, 10, S('real'), Tp('real'));
      break; }
    case 'gold':                                    // 黃金：一疊金條
      for(let i = 0; i < Math.min(4, 1 + Math.ceil(f/2)); i++)
        box(g, x + (i%2 ? .04 : -.04), y, z + i*.055, .2, .09, .05, S('gold', .9), Tp('gold', 1.1));
      break;
    case 'cash':                                    // 現金：一疊鈔票
      for(let i = 0; i < 3; i++) box(g, x, y + (i%2 ? .02 : -.02), z + i*.045, .2, .13, .04, S('cash'), Tp('cash'));
      break;
    case 'hold': {                                  // 控股層：紅色堡壘 + 金頂
      const t = box(g, x, y, z, .26, .26, .42, S('hold'), Tp('hold'));
      pyramid(g, x, y, t, .26, .16, lin('#e0b23c'));
      break; }
    default:                                        // 空殼：一個淡淡的小盒子
      box(g, x, y, z, .16, .16, .12, S('shell', .6), Tp('shell', .7));
  }
}
const SLOTS = [[0,0],[-.29,.2],[.29,.2],[-.29,-.2],[.29,-.2]];
const TILE_R = .62;

function geoFor(key, fill){
  if(GEO_CACHE.has(key)) return GEO_CACHE.get(key);
  const g = GB(); fill(g);
  const geo = new T.BG();
  geo.setAttribute('position', new T.Attr(new Float32Array(g.p), 3));
  geo.setAttribute('normal', new T.Attr(new Float32Array(g.n), 3));
  geo.setAttribute('color', new T.Attr(new Float32Array(g.c), 3));
  geo.computeBoundingSphere();
  if(GEO_CACHE.size > 160) GEO_CACHE.clear();      // 很長的一局不要無限累積
  GEO_CACHE.set(key, geo);
  return geo;
}

/* =============================================================================
   部隊棋子 —— 參考畫面裡那些站在地圖上的戰車與船
   -----------------------------------------------------------------------------
   一支部隊 = 一塊隊伍顏色的六角底座 + 一個看得出兵種的模型。
   同一個城市駐了好幾支就並排站在同一塊底座上（最多畫三個，其餘看標籤上的 ×N）。
   在路上的部隊如果正在海上，就畫成一艘船 —— 參考那款遊戲的海上單位。
   ============================================================================= */
const TEAM = '#2f8fe0';
function drawUnit(g, k, x, y, z, tint){
  const T2 = tint || TEAM;
  switch(k){
    case 'raid': {                                  // 併購小組:戰車
      const hull = lin('#5d6b45'), top = lin('#7d8d5c');
      const t = box(g, x, y, z, .34, .2, .08, hull, top);
      box(g, x - .02, y, t, .17, .14, .07, lin('#6c7b50'), lin('#8fa068'));
      box(g, x + .13, y, t + .025, .2, .03, .03, lin('#3d472e'), lin('#56623f'));
      box(g, x, y - .115, z, .36, .03, .05, lin('#2b2f24'), lin('#3b4031'));   // 履帶
      box(g, x, y + .115, z, .36, .03, .05, lin('#2b2f24'), lin('#3b4031'));
      box(g, x - .1, y + .05, t + .07, .015, .015, .12, lin('#cccccc'), lin('#ffffff'));
      box(g, x - .06, y + .05, t + .16, .08, .01, .05, lin(T2, .9), lin(T2, 1.1)); // 小旗
      break; }
    case 'law': {                                   // 律師團:法院(柱廊 + 三角山牆)
      const w = lin('#e9e6dc'), wt = lin('#ffffff');
      const t = box(g, x, y, z, .32, .22, .04, lin('#c9c4b6'), wt);
      for(const cx of [-.11, -.037, .037, .11]) box(g, x + cx, y - .06, t, .028, .028, .15, w, wt);
      box(g, x, y + .03, t, .28, .1, .15, lin('#d8d3c6'), wt);
      const r = box(g, x, y, t + .15, .34, .24, .035, w, wt);
      pyramid(g, x, y, r, .3, .08, lin(T2, 1));
      break; }
    case 'lobby': {                                 // 遊說團:講台 + 旗子
      const t = box(g, x, y, z, .16, .12, .15, lin('#6b4a2e'), lin('#8a6440'));
      box(g, x, y - .02, t, .12, .05, .02, lin('#2a2a2a'), lin('#444'));
      box(g, x + .1, y + .04, z, .014, .014, .38, lin('#bbbbbb'), lin('#eeeeee'));
      box(g, x + .18, y + .04, z + .28, .16, .01, .1, lin(T2, .95), lin(T2, 1.15));
      break; }
    case 'mgr': {                                   // 經理人:西裝人像 + 公事包
      const suit = lin('#2d3440'), sk = lin('#e2b894');
      const t = prism(g, x, y, z, .065, .19, 8, suit, lin('#3c4556'));
      prism(g, x, y, t, .05, .075, 8, sk, lin('#f0c9a4'));
      box(g, x, y - .062, t - .06, .03, .012, .06, lin(T2), lin(T2, 1.2));      // 領帶
      box(g, x + .1, y, z, .1, .04, .08, lin('#5a3a22'), lin('#7a5234'));        // 公事包
      break; }
    case 'ship': {                                  // 海上:一艘船
      const hull = lin('#5f6b78'), deck = lin('#8a96a2');
      const t = box(g, x - .04, y, z, .36, .15, .07, hull, deck);
      tri(g, [x + .14, y - .075, z], [x + .26, y, z], [x + .14, y - .075, t], hull);
      tri(g, [x + .14, y + .075, t], [x + .26, y, z], [x + .14, y + .075, z], hull);
      tri(g, [x + .14, y - .075, t], [x + .26, y, z], [x + .14, y + .075, t], deck);
      const b = box(g, x - .08, y, t, .13, .1, .08, lin('#d9dde2'), lin('#f4f6f8'));
      box(g, x - .08, y, b, .03, .03, .08, lin(T2), lin(T2, 1.2));
      break; }
  }
}
function troopKey(d){
  if(d._threat) return `th:${d._r.id}:${d._sea ? 1 : 0}`;
  return `tr:${d._sea ? 'ship' : d._units.slice(0, 3).map(u => u.k).join(',')}`;
}
function buildTroop(d){
  const col = d._threat ? `rgb(${(typeof TY_RVCOL !== 'undefined' && TY_RVCOL[d._r.id]) || '255,69,58'})` : TEAM;
  const kinds = d._threat ? [d._sea ? 'ship' : 'raid'] : d._sea ? ['ship'] : d._units.slice(0, 3).map(u => u.k);
  const key = troopKey(d);
  return geoFor(key, g => {
    const n = kinds.length, r = .22 + n * .13;
    const z = prism(g, 0, 0, 0, r, .05, 6, lin(col, .55), lin(col, .95), Math.PI/6);
    prism(g, 0, 0, z, r * .84, .01, 6, lin('#1a2a36'), lin(d._threat ? '#3a1414' : '#1f3a52'), Math.PI/6);
    kinds.forEach((k, i) => drawUnit(g, k, (i - (n - 1) / 2) * .36, 0, z + .01, col));
  });
}

/* 一個據點（或一個對手大本營）的整座小城 */
function buildSite(d){
  if(d._units || d._threat){
    const root = new T.O3();
    root.add(new T.Mesh(buildTroop(d), MAT));
    root.userData.site = d;
    root.userData.troop = true;
    root.visible = !FAR;
    OBJS.add(root);
    return root;
  }
  let key, fill;
  if(d._rival){
    const col = `rgb(${(typeof TY_RVCOL !== 'undefined' && TY_RVCOL[d._rival.id]) || '160,160,170'})`;
    const h = .45 + (d._rvk || 0) * .9;
    key = `rv:${d._rival.id}:${h.toFixed(2)}`;
    fill = g => {
      const z = prism(g, 0, 0, 0, TILE_R*.8, .07, 6, lin(col, .45), lin(col, .75), Math.PI/6);
      const t = box(g, 0, 0, z, .24, .24, h, lin(col, .7), lin(col, 1.1));
      pyramid(g, 0, 0, t, .24, .2, lin(col, 1.2));
      box(g, -.22, .12, z, .14, .14, h*.45, lin(col, .55), lin(col, .9));
      box(g, .2, -.14, z, .14, .14, h*.3, lin(col, .55), lin(col, .9));
    };
  }else{
    const blds = (d._blds || []).slice().sort((a,b) => (b.f||1) - (a.f||1));
    const catCol = (d._col && d._col[0] === '#') ? d._col : '#4fc3f7';
    key = `me:${d._cat}:${blds.map(b => b.c + b.f + (b.st||'')).join(',')}`;
    fill = g => {
      const z = prism(g, 0, 0, 0, TILE_R, .07, 6, lin(catCol, .35), lin(catCol, .6), Math.PI/6);
      prism(g, 0, 0, z, TILE_R*.86, .012, 6, lin('#0d1d2a'), lin('#16303f'), Math.PI/6);
      blds.forEach((b, i) => { const s = SLOTS[i] || SLOTS[0]; drawBuilding(g, b, s[0], s[1], z + .012); });
    };
  }
  const geo = geoFor(key, fill);
  const mesh = new T.Mesh(geo, MAT);
  const root = new T.O3();
  root.add(mesh);
  root.userData.key = key;
  root.userData.site = d;
  /* 這個據點的樣子跟上一次不一樣（新蓋的、長高的）→ 播一次「從地上長出來」 */
  const id = d._rival ? 'rv:' + d._rival.id : d.id;
  if(SEEN[id] !== key){
    if(SEEN[id] !== undefined || W3D._warm) root.userData.grow = performance.now();
    SEEN[id] = key;
  }
  OBJS.add(root);
  if(root.userData.grow) kick();
  return root;
}

/* 建築的大小跟著鏡頭高度走：拉遠的時候放大，不然整座城只剩一個點；
   貼近的時候縮小，不然一棟樓會蓋掉整座城市。 */
const bScale = () => clamp(.25 + W3D.alt * 2.3, .55, 5.5);
function placeSite(obj, d){
  const a = (d._base || .0085);
  const c = G.getCoords(d.lat, d.lng, a);
  obj.position.set(c.x, c.y, c.z);
  /* 立起來：z = 地表法線、x = 正東、y = 正北。
     ⚠ 不能用 lookAt —— 它吃的是世界座標，而 three-globe 的圖層本身是轉過的，
       用 lookAt 立起來的樓會斜斜地躺在地上。getCoords 給的是圖層內的座標，
       所以旋轉也要在圖層內自己組。 */
  const l = Math.hypot(c.x, c.y, c.z) || 1, nx = c.x/l, ny = c.y/l, nz = c.z/l;
  let ex = nz, ey = 0, ez = -nx;                   // (0,1,0) × n
  const el = Math.hypot(ex, ez) || 1; ex /= el; ez /= el;
  const qx = ny*ez - nz*ey, qy = nz*ex - nx*ez, qz = nx*ey - ny*ex;   // n × e = 北
  const M = obj.matrix;
  M.set(ex, qx, nx, 0,  ey, qy, ny, 0,  ez, qz, nz, 0,  0, 0, 0, 1);
  obj.quaternion.setFromRotationMatrix(M);
  /* 駐在城市裡的部隊站在城市的東南邊一點,不要跟建築疊在一起。
     偏移量是「幾塊地磚寬」,所以要跟著縮放走(見 applyScale)。 */
  obj.userData.at = { x: c.x, y: c.y, z: c.z, e: [ex, ey, ez], q: [qx, qy, qz], off: d._off || null };
  applyScale(obj, performance.now());
}
function applyScale(obj, now){
  // 部隊棋子比建築大一號 —— 它們是你要常常點、常常看的東西
  const s = bScale() * (obj.userData.troop ? 1.45 : 1);
  let k = 1;
  const g0 = obj.userData.grow;
  if(g0){
    const p = clamp((now - g0) / 900, 0, 1);
    // 先衝過頭一點再回來，像蓋好的那一下
    k = p >= 1 ? 1 : 1 + 2.2 * Math.pow(p - 1, 3) + 1.2 * Math.pow(p - 1, 2);
    k = Math.max(.02, k);
    if(p >= 1) obj.userData.grow = 0;
  }
  obj.scale.set(s * 1.6, s * 1.6, s * k);        // 底座放寬:遠看才認得出是一座城,不是一根針
  const at = obj.userData.at;
  if(at && at.off){
    const w = s * 1.6, dx = at.off[0] * w, dy = at.off[1] * w;
    obj.position.set(at.x + at.e[0]*dx + at.q[0]*dy, at.y + at.e[1]*dx + at.q[1]*dy, at.z + at.e[2]*dx + at.q[2]*dy);
  }
}
let rafOn = false;
function kick(){
  if(rafOn) return; rafOn = true;
  const step = now => {
    let busy = false;
    for(const o of OBJS){
      if(!o.parent){ OBJS.delete(o); continue; }
      if(o.userData.grow){ applyScale(o, now); busy = true; }
    }
    if(busy) requestAnimationFrame(step); else rafOn = false;
  };
  requestAnimationFrame(step);
}
function rescaleAll(){
  const now = performance.now();
  for(const o of OBJS){ if(!o.parent){ OBJS.delete(o); continue; } applyScale(o, now); }
}

/* =============================================================================
   3. 傾斜鏡頭
   -----------------------------------------------------------------------------
   OrbitControls 永遠繞著球心轉，鏡頭永遠朝球心看 —— 所以不管拉多近，
   看到的都是「正上方俯視」。這裡在每一幀控制器算完之後，把鏡頭往南邊挪、
   往北邊斜看同一個點：畫面中心不變，但是你看到的是一張傾斜的地圖。

   關鍵是分清兩個位置：
     邏輯位置 = 控制器以為鏡頭在哪（永遠在正上方，旋轉/縮放都照它算）
     實際位置 = 真的拿去算畫面的那個（傾斜過的）
   每一幀先把鏡頭放回邏輯位置讓控制器算，算完再傾斜。如果鏡頭被別人搬過
   （pointOfView 的飛行動畫），就以那個新位置當邏輯位置。
   ============================================================================= */
function installTilt(){
  const cam = G.camera(), ctl = G.controls();
  if(!cam || !ctl || ctl.__w3d || typeof ctl.update !== 'function') return;
  ctl.__w3d = true;
  /* ⚠ globe.gl 預設「朝游標縮放」:縮放時把旋轉中心往游標挪,下一個事件再拉回球心。
     這一來一回在傾斜鏡頭底下會變成每滾一下畫面就跳一下 —— 使用者說的「不太順」。 */
  ctl.zoomToCursor = false;
  const V = cam.position.constructor;
  const logical = cam.position.clone(), last = new V(1e9, 0, 0);
  const n = new V(), north = new V(), up = new V(), S = new V(), P = new V();
  let lights = null;
  try{ lights = G.lights(); }catch(e){}
  const orig = ctl.update.bind(ctl);
  W3D._logical = logical;

  ctl.update = function(dt){
    if(cam.position.distanceToSquared(last) > 1e-10) logical.copy(cam.position);
    cam.position.copy(logical);
    cam.up.set(0, 1, 0);
    const r = orig(dt);
    logical.copy(cam.position);

    const d = logical.length();
    const alt = d / R - 1;
    W3D.alt = alt;
    const t = TILT_MAX * smooth((.9 - alt) / (.9 - .25));
    n.copy(logical).divideScalar(d || 1);
    if(t > 1e-3){
      S.copy(n).multiplyScalar(R);
      north.set(0, 1, 0).addScaledVector(n, -n.y);
      if(north.lengthSq() < 1e-6) north.set(0, 0, -1);
      north.normalize();
      const h = d - R;
      P.copy(S).addScaledVector(n, h * Math.cos(t)).addScaledVector(north, -h * Math.sin(t));
      cam.position.copy(P);
      up.copy(north).multiplyScalar(Math.cos(t)).addScaledVector(n, Math.sin(t)).normalize();
      cam.up.copy(up);
      cam.lookAt(S);
    }
    /* 方向光跟著鏡頭：從鏡頭的左上方打過來，建築永遠有一面亮、一面暗 */
    if(lights && lights[1] && lights[1].position){
      const L = lights[1].position;
      L.copy(logical).multiplyScalar(1.2);
      L.x += -logical.z * .6; L.z += logical.x * .6; L.y += d * .7;
    }
    last.copy(cam.position);
    return r;
  };
  if(lights){
    try{
      // 參考的那款遊戲沒有夜晚:環境光開大,方向光只負責讓建築有亮暗面
      if(lights[0]) lights[0].intensity = Math.PI * 1.05;
      if(lights[1]) lights[1].intensity = Math.PI * .55;
    }catch(e){}
  }
}

/* 鏡頭「邏輯上」在哪。pointOfView() 讀的是實際位置 —— 傾斜之後
   它會以為你在南邊一點，拿它去算「放大」會讓畫面每按一次就往南漂。 */
W3D.pov = function(){
  try{
    if(G && W3D._logical && typeof G.toGeoCoords === 'function')
      return G.toGeoCoords(W3D._logical);
  }catch(e){}
  return G ? G.pointOfView() : null;
};

/* =============================================================================
   掛上去
   ============================================================================= */
W3D.attach = function(globe){
  G = globe;
  try{
    const scene = G.scene && G.scene();
    if(!scene || scene.isScene !== true) return false;
  }catch(e){ return false; }
  paintSkin();
  if(W3D.ok) return true;
  /* globe.gl 的地球網格是非同步建的，剛 new 出來的那一刻還撿不到建構子。
     撿不到就每 300ms 再試一次（最多 12 秒），撿到了重畫一次標記。 */
  if(!grabThree()){
    if(!W3D._retry){
      let n = 0;
      W3D._retry = setInterval(() => {
        if(++n > 40 || W3D.ok){ clearInterval(W3D._retry); return; }
        if(grabThree()){
          clearInterval(W3D._retry);
          if(W3D.attach(G) && TY && typeof tyGlobeData === 'function'){ tyPaintGlobe(); tyGlobeData(); }
        }
      }, 300);
    }
    return false;
  }
  try{
    MAT = new T.Phong({ vertexColors: true, shininess: 28 });
    MAT.emissive && MAT.emissive.set('#141a22');
    G.customLayerData([])
     .customThreeObject(d => buildSite(d))
     .customThreeObjectUpdate((obj, d) => placeSite(obj, d));
    if(typeof G.onCustomLayerClick === 'function')
      G.onCustomLayerClick(d => {
        if(!d) return;
        if(d._units || d._threat){ TY_MODAL = 'troop'; renderPage(); }
        else if(d._rival){ TY_RIVAL = d._rival.id; TY_DEAL = null; TY_MODAL = 'rival'; renderPage(); }
        else tyPickSite(d.id);
      });
    if(typeof G.ringsData === 'function'){
      G.ringsData([]).ringLat('lat').ringLng('lng')
       .ringColor(d => t => `rgba(${d._rgb},${(1 - t) * (d._a || .9)})`)
       .ringMaxRadius(d => d._r || 2).ringPropagationSpeed(d => d._v || 2.2)
       .ringRepeatPeriod(d => d._p || 1100);
      if(typeof G.ringAltitude === 'function') G.ringAltitude(d => d._alt || .012);
    }
    installTilt();
    setupPaths();
    W3D.ok = true;
    const host = document.getElementById('tyGlobeHost');
    if(host) host.dataset.w3d = '1';
  }catch(e){ W3D.ok = false; }
  return W3D.ok;
};

/* 每次 tyGlobeData() 算完標記之後呼叫：把我的據點與對手大本營蓋成 3D。 */
/* 駐紮的部隊站在城市的哪一邊。使用者要的是「站在陸地上」—— 台北的東南邊是海,
   所以從東南開始試八個方向,挑第一個落在陸地上的。每座城市只算一次。 */
const DIRS = [-40, -140, 40, 140, -90, 90, 0, 180].map(a => a * Math.PI / 180);
const LAND_DIR = Object.create(null);
function landDir(d){
  const key = d._k || (d.lat + ',' + d.lng);
  if(!LAND_DIR[key] || LAND_DIR[key].hi !== !!W3D.hiFeats){
    let best = DIRS[0];
    for(const a of DIRS){
      const lat = d.lat + Math.sin(a) * .45, lng = d.lng + Math.cos(a) * .45 / Math.max(.2, Math.cos(d.lat * Math.PI / 180));
      if(W3D.featAt(lat, lng)){ best = a; break; }
    }
    LAND_DIR[key] = { a: best, hi: !!W3D.hiFeats };
  }
  const a = LAND_DIR[key].a;
  return [Math.cos(a) * 1.2, Math.sin(a) * 1.2];
}

W3D.sites = function(mine, rivals, troops){
  if(!W3D.ok) return;
  paintSkin();
  const rvMax = Math.max(1, ...rivals.map(r => r._v || 0));
  rivals.forEach(r => { r._rvk = Math.sqrt((r._v || 0) / rvMax); });
  const tr = (troops || []).map(d => {
    const o = { ...d, _base: .0008 };
    delete o._arc;
    if(d._units && !d._mv) o._off = landDir(d);            // 駐紮:城市旁邊的陸地上
    else o._sea = !W3D.featAt(d.lat, d.lng);                // 路上:在海上就是船
    if(d._threat) o._off = null;
    return o;
  });
  TROOPS = tr;
  G.customLayerData([...mine, ...rivals, ...tr]);
  tagsOn();
  buildRoutes(tr);
  pushPaths();
  armHover();
  W3D._warm = true;           // 第一批是開局就有的，不要全部從地上長出來
  W3D.rings();
};

/* 部隊棋子上方的小標籤(「⚖👔 ×2」「2季」)。棋子會跟著鏡頭縮放、位置會偏移,
   所以標籤不能掛在 globe.gl 的 HTML 層(那一層只吃經緯度)—— 這裡每一幀
   直接把棋子的 3D 位置投影到螢幕上。沒有部隊的時候這個迴圈不跑。 */
let TROOPS = [], TAGS = null, tagLoop = false;
function tagsOn(){
  const host = document.getElementById('tyGlobeHost');
  if(!host) return;
  if(!TAGS || !TAGS.isConnected){ TAGS = document.createElement('div'); TAGS.id = 'w3dTags'; host.appendChild(TAGS); }
  TAGS.innerHTML = '';
  for(const d of TROOPS){
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'w3d-tag' + (d._threat ? ' th' : '') + (d._mv ? ' mv' : '');
    if(d._threat){
      el.style.setProperty('--rc', `rgb(${(typeof TY_RVCOL !== 'undefined' && TY_RVCOL[d._r.id]) || '255,69,58'})`);
      el.innerHTML = `${d._r.ic || '⚔'} <b>${Math.max(0, d._threat.eta - TY.t)}季</b>`;
      el.title = `${d._r.nm}的併購小組 → ${tySite(d._threat.site).nm}`;
    }else{
      const ics = d._units.map(u => TY_UNITS[u.k].ic).join('');
      el.innerHTML = `${ics}${d._mv ? ` <b>${d._mv}季</b>` : d._units.length > 1 ? ` <b>×${d._units.length}</b>` : ''}`;
      el.title = d._units.map(u => TY_UNITS[u.k].nm + (u.to ? ` → ${tySite(u.to).nm}` : '')).join('、');
    }
    el.onclick = () => { TY_MODAL = 'troop'; renderPage(); };
    el._d = d;
    TAGS.appendChild(el);
  }
  if(TROOPS.length && !tagLoop){ tagLoop = true; requestAnimationFrame(tagStep); }
}
function tagStep(){
  if(!TAGS || !TAGS.isConnected || !TROOPS.length){ tagLoop = false; return; }
  let cam, V, w, h;
  try{ cam = G.camera(); const el = G.renderer().domElement; w = el.clientWidth; h = el.clientHeight; V = cam.position.clone(); }
  catch(e){ tagLoop = false; return; }
  const objs = [...OBJS].filter(o => o.parent && o.userData.troop);
  const placed = [];                     // 已經放好的標籤:同一區的圖示不要疊成一坨,往右錯開
  for(const el of TAGS.children){
    const o = objs.find(x => x.userData.site && x.userData.site._k === el._d._k);
    if(!o){ el.style.opacity = '0'; continue; }
    o.getWorldPosition(V);
    const vis = V.dot(cam.position) > R * R * 1.001;
    V.project(cam);
    let sx = (V.x + 1) / 2 * w, sy = (1 - V.y) / 2 * h;
    const gap = FAR ? 36 : 0;
    if(gap && vis){
      // 撞到就左右交替錯開(右一格、左一格、右兩格…),離真正的位置越近越好
      const x0 = sx;
      for(let k = 1; k < 7 && placed.some(p => Math.abs(p[0] - sx) < gap && Math.abs(p[1] - sy) < gap); k++)
        sx = x0 + gap * Math.ceil(k / 2) * (k % 2 ? 1 : -1);
      placed.push([sx, sy]);
    }
    el.style.transform = `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px) translate(-50%,-150%)`;
    el.style.opacity = vis ? '1' : '0';
    el.style.pointerEvents = vis ? 'auto' : 'none';
  }
  requestAnimationFrame(tagStep);
}

/* =============================================================================
   行軍路線 + 滑鼠懸停的國界 / 城市範圍
   -----------------------------------------------------------------------------
   兩個都畫在 globe.gl 的 paths 圖層上(貼著地表的線,不是弧線):
     行軍路線  從部隊現在的位置到目的地的大圓路線,虛線會往目的地流動 ——
               參考那款遊戲點一支部隊時看到的那條線
     懸停      滑鼠移到一個國家 → 描出它的國界;移到一座城市 → 畫出它的範圍圈
   ============================================================================= */
let ROUTES = [], HOVER = [];
function gcPts(a, b, n){
  const out = [];
  for(let i = 0; i <= n; i++){ const p = tyGeoLerp(a, b, i / n); out.push([p.lng, p.lat]); }
  return out;
}
function pushPaths(){
  if(!W3D.ok || typeof G.pathsData !== 'function') return;
  G.pathsData([...ROUTES, ...HOVER]);
}
function setupPaths(){
  if(typeof G.pathsData !== 'function') return;
  G.pathsData([])
   .pathPoints('pts').pathPointLat(p => p[1]).pathPointLng(p => p[0])
   .pathPointAlt(d => d.alt || .0012)
   .pathColor(d => d.col).pathStroke(d => d.w || null)
   .pathDashLength(d => d.dash || 1).pathDashGap(d => d.gap || 0)
   .pathDashAnimateTime(d => d.anim || 0)
   .pathTransitionDuration(0);
}
/* 行軍路線:由 W3D.sites 帶進來的部隊資料算 */
function buildRoutes(troops){
  ROUTES = [];
  for(const d of troops){
    let to = null, col;
    if(d._threat){ to = tySite(d._threat.site); col = 'rgba(255,90,70,1)'; }
    else if(d._mv && d._units && d._units[0].to){ to = tySite(d._units[0].to); col = 'rgba(120,215,255,1)'; }
    if(!to) continue;
    const km = typeof tyKm === 'function' ? tyKm(d, to) : 2000;
    const n = clamp(Math.round(km / 60), 8, 160);
    // 一條暗色的底線 + 一條會流動的亮色虛線:在綠色陸地和藍色海上都看得清楚
    const pts = gcPts(d, to, n);
    ROUTES.push({ pts, col: 'rgba(8,20,31,.6)', w: 2.4 });
    ROUTES.push({ pts, col, w: 1.4, dash: .04, gap: .02, anim: 2600, alt: .0014 });
  }
}

/* ---- 懸停 ---- */
let hoverCard = null, hoverKey = '', hoverT = 0;
function ringPts(lat, lng, rDeg){
  const out = [], k = 1 / Math.max(.2, Math.cos(lat * Math.PI / 180));
  for(let i = 0; i <= 48; i++){ const a = i / 48 * Math.PI * 2; out.push([lng + Math.cos(a) * rDeg * k, lat + Math.sin(a) * rDeg]); }
  return out;
}
/* 太長的環先抽稀:10m 的中國邊界有上萬個點,懸停不需要那麼細 */
function thin(ring, max){
  if(ring.length <= max) return ring;
  const step = ring.length / max, out = [];
  for(let i = 0; i < ring.length; i += step) out.push(ring[Math.floor(i)]);
  out.push(ring[0]);
  return out;
}
function featOutline(f){
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  // 只描大的那幾塊(離島一千個小環描起來只會很亂)
  const rings = polys.map(p => p[0]).filter(r => r && r.length > 6)
    .sort((a, b) => b.length - a.length).slice(0, 12);
  return rings.map(r => ({ pts: thin(r, 900), col: 'rgba(255,236,150,.95)', w: .38, alt: .0016 }));
}
function nearSite(x, y){
  if(typeof TY_SITES === 'undefined') return null;
  let best = null, bd = 26 * 26;
  for(const s of TY_SITES){
    let c; try{ c = G.getScreenCoords(s.lat, s.lng, .001); }catch(e){ return null; }
    const dx = c.x - x, dy = c.y - y, d = dx*dx + dy*dy;
    if(d < bd){
      const q = G.getCoords(s.lat, s.lng, 0), cam = G.camera().position;
      if(q.x*cam.x + q.y*cam.y + q.z*cam.z > R*R*1.001){ bd = d; best = s; }
    }
  }
  return best;
}
function flag(code){
  if(!code || code.length !== 2 || code === '-9') return '🏳';
  return String.fromCodePoint(...[...code.toUpperCase()].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65));
}
W3D.flag = flag;
function hoverAt(x, y){
  if(!W3D.ok || !TY) return;
  const host = document.getElementById('tyGlobeHost');
  const s = nearSite(x, y);
  let key = '', html = '';
  if(s){
    key = 'site:' + s.id;
    if(key !== hoverKey){
      const t = tySiteStuff(s.id), R0 = TY_REGIONS[s.reg];
      HOVER = [{ pts: ringPts(s.lat, s.lng, clamp(W3D.alt * 2.6, .25, 4)), col: 'rgba(255,236,150,.95)', w: .4, alt: .0016,
                 dash: .06, gap: .03, anim: 4000 }];
      html = `<b>${flag(s.iso)} ${escH(s.nm)}${t.val > 0 ? ` <em class="lv">${tySiteLv(t.val)}</em>` : ''}</b>`
        + `<span>${escH(R0.nm)} · 稅率 ${(s.tax*100).toFixed(1)}% · 景氣 ${((tyRegIdx(s.reg)-1)*100).toFixed(1)}%</span>`
        + (t.val > 0 ? `<span>你在這裡:${tyM(t.val)}</span>` : `<span class="dim">還沒進場 · 點一下看能做什麼</span>`);
    }
  }else{
    let p = null; try{ p = G.toGlobeCoords(x, y); }catch(e){}
    const f = p ? W3D.featAt(p.lat, p.lng) : null;
    if(f){
      const code = iso(f);
      key = 'iso:' + (code || f.properties.NAME);
      if(key !== hoverKey){
        HOVER = featOutline(f);
        const info = typeof tyIsoInfo === 'function' ? tyIsoInfo(code, f) : null;
        html = `<b>${flag(code)} ${escH((code && REGION_NAME[code]) || f.properties.NAME || code || '')}</b>`
          + (info ? `<span>${escH(info.regNm)} · 景氣 ${info.idxTxt} · 政策風險 ${info.polTxt}</span>`
                  + `<span>${info.ownerTxt}</span>` : '');
      }
    }
  }
  if(key === hoverKey){ if(hoverCard && key) place(); return; }
  hoverKey = key;
  if(!key){ HOVER = []; pushPaths(); if(hoverCard) hoverCard.style.display = 'none'; if(host) host.style.cursor = ''; return; }
  pushPaths();
  if(!hoverCard || !hoverCard.isConnected){
    hoverCard = document.createElement('div'); hoverCard.className = 'w3d-hover';
    if(host) host.appendChild(hoverCard);
  }
  hoverCard.innerHTML = html;
  hoverCard.style.display = '';
  if(host) host.style.cursor = 'pointer';
  place();
  function place(){
    const w = host ? host.clientWidth : innerWidth;
    const left = x + 16 + 240 > w ? x - 16 - 240 : x + 16;
    hoverCard.style.transform = `translate(${Math.max(4, left)}px,${Math.max(4, y - 10)}px)`;
  }
}
function armHover(){
  const el = document.getElementById('tyGlobe');
  if(!el || el.__w3dHover) return;
  el.__w3dHover = true;
  // 觸控裝置沒有「懸停」:點一下就直接開面板了,不用再多一層
  if(window.matchMedia && !matchMedia('(hover: hover)').matches) return;
  el.addEventListener('pointermove', ev => {
    if(ev.pointerType !== 'mouse' || ev.buttons) return;          // 拖曳地圖的時候不要一直換
    const r = el.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    const now = performance.now();
    if(now - hoverT < 60) return;
    hoverT = now;
    hoverAt(x, y);
  });
  el.addEventListener('pointerleave', () => { hoverKey = 'x'; hoverAt(-999, -999); });
}

/* 光圈：你的大本營一圈慢慢擴散的金色、目前選的據點一圈青色，
   加上過場時臨時加的（賺錢綠、賠錢紅、對手的顏色）。 */
W3D.rings = function(){
  if(!W3D.ok || typeof G.ringsData !== 'function' || !TY) return;
  const out = [];
  const home = tySite(TY.home);
  out.push({ lat: home.lat, lng: home.lng, _rgb: '255,205,90', _a: .7, _r: 2.6, _v: 1.2, _p: 2200 });
  if(typeof TY_SEL !== 'undefined' && TY_SEL){
    const s = tySite(TY_SEL);
    out.push({ lat: s.lat, lng: s.lng, _rgb: '79,195,247', _a: .95, _r: 1.8, _v: 2.4, _p: 800 });
  }
  /* 對手的部隊正往這裡來:目標城市一圈紅色警報,越接近抵達跳得越快 */
  if(typeof tyThreats === 'function') for(const th of tyThreats()){
    const s = tySite(th.site), left = Math.max(0, th.eta - TY.t);
    out.push({ lat: s.lat, lng: s.lng, _rgb: '255,69,58', _a: .95, _r: 3.4, _v: 3, _p: left <= 1 ? 600 : 1200 });
  }
  // 自己的部隊正在前往的地方:一圈藍色的目標標記
  if(typeof tyUnits === 'function') for(const u of tyUnits()){
    if(!u.to) continue;
    const s = tySite(u.to);
    out.push({ lat: s.lat, lng: s.lng, _rgb: '90,200,255', _a: .9, _r: 1.4, _v: 1.4, _p: 900 });
  }
  G.ringsData(out.concat(W3D.extraRings));
};

W3D.onZoom = function(pov){
  if(!W3D.ok) return;
  if(!W3D._logical && pov && isFinite(pov.altitude)) W3D.alt = pov.altitude;
  rescaleAll();
  patchSoon();
  farMode();
};
/* 拉遠:3D 部隊棋子收起來,改成參考畫面那種方形兵種圖示(標籤層切換樣式)。
   遠看的時候一台 3D 戰車只有幾個像素,看不出是什麼;圖示才讀得出來。 */
let FAR = null;
function farMode(){
  const far = W3D.alt > FAR_ALT;
  if(far === FAR) return;
  FAR = far;
  const host = document.getElementById('tyGlobeHost');
  if(host) host.dataset.far = far ? '1' : '';
  for(const o of OBJS) if(o.userData.troop) o.visible = !far;
}

/* =============================================================================
   4. 季與季之間的過場
   -----------------------------------------------------------------------------
   **狀態先變、畫面後到**：按下「下一季」的那一刻 tyNext() 已經跑完、存檔也寫了，
   這裡播的只是「剛剛發生了什麼」的重播。所以動畫播到一半關掉、切面板、
   再按一次下一季，都不會影響任何數字 —— 最多就是這一段重播被下一段蓋掉。
   ============================================================================= */
W3D.snap = function(){
  if(!TY) return null;
  const sites = {};
  for(const s of tyMySites()) sites[s.id] = tySiteStuff(s.id).val;
  const rv = {};
  for(const r of tyRivalsA()) rv[r.id] = { nw: r.nw, turf: { ...(r.turf || {}) } };
  return { t: TY.t, nw: tyShownNW(), cash: TY.cash, debt: TY.debt, sites, rv,
           credit: TY.credit, fame: TY.fame, infl: TY.infl, heat: TY.heat };
};

function fxLayer(){
  const host = document.getElementById('tyGlobeHost');
  if(!host) return null;
  let fx = document.getElementById('w3dFx');
  if(!fx){
    fx = document.createElement('div'); fx.id = 'w3dFx';
    host.appendChild(fx);
    // 碰一下地圖就收掉橫幅 —— 橫幅本身不吃點擊，所以不會擋住任何按鈕
    host.addEventListener('pointerdown', () => { const b = fx.querySelector('.w3d-ban'); if(b) b.classList.add('out'); }, { passive: true });
  }
  return fx;
}

/* 數字從舊值跳到新值。只換文字，不重畫 —— 重畫會讓整頁閃一下。 */
function countUp(el, from, to, fmt, ms){
  if(!el || !isFinite(from) || !isFinite(to) || from === to) return;
  el.classList.remove('w3d-up', 'w3d-dn'); void el.offsetWidth;
  el.classList.add(to > from ? 'w3d-up' : 'w3d-dn');
  if(reduced()){ el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = now => {
    if(!el.isConnected) return;
    const p = clamp((now - t0) / ms, 0, 1), e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * e);
    if(p < 1) requestAnimationFrame(step); else el.textContent = fmt(to);
  };
  requestAnimationFrame(step);
}

/* 一個浮在地球某一點上方的標籤（「+3.2 億」）。每一幀用 getScreenCoords
   換算成螢幕座標；轉到球的背面就淡掉。 */
function floatAt(fx, lat, lng, html, cls, delay){
  const el = document.createElement('div');
  el.className = 'w3d-float ' + (cls || '');
  el.innerHTML = html;
  el.style.opacity = '0';
  fx.appendChild(el);
  const t0 = performance.now() + (delay || 0), dur = 2600;
  const step = now => {
    if(!el.isConnected) return;
    const p = (now - t0) / dur;
    if(p >= 1){ el.remove(); return; }
    let vis = true, x = -999, y = -999;
    try{
      const c = G.getScreenCoords(lat, lng, .02);
      x = c.x; y = c.y;
      const cam = G.camera().position, q = G.getCoords(lat, lng, 0);
      vis = (q.x*cam.x + q.y*cam.y + q.z*cam.z) > R*R*1.001;
    }catch(e){}
    if(p < 0){ requestAnimationFrame(step); return; }
    const rise = 34 * (1 - Math.pow(1 - clamp(p, 0, 1), 2));
    const a = p < .12 ? p / .12 : p > .75 ? (1 - p) / .25 : 1;
    el.style.transform = `translate(${x}px,${y - rise}px) translate(-50%,-100%)`;
    el.style.opacity = vis ? a.toFixed(3) : '0';
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

W3D.play = function(snap){
  if(!snap || !TY || TY.t === snap.t) return;
  const fx = fxLayer();

  /* ① 資源列：數字跳過去，漲的閃綠、跌的閃紅 */
  const res = document.querySelectorAll('.tg-res .r b');
  countUp(res[0], snap.cash, TY.cash, tyM, 1100);
  countUp(res[1], snap.debt, TY.debt, tyM, 1100);
  const nwEl = document.querySelector('.tg-nwp b');
  const nw = tyShownNW();
  countUp(nwEl, snap.nw, nw, tyM, 1400);

  if(!fx) return;
  fx.querySelectorAll('.w3d-ban,.w3d-float').forEach(e => e.remove());

  /* ② 季別橫幅：新的一季、景氣、這一季身家變多少、最重要的一則新聞 */
  const reg = (typeof TY_REGIME !== 'undefined' && TY_REGIME[TY.macro.reg]) || { ic: '', nm: '' };
  const d = nw - snap.nw, pct = snap.nw ? d / Math.abs(snap.nw) * 100 : 0;
  const top = (TY.news || []).find(n => n.kind === 'bad') || (TY.news || [])[0];
  const ban = document.createElement('div');
  ban.className = 'w3d-ban';
  ban.innerHTML = `<em>第 ${TY.t + 1} 季 · ${reg.ic || ''} ${escH(reg.nm || '')}</em>`
    + `<b>${tyWhen(TY.t)}</b>`
    + `<span class="${d >= 0 ? 'up' : 'dn'}">身家 ${d >= 0 ? '+' : '−'}${tyM(Math.abs(d))}`
    + `（${d >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%）</span>`
    + (top ? `<i>${escH(top.title)}</i>` : '');
  fx.appendChild(ban);
  setTimeout(() => ban.classList.add('out'), 2900);
  setTimeout(() => ban.remove(), 3500);

  if(!W3D.ok) return;

  /* ③ 每個據點浮出這一季的賺賠。太小的不標 —— 滿球的「+0.0 億」只是噪音。 */
  const rings = [];
  const ids = new Set([...Object.keys(snap.sites), ...tyMySites().map(s => s.id)]);
  const thr = Math.max(1e7, Math.abs(nw) * .004);
  let i = 0;
  for(const id of ids){
    const was = snap.sites[id] || 0, now = tySiteStuff(id).val;
    const dv = now - was;
    if(Math.abs(dv) < thr) continue;
    const s = tySite(id), up = dv >= 0;
    floatAt(fx, s.lat, s.lng, `${up ? '+' : '−'}${tyM(Math.abs(dv))}`, up ? 'up' : 'dn', 250 + (i++) * 110);
    rings.push({ lat: s.lat, lng: s.lng, _rgb: up ? '255,69,58' : '48,209,88', _a: .95, _r: 3.2, _v: 3, _p: 900 });
  }

  /* ④ 對手擴張：勢力明顯變大的地區，從他的大本營拉一條他顏色的弧線過去 */
  const arcs = [];
  for(const r of tyRivalsA()){
    const was = snap.rv[r.id]; if(!was) continue;
    const col = (typeof TY_RVCOL !== 'undefined' && TY_RVCOL[r.id]) || '200,200,210';
    for(const [reg2, v] of Object.entries(r.turf || {})){
      if(v - (was.turf[reg2] || 0) < 1.5) continue;
      const home = tySite(r.home);
      const to = TY_SITES.find(s => s.reg === reg2 && s.id !== r.home);
      if(!to) continue;
      arcs.push({ startLat: home.lat, startLng: home.lng, endLat: to.lat, endLng: to.lng,
                  _c: [`rgba(${col},.2)`, `rgba(${col},.95)`] });
      rings.push({ lat: to.lat, lng: to.lng, _rgb: col, _a: .9, _r: 2.6, _v: 2, _p: 1000 });
      if(arcs.length <= 3) floatAt(fx, to.lat, to.lng, `${r.ic || ''} ${escH(r.nm)} 擴張`, 'rv', 700 + arcs.length * 200);
    }
  }

  W3D.extraArcs = arcs.slice(0, 8);
  W3D.extraRings = rings.slice(0, 14);
  if(typeof tyGlobeData === 'function') tyGlobeData();
  clearTimeout(W3D._clr);
  W3D._clr = setTimeout(() => {
    W3D.extraArcs = []; W3D.extraRings = [];
    if(TYG && typeof tyGlobeData === 'function') tyGlobeData();
  }, 3600);
};

})();
