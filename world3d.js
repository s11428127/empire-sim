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
  /* 小於 1 像素的點不畫:10m 國界有幾十萬個點,在 4K 貼圖上大部分擠在同一個像素裡。
     一半以上的畫線指令是白做的 —— 那就是切換圖層會卡的原因之一。 */
  const draw = sh => {
    let lx = -1e9, ly = -1e9;
    pts.forEach(([lng,lat], i) => {
      const x = X(lng+sh), y = Y(lat);
      if(!i){ ctx.moveTo(x, y); lx = x; ly = y; return; }
      if(Math.abs(x-lx) + Math.abs(y-ly) < 1 && i < pts.length - 1) return;
      ctx.lineTo(x, y); lx = x; ly = y;
    });
  };
  draw(0); ctx.closePath();
  if(mx > 180){ draw(-360); ctx.closePath(); }
  if(mn < -180){ draw(360); ctx.closePath(); }
}
function featPath(ctx, f, W, H){
  const g = f.geometry; if(!g) return;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  for(const poly of polys) for(const r of poly) if(r.length > 2) ringPath(ctx, r, W, H);
}
/* 每一國的輪廓轉成 Path2D 存起來:換圖層只是「換顏色」,輪廓不會變,
   沒道理每次都把兩百多國的每一個點重走一遍。貼圖尺寸變了才重建。 */
function featP2D(f, W, H){
  if(f._p2d && f._p2dW === W) return f._p2d;
  const p = new Path2D(); featPath(p, f, W, H);
  f._p2d = p; f._p2dW = W;
  return p;
}
let ALLP = null, ALLP_KEY = null;
function allP2D(feats, W, H){
  if(ALLP && ALLP_KEY === feats && ALLP.w === W) return ALLP.p;
  const p = new Path2D(); for(const f of feats) p.addPath(featP2D(f, W, H));
  ALLP = { p, w: W }; ALLP_KEY = feats;
  return p;
}
function landPath(ctx, feats, W, H){
  ctx.beginPath();
  for(const f of feats) featPath(ctx, f, W, H);
}

let BASE = null, TOP = null, TEX = null, FEATS = null, PFEATS = null, HI = false, SIG = '';
const texSize = () => {
  const small = Math.min(innerWidth, innerHeight) < 700 || /Mobi|Android|iPhone|iPad/.test(navigator.userAgent);
  /* 8K 貼圖要 170MB 左右的顯示記憶體(含 mipmap)。只給回報得出 16K 貼圖上限的
     顯卡 —— 那通常是獨立顯卡或近幾年的桌機內顯;其餘一律 4K。 */
  /* 第一版桌機給 8K。使用者回報「切勢力範圍、地區景氣很卡」—— 每切一次就重畫並
     重新上傳一張 8K 貼圖(128MB)。現在近看有局部地圖負責清晰度,整球貼圖不需要那麼大:
     桌機 4K、手機 2K。 */
  let W = small ? 2048 : 4096;
  if(window.__W3D_TEX) W = Math.min(W, window.__W3D_TEX);   // 測試截圖用
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
  /* ⚠ 不用 shadowBlur:模糊是整張畫布逐像素算的,4K 上一次就要好幾百毫秒。
     改成沿著海岸描三層由寬到窄、由淡到濃的線 —— 看起來一樣是一圈淺海,快幾十倍。 */
  landPath(c, feats, W, H);
  c.lineJoin = 'round';
  for(const [w, a] of [[18, .16], [10, .22], [5, .32]]){ c.lineWidth = w*k; c.strokeStyle = `rgba(110,195,232,${a})`; c.stroke(); }

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
    const p = featP2D(f, W, H);
    c.fillStyle = cols[i].replace(/,\s*([\d.]+)\)$/, (s, a) => `,${Math.min(.72, +a * 1.6).toFixed(3)})`);
    c.fill(p, 'evenodd');
    // 有主的國家描一圈同色的粗邊 —— 參考畫面裡「這塊是誰的」主要是靠邊框看出來的
    c.lineWidth = 3.2*k; c.strokeStyle = cols[i].replace(/,\s*([\d.]+)\)$/, ',.95)');
    c.stroke(p);
  });
  // 國界：白色細線，跟參考畫面一樣
  c.lineWidth = 1.3*k; c.strokeStyle = 'rgba(255,255,255,.55)'; c.stroke(allP2D(FEATS, W, H));
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
  try{ t.anisotropy = Math.min(4, G.renderer().capabilities.getMaxAnisotropy()); }catch(e){}
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
/* 兩層精度:
     50m  整球貼圖、點擊判斷、懸停 —— 夠細,而且點數只有 10m 的四分之一
     10m  只給桌機近看的局部地圖(手機近看也用 50m,省記憶體) */
async function fetchAtlas(urls){
  for(const u of urls){
    try{
      const r = await fetch(u); if(!r.ok) continue;
      const topo = await r.json();
      if(!topo || !topo.objects || !topo.objects.countries) continue;
      const feats = topoFeatures(topo).filter(f => f.properties.NAME !== 'Antarctica');
      if(feats.length >= 100) return feats;
    }catch(e){ /* 換下一個來源 */ }
  }
  return null;
}
async function loadHiRes(){
  if(HI) return; HI = true;
  const f50 = await fetchAtlas(ATLAS(true));
  if(f50){
    FEATS = f50; W3D.hiFeats = f50; PFEATS = PFEATS || f50;
    paintBase(FEATS); paintTop(true);
    patchDirty = true; patchSoon();
  }
  if(texSize() > 2048){
    const f10 = await fetchAtlas(ATLAS(false).filter(u => u.includes('10m')));
    if(f10){ PFEATS = f10; patchDirty = true; patchSoon(); }
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
/* ⚠ 第一版是「每一個點各自」平移到中心 ±180° 以內 —— 橫跨上百個經度的俄羅斯
     會被切成繞一圈的怪形狀,跟中國、蒙古的填色互相抵消,整片陸地變成海
     (使用者截圖那條橫跨亞洲的藍色帶子)。現在整個環先攤平成連續的經度,
     再**整環**平移到靠近中心的位置。 */
function patchRing(ctx, ring, P, W, H){
  const mid = (P.lo0 + P.lo1) / 2, kx = W / (P.lo1 - P.lo0), ky = H / (P.la1 - P.la0);
  let off = 0, prev = null, sum = 0;
  const pts = new Array(ring.length);
  for(let i = 0; i < ring.length; i++){
    const lng = ring[i][0];
    if(prev !== null){ const d = lng + off - prev; if(d > 180) off -= 360; else if(d < -180) off += 360; }
    prev = lng + off; pts[i] = prev; sum += prev;
  }
  let sh = mid - sum / ring.length; sh = Math.round(sh / 360) * 360;
  let lx = -1e9, ly = -1e9;
  for(let i = 0; i < ring.length; i++){
    const x = (pts[i] + sh - P.lo0) * kx, y = (P.la1 - ring[i][1]) * ky;
    if(!i){ ctx.moveTo(x, y); lx = x; ly = y; continue; }
    if(Math.abs(x-lx) + Math.abs(y-ly) < 1 && i < ring.length - 1) continue;   // 小於 1 像素的點不畫
    ctx.lineTo(x, y); lx = x; ly = y;
  }
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
  const feats = (PFEATS || FEATS || []).filter(f => {
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
  c.lineJoin = 'round';
  for(const [w, a] of [[Math.min(40, ppd*.7), .16], [Math.min(22, ppd*.35), .22], [Math.min(10, ppd*.15), .32]]){
    c.lineWidth = w; c.strokeStyle = `rgba(110,195,232,${a})`; c.stroke();
  }
  // 陸地:底色 + 依緯度的色帶 + 釘在經緯度上的斑塊與森林
  c.save(); land(); c.clip('evenodd');
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
      c.fillStyle = col.replace(/,\s*([\d.]+)\)$/, (s, a) => `,${Math.min(.72, +a * 1.6).toFixed(3)})`); c.fill('evenodd');
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
    const inLat = Math.abs(lat - (PATCH.la0 + PATCH.la1) / 2) < (PATCH.la1 - PATCH.la0) * .28;
    let dl = pov.lng - (PATCH.lo0 + PATCH.lo1) / 2; dl -= Math.round(dl / 360) * 360;
    const inLng = Math.abs(dl) < (PATCH.lo1 - PATCH.lo0) * .28;
    const r = alt / PATCH.alt;
    if(inLat && inLng && r > .66 && r < 1.45) return;       // 還在這一片裡面,不用重畫
  }
  patchDirty = false;
  const P = PATCH || {};
  P.la0 = clamp(lat - half, -89, 89); P.la1 = clamp(lat + half * 1.25, -89, 89);   // 北邊多留:傾斜時看得比較遠
  P.lo0 = pov.lng - halfLng; P.lo1 = pov.lng + halfLng; P.alt = alt;
  const M = texSize() <= 2048 ? 1024 : 1536;
  const rw = (P.lo1 - P.lo0) * Math.cos(lat * Math.PI / 180), rh = P.la1 - P.la0;
  if(!P.cv){ P.cv = document.createElement('canvas'); }
  const nw = rw >= rh ? M : Math.max(256, Math.round(M * rw / rh));
  const nh = rh >= rw ? M : Math.max(256, Math.round(M * rh / rw));
  /* ⚠ 畫布換了尺寸,GPU 上那張貼圖一定要先釋放。three.js 的貼圖儲存空間是配置一次就
     固定的,不釋放的話新的內容會被塞進舊尺寸的格子裡 —— 畫面上就是糊掉又錯位的地圖
     (實際發生過:局部地圖本身畫得很清楚,貼到球上卻是一格一格的)。 */
  if(P.tex && (P.cv.width !== nw || P.cv.height !== nh)) P.tex.dispose();
  P.cv.width = nw; P.cv.height = nh;
  if(!P.tex){
    P.tex = new TEX.constructor(P.cv);
    P.tex.colorSpace = TEX.colorSpace;
    try{ P.tex.anisotropy = Math.min(4, G.renderer().capabilities.getMaxAnisotropy()); }catch(e){}
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
/* 鏡頭停下來 350ms 之後才重畫 —— 快速拉近再拖動的時候,中間每一個停頓都重畫一次
   就是使用者說的「快速放大然後移動會卡」。 */
function patchSoon(){ clearTimeout(patchTimer); patchTimer = setTimeout(patchCheck, 350); }

/* 換圖層時:按鈕和面板先反應,地圖顏色下一幀才重畫 —— 點下去的那一刻不要卡住。 */
W3D._paintTop = force => paintTop(force);   // 給效能量測用
let repaintQ = 0;
W3D.repaint = () => {
  if(repaintQ) return;
  repaintQ = requestAnimationFrame(() => {
    repaintQ = 0;
    const before = SIG; paintTop(false);
    if(SIG !== before){ patchDirty = true; patchSoon(); }
  });
};
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
    /* 先用外框篩掉:滑鼠每動一下就要判斷一次,不篩的話每次都把兩百多國的
       每一個點走一遍 —— 那就是「移動地圖很卡」的另一個原因。 */
    const b = featBox(f);
    if(lat < b[0] || lat > b[1] || (b[3] - b[2] < 300 && (lng < b[2] || lng > b[3]))) continue;
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
/* 使用者:「軍隊可以再精細一點點,但是也不要讓地圖太卡」。
   所以多的是**形狀的細節**(負重輪、艙蓋、階梯、桅杆、手腳),不是多邊形數量的暴增 ——
   一支部隊還是幾百個三角形,而且同一種組合的幾何只算一次。 */
function drawUnit(g, k, x, y, z, tint){
  const T2 = tint || TEAM;
  switch(k){
    case 'raid': {                                  // 併購小組:戰車
      const hull = lin('#5d6b45'), top = lin('#7d8d5c'), dark = lin('#2b2f24'), dt = lin('#3b4031');
      for(const s of [-1, 1]){
        box(g, x, y + s*.115, z, .38, .04, .055, dark, dt);                      // 履帶
        for(let i = 0; i < 5; i++) frustum(g, x - .14 + i*.07, y + s*.14, z + .005, .022, .022, .012, 8, lin('#4a4f40'), lin('#6a705c'));  // 負重輪
      }
      let t = box(g, x, y, z + .03, .34, .2, .06, hull, top);
      box(g, x + .15, y, z + .03, .04, .18, .045, hull, top);                    // 前裝甲斜面
      const tr = box(g, x - .03, y, t, .17, .14, .065, lin('#6c7b50'), lin('#8fa068'));
      frustum(g, x - .06, y + .03, tr, .025, .022, .02, 8, lin('#55613f'), lin('#7d8d5c'));   // 艙蓋
      box(g, x + .14, y, t + .025, .22, .028, .028, lin('#3d472e'), lin('#56623f'));        // 砲管
      box(g, x + .255, y, t + .025, .03, .038, .038, lin('#2f3824'), lin('#46523a'));       // 砲口
      box(g, x - .16, y - .06, t - .02, .03, .04, .03, lin('#3a3a32'), lin('#555'));        // 排氣
      box(g, x - .1, y + .05, tr, .01, .01, .16, lin('#cccccc'), lin('#ffffff'));          // 天線
      box(g, x - .065, y + .05, tr + .11, .07, .008, .045, lin(T2, .9), lin(T2, 1.1));     // 小旗
      break; }
    case 'law': {                                   // 律師團:法院(階梯 + 柱廊 + 山牆)
      const w = lin('#e9e6dc'), wt = lin('#ffffff'), st = lin('#c9c4b6');
      box(g, x, y - .02, z, .36, .28, .02, st, wt);
      box(g, x, y - .01, z + .02, .34, .24, .02, st, wt);
      const t = box(g, x, y, z + .04, .32, .22, .02, st, wt);
      for(const cx of [-.12, -.06, 0, .06, .12]) frustum(g, x + cx, y - .07, t, .016, .014, .15, 6, w, wt);
      box(g, x, y + .035, t, .28, .1, .15, lin('#d8d3c6'), wt);
      const r = box(g, x, y, t + .15, .34, .24, .03, w, wt);
      pyramid(g, x, y, r, .3, .08, lin(T2, 1));
      box(g, x, y - .12, r - .01, .1, .01, .03, lin('#e0b23c'), lin('#ffd76a'));   // 門楣上的徽章
      break; }
    case 'lobby': {                                 // 遊說團:講台 + 麥克風 + 旗子 + 兩個聽眾
      const t = box(g, x, y, z, .16, .12, .15, lin('#6b4a2e'), lin('#8a6440'));
      box(g, x, y - .02, t, .12, .05, .02, lin('#2a2a2a'), lin('#444'));
      box(g, x, y - .03, t + .02, .008, .008, .05, lin('#222'), lin('#555'));        // 麥克風
      box(g, x + .1, y + .04, z, .014, .014, .38, lin('#bbbbbb'), lin('#eeeeee'));
      box(g, x + .18, y + .04, z + .28, .16, .01, .1, lin(T2, .95), lin(T2, 1.15));
      for(const dx of [-.07, .04]){                                                   // 聽眾
        const b = frustum(g, x + dx, y - .17, z, .03, .026, .09, 6, lin('#3c4556'), lin('#4e586b'));
        frustum(g, x + dx, y - .17, b, .022, .022, .03, 6, lin('#e2b894'), lin('#f0c9a4'));
      }
      break; }
    case 'mgr': {                                   // 經理人:西裝人像(腿、身體、手臂、頭)+ 公事包
      const suit = lin('#2d3440'), st = lin('#3c4556'), sk = lin('#e2b894');
      for(const dy of [-.025, .025]) box(g, x, y + dy, z, .035, .03, .09, suit, st);    // 腿
      const t = frustum(g, x, y, z + .09, .06, .07, .12, 8, suit, st);
      for(const dy of [-.08, .08]) box(g, x, y + dy, t - .11, .03, .025, .1, suit, st); // 手臂
      prism(g, x, y, t, .045, .065, 8, sk, lin('#f0c9a4'));
      box(g, x, y, t + .06, .1, .1, .012, lin('#222'), lin('#333'));                  // 頭髮
      box(g, x - .062, y, t - .06, .012, .03, .06, lin(T2), lin(T2, 1.2));            // 領帶
      box(g, x + .01, y + .1, z + .03, .09, .035, .07, lin('#5a3a22'), lin('#7a5234')); // 公事包
      break; }
    case 'ship': {                                  // 海上:一艘船(船身、艦橋、砲塔、桅杆)
      const hull = lin('#5f6b78'), deck = lin('#8a96a2');
      const t = box(g, x - .04, y, z, .38, .15, .07, hull, deck);
      tri(g, [x + .15, y - .075, z], [x + .28, y, z], [x + .15, y - .075, t], hull);
      tri(g, [x + .15, y + .075, t], [x + .28, y, z], [x + .15, y + .075, z], hull);
      tri(g, [x + .15, y - .075, t], [x + .28, y, z], [x + .15, y + .075, t], deck);
      box(g, x - .04, y, z + .02, .39, .155, .008, lin('#c8322a'), lin('#d9443a'));    // 吃水線
      const b = box(g, x - .1, y, t, .12, .1, .08, lin('#d9dde2'), lin('#f4f6f8'));
      box(g, x - .1, y - .051, t + .05, .1, .004, .015, lin('#223'), lin('#334'));    // 艦橋窗
      box(g, x - .1, y, b, .02, .02, .14, lin('#bbb'), lin('#eee'));                   // 桅杆
      box(g, x - .1, y, b + .1, .07, .01, .01, lin('#bbb'), lin('#eee'));
      frustum(g, x + .08, y, t, .035, .03, .03, 8, lin('#6c7884'), lin('#95a1ad'));    // 砲塔
      box(g, x + .13, y, t + .015, .08, .012, .012, lin('#444'), lin('#666'));
      box(g, x - .2, y, t, .03, .03, .06, lin(T2), lin(T2, 1.2));                     // 船尾旗
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

/* =============================================================================
   城市地標 —— 使用者:「每個城市都可以有地標或是特色建築」
   -----------------------------------------------------------------------------
   44 座城市各配一個一眼認得出來的地標,用最基本的幾何(方塊、稜柱、錐台、角錐)
   拼出來:每一個只有幾百個三角形,同一種地標的幾何只算一次,所以整張地圖多出來的
   負擔大約是 44 個 draw call —— 不會讓地圖變卡。
   遠看(部隊變成圖示的那個高度)一律收起來:那時候它們只會是一堆擠在一起的小點。
   ============================================================================= */
/* 錐台:底半徑 r0、頂半徑 r1 的 n 邊柱。r1 = 0 就是角錐,r0 = r1 就是稜柱。 */
function frustum(g, cx, cy, z0, r0, r1, h, n, side, top, rot){
  const z1 = z0 + h, A = [], B = [];
  for(let i = 0; i < n; i++){
    const a = (rot || 0) + i / n * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    A.push([cx + c*r0, cy + s*r0]); B.push([cx + c*r1, cy + s*r1]);
  }
  for(let i = 0; i < n; i++){
    const j = (i + 1) % n;
    quad(g, [A[i][0],A[i][1],z0], [A[j][0],A[j][1],z0], [B[j][0],B[j][1],z1], [B[i][0],B[i][1],z1], side);
    if(r1 > 0) tri(g, [cx,cy,z1], [B[i][0],B[i][1],z1], [B[j][0],B[j][1],z1], top || side);
  }
  return z1;
}
/* 球(或圓頂):幾段錐台疊起來 */
function ball(g, cx, cy, z0, r, col, half){
  const seg = half ? 3 : 6, n = 10;
  let z = z0;
  for(let i = 0; i < seg; i++){
    const t0 = half ? i / seg * Math.PI/2 : -Math.PI/2 + i / seg * Math.PI;
    const t1 = half ? (i+1) / seg * Math.PI/2 : -Math.PI/2 + (i+1) / seg * Math.PI;
    const h = r * (Math.sin(t1) - Math.sin(t0));
    z = frustum(g, cx, cy, z, r * Math.cos(t0), r * Math.cos(t1), h, n, col, col);
  }
  return z;
}
const LM = {
  // 台北 101:八節往外張的竹節 + 尖塔
  t101(g){ const gl = lin('#5f8f86'), gt = lin('#8ec3b8');
    let z = box(g, 0, 0, 0, .3, .3, .3, gl, gt);
    for(let i = 0; i < 8; i++) z = frustum(g, 0, 0, z, .1, .145, .1, 4, gl, gt, Math.PI/4);
    z = box(g, 0, 0, z, .12, .12, .08, gl, gt);
    box(g, 0, 0, z, .02, .02, .3, lin('#dddddd'), lin('#ffffff')); },
  // 東京鐵塔 / 石油井架:往上收的格架,紅白相間
  lattice(g, red){ let z = 0, w = .42;
    for(let i = 0; i < 6; i++){ const c = red ? lin(i % 2 ? '#f2f2f2' : '#e0452f') : lin(i % 2 ? '#9aa3ab' : '#6d767e');
      const nw = w * .7; z = frustum(g, 0, 0, z, w * .7, nw * .7, .2, 4, c, c, Math.PI/4); w = nw;
      if(i === 2) box(g, 0, 0, z, .18, .18, .05, lin('#d0d0d0'), lin('#f0f0f0')); }
    box(g, 0, 0, z, .015, .015, .22, lin('#dddddd'), lin('#ffffff')); },
  eiffel(g){ const b = lin('#8a6f4d'), bt = lin('#a88b62');
    for(const [x, y] of [[-.14,-.14],[.14,-.14],[-.14,.14],[.14,.14]]) frustum(g, x, y, 0, .06, .035, .22, 4, b, bt, Math.PI/4);
    let z = box(g, 0, 0, .22, .36, .36, .04, b, bt);
    z = frustum(g, 0, 0, z, .17, .08, .35, 4, b, bt, Math.PI/4);
    z = box(g, 0, 0, z, .14, .14, .03, b, bt);
    z = frustum(g, 0, 0, z, .07, .02, .5, 4, b, bt, Math.PI/4);
    box(g, 0, 0, z, .012, .012, .12, b, bt); },
  bigben(g){ const s = lin('#c8b27a'), st = lin('#e2cf9b');
    let z = box(g, 0, 0, 0, .16, .16, .75, s, st);
    z = box(g, 0, 0, z, .19, .19, .14, lin('#e9e2cf'), lin('#fff8e6'));
    pyramid(g, 0, 0, z, .19, .28, lin('#4b5a4f'));
    box(g, .28, 0, 0, .34, .2, .25, s, st); },
  liberty(g){ const p = lin('#9a9486'), pt = lin('#bdb7a8'), v = lin('#6fae98'), vt = lin('#8fd0b8');
    let z = frustum(g, 0, 0, 0, .2, .16, .12, 4, p, pt, Math.PI/4);
    z = box(g, 0, 0, z, .16, .16, .22, p, pt);
    const t = frustum(g, 0, 0, z, .07, .045, .38, 8, v, vt);
    ball(g, 0, 0, t, .045, v);
    box(g, .05, 0, t - .05, .025, .025, .22, v, vt);
    frustum(g, .05, 0, t + .17, .03, .045, .05, 8, lin('#e0b23c'), lin('#ffd76a')); },
  burj(g){ const c = lin('#c9d3dc'), ct = lin('#eef3f7'); let z = 0, r = .16;
    for(let i = 0; i < 7; i++){ const nr = r * .78; z = frustum(g, 0, 0, z, r, nr, .22, 6, c, ct); r = nr; }
    frustum(g, 0, 0, z, r, 0, .35, 6, c, ct); },
  pearl(g){ const s = lin('#b9b9c4'), p = lin('#d86aa0');
    for(const [x, y] of [[-.1,-.06],[.1,-.06],[0,.1]]) frustum(g, x, y, 0, .03, .03, .5, 6, s, s);
    ball(g, 0, 0, .12, .14, p);
    const z = frustum(g, 0, 0, .4, .035, .03, .45, 6, s, s);
    ball(g, 0, 0, z - .1, .08, p);
    frustum(g, 0, 0, z + .06, .015, 0, .3, 6, s, s); },
  mbs(g){ const c = lin('#d9dde2'), ct = lin('#f4f6f8');
    for(const x of [-.2, 0, .2]){ box(g, x, -.04, 0, .1, .08, .55, c, ct); box(g, x, .05, 0, .1, .08, .5, c, ct); }
    box(g, .04, 0, .55, .62, .14, .04, lin('#8fae78'), lin('#b9d6a0')); },
  opera(g){ const w = lin('#f2efe6'), b = lin('#b5886a');
    box(g, 0, 0, 0, .56, .3, .06, b, lin('#c99e7f'));
    for(const [x, h, s] of [[-.2,.24,.16],[-.07,.3,.2],[.07,.26,.17],[.2,.2,.14]]) pyramid(g, x, 0, .06, s, h, w); },
  bridge(g){ const r = lin('#c8442c'), rt = lin('#e45a3f');
    for(const x of [-.3, .3]){ box(g, x, -.04, 0, .05, .05, .6, r, rt); box(g, x, .04, 0, .05, .05, .6, r, rt); box(g, x, 0, .5, .05, .13, .04, r, rt); }
    box(g, 0, 0, .18, .9, .1, .03, r, rt);
    for(let i = 0; i < 6; i++){ const x = -.3 + i * .12, h = .22 + Math.abs(Math.cos(i / 5 * Math.PI)) * .28;
      box(g, x, .045, .21, .01, .01, h - .21, lin('#a33'), lin('#c44')); } },
  pagoda(g, gold){ const wall = lin(gold ? '#c9a227' : '#b53a2a'), roof = lin(gold ? '#e8c050' : '#2f5d4a'), rt = lin(gold ? '#ffe08a' : '#3f7a60');
    let z = box(g, 0, 0, 0, .4, .3, .08, lin('#9c9384'), lin('#bbb2a1'));
    for(let i = 0; i < 3; i++){ const s = .3 - i * .07;
      z = box(g, 0, 0, z, s, s * .8, .12, wall, wall);
      z = frustum(g, 0, 0, z, s * .85, s * .45, .07, 4, roof, rt, Math.PI/4); }
    frustum(g, 0, 0, z, .025, 0, .18, 6, lin('#e0b23c'), lin('#ffd76a')); },
  stupa(g){ const c = lin('#d9a82c'), ct = lin('#ffd76a'); let z = 0, r = .24;
    for(let i = 0; i < 5; i++){ z = frustum(g, 0, 0, z, r, r * .82, .08, 8, c, ct); r *= .78; }
    ball(g, 0, 0, z, r * 1.3, c, true);
    frustum(g, 0, 0, z + r * 1.2, r * .5, 0, .45, 8, c, ct); },
  aztec(g){ const c = lin('#b89a68'), ct = lin('#d4b886'); let z = 0;
    for(let i = 0; i < 4; i++) z = box(g, 0, 0, z, .5 - i * .1, .5 - i * .1, .08, c, ct);
    box(g, 0, 0, z, .12, .12, .08, lin('#8a7550'), ct); },
  mosque(g){ const w = lin('#ece3cf'), wt = lin('#fff8e8'), d = lin('#3f8a86');
    let z = box(g, 0, 0, 0, .34, .34, .16, w, wt);
    ball(g, 0, 0, z, .14, d, true);
    for(const x of [-.24, .24]){ const t = frustum(g, x, -.14, 0, .03, .025, .55, 8, w, wt); frustum(g, x, -.14, t, .03, 0, .08, 8, d, d); } },
  gateway(g){ const s = lin('#c9a46a'), st = lin('#e2c08a');
    for(const x of [-.17, .17]) box(g, x, 0, 0, .12, .16, .3, s, st);
    box(g, 0, 0, .3, .46, .16, .08, s, st);
    for(const x of [-.19, -.06, .06, .19]) frustum(g, x, 0, .38, .03, 0, .12, 6, s, st); },
  bank(g){ const w = lin('#e9e6dc'), wt = lin('#ffffff');
    const t = box(g, 0, 0, 0, .44, .3, .05, lin('#c9c4b6'), wt);
    for(const cx of [-.15, -.05, .05, .15]) box(g, cx, -.09, t, .04, .04, .22, w, wt);
    box(g, 0, .05, t, .38, .14, .22, lin('#d8d3c6'), wt);
    const r = box(g, 0, 0, t + .22, .46, .32, .04, w, wt);
    pyramid(g, 0, 0, r, .36, .1, lin('#7c8c96')); },
  skyline(g, tint){ const c = lin(tint || '#6f93b8'), ct = lin('#cfe3f5');
    for(const [x, y, h, w] of [[0,0,.9,.13],[-.17,.06,.6,.12],[.16,-.05,.7,.12],[-.05,-.16,.45,.1],[.12,.15,.4,.1]]){
      const t = box(g, x, y, 0, w, w, h, c, ct);
      if(h > .8) frustum(g, x, y, t, w * .35, 0, .22, 4, c, ct, Math.PI/4); } },
  needle(g, pod){ const c = lin('#cfcfcf'), ct = lin('#f0f0f0');
    const z = frustum(g, 0, 0, 0, .09, .04, 1.1, 6, c, ct);
    frustum(g, 0, 0, z - .3 + (pod || 0), .16, .16, .09, 10, lin('#8a9097'), lin('#b8bec5'));
    frustum(g, 0, 0, z, .025, 0, .4, 6, c, ct);
    box(g, 0, 0, 0, .3, .3, .05, lin('#9a9486'), lin('#bdb7a8')); },
  palm(g){ const t = lin('#8a6a44'), l = lin('#3f9a4a'), lt = lin('#6cc46f');
    let z = 0; for(let i = 0; i < 5; i++) z = frustum(g, i * .012, 0, z, .035, .03, .1, 6, t, t);
    for(let i = 0; i < 6; i++){ const a = i / 6 * Math.PI * 2; box(g, .06 + Math.cos(a) * .12, Math.sin(a) * .12, z - .03, .2, .05, .02, l, lt); }
    box(g, 0, 0, 0, .5, .34, .02, lin('#e6d6a8'), lin('#f4e6bc')); },
  lighthouse(g){ let z = 0; for(let i = 0; i < 5; i++) z = frustum(g, 0, 0, z, .1 - i * .008, .092 - i * .008, .12, 10, lin(i % 2 ? '#f4f4f4' : '#c8322a'), lin('#fff'));
    z = frustum(g, 0, 0, z, .07, .07, .08, 10, lin('#ffe08a'), lin('#fff4c0'));
    frustum(g, 0, 0, z, .08, 0, .08, 10, lin('#333'), lin('#444')); },
  fab(g){ const w = lin('#dfe5ea'), wt = lin('#ffffff');
    const t = box(g, 0, 0, 0, .6, .36, .16, w, wt);
    for(let i = 0; i < 4; i++) pyramid(g, -.22 + i * .15, 0, t, .14, .06, lin('#8fa6b8'));
    for(const x of [-.2, .2]) frustum(g, x, .22, 0, .04, .035, .42, 8, lin('#b0b7bd'), lin('#d0d6db')); },
  headframe(g){ const s = lin('#6d767e'), st = lin('#9aa3ab');
    let z = 0, w = .3; for(let i = 0; i < 4; i++){ z = frustum(g, 0, 0, z, w * .7, w * .55, .14, 4, s, st, Math.PI/4); w *= .78; }
    frustum(g, 0, 0, z, .1, .1, .03, 12, lin('#444'), lin('#666'));
    box(g, .3, 0, 0, .26, .22, .12, lin('#8a6a44'), lin('#a98256')); },
  saucer(g){ const c = lin('#c9a46a'), ct = lin('#e2c08a');
    const z = frustum(g, 0, 0, 0, .1, .09, .7, 10, c, ct);
    frustum(g, 0, 0, z, .12, .22, .05, 12, lin('#8a6a44'), lin('#a98256'));
    box(g, .22, 0, 0, .2, .3, .14, lin('#b0a898'), lin('#d0c8b8')); },
  luxor(g){ pyramid(g, 0, 0, 0, .56, .5, lin('#2b2f3a'));
    frustum(g, 0, 0, .5, .01, .01, .6, 4, lin('#fff6c0'), lin('#fff6c0')); },
  casino(g){ const w = lin('#efe6d2'), wt = lin('#fffaf0');
    const t = box(g, 0, 0, 0, .5, .3, .18, w, wt);
    ball(g, 0, 0, t, .1, lin('#6b8c84'), true);
    for(const x of [-.21, .21]){ const tt = box(g, x, 0, t, .08, .08, .1, w, wt); pyramid(g, x, 0, tt, .09, .08, lin('#6b8c84')); } },
  spire(g){ frustum(g, 0, 0, 0, .05, 0, 1.3, 8, lin('#c9d3dc'), lin('#eef3f7'));
    box(g, 0, 0, 0, .3, .3, .03, lin('#9a9486'), lin('#bdb7a8')); },
  kingdom(g){ const c = lin('#8fa2b3'), ct = lin('#c7d6e3');
    const z = frustum(g, 0, 0, 0, .2, .14, .8, 4, c, ct, Math.PI/4);
    for(const s of [-1, 1]) frustum(g, s * .07, 0, z, .07, .01, .3, 4, c, ct, Math.PI/4);
    box(g, 0, 0, z + .2, .16, .04, .03, lin('#dfe8f0'), lin('#fff')); },
  monas(g){ const w = lin('#f0f0ea'), wt = lin('#ffffff');
    let z = frustum(g, 0, 0, 0, .3, .24, .1, 4, w, wt, Math.PI/4);
    z = frustum(g, 0, 0, z, .07, .04, .75, 4, w, wt, Math.PI/4);
    frustum(g, 0, 0, z, .07, .04, .09, 8, lin('#e0b23c'), lin('#ffd76a')); },
  castle(g){ const w = lin('#f2f0ea'), wt = lin('#fff'), r = lin('#3c5a6e'), rt = lin('#56788e');
    let z = box(g, 0, 0, 0, .46, .4, .14, lin('#8e8a82'), lin('#aaa59b'));
    for(let i = 0; i < 4; i++){ const s = .32 - i * .06; z = box(g, 0, 0, z, s, s * .85, .1, w, wt); z = frustum(g, 0, 0, z, s * .8, s * .5, .06, 4, r, rt, Math.PI/4); }
    box(g, 0, 0, z, .04, .04, .06, lin('#e0b23c'), lin('#ffd76a')); },
};
/* 每座城市用哪一個。名字會出現在城市的懸停小卡上。 */
const LANDMARK = {
  nyc:['liberty','自由女神像'], sfo:['bridge','金門大橋'], mia:['palm','南灘'], las:['luxor','賭城大道'],
  hou:['lattice','石油井架',0], del:['bank','公司註冊處'], chi:['skyline','天際線','#4c5d73'], tor:['needle','西恩塔'],
  lon:['bigben','大笨鐘'], zur:['bank','班霍夫大街銀行'], fra:['skyline','銀行區','#5d7fa6'], par:['eiffel','艾菲爾鐵塔'],
  dub:['spire','都柏林尖塔'], lux:['castle','盧森堡老城'], mon:['casino','蒙地卡羅賭場'], hkg:['skyline','維港天際線','#3f6c8e'],
  sha:['pearl','東方明珠'], shz:['skyline','平安金融中心','#6a8aa6'], bjs:['pagoda','天安門'], tpe:['t101','台北 101'],
  hsz:['fab','晶圓廠'], tky:['lattice','東京鐵塔',1], osa:['castle','大阪城'], seo:['needle','首爾塔',.12],
  sin:['mbs','濱海灣金沙'], bkk:['stupa','大皇宮'], jkt:['monas','民族紀念碑'], hcm:['skyline','金融塔','#5f8fa0'],
  syd:['opera','雪梨歌劇院'], dxb:['burj','哈里發塔'], ruh:['kingdom','王國中心'], doh:['mosque','伊斯蘭藝術館'],
  tlv:['skyline','白城天際線','#8aa4b8'], bom:['gateway','印度門'], blr:['fab','科技園區'], sao:['skyline','保利斯塔大道','#7b8794'],
  mex:['aztec','太陽金字塔'], scl:['needle','科斯塔內拉塔',-.1], jnb:['headframe','金礦井架'], lag:['skyline','維多利亞島','#7a9a8a'],
  nbo:['saucer','肯亞塔國際會議中心'], cay:['palm','七哩海灘'], vgb:['palm','維京群島'], bmu:['lighthouse','吉布斯山燈塔'],
};
W3D.landmarkName = id => (LANDMARK[id] || [])[1] || '';
function buildLandmark(d){
  const L = LANDMARK[d.id]; if(!L) return null;
  const [k, , arg] = L;
  const geo = geoFor('lm:' + d.id, g => (LM[k] || LM.skyline)(g, arg));
  const root = new T.O3();
  root.add(new T.Mesh(geo, MAT));
  root.userData.site = d; root.userData.lm = true;
  root.visible = !FAR;
  OBJS.add(root);
  return root;
}

/* 一個據點（或一個對手大本營）的整座小城 */
function buildSite(d){
  if(d._lm) return buildLandmark(d) || new T.O3();
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
/* 近看要縮小:第一版最小 .55,貼近台灣時一座小城比新竹市還大,半個都站到海裡去了 */
const bScale = () => clamp(.15 + W3D.alt * 2.2, .38, 5.5);
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
  const s = bScale() * (obj.userData.troop ? 1.45 : obj.userData.lm ? 1.6 : 1);   // 地標也放大:中距離要認得出是哪一座
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
        if(W3D.aiming()) return;
        if(d._units){ let c = null; try{ c = G.getScreenCoords(d.lat, d.lng, .002); }catch(e){}
                      unitPop(d, c ? c.x : 100, c ? c.y : 100); }
        else if(d._threat){ TY_MODAL = 'troop'; renderPage(); }
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
    /* 高解析度螢幕(像素比 2~3)等於每一幀畫四到九倍的像素。上限 1.5:
       肉眼幾乎看不出差別,GPU 的工作量少一半以上。 */
    try{ G.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); }catch(e){}
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

/* 一座城市周圍有哪幾個方向是陸地(依偏好排好:東南、西南、東北、西北、南、北、東、西)。
   使用者截圖:「怎麼建築在海上」、「如果之後對手也在台灣設點會很擠」——
   同一座城市旁邊可能同時有你的小城、對手的大本營、地標、兩群部隊。
   所以先把「陸地上的空位」列出來,再一個一個分出去,不要全部擠在同一點、也不要站到海上。 */
const SLOTS_C = Object.create(null);
function citySlots(id, lat, lng){
  const key = id + (W3D.hiFeats ? ':h' : '');
  if(SLOTS_C[key]) return SLOTS_C[key];
  const land = [], sea = [];
  for(const a of DIRS){
    const k = 1 / Math.max(.2, Math.cos(lat * Math.PI / 180));
    const on = r => W3D.featAt(lat + Math.sin(a) * r, lng + Math.cos(a) * r * k);
    (on(.28) && on(.5) ? land : on(.28) ? land : sea).push(a);
  }
  return (SLOTS_C[key] = land.concat(sea));
}
const slotOff = (a, r) => [Math.cos(a) * (r || 1.3), Math.sin(a) * (r || 1.3)];

W3D.sites = function(mine, rivals, troops){
  if(!W3D.ok) return;
  paintSkin();
  const rvMax = Math.max(1, ...rivals.map(r => r._v || 0));
  rivals.forEach(r => { r._rvk = Math.sqrt((r._v || 0) / rvMax); });
  /* 分位子:城市正中央給你的小城(沒有的話給對手大本營),其餘的依序拿陸地上的空位 */
  const used = Object.create(null);
  const take = (id, lat, lng, r) => {
    const sl = citySlots(id, lat, lng), n = used[id] = (used[id] || 0);
    used[id]++;
    return slotOff(sl[n % sl.length], r || (1.3 + Math.floor(n / sl.length) * .9));
  };
  const center = new Set(mine.map(d => d.id));
  for(const d of rivals){
    if(center.has(d.id)) d._off = take(d.id, d.lat, d.lng);
    else { d._off = null; center.add(d.id); }
  }
  const siteOf = d => (typeof TY_SITES !== 'undefined' ? TY_SITES : []).find(st => Math.abs(st.lat - d.lat) < 1e-6 && Math.abs(st.lng - d.lng) < 1e-6);
  const tr = (troops || []).map(d => {
    const o = { ...d, _base: .0008 };
    delete o._arc;
    if(d._threat){ o._off = null; o._sea = !W3D.featAt(d.lat, d.lng); return o; }
    const st = siteOf(d);
    if(st){ o._off = take(st.id, st.lat, st.lng); o._sea = false; }   // 駐紮 / 下季到位:城市旁邊的陸地上
    else o._sea = !W3D.featAt(d.lat, d.lng);
    return o;
  });
  TROOPS = tr;
  /* 地標:每一座城市都有。正中央空著就站中央,不然也去拿一個陸地上的空位。 */
  const lms = (typeof TY_SITES !== 'undefined' ? TY_SITES : []).map(st => ({
    id: st.id, lat: st.lat, lng: st.lng, iso: st.iso, _lm: true, _k: 'lm:' + st.id, _base: .0008,
    _off: center.has(st.id) ? take(st.id, st.lat, st.lng) : null }));
  G.customLayerData([...mine, ...rivals, ...tr, ...lms]);
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
      el.innerHTML = `${ics}${d._mv ? ` <b>下季到位</b>` : d._units.length > 1 ? ` <b>×${d._units.length}</b>` : ''}`;
      el.title = d._units.map(u => TY_UNITS[u.k].nm + (u.to ? ` → ${tySite(u.to).nm}` : '')).join('、');
    }
    if(d._threat) el.onclick = () => { TY_MODAL = 'troop'; renderPage(); };
    else armTagDrag(el, d);
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
let ROUTES = [], HOVER = [], SELB = [];
/* 城市的真實範圍(cities.json:Natural Earth 的都市範圍,沒有的用省州邊界)。
   使用者:「城市範圍是城市的真實邊界」—— 第一版畫的是一個圓圈。
   44 座城市、壓縮後約 40KB,第一次需要的時候才抓。抓不到就退回圓圈。 */
let CITY_B = null, cityLoading = false;
function cityBounds(){
  if(CITY_B || cityLoading) return CITY_B;
  cityLoading = true;
  fetch('cities.json').then(r => r.ok ? r.json() : null).then(j => {
    CITY_B = j || {};
    hoverKey = ''; W3D.rings();                               // 抓到了:重畫選中城市的邊界
  }).catch(() => { CITY_B = {}; });
  return null;
}
function cityPaths(id, col, w){
  const b = cityBounds();
  if(!b || !b[id] || !b[id].length) return null;
  return b[id].map(r => ({ pts: r, col, w, alt: .0016 }));
}
function gcPts(a, b, n){
  const out = [];
  for(let i = 0; i <= n; i++){ const p = tyGeoLerp(a, b, i / n); out.push([p.lng, p.lat]); }
  return out;
}
function pushPaths(){
  if(!W3D.ok || typeof G.pathsData !== 'function') return;
  const tr = [];
  for(const t of TRAILS.values()) if(t.length > 1) tr.push({ pts: t, col: ['rgba(255,220,160,0)', 'rgba(255,150,60,.95)'], w: 1.3 });
  G.pathsData([...ROUTES, ...SELB, ...HOVER, ...AIMP, ...tr]);
}
function setupPaths(){
  if(typeof G.pathsData !== 'function') return;
  G.pathsData([])
   .pathPoints('pts').pathPointLat(p => p[1]).pathPointLng(p => p[0])
   .pathPointAlt(p => p[2] != null ? p[2] : .0014)
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
  return rings.map(r => ({ pts: thin(r, 900), col: 'rgba(255,236,150,.95)', w: .7, alt: .0016 }));
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
      HOVER = cityPaths(s.id, 'rgba(255,236,150,1)', .9)
           || [{ pts: ringPts(s.lat, s.lng, clamp(W3D.alt * 2.6, .25, 4)), col: 'rgba(255,236,150,.95)', w: .4, alt: .0016,
                 dash: .06, gap: .03, anim: 4000 }];
      html = `<b>${flag(s.iso)} ${escH(s.nm)}${t.val > 0 ? ` <em class="lv">${tySiteLv(t.val)}</em>` : ''}</b>`
        + (W3D.landmarkName(s.id) ? `<span class="dim">地標 · ${escH(W3D.landmarkName(s.id))}</span>` : '')
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

/* =============================================================================
   出發動畫 —— 飛機、船、卡車、飛彈、戰機
   -----------------------------------------------------------------------------
   使用者:「律師團要去國外可以有飛機起飛,依照航線到目的地降落;搭船也會下港、
            開船依照航線到目的地上岸。飛彈、空襲都要有動畫」。
   規則上派出去的部隊下一季才到位 —— 這裡演的是「出發的那一趟」,演完它就站在
   目的地,標籤寫著下季到位。動畫一律是畫面層的事,不碰任何數字。

   載具的方向:x = 前進方向、z = 地表法線,每一幀用前後兩點算。
   ============================================================================= */
const VEH = {
  plane(g){ const w = lin('#eef2f6'), wt = lin('#ffffff'), b = lin(TEAM);
    box(g, 0, 0, 0, .5, .08, .08, w, wt);                    // 機身
    frustum(g, .25, 0, .0, .04, 0, .1, 6, w, wt);              // 機鼻(朝上的錐,之後用方向蓋過去也看得出來)
    box(g, .02, 0, .03, .14, .62, .02, lin('#c9d3dc'), wt);  // 主翼
    box(g, -.22, 0, .03, .07, .22, .015, lin('#c9d3dc'), wt);// 水平尾翼
    box(g, -.22, 0, .08, .08, .015, .12, b, lin(TEAM, 1.2));  // 垂直尾翼(隊伍色)
    for(const y of [-.16, .16]) box(g, .05, y, -.02, .1, .045, .04, lin('#8a96a2'), lin('#b0bac4')); },  // 引擎
  ship(g){ drawUnit(g, 'ship', 0, 0, 0); },
  truck(g){ const c = lin('#5d6b45'), ct = lin('#7d8d5c');
    box(g, -.04, 0, .03, .26, .14, .11, c, ct);
    box(g, .15, 0, .03, .1, .13, .08, lin('#46523a'), lin('#5d6b45'));
    for(const x of [-.12, .02, .15]) for(const y of [-.075, .075]) frustum(g, x, y, 0, .035, .035, .02, 8, lin('#222'), lin('#444')); },
  missile(g){ const w = lin('#e9ecef'), r = lin('#c8322a');
    box(g, 0, 0, 0, .34, .05, .05, w, lin('#ffffff'));
    box(g, .2, 0, 0, .06, .04, .04, r, r);
    for(const [y, z] of [[.05, 0], [-.05, 0], [0, .05], [0, -.05]]) box(g, -.15, y, z, .06, y ? .04 : .01, z ? .04 : .01, r, r); },
  jet(g){ const c = lin('#7c8792'), ct = lin('#a3adb7');
    box(g, 0, 0, 0, .42, .06, .06, c, ct);
    box(g, .24, 0, 0, .08, .04, .04, lin('#5d6770'), ct);
    box(g, -.02, 0, .01, .18, .44, .015, c, ct);
    box(g, -.18, 0, .05, .07, .012, .1, lin('#c8322a'), lin('#e04a3a')); },
};
function vehGeo(k){ return geoFor('veh:' + k, g => VEH[k](g)); }

/* ---- 海上航線 ----
   不做真的航海計算:約六十個航點(海峽、運河、大洋上的轉折點)連成一張網,
   船走最短路徑。每座城市的港口 = 離它最近的航點;內陸城市先開卡車到港口。 */
const SEA = {
  twn:[24,119.6], luz:[20.5,121.5], hkg:[21.8,114.3], scs:[14.5,114.5], vnm:[9.5,108.5], gth:[10.5,101.5],
  sgp:[1.2,104.3], mal:[4.5,99], jav:[-5.5,110.5], ecs:[29.5,124], yel:[36,123.5], krs:[34.3,129.2],
  jpn:[33.5,136], tky:[34.8,140.2], phl:[12,127], cor:[-18,155], syd:[-34,151.8], aus:[-38,120],
  hwi:[21,-157.5], npc:[40,-150], sfo:[37.6,-123.3], mxp:[16,-102], pnp:[7.5,-79.8], pnc:[10,-79.3],
  car:[17.5,-78], cay:[19.2,-81.5], gom:[25,-90], hou:[28.8,-94.5], mia:[25.6,-79.8], vgb:[18.6,-64.4],
  bmu:[32.2,-64.6], nyc:[40.3,-73.3], del:[38.7,-74.8], nat:[42,-45], eng:[49.9,-3], nse:[53,3.5],
  irl:[53.3,-5.8], bis:[45,-9], gib:[36,-6.5], med:[37.5,6], mon:[43.4,7.6], emd:[33.5,28], sue:[30,32.5],
  red:[20,38.5], adn:[12.5,45.5], ara:[18,62], hor:[26.3,56.6], pgf:[26,52], bom:[18.6,72.3], lka:[5.8,80.5],
  ben:[15,88], ind:[-10,90], cpt:[-35,18.5], moz:[-25,37], mbs:[-4.2,40.5], gng:[4,3], lag:[6.2,3.4],
  waf:[14,-19], bra:[-8,-33], san:[-24.3,-45.5], sat:[-20,-10], chl:[-33,-72], per:[-12,-78.5], hrn:[-56,-67],
};
const SEA_E = ('twn-hkg twn-luz twn-ecs luz-phl luz-scs hkg-scs scs-vnm vnm-gth vnm-sgp gth-sgp sgp-mal sgp-jav '
  + 'mal-lka mal-ben jav-cor jav-aus ecs-yel ecs-krs ecs-jpn krs-jpn jpn-tky tky-npc phl-cor phl-hwi cor-syd '
  + 'syd-aus aus-ind npc-hwi npc-sfo hwi-sfo sfo-mxp mxp-pnp pnp-per per-chl chl-hrn hrn-san pnp-pnc pnc-car '
  + 'car-cay car-gom gom-hou gom-mia car-vgb mia-bmu mia-nyc bmu-nyc bmu-nat vgb-nat vgb-bra nyc-del nyc-nat '
  + 'nat-eng nat-irl nat-bis eng-nse eng-irl eng-bis bis-gib gib-med med-mon med-emd emd-sue sue-red red-adn '
  + 'adn-ara ara-hor hor-pgf ara-bom bom-lka lka-ben lka-ind adn-mbs mbs-moz moz-cpt ind-moz cpt-sat sat-bra '
  + 'sat-gng gng-lag gng-waf waf-gib waf-bra bra-san san-sat').split(' ').map(e => e.split('-'));
const kmLL = (a, b) => typeof tyKm === 'function' ? tyKm({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] }) : 1000;
function seaPath(from, to){
  const near = p => Object.keys(SEA).sort((x, y) => kmLL(p, SEA[x]) - kmLL(p, SEA[y]))[0];
  const a = near(from), b = near(to);
  const adj = {}; for(const [x, y] of SEA_E){ (adj[x] = adj[x] || []).push(y); (adj[y] = adj[y] || []).push(x); }
  const dist = { [a]: 0 }, prev = {}, left = new Set(Object.keys(SEA));
  while(left.size){
    let u = null; for(const n of left) if(dist[n] !== undefined && (u === null || dist[n] < dist[u])) u = n;
    if(u === null || u === b) break;
    left.delete(u);
    for(const v of adj[u] || []){ const d = dist[u] + kmLL(SEA[u], SEA[v]); if(dist[v] === undefined || d < dist[v]){ dist[v] = d; prev[v] = u; } }
  }
  const nodes = [b]; while(nodes[0] !== a && prev[nodes[0]]) nodes.unshift(prev[nodes[0]]);
  return nodes.map(n => SEA[n]);
}
/* 一條路線 = 很多小段,每段有它的交通工具。回傳細分好的點與每一點的載具。 */
function legPts(a, b, mode, out){
  const km = kmLL(a, b), n = clamp(Math.round(km / 80), 4, 120);
  for(let i = out.length ? 1 : 0; i <= n; i++){
    const p = tyGeoLerp({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] }, i / n);
    out.push({ lat: p.lat, lng: p.lng, mode });
  }
}
function routeFor(kind, A, B){
  const a = [A.lat, A.lng], b = [B.lat, B.lng], pts = [];
  if(kind === 'plane' || kind === 'missile' || kind === 'jet'){ legPts(a, b, kind, pts); return pts; }
  if(kmLL(a, b) < 1200){ legPts(a, b, 'truck', pts); return pts; }
  const sea = seaPath(a, b);
  legPts(a, sea[0], 'truck', pts);                          // 開到港口
  for(let i = 1; i < sea.length; i++) legPts(sea[i-1], sea[i], 'ship', pts);
  legPts(sea[sea.length-1], b, 'truck', pts);                // 上岸
  return pts;
}

/* 播一趟:沿著路線走,依載具換模型;飛機 / 飛彈有高度曲線。 */
let ANIMS = [], animOn = false;
function animHost(){ return patchHost(); }
function spawnVeh(k){
  const m = new T.Mesh(vehGeo(k), MAT);
  const h = animHost(); if(!h) return null;
  h.add(m); return m;
}
function orient(obj, p, q){
  // p、q:世界(圖層)座標的目前位置與下一個位置
  const l = Math.hypot(p.x, p.y, p.z) || 1, nx = p.x/l, ny = p.y/l, nz = p.z/l;
  let fx = q.x - p.x, fy = q.y - p.y, fz = q.z - p.z;
  const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
  // 上方向:法線去掉跟前進方向平行的部分(爬升 / 俯衝時機身會跟著仰 / 俯)
  const dot = nx*fx + ny*fy + nz*fz;
  let ux = nx - dot*fx, uy = ny - dot*fy, uz = nz - dot*fz;
  const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
  const yx = uy*fz - uz*fy, yy = uz*fx - ux*fz, yz = ux*fy - uy*fx;   // y = up × forward
  obj.matrix.set(fx, yx, ux, 0,  fy, yy, uy, 0,  fz, yz, uz, 0,  0, 0, 0, 1);
  obj.quaternion.setFromRotationMatrix(obj.matrix);
  obj.position.set(p.x, p.y, p.z);
}
/* opt: { kind, from, to, dur, arc(高度峰值), off(側向偏移度數), done } */
function fly(opt){
  if(!W3D.ok) return;
  const pts = routeFor(opt.kind, opt.from, opt.to);
  if(pts.length < 2) return;
  // 每一點的累積距離,速度才會均勻
  const cum = [0]; for(let i = 1; i < pts.length; i++) cum.push(cum[i-1] + kmLL([pts[i-1].lat, pts[i-1].lng], [pts[i].lat, pts[i].lng]));
  const tot = cum[cum.length-1] || 1;
  const a = { pts, cum, tot, t0: performance.now(), dur: opt.dur || clamp(1800 + tot * .2, 2200, 6500),
              arc: opt.arc || 0, off: opt.off || 0, kind: opt.kind, mesh: null, mk: '', done: opt.done, trail: opt.trail ? [] : null };
  ANIMS.push(a);
  if(!animOn){ animOn = true; requestAnimationFrame(animStep); }
}
function posAt(a, u){
  let i = 1; while(i < a.cum.length - 1 && a.cum[i] < u * a.tot) i++;
  const s0 = a.cum[i-1], s1 = a.cum[i], f = s1 > s0 ? (u * a.tot - s0) / (s1 - s0) : 0;
  const p0 = a.pts[i-1], p1 = a.pts[i];
  let lat = p0.lat + (p1.lat - p0.lat) * f, lng = p0.lng + (((p1.lng - p0.lng + 540) % 360) - 180) * f;
  if(a.off){ lat += a.off; }
  // 高度:飛機起飛前在跑道上滑一段、降落後再滑一段;飛彈是一道拋物線
  let alt = .0012;
  if(a.arc){
    const e = a.kind === 'missile' ? Math.sin(Math.PI * u) : smooth(clamp((u - .06) / .22, 0, 1)) * smooth(clamp((.94 - u) / .22, 0, 1));
    alt += a.arc * e;
  }
  return { lat, lng, alt, mode: p0.mode };
}
function animStep(now){
  const keep = [];
  for(const a of ANIMS){
    const u = clamp((now - a.t0) / a.dur, 0, 1);
    const P = posAt(a, u), Q = posAt(a, Math.min(1, u + .004));
    const mk = a.kind === 'jet' ? 'jet' : a.kind === 'missile' ? 'missile' : a.kind === 'plane' ? 'plane' : P.mode;
    if(mk !== a.mk){ if(a.mesh && a.mesh.parent) a.mesh.parent.remove(a.mesh); a.mesh = spawnVeh(mk); a.mk = mk; }
    if(a.mesh){
      const p = G.getCoords(P.lat, P.lng, P.alt), q = G.getCoords(Q.lat, Q.lng, Q.alt);
      if(u >= 1){ q.x = p.x + (p.x - (a._lx || p.x)); q.y = p.y + (p.y - (a._ly || p.y)); q.z = p.z + (p.z - (a._lz || p.z)); }
      orient(a.mesh, p, q); a._lx = p.x; a._ly = p.y; a._lz = p.z;
      const s = bScale() * (mk === 'missile' ? 1.3 : 1.5);
      a.mesh.scale.set(s, s, s);
    }
    if(a.trail){                                          // 飛彈的尾煙:沿路留下的點
      a.trail.push([P.lng, P.lat, P.alt]);
      TRAILS.set(a, a.trail);
    }
    if(u < 1) keep.push(a);
    else{
      if(a.mesh && a.mesh.parent) a.mesh.parent.remove(a.mesh);
      if(a.trail) setTimeout(() => { TRAILS.delete(a); pushPaths(); }, 1200);
      if(a.done) a.done();
    }
  }
  ANIMS = keep;
  if(TRAILS.size) pushPaths();
  if(ANIMS.length) requestAnimationFrame(animStep); else animOn = false;
}
const TRAILS = new Map();

/* 爆炸:一圈快速擴散的橘紅光圈 + 螢幕上的閃光與「💥」 */
function boom(lat, lng, big){
  W3D.extraRings = W3D.extraRings.concat([
    { lat, lng, _rgb: '255,140,40', _a: 1, _r: big ? 4.5 : 2.6, _v: big ? 6 : 4, _p: 380 },
    { lat, lng, _rgb: '255,60,30', _a: .9, _r: big ? 3 : 1.8, _v: 3, _p: 520 }]);
  W3D.rings();
  const fx = fxLayer();
  if(fx){
    let c = null; try{ c = G.getScreenCoords(lat, lng, .002); }catch(e){}
    if(c){
      const el = document.createElement('div'); el.className = 'w3d-boom' + (big ? ' big' : '');
      el.style.left = c.x + 'px'; el.style.top = c.y + 'px';
      fx.appendChild(el); setTimeout(() => el.remove(), 1100);
    }
  }
  clearTimeout(boom._t);
  boom._t = setTimeout(() => { W3D.extraRings = []; W3D.rings(); }, 1800);
}

/* 部隊出發:人搭飛機;併購小組近的開車、遠的走海運 */
W3D.animMove = function(m){
  if(!W3D.ok || !m) return;
  const A = tySite(m.from), B = tySite(m.to);
  const km = kmLL([A.lat, A.lng], [B.lat, B.lng]);
  if(m.k === 'raid') fly({ kind: 'ground', from: A, to: B });
  else fly({ kind: 'plane', from: A, to: B, arc: clamp(km / 9000 * .09, .012, .08) });
};
/* 打擊:飛彈從大本營拋過去;空襲是三架戰機編隊飛過去,到了一串爆炸 */
W3D.animStrike = function(s){
  if(!W3D.ok || !s) return;
  const A = tySite(s.from), B = tySite(s.to);
  const km = kmLL([A.lat, A.lng], [B.lat, B.lng]);
  if(s.k === 'missile'){
    fly({ kind: 'missile', from: A, to: B, arc: clamp(km / 6000 * .22, .05, .32), dur: clamp(1600 + km * .12, 1800, 3200),
          trail: true, done: () => { boom(B.lat, B.lng, true); } });
  }else{
    for(const [off, delay] of [[0, 0], [.35, 120], [-.35, 240]]){
      setTimeout(() => fly({ kind: 'jet', from: A, to: B, arc: .03, off, dur: clamp(1600 + km * .12, 1800, 3000),
        done: () => { for(let i = 0; i < 3; i++) setTimeout(() => boom(B.lat + (i - 1) * .18 + off * .4, B.lng + (i - 1) * .22, false), i * 160); } }), delay);
    }
  }
};

/* =============================================================================
   拉線:點部隊(或武器)→ 拉一條線到目標城市
   -----------------------------------------------------------------------------
   使用者:「點一下部隊就可以選擇要派哪些部隊、去哪個城市、攻擊哪一個對手,可以用拉線的」。
   兩種開始方式:
     · 從地圖上的部隊標籤直接**拖曳**出去,放開在城市上
     · 按「🎯 地圖上選」(部隊小卡、部隊面板、武器卡),然後點城市
   瞄準中:線從出發點跟著游標走,停在可以選的城市上會吸附並變綠、跳出說明;
   Esc 或「取消」離開。⚠ 瞄準中要擋掉地圖原本的點擊(開城市面板),不然點下去兩件事一起發生。
   ============================================================================= */
let AIM = null, AIMP = [];
W3D.aiming = () => !!AIM;
function aimBar(){
  let b = document.getElementById('w3dAim');
  const host = document.getElementById('tyGlobeHost');
  if(!b && host){ b = document.createElement('div'); b.id = 'w3dAim'; host.appendChild(b); }
  return b;
}
W3D.aim = function(opt){
  if(!W3D.ok) return;
  AIM = { ...opt, x: null, y: null, site: null };
  const b = aimBar();
  if(b){
    b.innerHTML = `<b>🎯 ${escH(opt.label || '選一座城市')}</b><span>點目標城市 · 拖曳可以轉地圖 · Esc 取消</span>`
      + `<button type="button">取消</button>`;
    b.style.display = '';
    b.querySelector('button').onclick = () => W3D.aimCancel();
  }
  const host = document.getElementById('tyGlobeHost'); if(host) host.dataset.aim = '1';
  armAim();
  drawAim();
};
W3D.aimCancel = function(){
  AIM = null; AIMP = []; pushPaths();
  const b = document.getElementById('w3dAim'); if(b) b.style.display = 'none';
  const host = document.getElementById('tyGlobeHost'); if(host) host.dataset.aim = '';
  if(hoverCard) hoverCard.style.display = 'none';
};
function drawAim(){
  if(!AIM) return;
  const A = AIM.from; let B = null, ok = false;
  if(AIM.site){ B = tySite(AIM.site); ok = AIM.valid(AIM.site); }
  else if(AIM.x != null){ try{ const p = G.toGlobeCoords(AIM.x, AIM.y); if(p) B = p; }catch(e){} }
  AIMP = [];
  if(B){
    const km = kmLL([A.lat, A.lng], [B.lat, B.lng]);
    const pts = gcPts(A, B, clamp(Math.round(km / 60), 6, 140));
    const col = AIM.site ? (ok ? 'rgba(90,230,120,1)' : 'rgba(255,90,70,1)') : 'rgba(255,225,120,1)';
    AIMP.push({ pts, col: 'rgba(8,20,31,.6)', w: 2.6 });
    AIMP.push({ pts, col, w: 1.5, dash: .05, gap: .025, anim: 1500 });
    if(AIM.site) AIMP.push({ pts: ringPts(B.lat, B.lng, clamp(W3D.alt * 1.6, .2, 3)), col, w: 1.2 });
  }
  pushPaths();
  // 說明小卡
  const host = document.getElementById('tyGlobeHost');
  if(AIM.site && host && AIM.x != null){
    if(!hoverCard || !hoverCard.isConnected){ hoverCard = document.createElement('div'); hoverCard.className = 'w3d-hover'; host.appendChild(hoverCard); }
    const s = tySite(AIM.site), h = AIM.hint ? AIM.hint(AIM.site) : '';
    hoverCard.innerHTML = `<b>${flag(s.iso)} ${escH(s.nm)}</b>${h ? `<span>${escH(h)}</span>` : ''}`
      + `<span class="${ok ? 'ok' : 'dim'}">${ok ? '✓ 點一下確定' : '✕ 這裡不行'}</span>`;
    hoverCard.style.display = '';
    hoverCard.style.transform = `translate(${AIM.x + 16}px,${Math.max(4, AIM.y - 10)}px)`;
  }else if(hoverCard) hoverCard.style.display = 'none';
}
function aimPick(x, y){
  if(!AIM) return false;
  const s = nearSite(x, y);
  if(!s || !AIM.valid(s.id)){ AIM.x = x; AIM.y = y; AIM.site = s ? s.id : null; drawAim(); return true; }
  const pick = AIM.pick;
  W3D.aimCancel();
  pick(s.id);
  return true;
}
let aimArmed = false, aimT = 0;
function armAim(){
  if(aimArmed) return;
  const host = document.getElementById('tyGlobeHost'); if(!host) return;
  aimArmed = true;
  const rel = ev => { const r = host.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  let down = null;
  host.addEventListener('pointerdown', ev => { if(AIM) down = rel(ev); }, true);
  host.addEventListener('pointermove', ev => {
    if(!AIM) return;
    const now = performance.now(); if(now - aimT < 30) return; aimT = now;
    const [x, y] = rel(ev);
    AIM.x = x; AIM.y = y;
    const s = nearSite(x, y); AIM.site = s ? s.id : null;
    drawAim();
  }, true);
  // 點擊 = 選目標(拖曳過的不算,那是在轉地圖)
  host.addEventListener('click', ev => {
    if(!AIM) return;
    if(ev.target.closest && ev.target.closest('#w3dAim')) return;
    ev.stopPropagation(); ev.preventDefault();
    const [x, y] = rel(ev);
    if(down && Math.hypot(x - down[0], y - down[1]) > 8) return;
    aimPick(x, y);
  }, true);
  addEventListener('keydown', ev => { if(AIM && ev.key === 'Escape') W3D.aimCancel(); });
}

/* ---- 點部隊:一張小卡,勾選要派哪幾支 ---- */
let UPOP = null;
function unitPop(d, x, y){
  const host = document.getElementById('tyGlobeHost'); if(!host) return;
  if(!UPOP || !UPOP.isConnected){ UPOP = document.createElement('div'); UPOP.id = 'w3dUnitPop'; host.appendChild(UPOP); }
  const units = d._units.slice();
  const where = units[0].to ? `→ ${tySite(units[0].to).nm}(下季到位)` : `駐 ${tySite(units[0].site).nm}`;
  UPOP.innerHTML = `<div class="up-h"><b>${units.length} 支部隊</b><em>${escH(where)}</em><button type="button" class="x">✕</button></div>`
    + units.map(u => `<label><input type="checkbox" checked data-u="${u.id}"> ${TY_UNITS[u.k].ic} ${escH(TY_UNITS[u.k].nm)}</label>`).join('')
    + `<div class="up-b"><button type="button" class="go">🎯 拉線派遣</button><button type="button" class="pn">部隊面板</button></div>`
    + `<div class="up-n">也可以直接從部隊標籤拖一條線到城市</div>`;
  UPOP.style.display = '';
  const w = host.clientWidth;
  UPOP.style.transform = `translate(${Math.min(w - 230, Math.max(6, x - 100))}px,${Math.max(6, y + 18)}px)`;
  UPOP.querySelector('.x').onclick = () => { UPOP.style.display = 'none'; };
  UPOP.querySelector('.pn').onclick = () => { UPOP.style.display = 'none'; TY_MODAL = 'troop'; renderPage(); };
  UPOP.querySelector('.go').onclick = () => {
    const ids = [...UPOP.querySelectorAll('input:checked')].map(i => +i.dataset.u);
    UPOP.style.display = 'none';
    const sel = tyUnits().filter(u => ids.includes(u.id));
    if(sel.length) tyAimUnits(sel);
  };
}
W3D.unitPop = unitPop;
/* 標籤上直接拖:按下去往外拉超過 10 像素就進入瞄準,放開的位置就是目標 */
function armTagDrag(el, d){
  el.addEventListener('pointerdown', ev => {
    if(!d._units) return;
    ev.preventDefault();
    const host = document.getElementById('tyGlobeHost'), r = host.getBoundingClientRect();
    const sx = ev.clientX, sy = ev.clientY; let dragging = false;
    const mv = e => {
      if(!dragging && Math.hypot(e.clientX - sx, e.clientY - sy) > 10){
        dragging = true;
        tyAimUnits(d._units.slice());
      }
      if(dragging && AIM){ AIM.x = e.clientX - r.left; AIM.y = e.clientY - r.top; const s = nearSite(AIM.x, AIM.y); AIM.site = s ? s.id : null; drawAim(); }
    };
    const up = e => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
      if(dragging){ aimPick(e.clientX - r.left, e.clientY - r.top); }
      else unitPop(d, sx - r.left, sy - r.top);
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
}

/* 光圈：你的大本營一圈慢慢擴散的金色、目前選的據點一圈青色，
   加上過場時臨時加的（賺錢綠、賠錢紅、對手的顏色）。 */
W3D.rings = function(){
  if(!W3D.ok || typeof G.ringsData !== 'function' || !TY) return;
  const out = [];
  const home = tySite(TY.home);
  out.push({ lat: home.lat, lng: home.lng, _rgb: '255,205,90', _a: .7, _r: 2.6, _v: 1.2, _p: 2200 });
  // 選中的城市:常駐描出它的真實邊界(青色)
  SELB = (typeof TY_SEL !== 'undefined' && TY_SEL && cityPaths(TY_SEL, 'rgba(79,215,255,1)', 1.1)) || [];
  pushPaths();
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
  /* ⚠ 一定要用這個事件帶來的高度。W3D.alt 是傾斜鏡頭每一幀「算完之後」才更新的,
     而這個事件是在那之前觸發的 —— 用 W3D.alt 的話,鏡頭停下來的那一刻縮放的是
     **上一刻**的高度,之後沒有新事件,建築就一直維持拉遠時的超大尺寸(偏移量也跟著放大,
     部隊被推到海上去)。自轉的時候事件不斷,這個 bug 被蓋住了。 */
  if(pov && isFinite(pov.altitude)) W3D.alt = pov.altitude;
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
  for(const o of OBJS) if(o.userData.troop || o.userData.lm) o.visible = !far;
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
