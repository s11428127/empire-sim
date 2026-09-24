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
const TILT_MAX = 56 * Math.PI / 180;           // 貼到最近時鏡頭壓多低
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
      Color: gm.color.constructor,
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
   1. 地球的皮
   -----------------------------------------------------------------------------
   一張等距圓柱投影的貼圖：x = 經度、y = 緯度。
   畫的順序就是一張手繪沙盤的順序 —— 深海 → 大陸棚的淺色光暈 → 陸地底色
   → 依緯度疊上的地貌色帶（極地、針葉林、溫帶、沙漠帶、雨林）→ 雜點質感
   → 海岸線。國界不畫在貼圖上，那是 globe.gl 的多邊形層的工作。
   ============================================================================= */
function landPath(ctx, feats, W, H){
  const X = lng => (lng + 180) / 360 * W, Y = lat => (90 - lat) / 180 * H;
  ctx.beginPath();
  for(const f of feats){
    const g = f.geometry; if(!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for(const poly of polys) for(const ring of poly){
      ring.forEach(([lng,lat], i) => i ? ctx.lineTo(X(lng), Y(lat)) : ctx.moveTo(X(lng), Y(lat)));
      ctx.closePath();
    }
  }
}
function makeSkin(feats){
  const small = Math.min(innerWidth, innerHeight) < 700;
  const W = small ? 2048 : 4096, H = W / 2;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  const rnd = vrand(20260924);

  // 深海：赤道稍亮、兩極壓暗
  const sea = c.createLinearGradient(0, 0, 0, H);
  sea.addColorStop(0, '#0a2438'); sea.addColorStop(.3, '#0e3a58');
  sea.addColorStop(.5, '#114566'); sea.addColorStop(.7, '#0e3a58'); sea.addColorStop(1, '#0a2438');
  c.fillStyle = sea; c.fillRect(0, 0, W, H);
  // 海面的深淺斑
  for(let i = 0; i < 260; i++){
    const x = rnd()*W, y = rnd()*H, r = (0.02 + rnd()*0.06) * W;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    const a = rnd() < .5 ? 'rgba(30,110,150,.10)' : 'rgba(4,20,34,.14)';
    g.addColorStop(0, a); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(x-r, y-r, r*2, r*2);
  }
  // 大陸棚：陸地外圍一圈淺色 —— 用陰影模糊畫兩次，一寬一窄
  landPath(c, feats, W, H);
  c.save();
  c.fillStyle = '#1b6f8c';
  c.shadowColor = 'rgba(60,170,200,.55)'; c.shadowBlur = W / 90; c.fill();
  c.shadowColor = 'rgba(110,210,225,.5)'; c.shadowBlur = W / 400; c.fill();
  c.restore();

  // 陸地
  c.save();
  landPath(c, feats, W, H); c.clip();
  c.fillStyle = '#3b5a3c'; c.fillRect(0, 0, W, H);
  /* 地貌色帶。只是依緯度的粗略分帶 —— 這是一張遊戲沙盤，不是衛星圖；
     目的只是讓「撒哈拉」與「西伯利亞」一眼看得出不是同一種地方。 */
  const band = c.createLinearGradient(0, 0, 0, H);
  const st = (lat, col) => band.addColorStop((90 - lat) / 180, col);
  st(90, 'rgba(214,226,230,.95)'); st(68, 'rgba(160,178,170,.75)'); st(60, 'rgba(58,86,62,.55)');
  st(45, 'rgba(78,108,64,.45)'); st(33, 'rgba(146,128,78,.55)'); st(23, 'rgba(176,146,90,.72)');
  st(14, 'rgba(120,122,70,.45)'); st(4, 'rgba(46,96,52,.6)'); st(-6, 'rgba(46,96,52,.6)');
  st(-18, 'rgba(118,118,70,.45)'); st(-26, 'rgba(170,140,88,.62)'); st(-38, 'rgba(84,110,66,.45)');
  st(-60, 'rgba(160,178,170,.75)'); st(-90, 'rgba(220,230,234,.95)');
  c.fillStyle = band; c.fillRect(0, 0, W, H);
  // 山脈與平原的斑塊：大小不一的亮暗團，看起來像有高低
  for(let i = 0; i < 1400; i++){
    const x = rnd()*W, y = rnd()*H, r = (0.004 + rnd()*rnd()*0.03) * W;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    const light = rnd() < .45;
    g.addColorStop(0, light ? 'rgba(236,226,190,.16)' : 'rgba(10,26,14,.2)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(x-r, y-r, r*2, r*2);
  }
  // 細顆粒
  for(let i = 0; i < 26000; i++){
    c.fillStyle = rnd() < .5 ? 'rgba(255,248,220,.07)' : 'rgba(0,0,0,.09)';
    c.fillRect(rnd()*W, rnd()*H, 1 + rnd()*2, 1 + rnd()*2);
  }
  c.restore();

  // 海岸線：一道亮邊，讓陸地「浮」在海上
  landPath(c, feats, W, H);
  c.lineWidth = W / 2048; c.strokeStyle = 'rgba(190,230,215,.55)'; c.stroke();

  /* 凹凸貼圖：只有陸地有起伏，海是平的。同一組斑塊再畫一次灰階版本。 */
  const bw = 1024, bh = 512;
  const bv = document.createElement('canvas'); bv.width = bw; bv.height = bh;
  const b = bv.getContext('2d');
  b.fillStyle = '#000'; b.fillRect(0, 0, bw, bh);
  b.save(); landPath(b, feats, bw, bh); b.clip();
  b.fillStyle = '#404040'; b.fillRect(0, 0, bw, bh);
  const r2 = vrand(7);
  for(let i = 0; i < 900; i++){
    const x = r2()*bw, y = r2()*bh, r = (0.004 + r2()*r2()*0.04) * bw;
    const g = b.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${(.15 + r2()*.35).toFixed(2)})`); g.addColorStop(1, 'rgba(255,255,255,0)');
    b.fillStyle = g; b.fillRect(x-r, y-r, r*2, r*2);
  }
  b.restore();

  return { map: cv.toDataURL('image/jpeg', .9), bump: bv.toDataURL('image/jpeg', .85) };
}

let painting = false;
function paintSkin(){
  if(W3D.textured || painting || !G) return;
  if(typeof countries === 'undefined' || !countries || !countries.length) return;
  painting = true;
  /* 貼圖要畫大約半秒 —— 丟到下一個閒置時段，不要卡住第一次顯示 */
  const run = () => {
    try{
      const s = makeSkin(countries);
      G.globeImageUrl(s.map);
      if(typeof G.bumpImageUrl === 'function') G.bumpImageUrl(s.bump);
      W3D.textured = true;
      W3D.material();
      if(typeof tyPaintGlobe === 'function') tyPaintGlobe();
    }catch(e){ W3D.textured = false; }
    painting = false;
  };
  /* ⚠ 一定要給 timeout:地球每一幀都在畫，瀏覽器可能永遠等不到「閒置」，
     沒有 timeout 的話這張貼圖永遠不會畫。 */
  if(window.requestIdleCallback) requestIdleCallback(run, { timeout: 400 });
  else setTimeout(run, 60);
}

/* 有貼圖之後，材質的底色要是白的（貼圖會被底色相乘），
   原本「永遠是夜晚」的深藍底色會把整張沙盤壓成一片黑。 */
W3D.material = function(){
  if(!G || !W3D.textured) return false;
  try{
    const m = G.globeMaterial();
    m.color && m.color.set('#ffffff');
    m.emissive && m.emissive.set('#0b1a24');
    if('shininess' in m) m.shininess = 6;
    if('bumpScale' in m) m.bumpScale = 3.5;
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

/* 一個據點（或一個對手大本營）的整座小城 */
function buildSite(d){
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
const bScale = () => clamp(.1 + W3D.alt * 2.4, .3, 5.5);
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
  applyScale(obj, performance.now());
}
function applyScale(obj, now){
  const s = bScale();
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
    const t = TILT_MAX * smooth((1.3 - alt) / (1.3 - .28));
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
      if(lights[0]) lights[0].intensity = Math.PI * .62;
      if(lights[1]) lights[1].intensity = Math.PI * 1.05;
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
        if(d._rival){ TY_RIVAL = d._rival.id; TY_DEAL = null; TY_MODAL = 'rival'; renderPage(); }
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
    W3D.ok = true;
    const host = document.getElementById('tyGlobeHost');
    if(host) host.dataset.w3d = '1';
  }catch(e){ W3D.ok = false; }
  return W3D.ok;
};

/* 每次 tyGlobeData() 算完標記之後呼叫：把我的據點與對手大本營蓋成 3D。 */
W3D.sites = function(mine, rivals){
  if(!W3D.ok) return;
  paintSkin();
  const rvMax = Math.max(1, ...rivals.map(r => r._v || 0));
  rivals.forEach(r => { r._rvk = Math.sqrt((r._v || 0) / rvMax); });
  G.customLayerData([...mine, ...rivals]);
  W3D._warm = true;           // 第一批是開局就有的，不要全部從地上長出來
  W3D.rings();
};

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
  G.ringsData(out.concat(W3D.extraRings));
};

W3D.onZoom = function(pov){
  if(!W3D.ok) return;
  if(!W3D._logical && pov && isFinite(pov.altitude)) W3D.alt = pov.altitude;
  rescaleAll();
};

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
