/* =============================================================================
   pixel.js —— 像素圖庫
   -----------------------------------------------------------------------------
   使用者:「我想要全部變成像素風格,包含所有建築、軍事」。
   所有像素圖都在這裡用字串畫(一個字元 = 一個像素,對照下面的調色盤),
   卡牌(DOM)和地球上的看板(world3d.js 的貼圖)用的是**同一張圖**。

   三種來源:
     ① 手畫的固定圖(房子、金條、坦克、飛機、地標…)
     ② 產生器:事業塔樓依「高度」長出不同樓層數 —— 高度就是規模(見 index 的 tyHeightScale)
     ③ 組合:一座城的所有建築並排在一塊地上,拼成一張圖

   ⚠ 'T' / 't' 是「隊伍色」:畫的時候換成你(藍)或對手的顏色(淺 / 深)。
   ⚠ 這個檔案只畫圖,不碰遊戲狀態。
   ============================================================================= */
(function(){
'use strict';
const PX = window.PX = {};

const PAL = {
  k:'#141821', K:'#2a3140', G:'#566074', g:'#9aa5b8', w:'#eef2f7',
  r:'#e5484d', R:'#8f2328', o:'#f59f3a', O:'#a3561b', y:'#ffd84a', Y:'#c49a1c',
  n:'#46c46a', N:'#1f7a3e', c:'#7fd8ff', b:'#3a7bd5', B:'#1f3f7a', p:'#b36bff', P:'#6a2fb3',
  m:'#a0703f', M:'#5e3b1c', s:'#f0c79a', l:'#ffe9a8', e:'#d9dde6', q:'#ff8fb8', v:'#5fd0b0',
};
PX.PAL = PAL;

/* ---------- 基本:字串 → 圖 ---------- */
function S(rows){
  const w = Math.max(...rows.map(r => r.length));
  return { w, h: rows.length, rows: rows.map(r => r.padEnd(w, '.')) };
}
// 水平置中補齊到同寬(疊圖用)
function center(sp, w){
  if(sp.w >= w) return sp;
  const l = Math.floor((w - sp.w) / 2);
  return S(sp.rows.map(r => '.'.repeat(l) + r + '.'.repeat(w - sp.w - l)));
}
function stack(...parts){                       // 由上往下疊,置中
  const w = Math.max(...parts.map(p => p.w));
  return S([].concat(...parts.map(p => center(p, w).rows)));
}
function beside(gap, ...parts){                 // 左右並排,底部對齊
  const h = Math.max(...parts.map(p => p.h));
  const rows = [];
  for(let y = 0; y < h; y++){
    rows.push(parts.map(p => { const yy = y - (h - p.h); return yy >= 0 ? p.rows[yy] : '.'.repeat(p.w); }).join('.'.repeat(gap)));
  }
  return S(rows);
}
PX.S = S; PX.stack = stack; PX.beside = beside;

/* ---------- 事業塔樓產生器 ----------
   floors 越多越高。每一層兩列:一列窗、一列牆。窗戶的亮暗用樓層號固定打散(不用亂數)。 */
function tower(o){
  const w = o.w || 10, body = o.body, win = o.win, dark = o.dark || 'k', rows = [];
  rows.push('k'.repeat(w + 2));
  for(let f = 0; f < o.floors; f++){
    let a = 'k';
    for(let x = 0; x < w; x++){
      const onWin = x % 3 !== 0;
      const lit = ((f * 7 + x * 3) % 5) !== 0;
      a += onWin ? (lit ? win : dark === 'k' ? 'K' : dark) : body;
    }
    rows.push(a + 'k');
    rows.push('k' + body.repeat(w) + 'k');
  }
  // 底層:大門(招牌底座可以換成跑馬燈)
  const mid = Math.floor(w / 2);
  const door = x => (x === mid - 1 || x === mid) ? 'M' : body;
  if(o.base === 'marquee'){
    rows.push('k' + Array.from({ length: w }, (_, x) => x % 2 ? 'y' : 'r').join('') + 'k');
  }
  rows.push('k' + Array.from({ length: w }, (_, x) => door(x)).join('') + 'k');
  rows.push('k' + Array.from({ length: w }, (_, x) => door(x)).join('') + 'k');
  rows.push('k'.repeat(w + 2));
  const t = S(rows);
  return o.roof ? stack(S(o.roof), t) : t;
}
PX.tower = tower;

/* 每一種事業的長相:牆色 / 窗色 / 屋頂 */
const BIZ = {
  dev:    { body:'g', win:'K', roof:[
    'kyyyyyyyyyyk',
    '...y......k.',
    '...y......k.',
    '..kyk.....G.',
    '..kyk.......'] },
  hotel:  { body:'p', win:'l', base:'marquee', roof:[
    '.kkkkkkkkkk.',
    '.kryrryrryk.',
    '.kyrryrryrk.',
    '.kkkkkkkkkk.',
    '...k....k...'] },
  media:  { body:'K', win:'c', roof:[
    '.....k......',
    '.....r......',
    '....kwk.....',
    '..kkkwkkk...',
    '.kwwwwwwwk..',
    '..kkkkkkk...'] },
  brand:  { body:'K', win:'y', roof:[
    '..k.k.k.k...',
    '..kykykyk...',
    '..kyyyyyk...',
    '..kkkkkkk...'] },
  tech:   { body:'b', win:'c', roof:[
    '......k.....',
    '......k.....',
    '....kcck....',
    '..kkccccckk.',
    '.kcccccccck.'] },
  fund:   { body:'B', win:'c', roof:[
    '.kkkkkkkkkk.',
    '.kKKKKKKnnk.',
    '.kKKKKnnKKk.',
    '.kKnnnKKKKk.',
    '.kkkkkkkkkk.',
    '...k....k...'] },
  bank:   { body:'e', win:'B', roof:[
    '.....kk.....',
    '...kkggkk...',
    '.kkggggggkk.',
    'kkkkkkkkkkkk',
    '.kgkgkgkgk..'] },
  energy: { body:'G', win:'o', roof:[
    '.......y....',
    '......oyo...',
    '.......r....',
    '.......k....',
    '.......k....',
    '......kGk...'] },
  infra:  { body:'o', win:'k', dark:'O', roof:[
    '.....r......',
    '....kGk.....',
    '...kGGGk....',
    '..kwkwkwk...'] },
};
PX.BIZ = BIZ;
/* 一棟事業:h 是 0~1 的高度(同一把尺),換成 1~13 層 */
PX.bizTower = (k, h) => {
  const d = BIZ[k]; if(!d) return SPR.shell;
  return tower({ ...d, floors: 1 + Math.round(Math.max(0, Math.min(1, h || 0)) * 12) });
};
/* 對手大本營:他的顏色,插他的旗 */
PX.rivalTower = h => tower({ body:'T', win:'l', dark:'t', floors: 1 + Math.round(Math.max(0, Math.min(1, h || 0)) * 12), roof:[
  '...kk.......',
  '...kTTTk....',
  '...kTTTTk...',
  '...kTTTk....',
  '...k........',
  '...k........',
  '..kkk.......'] });

/* 古典建築(銀行、交易所、債券、美術館、賭場):山牆 + 柱子。emblem 是山牆上的徽記顏色 */
function classic(col, emblem, pillars){
  const n = pillars || 4, w = n * 3 + 1;
  const top = [];
  const half = Math.floor(w / 2);
  for(let i = 0; i < 3; i++){
    const pad = half - i * 2 - 1;
    top.push('.'.repeat(Math.max(0, pad)) + 'k' + (i === 1 ? col + emblem + col : col.repeat(Math.max(0, (i * 2 + 1) * 2 - 1))) + 'k');
  }
  const body = [
    'k'.repeat(w + 2),
    'k' + col.repeat(w) + 'k',
    'k'.repeat(w + 2),
  ];
  for(let y = 0; y < 5; y++){
    let r = 'k';
    for(let x = 0; x < w; x++) r += x % 3 === 0 ? col : (y === 4 && x === Math.floor(w/2)) ? 'M' : 'K';
    body.push(r + 'k');
  }
  body.push('k'.repeat(w + 2), 'k' + 'g'.repeat(w) + 'k', 'k'.repeat(w + 2));
  return stack(S(top), S(body));
}

/* ---------- 手畫的固定圖 ---------- */
const SPR = PX.SPR = {
  house: S([
    '....kkkk....',
    '...krrrrk...',
    '..krrrrrrk..',
    '.krrrrrrrrk.',
    'kkkkkkkkkkkk',
    '.kwwwwwwwwk.',
    '.kwbwwwwbwk.',
    '.kwwwkkwwwk.',
    '.kwbwkMkwbk.',
    '.kwwwkMkwwk.',
    '.kkkkkkkkkk.']),
  gold: S([
    '....kkkkkk....',
    '...kyyyyyyk...',
    '...kYYYYYYk...',
    '.kkkkkkkkkkkk.',
    'kyyyyykyyyyyyk',
    'kYYYYYkYYYYYYk',
    'kkkkkkkkkkkkkk']),
  cash: S([
    '.kkkkkkkkkkkk.',
    'knnnnnnnnnnnnk',
    'knNNnnyynnNNnk',
    'knnnnnnnnnnnnk',
    'kkkkkkkkkkkkkk',
    'knnnnnnnnnnnnk',
    'kNNNNNNNNNNNNk',
    'kkkkkkkkkkkkkk']),
  oil: S([
    '..kkkkk...kkkk..',
    '.kgggggk.kggggk.',
    'kgwgggggkgwgggk.',
    'kgggggggkggggGk.',
    'kgrrrrrgkgrrrgk.',
    'kgggggggkggggGk.',
    'kgggggggkggggGk.',
    'kgggggggkggggGk.',
    'kkkkkkkkkkkkkkk.']),
  crypto: S([
    'kkkkkkkkkkkk',
    'kKKKKKKKKKKk',
    'kKnKnKnKnKKk',
    'kKKKKKKKKKKk',
    'kKnKnKnKnKKk',
    'kKKKKKKKKKKk',
    'kKKkkkkkKKKk',
    'kKkoooookKKk',
    'kKkoyyyokKKk',
    'kKkoooookKKk',
    'kKKkkkkkKKKk',
    'kkkkkkkkkkkk']),
  shell: S([
    'kkkkkkk...',
    'kwwwwwkk..',
    'kwwwwwkwk.',
    'kwkkkwkkkk',
    'kwwwwwwwwk',
    'kwkkkkkkwk',
    'kwwwwwwwwk',
    'kwkkkkkkwk',
    'kwwwwwrrwk',
    'kwwwwwrrwk',
    'kkkkkkkkkk']),
  contract: S([
    'kkkkkkk...',
    'kwwwwwkk..',
    'kwwwwwkwk.',
    'kwkkkwkkkk',
    'kwwwwwwwwk',
    'kwkkkkkkwk',
    'kwwwwwwwwk',
    'kwkkkkyykk',
    'kwwwwyYYyk',
    'kwwwwyYYyk',
    'kkkkkkyykk']),
  hold: S([
    'k.k.k......k.k.k',
    'kkkkk......kkkkk',
    'kRRRk.kkkk.kRRRk',
    'kRRRkkyyyykkRRRk',
    'kRRRkyyyyyykRRRk',
    'kRRRkkkkkkkkRRRk',
    'kRRRRRRRRRRRRRRk',
    'kRRrRRRRRRRRrRRk',
    'kRRRRRRkkRRRRRRk',
    'kRRRRRkMMkRRRRRk',
    'kRRRRRkMMkRRRRRk',
    'kkkkkkkkkkkkkkkk']),
  heart: S([
    '.kkk...kkk.',
    'krrrk.krrrk',
    'krwrrkrrrrk',
    'krrrrrrrrrk',
    '.krrrrrrrk.',
    '..krrrrrk..',
    '...krrrk...',
    '....krk....',
    '.....k.....']),
  arrow: S([
    '.....k.....',
    '....kyk....',
    '...kyyyk...',
    '..kyyyyyk..',
    '.kyyyyyyyk.',
    'kkkkyyykkkk',
    '...kyyyk...',
    '...kyyyk...',
    '...kyyyk...',
    '...kkkkk...']),
  suitcase: S([
    '....kkkkkk....',
    '....kk..kk....',
    'kkkkkkkkkkkkkk',
    'kmmmmmmmmmmmmk',
    'kmMmmmmmmmmMmk',
    'kkkkkkyykkkkkk',
    'kmmmmmmmmmmmmk',
    'kmMmmmmmmmmMmk',
    'kkkkkkkkkkkkkk']),
  safe: S([
    'kkkkkkkkkkkkkk',
    'kGggggggggggGk',
    'kgkkkkkkkkkkgk',
    'kgkGGGGGGGGkgk',
    'kgkGGkkkkGGkgk',
    'kgkGkyyyykGkgk',
    'kgkGkyGGykGkgk',
    'kgkGkyyyykGkgk',
    'kgkGGkkkkGGkgk',
    'kgkkkkkkkkkkgk',
    'kGggggggggggGk',
    'kkkkkkkkkkkkkk']),
  flag: S([
    'kk......',
    'kTTTTTk.',
    'kTTTTTTk',
    'kTtTTTk.',
    'kTTTTTTk',
    'kk......',
    'k.......',
    'k.......',
    'kk......']),
  news: S([
    'kkkkkkkkkkkkkk.',
    'kwwwwwwwwwwwwkk',
    'kwkkkkkkkkkkwkw',
    'kwwwwwwwwwwwwkw',
    'kwkkkkkwgggwwkw',
    'kwwwwwwwgggwwkw',
    'kwkkkkkwgggwwkw',
    'kwwwwwwwwwwwwkw',
    'kwkkkkkkkkkkwkw',
    'kkkkkkkkkkkkkkk']),
  /* ---- 軍事(正面,朝右,T = 隊伍色) ---- */
  raid: S([
    '.....kkkk.......',
    '....kTTTTk......',
    '....kTTTTkkkkkkk',
    '..kkkTTTTTkk....',
    '.kTTTTTTTTTTTk..',
    'kttttttttttttttk',
    'kGkGkGkGkGkGkGkk',
    '.kGGGGGGGGGGGGk.',
    '..kkkkkkkkkkkk..']),
  law: S([
    '..kkkkkkkkkk....',
    '.kTTTTTTTTTTkk..',
    '.kTccTTTccTTTTk.',
    'kTTTTTTwTTTTTTTk',
    'kTTTTTwwwTTTTTTk',
    'kttttttwttttttttk',
    '.kkGkkkkkkkGkk..',
    '..kGk.....kGk...',
    '...k.......k....']),
  lobby: S([
    '.......kk.......',
    '......kwwk......',
    '.......kk.......',
    '.......kk.......',
    '..kkkkkkkkkkk...',
    '.kTTTTTTTTTTTkk.',
    '.kTTTTTTTTTcckTk',
    'kttttttttttttttk',
    '.kkGkkkkkkkkGkk.',
    '..kGk......kGk..',
    '...k........k...']),
  mgr: S([
    '.kkkkkkkkk......',
    '.kmmmmmmmmk.....',
    '.kmMmMmMmmkkkkk.',
    '.kmmmmmmmmkTTcTk',
    '.kmmmmmmmmkTTTTk',
    'kttttttttttttttk',
    '.kkGkkkkkkkkGkk.',
    '..kGk......kGk..',
    '...k........k...']),
  /* ---- 載具(俯視,機頭朝右)---- */
  plane: S([
    '.........kk.........',
    '........kggk........',
    '........kggk........',
    '.......kgggk........',
    '......kgggGk........',
    '..kk..kgggGk........',
    '.kggkkkgggGkkkkkk...',
    'kgggggggggggggggggk.',
    'kgwgwgwgwgwgwgwgwggk',
    'kgggggggggggggggggk.',
    '.kggkkkgggGkkkkkk...',
    '..kk..kgggGk........',
    '......kgggGk........',
    '.......kgggk........',
    '........kggk........',
    '........kggk........',
    '.........kk.........']),
  ship: S([
    '.kkkkkkkkkkkkkkkkkkkkk...',
    'kGGGGGGGGGGGGGGGGGGGGGkk.',
    'kGgggGGkkkkkGGGkkkGGGGGGk',
    'kGgRgGGkwwwkGGGkgkkkkkGGGk',
    'kGgggGGkkkkkGGGkkkGGGGGGk',
    'kGGGGGGGGGGGGGGGGGGGGGkk.',
    '.kkkkkkkkkkkkkkkkkkkkk...']),
  truck: S([
    'kkkkkkkkk..kkkkkkkkk..kkkkkkkkk.',
    'kmmmmmmkTk.kmmmmmmkTk.kmmmmmmkTk',
    'kmMmmMmkck.kmMmmMmkck.kmMmmMmkck',
    'kmmmmmmkTk.kmmmmmmkTk.kmmmmmmkTk',
    'kkkkkkkkk..kkkkkkkkk..kkkkkkkkk.']),
  missile: S([
    'kk..............',
    'krkkkkkkkkkkk...',
    'yowwwwwwwwwwwrrk',
    'krkkkkkkkkkkk...',
    'kk..............']),
  jet: S([
    '......k.......',
    '.....kGk......',
    '.....kGGk.....',
    'kk...kGGGk....',
    'kGk..kGGGGk...',
    'kGGkkGGGGGGkk.',
    'kGGGGGGGccGGGk',
    'kGGkkGGGGGGkk.',
    'kGk..kGGGGk...',
    'kk...kGGGk....',
    '.....kGGk.....',
    '.....kGk......',
    '......k.......']),
  bomb: S([
    'kk.kkkk.',
    'kGkGGGGk',
    'kk.kkkk.']),
};
SPR.stock = classic('g', 'n', 4);
SPR.bond = classic('e', 'b', 4);
SPR.art = classic('s', 'r', 3);
SPR.fx = classic('v', 'y', 3);
SPR.bankc = classic('e', 'y', 5);
SPR.casino = classic('p', 'y', 5);
SPR.hotel5 = tower({ body:'o', win:'l', floors:6, w:10, roof:['..kkkkkkkk..', '..kyryryryk.', '..kkkkkkkk..'] });

/* ---- 地標(每座城一個,參考那款遊戲「每座城都認得出來」)---- */
function needle(pod, h){
  const r = ['.....k.....', '.....k.....', '....k' + pod + 'k....', '..kk' + pod + pod + pod + 'kk..',
             '.k' + pod.repeat(7) + 'k.', '..kkkkkkk..'];
  for(let i = 0; i < h; i++) r.push('....kgk....');
  r.push('...kgggk...', '..kgggggk..', '.kkkkkkkkk.');
  return S(r);
}
function lattice(c, h){
  const r = ['.....k.....', '.....k.....', '....k' + c + 'k....'];
  for(let i = 0; i < h; i++){
    const wv = Math.floor(i / 3);
    const inner = 1 + wv * 2;
    const pad = 5 - wv - 1;
    const mid = Array.from({ length: inner }, (_, x) => (x + i) % 2 ? '.' : c).join('');
    r.push('.'.repeat(Math.max(0, pad)) + 'k' + mid + 'k');
  }
  r.push('k' + c + '.'.repeat(7) + c + 'k');
  return S(r.map(x => x.padEnd(11, '.')));
}
function skyline(c){
  const a = tower({ body:c, win:'c', floors:7, w:4 });
  const b = tower({ body:c, win:'l', floors:10, w:5 });
  const d = tower({ body:c, win:'c', floors:5, w:4 });
  return beside(0, a, b, d);
}
function pyramid(c, stepped){
  const r = [];
  for(let i = 0; i < 9; i++){
    const w = i * 2 + 1;
    r.push('.'.repeat(9 - i) + 'k' + (stepped && i % 2 ? 'k'.repeat(w) : c.repeat(w)) + 'k');
  }
  r.push('k'.repeat(21));
  return S(r);
}
const LMS = PX.LMS = {
  liberty: S([
    '....y.....', '...kok....', '...knk....', '...knk....', '.kkknk....', 'knnnnk....', 'knNnnk....',
    '.knnnnk...', '.knNnnk...', '.knnnnk...', '.knnnnnk..', '.knNnnnk..', 'knnnnnnnk.', 'kkkkkkkkkk',
    'kgggggggggk', 'kgGgGgGggk', 'kgggggggggk', 'kkkkkkkkkkk']),
  bridge: S([
    '..k..........k..', '.krk........krk.', '.krkk......kkrk.', '.krk.k....k.krk.', '.krk..k..k..krk.',
    '.krk...kk...krk.', 'kkrkkkkkkkkkkrkk', 'rrrrrrrrrrrrrrrr', '.krk........krk.', '.krk........krk.', 'bbbbbbbbbbbbbbbb']),
  palm: S([
    '..kkk.kkk...', '.knnnknnnk..', 'knnkNNkNnnk.', 'kn.k.MM.kNk.', '.k...Mk...k.', '.....Mk.....',
    '.....Mk.....', '....kMk.....', '....kMk.....', '....kMk.....', 'ssssssssssss', 'bbbbbbbbbbbb']),
  luxor: stack(S(['c', 'c', 'c', 'c']), pyramid('G', false)),   // 路克索:黑玻璃金字塔 + 頂上那道光
  aztec: pyramid('m', true),
  lattice: lattice('r', 14),
  eiffel: lattice('m', 16),
  headframe: lattice('G', 9),
  bank: SPR.bankc,
  casino: SPR.casino,
  needle: needle('g', 12),
  spire: S(['.k.', 'kwk', 'kwk', 'kwk', 'kwk', 'kwk', 'kwk', 'kwk', 'kwk', 'kwk', 'kwk', 'kwk', 'kwk', 'kwk', 'kgk', 'kkk']),
  bigben: S([
    '....k....', '...kyk...', '..kmmmk..', '.kmmmmmk.', 'kkkkkkkkk', 'kmwwwwwmk', 'kmwkwkwmk', 'kmwwkwwmk',
    'kmwwwwwmk', 'kkkkkkkkk', 'kmmkmkmmk', 'kmmmmmmmk', 'kmmkmkmmk', 'kmmmmmmmk', 'kmmkmkmmk', 'kmmmmmmmk',
    'kmmkmkmmk', 'kmmmmmmmk', 'kmmmMMmmk', 'kkkkkkkkk']),
  castle: S([
    '.....kk.....', '....kNNk....', '...kNNNNk...', '..kkkkkkkk..', '..kwwkwwwk..', '.kNNNNNNNNk.',
    '.kkkkkkkkkk.', '.kwkwwwwkwk.', 'kNNNNNNNNNNk', 'kkkkkkkkkkkk', 'kgggggggggggk', 'kgGgggggggGgk', 'kkkkkkkkkkkkk']),
  pearl: S([
    '...k...', '...k...', '..kqk..', '...k...', '..kqk..', '.kqqqk.', '.kqwqk.', '..kqk..', '...k...',
    '..kgk..', '..kgk..', '.kqqqk.', 'kqqwqqk', 'kqqqqqk', '.kqqqk.', '.kgkgk.', 'kgk.kgk', 'kk...kk']),
  pagoda: S([
    '...kkkkkkkk...', '..kyyyyyyyyk..', '.kkkkkkkkkkkk.', '...krrrrrrk...', '..kkkkkkkkkk..', '.kyyyyyyyyyyk.',
    'kkkkkkkkkkkkkk', '.krrrrrrrrrrk.', '.krrkMMMkrrrk.', '.krrkMMMkrrrk.', 'kkkkkkkkkkkkkk']),
  t101: S([
    '....k....', '....k....', '...kvk...', '..kvvvk..', '.kvvcvvk.', '..kvvvk..', '.kvvcvvk.', '..kvvvk..',
    '.kvvcvvk.', '..kvvvk..', '.kvvcvvk.', '..kvvvk..', '.kvvcvvk.', '..kvvvk..', '.kvvcvvk.', '..kvvvk..',
    '..kvcvk..', '.kkvvvkk.', 'kvvvvvvvk', 'kkkkkkkkk']),
  fab: S([
    '..kk....kk......', '..kGk...kGk.....', '..kGk...kGk.....', 'kkkGkkkkkGkkkkkk', 'kwwwwwwwwwwwwwwk',
    'kwcwcwcwwwcwcwck', 'kwwwwwwwwwwwwwwk', 'kwcwcwcwwwcwcwck', 'kwwwwwwwMMwwwwwk', 'kkkkkkkkkkkkkkkk']),
  mbs: S([
    'kkkkkkkkkkkkkkkkk', 'kgggggggggggggggk', 'kkkkkkkkkkkkkkkkk', '.kck..kck..kck...', '.kgk..kgk..kgk...',
    '.kck..kck..kck...', '.kgk..kgk..kgk...', '.kck..kck..kck...', '.kgk..kgk..kgk...', '.kck..kck..kck...',
    '.kgk..kgk..kgk...', '.kck..kck..kck...', '.kgk..kgk..kgk...', 'kkkkkkkkkkkkkkkk.']),
  stupa: S([
    '....k....', '....y....', '...kyk...', '...kyk...', '..kyyyk..', '..kyyyk..', '.kyyYyyk.', 'kyyyyyyyk',
    'kyyYyYyyk', 'kyyyyyyyk', 'kkkkkkkkk', 'kgggggggk', 'kkkkkkkkk']),
  monas: S([
    '...y...', '..yoy..', '..kyk..', '...k...', '..kwk..', '..kwk..', '..kwk..', '..kwk..', '..kwk..', '..kwk..',
    '..kwk..', '..kwk..', '.kwwwk.', 'kkkkkkk', 'kwwwwwk', 'kkkkkkk']),
  opera: S([
    '......k.........', '.....kwk...k....', '....kwwk..kwk...', '...kwwwk.kwwk.k.', '..kwwwwkkwwwkkwk',
    '.kwwwwwkwwwwkwwk', 'kkkkkkkkkkkkkkkk', 'kssssssssssssssk', 'kkkkkkkkkkkkkkkk']),
  burj: S([
    '..k..', '..k..', '..k..', '.kgk.', '.kgk.', '.kck.', '.kgk.', 'kkgkk', 'kgckk', 'kgggk', 'kgcgk', 'kgggk',
    'kgcgk', 'kgggk', 'kgcgk', 'kgggk', 'kgcgk', 'kgggk', 'kgcgk', 'kgggk', 'kgcgk', 'kgggk', 'kgcgk', 'kkkkk']),
  kingdom: S([
    'kk.....kk', 'kgk...kgk', 'kgk...kgk', 'kgkkkkkgk', 'kgcgcgcgk', 'kgggggggk', 'kgcgcgcgk', 'kgggggggk',
    'kgcgcgcgk', 'kgggggggk', 'kgcgcgcgk', 'kgggggggk', 'kgcgcgcgk', 'kgggMgggk', 'kkkkkkkkk']),
  mosque: S([
    'k.....kk.....k', 'k....kwwk....k', 'k...kwwwwk...k', 'k..kwwwwwwk..k', 'k.kwwwwwwwwk.k', 'kkkkkkkkkkkkkk',
    'kskssssssssksk', 'kskskMMMkssksk', 'kskskMMMkssksk', 'kkkkkkkkkkkkkk']),
  gateway: S([
    '.kkkkkkkkkkkkk.', 'kssssssssssssssk', 'kskkkkkkkkkkksk', 'ksskk.....kkssk', 'kssk.......kssk', 'kssk.......kssk',
    'kssk.......kssk', 'kssk.......kssk', 'kkkk.......kkkk']),
  lighthouse: S([
    '...k...', '..kyk..', '.kyyyk.', '.kkkkk.', '..kwk..', '..krk..', '..kwk..', '.kwwwk.', '.krrrk.', '.kwwwk.',
    '.krrrk.', 'kwwwwwk', 'kkkkkkk']),
  saucer: S([
    '.....k.....', '...kkkkk...', '.kgggggggk.', 'kkkkkkkkkkk', '....kgk....', '....kgk....', '....kgk....',
    '...kgggk...', '..kgggggk..', '.kkkkkkkkk.']),
  skyline: skyline('G'),
};
PX.skyline = skyline;

/* ---------- 顏色與繪圖 ---------- */
function hexRgb(h){ const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if(!m) return null; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
function rgbStr(c){
  if(typeof c !== 'string') return `rgb(${c.join(',')})`;
  return c[0] === '#' || /^rgba?\(/.test(c) ? c : `rgb(${c})`;     // '#…'、'rgb(…)' 原樣;'r,g,b' 補上 rgb()
}
function darker(c, k){
  const a = typeof c === 'string' ? (hexRgb(c) || c.replace(/[^\d,]/g, '').split(',').map(Number)) : c;
  return `rgb(${a.map(v => Math.round(v * k)).join(',')})`;
}
PX.darker = darker;
/* 把一張圖畫到 ctx 上(x, y 是左上角,單位像素)。tint = 隊伍色 */
function draw(ctx, sp, x, y, tint){
  const T = tint ? rgbStr(tint) : '#4fc3f7', t = tint ? darker(tint, .6) : '#1f6a8a';
  for(let j = 0; j < sp.h; j++){
    const row = sp.rows[j];
    for(let i = 0; i < sp.w; i++){
      const ch = row[i];
      if(ch === '.' || ch === ' ') continue;
      ctx.fillStyle = ch === 'T' ? T : ch === 't' ? t : (PAL[ch] || '#f0f');
      ctx.fillRect(x + i, y + j, 1, 1);
    }
  }
}
PX.draw = draw;
/* 一張圖 → canvas(每個像素放大 scale 倍,邊緣保持銳利) */
PX.canvas = function(sp, scale, tint, pad){
  const s = scale || 1, p = pad || 0;
  const c = document.createElement('canvas');
  c.width = (sp.w + p * 2) * s; c.height = (sp.h + p * 2) * s;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.scale(s, s);
  draw(ctx, sp, p, p, tint);
  return c;
};
const URLS = new Map();
/* 給 DOM 用的 dataURL(卡牌、清單)。同一張圖只轉一次 */
PX.url = function(key, sp, tint){
  const k = key + '|' + (tint || '');
  if(URLS.has(k)) return URLS.get(k);
  let u = '';
  try{ u = PX.canvas(sp, 1, tint).toDataURL(); }catch(e){}
  URLS.set(k, u);
  return u;
};
/* <img> 標籤:用 CSS 放大、image-rendering: pixelated */
PX.img = function(key, sp, opt){
  opt = opt || {};
  // fit:[寬, 高] → 取「放得下的最大整數倍」,像素才會是整齊的方塊
  const z = opt.fit ? Math.max(1, Math.min(Math.floor(opt.fit[0] / sp.w), Math.floor(opt.fit[1] / sp.h))) : (opt.z || 3);
  return `<img class="px${opt.cls ? ' ' + opt.cls : ''}" src="${PX.url(key, sp, opt.tint)}" width="${sp.w * z}" height="${sp.h * z}" alt="${opt.alt || ''}" draggable="false">`;
};

/* 建築頭上的小徽章:▲ 賺錢、▼ 燒錢、◆ 上市 */
const BADGE = {
  up:   S(['..n..', '.nnn.', 'nnnnn']),
  down: S(['rrrrr', '.rrr.', '..r..']),
  pub:  S(['..b..', '.bcb.', 'bcccb', '.bcb.', '..b..']),
};
PX.BADGE = BADGE;
/* ---------- 一座城:所有建築並排在一塊地上 ----------
   parts: [{ sp, tint }] 依序排,最高的放中間;底下是一條隊伍色的地基。 */
PX.city = function(parts, groundTint){
  const list = parts.slice().sort((a, b) => b.sp.h - a.sp.h);
  const order = [];
  list.forEach((p, i) => { if(i % 2) order.push(p); else order.unshift(p); });
  const gap = 1;
  const w = order.reduce((s, p) => s + p.sp.w, 0) + gap * (order.length - 1) + 4;
  const top = order.some(p => p.badge) ? 6 : 0;
  const h = Math.max(...order.map(p => p.sp.h + (p.badge ? top : 0))) + 3;
  return { w, h, paint(ctx){
    let x = 2;
    for(const p of order){
      const y = h - 3 - p.sp.h;
      draw(ctx, p.sp, x, y, p.tint);
      const b = p.badge && BADGE[p.badge];
      if(b) draw(ctx, b, x + Math.floor((p.sp.w - b.w) / 2), y - b.h - 1);
      x += p.sp.w + gap;
    }
    ctx.fillStyle = PAL.k; ctx.fillRect(0, h - 3, w, 3);
    ctx.fillStyle = groundTint ? rgbStr(groundTint) : PAL.n; ctx.fillRect(1, h - 2, w - 2, 1);
  } };
};
/* 自訂 paint 的圖 → canvas */
PX.paint = function(img, scale){
  const s = scale || 1;
  const c = document.createElement('canvas');
  c.width = img.w * s; c.height = img.h * s;
  const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.scale(s, s);
  img.paint(ctx);
  return c;
};

/* 資產類別 → 哪一張圖(股票六類共用交易所,但各有自己的招牌色) */
PX.assetSprite = function(k, g){
  if(k === 'estate') return SPR.house;
  if(k === 'gold') return SPR.gold;
  if(k === 'oil') return SPR.oil;
  if(k === 'art') return SPR.art;
  if(k === 'fx') return SPR.fx;
  if(k === 'crypto') return SPR.crypto;
  if(k === 'bond') return SPR.bond;
  return SPR.stock;
};
})();
