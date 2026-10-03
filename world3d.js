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
  const zs = zones();
  const sig = (typeof TY_LAYER !== 'undefined' ? TY_LAYER : '') + '|' + cols.join('|') + '|' + ccols.map(x => x[0] + x[1]).join('|') + '|' + zs.map(z => z.id + z.km + z.col + z.pa).join('|') + (PROV ? '|P' : '');
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
  /* 勢力範圍:城市勢力半徑內的省 / 州整塊塗上第一名的顏色(使用者:「不要用圓圈,把範圍內的地區顏色畫明顯一點」)。
     描邊用同色、比較深 —— 一塊一塊的省界看得出來,整片連起來就是那個人的地盤。 */
  for(const [rings, z] of provZones(zs)){
    const p = new Path2D(); for(const r of rings) ringPath(p, r, W, H);
    c.fillStyle = `rgba(${z.col},${z.pa})`; c.fill(p, 'evenodd');
    c.lineWidth = Math.max(1.5, 2 * k); c.strokeStyle = `rgba(${z.col},.95)`; c.stroke(p);
  }
  // 勢力圖層:城市的真實範圍塗上「這座城是誰的」(國家之下的第二層)
  for(const [id, col] of ccols){
    const p = cityP2D(id, W, H); if(!p) continue;
    c.fillStyle = col; c.fill(p, 'evenodd');
    c.lineWidth = 2*k; c.strokeStyle = col.replace(/,\s*([\d.]+)\)$/, ',1)'); c.stroke(p);
  }
  TEX.needsUpdate = true;
}
/* 勢力範圍(index.html 的 tyCityZones:每座城的第一名、顏色、半徑)→ 半徑內的省 / 州。
   provinces.json 是開發時從 Natural Earth 省界擷取的(tools/make-provinces.py):每座城 460 公里內的省與距離。
   同一個省落在好幾座城的範圍裡:歸「距離 ÷ 半徑」最小的那一座(離得近、勢力又大的贏)。 */
function zones(){ try{ return typeof tyCityZones === 'function' ? tyCityZones() : []; }catch(e){ return []; } }
let PROV = null, provLoading = false;
function provData(){
  if(PROV || provLoading) return PROV;
  provLoading = true;
  fetch('provinces.json').then(r => r.ok ? r.json() : null).then(j => { PROV = j || { P: [], S: {} }; W3D.repaint(); })
    .catch(() => { PROV = { P: [], S: {} }; });
  return null;
}
function provZones(zs){
  const D = zs.length ? provData() : null; if(!D) return [];
  const best = new Map();
  for(const z of zs) for(const [pi, d] of (D.S[z.id] || [])){
    if(d > z.km) continue;
    const sc = d / Math.max(1, z.km), cur = best.get(pi);
    if(!cur || sc < cur.sc) best.set(pi, { sc, z });
  }
  const out = [];
  for(const [pi, b] of best) out.push([D.P[pi], b.z]);
  return out.sort((a, b) => (a[1].me ? 1 : 0) - (b[1].me ? 1 : 0));   // 你的畫在最上面
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
/* 高於這個高度:3D 模型全部收起來,改成像素圖示(城市名牌上的小建築、部隊的方形兵種圖示)。
   使用者截圖(歐洲、台灣海峽那個距離):「這個距離還是先顯示圖案,等我再放大再顯示立體的」——
   第一版 .95 太高,中距離一堆 3D 大樓、戰車、地標擠成一團。 */
const FAR_ALT = .3;

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
  for(const [rings, z] of provZones(zones())){
    c.beginPath(); for(const r of rings) patchRing(c, r, P, W, H);
    c.fillStyle = `rgba(${z.col},${z.pa})`; c.fill('evenodd');
    c.lineWidth = 2; c.strokeStyle = `rgba(${z.col},.95)`; c.stroke();
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
/* 地形的真實高度(使用者:「地形也要立體,要跟地圖很完美的融合」)。
   近看的那一片曲面照 terrain.js 的高程往上推:山真的是凸起來的,傾斜的鏡頭看得到山的側面;
   貼圖上的梯田、懸崖暗面、北緣亮邊是同一組高程畫的,所以凸起來的地方就是畫著山的地方。
   高度一半取梯田的階數(像素風的「一階一階」)、一半取平滑高程(不要變成一根根柱子);
   曲面的四邊收斂到 0,跟整球貼圖接得起來。建築也站在同一個高度上(elevAlt)。 */
const EH = .0045;
const elevAlt = (lat, lng) => (typeof TERRAIN !== 'undefined' && TERRAIN.elev) ? (() => {
  const e = TERRAIN.elev(lng, lat); return (e * .5 + TERRAIN.levelOf(e) / 5 * .5) * EH; })() : 0;
W3D.elevAlt = elevAlt;
function patchGeo(P){
  // 格子依範圍加密:每格不超過 0.25 度 —— 山的起伏要做得出來,弦也不會切進球面
  const N = clamp(Math.ceil(Math.max(P.la1 - P.la0, P.lo1 - P.lo0) / .25), 48, 170), pos = [], uv = [], nor = [], idx = [];
  const edge = Math.max(2, N * .12);
  for(let j = 0; j <= N; j++) for(let i = 0; i <= N; i++){
    const lat = P.la0 + (P.la1 - P.la0) * j / N, lng = P.lo0 + (P.lo1 - P.lo0) * i / N;
    const taper = smooth(Math.min(i, N - i, j, N - j) / edge);
    const q = G.getCoords(lat, lng, .0004 + elevAlt(lat, lng) * taper);
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
W3D.bldSprite = b => bldSprite(b);
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
  return { W, D };
}
/* 城市的配套 —— 使用者:「參考世界征服者 4 的城市,還有港口、工廠等等」。
   你的小城旁邊依那座城的條件長出配套(規則面由 index.html 算好,放在 d._feat):
     港口  港口城市:碼頭、貨櫃堆、龍門吊(南邊,朝海的那一側)
     工廠  有能源 / 基建 / 建設 / 科技公司:鋸齒屋頂廠房 + 紅白煙囪(東邊)
     機場  城市等級 6 以上:跑道 + 塔台 + 一架停著的客機(西邊)
   W、D = 小城地基的寬與深(體素),配套貼在它外側。 */
function cityExtras(B, W, D, f){
  if(!f) return;
  if(f.factory){
    const x0 = W / 2 + 1;
    vbox(B, x0, -4, 0, 10, 8, 1, [150,150,140]);
    vbox(B, x0 + .5, -3, 1, 9, 6, 3.4, [176,160,140]);
    for(let i = 0; i < 3; i++){ vbox(B, x0 + .5 + i * 3, -3, 4.4, 3, 6, .9, [120,110,100]); vbox(B, x0 + 2.6 + i * 3, -3, 4.4, .4, 6, 1.8, [127,190,220]); }
    for(const [x, y] of [[x0 + 7.5, 2], [x0 + 5.5, 2.2]]){
      for(let z = 1; z < 11; z += 2) vbox(B, x, y, z, 1.4, 1.4, 1, z % 4 === 1 ? [229,72,77] : [238,242,247]);
      vbox(B, x - .3, y - .3, 11, 2, 2, 1.2, [200,200,205]); vbox(B, x - .8, y - .6, 12.2, 2.6, 2.4, 1.6, [215,215,220]);   // 冒出來的煙
    }
  }
  if(f.port){
    const y0 = -D / 2 - 7;
    vbox(B, -W / 2 - 2, y0, 0, W + 4, 6.5, 1, [168,172,180]);             // 碼頭
    for(let x = -W / 2 - 2; x < W / 2 + 2; x += 3) vbox(B, x, y0 - .6, 0, .6, .6, 1, [90,70,50]);   // 繫纜樁
    const cols = [[229,72,77], [58,123,213], [70,196,106], [245,159,58], [255,216,74]];
    for(let i = 0; i < 6; i++) vbox(B, -W / 2 + 1 + (i % 3) * 2.6, y0 + 3 + Math.floor(i / 3) * 1.4, 1, 2.4, 1.2, 1.2 + (i % 2), cols[i % 5]);
    const cx = W / 2 - 3;                                                  // 龍門吊
    vbox(B, cx, y0 + 1, 1, .7, .7, 9, [255,216,74]); vbox(B, cx, y0 + 5, 1, .7, .7, 9, [255,216,74]);
    vbox(B, cx - .2, y0 - 4, 10, 1.1, 10, 1, [255,216,74]); vbox(B, cx - .4, y0 + 3.5, 10.5, 1.5, 2, 1.5, [60,64,74]);
    vbox(B, cx + .1, y0 - 2.5, 6, .3, .3, 4, [60,64,74]);
  }
  if(f.airport){
    const x1 = -W / 2 - 2;
    vbox(B, x1 - 5, -9, 0, 5, 18, .5, [70,74,84]);                        // 跑道
    for(let y = -8; y < 9; y += 3) vbox(B, x1 - 2.7, y, .5, .6, 1.6, .05, [238,242,247]);
    vbox(B, x1 - 7.5, 4, 0, 2, 2, 7, [217,221,230]); vbox(B, x1 - 7.9, 3.6, 7, 2.8, 2.8, 1.4, [127,216,255]);   // 塔台
    // 停在跑道頭的客機:機身、主翼、尾翼
    vbox(B, x1 - 3.1, -7, .6, .9, 6, .9, [238,242,247]); vbox(B, x1 - 5, -4.8, .9, 4.8, 1.2, .3, [200,205,215]);
    vbox(B, x1 - 3.9, -7, .9, 2.5, .7, .3, [200,205,215]); vbox(B, x1 - 2.8, -7, 1.5, .3, .8, 1.4, [47,143,224]);
  }
}
function voxRoot(d, key, make, flags){
  const root = new T.O3();
  root.userData.site = d;
  Object.assign(root.userData, flags || {});
  if(!hasPX()) return root;
  const mesh = new T.Mesh(voxGeo(key, make), vmat());
  mesh.scale.setScalar(PXU);
  if(!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox;
  root.userData.rx = Math.max(Math.abs(bb.min.x), bb.max.x, Math.abs(bb.min.y), bb.max.y);
  root.add(mesh);
  root.userData.vox = mesh;
  root.userData.key = key;
  OBJS.add(root);
  return root;
}
let LAST_SITES = null;
const CENTER_R = Object.create(null);     // 每座城正中央那一棟的佔地半徑(度),旁邊的東西照它讓位
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
  const L = LANDMARK[d.id];
  if(!L) return null;
  const k = L[0], sp = (PX.LMS[k] || PX.LMS.skyline);
  return voxRoot(d, 'lm:' + k, B => voxCity(B, [{ sp, dep: Math.max(4, Math.min(sp.w, 10)) }], '#9aa5b8'), { lm: true });
}
/* =============================================================================
   軍隊模型 —— 使用者:「軍隊這樣很醜,我想要長得像那幾張圖(Conflict of Nations 那種)」
   -----------------------------------------------------------------------------
   第一版是把 2D 像素圖擠出厚度、底下墊一塊藍色地基 —— 像一張立牌,不像一台戰車。
   這一版每一種兵都是**真的 3D 模型**(一塊一塊長方體拼的,還是方方的像素手感):
     坦克    履帶、車身、砲塔、長砲管、天線上一面小旗
     步兵    三個兵:鋼盔、背包、步槍
     火炮    自走砲:大砲塔 + 往上翹的長砲管(一格一格的階梯)
     補給    軍卡:駕駛艙、擋風玻璃、帆布車斗、六個輪子
     驅逐艦  船身、艦橋、桅杆、前主砲、紅色水線
     航空母艦 長甲板(白邊、黃中線)、右舷艦島、甲板上停著戰機
   塗裝照參考圖:你的部隊是沙漠色、對手是灰綠色;隊伍顏色只出現在旗子與砲塔上的一條識別帶。
   每一支部隊一台,排成小隊形(不再是一坨擠在同一塊底座上),底下有一片半透明的影子。
   座標:x = 車頭方向、y = 左、z = 上,一格 = 一個體素;跟移動動畫的 orient() 同一套。
   ============================================================================= */
const MIL_SCHEME = {
  me:  { body: [206,182,124], dark: [150,130,86], light: [226,206,152], track: [58,56,50], canvas: [170,156,108] },
  foe: { body: [118,128,110], dark: [80,88,76],   light: [146,156,136], track: [46,48,44], canvas: [98,110,88] },
};
const SHIP = { hull: [120,128,140], deck: [150,158,170], dark: [84,90,100], red: [150,44,40], fdeck: [74,80,90] };
const GUN = [40,42,44], SKIN = [230,190,150], GLASS = [127,216,255], WHITE = [238,242,247], YEL = [255,216,74];
function milFlag(B, x, y, z, acc){ vbox(B, x, y, z, .25, .25, 3.4, GUN); vbox(B, x + .25, y, z + 2.2, 2.2, .15, 1.3, acc); }
/* 每一種兵的長寬高(體素),排隊形與算佔地用 */
const MIL_DIM = { tank: [15, 7, 6], inf: [6, 6, 5], arty: [16, 7, 8], truck: [12, 5, 4], destroyer: [19, 5, 7], carrier: [33, 9, 10] };
const MIL_OF = { raid: 'tank', law: 'inf', lobby: 'arty', mgr: 'truck', navy: 'carrier', ship: 'destroyer' };
function milBuild(B, kind, side, acc){
  const C = MIL_SCHEME[side] || MIL_SCHEME.me;
  if(kind === 'tank'){
    vbox(B, -5.6, -3.4, 0, 11.2, 1.7, 1.9, C.track); vbox(B, -5.6, 1.7, 0, 11.2, 1.7, 1.9, C.track);
    for(let i = 0; i < 5; i++){ vbox(B, -4.4 + i * 2.2, -3.5, .3, 1.2, .1, 1.2, [90,88,80]); vbox(B, -4.4 + i * 2.2, 3.4, .3, 1.2, .1, 1.2, [90,88,80]); }
    vbox(B, -5.2, -2.9, 1.2, 10.2, 5.8, 1.5, C.body);
    vbox(B, 4.4, -2.6, 1.2, 1.4, 5.2, 1, C.dark);                       // 前裝甲斜板
    vbox(B, -2.8, -2.1, 2.7, 5.2, 4.2, 1.7, C.light);                    // 砲塔
    vbox(B, -2.8, -2.15, 3.5, 5.2, .1, .4, acc);                         // 識別帶
    vbox(B, -1.9, .4, 4.4, 1.3, 1.3, .4, C.dark);                        // 艙蓋
    vbox(B, 2.3, -.4, 3.2, 7, .8, .8, GUN); vbox(B, 9, -.55, 3.05, 1, 1.1, 1.1, GUN);   // 砲管 + 砲口
    milFlag(B, -2.4, 1.6, 4.4, acc);
  }else if(kind === 'inf'){
    const man = (ox, oy) => {
      vbox(B, ox - .35, oy - .55, 0, .7, .45, 1.5, C.dark); vbox(B, ox - .35, oy + .1, 0, .7, .45, 1.5, C.dark);
      vbox(B, ox - .55, oy - .65, 1.5, 1.1, 1.3, 1.6, C.body);
      vbox(B, ox - 1.05, oy - .45, 1.7, .5, .9, 1.2, C.dark);            // 背包
      vbox(B, ox - .35, oy - .35, 3.1, .7, .7, .7, SKIN);
      vbox(B, ox - .5, oy - .5, 3.6, 1, 1, .5, C.dark);                   // 鋼盔
      vbox(B, ox + .2, oy - .95, 2.1, 2.2, .3, .3, GUN);                   // 步槍
    };
    man(1.6, 0); man(-1.2, 2); man(-1.2, -2);
    milFlag(B, -2.6, 0, 0, acc);
  }else if(kind === 'arty'){
    vbox(B, -6, -3.4, 0, 12, 1.7, 1.9, C.track); vbox(B, -6, 1.7, 0, 12, 1.7, 1.9, C.track);
    vbox(B, -5.6, -2.9, 1.2, 11, 5.8, 1.4, C.body);
    vbox(B, -5, -2.5, 2.6, 6.2, 5, 2.4, C.light);                        // 大砲塔(在後段)
    vbox(B, -5, -2.55, 3.8, 6.2, .1, .5, acc);
    for(let i = 0; i < 7; i++) vbox(B, 1 + i * 1.25, -.45, 3.6 + i * .62, 1.45, .9, .9, GUN);   // 往上翹的長砲管
    vbox(B, -6.4, -2, .6, .8, 4, .5, C.dark);                            // 駐鋤
    milFlag(B, -4.4, 1.8, 5, acc);
  }else if(kind === 'truck'){
    for(const x of [-3.8, -1.8, 3.6]) for(const y of [-2.7, 2.1]) vbox(B, x, y, 0, 1.5, .6, 1.5, C.track);
    vbox(B, -5, -2.2, .8, 11, 4.4, .6, C.dark);                          // 底盤
    vbox(B, 3, -2.2, 1.4, 2.8, 4.4, 2.4, C.body);                        // 駕駛艙
    vbox(B, 5.75, -1.8, 2.4, .12, 3.6, 1, GLASS);
    vbox(B, -5, -2.3, 1.4, 7.6, 4.6, 2.8, C.canvas);                     // 帆布車斗
    for(let x = -4.4; x < 2.5; x += 1.8) vbox(B, x, -2.35, 1.4, .3, 4.7, 2.9, C.dark);   // 帆布的肋條
    vbox(B, -5, -2.4, 3.2, 7.6, .1, .5, acc);
    milFlag(B, 3.2, 1.6, 3.8, acc);
  }else if(kind === 'destroyer'){
    vbox(B, -8.5, -2.1, 0, 14, 4.2, .5, SHIP.red);                       // 水線
    vbox(B, -8.5, -2, .5, 14, 4, 1.4, SHIP.hull);
    vbox(B, 5.5, -1.5, 0, 2, 3, 1.9, SHIP.hull); vbox(B, 7.5, -.8, .2, 1.7, 1.6, 1.7, SHIP.hull);   // 船頭收窄
    vbox(B, -8.5, -1.9, 1.9, 16.6, 3.8, .15, SHIP.deck);
    vbox(B, -3.5, -1.4, 2, 4.6, 2.8, 2, SHIP.deck); vbox(B, 0, -1.1, 2, 1.8, 2.2, 3.2, WHITE);     // 艦橋
    vbox(B, .2, -1.15, 4.4, 1.4, 2.3, .4, GLASS);
    vbox(B, -2.2, -.15, 4, .3, .3, 3.4, GUN); vbox(B, -2.9, -.9, 6.4, 1.6, 1.8, .15, GUN);         // 桅杆 + 雷達
    vbox(B, 3.6, -.7, 2, 1.5, 1.4, .9, SHIP.dark); vbox(B, 5.1, -.15, 2.3, 2.4, .3, .3, GUN);     // 前主砲
    vbox(B, -8, -1.6, 2.05, 3, 3.2, .05, [200,200,200]);                  // 直升機甲板
    vbox(B, -2.25, -.1, 7.4, .2, 1.8, 1.1, acc);                          // 艦旗
  }else if(kind === 'carrier'){
    vbox(B, -15, -3.4, 0, 27, 6.8, .6, SHIP.red);
    vbox(B, -15, -3.3, .6, 27, 6.6, 2, SHIP.hull);
    vbox(B, 12, -2.4, .1, 3, 4.8, 2.5, SHIP.hull);
    vbox(B, -16, -4.4, 2.6, 32, 8.8, .35, SHIP.fdeck);                   // 飛行甲板
    vbox(B, -16, -4.35, 2.96, 32, .2, .04, WHITE); vbox(B, -16, 4.15, 2.96, 32, .2, .04, WHITE);
    for(let x = -14; x < 15; x += 2.6) vbox(B, x, -.1, 2.96, 1.4, .2, .04, YEL);                 // 中線
    vbox(B, -1, -4.6, 2.95, 4.2, 1.8, 4, SHIP.deck); vbox(B, -.8, -4.65, 5.7, 3.8, 1.9, .6, GLASS);   // 右舷艦島
    vbox(B, .6, -3.9, 6.95, .35, .35, 2.6, GUN); vbox(B, 0, -4.6, 8.6, 1.6, 1.6, .15, GUN);
    vbox(B, .9, -3.85, 8.4, .2, 1.6, 1, acc);
    const jet = (x, y) => {
      vbox(B, x - 1.7, y - .35, 3, 3.4, .7, .5, [150,160,172]);
      vbox(B, x - .5, y - 1.7, 3.1, 1.3, 3.4, .15, [128,138,150]);
      vbox(B, x - 1.7, y - .9, 3.1, .6, 1.8, .15, [128,138,150]);
      vbox(B, x - 1.7, y - .08, 3.5, .7, .16, .9, [110,120,130]);
      vbox(B, x + 1.3, y - .25, 3.35, .6, .5, .25, GLASS);
    };
    jet(-11, 2.2); jet(-6.5, 2.2); jet(-2, 2.2); jet(6, 1.8); jet(10, -1.8);
  }
}
/* 一台模型的幾何(同一種兵 + 同一個陣營 + 同一個識別色只算一次) */
function milGeo(kind, side, acc){
  const a = acc || [47,143,224];
  return voxGeo('mil:' + kind + ':' + side + ':' + a.join(','), B => milBuild(B, kind, side, a));
}
let SHADOW_MAT = null, SHADOW_GEO = null;
function milShadow(len, wid){
  if(!SHADOW_MAT){
    SHADOW_MAT = new T.Phong({ color: 0x000000, transparent: true, opacity: .28, depthWrite: false });
    const B = VB(); vquad(B, [-.5,-.5,0], [.5,-.5,0], [.5,.5,0], [-.5,.5,0], [0,0,1], [0,0,0], 1); SHADOW_GEO = vgeo(B);
  }
  const m = new T.Mesh(SHADOW_GEO, SHADOW_MAT);
  m.scale.set(len * 1.05, wid * 1.15, 1); m.position.set(.8, -.8, .05);
  return m;
}
/* 部隊:每一支一台,排成小隊形。海軍另外站在海上(見 applyScale 的 navy) */
function buildTroop(d){
  const enemy = d._threat || d._rvf;
  const side = enemy ? 'foe' : 'me';
  const acc = enemy ? rvRGB(d._r.id).split(',').map(Number) : hexRGB(TEAM);
  let kinds;
  if(d._threat) kinds = [d._sea ? 'destroyer' : 'tank'];
  else if(d._navy){ kinds = ['carrier']; if(d._units.length > 1) kinds.push('destroyer'); }
  else if(d._sea) kinds = ['destroyer'];
  else kinds = d._units.slice(0, 4).map(u => MIL_OF[u.k] || 'tank');
  const root = new T.O3();
  root.userData.site = d; root.userData.troop = true; root.userData.mil = true; root.userData.navy = !!d._navy;
  if(!hasPX()) return root;
  const grp = new T.O3();
  /* 隊形:兩兩一排,往東南斜斜地排(鏡頭從南邊看,側面看得到);船一前一後 */
  let maxX = 0, maxY = 0;
  kinds.forEach((k, i) => {
    const dim = MIL_DIM[k] || MIL_DIM.tank;
    const m = new T.Mesh(milGeo(k, side, acc), vmat());
    const col = i % 2, row = Math.floor(i / 2);
    const x = d._navy ? (i ? -dim[0] * .9 : 0) : (col ? -dim[0] * .35 : dim[0] * .35) - row * 4;
    const y = d._navy ? (i ? -9 : 0) : (col ? -4.5 : 4.5) - row * 9;
    m.position.set(x, y, 0);
    m.rotation.z = d._navy ? .15 : -.35;
    if(!d._navy && !d._sea) m.add(milShadow(dim[0], dim[1]));
    grp.add(m);
    maxX = Math.max(maxX, Math.abs(x) + dim[0] / 2); maxY = Math.max(maxY, Math.abs(y) + dim[1] / 2);
  });
  const K = d._navy || d._sea ? .8 : 1.25;          // 參考圖裡的部隊很顯眼:比第一版的立牌大
  grp.scale.setScalar(PXU * K);
  root.add(grp);
  root.userData.vox = grp;
  root.userData.rx = Math.max(maxX, maxY) * K;
  root.userData.key = 'mil:' + side + ':' + kinds.join(',');
  OBJS.add(root);
  return root;
}
W3D._milKinds = () => [...OBJS].filter(o => o.userData.mil).map(o => o.userData.key);

/* 一個據點（或一個對手大本營）的整座小城 */
function buildSite(d){
  if(d._lm){ const r = buildLandmark(d) || new T.O3(); r.visible = !FAR; return r; }
  if(d._units || d._threat){ const r = buildTroop(d); r.visible = !FAR; return r; }
  let key, make;
  if(d._rival){
    const col = `rgb(${rvRGB(d._rival.id)})`;
    const h = d._hk != null ? d._hk : (d._rvk || 0);
    key = `rv:${d._rival.id}:${d._branch ? 'b' : ''}${h.toFixed(2)}`;
    make = B => voxCity(B, [{ sp: PX.rivalTower(h), tint: col }], col);
  }else{
    const blds = (d._blds || []);
    const ground = (d._col && d._col[0] === '#') ? d._col : '#4fc3f7';
    const f = d._feat || null;
    key = `me:${ground}:${blds.map(b => b.c + (b.k || '') + b.f + (b.st || '') + (b.h != null ? '@' + b.h : '')).join(',')}`
        + (f ? `:${f.port ? 'P' : ''}${f.factory ? 'F' : ''}${f.airport ? 'A' : ''}` : '');
    make = B => { const r = voxCity(B, blds.map(b => ({ sp: bldSprite(b) })), ground); cityExtras(B, r.W, r.D, f); };
  }
  const root = voxRoot(d, key, make);
  /* 這個據點的樣子跟上一次不一樣（新蓋的、長高的）→ 播一次「從地上長出來」 */
  const id = d._rival ? 'rv:' + d._rival.id + (d._branch ? ':' + d.id : '') : d.id;
  if(root.userData.vox && SEEN[id] !== key){
    if(SEEN[id] !== undefined || W3D._warm){
      root.userData.grow = performance.now();
      fxAt(d.lat, d.lng, 'dust', { z: 4, dur: .9, life: 1100, alt: .001 });     // 蓋起來的那一刻揚起一陣塵土
    }
    SEEN[id] = key;
  }
  if(root.userData.grow) kick();
  root.visible = !FAR;
  return root;
}

/* 建築的大小跟著鏡頭高度走：拉遠的時候放大，不然整座城只剩一個點；
   貼近的時候縮小，不然一棟樓會蓋掉整座城市。 */
/* 近看要縮小:第一版最小 .55,貼近台灣時一座小城比新竹市還大,半個都站到海裡去了 */
/* 第二版:拉很近的時候模型跟著縮小(下限從 .38 降到 .16)。使用者截圖:貼近台北時台北、新竹、對手大本營、
   地標、部隊全部疊在一起 —— 城市之間的距離在螢幕上會隨拉近變大,模型如果不縮,就永遠擠在一起。 */
const bScale = () => clamp(.06 + W3D.alt * 2.2, .16, 5.5);
function placeSite(obj, d){
  const a = (d._base || .0085) + elevAlt(d.lat, d.lng);        // 站在地形上(山上的城市不能埋進山裡)
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
  const LEAN = obj.userData.mil ? .45 : obj.userData.vox ? .8 : 0, cl = Math.cos(LEAN), sl = Math.sin(LEAN);   // 真 3D 的軍隊只要仰一點
  const ux = nx*cl + qx*sl, uy = ny*cl + qy*sl, uz = nz*cl + qz*sl;     // 新的上 = 往北仰
  const vx = qx*cl - nx*sl, vy = qy*cl - ny*sl, vz = qz*cl - nz*sl;     // 新的北
  M.set(ex, vx, ux, 0,  ey, vy, uy, 0,  ez, vz, uz, 0,  0, 0, 0, 1);
  obj.quaternion.setFromRotationMatrix(M);
  /* 駐在城市裡的部隊站在城市的東南邊一點,不要跟建築疊在一起。
     偏移量是「幾塊地磚寬」,所以要跟著縮放走(見 applyScale)。 */
  obj.userData.at = { x: c.x, y: c.y, z: c.z, e: [ex, ey, ez], q: [qx, qy, qz], slot: d._slot || null, base: a, b0: d._base || .0085 };
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
    obj.userData.rdeg = (obj.userData.rx || 8) * PXU * b / 1.745;          // 佔地半徑(度)
    if(!(obj.userData.at && obj.userData.at.slot) && obj.userData.site && obj.userData.site.id && !obj.userData.troop)
      CENTER_R[obj.userData.site.id] = obj.userData.rdeg;
  }else obj.scale.set(s * 1.6, s * 1.6, s * k);
  const at = obj.userData.at;
  if(at && at.slot){
    /* 城市旁邊的位子:用「度」算、而且在**當下這個距離**檢查是不是陸地。
       第一版的偏移是「幾塊地磚寬」、陸地只在固定的 0.3~0.5 度檢查過 —— 拉遠一點,
       地磚變大、偏移跟著變大,實際站的地方早就不是檢查過的那一點,於是部隊站到海上、
       離城市一大截(使用者:「部隊和建築的定位沒有很精準」)。 */
    /* 距離 = 中間那一棟的半徑 + 自己的半徑(都用實際的體素大小 × 目前的縮放算)再留一點縫 ——
       第一版用固定的 1.6 倍,體素模型變大之後部隊就疊在建築與彼此身上(使用者:「部隊會重疊在一起」)。 */
    const S = at.slot, oR = obj.userData.rdeg || .8 * bScale(), cR = CENTER_R[S.id] || oR;
    const D = Math.max(.05, (cR + oR) * 1.1);
    const L = obj.userData.navy ? seaDirs(S.id, S.lat, S.lng, D) : slotDirs(S.id, S.lat, S.lng, D);
    const [ang, f] = L[S.n % L.length], ring = Math.floor(S.n / L.length);
    const r = D * f * (1 + ring * .8), k = 1 / Math.max(.2, Math.cos(S.lat * Math.PI / 180));
    /* ⚠ 高度要用**實際站的那一點**的地形 —— 第一版用城市中心的高度,台北旁邊就是中央山脈,
       部隊站到山坡上、模型卻還在城市的高度,整台坦克被山埋住(使用者:「坦克卡在下面」)。 */
    const la = S.lat + Math.sin(ang) * r, lo = S.lng + Math.cos(ang) * r * k;
    const c = G.getCoords(la, lo, (at.b0 != null ? at.b0 + Math.max(elevAlt(la, lo), elevAlt(S.lat, S.lng)) : at.base));
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
    if(CHASE){ const r0 = orig(dt); if(chaseCam(cam)){ last.copy(cam.position); return r0; } }   // 火箭追焦中
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
W3D._look = (lat, lng, alt) => { try{ G.controls().autoRotate = false; G.pointOfView({ lat, lng, altitude: alt }, 0); tyWake(); }catch(e){} };   // 給截圖用
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
        if(d._rvf) { TY_RIVAL = d._r.id; TY_DEAL = null; TY_MODAL = 'rival'; renderPage(); }   // 第五十三輪:點對手的駐軍 → 他的對手頁(進攻駐軍的按鈕在那裡)
        else if(d._units){ let c = null; try{ c = G.getScreenCoords(d.lat, d.lng, .002); }catch(e){}
                      unitPop(d, c ? c.x : 100, c ? c.y : 100); }
        else if(d._threat){ if(d._r) { TY_RIVAL = d._r.id; TY_DEAL = null; TY_MODAL = 'rival'; renderPage(); } else { TY_MODAL = 'troop'; renderPage(); } }   // 打過來的部隊 → 派它的人的頁面(空襲鈕在那裡)
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
    spaceInit();
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
/* 方向的偏好:東、西、東南、西南、南,北邊最後 —— 建築往北仰(看得到正面),北邊的東西會被高樓擋住 */
const DIRS = [0, 180, -40, -140, -90, -20, -160, -65, -115, 40, 140, 20, 160, 65, 115, 90].map(a => a * Math.PI / 180);
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
      if(out.some(o => angGap(o[0], a) < 1.0 && Math.abs(o[1] - f) < .3)) continue;   // 57° 以內不放第二個:同樣大小的兩個才不會疊
      out.push([a, f]);
    }
  // 真的全是海(新加坡、香港拉很遠的時候):縮到 0.28 倍,至少不要離城市太遠
  for(const a of DIRS.slice(0, 8)) if(!out.some(o => angGap(o[0], a) < 1.0)) out.push([a, .28]);
  return (SLOT_C[key] = out);
}
/* 海軍的位子:跟 slotDirs 反過來,要**海上**(那個距離與再遠一點都是海)。港口城市一定找得到;
   真的找不到(內陸)就退回城市旁邊。 */
const SEA_C = Object.create(null);
function seaDirs(id, lat, lng, D){
  const b = Math.round(Math.log2(Math.max(.01, D)) * 3);
  const key = id + ':' + b + (W3D.hiFeats ? 'h' : '');
  if(SEA_C[key]) return SEA_C[key];
  const Dq = Math.pow(2, b / 3), k = 1 / Math.max(.2, Math.cos(lat * Math.PI / 180));
  const sea = (a, r) => !W3D.featAt(lat + Math.sin(a) * r, lng + Math.cos(a) * r * k);
  const out = [];
  for(const f of [1, 1.4, 1.9, 2.6])
    for(const a of DIRS){
      if(!sea(a, Dq * f) || !sea(a, Dq * f * 1.3)) continue;
      if(out.some(o => angGap(o[0], a) < 1.0)) continue;
      out.push([a, f]);
    }
  if(!out.length) out.push([DIRS[0], 1]);
  return (SEA_C[key] = out);
}
W3D._seaSlot = (id, lat, lng, D) => seaDirs(id, lat, lng, D);
W3D._objs = () => [...OBJS];     // 給截圖驗證用
W3D._slot = (id, lat, lng, D) => slotDirs(id, lat, lng, D);   // 給測試用

/* 各國首都的小城 —— 使用者:「其他不重要的首都放個超級簡單的小城市建築,不用特別設計」。
   ⚠ 一座一個物件的話是 140 次繪製呼叫:量測手機寬度 fps 15 → 6。所以全部合併成**一個**網格
   (一次繪製),尺寸固定(它們只在拉近時出現 —— 拉遠跟其他 3D 物件一起收起來)。
   有人進駐的首都會從這裡拿掉,改由那個人的建築站在那裡。 */
let MINOR = null, MINOR_KEY = '';
function minorTowns(list){
  const key = list.map(s => s.id).join(',');
  if(key === MINOR_KEY && MINOR && MINOR.parent) return;
  MINOR_KEY = key;
  if(MINOR){ if(MINOR.parent) MINOR.parent.remove(MINOR); MINOR.geometry.dispose(); MINOR = null; }
  const host = patchHost(); if(!host || !list.length || !hasPX()) return;
  const one = VB();
  vbox(one, -4, -3, 0, 4, 4, 5, [206,200,188]); vbox(one, -4, -3, 5, 4, 4, .6, [150,90,70]);
  vbox(one, 1, -3.5, 0, 3, 3, 8, [172,182,196]); vbox(one, 1.5, -3, 8, 2, 2, 1.2, [120,130,146]);
  vbox(one, -3, 2, 0, 6, 3, 3, [214,176,132]); vbox(one, -3, 2, 3, 6, 3, .6, [150,90,70]);
  const U = .075;                                   // 一格 = 幾個地球單位(大約是拉近時地標的大小)
  const np = G.getCoords(90, 0, 0), nl = Math.hypot(np.x, np.y, np.z), N = [np.x / nl, np.y / nl, np.z / nl];
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const nz = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const B = VB();
  for(const st of list){
    const c = G.getCoords(st.lat, st.lng, .0008 + elevAlt(st.lat, st.lng));
    const up = nz([c.x, c.y, c.z]), e = nz(cr(N, up)), n = cr(up, e);
    for(let i = 0; i < one.p.length; i += 3){
      const x = one.p[i] * U, y = one.p[i + 1] * U, z = one.p[i + 2] * U;
      B.p.push(c.x + e[0] * x + n[0] * y + up[0] * z, c.y + e[1] * x + n[1] * y + up[1] * z, c.z + e[2] * x + n[2] * y + up[2] * z);
      const a = one.n[i], b = one.n[i + 1], d = one.n[i + 2];
      B.n.push(e[0] * a + n[0] * b + up[0] * d, e[1] * a + n[1] * b + up[1] * d, e[2] * a + n[2] * b + up[2] * d);
      B.c.push(one.c[i], one.c[i + 1], one.c[i + 2]);
    }
  }
  MINOR = new T.Mesh(vgeo(B), vmat());
  MINOR.visible = !FAR;
  host.add(MINOR);
}
W3D._minorMesh = () => MINOR;                 // 給測試 / 量測用
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
    if(st && d._navy){ o._slot = take(st.id + ':sea', st.lat, st.lng); o._slot.id = st.id; o._sea = false; }   // 海軍:港外的海上
    else if(st){ o._slot = take(st.id, st.lat, st.lng); o._sea = false; }   // 駐紮 / 下季到位:城市旁邊的陸地上
    else o._sea = !W3D.featAt(d.lat, d.lng);
    return o;
  });
  TROOPS = tr;
  /* 地標:每一座城市都有。正中央空著就站中央,不然也去拿一個陸地上的空位。 */
  /* 地標只畫在「沒有人的城市」:你或對手已經在那裡蓋了東西,地標就收進城市全景(連點兩下看得到),不要再多擠一棟 */
  // 小國首都(minor):合併成一個網格的簡單小城(minorTowns),名字只在拉近時出現
  minorTowns((typeof TY_SITES !== 'undefined' ? TY_SITES : []).filter(st => st.minor && !center.has(st.id)));
  const lms = (typeof TY_SITES !== 'undefined' ? TY_SITES : []).filter(st => !center.has(st.id) && !st.minor).map(st => ({
    id: st.id, lat: st.lat, lng: st.lng, iso: st.iso, _lm: true, _minor: !!st.minor, _k: 'lm:' + st.id, _base: .0008,
    _slot: center.has(st.id) ? take(st.id, st.lat, st.lng) : null }));
  G.customLayerData([...mine, ...rivals, ...tr, ...lms]);
  tagsOn();
  buildRoutes(tr);
  pushPaths();
  armHover();
  W3D._warm = true;           // 第一批是開局就有的，不要全部從地上長出來
  setTimeout(rescaleAll, 0);  // 中間那一棟的大小要先量到,旁邊的東西才知道要讓多遠
  W3D.rings();
};

/* 部隊棋子上方的小標籤(「⚖👔 ×2」「2季」)。棋子會跟著鏡頭縮放、位置會偏移,
   所以標籤不能掛在 globe.gl 的 HTML 層(那一層只吃經緯度)—— 這裡每一幀
   直接把棋子的 3D 位置投影到螢幕上。沒有部隊的時候這個迴圈不跑。 */
let TROOPS = [], TAGS = null, tagLoop = false;
/* 手機中距離的精簡版(使用者:「每個單位只要顯示國旗就好,有重複就兩個圖案:國旗跟另一個圖案」):
   一支 → 只有國旗;兩支以上 → 國旗 + 第一種兵的圖示與數量。完整內容在 .tg-more,由 CSS 依縮放切換 */
const tag2 = units => { const n = (units || []).length; return n > 1 ? `<span class="tg-2">${TY_UNITS[units[0].k].ic}<b>${n}</b></span>` : ''; };
/* 標籤前面一面像素國旗(參考圖裡每一台車旁邊都有):你的是大本營所在國、對手的是他大本營所在國 */
const tagFlag = site => { try{ const s = tySite(site); return s && PX.flagHTML ? PX.flagHTML(s.iso) : ''; }catch(e){ return ''; } };
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
      // 同一國可能有兩個對手(同一面國旗):靠他的顏色 + 頭像 + 名字第一個字分
      el.innerHTML = `${tagFlag(d._r.home)}<span class="tg-more"><u class="tg-who" style="--rc:rgb(${(typeof TY_RVCOL !== 'undefined' && TY_RVCOL[d._r.id]) || '255,69,58'})">${d._r.ic || '⚔'}${escH([...d._r.nm][0] || '')}</u>${d._units.map(u => TY_UNITS[u.k].ic).join('')}</span>${tag2(d._units)}`;
      el.title = `${d._r.nm}在${TY_REGIONS[d._rvf.reg].nm}的駐軍(勢力 ${d._rvf.v.toFixed(0)})`;
    }else if(d._threat){
      el.style.setProperty('--rc', `rgb(${(typeof TY_RVCOL !== 'undefined' && TY_RVCOL[d._r.id]) || '255,69,58'})`);
      el.innerHTML = `${d._r.ic || '⚔'} <b>${Math.max(0, d._threat.eta - TY.t)}季</b>`;
      el.title = `${d._r.nm}的併購小組 → ${tySite(d._threat.site).nm}`;
    }else{
      // 同一種兵只畫一個圖示,後面標總數;下一季才到的標「+N」
      const ics = [...new Set(d._units.map(u => TY_UNITS[u.k].ic))].slice(0, 3).join('');
      const n = d._units.length, inc = d._in || 0;
      el.style.setProperty('--rc', 'rgb(47,143,224)');
      el.classList.add('me');
      el.innerHTML = `${tagFlag(TY.home)}<span class="tg-more"><u class="tg-who me">你</u>${ics}${n > 1 ? ` <b>×${n}</b>` : ''}${inc ? ` <i class="inc">+${inc}</i>` : ''}</span>${tag2(d._units)}`;
      el.title = d._units.map(u => TY_UNITS[u.k].nm + (u.to ? ` → ${tySite(u.to).nm}` : '')).join('、');
    }
    if(d._rvf) el.onclick = () => { TY_RIVAL = d._r.id; TY_DEAL = null; TY_MODAL = 'rival'; renderPage(); };
    else if(d._threat) el.onclick = () => { if(d._r) { TY_RIVAL = d._r.id; TY_DEAL = null; TY_MODAL = 'rival'; renderPage(); } else { TY_MODAL = 'troop'; renderPage(); } };
    else armTagDrag(el, d);
    el._d = d;
    TAGS.appendChild(el);
  }
  if(TROOPS.length && !tagLoop){ tagLoop = true; requestAnimationFrame(tagStep); }
}
/* 城市名牌的位置(globe.gl 的 HTML 圖層)。量版面很貴,所以 250ms 才量一次 */
/* 一個 3D 物件在螢幕上的「半徑」(像素):佔地半徑 × 目前的縮放,投影到畫面上量出來。
   名牌與部隊標籤要掛在模型**底下**,不能蓋在模型身上(使用者:「牌子跟圖案不要擋到立體的建築」)。 */
let RIGHT = null, PA = null, PB = null;
function screenR(o, cam, w, h){
  if(!o.visible || !o.parent) return 0;
  const V3 = o.position.constructor;
  RIGHT = RIGHT || new V3(); PA = PA || new V3(); PB = PB || new V3();
  RIGHT.setFromMatrixColumn(cam.matrixWorld, 0);
  o.getWorldPosition(PA);
  const L = (o.userData.rx || 8) * PXU * o.scale.x;
  PB.copy(PA).addScaledVector(RIGHT, L);
  PA.project(cam); PB.project(cam);
  return Math.hypot((PB.x - PA.x) / 2 * w, (PB.y - PA.y) / 2 * h);
}
/* 城市名牌互相讓位 —— 使用者截圖:台北、新竹、對手名字疊在一起,「台北的字很擠」。
   地圖軟體的做法:名牌重疊時,比較不重要的那一個先藏起來(拉近、分開了自然又出現)。
   重要度:你的城市(越值錢越前面)> 對手大本營 > 還沒進場的城市。每 300ms 量一次,只動 class,不動位置。 */
setInterval(() => {
  if(!W3D.ok || document.hidden) return;
  const host = document.getElementById('tyGlobeHost'); if(!host) return;
  const els = [...host.querySelectorAll('.tyk')];
  if(!els.length) return;
  // 先把名牌往下推到模型底下(每座城:中間那一棟的螢幕半徑)
  const DY = Object.create(null);
  if(!FAR){ try{
    const cam = G.camera(), cv = G.renderer().domElement, w = cv.clientWidth, h = cv.clientHeight;
    for(const o of OBJS){
      if(o.userData.troop || o.userData.lm || (o.userData.at && o.userData.at.slot)) continue;
      const id = o.userData.site && o.userData.site.id; if(!id) continue;
      DY[id] = Math.max(DY[id] || 0, screenR(o, cam, w, h));
    }
  }catch(e){} }
  for(const e of els){
    const dy = Math.round(Math.min(90, (DY[e.dataset.id] || 0) * .55)) + 'px';
    if(e.style.getPropertyValue('--dy') !== dy) e.style.setProperty('--dy', dy);
  }
  const rank = e => e.classList.contains('idle') ? 0 : e.classList.contains('rv') ? 1e15 : 1e18 + (+e.dataset.v || 0);
  els.sort((a, b) => rank(b) - rank(a));
  const keep = [];
  for(const e of els){
    const r = (e.querySelector('.k-n') || e).getBoundingClientRect();      // 外框是 0×0 的定位點,量字那一塊
    if(!(r.width > 0 && r.height > 0)){ e.classList.remove('cull'); continue; }
    const hit = keep.some(k => r.left < k.right - 3 && r.right > k.left + 3 && r.top < k.bottom - 2 && r.bottom > k.top + 2);
    if(e.classList.contains('cull') !== hit) e.classList.toggle('cull', hit);
    if(!hit) keep.push(r);
  }
}, 300);
let OBST = [], obstT = 0;
function obstacles(){
  const now = performance.now();
  if(now - obstT < 250) return OBST;
  obstT = now;
  const host = document.getElementById('tyGlobeHost'); if(!host){ OBST = []; return OBST; }
  const hr = host.getBoundingClientRect();
  OBST = [];
  for(const e of host.querySelectorAll('.tyk:not(.cull)')){
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
    const sx = (V.x + 1) / 2 * w, sy0 = (1 - V.y) / 2 * h;
    // 掛在模型的底下,不蓋住模型(每 10 幀量一次螢幕半徑就夠)
    if(!o._rT || ++o._rT > 10){ o._rT = 1; o._sr = screenR(o, cam, w, h); }
    const sy = sy0 + Math.min(80, (o._sr || 0) * .6);
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
  if(kind === 'plane' || kind === 'missile' || kind === 'jet' || kind === 'recon'){ legPts(a, b, kind, pts); return pts; }
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
  /* 地面與海上的載具換成跟駐軍同一套 3D 模型(卡車段是軍卡或坦克、海上是驅逐艦或航母) */
  const mk3 = k === 'truck' ? 'truck' : k === 'ship' ? 'destroyer' : MIL_DIM[k] ? k : null;
  if(mk3){
    const acc = tint ? (tint.match(/\d+/g) || []).slice(0, 3).map(Number) : hexRGB(TEAM);
    const m = new T.Mesh(milGeo(mk3, tint ? 'foe' : 'me', acc), vmat());
    m.renderOrder = 3; m.userData.vpx = VPX;
    h.add(m); return m;
  }
  const sp = PX.SPR[k] || PX.SPR.truck;
  const dep = k === 'ship' ? 4 : k === 'plane' ? 3 : 2;
  if(k === 'reconTop') tint = tint || TEAM;
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
               done: opt.done, onPass: opt.onPass, passAt: opt.passAt, passed: false,
               trail: opt.trail || null, tr: opt.trail ? [] : null, tag: opt.tag || '', unit: opt.unit || '' });
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
    else if(a.kind === 'recon') e = smooth(clamp(u / .12, 0, 1));           // 偵察機:爬升後一直待在空中繞圈
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
    let mk = a.kind === 'jet' ? 'jet' : a.kind === 'missile' ? 'missile' : a.kind === 'bomb' ? 'bomb' : a.kind === 'plane' ? 'plane' : a.kind === 'recon' ? 'reconTop' : P.mode;
    if(a.unit === 'navy' && (mk === 'truck' || mk === 'ship' || mk === 'dock')) mk = 'carrier';        // 航母一路都是航母
    else if(a.unit === 'raid' && mk === 'truck') mk = 'tank';                                          // 坦克營在陸上是坦克
    if(mk !== a.mk){ if(a.mesh && a.mesh.parent) a.mesh.parent.remove(a.mesh); a.mesh = spawnVeh(mk, a.tag ? `rgb(${rvRGB(a.tag)})` : null); a.mk = mk; }
    if(a.mesh){
      const p = G.getCoords(P.lat, P.lng, P.alt);
      let q = G.getCoords(Q.lat, Q.lng, Q.alt);
      if(u >= .994 && a._p){ q = { x: p.x*2 - a._p.x, y: p.y*2 - a._p.y, z: p.z*2 - a._p.z }; }
      if(a.kind === 'bomb') q = G.getCoords(P.lat, P.lng, P.alt - .01);  // 炸彈頭朝下
      orient(a.mesh, p, q); a._p = p;
      // 載具要比建築顯眼 —— 它們是這一刻畫面上的主角(第一版跟地標一樣大,遠看根本找不到)
      const s = bScale() * (mk === 'missile' ? 3.6 : mk === 'carrier' ? 1.8 : mk === 'tank' ? 2.2 : mk === 'ship' ? 3.2 : mk === 'plane' || mk === 'reconTop' ? 3.2 : mk === 'jet' ? 3 : mk === 'bomb' ? 2.6 : 2.4);
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
const sfx = (snd, buzz) => { try{ if(typeof SFX !== 'undefined') SFX.fx(snd, buzz); }catch(e){} };
/* 撞擊感:整個地圖往內縮一下再彈回(兩格),大爆炸再加一格白色閃屏 */
function impact(big){
  const host = document.getElementById('tyGlobeHost'); if(!host || reduced()) return;
  host.classList.remove('w3d-impact', 'w3d-impact2'); void host.offsetWidth;
  host.classList.add(big ? 'w3d-impact2' : 'w3d-impact');
  clearTimeout(impact._t); impact._t = setTimeout(() => host.classList.remove('w3d-impact', 'w3d-impact2'), 400);
}
W3D.impact = impact;
function boom(lat, lng, big){
  shake(big);
  if(big) impact(true);
  sfx(big ? 'boomBig' : 'boom', big ? 'boomBig' : 'boom');
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
/* 部隊抵達目標城市的攻擊動畫 —— 使用者:「部隊到目標城市的時候可以有攻擊動畫」。
   目標城市有對手(大本營、駐軍、正往那裡打的部隊)→ 真的開打:
     坦克營 / 航母:一輪砲擊(砲口閃光 → 對面爆炸,一左一右輪流)· 火炮陣地:齊射、落點散開、最後一發大的
     步兵連 / 補給車隊:短短的槍火與幾發小爆炸
   沒有對手的城市 → 進駐:插旗的閃光 + 星星。
   只是畫面(Math.random,不碰種子亂數),打完什麼數字都不會變 —— 規則上的攻防在下一季結算。 */
function attackAt(B, k, opt){
  if(!B) return;
  // 鏡頭先轉到目標城市(長途飛行時它常常在畫面邊緣,打起來看不到)—— 即時制(opt.noCam)不搶鏡頭
  try{ if(!(opt && opt.noCam) && !CHASE && !CV.on && !PV.on){ G.controls().autoRotate = false; G.pointOfView({ lat: B.lat - 1.5, lng: B.lng, altitude: clamp(W3D.alt || .6, .35, .7) }, 500); tyWake(); } }catch(e){}
  let foe = false;
  try{
    foe = tyRivalsA().some(r => r.home === B.id) || tyRivalForces().some(f => f.site === B.id) || tyThreats().some(t => t.site === B.id);
  }catch(e){}
  const at = (dLat, dLng, fn, ms) => setTimeout(() => fn(B.lat + dLat, B.lng + dLng), ms + 300);   // 等鏡頭轉過去
  const rnd = Math.random, j = s => (rnd() - .5) * s;
  /* 第二版:使用者「部隊到目的地的時候沒有攻擊動畫」—— 沒有對手的城市也要打:攻擊部隊(坦克、火炮、航母)
     一樣開火(掃蕩、佔領),只是少一點、最後沒有大爆炸;步兵與補給是槍火。 */
  setTimeout(() => floatAt(fxLayer(), B.lat, B.lng, foe ? `⚔ 進攻 ${escH(B.nm)}` : `⚔ 掃蕩 · 佔領 ${escH(B.nm)}`, 'enemy', 0), 550);
  if(k === 'lobby'){                                    // 火炮:齊射
    for(let i = 0; i < 6; i++) at(j(.9), j(.9), (la, lo) => { fxAt(la, lo, 'boom', { z: 3, dur: .6, life: 900, alt: .002 }); sfx('boom'); if(i % 2) shake(false); }, 500 + i * 180 + rnd() * 80);
    at(0, 0, (la, lo) => foe ? boom(la, lo, true) : fxAt(la, lo, 'boomBig', { z: 3, dur: .8, life: 1200, alt: .002 }), 1900);
  }else if(k === 'raid' || k === 'navy'){               // 坦克 / 航母:砲口閃光 → 對面爆炸,輪流
    const n = k === 'navy' ? 5 : 4;
    for(let i = 0; i < n; i++){
      const side = i % 2 ? 1 : -1;
      at(.25 * side, -.35, (la, lo) => { fxAt(la, lo, 'flash', { z: 3, dur: .25, life: 400, alt: .002 }); sfx('hit'); }, 450 + i * 330);
      at(j(.5), .15 + j(.4), (la, lo) => { fxAt(la, lo, 'boom', { z: 3, dur: .6, life: 1000, alt: .002 }); sfx('boom'); shake(false); }, 650 + i * 330);
    }
    at(0, 0, (la, lo) => boom(la, lo, foe && k === 'navy'), 850 + n * 330);
  }else{                                                // 步兵 / 補給:槍火 + 小爆炸
    for(let i = 0; i < 6; i++) at(j(.4), j(.4), (la, lo) => { fxAt(la, lo, 'flash', { z: 2, dur: .2, life: 300, alt: .0015 }); sfx('hit'); }, 400 + i * 120);
    for(let i = 0; i < 2; i++) at(j(.5), j(.5), (la, lo) => { fxAt(la, lo, 'boom', { z: 2, dur: .5, life: 800, alt: .002 }); sfx('boom'); }, 900 + i * 260);
  }
}
W3D._attack = (id, k) => attackAt(tySite(id), k);     // 給截圖驗證用
W3D.attackAt = (id, k, opt) => attackAt(tySite(id), k, opt);

/* 小一號的像素特效:蓋房子的塵土、出牌落地的星星與金幣(出牌回饋用) */
function fxAt(lat, lng, kind, opt){
  if(!hasPX() || !PX.fxEl) return;
  const e = PX.fxEl(kind, opt); if(e) anchorFx(e, lat, lng, (opt && opt.alt) || .002, (opt && opt.life) || 1600);
}
W3D.fxAt = fxAt;
/* 一座城市在螢幕上的位置(client 座標);在球的背面回傳 null */
/* 任意經緯度 → 螢幕座標(背面回 null)。即時制的行軍標記用 */
W3D.screenOfLL = function(lat, lng){
  if(!W3D.ok || !G) return null;
  const host = document.getElementById('tyGlobeHost'); if(!host) return null;
  try{
    const c = G.getScreenCoords(lat, lng, .004), cam = G.camera().position, q = G.getCoords(lat, lng, 0);
    if(q.x*cam.x + q.y*cam.y + q.z*cam.z <= R*R*1.001) return null;
    const r = host.getBoundingClientRect();
    return { x: r.left + c.x, y: r.top + c.y };
  }catch(e){ return null; }
};
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
  shake(false); impact(false);
  sfx('drop', 'land');
  const extra = { build: 'build', shell: 'build', upgrade: 'upgrade', invest: 'coin', sell: 'coin', deal: 'deal', partner: 'deal', troop: 'unit', move: 'build' }[k];
  if(extra) setTimeout(() => sfx(extra), 90);
  if(k === 'upgrade'){                                      // 升級:往上噴的金色箭頭
    for(let i = 0; i < 4; i++) fxAt(lat, lng, 'star', { z: 4, cls: 'fly', delay: 80 + i * 90, life: 1400,
      css: `--dx:${((i - 1.5) * 14).toFixed(0)}px;--dy:-90px;--dur:1s;` });
  }
  if(k === 'troop' || k === 'move' || k === 'partner') fxAt(lat, lng, 'dust', { z: 3, dur: .7, life: 900, alt: .001 });
  if(label){ const fx = fxLayer(); if(fx) floatAt(fx, lat, lng, label, 'card', 120); }
};
/* 開演之前鏡頭先飛過去:起點與終點都要在畫面裡 */
function focusOn(A, B, cb){
  FOLLOW = null;                                  // 地球上的動畫要看地球:取消太空鏡頭鎖定
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
/* 還在飛機 / 船上的部隊。使用者:「要先搭飛機才會抵達,你剛剛是先抵達再搭飛機」——
   規則上派出去的部隊下一季到位、地圖畫在目的地;但出發動畫播的時候,目的地不能已經站著它。
   所以在這個集合裡的部隊,地圖上先不畫(index.html 的 tyTroopMarks 會跳過),落地那一刻才出現。
   純畫面狀態,不進存檔、不影響規則。 */
const FLYING = new Set();
W3D.flying = id => FLYING.has(id);
const landed = id => {
  if(!FLYING.delete(id)) return;
  try{ if(typeof tyGlobeData === 'function') tyGlobeData(); }catch(e){}
};
W3D.animMove = function(m){
  if(!W3D.ok || !m) return;
  const A = tySite(m.from), B = tySite(m.to);
  if(m.id != null){
    FLYING.add(m.id);
    setTimeout(() => landed(m.id), 30000);          // 保險:動畫被切掉(分頁藏起來)也不會永遠不見
    try{ if(typeof tyGlobeData === 'function') tyGlobeData(); }catch(e){}
  }
  const km = kmLL([A.lat, A.lng], [B.lat, B.lng]);
  // 一次派好幾支(拉線勾了三支):一支一支錯開出發,不要疊成同一架飛機
  const now = performance.now();
  if(now - moveBurst.t > 400) moveBurst.n = 0;
  moveBurst.t = now; const lag = moveBurst.n++ * 900;
  focusOn(A, B, () => setTimeout(() => {
    const land = () => { landed(m.id); floatAt(fxLayer(), B.lat, B.lng, `${TY_UNITS[m.k].ic} 抵達 ${escH(B.nm)}`, 'rv', 0); sfx('hit', 'tap'); fxAt(B.lat, B.lng, 'dust', { z: 3, dur: .7, life: 900, alt: .001 });
      attackAt(B, m.k); };
    sfx(m.k === 'raid' || m.k === 'navy' ? 'unit' : 'jet');
    if(m.k === 'raid' || m.k === 'navy'){
      const pts = routeFor('ground', A, B);
      const sea = pts.filter(p => p.mode === 'ship').length;
      fly({ kind: 'ground', pts, unit: m.k, dur: sea ? clamp(9000 + km * .55, 9000, 18000) : clamp(4500 + km * .55, 5000, 12000),
            trail: sea ? { col: ['rgba(255,255,255,0)', 'rgba(220,240,255,.8)'], w: 1.6, max: 90 } : null, done: land });
    }else{
      fly({ kind: 'plane', from: A, to: B, arc: clamp(km / 9000 * .1, .018, .09), dur: clamp(4000 + km * .5, 5000, 10000),
            trail: { col: ['rgba(255,255,255,0)', 'rgba(255,255,255,.75)'], w: 1.1, max: 70 }, done: land });
    }
  }, lag));
};
/* 偵察機:飛到目標上空繞一圈(掃描光圈 + 星星),再飛離;done 在繞完之後呼叫 */
W3D.animRecon = function(m, done){
  if(!W3D.ok || !m){ if(done) done(); return; }
  const A = tySite(m.from), B = tySite(m.to);
  const km = kmLL([A.lat, A.lng], [B.lat, B.lng]);
  focusOn(A, B, () => {
    sfx('jet', 'tap');
    const pts = routeFor('recon', A, B);
    const r = clamp(km / 9000, .8, 2.2), k = 1 / Math.max(.2, Math.cos(B.lat * Math.PI / 180));
    for(let i = 1; i <= 24; i++){ const a = -Math.PI / 2 + i / 24 * Math.PI * 2;
      pts.push({ lat: B.lat + Math.sin(a) * r - r, lng: B.lng + Math.cos(a) * r * k, mode: 'recon' }); }
    fly({ kind: 'recon', pts, arc: clamp(km / 9000 * .1, .03, .09), dur: clamp(5000 + km * .35, 6000, 10000),
          trail: { col: ['rgba(255,255,255,0)', 'rgba(160,230,255,.7)'], w: 1, max: 80 },
          passAt: .7, onPass: () => { fxAt(B.lat, B.lng, 'ring', { z: 5, dur: .7, life: 1000 }); fxAt(B.lat, B.lng, 'ring', { z: 4, dur: .7, delay: 250, life: 1200 });
            sfx('coin'); const fx = fxLayer(); if(fx) floatAt(fx, B.lat, B.lng, '🛩 偵察完成 · 情報到手', 'card', 0); },
          done: () => { if(done) done(); } });
  });
};
/* 打擊:飛彈從大本營拋過去;空襲是三架戰機編隊,飛過目標上空一路投彈 */
/* 打擊的效果寫在地圖上(第四十輪:「要有一些顯示效果的動畫」)——
   命中的那一刻,目標上方浮出一行字(−12 勢力、攻擊力 ×0.4…),往上飄、淡出 */
function floatText(B, txt, cls){
  const host = document.getElementById('tyGlobeHost'); if(!host || !B) return;
  const p = W3D.screenOfLL(B.lat, B.lng); if(!p) return;
  const r = host.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'w3d-pop ' + (cls || '');         // ⚠ 不能叫 w3d-float:那是季末重播在用的 class(樣式與清除都會撞)
  el.innerHTML = txt;
  el.style.left = (p.x - r.left) + 'px'; el.style.top = (p.y - r.top) + 'px';
  host.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}
W3D.floatText = (id, txt, cls) => { if(typeof tySite === 'function') floatText(tySite(id), txt, cls); };
W3D.animStrike = function(s){
  if(!W3D.ok || !s) return;
  const A = tySite(s.from), B = tySite(s.to);
  const km = kmLL([A.lat, A.lng], [B.lat, B.lng]);
  focusOn(A, B, () => {
    sfx(s.k === 'missile' ? 'launch' : 'jet', 'tap');
    if(s.k === 'missile'){
      fly({ kind: 'missile', from: A, to: B, arc: clamp(km / 6000 * .25, .06, .36), dur: clamp(3500 + km * .3, 4000, 7000),
            trail: { col: ['rgba(200,200,200,0)', 'rgba(255,190,120,.95)'], w: 2.4 },
            done: () => { boom(B.lat, B.lng, true); setTimeout(() => boom(B.lat + .08, B.lng - .1, false), 260); if(s.fx) floatText(B, s.fx, s.fxc); } });
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
                  arc: 0, dur: 700, done: () => { boom(lat, lng, false); if(s.fx && i === 2 && j === 0) floatText(B, s.fx, s.fxc); } });
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
  const where = `${tySite(here).nm} · ${units.length - inc} 支駐紮${inc ? ` · ${inc} 支在路上` : ''}`;
  const O = (typeof TY_UORD !== 'undefined') ? TY_UORD : { ord:'attack', mode:'seq' };
  const seg = (k, v, lab) => `<button type="button" class="sg${O[k] === v ? ' on' : ''}" data-k="${k}" data-v="${v}">${lab}</button>`;
  UPOP.innerHTML = `<div class="up-h"><b>${units.length} 支部隊</b><em>${escH(where)}</em><button type="button" class="x">✕</button></div>`
    + units.map(u => { const a = typeof tyArmyOf === 'function' && tyArmyOf(u);
        return `<label><input type="checkbox" checked data-u="${u.id}"> ${TY_UNITS[u.k].ic} ${escH(TY_UNITS[u.k].nm)}${a ? ` <i class="ar">🎖${escH(a.nm)}</i>` : ''}</label>`; }).join('')
    + `<div class="up-o">到了 ${seg('ord', 'attack', '⚔ 進攻')}${seg('ord', 'hold', '🛡 駐紮')}</div>`
    + (O.ord === 'attack' && units.length > 1 ? `<div class="up-o">多支 ${seg('mode', 'seq', '到了就打')}${seg('mode', 'mass', '到齊再打')}</div>` : '')
    + `<div class="up-b"><button type="button" class="go">🎯 拉線派遣</button><button type="button" class="pn">指揮中心</button></div>`
    + `<div class="up-n">也可以直接從部隊標籤拖一條線到城市</div>`;
  UPOP.querySelectorAll('.sg').forEach(b => b.onclick = () => {
    if(typeof TY_UORD !== 'undefined') TY_UORD[b.dataset.k] = b.dataset.v;
    const off = [...UPOP.querySelectorAll('input:not(:checked)')].map(i => i.dataset.u);   // 重畫之後保留沒勾的
    unitPop(d, x, y);
    for(const id of off){ const i = UPOP.querySelector(`input[data-u="${id}"]`); if(i) i.checked = false; }
  });
  UPOP.style.display = '';
  const w = host.clientWidth;
  UPOP.style.transform = `translate(${Math.min(w - 230, Math.max(6, x - 100))}px,${Math.max(6, y + 18)}px)`;
  UPOP.querySelector('.x').onclick = () => { UPOP.style.display = 'none'; };
  UPOP.querySelector('.pn').onclick = () => {
    UPOP.style.display = 'none';
    if(typeof TY_USEL !== 'undefined'){ TY_USEL.clear(); for(const i of UPOP.querySelectorAll('input:checked')) TY_USEL.add(+i.dataset.u); }
    TY_MODAL = 'troop'; renderPage();
  };
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
  // 太空視角(看月球、火星):地面上的標籤全部收起來,只留星球
  const hs = document.getElementById('tyGlobeHost');
  if(hs){ const sp = W3D.alt > 4.5 ? '1' : ''; if(hs.dataset.space !== sp) hs.dataset.space = sp; }
  if(far === FAR) return;
  FAR = far;
  const host = document.getElementById('tyGlobeHost');
  if(host) host.dataset.far = far ? '1' : '';
  for(const o of OBJS) o.visible = !far;
  if(MINOR) MINOR.visible = !far;
}
W3D.far = () => !!FAR;

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


/* =============================================================================
   城市全景 —— 使用者:「連續點兩下一個城市,整個畫面都是這個地區,把裡面所有的建設立體列出來。
   建設依照它是哪一種,像城市裡的建築一樣排列;要有道路、鐵路、行人。」
   -----------------------------------------------------------------------------
   另開一個小的 3D 場景(自己的畫布、自己的鏡頭),不動地球那一個:
     · 建構子一樣從 globe.gl 身上撿(Scene / 鏡頭 / 渲染器 / 燈光),不另外載 three.js
     · 3×3 個街區、中間是道路(黃色虛線)與人行道,北邊一條鐵路,火車來回跑
     · 每一種東西一個區:中央商業區(事業)、西邊金融區、東邊住宅區(大富翁的房子/旅館)、
       南邊你的駐軍、北邊地標公園、東北角對手的地盤;空的街區是公園(樹)
     · 行人沿著人行道繞街區走、車子在路上跑 —— 只是畫面,不碰遊戲狀態、不用種子亂數
     · 用低解析度渲染再放大(image-rendering: pixelated),整個畫面是一顆一顆的像素
   資料由 index.html 的 tyCityData() 整理好傳進來,這裡只負責畫。
   ============================================================================= */
const CV = { on: false };
W3D.cityOn = () => CV.on;
/* 任意長方體(體素的「一塊」):車子、樹、行人、鐵軌都是它 */
function vbox(B, x0, y0, z0, w, d, h, rgb){
  const x1 = x0 + w, y1 = y0 + d, z1 = z0 + h;
  vquad(B, [x0,y0,z1], [x1,y0,z1], [x1,y1,z1], [x0,y1,z1], [0,0,1], rgb, 1.08);
  vquad(B, [x0,y0,z0], [x1,y0,z0], [x1,y0,z1], [x0,y0,z1], [0,-1,0], rgb, .82);
  vquad(B, [x1,y0,z0], [x1,y1,z0], [x1,y1,z1], [x1,y0,z1], [1,0,0], rgb, .9);
  vquad(B, [x0,y1,z0], [x0,y0,z0], [x0,y0,z1], [x0,y1,z1], [-1,0,0], rgb, .72);
  vquad(B, [x1,y1,z0], [x0,y1,z0], [x0,y1,z1], [x1,y1,z1], [0,1,0], rgb, .66);
}
/* 固定的「亂數」:同一座城每次打開長得一樣,也不吃遊戲的種子 */
function hrand(seed){ let s = 0; for(const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  return () => { s = (s * 1103515245 + 12345) >>> 0; return (s >>> 8) / 16777216; }; }
const CVC = {
  grass: [86,150,72], grass2: [70,128,60], road: [58,63,74], dash: [255,216,74], walk: [176,182,194],
  ballast: [120,104,92], sleeper: [94,59,28], rail: [206,212,222], plat: [150,156,168],
  trunk: [110,72,40], leaf: [60,150,70], leaf2: [44,118,58], skin: [240,199,154],
};
const ZONE_LOT = { biz: [150,130,190], fin: [120,150,200], estate: [140,190,120], army: [120,140,100],
                   lm: [170,190,150], rival: [180,140,140], park: [96,168,80], ind: [160,150,130] };
/* 格局:3×3 街區,(列, 行) 由西往東、由南往北(鏡頭在南邊) */
const BLK = 20, RD = 5, SPAN = 3 * BLK + 4 * RD, HALF = SPAN / 2;
const blkX = i => -HALF + RD + i * (BLK + RD);
const ZONE_AT = { biz: [1, 1], fin: [0, 1], estate: [2, 1], army: [1, 0], lm: [1, 2], rival: [2, 2], ind: [0, 2] };

function cvItemSprite(it){
  if(it.t === 'bld') return { sp: bldSprite(it.b) };
  if(it.t === 'unit'){ const k = MIL_OF[it.k] || 'tank', dm = MIL_DIM[k];     // 城市全景裡也是 3D 軍隊模型
    return { mil: k, side: it.col ? 'foe' : 'me', acc: it.col ? it.col.split(',').map(Number) : hexRGB(TEAM), sp: { w: dm[0], h: dm[2] }, dep: dm[1] }; }
  if(it.t === 'hq') return { sp: PX.rivalTower(it.h || 0), tint: `rgb(${it.col})` };
  if(it.t === 'lm'){ const L = LANDMARK[it.id]; return { sp: (L && PX.LMS[L[0]]) || PX.LMS.skyline, dep: 10 }; }
  if(it.t === 'flag') return { sp: PX.SPR.flag, tint: it.col ? `rgb(${it.col})` : TEAM, dep: 1 };
  return { sp: PX.SPR.shell };
}

W3D.cityOpen = function(host, data){
  W3D.cityClose();
  if(!W3D.ok || !G || !T || !hasPX() || !host) return false;
  let rd, scene, cam;
  try{
    const RC = G.renderer().constructor, SC = G.scene().constructor, CC = G.camera().constructor;
    rd = new RC({ antialias: false, alpha: true, powerPreference: 'low-power', preserveDrawingBuffer: !!W3D._fxHold });
    const gr = G.renderer();
    if('outputColorSpace' in gr) rd.outputColorSpace = gr.outputColorSpace;
    if('outputEncoding' in gr) rd.outputEncoding = gr.outputEncoding;
    scene = new SC();
    cam = new CC(38, 1, .5, 2000);
    cam.up.set(0, 0, 1);
    // 燈光:照抄地球那一組的種類與強度(不同版本的 three 強度單位不一樣,抄過來最保險)
    let L = [];
    try{ L = G.lights() || []; }catch(e){}
    if(!L.length) G.scene().traverse(o => { if(o.isLight) L.push(o); });
    for(const l of L){
      const n = new l.constructor();
      n.color && l.color && n.color.copy(l.color);
      n.intensity = l.intensity * (l.isAmbientLight ? 1.15 : 1);
      if(n.position && !l.isAmbientLight) n.position.set(-40, -70, 110);
      scene.add(n);
    }
  }catch(e){ try{ rd && rd.dispose(); }catch(_){} return false; }

  const geos = [];
  const mat = new T.Phong({ vertexColors: true, shininess: 4, side: 2 });
  mat.emissive && mat.emissive.set('#1e2630');
  const mesh = (B, parent) => { const g = vgeo(B); geos.push(g); const m = new T.Mesh(g, mat); (parent || scene).add(m); return m; };
  const rnd = hrand(data.id);
  const used = new Set(Object.values(data.zones || {}).length ? Object.keys(data.zones).filter(k => (data.zones[k] || []).length) : []);
  if(data.lm) used.add('lm');

  /* ---- 地面、道路、人行道、鐵路(全部併成一個網格) ---- */
  const G0 = VB();
  vbox(G0, -HALF - 8, -HALF - 8, -3, SPAN + 16, SPAN + 22, 3, CVC.grass2);
  for(let i = 0; i < 4; i++){
    const x = -HALF + i * (BLK + RD);
    vbox(G0, x, -HALF, 0, RD, SPAN, .25, CVC.road);          // 南北向
    vbox(G0, -HALF, x, 0, SPAN, RD, .26, CVC.road);          // 東西向
    for(let k = 0; k < 3; k++){                                // 虛線:只畫在兩個路口之間
      const a = blkX(k);
      for(let s = a + 1.5; s < a + BLK - 1; s += 4){
        vbox(G0, x + RD / 2 - .2, s, .25, .4, 2, .06, CVC.dash);
        vbox(G0, s, x + RD / 2 - .2, .26, 2, .4, .06, CVC.dash);
      }
    }
  }
  // 鐵路:城市北邊一條,碎石道床 + 枕木 + 兩條鋼軌,中間一座月台
  const RY = HALF + 5;
  vbox(G0, -HALF - 8, RY - 2.5, 0, SPAN + 16, 5, .4, CVC.ballast);
  for(let x = -HALF - 7.5; x < HALF + 8; x += 1.6) vbox(G0, x, RY - 1.8, .4, .7, 3.6, .25, CVC.sleeper);
  vbox(G0, -HALF - 8, RY - 1.3, .65, SPAN + 16, .35, .35, CVC.rail);
  vbox(G0, -HALF - 8, RY + .95, .65, SPAN + 16, .35, .35, CVC.rail);
  vbox(G0, -10, RY - 5.5, 0, 20, 2.6, 1, CVC.plat);
  vbox(G0, -8, RY - 5.2, 1, 16, 1.6, 3, [200,120,80]);         // 車站
  vbox(G0, -8.5, RY - 5.7, 4, 17, 2.6, .6, [120,70,50]);
  /* 街區:人行道一圈 + 地塊(顏色依用途) */
  const blocks = [];
  for(let i = 0; i < 3; i++) for(let j = 0; j < 3; j++){
    const zone = Object.keys(ZONE_AT).find(k => ZONE_AT[k][0] === i && ZONE_AT[k][1] === j && used.has(k)) || 'park';
    const x0 = blkX(i), y0 = blkX(j);
    vbox(G0, x0, y0, 0, BLK, BLK, .5, CVC.walk);
    vbox(G0, x0 + 1.2, y0 + 1.2, .5, BLK - 2.4, BLK - 2.4, .2, ZONE_LOT[zone]);
    blocks.push({ i, j, zone, x0, y0 });
    if(zone === 'park' || zone === 'lm'){
      const n = zone === 'park' ? 7 : 4;
      for(let t = 0; t < n; t++){
        const tx = x0 + 2.5 + rnd() * (BLK - 6), ty = y0 + 2.5 + rnd() * (BLK - 6);
        if(zone === 'lm' && Math.abs(tx - x0 - BLK / 2) < 6 && Math.abs(ty - y0 - BLK / 2) < 6) continue;
        vbox(G0, tx + .6, ty + .6, .7, .8, .8, 1.8, CVC.trunk);
        vbox(G0, tx, ty, 2.5, 2, 2, 2, t & 1 ? CVC.leaf : CVC.leaf2);
        vbox(G0, tx + .5, ty + .5, 4.5, 1, 1, .8, CVC.leaf);
      }
    }
  }
  mesh(G0);

  /* ---- 各區的建築:照類型排進自己的街區,高的放後排(鏡頭在南邊才不會被擋) ---- */
  const picks = [], labels = [];
  const fill = (zone, items) => {
    const at = ZONE_AT[zone]; if(!at || !items.length) return;
    const x0 = blkX(at[0]) + 1.2, y0 = blkX(at[1]) + 1.2, W = BLK - 2.4;
    const list = items.map(it => ({ it, ...cvItemSprite(it) })).sort((a, b) => b.sp.h - a.sp.h);
    const cols = Math.ceil(Math.sqrt(list.length)), rows = Math.ceil(list.length / cols);
    const cw = W / cols, cd = W / rows;
    let top = 0;
    list.forEach((p, n) => {
      const r = rows - 1 - Math.floor(n / cols), c = n % cols;
      const dep = p.dep || Math.max(4, Math.min(p.sp.w, 10));
      const s = Math.min(.8, (cw - .6) / p.sp.w, (cd - .6) / Math.max(dep, 3));        // 只有一棟時不要大到蓋掉整個畫面
      const B = VB();
      if(p.mil) milBuild(B, p.mil, p.side, p.acc);
      else voxAdd(B, p.sp, p.tint, { x: -p.sp.w / 2, y: -dep / 2, z: 0 }, dep, false);
      const m = mesh(B);
      if(p.mil) m.rotation.z = -.35;
      m.scale.setScalar(Math.max(.05, s));
      const cx = x0 + (c + .5) * cw, cy = y0 + (r + .5) * cd;
      m.position.set(cx, cy, .7);
      m.userData.grow = 0;
      top = Math.max(top, p.sp.h * s);
      picks.push({ x: cx, y: cy, z: .7 + p.sp.h * s * .55, tag: p.it.tag || '', zone, m, h: p.sp.h * s });
    });
    return top;
  };
  const Z = data.zones || {};
  for(const k of Object.keys(ZONE_AT)) if(k !== 'lm' && Z[k] && Z[k].length) fill(k, Z[k]);
  if(data.lm) fill('lm', [{ t: 'lm', id: data.id, tag: W3D.landmarkName(data.id) }]);
  for(const b of blocks){
    const nm = (data.names || {})[b.zone]; if(!nm) continue;
    const n = b.zone === 'lm' ? 0 : (Z[b.zone] || []).length;
    labels.push({ x: b.x0 + BLK / 2, y: b.y0 + .2, z: .8, html: nm + (n ? `<b>${n}</b>` : ''), zone: b.zone });
  }
  if(!picks.length) labels.push({ x: 0, y: 0, z: 3, html: data.empty || '', zone: 'empty' });

  /* ---- 會動的:車、行人、火車 ---- */
  const movers = [];
  const carCols = [[229,72,77], [58,123,213], [255,216,74], [238,242,247], [70,196,106], [245,159,58]];
  const carGeo = col => { const B = VB(); vbox(B, -1, -1.7, .3, 2, 3.4, 1, col); vbox(B, -.8, -1, 1.3, 1.6, 1.8, .7, col.map(v => v * .8));
    vbox(B, -.9, -1.5, 0, .5, .8, .6, [30,30,36]); vbox(B, .4, -1.5, 0, .5, .8, .6, [30,30,36]);
    vbox(B, -.9, .7, 0, .5, .8, .6, [30,30,36]); vbox(B, .4, .7, 0, .5, .8, .6, [30,30,36]); return B; };
  for(let n = 0; n < 12; n++){
    const road = n % 4, vert = n % 2 === 0, dir = (n >> 1) % 2 ? 1 : -1;
    const lane = -HALF + road * (BLK + RD) + RD / 2 + dir * 1.2;
    const m = mesh(carGeo(carCols[n % carCols.length]));
    m.rotation.z = vert ? (dir > 0 ? 0 : Math.PI) : (dir > 0 ? -Math.PI / 2 : Math.PI / 2);
    movers.push({ m, kind: 'car', vert, dir, lane, p: rnd() * SPAN, v: 7 + rnd() * 6 });
  }
  const shirt = [[229,72,77], [58,123,213], [255,216,74], [179,107,255], [70,196,106], [238,242,247], [245,159,58]];
  for(const b of blocks){
    const k = b.zone === 'park' ? 2 : 3;
    for(let n = 0; n < k; n++){
      const B = VB(); const c = shirt[Math.floor(rnd() * shirt.length)];
      vbox(B, -.35, -.25, 0, .3, .5, .8, [50,56,70]); vbox(B, .05, -.25, 0, .3, .5, .8, [50,56,70]);
      vbox(B, -.4, -.3, .8, .8, .6, 1, c); vbox(B, -.3, -.25, 1.8, .6, .5, .6, CVC.skin);
      const m = mesh(B);
      movers.push({ m, kind: 'ped', b, p: rnd() * 4, v: (.04 + rnd() * .05) * (rnd() < .5 ? 1 : -1), ph: rnd() * 6 });
    }
  }
  // 火車:車頭 + 三節車廂,一起沿著鐵軌走
  const TB = VB();
  vbox(TB, 0, -1.3, .7, 6, 2.6, 2.6, [229,72,77]); vbox(TB, 4, -1.1, 3.3, 1.6, 2.2, 1.2, [143,35,40]); vbox(TB, 1, -1.35, 2, 2, 2.7, .7, [127,216,255]);
  for(let c = 0; c < 3; c++){ const x = -7.2 * (c + 1);
    vbox(TB, x, -1.3, .7, 6.6, 2.6, 2.4, [217,221,230]); vbox(TB, x + .5, -1.35, 1.9, 5.6, 2.7, .7, [58,123,213]); }
  const train = mesh(TB);
  movers.push({ m: train, kind: 'train', p: 0, v: 14 });

  /* ---- 畫布、鏡頭、操作 ---- */
  const cvs = rd.domElement;
  cvs.className = 'cv-canvas';
  host.appendChild(cvs);
  const lab = document.createElement('div'); lab.className = 'cv-labels'; host.appendChild(lab);
  const labEls = labels.map(l => { const e = document.createElement('span'); e.className = 'cv-zl z-' + l.zone; e.innerHTML = l.html; lab.appendChild(e); return e; });
  const tip = document.createElement('div'); tip.className = 'cv-tip'; tip.hidden = true; host.appendChild(tip);
  let az = -.35, el = .78, dist = 150, idleT = performance.now(), W = 1, H = 1;
  const fit = () => {
    W = Math.max(1, host.clientWidth); H = Math.max(1, host.clientHeight);
    cam.aspect = W / H; cam.updateProjectionMatrix();
    rd.setPixelRatio(clamp(560 / W, .38, 1) * Math.min(1, window.devicePixelRatio || 1) * (W < 600 ? 1.15 : 1));
    rd.setSize(W, H, false);
    const tan = Math.tan(19 * Math.PI / 180);
    dist = clamp(58 / (tan * Math.min(1.25, cam.aspect)), 115, 185);      // 直式手機左右會切掉一點,自動繞圈會轉到
  };
  fit();
  const V3 = cam.position.constructor, tmp = new V3();
  const place = () => {
    cam.position.set(Math.sin(az) * Math.cos(el) * dist, -Math.cos(az) * Math.cos(el) * dist, Math.sin(el) * dist + 4);
    cam.lookAt(0, 4, 4);
  };
  const ptrs = new Map(); let pinch = 0, moved = 0;
  const onDown = e => { ptrs.set(e.pointerId, [e.clientX, e.clientY]); moved = 0; idleT = performance.now(); try{ cvs.setPointerCapture(e.pointerId); }catch(_){}
    if(ptrs.size === 2){ const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); } };
  const onMove = e => {
    const p = ptrs.get(e.pointerId); if(!p) return;
    const dx = e.clientX - p[0], dy = e.clientY - p[1];
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    idleT = performance.now();
    if(ptrs.size === 2){ const [a, b] = [...ptrs.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if(pinch) dist = clamp(dist * pinch / Math.max(1, d), 45, 260); pinch = d; moved += 10; return; }
    moved += Math.abs(dx) + Math.abs(dy);
    az -= dx * .008; el = clamp(el + dy * .006, .32, 1.38);
  };
  const onUp = e => {
    ptrs.delete(e.pointerId); pinch = 0;
    if(moved < 8 && e.target === cvs) pickAt(e.clientX, e.clientY);
  };
  const onWheel = e => { e.preventDefault(); idleT = performance.now(); dist = clamp(dist * Math.exp(e.deltaY * .0012), 45, 260); };
  cvs.addEventListener('pointerdown', onDown); cvs.addEventListener('pointermove', onMove);
  cvs.addEventListener('pointerup', onUp); cvs.addEventListener('pointercancel', onUp);
  cvs.addEventListener('wheel', onWheel, { passive: false });
  const proj = (x, y, z) => { tmp.set(x, y, z).project(cam); return [(tmp.x + 1) / 2 * W, (1 - tmp.y) / 2 * H, tmp.z]; };
  function pickAt(cx, cy){
    const r = host.getBoundingClientRect(); const x = cx - r.left, y = cy - r.top;
    let best = null, bd = 44;
    for(const p of picks){ const s = proj(p.x, p.y, p.z); const d = Math.hypot(s[0] - x, s[1] - y); if(s[2] < 1 && d < bd){ bd = d; best = p; } }
    if(!best || !best.tag){ tip.hidden = true; CV.sel = null; return; }
    CV.sel = best; tip.hidden = false; tip.innerHTML = best.tag;
    best.m.userData.grow = performance.now();
    sfx('pick', 'tap');
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
  if(ro) ro.observe(host);

  let last = performance.now(), raf = 0;
  const t0 = last;
  const frame = now => {
    raf = requestAnimationFrame(frame);
    if(document.hidden) return;
    const dt = Math.min(.1, (now - last) / 1000); last = now;
    if(now - idleT > 3500 && !reduced()) az += dt * .07;       // 放著不動就慢慢繞城一圈
    place();
    for(const o of movers){
      if(o.kind === 'car'){
        o.p = (o.p + o.v * dt * o.dir + SPAN * 10) % SPAN;
        const s = -HALF + o.p;
        if(o.vert) o.m.position.set(o.lane, s, .26); else o.m.position.set(s, o.lane, .27);
      }else if(o.kind === 'ped'){
        o.p = (o.p + o.v * dt + 4) % 4;
        const side = Math.floor(o.p), f = o.p - side, a = .6, L = BLK - 1.2;
        const x = side === 0 ? a + f * L : side === 1 ? a + L : side === 2 ? a + L - f * L : a;
        const y = side === 0 ? a : side === 1 ? a + f * L : side === 2 ? a + L : a + L - f * L;
        o.m.position.set(o.b.x0 + x, o.b.y0 + y, .5 + (Math.sin(now / 90 + o.ph) > 0 ? .15 : 0));
        o.m.rotation.z = [-Math.PI / 2, 0, Math.PI / 2, Math.PI][side] * (o.v > 0 ? 1 : 1) + (o.v > 0 ? 0 : Math.PI);
      }else{
        o.p = (o.p + o.v * dt) % (SPAN + 60);
        o.m.position.set(-HALF - 30 + o.p, RY, 0);
        o.m.visible = o.p > 8 && o.p < SPAN + 52;
      }
    }
    // 點到的那一棟:跳一下(像素遊戲那種一格一格的彈)
    for(const p of picks){
      const g = p.m.userData.grow;
      p.m.position.z = .7 + (g && now - g < 600 ? Math.round(Math.sin((now - g) / 600 * Math.PI) * 3) * .5 : 0);
      if(p.m.userData.base == null) p.m.userData.base = p.m.scale.x;
      // 打開時一棟一棟從地上長出來
      const k = smooth((now - t0 - (p.x + HALF) * 6) / 500);
      p.m.scale.set(p.m.userData.base, p.m.userData.base, p.m.userData.base * Math.max(.02, k));
    }
    rd.render(scene, cam);
    labels.forEach((l, n) => { const s = proj(l.x, l.y, l.z), e = labEls[n];
      e.style.transform = `translate(${Math.round(s[0])}px,${Math.round(s[1])}px) translate(-50%,-50%)`; e.hidden = s[2] > 1; });
    if(CV.sel && !tip.hidden){ const s = proj(CV.sel.x, CV.sel.y, .7 + CV.sel.h + 1.5);
      tip.style.transform = `translate(${Math.round(s[0])}px,${Math.round(s[1])}px) translate(-50%,-100%)`; }
  };
  raf = requestAnimationFrame(frame);
  if(W3D._tfix != null) frame(t0 + 4000);
  CV.on = true;
  CV.stat = { picks: picks.map(p => ({ zone: p.zone, tag: p.tag })), movers: movers.map(m => m.kind), zones: blocks.map(b => b.zone), labels: labels.map(l => l.zone) };
  CV.close = () => {
    cancelAnimationFrame(raf);
    if(ro) ro.disconnect();
    cvs.removeEventListener('wheel', onWheel);
    for(const g of geos) g.dispose();
    mat.dispose();
    try{ rd.dispose(); rd.forceContextLoss && rd.forceContextLoss(); }catch(e){}
    cvs.remove(); lab.remove(); tip.remove();
  };
  return true;
};
W3D.cityStat = () => CV.on ? CV.stat : null;
W3D.cityClose = function(){
  if(!CV.on) return;
  CV.on = false; CV.sel = null;
  try{ CV.close(); }catch(e){}
  CV.close = null;
};

/* =============================================================================
   外太空 —— 使用者:「想要加上外太空:衛星、月球、火星,先幫我做模型」
   -----------------------------------------------------------------------------
   · 星鏈式的低軌星座:三個軌道面(傾角 53°)、每面 10 顆,扁平的一片太陽能板
   · 太空站一座(低軌)、兩顆導航衛星(中軌)
   · 月球、火星:體素球(一顆一顆方塊堆成的球),各自自轉、繞著地球慢慢走
   · 拉近地球(高度 < 0.9)時衛星收起來 —— 那時候它們只會擋住城市
   月球在 520、火星在 650(地球半徑 100):比平常的鏡頭距離遠,所以它們不會擋在你跟地球中間;
   把地球整個拉遠就看得到。只是畫面,不碰遊戲狀態、不用種子亂數。
   ============================================================================= */
const SAT_SP = {
  star: ['kek.cbcbcbcb', 'eee.bbbbbbbb', 'kek.cbcbcbcb'],
  nav:  ['bcb.kkk.bcb', 'bbbkeeekbbb', 'bcbkeyekbcb', 'bbbkeeekbbb', 'bcb.kkk.bcb'],
  iss:  ['bbbb.......bbbb', 'cbcb.......cbcb', 'bbbbkkkkkkkbbbb', '....keeeeek....', 'kkkkkeyryekkkkk',
         '....keeeeek....', 'bbbbkkkkkkkbbbb', 'cbcb.......cbcb', 'bbbb.......bbbb'],
};
/* 體素球:半徑 rad 格,只畫露在外面的面 */
function vsphere(B, rad, col, half){
  const inS = (x, y, z) => (!half || z >= 0) && (x + .5) ** 2 + (y + .5) ** 2 + (z + .5) ** 2 <= rad * rad;
  for(let x = -rad; x < rad; x++) for(let y = -rad; y < rad; y++) for(let z = -rad; z < rad; z++){
    if(!inS(x, y, z)) continue;
    const c = col(x + .5, y + .5, z + .5), X = x + 1, Y = y + 1, Zz = z + 1;
    if(!inS(x + 1, y, z)) vquad(B, [X,y,z], [X,Y,z], [X,Y,Zz], [X,y,Zz], [1,0,0], c, 1);
    if(!inS(x - 1, y, z)) vquad(B, [x,Y,z], [x,y,z], [x,y,Zz], [x,Y,Zz], [-1,0,0], c, 1);
    if(!inS(x, y + 1, z)) vquad(B, [X,Y,z], [x,Y,z], [x,Y,Zz], [X,Y,Zz], [0,1,0], c, 1);
    if(!inS(x, y - 1, z)) vquad(B, [x,y,z], [X,y,z], [X,y,Zz], [x,y,Zz], [0,-1,0], c, 1);
    if(!inS(x, y, z + 1)) vquad(B, [x,y,Zz], [X,y,Zz], [X,Y,Zz], [x,Y,Zz], [0,0,1], c, 1);
    if(!inS(x, y, z - 1)) vquad(B, [x,Y,z], [X,Y,z], [X,y,z], [x,y,z], [0,0,-1], c, 1);
  }
}
const vnoise = (x, y, z, s) => { const h = Math.sin(x * 12.99 + y * 78.23 + z * 37.71 + (s || 0)) * 43758.55; return h - Math.floor(h); };
/* =============================================================================
   火星與月球大改 —— 使用者:「火星跟月球基地開始做個大改外型」
   -----------------------------------------------------------------------------
   第一版是一顆顆「顏色不同的方塊球」,表面是平的。這一版是**有地形的體素星球**:
   每一個方向算一個高度(平滑雜訊 + 地標),方塊堆到那個高度 —— 撞擊坑真的凹下去、坑緣凸起來,
   火山真的隆起、峽谷真的切下去。
     火星  奧林帕斯山(太陽系最高的火山,頂上有火山口)、塔爾西斯三座火山、水手號峽谷、
           十幾個撞擊坑、南北極冠(冰的邊緣帶一點藍)、一層橘色的薄大氣光暈、兩顆小衛星(火衛一、火衛二)
     月球  月海(大片深色低地)、二十幾個撞擊坑(亮坑緣、暗坑底)、第谷坑的放射亮紋
   月球基地與火星殖民地:圓頂(白色骨架 + 玻璃)、居住艙與連接通道、登陸場(黃色 H)與登陸器、
   太陽能板陣列、雷達天線、探測車、旗子;火星另外有溫室(裡面是綠的)、通訊塔、採礦鑽機。
   它們永遠轉向鏡頭那一側(看得到你蓋了什麼)。只是畫面,不碰遊戲狀態、不用種子亂數。
   ============================================================================= */
/* 平滑的 3D 值雜訊(格點用 vnoise,三線性內插) */
function snoise(x, y, z, s){
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z), fx = x - X, fy = y - Y, fz = z - Z;
  const sm = t => t * t * (3 - 2 * t), u = sm(fx), v = sm(fy), w = sm(fz);
  const n = (a, b, c) => vnoise(X + a, Y + b, Z + c, s);
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(n(0,0,0), n(1,0,0), u), l(n(0,1,0), n(1,1,0), u), v), l(l(n(0,0,1), n(1,0,1), u), l(n(0,1,1), n(1,1,1), u), v), w);
}
const dirOf = (lat, lng) => { const a = lat * Math.PI / 180, b = lng * Math.PI / 180; return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)]; };
const angD = (u, d) => Math.acos(clamp(u[0] * d[0] + u[1] * d[1] + u[2] * d[2], -1, 1));
/* 固定的撞擊坑清單(方向 + 角半徑),用固定的種子產生 —— 每次長得一樣 */
function craterList(n, seed, rMin, rMax){
  let s = seed; const r = () => { s = (s * 1103515245 + 12345) >>> 0; return (s >>> 8) / 16777216; };
  const out = [];
  for(let i = 0; i < n; i++){ const z = r() * 2 - 1, t = r() * Math.PI * 2, q = Math.sqrt(1 - z * z); out.push([q * Math.cos(t), q * Math.sin(t), z, rMin + r() * (rMax - rMin)]); }
  return out;
}
/* 有地形的體素星球:solid = 到球心的距離 ≤ 半徑 + 高度(方向);只畫露在外面的面 */
function vplanet(B, rad, feat, hs){
  /* hs = 高度倍率:同一套地形函式(為半徑 14 設計的)畫在更大的星球上時,起伏跟著放大 */
  hs = hs || 1;
  const pad = 6 * hs, M = Math.ceil(rad + pad), memo = new Map(), INNER = { c: [0,0,0] };
  const cell = (x, y, z) => {
    const k = ((x + 96) * 256 + (y + 96)) * 256 + (z + 96);
    let v = memo.get(k);
    if(v === undefined){
      const cx = x + .5, cy = y + .5, cz = z + .5, l = Math.hypot(cx, cy, cz) || 1;
      if(l < rad - pad) v = INNER;                       // 深處一定是實心,不用算地形
      else if(l > rad + pad) v = null;
      else { const f = feat([cx / l, cy / l, cz / l]); v = l <= rad + f.h * hs ? f : null; }
      memo.set(k, v);
    }
    return v;
  };
  for(let x = -M; x < M; x++) for(let y = -M; y < M; y++) for(let z = -M; z < M; z++){
    const l = Math.hypot(x + .5, y + .5, z + .5);
    if(l < rad - pad - 1.8 || l > rad + pad + 1) continue;  // 只有表面那一層殼可能有露出來的面
    const f = cell(x, y, z); if(!f) continue;
    const c = f.c, X = x + 1, Y = y + 1, Zz = z + 1;
    if(!cell(x + 1, y, z)) vquad(B, [X,y,z], [X,Y,z], [X,Y,Zz], [X,y,Zz], [1,0,0], c, 1);
    if(!cell(x - 1, y, z)) vquad(B, [x,Y,z], [x,y,z], [x,y,Zz], [x,Y,Zz], [-1,0,0], c, 1);
    if(!cell(x, y + 1, z)) vquad(B, [X,Y,z], [x,Y,z], [x,Y,Zz], [X,Y,Zz], [0,1,0], c, 1);
    if(!cell(x, y - 1, z)) vquad(B, [x,y,z], [X,y,z], [X,y,Zz], [x,y,Zz], [0,-1,0], c, 1);
    if(!cell(x, y, z + 1)) vquad(B, [x,y,Zz], [X,y,Zz], [X,Y,Zz], [x,Y,Zz], [0,0,1], c, 1);
    if(!cell(x, y, z - 1)) vquad(B, [x,Y,z], [X,Y,z], [X,y,z], [x,y,z], [0,0,-1], c, 1);
  }
}
const MARS_R = 14, MOON_R = 12, MARS_S = 2.6, MOON_S = 2.2;     // 火星比月球大(真實比例約 2 倍)
const MARS_CR = craterList(16, 77, .07, .2);
const OLYMPUS = dirOf(18, -40), THARSIS = [dirOf(10, -8), dirOf(0, 0), dirOf(-10, 8)];
function marsFeat(u){
  const lat = Math.asin(u[2]) * 180 / Math.PI, lng = Math.atan2(u[1], u[0]) * 180 / Math.PI;
  let h = (snoise(u[0] * 3 + 5, u[1] * 3, u[2] * 3, 2) - .5) * 1.4 + (snoise(u[0] * 8, u[1] * 8, u[2] * 8, 4) - .5) * .6;
  const n = snoise(u[0] * 5, u[1] * 5 + 3, u[2] * 5, 7);
  let c = n < .33 ? [150,64,38] : n < .66 ? [190,90,52] : [214,124,74];
  if(snoise(u[0] * 11, u[1] * 11, u[2] * 11, 9) > .72) c = [232,158,104];               // 亮色的沙塵
  const dO = angD(u, OLYMPUS);
  if(dO < .42){ h += 3.6 * Math.pow(1 - dO / .42, 1.4); c = dO < .06 ? [120,52,34] : [206,112,72]; if(dO < .06) h -= 1; }
  for(const t of THARSIS){ const d = angD(u, t); if(d < .16){ h += 1.8 * (1 - d / .16); c = d < .03 ? [120,52,34] : [198,104,66]; } }
  if(Math.abs(lat + 8) < 4.5 && lng > 20 && lng < 95){                                    // 水手號峽谷
    const k = 1 - Math.abs(lat + 8) / 4.5; h -= 2.4 * k; c = k > .5 ? [104,40,26] : [138,58,36];
  }
  for(const cr of MARS_CR){
    const d = angD(u, cr), r = cr[3];
    if(d < r){ h -= 1.5 * (1 - (d / r) ** 2); c = [132,58,36]; }
    else if(d < r * 1.3){ h += .8 * (1 - (d - r) / (r * .3)); c = [228,150,100]; }
  }
  const pole = Math.abs(lat) + (snoise(u[0] * 6, u[1] * 6, 0, 11) - .5) * 10;
  if(pole > 74){ h += .7; c = pole > 78 ? [244,246,250] : [196,212,232]; }
  return { h, c };
}
const MOON_CR = craterList(24, 1234, .05, .17), TYCHO = dirOf(-43, 10);
const MARIA = [[dirOf(20, 20), .55], [dirOf(5, 55), .4], [dirOf(-10, -15), .45], [dirOf(35, -30), .35]];
function moonFeat(u){
  let h = (snoise(u[0] * 4, u[1] * 4, u[2] * 4, 21) - .5) * .9;
  let c = snoise(u[0] * 9, u[1] * 9, u[2] * 9, 23) < .5 ? [168,172,180] : [184,188,196];
  for(const [d0, r] of MARIA){ const d = angD(u, d0) + (snoise(u[0] * 5, u[1] * 5, u[2] * 5, 25) - .5) * .25; if(d < r){ h -= .7; c = [98,102,112]; } }
  const dT = angD(u, TYCHO);
  if(dT > .12 && dT < .9){                                                                  // 第谷坑的放射亮紋
    const ax = Math.atan2(u[1] - TYCHO[1], u[0] - TYCHO[0]);
    if(Math.abs(Math.sin(ax * 7)) > .93) c = [214,218,226];
  }
  for(const cr of [...MOON_CR, [...TYCHO, .12]]){
    const d = angD(u, cr), r = cr[3];
    if(d < r){ h -= 1.3 * (1 - (d / r) ** 2); c = d < r * .25 ? [150,154,162] : [118,122,130]; }
    else if(d < r * 1.3){ h += .7 * (1 - (d - r) / (r * .3)); c = [220,224,230]; }
  }
  return { h, c };
}
/* 平滑球(大氣光暈用):經緯網格 */
function sphereGeo(r, seg){
  const B = VB(), P = (i, j) => { const a = Math.PI * (i / seg - .5), b = Math.PI * 2 * j / seg; return [r * Math.cos(a) * Math.cos(b), r * Math.cos(a) * Math.sin(b), r * Math.sin(a)]; };
  for(let i = 0; i < seg; i++) for(let j = 0; j < seg; j++){
    const a = P(i, j), b = P(i, j + 1), c = P(i + 1, j + 1), d = P(i + 1, j), n = a.map(v => v / r);
    vquad(B, a, b, c, d, n, [255,255,255], 1);
  }
  return vgeo(B);
}
/* ---- 基地的零件(z 朝上,一格 = 一個體素) ---- */
const BASE_C = { frame: [238,242,247], glass: [110,190,230], hull: [217,221,230], dark: [70,74,84], gold: [214,170,60],
                 pad: [80,84,94], yel: [255,216,74], panel: [40,90,190], panel2: [90,150,230], green: [70,170,80] };
function bDome(B, ox, oy, oz, r, glass){
  const tmp = VB();
  vsphere(tmp, r, (x, y, z) => (Math.abs(x) < .6 || Math.abs(y) < .6 || z > r * .82) ? BASE_C.frame : (glass || BASE_C.glass), true);
  for(let i = 0; i < tmp.p.length; i += 3){ B.p.push(tmp.p[i] + ox, tmp.p[i + 1] + oy, tmp.p[i + 2] + oz); }
  B.n.push(...tmp.n); B.c.push(...tmp.c);
}
function bFoundation(B, w, d, col){ vbox(B, -w / 2, -d / 2, -5.5, w, d, 5.8, col); }     // 地基往下插深一點:星球在自轉,地形高低不一,不能被埋掉
function bHab(B, col){                                                 // 居住區:兩座圓頂 + 長艙 + 通道 + 氣閘
  bFoundation(B, 16, 10, col);
  bDome(B, -4, 0, .3, 3.2); bDome(B, 4.5, 1.5, .3, 2.3);
  vbox(B, -1, -1, .3, 4, 2, 1.8, BASE_C.hull); vbox(B, -.8, -1.05, 1.1, 3.6, .1, .5, BASE_C.glass);   // 連接通道
  vbox(B, 1, -4.2, .3, 6, 2.4, 2.2, BASE_C.hull); vbox(B, 1.2, -4.25, 1.2, 5.6, .1, .6, BASE_C.glass); // 長艙
  vbox(B, 1, -4.3, 2.5, 6, 2.6, .3, BASE_C.dark);
  vbox(B, -7.5, 2.6, .3, 1.6, 1.6, 1.4, BASE_C.dark);                                               // 氣閘
}
function bPad(B, col){                                                 // 登陸場 + 登陸器
  bFoundation(B, 10, 10, col);
  vbox(B, -4, -4, .3, 8, 8, .2, BASE_C.pad);
  vbox(B, -2, -2, .5, .6, 4, .05, BASE_C.yel); vbox(B, 1.4, -2, .5, .6, 4, .05, BASE_C.yel); vbox(B, -1.4, -.3, .5, 2.8, .6, .05, BASE_C.yel);
  vbox(B, -1.3, -1.3, 1.2, 2.6, 2.6, 2.2, BASE_C.hull); vbox(B, -1.1, -1.1, 3.4, 2.2, 2.2, .7, BASE_C.gold);
  vbox(B, -.4, -.4, 4.1, .8, .8, 1.4, BASE_C.hull); vbox(B, -.6, -.6, .5, 1.2, 1.2, .7, BASE_C.dark);
  for(const [x, y] of [[-2.3,-2.3],[1.8,-2.3],[-2.3,1.8],[1.8,1.8]]) vbox(B, x, y, .5, .5, .5, 1, BASE_C.dark);
}
function bSolar(B, col){                                               // 太陽能板 3×2 + 雷達天線
  bFoundation(B, 14, 10, col);
  for(let i = 0; i < 3; i++) for(let j = 0; j < 2; j++){
    const x = -6 + i * 3.6, y = -4 + j * 3.4;
    vbox(B, x + 1.2, y + 1, .3, .3, .3, 1.2, BASE_C.dark);
    vbox(B, x, y, 1.5, 3, 2.4, .2, BASE_C.panel);
    vbox(B, x + 1.4, y, 1.71, .15, 2.4, .02, BASE_C.panel2); vbox(B, x, y + 1.1, 1.71, 3, .15, .02, BASE_C.panel2);
  }
  vbox(B, 4.6, -.3, .3, .5, .5, 3.6, BASE_C.dark);                                                  // 雷達天線(碗是一層層的方塊)
  vbox(B, 3.6, -1.3, 3.9, 2.5, 2.5, .3, BASE_C.frame); vbox(B, 3.1, -1.8, 4.2, 3.5, 3.5, .3, BASE_C.frame); vbox(B, 2.6, -2.3, 4.5, 4.5, 4.5, .3, BASE_C.frame);
  vbox(B, 4.7, -.2, 4.8, .3, .3, 1.6, BASE_C.dark);
}
function bRover(B){
  vbox(B, -1.5, -1, .6, 3, 2, 1, BASE_C.hull); vbox(B, -.6, -.8, 1.6, 1.6, 1.6, .9, BASE_C.glass);
  for(const [x, y] of [[-1.6,-1.3],[.9,-1.3],[-1.6,1],[.9,1]]) vbox(B, x, y, 0, .8, .4, .8, BASE_C.dark);
  vbox(B, 1.1, .3, 1.6, .2, .2, 1.4, BASE_C.dark);
}
function bFlag(B, acc){ vbox(B, 0, 0, 0, .3, .3, 5, BASE_C.frame); vbox(B, .3, -.05, 3.4, 2.6, .2, 1.6, acc); }
function bGreenhouse(B, col){                                          // 溫室:三條長玻璃溫室,裡面是綠的
  bFoundation(B, 14, 11, col);
  for(let i = 0; i < 3; i++){
    const y = -4.5 + i * 3.4;
    vbox(B, -6, y, .3, 12, 2.6, .8, BASE_C.green);
    vbox(B, -6.2, y - .1, 1.1, 12.4, 2.8, 1.4, [150,220,190]);
    for(let x = -6; x <= 6; x += 2) vbox(B, x, y - .15, .3, .25, 2.9, 2.4, BASE_C.frame);
  }
}
function bTower(B, col){                                               // 通訊塔 + 採礦鑽機
  bFoundation(B, 10, 8, col);
  vbox(B, -3.5, -.5, .3, 1, 1, 9, [200,200,210]); for(let z = 1.3; z < 9; z += 2) vbox(B, -4, -1, z, 2, 2, .3, [229,72,77]);
  vbox(B, -4.2, -1.2, 9.3, 2.4, 2.4, .6, BASE_C.frame);
  vbox(B, 1, -2, .3, 4, 4, 1.4, [150,120,80]); vbox(B, 2.6, -.4, 1.7, .8, .8, 5, BASE_C.yel); vbox(B, 1.5, -1.5, 6.7, 3, 3, .6, BASE_C.yel);
  vbox(B, 2.8, -.2, -1.5, .4, .4, 1.8, BASE_C.dark);
}

const SPACE = { on: false };
W3D.spaceStat = () => SPACE.on ? { sats: SPACE.sats.length, moon: !!SPACE.moon, mars: !!SPACE.mars, satsVisible: SPACE.satG.visible } : null;
function spaceInit(){
  if(SPACE.on || !W3D.ok || !T || !hasPX()) return;
  try{
    const root = new T.O3(), satG = new T.O3();
    root.add(satG);
    const mk = (B, s) => { const m = new T.Mesh(vgeo(B), vmat()); m.scale.setScalar(s); return m; };
    const sats = [];
    const satGeo = k => { const sp = PX.S(SAT_SP[k]); const B = VB(); voxAdd(B, sp, null, { x: -sp.w / 2, y: -sp.h / 2, z: -.5 }, 1, true); return vgeo(B); };
    const gS = satGeo('star'), gN = satGeo('nav'), gI = satGeo('iss');
    const add = (g, s, r, inc, raan, ph, w) => { const m = new T.Mesh(g, vmat()); m.scale.setScalar(s); satG.add(m); sats.push({ m, r, inc, raan, ph, w }); };
    /* 星鏈:每一批 = 一個軌道面 8 顆,最多 6 面。沒發射之前軌道上沒有星鏈 —— 發一批就多一圈,看得出來 */
    for(let p = 0; p < 6; p++) for(let n = 0; n < 8; n++){
      add(gS, .42, 130 + p * 2, (48 + p * 3) * Math.PI / 180, p * 1.047, n * .785 + p * .3, .09);
      sats[sats.length - 1].plane = p;
    }
    add(gI, .5, 142, 51.6 * Math.PI / 180, 1.1, 0, .075);
    add(gN, .6, 196, 55 * Math.PI / 180, .4, 0, .03); add(gN, .6, 196, 55 * Math.PI / 180, 2.5, 2.2, .03);
    const MB = VB(); vplanet(MB, MOON_R, moonFeat);
    const moon = mk(MB, MOON_S); root.add(moon);
    const RB = VB(); vplanet(RB, MARS_R, marsFeat);
    const mars = mk(RB, MARS_S); root.add(mars);
    // 火星的薄大氣:一層橘色半透明的光暈(只畫背面 = 星球邊緣一圈亮邊)
    const halo = new T.Mesh(sphereGeo(MARS_R * 1.16, 24), new T.Phong({ color: 0x000000, emissive: 0xff8a48, transparent: true, opacity: .28, depthWrite: false, side: 1 }));
    mars.add(halo);
    // 火衛一、火衛二:兩顆坑坑疤疤的小石頭
    const lump = (r, seed) => { const B = VB(); vplanet(B, r, u => ({ h: (snoise(u[0] * 3, u[1] * 3, u[2] * 3, seed) - .5) * 1.6, c: snoise(u[0] * 6, u[1] * 6, u[2] * 6, seed + 1) < .5 ? [120,104,92] : [150,132,116] })); return mk(B, 1.6); };
    const phobos = lump(2.4, 31), deimos = lump(1.7, 41); root.add(phobos); root.add(deimos);
    G.scene().add(root);
    /* 殖民地與月球基地不黏在星球的自轉上:永遠轉向鏡頭那一側(不然十次有五次在背面,看不到你蓋了什麼) */
    const colony = new T.O3(); colony.scale.setScalar(MARS_S); root.add(colony);
    const moonBase = new T.O3(); moonBase.scale.setScalar(MOON_S); root.add(moonBase);
    Object.assign(SPACE, { on: true, root, satG, sats, moon, mars, colony, moonBase, phobos, deimos });
    buildMoonBase();
    spaceApply();
    let lastT = 0;
    const tick = now => {
      requestAnimationFrame(tick);
      if(document.hidden || CV.on || now - lastT < 33) return;
      lastT = now;
      spaceStep(now / 1000);
    };
    spaceStep(0);
    requestAnimationFrame(tick);
  }catch(e){ SPACE.on = false; }
}
/* 軌道:在赤道面上轉一圈,再依傾角與升交點轉過去(globe.gl 的 y 軸朝北) */
function orbitPos(r, inc, raan, a){
  const x0 = Math.cos(a) * r, z0 = Math.sin(a) * r;
  const y1 = z0 * Math.sin(inc), z1 = z0 * Math.cos(inc);
  return [x0 * Math.cos(raan) + z1 * Math.sin(raan), y1, -x0 * Math.sin(raan) + z1 * Math.cos(raan)];
}
function spaceStep(t){
  if(!SPACE.on) return;
  SPACE.satG.visible = (W3D.alt || 2) >= .9;
  if(SPACE.satG.visible) for(const s of SPACE.sats){
    if(!s.m.visible) continue;
    const p = orbitPos(s.r, s.inc, s.raan, s.ph + t * s.w);
    s.m.position.set(p[0], p[1], p[2]);
    s.m.quaternion.copy(G.camera().quaternion);      // 太陽能板正對鏡頭:不然在地球邊緣只剩一條線
  }
  const mp = orbitPos(520, 5 * Math.PI / 180, .6, .9 + t * .003);
  SPACE.moon.position.set(mp[0], mp[1], mp[2]); SPACE.moon.rotation.y = t * .003;
  const rp = orbitPos(650, 2 * Math.PI / 180, 2.2, 5 + t * .0015);
  SPACE.mars.position.set(rp[0], rp[1], rp[2]); SPACE.mars.rotation.y = t * .05;
  const face = (C, P) => {
    if(!C.children.length) return;
    const V3 = C.position.constructor;
    C.position.copy(P.position);
    const d = G.camera().position.clone().sub(P.position).normalize();
    C.quaternion.setFromUnitVectors(new V3(1, 0, 0), d);
  };
  face(SPACE.colony, SPACE.mars); face(SPACE.moonBase, SPACE.moon);
  const ph = t * .4, dm = t * .15, M = SPACE.mars.position;
  SPACE.phobos.position.set(M.x + Math.cos(ph) * 58, M.y + Math.sin(ph) * 8, M.z + Math.sin(ph) * 58); SPACE.phobos.rotation.set(ph, ph * .7, 0);
  SPACE.deimos.position.set(M.x + Math.cos(dm) * 80, M.y - Math.sin(dm) * 12, M.z + Math.sin(dm) * 80); SPACE.deimos.rotation.set(0, dm, dm * .5);
  // 看月球 / 看火星:鏡頭鎖住那顆星(它一直在公轉,不跟的話幾分鐘就跑出畫面)
  if(FOLLOW && !CV.on){
    const now = performance.now();
    if(now - followT > 1000){ const first = followT === 0; followT = now; const pov = W3D.spacePov(FOLLOW); if(pov){ try{ G.pointOfView(pov, first ? 700 : 1000); }catch(e){} } }
  }
}
/* 遊戲狀態 → 太空畫面:幾批星鏈、火星計畫走到哪。index.html 每次畫地圖時呼叫(只讀,不改規則) */
let SPACE_WANT = { stars: 0, mars: 0, run: 0 }, SPACE_KEY = '';
W3D.spaceSync = function(w){ SPACE_WANT = w || SPACE_WANT; spaceApply(); };
function spaceApply(){
  if(!SPACE.on) return;
  const w = SPACE_WANT;
  for(const s of SPACE.sats) if(s.plane != null) s.m.visible = s.plane < (w.stars || 0);
  const key = (w.mars || 0) + ':' + (w.run || 0);
  if(key === SPACE_KEY) return;
  SPACE_KEY = key;
  // 火星上的殖民地:無人補給 → 登陸場 + 物資;首批登陸 → 居住區 + 旗子 + 探測車;自給自足 → 溫室、太陽能、通訊塔與鑽機
  const C = SPACE.colony;
  while(C.children.length){ const o = C.children.pop(); o.geometry && o.geometry.dispose(); }
  const st = w.mars || 0, soil = [176,86,52];
  if(st >= 2 || w.run >= 2){ const B = VB(); bPad(B, soil);
    const cols = [[229,72,77], [58,123,213], [255,216,74], [238,242,247]];
    for(let i = 0; i < 4; i++) vbox(B, 3 + (i % 2) * 1.3, -3.5 + Math.floor(i / 2) * 1.3, .3, 1.1, 1.1, 1.1, cols[i]);
    surfPut(C, B, MARS_R, -14, 22); }
  if(st >= 3){ const B = VB(); bHab(B, soil); surfPut(C, B, MARS_R, 0, 0);
    const F = VB(); bFlag(F, hexRGB(TEAM)); surfPut(C, F, MARS_R, 10, 12);
    const R = VB(); bRover(R); surfPut(C, R, MARS_R, -12, -8); }
  if(st >= 4){ const G1 = VB(); bGreenhouse(G1, soil); surfPut(C, G1, MARS_R, 20, -16);
    const S = VB(); bSolar(S, soil); surfPut(C, S, MARS_R, -24, -22);
    const T1 = VB(); bTower(T1, soil); surfPut(C, T1, MARS_R, 22, 24); }
}
/* 把一組零件貼在星球表面(局部座標:+x 朝鏡頭那一側,lat / lng 是從那一點往外偏幾度) */
function surfPut(C, B, rad, lat, lng){
  const m = new T.Mesh(vgeo(B), vmat());
  const V3 = m.position.constructor, d = new V3(...dirOf(lat, lng));
  m.position.copy(d).multiplyScalar(rad + 2.4);
  m.quaternion.setFromUnitVectors(new V3(0, 0, 1), d);
  m.scale.setScalar(.5);
  C.add(m);
}
/* 月球基地(外型;什麼時候出現、怎麼玩等討論完再接規則,現在先一直擺著給你看) */
function buildMoonBase(){
  const C = SPACE.moonBase, soil = [150,154,162];
  const H = VB(); bHab(H, soil); surfPut(C, H, MOON_R, 0, 0);
  const P = VB(); bPad(P, soil); surfPut(C, P, MOON_R, -18, 26);
  const S = VB(); bSolar(S, soil); surfPut(C, S, MOON_R, 20, -22);
  const R = VB(); bRover(R); surfPut(C, R, MOON_R, -14, -12);
  const F = VB(); bFlag(F, hexRGB(TEAM)); surfPut(C, F, MOON_R, 12, 14);
}
let FOLLOW = null, followT = 0;
/* 鏡頭鎖定:'moon' / 'mars' / null(回地球)。index.html 的太空鈕與火星火箭用 */
W3D.spaceFollow = k => { FOLLOW = k || null; followT = performance.now(); };
/* 火箭發射:從城市垂直升空。星鏈 → 升到軌道就散開;火星 → 升空後轉向,一路飛到火星 */
const ROCKETS = new Set();
/* 使用者:「火箭發射的時候鏡頭要跟著火箭移動」—— 追焦鏡頭。
   globe.gl 的鏡頭平常一定是「繞著地球、看著球心」(傾斜鏡頭也是在那之上算的);追焦的時候
   在 installTilt 的 update 最後把鏡頭直接擺到火箭旁邊、看著火箭,結束後再交還給原本的控制器。
     升空  鏡頭在發射場南邊一點、跟著火箭一起往上爬,看得到火箭、尾焰、底下的城市
     轉向火星(火星計畫)  鏡頭跑到火箭後上方,看著前方 —— 火星在畫面裡越來越大
     結束  星鏈:回到發射城市上空;火星:停在「看火星」的位置並鎖定 */
let CHASE = null;
W3D.chasing = () => !!CHASE;
function chaseCam(cam){
  const r = CHASE;
  if(!r || !r.cp) return false;
  cam.position.copy(r.cp); cam.up.copy(r.cu); cam.lookAt(r.cl);
  W3D.alt = cam.position.length() / R - 1;
  return true;
}
function chaseEnd(r){
  if(CHASE !== r) return;
  const dest = r.kind === 'mars' || r.kind === 'moon' ? r.kind : null;     // 第五十一輪:登月也是一路飛過去
  const hand = dest && !r.skip ? W3D.handoff(dest) : null;     // 在鏡頭被交還之前量:星球畫面的第一格要跟這一格一樣
  CHASE = null;
  setTimeout(() => { try{ farMode(); }catch(e){} }, 1700);     // 名牌照新的高度決定要不要再出來
  try{
    const cam = G.camera();
    if(W3D._logical){ const p = cam.position.clone(); if(p.length() > 880) p.setLength(880); if(p.length() < 110) p.setLength(110); W3D._logical.copy(p); cam.position.copy(p); }
    cam.up.set(0, 1, 0); cam.lookAt(0, 0, 0);
    if(dest){
      // 到了:直接進那顆星的畫面,播著陸(地球這邊的鏡頭不鎖在那顆星 —— 回地球時才回得去)。按了「跳過」就直接到、不播著陸
      FOLLOW = null;
      try{ if(typeof tyOpenPlanet === 'function') tyOpenPlanet(dest, r.skip ? {} : { landing: true, from: hand }); }catch(e){}
    }else G.pointOfView({ lat: r.S.lat, lng: r.S.lng, altitude: 1.4 }, 1500);
  }catch(e){}
  tyWake();
}
W3D.launch = function(L){
  if(!W3D.ok || !SPACE.on || !L || !hasPX()) return;
  const S = tySite(L.site); if(!S) return;
  const sp = PX.SPR.rocket, B = VB();
  voxAdd(B, sp, null, { x: -sp.w / 2, y: -1.5, z: 0 }, 3, false);
  const m = new T.Mesh(vgeo(B), vmat());
  const c = G.getCoords(S.lat, S.lng, .002 + elevAlt(S.lat, S.lng));
  const V3 = m.position.constructor, base = new V3(c.x, c.y, c.z), n = base.clone().normalize();
  // 鏡頭的「南」:從北往下(地表切面上)
  const south = new V3(0, -1, 0).addScaledVector(n, n.y); if(south.lengthSq() < 1e-6) south.set(0, 0, 1); south.normalize();
  m.position.copy(base);
  SPACE.root.add(m);
  const r = { m, base, n: n.clone(), n0: n, south, S, kind: L.kind, t0: performance.now(), tgt: new V3(), V3,
              cp: null, cu: n.clone(), cl: new V3(), dir: new V3() };
  ROCKETS.add(r);
  /* 即時制(L.noChase):鏡頭不自動跟,畫面層出一顆「看火箭」按鈕(W3D.chaseRocket)——
     使用者:「火星發射的動畫鏡頭就不用跟著,可以有一個小按鈕點一下切到火箭的鏡頭」 */
  if(!L.noChase){
    FOLLOW = null;
    if(!reduced()){ CHASE = r; try{ G.controls().autoRotate = false; }catch(e){} }
    else try{ G.pointOfView({ lat: S.lat, lng: S.lng, altitude: 1.3 }, 900); }catch(e){}
  }
  tyWake();
  sfx('launch', 'boom');
  setTimeout(() => sfx('jet'), 300);
  for(let i = 0; i < 4; i++) setTimeout(() => fxAt(S.lat, S.lng, i ? 'smoke' : 'boom', { z: 4, dur: .8, life: 1000, alt: .002 }), i * 260);
  if(ROCKETS.size === 1) requestAnimationFrame(rocketStep);
};
function rocketStep(now){
  for(const r of ROCKETS){
    /* 第五十一輪:時間用「每一幀最多算 0.1 秒」累加 —— 原本用牆上時間,慢的裝置(或剛發射那一幀要載入城市 3D 模型)
       一卡就跳過 3.6 秒,星鏈火箭還沒看到就結束了 */
    if(r.last == null) r.last = now;
    r.tt = (r.tt || 0) + Math.min(.1, Math.max(0, (now - r.last) / 1000)); r.last = now;
    const t = W3D._rocketT != null ? W3D._rocketT : r.tt, m = r.m;     // _rocketT:截圖驗證用,凍結在某一秒
    m.scale.setScalar(CHASE === r ? .2 + Math.min(40, (t < 3.2 ? t * t * 4.5 : 46)) * .004 : clamp((W3D.alt || 1) * .42, .15, .8));
    if(CHASE === r && r.cp && !r.zoomed){ r.zoomed = true; try{ W3D.onZoom({ altitude: W3D.alt }); }catch(e){} }   // 近看:城市的 3D 模型與地形要出來
    const up = Math.min(t, 3.2), h = up * up * 4.5;             // 越飛越快
    const far = r.kind === 'mars' || r.kind === 'moon';
    if(far && t > 3.2){
      /* 使用者:「鏡頭和火星會直接切穿地球,不合理」—— 第一版是直線飛過去,火星在地球另一邊時就穿過地球。
         改成繞著地球外側飛:方向從發射點慢慢轉向火星(球面內插)、同時離地球越來越遠 → 永遠在地球外面。 */
      const f = smooth((t - 3.2) / (r.kind === 'moon' ? 4.5 : 6)), top = r.base.clone().addScaledVector(r.n0, h), rT = top.length();
      r.tgt.copy(SPACE[r.kind].position);
      const mD = r.tgt.clone().normalize(), rM = r.tgt.length() - PLANET_R(r.kind) * (r.kind === 'moon' ? 2.6 : 1.5);   // 月球比較小:停遠一點,著陸畫面的第一格才不會只看到一個坑
      const ang = Math.acos(clamp(r.n0.dot(mD), -1, 1));
      const ax = r.n0.clone().cross(mD); if(ax.lengthSq() < 1e-8) ax.set(0, 1, 0); ax.normalize();
      const pos = (u) => { const q = new (G.camera().quaternion.constructor)().setFromAxisAngle(ax, ang * smooth(u));
        return r.n0.clone().applyQuaternion(q).multiplyScalar(rT + (rM - rT) * u * u); };      // 先繞、後衝
      m.position.copy(pos(f));
      const ahead = pos(Math.min(1, f + .02));
      m.lookAt(ahead);
      // 追焦:火箭後上方,看著前面(火星在畫面裡越來越大)
      r.dir.copy(ahead).sub(m.position).normalize();
      if(r.dir.lengthSq() < 1e-8) r.dir.copy(mD);
      r.n.lerp(m.position.clone().normalize(), .08).normalize();       // 鏡頭的「上」跟著火箭所在的位置轉
      // 飛向火星的時候地球在鏡頭後面:地上的名牌 / 部隊標籤投影會跑到太空裡,先收起來
      if(CHASE === r){ const hs = document.getElementById('tyGlobeHost'); if(hs && hs.dataset.space !== '1') hs.dataset.space = '1'; }
      r.cp = (r.cp || new r.V3()).copy(m.position).addScaledVector(r.dir, -16).addScaledVector(r.n, 5);
      r.cl.copy(m.position).addScaledVector(r.dir, 20).lerp(r.tgt, clamp((f - .5) * 2, 0, 1)); r.cu.copy(r.n);   // 後半段轉頭看火星
      if(f >= 1){ chaseEnd(r); ROCKETS.delete(r); SPACE.root.remove(m); m.geometry.dispose(); sfx('upgrade', 'land');
        try{ if(typeof renderPage === 'function' && typeof TY_MODAL !== 'undefined' && !TY_MODAL) renderPage(); }catch(e){} }
    }else{
      m.position.copy(r.base).addScaledVector(r.n, h);
      r.tgt.copy(m.position).addScaledVector(r.n, 10);
      m.lookAt(r.tgt);
      // 追焦:發射場南邊一點、比火箭高一點,跟著一起往上爬
      /* 鏡頭比火箭低一點、越飛拉得越遠,水平看過去:火箭在畫面上半、地球的弧線在下半
         (鏡頭越高,地平線就越往下沉 —— 鏡頭留在火箭三成的高度、拉遠,兩個才塞得進同一個畫面) */
      const hc = h * .3 + 1;
      r.cp = (r.cp || new r.V3()).copy(r.base).addScaledVector(r.n, hc).addScaledVector(r.south, 11 + h * 1.5);
      r.cl.copy(r.base).addScaledVector(r.n, h * .55 + 1.5); r.cu.copy(r.n);     // 看向火箭與地面中間偏上
      if(CHASE === r){ const hs = document.getElementById('tyGlobeHost'); if(hs && hs.dataset.space !== '1') hs.dataset.space = '1'; }   // 追焦時地上的名牌先收起來
      if(!far && t > 3.6){ chaseEnd(r); ROCKETS.delete(r); SPACE.root.remove(m); m.geometry.dispose(); }
    }
  }
  if(ROCKETS.size) requestAnimationFrame(rocketStep);
}
W3D._rockets = () => ROCKETS.size;
/* 第五十一輪:使用者「多加一個跳過動畫的按鍵」。
   跳過 = 火箭直接到終點:星鏈 → 鏡頭回到發射城市;登月 / 火星 → 直接打開那顆星(不播著陸);
   正在播的著陸也直接落地。畫面層用 W3D.animBusy() 決定要不要顯示「跳過」鈕、要不要先停住時間。 */
W3D.animSkip = function(){
  let any = false;
  for(const r of [...ROCKETS]){
    any = true; r.skip = true;
    ROCKETS.delete(r); try{ SPACE.root.remove(r.m); r.m.geometry.dispose(); }catch(e){}
    if(CHASE === r) chaseEnd(r);
    else if((r.kind === 'mars' || r.kind === 'moon') && !PV.on){ try{ tyOpenPlanet(r.kind, {}); }catch(e){} }
  }
  if(W3D._landSkip && W3D._landSkip()) any = true;
  if(any) try{ farMode(); }catch(e){}
  tyWake();
  return any;
};
W3D.animBusy = () => !!CHASE || ROCKETS.size > 0 || !!(W3D._landBusy && W3D._landBusy());
/* 「看火箭」:切到正在飛的那一枚(火星的優先)的追焦鏡頭 */
W3D.chaseRocket = function(){
  const list = [...ROCKETS]; const r = list.find(x => x.kind === 'mars') || list[0];
  if(!r) return false;
  FOLLOW = null; CHASE = r; try{ G.controls().autoRotate = false; }catch(e){}
  tyWake(); return true;
};
W3D._space = t => spaceStep(t);          // 給截圖用:手動推到某個時間
W3D._spaceObj = () => SPACE;
/* 「看月球 / 看火星」的鏡頭:站在它外側、往旁邊偏一點,讓地球跟它同框 */
/* 「看月球 / 看火星」的鏡頭。使用者:「星球本身比較小,我想要可以放大到跟地球一樣的比例」——
   鏡頭站在那顆星的正外側(地球 → 星球 → 鏡頭一直線),距離 = 星球半徑 × SPACE_ZOOM。
   地球平常是在「半徑 × 3」的距離看(高度 2),預設用同一個倍數 → 星球在畫面上跟地球一樣大。
   拉近 / 拉遠鈕在太空模式改這個倍數(1.6 ~ 6)。鏡頭距離地心不能超過 globe.gl 的上限 900。 */
let SPACE_ZOOM = 3;
const PLANET_R = k => k === 'moon' ? MOON_R * MOON_S : MARS_R * MARS_S;
W3D.spaceZoom = function(dir){
  SPACE_ZOOM = clamp(SPACE_ZOOM * (dir > 0 ? 1.35 : 1 / 1.35), 1.6, 6);
  followT = 0;                                  // 下一幀就照新的距離移過去
};
W3D.spacePov = function(k){
  if(!SPACE.on || !G || typeof G.toGeoCoords !== 'function') return null;
  const o = SPACE[k]; if(!o) return null;
  const g = G.toGeoCoords({ x: o.position.x, y: o.position.y, z: o.position.z });
  let asp = 1; try{ asp = G.camera().aspect || 1; }catch(e){}
  const fitW = Math.max(1, .9 / asp);                // 直式手機:左右比較窄,站遠一點才塞得下整顆
  const d = Math.min(895, o.position.length() + PLANET_R(k) * SPACE_ZOOM * fitW);
  return { lat: g.lat, lng: g.lng, altitude: d / R - 1 };
};
W3D.spaceInit = spaceInit;
/* 地球畫面上點到的是不是月球 / 火星(連點兩下飛過去用):投影到螢幕,在星球的圓裡(再多 18px)就算 */
W3D.pickSpace = function(cx, cy){
  if(!SPACE.on || !G) return null;
  try{
    const cam = G.camera(), el = G.renderer().domElement, rc = el.getBoundingClientRect();
    const x = cx - rc.left, y = cy - rc.top, V3 = cam.position.constructor;
    let best = null, bd = 1e9;
    for(const k of ['moon', 'mars']){
      const o = SPACE[k], p = o.position.clone();
      if(p.clone().sub(cam.position).dot(new V3(0, 0, -1).applyQuaternion(cam.quaternion)) <= 0) continue;   // 在鏡頭後面
      const e = p.clone().add(new V3(1, 0, 0).applyQuaternion(cam.quaternion).multiplyScalar(PLANET_R(k)));
      p.project(cam); e.project(cam);
      const sx = (p.x + 1) / 2 * rc.width, sy = (1 - p.y) / 2 * rc.height, sr = Math.hypot((e.x - p.x) / 2 * rc.width, (e.y - p.y) / 2 * rc.height);
      const d = Math.hypot(sx - x, sy - y);
      if(d < sr + 18 && d < bd){ bd = d; best = k; }
    }
    return best;
  }catch(e){ return null; }
};
/* 從地球飛過去:鏡頭用 globe.gl 的經緯度 + 高度補間(不會穿過地球),到了再打開那顆星的畫面 */
W3D.flyToPlanet = function(k, done){
  FOLLOW = null;
  const pov = W3D.spacePov(k); if(!pov){ done && done(); return; }
  try{ G.controls().autoRotate = false; G.pointOfView(pov, 1800); }catch(e){}
  tyWake(); sfx('launch', 'tap');
  setTimeout(() => done && done(W3D.handoff(k)), 1850);
};

/* 星空改成像素星星(方的、一格一格,少數亮星有十字光) */
(function(){
  try{
    const c = document.createElement('canvas'); c.width = c.height = 192;
    const x = c.getContext('2d'); if(!x) return;
    let s = 7;
    const r = () => { s = (s * 1103515245 + 12345) >>> 0; return (s >>> 8) / 16777216; };
    for(let i = 0; i < 70; i++){
      const px = Math.floor(r() * 192), py = Math.floor(r() * 192), b = r();
      x.fillStyle = b < .7 ? 'rgba(200,215,240,.55)' : b < .9 ? 'rgba(255,240,200,.8)' : '#ffffff';
      x.fillRect(px, py, 1, 1);
      if(b > .95){ x.fillStyle = 'rgba(255,255,255,.55)'; x.fillRect(px - 1, py, 1, 1); x.fillRect(px + 1, py, 1, 1); x.fillRect(px, py - 1, 1, 1); x.fillRect(px, py + 1, 1, 1); }
    }
    const st = document.createElement('style');
    st.textContent = `.tg-map{background-image:url(${c.toDataURL()}),url(${c.toDataURL()}),radial-gradient(ellipse at 50% 42%,#0f2a40 0%,#08131c 60%,#040a10 100%);
      background-size:192px 192px,384px 384px,100% 100%;background-position:0 0,77px 51px,0 0;image-rendering:pixelated}
      .tg-planet{background:url(${c.toDataURL()}) 0 0/192px 192px,url(${c.toDataURL()}) 77px 51px/384px 384px,radial-gradient(ellipse at 50% 50%,#101c2c 0%,#050a12 70%) !important;image-rendering:pixelated}`;
    document.head.appendChild(st);
  }catch(e){}
})();


/* =============================================================================
   月球 / 火星的獨立畫面 —— 使用者:「火星和月球可以像地球一樣放大縮小、移動旋轉,因為我也會在上面建設」
   -----------------------------------------------------------------------------
   地球的鏡頭永遠繞著地心轉(globe.gl 的控制器),沒辦法拿來轉別顆星。所以跟城市全景一樣,
   另開一個小場景:只有那顆星(同一個體素地形)、它上面的建築、衛星(火衛一二)、背景星空。
     拖曳    轉動星球(抓著表面轉,放開有一點慣性)
     滾輪 / 雙指   放大縮小(從貼近地表到整顆縮小)
     點建築  看它是什麼
   建築**黏在星球表面**、跟著星球轉(之後要在上面蓋東西,位置必須是固定的經緯度)。
   只是畫面,不碰遊戲狀態、不用種子亂數。
   ============================================================================= */
/* 第二版 —— 使用者:「到火星之後不要再切一次鏡頭,卡卡的;到火星要完全跟地球的操作一樣,
   轉的時候背景的地球也會因為鏡頭轉了而在不一樣的位子;火星和月球跟地球一樣的比例尺,因為要在上面建設」。
     · 畫面嵌在地圖那一格裡(頂欄、資源列、手牌都還在),不再是蓋上來的另一個畫面
     · 鏡頭**繞著星球轉**(跟地球一樣:拖曳 = 鏡頭沿經緯度移動、滾輪 / 雙指 / 拉近拉遠 = 高度),
       拉近時鏡頭一樣會傾斜看地平線;星球本身不動,所以背景的地球、月球、星星會跟著鏡頭換位置
     · 星球半徑用 30 格體素(第一版 14),拉近看地形跟看地球差不多細;地形起伏跟著放大
     · 背景的地球、另一顆星的位置照太空場景裡的真實相對位置換算(同一把尺),
       從地球飛過來的最後一格畫面跟這裡的第一格畫面是同一個角度 —— 不會「切一次鏡頭」
   建築黏在星球表面固定的經緯度上。只是畫面,不碰遊戲狀態、不用種子亂數。 */
const PV = { on: false };
const PV_R = { mars: 36, moon: 26 };                 // 火星放大(10 塊建地要放得下)                 // 星球畫面的體素半徑
const BSC = .22;                                    // 建築的縮放:星球大、建築小(跟地球上的城市同一種比例)
const PVG = {};                                     // 幾何快取(每顆星算一次,之後重用)
W3D.planetOn = () => PV.on;
W3D.planetStat = () => PV.on ? PV.stat : null;
/* 基地的零件清單(經緯度 + 名字) */
function baseParts(k, st, run){
  const soil = k === 'mars' ? [176,86,52] : [150,154,162], out = [];
  const add = (fn, lat, lng, nm) => { const B = VB(); fn(B); out.push({ B, lat, lng, nm }); };
  if(k === 'moon'){
    add(B => bHab(B, soil), 0, 0, '🏠 月球居住區');
    add(B => bPad(B, soil), -9, 13, '🚀 登陸場');
    add(B => bSolar(B, soil), 10, -11, '☀ 太陽能板與雷達');
    add(B => bRover(B), -7, -6, '🚙 探測車');
    add(B => bFlag(B, hexRGB(TEAM)), 6, 7, '🚩 你的旗子');
    return out;
  }
  if(st >= 2 || run >= 2) add(B => { bPad(B, soil); const cols = [[229,72,77], [58,123,213], [255,216,74], [238,242,247]];
    for(let i = 0; i < 4; i++) vbox(B, 3 + (i % 2) * 1.3, -3.5 + Math.floor(i / 2) * 1.3, .3, 1.1, 1.1, 1.1, cols[i]); }, -7, 11, '📦 登陸場與物資');
  if(st >= 3){ add(B => bHab(B, soil), 0, 0, '🏠 殖民地居住區'); add(B => bFlag(B, hexRGB(TEAM)), 5, 6, '🚩 你的旗子'); add(B => bRover(B), -6, -4, '🚙 探測車'); }
  if(st >= 4){ add(B => bGreenhouse(B, soil), 10, -8, '🌱 溫室'); add(B => bSolar(B, soil), -12, -11, '☀ 太陽能板與雷達'); add(B => bTower(B, soil), 11, 12, '📡 通訊塔與鑽機'); }
  return out;
}
const LAND_SITE = (k, info) => k === 'mars' && ((info.mars || 0) >= 2 || (info.run || 0) >= 2) ? [-7, 11] : [0, 0];
/* 從地球場景的鏡頭換算成星球畫面的鏡頭(同一個方向、同一個「幾倍半徑」的距離) */
W3D.handoff = function(k){
  if(!SPACE.on || !G) return null;
  try{
    const cam = G.camera(), o = SPACE[k], f = PV_R[k] / PLANET_R(k);
    const rel = cam.position.clone().sub(o.position).applyQuaternion(o.quaternion.clone().invert());
    return { dir: rel.clone().normalize().toArray(), dist: rel.length() * f, fov: cam.fov };
  }catch(e){ return null; }
};
W3D.planetOpen = function(host, k, info){
  W3D.planetClose();
  info = info || {};
  if(!W3D.ok || !G || !T || !hasPX() || !host) return false;
  let rd, scene, cam, sun = null;
  try{
    const RC = G.renderer().constructor, SC = G.scene().constructor, CC = G.camera().constructor;
    rd = new RC({ antialias: false, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: !!W3D._fxHold });
    const gr = G.renderer();
    if('outputColorSpace' in gr) rd.outputColorSpace = gr.outputColorSpace;
    if('outputEncoding' in gr) rd.outputEncoding = gr.outputEncoding;
    scene = new SC();
    cam = new CC((info.from && info.from.fov) || G.camera().fov || 50, 1, .1, 20000);
    let L = [];
    try{ L = G.lights() || []; }catch(e){}
    if(!L.length) G.scene().traverse(o => { if(o.isLight) L.push(o); });
    for(const l of L){
      const n = new l.constructor();
      n.color && l.color && n.color.copy(l.color);
      n.intensity = l.intensity;
      if(n.position && !l.isAmbientLight) sun = n;
      scene.add(n);
    }
  }catch(e){ try{ rd && rd.dispose(); }catch(_){} return false; }
  const geos = [], mats = [];
  const mat = new T.Phong({ vertexColors: true, shininess: 4, side: 2 }); mats.push(mat);
  mat.emissive && mat.emissive.set('#1a2230');
  const own = (B, parent) => { const g = vgeo(B); geos.push(g); const m = new T.Mesh(g, mat); (parent || scene).add(m); return m; };
  const cached = (key, make, parent) => { if(!PVG[key]){ const B = VB(); make(B); PVG[key] = vgeo(B); } const m = new T.Mesh(PVG[key], mat); (parent || scene).add(m); return m; };
  const rad = PV_R[k], f = rad / PLANET_R(k);
  const V3 = cam.position.constructor, Q = cam.quaternion.constructor;
  // 星球(不動)
  /* 基地那一塊(經緯度 0,0 附近)整地:地形在這裡壓平,建築才不會一半埋在山裡、一半懸在坑上 */
  const feat0 = k === 'moon' ? moonFeat : marsFeat, hsc = rad / (k === 'moon' ? MOON_R : MARS_R);
  /* 整地:基地核心(0,0)與每一塊建地的周圍壓平 —— 建地是一塊塊自然的平地,不是排整齊的格子 */
  const pads = [[1, 0, 0, .27, .15], ...((typeof TY_PLOTS !== 'undefined' && TY_PLOTS[k]) || []).map(q => [...dirOf(q.lat, q.lng), .15, .1])];
  const flat = u => { const f0 = feat0(u); let best = 1;
    for(const p of pads){ const d = angD(u, p); if(d < p[3] + p[4]) best = Math.min(best, smooth((d - p[3]) / p[4])); }
    if(best >= 1) return f0;
    return { h: f0.h * best + (.45 / hsc) * (1 - best), c: best < .5 ? (k === 'mars' ? [184,96,60] : [158,162,170]) : f0.c }; };
  cached('p3:' + k, B => vplanet(B, rad, flat, hsc));
  if(k === 'mars'){
    const hm = new T.Phong({ color: 0x000000, emissive: 0xff8a48, transparent: true, opacity: .26, depthWrite: false, side: 1 }); mats.push(hm);
    const hg = sphereGeo(rad * 1.12, 40); geos.push(hg); scene.add(new T.Mesh(hg, hm));
  }
  // 建築:黏在表面
  const picks = [];
  for(const p of (k === 'moon' && !info.moonLanded ? [] : baseParts(k, info.mars || 0, info.run || 0))){
    const m = own(p.B);
    const d = new V3(...dirOf(p.lat, p.lng));
    m.position.copy(d).multiplyScalar(rad + 1);
    m.quaternion.setFromUnitVectors(new V3(0, 0, 1), d);
    m.scale.setScalar(BSC);
    picks.push({ m, nm: p.nm });
  }
  /* 建地:每一塊一圈樁子 + 中間的旗子(空地白旗、你的藍旗、對手是他的顏色),蓋了的放建築 */
  const plotG = new T.O3(); scene.add(plotG);
  const plotPicks = []; let plotKey = '';
  const plotModel = (B, b, soil) => {
    if(b === 'he3' || b === 'mine') bTower(B, soil);
    else if(b === 'port') bPad(B, soil);
    else if(b === 'relay') bSolar(B, soil);
    else if(b === 'dome') bHab(B, soil);
    else if(b === 'green') bGreenhouse(B, soil);
    else if(b === 'lab'){ bFoundation(B, 10, 10, soil); bDome(B, -1.5, 0, .3, 2.6); vbox(B, 2.5, -.3, .3, .5, .5, 8, [200,200,210]); vbox(B, 1.8, -1, 8.3, 2, 2, .4, [238,242,247]); }
  };
  /* 領土:每一塊有主的建地外面一片圓形的地(你的藍色、對手是他的顏色),邊緣一圈實線 ——
     使用者:「也沒有顯示我在火星的領土」。貼著地表的弧面(不是平板),跟著星球彎。 */
  const zoneG = new T.O3(); scene.add(zoneG);
  const zmF = new T.Phong({ vertexColors: true, transparent: true, opacity: .5, depthWrite: false, side: 2,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }); mats.push(zmF);
  const zmB = new T.Phong({ vertexColors: true, transparent: true, opacity: .95, depthWrite: false, side: 2,
    polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 }); mats.push(zmB);
  zmF.emissive && zmF.emissive.set('#303030'); zmB.emissive && zmB.emissive.set('#404040');
  const ZR = rad * .2, ZS = 40, PSC = BSC * 1.7;       // 建地上的建築比基地零件大一號:使用者要看得到自己蓋了什麼
  const ring = (B, r0, r1, col, z0) => {
    const P = (r, t) => [Math.cos(t) * r, Math.sin(t) * r, z0 - r * r / (2 * (rad + 1))];
    for(let j = 0; j < ZS; j++){ const a = j / ZS * Math.PI * 2, b = (j + 1) / ZS * Math.PI * 2;
      vquad(B, P(r0, a), P(r1, a), P(r1, b), P(r0, b), [0, 0, 1], col, 1); }
  };
  const zoneMesh = (d, col, m0, m1, parent) => {
    const BF = VB(); for(let q = 0; q < 6; q++) ring(BF, ZR * q / 6, ZR * (q + 1) / 6, col, .35);
    const BB = VB(); ring(BB, ZR * .9, ZR, col, .45);
    const gF = vgeo(BF), gB = vgeo(BB); zgeos.push(gF, gB);
    const g = new T.O3(); g.add(new T.Mesh(gF, m0)); g.add(new T.Mesh(gB, m1));
    g.position.copy(d).multiplyScalar(rad + 1); g.quaternion.setFromUnitVectors(new V3(0, 0, 1), d);
    parent.add(g); return g;
  };
  /* 拖牌瞄準:每一塊建地一圈白框(空地)/ 紅框(別人的),滑到哪一塊那一塊變黃、放大 */
  const aimG = new T.O3(); aimG.visible = false; scene.add(aimG);
  const amW = new T.Phong({ vertexColors: true, transparent: true, opacity: .9, depthWrite: false, side: 2,
    polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }); mats.push(amW);
  amW.emissive && amW.emissive.set('#707070');
  const aimRings = [], zgeos = [];
  let plotInfo = [], aimOn = false, aimHover = -1;
  const FX = [];
  const buildPlots = plots => {
    const key = JSON.stringify((plots || []).map(p => [p.o, p.b, p.col]));
    if(key === plotKey) return; plotKey = key;
    plotInfo = plots || [];
    while(plotG.children.length){ const o = plotG.children.pop(); o.geometry && o.geometry.dispose(); }
    while(zgeos.length) zgeos.pop().dispose();
    while(zoneG.children.length) zoneG.children.pop();
    while(aimG.children.length) aimG.children.pop();
    aimRings.length = 0;
    (plots || []).forEach((p, i) => {
      const d = new V3(...dirOf(p.lat, p.lng));
      if(p.o) zoneMesh(d, p.col.split(',').map(Number), zmF, zmB, zoneG);
      const BA = VB(); ring(BA, ZR * .82, ZR * 1.02, p.o ? [255,90,80] : [240,244,250], .6);
      const gA = vgeo(BA); zgeos.push(gA); const am = new T.Mesh(gA, amW);
      am.position.copy(d).multiplyScalar(rad + 1); am.quaternion.setFromUnitVectors(new V3(0, 0, 1), d);
      aimG.add(am); aimRings.push(am);
    });
    plotPicks.length = 0;
    const soil = k === 'mars' ? [184,96,60] : [158,162,170];
    (plots || []).forEach((p, i) => {
      const B = VB(), col = p.col ? p.col.split(',').map(Number) : [238,242,247];
      // 一圈樁子(8 根)標出建地範圍
      for(let a = 0; a < 8; a++){ const t = a / 8 * Math.PI * 2; vbox(B, Math.cos(t) * 13 - .5, Math.sin(t) * 13 - .5, 0, 1, 1, 2.2, p.o ? col : [230,230,236]); }
      if(p.b) plotModel(B, p.b, soil);
      const fx = p.b ? 9 : 0;                               // 旗子:空地在正中央,蓋了的放在建築旁邊
      vbox(B, fx, -9, 0, .5, .5, 9, [220,220,230]); vbox(B, fx + .5, -9.1, 6, 4, .3, 2.6, col);
      const g = vgeo(B), m = new T.Mesh(g, mat);
      const d = new V3(...dirOf(p.lat, p.lng));
      m.position.copy(d).multiplyScalar(rad + 1);
      m.quaternion.setFromUnitVectors(new V3(0, 0, 1), d);
      m.scale.setScalar(PSC);
      plotG.add(m);
      plotPicks.push({ m, i, tag: p.tag || '' });
    });
  };
  buildPlots(info.plots);
  W3D.planetPlots = inf => { if(inf) buildPlots(inf.plots); };
  /* ---- 拖牌到建地(跟地球拖到城市同一種手感) ---- */
  const plotNear = (cx, cy, lim) => {
    const r = host.getBoundingClientRect(), x = cx - r.left, y = cy - r.top;
    let bp = -1, bd = lim;
    for(const p of plotPicks){ const w = p.m.getWorldPosition(new V3()); if(w.dot(cam.position) < rad * rad * .9) continue;
      const s = proj(w); const d = Math.hypot(s[0] - x, s[1] - y); if(d < bd){ bd = d; bp = p.i; } }
    return bp;
  };
  W3D.planetAim = on => { aimOn = !!on; aimG.visible = aimOn; aimHover = -1; if(!aimOn){ tip.hidden = true; for(const m of aimRings) m.scale.setScalar(1); } };
  W3D.planetAimAt = (cx, cy) => {
    if(!aimOn) return -1;
    const i = plotNear(cx, cy, 80);
    if(i !== aimHover){
      aimHover = i; if(i >= 0) sfx('pick', 'tap');
      aimRings.forEach((m, j) => m.scale.setScalar(j === i ? 1.25 : 1));
      if(i >= 0){ const q = plotInfo[i] || {}; sel = plotPicks.find(p => p.i === i).m; tip.hidden = false;
        tip.textContent = `${q.nm || '建地'} · ${q.o === 'me' ? '你的' : q.o ? '別人的(可以強行收購)' : '空地 —— 放開就選這塊'}`; }
      else tip.hidden = true;
    }
    return i;
  };
  W3D.planetAimDrop = (cx, cy) => { const i = aimOn ? plotNear(cx, cy, 80) : -1; W3D.planetAim(false); return i; };
  /* ---- 蓋好的回饋:建築一格一格長出來 + 衝擊圈 + 碎片往外噴,鏡頭轉過去 ---- */
  W3D.planetBuildFx = i => {
    const p = plotPicks.find(q => q.i === i); if(!p) return;
    const d = p.m.getWorldPosition(new V3()).normalize(), now = performance.now();
    const la0 = lat, lo0 = lng; setFromDir(d.clone().add(new V3(0, -.12, 0)).normalize());
    const la1 = lat; let dl = lng - lo0; while(dl > 180) dl -= 360; while(dl < -180) dl += 360; lat = la0; lng = lo0;
    tween = { t0: now, dur: 700, la0, lo0, d0: dist, la1, lo1: lo0 + dl, d1: Math.min(dist, rad * 2.1 * Math.max(1, .95 / cam.aspect)) };      // 直式手機站遠一點,不然整個畫面只剩那一塊
    FX.push({ k: 'grow', m: p.m, t0: now + 500 });
    const col = (plotInfo[i] && plotInfo[i].col ? plotInfo[i].col.split(',').map(Number) : [41,151,255]);
    const BS = VB(); ring(BS, ZR * .85, ZR, col, .7); const gS = vgeo(BS); geos.push(gS);
    const shock = new T.Mesh(gS, zmB); shock.position.copy(d).multiplyScalar(rad + 1); shock.quaternion.setFromUnitVectors(new V3(0, 0, 1), d);
    scene.add(shock); shock.scale.setScalar(.2);
    FX.push({ k: 'shock', m: shock, t0: now + 500 });
    for(let n = 0; n < 16; n++){ const B = VB(); vbox(B, -.35, -.35, 0, .7, .7, .7, n % 3 ? [255,216,74] : [255,255,255]);
      const m = own(B); m.visible = false; FX.push({ k: 'bit', m, d, a: n / 16 * Math.PI * 2, t0: now + 500 + (n % 4) * 40 }); }
  };
  /* 背景:地球、另一顆星、火衛 —— 位置照太空場景的真實相對位置(同一把尺,換到星球的座標系) */
  const inv = SPACE.on ? SPACE[k].quaternion.clone().invert() : new Q();
  const toLocal = w => w.clone().sub(SPACE[k].position).applyQuaternion(inv).multiplyScalar(f);
  const bg = [];
  if(SPACE.on){
    const earth = cached('earth', B => vplanet(B, 24, u => { const lat = Math.asin(u[2]) * 180 / Math.PI, lng = Math.atan2(u[1], u[0]) * 180 / Math.PI;
      const land = !!W3D.featAt(lat, lng); return { h: land ? .6 : 0, c: Math.abs(lat) > 70 ? [236,240,246] : land ? (Math.abs(lat) < 25 && snoise(u[0]*4,u[1]*4,u[2]*4,5) > .55 ? [196,170,110] : [86,150,72]) : [52,110,190] }; }));
    earth.scale.setScalar(R * f / 24); earth.position.copy(toLocal(new V3(0, 0, 0)));
    // three-globe 的座標:北極 = +y;體素地球的北極是 +z → 轉一下
    earth.quaternion.copy(inv).multiply(new Q().setFromUnitVectors(new V3(0, 0, 1), new V3(0, 1, 0)));
    bg.push({ m: earth, k: 'earth', r: R * f });
    const other = k === 'mars' ? 'moon' : 'mars';
    const o = cached('pl:' + other, B => vplanet(B, other === 'moon' ? MOON_R : MARS_R, other === 'moon' ? moonFeat : marsFeat));
    o.scale.setScalar((other === 'moon' ? MOON_S : MARS_S) * f); o.position.copy(toLocal(SPACE[other].position));
    bg.push({ m: o, k: other, r: PLANET_R(other) * f });
  }
  const moons = [];
  if(k === 'mars') for(const [r0, seed, dist, w] of [[2.4, 31, rad * 2.3, .2], [1.7, 41, rad * 3.3, .08]]){
    const m = cached('lump:' + seed, B => vplanet(B, r0, u => ({ h: (snoise(u[0] * 3, u[1] * 3, u[2] * 3, seed) - .5) * 1.6, c: snoise(u[0] * 6, u[1] * 6, u[2] * 6, seed + 1) < .5 ? [120,104,92] : [150,132,116] })));
    m.scale.setScalar(1.3); moons.push({ m, dist, w });
  }
  // 星星:遠處一圈小方塊(跟著鏡頭轉的時候會移動 —— 不是貼在背景上的圖)
  cached('stars', B => { let s0 = 11; const r = () => { s0 = (s0 * 1103515245 + 12345) >>> 0; return (s0 >>> 8) / 16777216; };
    for(let i = 0; i < 700; i++){ const z = r() * 2 - 1, t = r() * Math.PI * 2, q = Math.sqrt(1 - z * z), D = 9000, sz = 9 + r() * 14, b = 150 + r() * 105;
      const cx = q * Math.cos(t) * D, cy = q * Math.sin(t) * D, cz = z * D;
      vbox(B, cx - sz / 2, cy - sz / 2, cz - sz / 2, sz, sz, sz, [b, b, Math.min(255, b + 20)]); } });
  const cvs = rd.domElement; cvs.className = 'pv-canvas'; host.appendChild(cvs);
  const tip = document.createElement('div'); tip.className = 'cv-tip'; tip.hidden = true; host.appendChild(tip);

  /* ---- 鏡頭:跟地球一樣繞著星球的中心 ---- */
  let lat, lng, dist, W = 1, H = 1, vx = 0, vy = 0, last = performance.now(), tween = null, back = null;
  const MIN = rad * 1.18, MAX = rad * 9;
  const site = LAND_SITE(k, info), siteD = new V3(...dirOf(site[0], site[1]));
  const setFromDir = (d) => { lat = Math.asin(clamp(d.y, -1, 1)) * 180 / Math.PI; lng = Math.atan2(d.x, d.z) * 180 / Math.PI; };
  const dirOfCam = (la, lo) => { const a = la * Math.PI / 180, b = lo * Math.PI / 180; return new V3(Math.cos(a) * Math.sin(b), Math.sin(a), Math.cos(a) * Math.cos(b)); };
  if(info.from){ setFromDir(new V3(...info.from.dir)); dist = clamp(info.from.dist, MIN, MAX * 1.5); }
  else { setFromDir(siteD.clone().add(new V3(0, -.25, 0)).normalize()); dist = 0; }       // 距離等 fit() 依畫面比例決定
  if(info.landing || info.from){
    // 從飛來的那一格,平順地拉到基地(著陸)上空
    const to = siteD.clone().add(new V3(0, -.09, 0)).normalize(), la0 = lat, lo0 = lng, d0 = dist || rad * 3;
    const t2 = {}; setFromDir.call(null, to); t2.lat = lat; t2.lng = lng; lat = la0; lng = lo0;
    let dl = t2.lng - lo0; while(dl > 180) dl -= 360; while(dl < -180) dl += 360;
    tween = { t0: performance.now(), dur: info.landing ? 2600 : 1400, la0, lo0, d0, la1: t2.lat, lo1: lo0 + dl, d1: rad * (info.landing ? 1.6 : 2.8) };
  }
  const fit = () => {
    W = Math.max(1, host.clientWidth); H = Math.max(1, host.clientHeight);
    cam.aspect = W / H; cam.updateProjectionMatrix();
    rd.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    rd.setSize(W, H, false);
    if(!dist) dist = rad * 3.2 * Math.max(1, .95 / cam.aspect);       // 直式手機左右比較窄,站遠一點
  };
  fit();
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null; if(ro) ro.observe(host);
  const alt = () => dist / rad - 1;
  const place = () => {
    const n = dirOfCam(lat, lng);
    const S = n.clone().multiplyScalar(rad);
    // 跟地球的傾斜鏡頭同一套:貼近地表時往南挪、往北看地平線
    const t = TILT_MAX * smooth((.9 - alt()) / (.9 - .25));
    if(t > 1e-3){
      const north = new V3(0, 1, 0).addScaledVector(n, -n.y); if(north.lengthSq() < 1e-6) north.set(0, 0, -1); north.normalize();
      const h = dist - rad;
      cam.position.copy(S).addScaledVector(n, h * Math.cos(t)).addScaledVector(north, -h * Math.sin(t));
      cam.up.copy(north).multiplyScalar(Math.cos(t)).addScaledVector(n, Math.sin(t)).normalize();
      cam.lookAt(S);
    }else{ cam.position.copy(n).multiplyScalar(dist); cam.up.set(0, 1, 0); cam.lookAt(0, 0, 0); }
    if(sun){ sun.position.copy(cam.position).multiplyScalar(1.2); sun.position.x += -cam.position.z * .6; sun.position.z += cam.position.x * .6; sun.position.y += dist * .7; }
  };
  /* 拖曳:鏡頭沿著經緯度走(越近走越慢 —— 跟地球的控制器一樣的手感) */
  const pan = (dx, dy) => { const k2 = .25 * clamp(alt(), .03, 3); lng -= dx * k2; lat = clamp(lat + dy * k2, -85, 85); };
  const ptrs = new Map(); let pinch = 0, moved = 0, lastTap = 0, lastTapK = null;
  const onDown = e => { ptrs.set(e.pointerId, [e.clientX, e.clientY]); moved = 0; vx = vy = 0; tween = null; try{ cvs.setPointerCapture(e.pointerId); }catch(_){}
    if(ptrs.size === 2){ const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); } };
  const onMove = e => {
    const p = ptrs.get(e.pointerId); if(!p) return;
    const dx = e.clientX - p[0], dy = e.clientY - p[1];
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if(ptrs.size === 2){ const [a, b] = [...ptrs.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if(pinch) dist = clamp(rad + (dist - rad) * pinch / Math.max(1, d), MIN, MAX); pinch = d; moved += 10; return; }
    moved += Math.abs(dx) + Math.abs(dy);
    pan(dx, dy); vx = dx; vy = dy;
  };
  const onUp = e => {
    ptrs.delete(e.pointerId); pinch = 0;
    if(moved >= 8 || e.target !== cvs) return;
    const hit = hitBg(e.clientX, e.clientY), now = performance.now();
    if(hit && lastTapK === hit && now - lastTap < 450){ lastTapK = null; if(hit === 'earth') W3D.planetBack(); else { try{ tyOpenPlanet(hit, { from: 'switch' }); }catch(_){} } return; }
    lastTap = now; lastTapK = hit;
    if(hit){ tip.hidden = false; tip.textContent = hit === 'earth' ? '🌍 地球 —— 連點兩下飛回去' : hit === 'moon' ? '🌙 月球 —— 連點兩下飛過去' : '🔴 火星 —— 連點兩下飛過去'; sel = bg.find(b => b.k === hit).m; }
    else pickAt(e.clientX, e.clientY);
  };
  // 滾輪:跟地球一樣,越近每一格走越少(用「離地高度」縮放)
  const onWheel = e => { e.preventDefault(); tween = null; dist = clamp(rad + (dist - rad) * Math.exp(e.deltaY * .0015), MIN, MAX); };
  cvs.addEventListener('pointerdown', onDown); cvs.addEventListener('pointermove', onMove);
  cvs.addEventListener('pointerup', onUp); cvs.addEventListener('pointercancel', onUp);
  cvs.addEventListener('wheel', onWheel, { passive: false });
  const tmp = new V3();
  const proj = v => { tmp.copy(v).project(cam); return [(tmp.x + 1) / 2 * W, (1 - tmp.y) / 2 * H, tmp.z]; };
  function hitBg(cx, cy){
    const r = host.getBoundingClientRect(), x = cx - r.left, y = cy - r.top, right = new V3().setFromMatrixColumn(cam.matrixWorld, 0);
    for(const b of bg){ const s0 = proj(b.m.position); if(s0[2] > 1) continue;
      const s1 = proj(b.m.position.clone().addScaledVector(right, b.r)); if(Math.hypot(s0[0] - x, s0[1] - y) < Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) + 20) return b.k; }
    return null;
  }
  let sel = null;
  function pickAt(cx, cy){
    const r = host.getBoundingClientRect(), x = cx - r.left, y = cy - r.top;
    // 建地優先:點到一塊建地 → 開出牌面板(蓋、收購、登月)
    let bp = null, bpd = 60;
    for(const p of plotPicks){ const w = p.m.getWorldPosition(new V3()); if(w.dot(cam.position) < rad * rad * .9) continue; const s = proj(w); const d = Math.hypot(s[0] - x, s[1] - y); if(d < bpd){ bpd = d; bp = p; } }
    if(bp){ sel = bp.m; tip.hidden = false; tip.textContent = bp.tag; try{ if(typeof tySpacePlot === 'function') tySpacePlot(k, bp.i); }catch(e){} return; }
    let best = null, bd = 50;
    for(const p of picks){ const w = p.m.getWorldPosition(new V3()); if(w.dot(cam.position) < rad * rad * .9) continue; const s = proj(w); const d = Math.hypot(s[0] - x, s[1] - y); if(d < bd){ bd = d; best = p; } }
    sel = best ? best.m : null; tip.hidden = !best; if(best){ tip.textContent = best.nm; sfx('pick', 'tap'); }
  }
  W3D.planetZoom = dir => { tween = null; dist = clamp(rad + (dist - rad) * (dir > 0 ? 1.55 : 1 / 1.55), MIN, MAX); };
  W3D._planetSpin = (dx, dy) => pan(dx, dy);
  W3D._planetZoom = fz => { dist = clamp(rad + (dist - rad) * fz, MIN, MAX); };
  W3D.planetBack = () => { if(back) return; back = performance.now(); tween = null; sfx('launch', 'tap'); };
  W3D.planetView = () => ({ lat, lng, alt: alt() });

  /* 著陸:登陸艇從上空一路減速降到登陸場(反推火焰)、落地揚起沙塵 */
  let LAND = null;
  if(info.landing){
    const sp = PX.SPR.rocket, LB = VB(); voxAdd(LB, sp, null, { x: -sp.w / 2, y: -1.5, z: 0 }, 3, false);
    const lander = own(LB); lander.scale.setScalar(BSC * .8);
    lander.quaternion.setFromUnitVectors(new V3(0, 0, 1), siteD);
    const FB = VB(); vbox(FB, -1.2, -1.2, -5, 2.4, 2.4, 5, [255,170,60]); vbox(FB, -.6, -.6, -8, 1.2, 1.2, 3, [255,230,120]);
    const flame = own(FB, lander);
    LAND = { lander, flame, t0: performance.now() + 600, dust: [], done: false };
  }
  W3D._landBusy = () => PV.on && !!((LAND && !LAND.done) || (tween && info.landing));
  W3D._landSkip = () => {
    let did = false;
    if(tween && info.landing){ lat = tween.la1; lng = tween.lo1; dist = tween.d1; tween = null; did = true; }
    if(LAND && !LAND.done && PV.on){ LAND.el = 3600; did = true; }
    return did;
  };
  let raf = 0;
  const frame = now => {
    raf = requestAnimationFrame(frame);
    if(document.hidden) return;
    const dtL = Math.min(100, Math.max(0, now - last)); last = now;     // 第五十一輪:著陸用累加時間(每幀最多 0.1 秒),慢裝置不會一卡就跳完
    if(back){ dist = Math.min(MAX * 3, dist * 1.07); if(now - back > 650){ back = null; try{ tyClosePlanet(false, k); }catch(e){} return; } }
    else if(tween){
      tween.el = (tween.el || 0) + dtL;
      const u = clamp(tween.el / tween.dur, 0, 1), e = smooth(u);
      lat = tween.la0 + (tween.la1 - tween.la0) * e; lng = tween.lo0 + (tween.lo1 - tween.lo0) * e; dist = tween.d0 + (tween.d1 - tween.d0) * e;
      if(u >= 1) tween = null;
    }else if(!ptrs.size && (Math.abs(vx) + Math.abs(vy) > .05)){ pan(vx, vy); vx *= .88; vy *= .88; }    // 放開後的慣性(跟地球一樣會滑一下)
    if(LAND && !LAND.done){
      LAND.el = (LAND.el || 0) + dtL;
      const u = clamp((LAND.el - 600) / 3000, 0, 1), e = 1 - Math.pow(1 - u, 3);
      LAND.lander.position.copy(siteD).multiplyScalar(rad + 1 + (1 - e) * rad * .7);
      LAND.flame.visible = u < 1 && ((now / 70) | 0) % 2 === 0;
      LAND.flame.scale.set(1, 1, .6 + (1 - e) * .8);
      if(u >= 1){
        LAND.done = true; LAND.flame.visible = false;
        sfx('drop', 'land'); setTimeout(() => sfx('upgrade', 'tap'), 400);
        tip.hidden = false; tip.textContent = '🚀 著陸成功'; sel = LAND.lander;
        for(let i = 0; i < 12; i++){ const B = VB(); vbox(B, -.3, -.3, 0, .6, .6, .6, k === 'mars' ? [214,140,96] : [200,204,210]);
          const m = own(B); LAND.dust.push({ m, a: i / 12 * Math.PI * 2, t0: now }); }
      }
    }
    if(LAND) for(const p of LAND.dust){
      const u = (now - p.t0) / 1000; if(u > 1){ p.m.visible = false; continue; }
      const t1 = new V3(-siteD.y, siteD.x, 0).normalize(), t2 = siteD.clone().cross(t1);
      p.m.position.copy(siteD).multiplyScalar(rad + 1.1 + u * .8).addScaledVector(t1, Math.cos(p.a) * u * 3.5).addScaledVector(t2, Math.sin(p.a) * u * 3.5);
      p.m.scale.setScalar(Math.max(.05, 1 - u));
    }
    for(let n = FX.length - 1; n >= 0; n--){
      const f = FX[n], u = (now - f.t0) / (f.k === 'grow' ? 800 : 900);
      if(u < 0) continue;
      if(f.k === 'grow'){ const st = Math.min(1, Math.floor(u * 8) / 8); f.m.scale.setScalar(PSC * Math.max(.05, st < 1 ? st * 1.12 : 1)); if(u >= 1){ f.m.scale.setScalar(PSC); FX.splice(n, 1); } }
      else if(f.k === 'shock'){ f.m.scale.setScalar(.2 + u * 1.6); f.m.visible = u < 1 && ((now / 60) | 0) % 2 === 0 || u < .5; if(u >= 1){ scene.remove(f.m); FX.splice(n, 1); } }
      else if(f.k === 'bit'){
        f.m.visible = u < 1;
        const t1 = new V3(-f.d.y, f.d.x, 0).normalize(), t2 = f.d.clone().cross(t1);
        f.m.position.copy(f.d).multiplyScalar(rad + 1.2 + Math.sin(Math.min(1, u) * Math.PI) * 3).addScaledVector(t1, Math.cos(f.a) * u * 6).addScaledVector(t2, Math.sin(f.a) * u * 6);
        f.m.scale.setScalar(Math.max(.05, 1 - u)); if(u >= 1){ scene.remove(f.m); FX.splice(n, 1); }
      }
    }
    if(aimOn){ const pulse = 1 + Math.sin(now / 180) * .04; aimRings.forEach((m, j) => { if(j !== aimHover) m.scale.setScalar(pulse); }); }
    for(const o of moons){ const a = now / 1000 * o.w; o.m.position.set(Math.cos(a) * o.dist, Math.sin(a) * o.dist * .2, Math.sin(a) * o.dist); o.m.rotation.y = a; }
    place();
    rd.render(scene, cam);
    if(sel && !tip.hidden){ const w = sel.getWorldPosition(new V3()); const s = proj(w);
      tip.style.transform = `translate(${Math.round(s[0])}px,${Math.round(s[1] - 34)}px) translate(-50%,-100%)`; }
  };
  raf = requestAnimationFrame(frame);
  PV.on = true; PV.k = k;
  PV.stat = { k, parts: picks.map(p => p.nm), moons: moons.length, bg: bg.map(b => b.k), rad, plots: () => plotPicks.length };
  W3D._plotScreen = i => { const p = plotPicks.find(q => q.i === i); if(!p) return null; const w = p.m.getWorldPosition(new V3()); const s = proj(w); const r = host.getBoundingClientRect(); return { x: s[0] + r.left, y: s[1] + r.top, front: w.dot(cam.position) > rad * rad }; };
  W3D._plotZones = () => zoneG.children.length;
  W3D._planetLook = i => { const p = plotPicks.find(q => q.i === i); if(!p) return; setFromDir(p.m.getWorldPosition(new V3()).normalize()); tween = null; };
  PV.close = () => {
    cancelAnimationFrame(raf); if(ro) ro.disconnect();
    cvs.removeEventListener('wheel', onWheel);
    for(const g of geos) g.dispose(); for(const g of zgeos) g.dispose(); for(const m of mats) m.dispose();
    W3D.planetAim = W3D.planetAimAt = W3D.planetAimDrop = W3D.planetBuildFx = null;
    try{ rd.dispose(); rd.forceContextLoss && rd.forceContextLoss(); }catch(e){}
    cvs.remove(); tip.remove();
  };
  return true;
};
W3D.planetClose = function(){
  if(!PV.on) return;
  PV.on = false;
  try{ PV.close(); }catch(e){}
  PV.close = null;
};
/* 回到地球的那一刻:地球這邊的鏡頭先擺在「那顆星旁邊」(跟星球畫面最後一格同一個角度),再拉回大本營 */
W3D.returnFrom = function(k, home, alt){
  try{
    const pov = W3D.spacePov(k);
    if(pov) G.pointOfView({ ...pov, altitude: Math.min(pov.altitude * 1.25, 8) }, 0);
    setTimeout(() => { try{ G.pointOfView({ lat: home.lat, lng: home.lng, altitude: alt }, 1900); }catch(e){} }, 30);
  }catch(e){}
  FOLLOW = null; tyWake();
};


})();
