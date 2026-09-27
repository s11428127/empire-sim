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
const OBJS = new Set();            // 目前在場上的建築群（縮放時要一個一個調）
const SEEN = Object.create(null);  // 每個據點上一次長什麼樣（決定要不要播「長出來」）

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

/* 底圖:像素地形(海、大陸棚、依緯度與沙漠區的地貌、山脈、湖泊、河流,見 terrain.js)。
   使用者:「地圖也改成像素的」。整球貼圖固定 2048×1024(一個像素約 0.18 度),放大時用最近鄰取樣 ——
   方塊就是方塊,不會糊成一片。 */
function paintBase(feats){
  const W = Math.min(2048, texSize()), H = W / 2;
  const cv = BASE || document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  TERRAIN.paint(c, { lo0: -180, lo1: 180, la0: -90, la1: 90, global: true }, W, H, ctx => landPath(ctx, feats, W, H));
  BASE = cv;
}

/* 上層：底圖 + 勢力顏色 + 國界。只有在「誰的顏色」變了才重畫 —— 每一次點擊都重畫
   一張 8K 貼圖，手機會卡。 */
function paintTop(force){
  if(!BASE || !TEX || !FEATS || typeof tyCountryColor !== 'function' || !TY) return;
  const cols = FEATS.map(f => { try{ return tyCountryColor(f); }catch(e){ return ''; } });
  const ccols = cityCols();
  const sig = (typeof TY_LAYER !== 'undefined' ? TY_LAYER : '') + '|' + cols.join('|') + '|' + ccols.map(x => x[0] + x[1]).join('|');
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
    c.lineWidth = Math.max(2, 3.2*k); c.strokeStyle = cols[i].replace(/,\s*([\d.]+)\)$/, ',.95)');
    c.stroke(p);
  });
  // 國界：白色細線，跟參考畫面一樣
  c.lineWidth = 1; c.strokeStyle = 'rgba(255,255,255,.7)'; c.stroke(allP2D(FEATS, W, H));
  // 勢力圖層:城市的真實範圍塗上「這座城是誰的」(國家之下的第二層)
  for(const [id, col] of ccols){
    const p = cityP2D(id, W, H); if(!p) continue;
    c.fillStyle = col; c.fill(p, 'evenodd');
    c.lineWidth = 2*k; c.strokeStyle = col.replace(/,\s*([\d.]+)\)$/, ',1)'); c.stroke(p);
  }
  TEX.needsUpdate = true;
}
/* 勢力圖層的城市顏色:[[id, 'rgba(...)'], ...]。cities.json 還沒到就先觸發下載,到了再重畫。 */
function cityCols(){
  if(typeof TY_LAYER === 'undefined' || TY_LAYER !== 'power' || typeof tyCityColor !== 'function') return [];
  const B = cityBounds(); if(!B) return [];
  const out = [];
  for(const id in B){ let col = ''; try{ col = tyCityColor(id); }catch(e){} if(col) out.push([id, col]); }
  return out;
}
const CITY_P2D = Object.create(null);
function cityP2D(id, W, H){
  const key = id + ':' + W;
  if(CITY_P2D[key]) return CITY_P2D[key];
  const B = CITY_B && CITY_B[id]; if(!B || !B.length) return null;
  const p = new Path2D(); for(const r of B) if(r.length > 2) ringPath(p, r, W, H);
  return (CITY_P2D[key] = p);
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
  t.magFilter = 1003;                      // 最近鄰:像素地圖放大還是方塊
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
function paintPatch(P){
  const cv = P.cv, W = cv.width, H = cv.height, c = cv.getContext('2d');
  const feats = (PFEATS || FEATS || []).filter(f => {
    const [a, b, cc, d] = featBox(f);
    if(b < P.la0 || a > P.la1) return false;
    if(d - cc > 300) return true;                          // 跨換日線的大國:保留,讓 patchRing 處理
    const mid = (P.lo0 + P.lo1) / 2, half = (P.lo1 - P.lo0) / 2;
    let dc = ((cc + d) / 2 - mid); dc -= Math.round(dc / 360) * 360;
    return Math.abs(dc) <= half + (d - cc) / 2;
  });
  const land = () => { c.beginPath(); for(const f of feats) patchFeatPath(c, f, P, W, H); };
  // 像素地形(跟整球貼圖同一套畫法,顏色才接得起來)
  TERRAIN.paint(c, P, W, H, ctx => { ctx.beginPath(); for(const f of feats) patchFeatPath(ctx, f, P, W, H); });
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
  // 勢力圖層:城市的真實範圍
  for(const [id, col] of cityCols()){
    const B = CITY_B && CITY_B[id]; if(!B) continue;
    c.beginPath(); for(const r of B) if(r.length > 2) patchRing(c, r, P, W, H);
    c.fillStyle = col; c.fill('evenodd');
    c.lineWidth = 2.5; c.strokeStyle = col.replace(/,\s*([\d.]+)\)$/, ',1)'); c.stroke();
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
  const M = 640;                            // 像素地圖:局部也刻意低解析,放大後每一格是清楚的方塊
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
    P.tex.magFilter = 1003; P.tex.minFilter = 1003; P.tex.generateMipmaps = false;
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
   2. 城市地標 —— 使用者:「每個城市都可以有地標或是特色建築」
   -----------------------------------------------------------------------------
   44 座城市各配一個一眼認得出來的地標(像素圖在 pixel.js 的 PX.LMS)。
   遠看(部隊變成圖示的那個高度)一律收起來:那時候它們只會是一堆擠在一起的小點。
   ============================================================================= */
const TEAM = '#2f8fe0';           // 你的隊伍色(部隊、旗子)
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
/* =============================================================================
   像素看板 —— 使用者:「全部變成像素風格,包含所有建築、軍事」
   -----------------------------------------------------------------------------
   建築、部隊、地標都是一張像素圖(pixel.js)貼在一片永遠面向鏡頭的四邊形上(看板),
   底部釘在地上。貼圖用最近鄰取樣(NearestFilter)—— 放大之後像素還是方的,不會糊。
   材質:底色黑、自發光白、自發光貼圖 = 像素圖 → 畫出來的就是原本的顏色,不受光照影響;
   alphaTest 把透明的像素挖掉(不用半透明排序)。
   ⚠ Texture 的建構子要等地球貼圖掛好(mountTex)才撿得到;在那之前先回傳空物件,
     掛好之後 W3D.sites 用上一次的資料重蓋一次。
   ============================================================================= */
const PXU = .12;                  // 體素:一格 = 幾個地磚單位
const VPX = .05;                  // 載具的體素:一格 = 幾個單位(之後還會乘上 animStep 的倍率)
const hasPX = () => typeof PX !== 'undefined' && PX && PX.S;
/* =============================================================================
   體素(3D 像素)—— 使用者:「地圖上的東西也要 3D 立體像素風格」
   -----------------------------------------------------------------------------
   把 pixel.js 的每一張像素圖「擠出」成一塊一塊的方塊:
     正面 / 背面  每個像素一片,就是原本那張圖
     側面 / 頂面  只在邊緣長出來,沿著厚度一整條(不是每一格一片,三角形數量才壓得住)
   顏色的小規矩:側面遇到黑色描邊('k')改用往內一格的顏色,頂面遇到描邊用深灰 —— 不然整棟樓的
   側面與屋頂全是黑的。側面暗一點、頂面亮一點,有光照的立體感。
   站著的(建築、部隊、地標):寬 = 圖的寬、高 = 圖的高、厚度自己給,正面朝南(鏡頭從南邊斜看)。
   平躺的(載具):圖就是俯視圖,往上長出厚度。
   ⚠ 頂點顏色是線性空間:sRGB 要先轉(^2.2),不然整張圖偏亮偏灰。
   ============================================================================= */
const VGEO = new Map();
let VMAT = null;
function vmat(){
  if(!VMAT){ VMAT = new T.Phong({ vertexColors: true, shininess: 6, side: 2 }); VMAT.emissive && VMAT.emissive.set('#2a3440'); }
  return VMAT;
}
const toLin = v => Math.pow(v / 255, 2.2);
function colOf(ch, tint){
  let hex;
  if(ch === 'T' || ch === 't'){
    const rgb = hexRGB(tint || TEAM);          // ⚠ '#2f8fe0' 不能用抓數字的正規式(會抓成 2,8,0 → 黑色)
    return ch === 't' ? rgb.map(v => v * .6) : rgb;
  }
  hex = PX.PAL[ch] || '#ff00ff';
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}
/* 一個累積頂點的緩衝:四邊形 → 兩個三角形 */
function VB(){ return { p: [], n: [], c: [] }; }
function vquad(B, a, b, c, d, nrm, rgb, k){
  const col = rgb.map(v => toLin(Math.min(255, v * k)));
  for(const v of [a, b, c, a, c, d]){ B.p.push(v[0], v[1], v[2]); B.n.push(nrm[0], nrm[1], nrm[2]); B.c.push(col[0], col[1], col[2]); }
}
/* 把一張圖擠出到緩衝裡。o = 原點(左下前角,體素單位),dep = 厚度
   站著:x = 圖的 x、z = 由下往上、y = 厚度(正面在 y = o.y)
   平躺:x = 圖的 x(機頭 +x)、y = 圖的列(第 0 列在 +y)、z = 厚度 */
function voxAdd(B, sp, tint, o, dep, flat){
  const w = sp.w, h = sp.h, R = sp.rows;
  const at = (i, j) => (i < 0 || j < 0 || i >= w || j >= h) ? '.' : R[j][i];
  const full = (i, j) => at(i, j) !== '.';
  const side = (i, j, di) => { const c = at(i, j); if(c !== 'k') return colOf(c, tint); const n = at(i + di, j); return n !== '.' && n !== 'k' ? colOf(n, tint) : colOf('K'); };
  // 屋頂:描邊改用這張圖的「主色」(出現最多次的非描邊顏色)—— 鏡頭幾乎從正上方看,屋頂就是你看到的那一面
  const main = sp._main || (sp._main = (() => { const n = {}; for(const r of R) for(const ch of r) if(ch !== '.' && ch !== 'k' && ch !== 'K') n[ch] = (n[ch] || 0) + 1;
    let b = 'K', bv = -1; for(const ch in n) if(n[ch] > bv){ bv = n[ch]; b = ch; } return b; })());
  const topc = (i, j) => { const c = at(i, j); return c === 'k' || c === 'K' ? colOf(main, tint) : colOf(c, tint); };
  // 座標轉換:圖的 (i, j) + 厚度 t → 3D
  const P = flat
    ? (x, r, t) => [o.x + x, o.y + (h - r), o.z + t]            // r = 圖的列(可以是小數邊界)
    : (x, r, t) => [o.x + x, o.y + t, o.z + (h - r)];
  // 法線:正面 / 背面 / 左 / 右 / 上 / 下
  const NF = flat ? [0,0,1] : [0,-1,0], NB = flat ? [0,0,-1] : [0,1,0];
  const NU = flat ? [0,1,0] : [0,0,1], ND = flat ? [0,-1,0] : [0,0,-1];
  for(let j = 0; j < h; j++) for(let i = 0; i < w; i++){
    if(!full(i, j)) continue;
    const c = colOf(at(i, j), tint);
    // 正面(站著:朝南;平躺:朝天)與背面
    vquad(B, P(i, j + 1, flat ? dep : 0), P(i + 1, j + 1, flat ? dep : 0), P(i + 1, j, flat ? dep : 0), P(i, j, flat ? dep : 0), NF, c, 1);
    if(!flat) vquad(B, P(i + 1, j + 1, dep), P(i, j + 1, dep), P(i, j, dep), P(i + 1, j, dep), NB, c, .7);
    // 左右兩側:沿著厚度一整條
    if(!full(i - 1, j)) vquad(B, P(i, j + 1, dep), P(i, j + 1, 0), P(i, j, 0), P(i, j, dep), [-1,0,0], side(i, j, 1), .72);
    if(!full(i + 1, j)) vquad(B, P(i + 1, j + 1, 0), P(i + 1, j + 1, dep), P(i + 1, j, dep), P(i + 1, j, 0), [1,0,0], side(i, j, -1), .82);
    // 上面(站著:屋頂;平躺:圖的上緣那一側)
    if(!full(i, j - 1)) vquad(B, P(i, j, 0), P(i + 1, j, 0), P(i + 1, j, dep), P(i, j, dep), NU, topc(i, j), 1.18);
    if(!full(i, j + 1) && (flat || j < h - 1)) vquad(B, P(i + 1, j + 1, 0), P(i, j + 1, 0), P(i, j + 1, dep), P(i + 1, j + 1, dep), ND, c, .55);
  }
}
function vgeo(B){
  const g = new T.BG();
  g.setAttribute('position', new T.Attr(new Float32Array(B.p), 3));
  g.setAttribute('normal', new T.Attr(new Float32Array(B.n), 3));
  g.setAttribute('color', new T.Attr(new Float32Array(B.c), 3));
  return g;
}
/* 一組體素 → 一個幾何(同一個樣子只算一次)。parts: [{ sp, tint, x, y, z, dep }] */
function voxGeo(key, make){
  if(VGEO.has(key)) return VGEO.get(key);
  const B = VB();
  make(B);
  const g = vgeo(B);
  if(VGEO.size > 220) VGEO.clear();
  VGEO.set(key, g);
  return g;
}
/* 一塊地基:厚一格的方塊(上面站建築) */
function voxSlab(B, x0, y0, w, d, rgb, z0){
  const z = z0 || 0, x1 = x0 + w, y1 = y0 + d, zt = z + 1;
  vquad(B, [x0,y0,zt], [x1,y0,zt], [x1,y1,zt], [x0,y1,zt], [0,0,1], rgb, 1.05);
  vquad(B, [x0,y0,z], [x1,y0,z], [x1,y0,zt], [x0,y0,zt], [0,-1,0], rgb, .7);
  vquad(B, [x1,y0,z], [x1,y1,z], [x1,y1,zt], [x1,y0,zt], [1,0,0], rgb, .8);
  vquad(B, [x0,y1,z], [x0,y0,z], [x0,y0,zt], [x0,y1,zt], [-1,0,0], rgb, .75);
  vquad(B, [x1,y1,z], [x0,y1,z], [x0,y1,zt], [x1,y1,zt], [0,1,0], rgb, .7);
}
const hexRGB = h => { if(!h) return [79,195,247]; const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(h); if(m && h[0] !== '#') return [+m[1], +m[2], +m[3]];
  return [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)]; };
/* 一座小城:建築排成前後兩排(最高的在前排中間,鏡頭從南邊看得到),底下一塊地基 */
function voxCity(B, parts, ground){
  const list = parts.slice().sort((a, b) => b.sp.h - a.sp.h);
  const rows = [[], []];
  list.forEach((p, i) => { const r = i < 3 ? 0 : 1; if(i % 2) rows[r].push(p); else rows[r].unshift(p); });
  const gap = 1;
  const rowW = r => r.reduce((s, p) => s + p.sp.w, 0) + gap * Math.max(0, r.length - 1);
  const W = Math.max(rowW(rows[0]), rowW(rows[1])) + 2;
  const depOf = p => p.dep || Math.max(4, Math.min(p.sp.w, 12));
  const D0 = Math.max(0, ...rows[0].map(depOf)), D1 = Math.max(0, ...rows[1].map(depOf));
  const D = D0 + (rows[1].length ? D1 + gap : 0) + 2;
  voxSlab(B, -W/2, -D/2, W, D, hexRGB(ground), 0);
  // 前排貼著南邊(y 小 = 南 = 鏡頭那一側),後排在它北邊
  const place = (r, y0, dRow) => {
    let x = -rowW(r) / 2;
    for(const p of r){ const dep = depOf(p); voxAdd(B, p.sp, p.tint, { x, y: y0 + (dRow - dep) / 2, z: 1 }, dep, false); x += p.sp.w + gap; }
  };
  place(rows[0], -D/2 + 1, D0);
  if(rows[1].length) place(rows[1], -D/2 + 1 + D0 + gap, D1);
}
function voxRoot(d, key, make, flags){
  const root = new T.O3();
  root.userData.site = d;
  Object.assign(root.userData, flags || {});
  if(!hasPX()) return root;
  const mesh = new T.Mesh(voxGeo(key, make), vmat());
  mesh.scale.setScalar(PXU);
  root.add(mesh);
  root.userData.vox = mesh;
  root.userData.key = key;
  OBJS.add(root);
  return root;
}
let LAST_SITES = null;
/* 待機動畫:部隊一格一格地上下彈(兩個畫格,交錯),地圖不是一張死的圖。
   只動子物件的高度(一個體素),每 380ms 一次 —— 便宜,而且是像素遊戲那種「一跳一跳」的節奏。 */
let bobT = 0;
setInterval(() => {
  if(!W3D.ok || document.hidden) return;
  bobT ^= 1;
  let i = 0;
  for(const o of OBJS){
    if(!o.userData.troop || !o.userData.vox || !o.visible) continue;
    o.userData.vox.position.z = ((bobT + i++) & 1) ? PXU * .9 : 0;
  }
}, 380);
/* 一座城的像素圖:每一棟照它的種類挑圖,事業塔樓的樓層數 = 同一把尺的高度 */
function bldSprite(b){
  const S = PX.SPR;
  switch(b.c){
    case 'biz':    return PX.bizTower(b.k || 'tech', b.h != null ? b.h : ((b.f || 1) - 1) / 6);
    case 'estate': return (b.f || 1) >= 5 ? S.hotel5 : S.house;
    case 'paper': case 'gold': case 'real': return PX.assetSprite(b.k);
    case 'cash':   return S.cash;
    case 'hold':   return S.hold;
    default:       return S.shell;
  }
}
const rvRGB = id => (typeof TY_RVCOL !== 'undefined' && TY_RVCOL[id]) || '160,160,170';

function buildLandmark(d){
  const L = LANDMARK[d.id]; if(!L) return null;
  const k = L[0], sp = (PX.LMS[k] || PX.LMS.skyline);
  return voxRoot(d, 'lm:' + k, B => voxCity(B, [{ sp, dep: Math.max(4, Math.min(sp.w, 10)) }], '#9aa5b8'), { lm: true });
}
function buildTroop(d){
  const enemy = d._threat || d._rvf;
  const tint = enemy ? `rgb(${rvRGB(d._r.id)})` : TEAM;
  const kinds = d._threat ? [d._sea ? 'ship' : 'raid'] : d._sea ? ['ship'] : d._units.slice(0, 3).map(u => u.k);
  const key = 'tr:' + tint + ':' + kinds.join(',');
  return voxRoot(d, key, B => voxCity(B, [...kinds.map(k => ({ sp: PX.SPR[k] || PX.SPR.raid, tint, dep: 7 })),
                                          { sp: PX.SPR.flag, tint, dep: 1 }], tint), { troop: true });
}

/* 一個據點（或一個對手大本營）的整座小城 */
function buildSite(d){
  if(d._lm){ const r = buildLandmark(d) || new T.O3(); r.visible = !FAR; return r; }
  if(d._units || d._threat){ const r = buildTroop(d); r.visible = !FAR; return r; }
  let key, make;
  if(d._rival){
    const col = `rgb(${rvRGB(d._rival.id)})`;
    const h = d._hk != null ? d._hk : (d._rvk || 0);
    key = `rv:${d._rival.id}:${h.toFixed(2)}`;
    make = B => voxCity(B, [{ sp: PX.rivalTower(h), tint: col }], col);
  }else{
    const blds = (d._blds || []);
    const ground = (d._col && d._col[0] === '#') ? d._col : '#4fc3f7';
    key = `me:${ground}:${blds.map(b => b.c + (b.k || '') + b.f + (b.st || '') + (b.h != null ? '@' + b.h : '')).join(',')}`;
    make = B => voxCity(B, blds.map(b => ({ sp: bldSprite(b) })), ground);
  }
  const root = voxRoot(d, key, make);
  /* 這個據點的樣子跟上一次不一樣（新蓋的、長高的）→ 播一次「從地上長出來」 */
  const id = d._rival ? 'rv:' + d._rival.id : d.id;
  if(root.userData.vox && SEEN[id] !== key){
    if(SEEN[id] !== undefined || W3D._warm){
      root.userData.grow = performance.now();
      fxAt(d.lat, d.lng, 'dust', { z: 4, dur: .9, life: 1100, alt: .001 });     // 蓋起來的那一刻揚起一陣塵土
    }
    SEEN[id] = key;
  }
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
  /* 體素模型往鏡頭那一側(南)傾斜一點:鏡頭幾乎從正上方看(使用者要的),不傾斜的話只看得到屋頂,
     看不到正面的窗戶、招牌與兵種 —— 像很多 2.5D 地圖遊戲那樣,把模型「立」起來給你看。 */
  /* ⚠ 往**北**仰(頂端離開鏡頭):正面(朝南)才會轉向天空、朝著上方的鏡頭。
     第一版往南傾,正面反而轉去對著地面,從上面看只剩屋頂。 */
  const LEAN = obj.userData.vox ? .8 : 0, cl = Math.cos(LEAN), sl = Math.sin(LEAN);
  const ux = nx*cl + qx*sl, uy = ny*cl + qy*sl, uz = nz*cl + qz*sl;     // 新的上 = 往北仰
  const vx = qx*cl - nx*sl, vy = qy*cl - ny*sl, vz = qz*cl - nz*sl;     // 新的北
  M.set(ex, vx, ux, 0,  ey, vy, uy, 0,  ez, vz, uz, 0,  0, 0, 0, 1);
  obj.quaternion.setFromRotationMatrix(M);
  /* 駐在城市裡的部隊站在城市的東南邊一點,不要跟建築疊在一起。
     偏移量是「幾塊地磚寬」,所以要跟著縮放走(見 applyScale)。 */
  obj.userData.at = { x: c.x, y: c.y, z: c.z, e: [ex, ey, ez], q: [qx, qy, qz], slot: d._slot || null, base: a };
  applyScale(obj, performance.now());
}
function applyScale(obj, now){
  // 部隊棋子比建築大一號 —— 它們是你要常常點、常常看的東西
  const s = bScale() * (obj.userData.troop ? 1.45 : obj.userData.lm ? 1.15 : 1);   // 地標也放大:中距離要認得出是哪一座
  let k = 1;
  const g0 = obj.userData.grow;
  if(g0){
    const p = clamp((now - g0) / 900, 0, 1);
    // 先衝過頭一點再回來，像蓋好的那一下
    k = p >= 1 ? 1 : 1 + 2.2 * Math.pow(p - 1, 3) + 1.2 * Math.pow(p - 1, 2);
    k = Math.max(.02, k);
    if(p >= 1) obj.userData.grow = 0;
  }
  if(obj.userData.vox){
    // 體素:「長出來」一格一格地長(階梯式),像素遊戲的手感
    const kk = k >= 1 ? 1 : Math.max(.05, Math.round(k * 10) / 10);
    // 拉遠時縮小一點:近看要看得到窗戶與兵種,遠看不能一棟樓蓋掉半個國家
    const far = clamp(1.25 - W3D.alt * .35, .45, 1);
    const b = s * far * (obj.userData.troop ? .8 : obj.userData.lm ? .9 : 1);
    obj.scale.set(b, b, b * kk);
  }else obj.scale.set(s * 1.6, s * 1.6, s * k);
  const at = obj.userData.at;
  if(at && at.slot){
    /* 城市旁邊的位子:用「度」算、而且在**當下這個距離**檢查是不是陸地。
       第一版的偏移是「幾塊地磚寬」、陸地只在固定的 0.3~0.5 度檢查過 —— 拉遠一點,
       地磚變大、偏移跟著變大,實際站的地方早就不是檢查過的那一點,於是部隊站到海上、
       離城市一大截(使用者:「部隊和建築的定位沒有很精準」)。 */
    const S = at.slot, D = 1.6 * bScale();
    const L = slotDirs(S.id, S.lat, S.lng, D);
    const [ang, f] = L[S.n % L.length], ring = Math.floor(S.n / L.length);
    const r = D * f * (1 + ring * .8), k = 1 / Math.max(.2, Math.cos(S.lat * Math.PI / 180));
    const c = G.getCoords(S.lat + Math.sin(ang) * r, S.lng + Math.cos(ang) * r * k, at.base);
    obj.position.set(c.x, c.y, c.z);
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
    G.customLayerData([])
     .customThreeObject(d => buildSite(d))
     .customThreeObjectUpdate((obj, d) => placeSite(obj, d));
    if(typeof G.onCustomLayerClick === 'function')
      G.onCustomLayerClick(d => {
        if(!d) return;
        if(W3D.aiming()) return;
        if(d._rvf){ TY_RIVAL = d._r.id; TY_DEAL = null; TY_MODAL = 'rival'; renderPage(); }
        else if(d._units){ let c = null; try{ c = G.getScreenCoords(d.lat, d.lng, .002); }catch(e){}
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
/* 城市旁邊的空位。使用者截圖:「怎麼建築在海上」、「如果之後對手也在台灣設點會很擠」——
   同一座城市旁邊可能同時有你的小城、對手的大本營、地標、好幾群部隊。
   城市正中央給一個,其餘依序拿「旁邊的位子」;位子是哪個方向,要看**那個距離**上是不是陸地:
     ① 在 D 與 0.6D 都是陸地的方向(東南、西南、東北、西北、南、北、東、西的順序)
     ② 只有近一點(0.55D)才是陸地的方向 —— 站近一點,寧可跟中央有點擠也不要下海
     ③ 剩下的(真的全是海,例如香港、新加坡拉很遠的時候)縮到 0.4D
   D 跟著鏡頭高度走,所以依 D 分桶快取(每一桶差 26%),同一桶只算一次。 */
const DIRS = [-40, -140, 40, 140, -90, 90, 0, 180, -65, -115, -20, -160, 20, 160, 65, 115].map(a => a * Math.PI / 180);
const SLOT_C = Object.create(null);
const angGap = (a, b) => { let d = Math.abs(a - b) % (Math.PI * 2); return d > Math.PI ? Math.PI * 2 - d : d; };
function slotDirs(id, lat, lng, D){
  const b = Math.round(Math.log2(Math.max(.01, D)) * 3);
  const key = id + ':' + b + (W3D.hiFeats ? 'h' : '');
  if(SLOT_C[key]) return SLOT_C[key];
  const Dq = Math.pow(2, b / 3), k = 1 / Math.max(.2, Math.cos(lat * Math.PI / 180));
  const on = (a, r) => !!W3D.featAt(lat + Math.sin(a) * r, lng + Math.cos(a) * r * k);
  /* 由遠到近試 16 個方向:整段(0.6~1 倍)都是陸地才算。已經選走的方向附近(40° 內、距離差不多)
     不再選,不然兩個會疊在一起。台灣、日本這種細長的島,主要靠中間那幾個斜方向找到陸地。 */
  const out = [];
  for(const f of [1, .75, .55, .4, .28])
    for(const a of DIRS){
      if(!on(a, Dq * f) || !on(a, Dq * f * .6)) continue;
      if(out.some(o => angGap(o[0], a) < .7 && Math.abs(o[1] - f) < .3)) continue;
      out.push([a, f]);
    }
  // 真的全是海(新加坡、香港拉很遠的時候):縮到 0.28 倍,至少不要離城市太遠
  for(const a of DIRS.slice(0, 8)) if(!out.some(o => angGap(o[0], a) < .7)) out.push([a, .28]);
  return (SLOT_C[key] = out);
}
W3D._objs = () => [...OBJS];     // 給截圖驗證用
W3D._slot = (id, lat, lng, D) => slotDirs(id, lat, lng, D);   // 給測試用

W3D.sites = function(mine, rivals, troops){
  if(!W3D.ok) return;
  LAST_SITES = [mine, rivals, troops];
  paintSkin();
  const rvMax = Math.max(1, ...rivals.map(r => r._v || 0));
  rivals.forEach(r => { r._rvk = Math.sqrt((r._v || 0) / rvMax); });
  /* 分位子:城市正中央給你的小城(沒有的話給對手大本營),其餘的依序拿陸地上的空位 */
  const used = Object.create(null);
  const take = (id, lat, lng) => ({ id, lat, lng, n: (used[id] = (used[id] || 0) + 1) - 1 });
  const center = new Set(mine.map(d => d.id));
  for(const d of rivals){
    if(center.has(d.id)) d._slot = take(d.id, d.lat, d.lng);
    else { d._slot = null; center.add(d.id); }
  }
  const siteOf = d => (typeof TY_SITES !== 'undefined' ? TY_SITES : []).find(st => Math.abs(st.lat - d.lat) < 1e-6 && Math.abs(st.lng - d.lng) < 1e-6);
  const tr = (troops || []).map(d => {
    const o = { ...d, _base: .0008 };
    delete o._arc;
    if(d._threat){ o._slot = null; o._sea = !W3D.featAt(d.lat, d.lng); return o; }
    const st = siteOf(d);
    if(st){ o._slot = take(st.id, st.lat, st.lng); o._sea = false; }   // 駐紮 / 下季到位:城市旁邊的陸地上
    else o._sea = !W3D.featAt(d.lat, d.lng);
    return o;
  });
  TROOPS = tr;
  /* 地標:每一座城市都有。正中央空著就站中央,不然也去拿一個陸地上的空位。 */
  const lms = (typeof TY_SITES !== 'undefined' ? TY_SITES : []).map(st => ({
    id: st.id, lat: st.lat, lng: st.lng, iso: st.iso, _lm: true, _k: 'lm:' + st.id, _base: .0008,
    _slot: center.has(st.id) ? take(st.id, st.lat, st.lng) : null }));
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
    el.className = 'w3d-tag' + (d._threat || d._rvf ? ' th' : '') + (d._rvf ? ' rf' : '') + (d._mv ? ' mv' : '');
    if(d._rvf){
      // 對手的駐軍:他的顏色、他的頭像 + 兵種;點下去開那位對手的卡
      el.style.setProperty('--rc', `rgb(${(typeof TY_RVCOL !== 'undefined' && TY_RVCOL[d._r.id]) || '255,69,58'})`);
      el.innerHTML = `${d._r.ic || '⚔'}${d._units.map(u => TY_UNITS[u.k].ic).join('')}`;
      el.title = `${d._r.nm}在${TY_REGIONS[d._rvf.reg].nm}的駐軍(勢力 ${d._rvf.v.toFixed(0)})`;
    }else if(d._threat){
      el.style.setProperty('--rc', `rgb(${(typeof TY_RVCOL !== 'undefined' && TY_RVCOL[d._r.id]) || '255,69,58'})`);
      el.innerHTML = `${d._r.ic || '⚔'} <b>${Math.max(0, d._threat.eta - TY.t)}季</b>`;
      el.title = `${d._r.nm}的併購小組 → ${tySite(d._threat.site).nm}`;
    }else{
      // 同一種兵只畫一個圖示,後面標總數;下一季才到的標「+N」
      const ics = [...new Set(d._units.map(u => TY_UNITS[u.k].ic))].slice(0, 3).join('');
      const n = d._units.length, inc = d._in || 0;
      el.innerHTML = `${ics}${n > 1 ? ` <b>×${n}</b>` : ''}${inc ? ` <i class="inc">+${inc}</i>` : ''}`;
      el.title = d._units.map(u => TY_UNITS[u.k].nm + (u.to ? ` → ${tySite(u.to).nm}` : '')).join('、');
    }
    if(d._rvf) el.onclick = () => { TY_MODAL = 'rival'; TY_RIVAL = d._r.id; renderPage(); };
    else if(d._threat) el.onclick = () => { TY_MODAL = 'troop'; renderPage(); };
    else armTagDrag(el, d);
    el._d = d;
    TAGS.appendChild(el);
  }
  if(TROOPS.length && !tagLoop){ tagLoop = true; requestAnimationFrame(tagStep); }
}
/* 城市名牌的位置(globe.gl 的 HTML 圖層)。量版面很貴,所以 250ms 才量一次 */
let OBST = [], obstT = 0;
function obstacles(){
  const now = performance.now();
  if(now - obstT < 250) return OBST;
  obstT = now;
  const host = document.getElementById('tyGlobeHost'); if(!host){ OBST = []; return OBST; }
  const hr = host.getBoundingClientRect();
  OBST = [];
  for(const e of host.querySelectorAll('.tyk')){
    const r = e.getBoundingClientRect();
    if(r.width > 0 && r.height > 0 && r.bottom > hr.top && r.top < hr.bottom) OBST.push([r.left - hr.left, r.top - hr.top, r.width, r.height]);
  }
  return OBST;
}
function tagStep(){
  if(!TAGS || !TAGS.isConnected || !TROOPS.length){ tagLoop = false; return; }
  let cam, V, w, h;
  try{ cam = G.camera(); const el = G.renderer().domElement; w = el.clientWidth; h = el.clientHeight; V = cam.position.clone(); }
  catch(e){ tagLoop = false; return; }
  const objs = [...OBJS].filter(o => o.parent && o.userData.troop);
  /* 標籤避讓(使用者截圖:香港、深圳一帶的字和東西全部卡在一起)。
     每一個標籤先放在棋子正下方;撞到已經放好的標籤、或城市名牌(.tyk,每 250ms 量一次)就依序試
     下、上、右、左、右下、左下… 挑第一個不撞的位置。遠看時標籤是方形兵種圖示,規則一樣。 */
  const obs = obstacles();
  const placed = [];
  const hit = (x, y, bw, bh) => placed.some(p => x < p[0] + p[2] && x + bw > p[0] && y < p[1] + p[3] && y + bh > p[1])
                            || obs.some(p => x < p[0] + p[2] && x + bw > p[0] && y < p[1] + p[3] && y + bh > p[1]);
  for(const el of TAGS.children){
    const o = objs.find(x => x.userData.site && x.userData.site._k === el._d._k);
    if(!o){ el.style.opacity = '0'; continue; }
    o.getWorldPosition(V);
    const vis = V.dot(cam.position) > R * R * 1.001;
    V.project(cam);
    const sx = (V.x + 1) / 2 * w, sy = (1 - V.y) / 2 * h;
    if(!el._w || el._wt !== el.innerHTML){ el._w = el.offsetWidth || 40; el._h = el.offsetHeight || 18; el._wt = el.innerHTML; }
    const bw = el._w, bh = el._h;
    let x = sx - bw / 2, y = sy + 4;
    if(vis){
      const tries = [[0,0],[0,bh+2],[0,-(bh+2)*2],[bw+4,0],[-(bw+4),0],[bw+4,bh+2],[-(bw+4),bh+2],[0,(bh+2)*2],[bw+4,-(bh+2)],[-(bw+4),-(bh+2)]];
      for(const [dx, dy] of tries){ if(!hit(sx - bw/2 + dx, sy + 4 + dy, bw, bh)){ x = sx - bw/2 + dx; y = sy + 4 + dy; break; } }
      placed.push([x, y, bw, bh]);
    }
    el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
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
    if(typeof TY_LAYER !== 'undefined' && TY_LAYER === 'power') W3D.repaint();   // 勢力圖層要把城市塗上去
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
  for(const t of TRAILS.values()) if(t.pts.length > 1) tr.push({ pts: t.pts, col: t.col, w: t.w });
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
function nearSite(x, y, rad){
  if(typeof TY_SITES === 'undefined') return null;
  let best = null, bd = (rad || 26) * (rad || 26);
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
/* 國旗:像素色帶(pixel.js 的 PX.flagHTML)—— 系統的國旗表情符號跟像素風不搭,而且 Windows 根本不畫國旗 */
function flag(code){
  if(typeof PX !== 'undefined' && PX.flagHTML) return PX.flagHTML(code && code.length === 2 ? code.toUpperCase() : '');
  return '';
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
   載具 —— 部隊出發、飛彈、空襲的動畫主角
   -----------------------------------------------------------------------------
   客機 / 驅逐艦 / 卡車車隊 / 飛彈 / 戰機 / 炸彈,都是 pixel.js 的俯視像素圖,
   平躺在地上(或空中),機頭 = 前進方向,每一幀用前後兩點算方向(orient)。
   飛機拉凝結尾、船拉航跡;爆炸 = 震動 + 閃光 + 火花 + 會燒一陣子的火 + 煙 + 衝擊波。
   ============================================================================= */
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
/* 兩點之間的直線會不會經過海。使用者:「陸軍要跨海要先搭船」——
   第一版只看距離(1200 公里內開車),於是台北開卡車直接橫越台灣海峽到上海。
   現在沿線取樣,頭尾各留一點(城市本身可能就在海岸線上)。 */
function crossesSea(a, b){
  const n = clamp(Math.round(kmLL(a, b) / 40), 8, 60);
  for(let i = 1; i < n; i++){
    const f = i / n; if(f < .04 || f > .96) continue;
    const p = tyGeoLerp({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] }, f);
    if(!W3D.featAt(p.lat, p.lng)) return true;
  }
  return false;
}
/* 從城市往某個航點走,第一個落在海上的點就是港口(海岸線)。
   找不到(城市本身就在海上的小島)就用城市自己。 */
function coastToward(city, node){
  const n = clamp(Math.round(kmLL(city, node) / 15), 6, 80);
  let last = city;
  for(let i = 1; i <= n; i++){
    const p = tyGeoLerp({ lat: city[0], lng: city[1] }, { lat: node[0], lng: node[1] }, i / n);
    if(!W3D.featAt(p.lat, p.lng)) return [p.lat, p.lng];
    last = [p.lat, p.lng];
  }
  return last;
}
/* 一條路線 = 很多小段,每段有它的交通工具。
   陸路的部隊:沒有跨海就一路開過去;要跨海就「開到海岸 → ⚓ 靠港登船 → 航行 → ⚓ 靠岸 → 上岸開到目的地」。
   靠港那兩下是 mode:'dock' 的停頓段(見 fly 的權重):船停在碼頭一會兒,地圖上跳「登船」「上岸」。 */
function routeFor(kind, A, B){
  const a = [A.lat, A.lng], b = [B.lat, B.lng], pts = [];
  if(kind === 'plane' || kind === 'missile' || kind === 'jet'){ legPts(a, b, kind, pts); return pts; }
  if(kmLL(a, b) < 2500 && !crossesSea(a, b)){ legPts(a, b, 'truck', pts); return pts; }
  const sea = seaPath(a, b);
  const pa = coastToward(a, sea[0]), pb = coastToward(b, sea[sea.length-1]);
  legPts(a, pa, 'truck', pts);                               // 開到港口
  pts.push({ lat: pa[0], lng: pa[1], mode: 'dock', dock: 'load' }, { lat: pa[0], lng: pa[1], mode: 'ship' });
  legPts(pa, sea[0], 'ship', pts);
  for(let i = 1; i < sea.length; i++) legPts(sea[i-1], sea[i], 'ship', pts);
  legPts(sea[sea.length-1], pb, 'ship', pts);
  pts.push({ lat: pb[0], lng: pb[1], mode: 'dock', dock: 'unload' }, { lat: pb[0], lng: pb[1], mode: 'truck' });
  legPts(pb, b, 'truck', pts);                               // 上岸
  return pts;
}
W3D._route = (A, B) => routeFor('ground', A, B).map(p => p.mode);   // 給測試用

/* 播一趟:沿著路線走,依載具換模型;飛機 / 飛彈 / 戰機有高度曲線。 */
let ANIMS = [], animOn = false;
/* 載具:俯視的像素圖平躺在地上(機頭 +x),orient() 把它轉向前進方向 */
function spawnVeh(k, tint){
  const h = patchHost(); if(!h || !hasPX()) return null;
  const sp = PX.SPR[k] || PX.SPR.truck;
  const dep = k === 'ship' ? 4 : k === 'plane' ? 3 : 2;
  const g = voxGeo('veh:' + k + ':' + (tint || ''), B => voxAdd(B, sp, tint || null, { x: -sp.w / 2, y: -sp.h / 2, z: -dep / 2 }, dep, true));
  const m = new T.Mesh(g, vmat());
  m.renderOrder = 3;
  m.userData.vpx = VPX;
  h.add(m); return m;
}
function orient(obj, p, q){
  const l = Math.hypot(p.x, p.y, p.z) || 1, nx = p.x/l, ny = p.y/l, nz = p.z/l;
  let fx = q.x - p.x, fy = q.y - p.y, fz = q.z - p.z;
  const fl = Math.hypot(fx, fy, fz);
  if(fl < 1e-9){ obj.position.set(p.x, p.y, p.z); return; }
  fx /= fl; fy /= fl; fz /= fl;
  const dot = nx*fx + ny*fy + nz*fz;
  let ux = nx - dot*fx, uy = ny - dot*fy, uz = nz - dot*fz;
  const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
  const yx = uy*fz - uz*fy, yy = uz*fx - ux*fz, yz = ux*fy - uy*fx;
  obj.matrix.set(fx, yx, ux, 0,  fy, yy, uy, 0,  fz, yz, uz, 0,  0, 0, 0, 1);
  obj.quaternion.setFromRotationMatrix(obj.matrix);
  obj.position.set(p.x, p.y, p.z);
}
/* opt: { kind, from, to, dur, arc, off, trail, done, onPass(u) } */
function fly(opt){
  if(!W3D.ok) return;
  const pts = opt.pts || routeFor(opt.kind, opt.from, opt.to);
  if(pts.length < 2) return;
  /* 每一小段的「權重」:卡車段 ×3 —— 開到港口那一小段在地圖上很短,不放慢的話一閃就過了 */
  /* 靠港(mode:'dock')是一段零長度的停頓:船停在碼頭、部隊上下船。長度取總路程的 9%,
     不然一閃就過,看不出「先開到港口、再上船」。 */
  const w = [0];
  for(let i = 1; i < pts.length; i++){
    const km = kmLL([pts[i-1].lat, pts[i-1].lng], [pts[i].lat, pts[i].lng]);
    w.push(km * (pts[i-1].mode === 'truck' ? 3 : 1));
  }
  const raw = w.reduce((x, y) => x + y, 0) || 1;
  const cum = [0];
  for(let i = 1; i < pts.length; i++) cum.push(cum[i-1] + (pts[i-1].mode === 'dock' ? raw * .09 : w[i]));
  const tot = cum[cum.length-1] || 1;
  ANIMS.push({ pts, cum, tot, t0: performance.now() + (opt.delay || 0), dur: opt.dur || 5000,
               arc: opt.arc || 0, off: opt.off || 0, kind: opt.kind, mesh: null, mk: '',
               done: opt.done, onPass: opt.onPass, passed: false,
               trail: opt.trail || null, tr: opt.trail ? [] : null, tag: opt.tag || '' });
  tyWake();
  if(!animOn){ animOn = true; requestAnimationFrame(animStep); }
}
function posAt(a, u){
  let i = 1; while(i < a.cum.length - 1 && a.cum[i] < u * a.tot) i++;
  const s0 = a.cum[i-1], s1 = a.cum[i], f = s1 > s0 ? (u * a.tot - s0) / (s1 - s0) : 0;
  const p0 = a.pts[i-1], p1 = a.pts[i];
  let lat = p0.lat + (p1.lat - p0.lat) * f, lng = p0.lng + (((p1.lng - p0.lng + 540) % 360) - 180) * f;
  // 編隊:起飛後散開,之後一路保持間距(第一版在後段會收回同一點,三架疊成一架)
  if(a.off) lat += a.off * smooth(clamp(u / .2, 0, 1));
  if(p0.mode === 'dock') return { lat, lng, alt: .0006, mode: 'ship', dock: p0.dock, di: i };
  let alt = p0.mode === 'ship' ? .0006 : .0012;
  if(a.kind === 'bomb') return { lat, lng, alt: .0012 + (a.fall || .03) * (1 - u*u), mode: 'bomb' };
  if(a.arc){
    let e;
    if(a.kind === 'missile') e = Math.pow(Math.sin(Math.PI * u), .8);        // 拋物線
    else if(a.kind === 'jet') e = smooth(clamp(u / .15, 0, 1));             // 起飛後一路低空
    else e = smooth(clamp((u - .08) / .2, 0, 1)) * smooth(clamp((.92 - u) / .2, 0, 1));   // 滑行 → 爬升 → 巡航 → 下降 → 滑行
    alt += a.arc * e;
  }
  return { lat, lng, alt, mode: p0.mode };
}
function animStep(now){
  const keep = [];
  for(const a of ANIMS){
    if(now < a.t0 && W3D._tfix == null){ keep.push(a); continue; }
    // W3D._tfix:只給截圖驗證用 —— 開發機一幀要畫好幾秒,把動畫凍結在某個進度才拍得到
    const u = W3D._tfix != null ? W3D._tfix : clamp((now - a.t0) / a.dur, 0, 1);
    const P = posAt(a, u), Q = posAt(a, Math.min(1, u + .006));
    const mk = a.kind === 'jet' ? 'jet' : a.kind === 'missile' ? 'missile' : a.kind === 'bomb' ? 'bomb' : a.kind === 'plane' ? 'plane' : P.mode;
    if(mk !== a.mk){ if(a.mesh && a.mesh.parent) a.mesh.parent.remove(a.mesh); a.mesh = spawnVeh(mk, a.tag ? `rgb(${rvRGB(a.tag)})` : null); a.mk = mk; }
    if(a.mesh){
      const p = G.getCoords(P.lat, P.lng, P.alt);
      let q = G.getCoords(Q.lat, Q.lng, Q.alt);
      if(u >= .994 && a._p){ q = { x: p.x*2 - a._p.x, y: p.y*2 - a._p.y, z: p.z*2 - a._p.z }; }
      if(a.kind === 'bomb') q = G.getCoords(P.lat, P.lng, P.alt - .01);  // 炸彈頭朝下
      orient(a.mesh, p, q); a._p = p;
      // 載具要比建築顯眼 —— 它們是這一刻畫面上的主角(第一版跟地標一樣大,遠看根本找不到)
      const s = bScale() * (mk === 'missile' ? 3.6 : mk === 'ship' ? 3.2 : mk === 'plane' ? 3.2 : mk === 'jet' ? 3 : mk === 'bomb' ? 2.6 : 2.4);
      a.mesh.scale.setScalar(s * VPX);         // 幾何是體素單位,一格 = VPX
    }
    if(a.tr){                                              // 尾跡:凝結尾 / 航跡 / 飛彈的煙
      if(mk !== 'truck'){ a.tr.push([P.lng, P.lat, P.alt]); if(a.trail.max && a.tr.length > a.trail.max) a.tr.shift(); }
      TRAILS.set(a, { pts: a.tr, col: a.trail.col, w: a.trail.w });
    }
    if(P.dock && a.docked !== P.di){                       // 靠港:跳一個「登船 / 上岸」,碼頭冒一圈水花
      a.docked = P.di;
      const fx = fxLayer();
      if(fx && W3D._tfix == null){
        floatAt(fx, P.lat, P.lng, P.dock === 'load' ? '⚓ 開到港口 · 登船' : '⚓ 靠岸 · 部隊上岸', 'dock' + (a.tag ? ' rv' : ''), 0);
        W3D.extraRings = W3D.extraRings.concat([{ lat: P.lat, lng: P.lng, _rgb: '120,200,255', _a: .9, _r: 1.6, _v: 1.6, _p: 700 }]);
        W3D.rings();
      }
    }
    if(a.onPass && !a.passed && u >= (a.passAt || .5)){ a.passed = true; a.onPass(P); }
    if(u < 1 || W3D._tfix != null) keep.push(a);
    else{
      if(a.mesh && a.mesh.parent) a.mesh.parent.remove(a.mesh);
      if(a.tr) setTimeout(() => { TRAILS.delete(a); pushPaths(); }, a.kind === 'missile' ? 2200 : 900);
      if(a.done) a.done();
    }
  }
  ANIMS = keep;
  if(TRAILS.size) pushPaths();
  if(ANIMS.length) requestAnimationFrame(animStep); else animOn = false;
}
const TRAILS = new Map();
/* 動畫播放時地球一定要醒著(面板打開時 index 會暫停 globe.gl 的繪圖) */
function tyWake(){ try{ if(typeof tyGlobeAwake === 'function') tyGlobeAwake(true); }catch(e){} }

/* ---- 爆炸 ----
   震動(整個地圖抖一下)+ 白色閃光 + 火球 + 往外噴的火花 + 燒一陣子的火 + 往上飄的煙 + 地面衝擊波光圈。
   火花、火、煙是 DOM 元素,每一幀跟著經緯度重新定位 —— 轉地圖的時候火會留在原地燒。 */
const FXS = new Set(); let fxLoop = false;
function anchorFx(el, lat, lng, alt, life){
  const fx = fxLayer(); if(!fx) return;
  fx.appendChild(el);
  FXS.add({ el, lat, lng, alt: alt || .002, t1: performance.now() + life });
  if(!fxLoop){ fxLoop = true; requestAnimationFrame(fxStep); }
}
function fxStep(now){
  let cam; try{ cam = G.camera().position; }catch(e){ fxLoop = false; return; }
  for(const f of FXS){
    if((now > f.t1 && !W3D._fxHold) || !f.el.isConnected){ f.el.remove(); FXS.delete(f); continue; }   // _fxHold:截圖驗證用
    let c = null; try{ c = G.getScreenCoords(f.lat, f.lng, f.alt); }catch(e){}
    const q = G.getCoords(f.lat, f.lng, 0), vis = (q.x*cam.x + q.y*cam.y + q.z*cam.z) > R*R*1.001;
    if(c){ f.el.style.left = c.x.toFixed(1) + 'px'; f.el.style.top = c.y.toFixed(1) + 'px'; }
    f.el.style.visibility = vis ? 'visible' : 'hidden';
  }
  if(FXS.size) requestAnimationFrame(fxStep); else fxLoop = false;
}
function shake(big){
  const host = document.getElementById('tyGlobeHost'); if(!host || reduced()) return;
  host.classList.remove('w3d-shake', 'w3d-shake2'); void host.offsetWidth;
  host.classList.add(big ? 'w3d-shake2' : 'w3d-shake');
  clearTimeout(shake._t); shake._t = setTimeout(() => host.classList.remove('w3d-shake', 'w3d-shake2'), big ? 650 : 420);
}
function boom(lat, lng, big){
  shake(big);
  if(!hasPX() || !PX.fxEl){ return; }
  const add = (el, alt, life) => { if(el) anchorFx(el, lat, lng, alt, life); };
  /* 全部是像素特效(使用者:「爆炸特效也改成像素」):
     閃光(3 格)→ 爆炸本體(9 格,白 → 黃 → 橘 → 紅 → 黑煙散掉)→ 壓扁的衝擊波圈
     → 方塊火花往外噴、落下 → 燒一陣子的像素火苗 → 往上飄的像素煙 */
  add(PX.fxEl('flash', { z: big ? 5 : 3, dur: .24 }), .002, 400);
  add(PX.fxEl(big ? 'boomBig' : 'boom', { z: big ? 4 : 3, dur: big ? 1.05 : .8 }), .002, 1300);
  add(PX.fxEl('ring', { z: big ? 5 : 3, dur: .6, delay: 60 }), .001, 900);
  const rnd = Math.random;                                  // 純畫面效果,不碰遊戲的種子亂數
  const cols = ['#ffe9a8', '#ffd84a', '#f59f3a', '#e5484d', '#eef2f7'];
  for(let i = 0, n = big ? 22 : 12; i < n; i++){             // 方塊火花
    const a = rnd() * Math.PI * 2, d = (big ? 60 : 34) + rnd() * (big ? 90 : 46);
    const e = document.createElement('div'); e.className = 'pxspark';
    e.style.cssText = `--dx:${(Math.cos(a)*d).toFixed(0)}px;--dy:${(Math.sin(a)*d - 24).toFixed(0)}px;--dl:${(rnd()*120).toFixed(0)}ms;`
      + `--c:${cols[i % cols.length]};--s:${big && i % 3 === 0 ? 6 : 4}px`;
    add(e, .002, 1200);
  }
  for(let i = 0, n = big ? 4 : 2; i < n; i++){              // 燒一陣子的火
    const e = PX.fxEl('fire', { z: 3, cls: 'burn', css: `--dx:${((rnd() - .5) * (big ? 50 : 26)).toFixed(0)}px;--dy:${((rnd() - .5) * 14).toFixed(0)}px;--life:${big ? 4 : 3}s;` });
    add(e, .0015, big ? 4200 : 3100);
  }
  for(let i = 0, n = big ? 5 : 3; i < n; i++){              // 煙
    add(PX.fxEl('smoke', { z: 3, dur: 2.2, delay: 300 + i * 240, cls: 'rise', css: `--dx:${((rnd() - .5) * 40).toFixed(0)}px;` }), .002, 3200);
  }
}
/* 小一號的像素特效:蓋房子的塵土、出牌落地的星星與金幣(出牌回饋用) */
function fxAt(lat, lng, kind, opt){
  if(!hasPX() || !PX.fxEl) return;
  const e = PX.fxEl(kind, opt); if(e) anchorFx(e, lat, lng, (opt && opt.alt) || .002, (opt && opt.life) || 1600);
}
W3D.fxAt = fxAt;
/* 一座城市在螢幕上的位置(client 座標);在球的背面回傳 null */
W3D.screenOf = function(id){
  if(!W3D.ok || typeof tySite !== 'function') return null;
  const s = tySite(id), host = document.getElementById('tyGlobeHost'); if(!s || !host) return null;
  try{
    const c = G.getScreenCoords(s.lat, s.lng, .002), cam = G.camera().position, q = G.getCoords(s.lat, s.lng, 0);
    if(q.x*cam.x + q.y*cam.y + q.z*cam.z <= R*R*1.001) return null;
    const r = host.getBoundingClientRect();
    return { x: r.left + c.x, y: r.top + c.y };
  }catch(e){ return null; }
};
/* 出牌落地:星星爆開 + 小閃光 + 衝擊圈 + 輕震;再依牌的種類加一點料 */
W3D.cardHit = function(id, k, label){
  if(!W3D.ok || typeof tySite !== 'function') return;
  const s = tySite(id); if(!s) return;
  const { lat, lng } = s;
  fxAt(lat, lng, 'flash', { z: 2, dur: .22, life: 400 });
  fxAt(lat, lng, 'ring', { z: 3, dur: .5, life: 800 });
  const rnd = Math.random;
  for(let i = 0; i < 6; i++){
    const a = i / 6 * Math.PI * 2 + rnd() * .5, d = 26 + rnd() * 20;
    fxAt(lat, lng, 'star', { z: 3, dur: .5, delay: i * 40, cls: 'fly', life: 900,
      css: `--dx:${(Math.cos(a)*d).toFixed(0)}px;--dy:${(Math.sin(a)*d).toFixed(0)}px;--dur:.6s;` });
  }
  if(k === 'build' || k === 'upgrade' || k === 'shell') fxAt(lat, lng, 'dust', { z: 4, dur: .8, life: 1000, alt: .001 });
  if(k === 'invest' || k === 'sell' || k === 'deal'){
    for(let i = 0; i < 6; i++) fxAt(lat, lng, 'coin', { z: 3, cls: 'fly', delay: i * 70, life: 1400,
      css: `--dx:${((rnd() - .5) * 60).toFixed(0)}px;--dy:${(-40 - rnd() * 40).toFixed(0)}px;--dur:1s;` });
  }
  shake(false);
  if(label){ const fx = fxLayer(); if(fx) floatAt(fx, lat, lng, label, 'card', 120); }
};
/* 開演之前鏡頭先飛過去:起點與終點都要在畫面裡 */
function focusOn(A, B, cb){
  const km = kmLL([A.lat, A.lng], [B.lat, B.lng]);
  const mid = tyGeoLerp(A, B, .5);
  const alt = clamp(.3 + km / 3800, .38, 2.1);
  try{ G.controls().autoRotate = false; G.pointOfView({ lat: mid.lat, lng: mid.lng, altitude: alt }, W3D._tfix != null ? 0 : 1000); }catch(e){}
  tyWake();
  setTimeout(cb, W3D._tfix != null ? 0 : 1050);
}

/* 部隊出發:人搭客機;併購小組近的車隊開過去、遠的開到港口 → 驅逐艦 → 上岸 */
let moveBurst = { t: 0, n: 0 };
W3D._boom = (lat, lng, big) => boom(lat, lng, big);    // 給截圖驗證用
W3D._step = () => { const t = performance.now(); animStep(t); animStep(t + 1); };   // 給截圖驗證用:手動推一格
W3D.animMove = function(m){
  if(!W3D.ok || !m) return;
  const A = tySite(m.from), B = tySite(m.to);
  const km = kmLL([A.lat, A.lng], [B.lat, B.lng]);
  // 一次派好幾支(拉線勾了三支):一支一支錯開出發,不要疊成同一架飛機
  const now = performance.now();
  if(now - moveBurst.t > 400) moveBurst.n = 0;
  moveBurst.t = now; const lag = moveBurst.n++ * 900;
  focusOn(A, B, () => setTimeout(() => {
    const land = () => floatAt(fxLayer(), B.lat, B.lng, `${TY_UNITS[m.k].ic} 抵達 ${escH(B.nm)}`, 'rv', 0);
    if(m.k === 'raid'){
      const pts = routeFor('ground', A, B);
      const sea = pts.filter(p => p.mode === 'ship').length;
      fly({ kind: 'ground', pts, dur: sea ? clamp(9000 + km * .55, 9000, 18000) : clamp(4500 + km * .55, 5000, 12000),
            trail: sea ? { col: ['rgba(255,255,255,0)', 'rgba(220,240,255,.8)'], w: 1.6, max: 90 } : null, done: land });
    }else{
      fly({ kind: 'plane', from: A, to: B, arc: clamp(km / 9000 * .1, .018, .09), dur: clamp(4000 + km * .5, 5000, 10000),
            trail: { col: ['rgba(255,255,255,0)', 'rgba(255,255,255,.75)'], w: 1.1, max: 70 }, done: land });
    }
  }, lag));
};
/* 打擊:飛彈從大本營拋過去;空襲是三架戰機編隊,飛過目標上空一路投彈 */
W3D.animStrike = function(s){
  if(!W3D.ok || !s) return;
  const A = tySite(s.from), B = tySite(s.to);
  const km = kmLL([A.lat, A.lng], [B.lat, B.lng]);
  focusOn(A, B, () => {
    if(s.k === 'missile'){
      fly({ kind: 'missile', from: A, to: B, arc: clamp(km / 6000 * .25, .06, .36), dur: clamp(3500 + km * .3, 4000, 7000),
            trail: { col: ['rgba(200,200,200,0)', 'rgba(255,190,120,.95)'], w: 2.4 },
            done: () => { boom(B.lat, B.lng, true); setTimeout(() => boom(B.lat + .08, B.lng - .1, false), 260); } });
    }else{
      // 航線延伸過目標一截:戰機飛越目標上空投彈,再繼續飛走
      const beyond = tyGeoLerp(A, B, 1.25);
      const dur = clamp(4500 + km * .35, 5000, 8000);
      const sep = clamp(km / 2500 * .8, 1.1, 1.8);             // 編隊間距跟著距離走:遠的看得出三架
      [[0, 0], [sep, 220], [-sep, 440]].forEach(([off, delay], j) => {
        const pts = routeFor('jet', A, beyond);
        const a = { kind: 'jet', pts, arc: .025, off, dur, delay,
          trail: { col: ['rgba(255,255,255,0)', 'rgba(255,255,255,.6)'], w: .8, max: 40 } };
        fly(a);
        const last = ANIMS[ANIMS.length - 1];
        last.passAt = 1 / 1.25 - .04;
        last.onPass = P => {
          for(let i = 0; i < 3; i++) setTimeout(() => {
            const lat = B.lat + off * .35 + (i - 1) * .12, lng = B.lng + (i - 1) * .16;
            fly({ kind: 'bomb', pts: [{ lat: P.lat, lng: P.lng, mode: 'bomb' }, { lat, lng, mode: 'bomb' }],
                  arc: 0, dur: 700, done: () => boom(lat, lng, false) });
            // 炸彈的高度:從戰機的高度直直掉下來
            const bb = ANIMS[ANIMS.length - 1]; bb.fall = P.alt;
          }, i * 170 + j * 60);
        };
      });
    }
  });
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
      + `<span class="${ok ? 'ok' : 'dim'}">${ok ? (AIM.drag ? '✓ 放開就出牌' : '✓ 點一下確定') : '✕ 這裡不行'}</span>`;
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
/* 從外面驅動拉線(卡牌拖曳):座標是 client 座標 */
function hostRel(cx, cy){
  const host = document.getElementById('tyGlobeHost'); if(!host) return null;
  const r = host.getBoundingClientRect();
  if(cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return null;
  return [cx - r.left, cy - r.top];
}
W3D.aimAt = function(cx, cy){
  if(!AIM) return;
  const p = hostRel(cx, cy); if(!p) return;
  AIM.x = p[0]; AIM.y = p[1]; AIM.drag = true;
  const s = nearSite(p[0], p[1], 40); AIM.site = s ? s.id : null;
  drawAim();
};
/* 放開:在城市上 → 出牌(回傳 true);放在地圖上但不是可以出的城市 → 留在拉線模式讓你再點一次
   (也回傳 true);放在地圖外面(拖回手牌)→ 回傳 false,由呼叫的人取消 */
W3D.aimDrop = function(cx, cy){
  if(!AIM) return false;
  const p = hostRel(cx, cy); if(!p) return false;
  const s = nearSite(p[0], p[1], 40);
  if(s && AIM.valid(s.id)){ const pick = AIM.pick; W3D.aimCancel(); pick(s.id); return true; }
  AIM.x = p[0]; AIM.y = p[1]; AIM.site = s ? s.id : null; AIM.drag = false; drawAim();
  return true;
};
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
  const here = units[0].to || units[0].site, inc = units.filter(u => u.to).length;
  const where = `${tySite(here).nm} · ${units.length - inc} 支駐紮${inc ? ` · ${inc} 支下季到位` : ''}`;
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

  /* ④ 對手這一季做了什麼(index 的 TY_RV_EV)—— 使用者:「我想看到對手做了什麼」。
     擴張 = 他的客機飛過去插旗;出兵 = 車隊 / 船真的開過來;併購 = 被吃掉的那一家爆炸;
     上市 = 大本營冒一圈光;斷頭 = 大本營冒煙;放話 = 你的大本營上跳一則。
     有人出兵打你的時候鏡頭會轉過去 —— 那是這一季最重要的事。 */
  const arcs = [];
  const EV = (typeof TY_RV_EV !== 'undefined' && TY_RV_EV) || [];
  const rcol = id => (typeof TY_RVCOL !== 'undefined' && TY_RVCOL[id]) || '200,200,210';
  const tag = (r, txt) => `<span style="color:rgb(${rcol(r.id)})">${r.ic || ''} ${escH(r.nm)}</span> ${txt}`;
  const regSite = (r, reg) => {
    const f = (typeof tyRivalForces === 'function' ? tyRivalForces() : []).find(x => x.r.id === r.id && x.reg === reg);
    return f ? tySite(f.site) : TY_SITES.find(s => s.reg === reg && s.id !== r.home);
  };
  const order = { march: 0, eat: 1, expand: 2, crash: 3, ipo: 4, leak: 5, smear: 5 };
  const evs = EV.slice().sort((a, b) => (order[a.k] ?? 9) - (order[b.k] ?? 9)).slice(0, 6);
  const march = evs.find(e => e.k === 'march');
  const go = () => evs.forEach((e, j) => {
    const r = TY.rivals.find(x => x.id === e.rid); if(!r) return;
    const home = tySite(r.home), col = rcol(r.id), delay = 700 + j * 1100;
    setTimeout(() => {
      if(e.k === 'expand'){
        const to = regSite(r, e.reg); if(!to || to.id === home.id) return;
        const km = kmLL([home.lat, home.lng], [to.lat, to.lng]);
        fly({ kind: 'plane', from: home, to, arc: clamp(km / 9000 * .1, .018, .09), dur: clamp(3500 + km * .4, 4500, 8000), tag: r.id,
              trail: { col: [`rgba(${col},0)`, `rgba(${col},.9)`], w: 1.2, max: 60 },
              done: () => {
                floatAt(fxLayer(), to.lat, to.lng, tag(r, e.mine ? '打進你的地盤' : `擴張到${escH(TY_REGIONS[e.reg].nm)}`), e.mine ? 'enemy' : 'rv', 0);
                W3D.extraRings = W3D.extraRings.concat([{ lat: to.lat, lng: to.lng, _rgb: col, _a: .95, _r: 3, _v: 2.4, _p: 800 }]); W3D.rings();
              } });
      }else if(e.k === 'march'){
        const to = tySite(e.to), km = kmLL([home.lat, home.lng], [to.lat, to.lng]);
        const pts = routeFor('ground', home, to), sea = pts.some(p => p.mode === 'ship');
        floatAt(fxLayer(), home.lat, home.lng, tag(r, `出兵 → ${escH(to.nm)}`), 'enemy', 0);
        fly({ kind: 'ground', pts, tag: r.id, dur: clamp((sea ? 8000 : 5000) + km * .5, 6000, 15000),
              trail: { col: [`rgba(${col},0)`, `rgba(${col},.9)`], w: 1.6, max: 90 },
              done: () => floatAt(fxLayer(), to.lat, to.lng, tag(r, '的併購小組逼近'), 'enemy', 0) });
      }else if(e.k === 'eat'){
        const at = tySite(e.at || r.home), prey = TY.rivals.find(x => x.id === e.prey);
        boom(at.lat, at.lng, false);
        floatAt(fxLayer(), at.lat, at.lng, tag(r, `吞併了${escH(prey ? prey.nm : '對手')}`), 'enemy', 300);
      }else if(e.k === 'ipo'){
        floatAt(fxLayer(), home.lat, home.lng, tag(r, '📈 旗下事業上市'), 'rv', 0);
        W3D.extraRings = W3D.extraRings.concat([{ lat: home.lat, lng: home.lng, _rgb: col, _a: 1, _r: 4, _v: 3, _p: 600 }]); W3D.rings();
      }else if(e.k === 'crash'){
        boom(home.lat, home.lng, false);
        floatAt(fxLayer(), home.lat, home.lng, tag(r, '💥 槓桿斷頭,身家腰斬'), 'enemy', 300);
      }else if(e.k === 'leak' || e.k === 'smear'){
        const me = tySite(TY.home);
        floatAt(fxLayer(), me.lat, me.lng, tag(r, e.k === 'leak' ? '📰 把你的架構送去檢舉' : '📰 在媒體上點名你'), 'enemy', 0);
      }
    }, delay);
  });
  if(evs.length){
    if(march){
      const A = tySite(march.from), B = tySite(march.to);
      setTimeout(() => focusOn(A, B, go), 900);
    }else go();
  }else{
    // 沒有事件紀錄(例如讀舊存檔的第一季):退回「勢力變大就拉一條弧線」
    for(const r of tyRivalsA()){
      const was = snap.rv[r.id]; if(!was) continue;
      const col = rcol(r.id);
      for(const [reg2, v] of Object.entries(r.turf || {})){
        if(v - (was.turf[reg2] || 0) < 1.5) continue;
        const home = tySite(r.home);
        const to = TY_SITES.find(s => s.reg === reg2 && s.id !== r.home);
        if(!to) continue;
        arcs.push({ startLat: home.lat, startLng: home.lng, endLat: to.lat, endLng: to.lng,
                    _c: [`rgba(${col},.2)`, `rgba(${col},.95)`] });
        rings.push({ lat: to.lat, lng: to.lng, _rgb: col, _a: .9, _r: 2.6, _v: 2, _p: 1000 });
      }
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
