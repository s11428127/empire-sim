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
  /* ---- 軍事(側面,朝右,T = 隊伍色、t = 隊伍色暗面)----
     使用者:「軍隊我要改成坦克、步兵、火炮等等,好看一點」。
     每一種都看得出輪廓:坦克有砲塔與履帶、步兵是三個拿槍的兵、火炮是仰起來的長砲管、補給是軍用卡車。 */
  raid: S([                                   // 坦克(原 併購小組)
    '.........kkkkk........',
    '........kTTTTTk.......',
    '.......kTTwTTTTkkkkkkk',
    '.......kTTTTTTTkgggggk',
    '....kkkkttttttttkkkkkk',
    '...kTTTTTTTTTTTTTTk...',
    '..kTTTTTTTTTTTTTTTTk..',
    '.kttttttttttttttttttk.',
    'kGkkGkkGkkGkkGkkGkkGk.',
    'kgGgGgGgGgGgGgGgGgGgk.',
    '.kkkkkkkkkkkkkkkkkkk..']),
  law: S([                                    // 步兵(原 律師團):三個兵,鋼盔、步槍
    '.kkk.....kkk.....kkk..',
    'kTTTk...kTTTk...kTTTk.',
    '.ksk.....ksk.....ksk..',
    '.kTkkkk..kTkkkk..kTkkkk',
    'kTTTGGk.kTTTGGk.kTTTGGk',
    'kTTTk...kTTTk...kTTTk..',
    '.ktk.....ktk.....ktk...',
    '.kTk.....kTk.....kTk...',
    '.k.k.....k.k.....k.k...',
    'kk.kk...kk.kk...kk.kk..']),
  lobby: S([                                  // 火炮(原 遊說團):仰角長砲管 + 大輪子
    '...................kk.',
    '.................kkgk.',
    '...............kkggk..',
    '.............kkggk....',
    '...........kkggk......',
    '.......kkkkTTkk.......',
    '.....kkTTTTTTTk.......',
    '....kTTTTTTTTTTk......',
    '...kttttttttttttk.....',
    '..kGGk......kGGk......',
    '.kGgGGk....kGgGGk.....',
    '.kGGgGk....kGGgGk.....',
    '..kGGk......kGGk......']),
  mgr: S([                                    // 補給車(原 經理人):帆布車斗 + 駕駛室
    '..kkkkkkkkkkkk........',
    '.kTTTTTTTTTTTTk.......',
    '.kTtTtTtTtTtTTkkkkkk..',
    '.kTTTTTTTTTTTTkTTccTk.',
    '.kTTTTTTTTTTTTkTTccTTk',
    '.kkkkkkkkkkkkkkTTTTTTk',
    'kttttttttttttttttttttk',
    'kkkGGGkkkkkkkkkkGGGkk.',
    '..kGgGk........kGgGk..',
    '...kkk..........kkk...']),
  /* 偵察機(側面,卡面用) */
  recon: S([
    '..k.....................',
    '..kk..........kkk.......',
    '..kTk.......kkwwTk......',
    '..kTTkkkkkkkTTTTTTkk....',
    '.kTTTTTTTTTTTTTTTTTTkkk.',
    '..kttttttttttttttttttkck',
    '....kkkkkkkTTTTkkkkkkk..',
    '..........kTTTTk........',
    '...........kkkk.........']),
  /* 偵察機(俯視,機頭朝右,飛行動畫用):長直翼 + 螺旋槳 */
  reconTop: S([
    '........kk........',
    '........kgk.......',
    '........kgk.......',
    '........kgk.......',
    '.kk.....kgk.......',
    'kggk.kkkkgkkkkkkk.',
    'kgggkggggggggccggk',
    'kggk.kkkkgkkkkkkk.',
    '.kk.....kgk.......',
    '........kgk.......',
    '........kgk.......',
    '........kgk.......',
    '........kk........']),
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
/* 太空計畫(第十三輪):火箭(站著,發射動畫與火星牌用)、衛星(星鏈牌的卡面) */
/* 航空母艦(側面):艦島、甲板上的戰機、紅色水線 —— 招募面板與卡面用 */
SPR.navy = S([
  '............k...........', '...........kgk..........', '..........kkgkk.........', '..kk.....kgcgck....kk...',
  'kkkkkkkkkkkkkkkkkkkkkkkkk', 'kGGGGGGGGGGGGGGGGGGGGGGGk', '.kGGGgGGGGGgGGGGGgGGGGGk.', '..kRRRRRRRRRRRRRRRRRRRk..',
  '...kkkkkkkkkkkkkkkkkkk...']);
SPR.rocket = S([
  '....k....', '...kwk...', '...kwk...', '..kwwwk..', '..kwcwk..', '..kwwwk..', '..kwwwk..',
  '..kgwgk..', '..kwwwk..', '..kwwwk..', '..kwrwk..', '..kwrwk..', '..kwwwk..', '.kkwwwkk.',
  'kgkwwwkgk', 'kgkwwwkgk', 'kgkgggkgk', 'kkkkkkkkk', '...kok...', '..koyok..', '..kyyyk..', '...kyk...']);
SPR.sat = S([
  '......kk......', '......ke......', 'bcbcb.kk.bcbcb', 'cbcbckeeekcbcbc',
  'bcbcbkeyekbcbcb', 'cbcbckeeekcbcbc', 'bcbcb.kk.bcbcb', '......kk......']);
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

/* =============================================================================
   像素圖示:取代文字裡的表情符號
   -----------------------------------------------------------------------------
   使用者:「所有風格都改成像素,包含按鈕,還有文字裡的表情符號」。
   表情符號是作業系統畫的(蘋果、Google、微軟各長各的),跟像素風完全不搭 ——
   這裡每一個用到的符號都有一張 9×9 的像素圖。畫面上任何地方出現這些字元
   (面板、地圖上的標籤、浮字、名牌),PX.observe 會自動把它換成 <img>。
   標題列提示(title="…")是瀏覽器畫的,換不了,保留原字。
   ============================================================================= */
(function(){
const S = PX.S;
const I = PX.ICON = {};
const def = (chars, rows) => { const sp = S(rows); for(const ch of chars) I[ch] = sp; };
def('⚠', ['....k....','...kyk...','...kyk...','..kykyk..','..kykyk..','.kyyyyyk.','.kyykyyk.','kyyyyyyyk','kkkkkkkkk']);
def('⚔', ['g.......g','.g.....g.','..g...g..','...g.g...','....g....','...g.g...','.mm...mm.','.m.....m.','m.......m']);
def('🚀', ['......kr.','.....kwrk','....kwwk.','...kwbwk.','..kwwwk..','.kkwwk...','.kok.k...','kyok.....','.k.......']);
def('🎯', ['..kkkkk..','.kwwwwwk.','kwrrrrrwk','kwrwwwrwk','kwrwrwrwk','kwrwwwrwk','kwrrrrrwk','.kwwwwwk.','..kkkkk..']);
def('🛢', ['.kkkkkkk.','.kBBBBBk.','.kbbbbbk.','.kBBBBBk.','.kbbbbbk.','.kBBBBBk.','.kbbbbbk.','.kBBBBBk.','.kkkkkkk.']);
def('🏛', ['....k....','..kkekk..','.keeeeek.','kkkkkkkkk','.e.e.e.e.','.e.e.e.e.','.e.e.e.e.','kkkkkkkkk','keeeeeeek']);
def('🏦', ['....k....','..kkykk..','.kyyyyyk.','kkkkkkkkk','.e.e.e.e.','.e.e.e.e.','.e.e.e.e.','kkkkkkkkk','keeeeeeek']);
def('🔵', ['..kkkkk..','.kbbbbbk.','kbbcbbbbk','kbcbbbbbk','kbbbbbbbk','kbbbbbbbk','kbbbbbbbk','.kbbbbbk.','..kkkkk..']);
def('📰📋', ['kkkkkkkk.','kwwwwwwkk','kwkkkwwkw','kwkkkwwkw','kwwwwwwkw','kwkkkkkkw','kwwwwwwkw','kwkkkkkkw','kkkkkkkkk']);
def('👑', ['.........','y...y...y','yy.yyy.yy','yyyyyyyyy','yyryyyryy','yyyyyyyyy','YYYYYYYYY']);
def('📊', ['kkkkkkkkk','kwwwwwwwk','kwwwwwnwk','kwwwnwnwk','kwnwnwnwk','kwnwnwnwk','kwnwnwnwk','kwwwwwwwk','kkkkkkkkk']);
def('📈', ['kkkkkkkkk','kwwwwwwwk','kwwwwwnwk','kwwwwnwwk','kwnwnwwwk','kwwnwwwwk','kwwwwwwwk','kkkkkkkkk']);
def('📉', ['kkkkkkkkk','kwwwwwwwk','kwrwwwwwk','kwwrwrwwk','kwwwrwrwk','kwwwwwwrk','kwwwwwwwk','kkkkkkkkk']);
def('🤝', ['.........','.ss...ss.','sssk.ksss','ssskkksss','.sssssss.','..sssss..','...sss...']);
def('👤', ['...kkk...','..kgggk..','..kgggk..','..kgggk..','...kgk...','.kkgggkk.','kgggggggk','kgggggggk','kkkkkkkkk']);
def('⚓', ['...kbk...','...b.b...','....b....','..bbbbb..','....b....','b...b...b','bb..b..bb','.bb.b.bb.','..bbbbb..']);
def('🔬', ['...kk....','...kgk...','....kgk..','....kgk..','...kgggk.','..k.kgk..','.k...k...','kkkkkkkk.']);
def('🪙₿', ['..kkkkk..','.kyyyyyk.','kyYyyyYyk','kyyYYYyyk','kyyYyyyyk','kyyYYYyyk','kyYyyyYyk','.kyyyyyk.','..kkkkk..']);
def('📄📜', ['kkkkkk...','kwwwwkk..','kwwwwkwk.','kwkkwkkkk','kwwwwwwwk','kwkkkkkwk','kwwwwwwwk','kwkkkkkwk','kkkkkkkkk']);
def('🏙🌆', ['.....kk..','.kk..kck.','.kck.kck.','.kckkkck.','kkckcckck','kcckcckck','kcckcckck','kcckcckck','kkkkkkkkk']);
def('🏭', ['.k.......','.kk......','.kGk.....','.kGkk.kk.','kGGGkkGGk','kGGGGGGGk','kGyGyGyGk','kGGGGGGGk','kkkkkkkkk']);
def('⛏', ['.kkkkkk..','kgggggggk','.kk.mk.kk','....mk...','....mk...','....mk...','....mk...','....mk...']);
def('⚖', ['....y....','.yyyyyyy.','.y..y..y.','yyy.y.yyy','yyy.y.yyy','....y....','....y....','..yyyyy..']);
def('👔', ['.kk...kk.','kwwk.kwwk','kwwwkwwwk','.kwwbwwk.','..kbbbk..','...bbb...','..kbbbk..','..kbbbk..','...kbk...']);
def('✈', ['....k....','....k....','...kgk...','kkkkgkkkk','kgggggggk','kkkkgkkkk','....g....','...kgk...','..kkkkk..']);
def('🔒🔐', ['..kkkkk..','.kk...kk.','.k.....k.','kkkkkkkkk','kyyyyyyyk','kyyykyyyk','kyyykyyyk','kyyyyyyyk','kkkkkkkkk']);
def('💰', ['...kkk...','....k....','..kkkkk..','.kYYYYYk.','kYYyyyYYk','kYYyYYYYk','kYYYyyYYk','kYYyyyYYk','.kkkkkkk.']);
def('💻', ['.kkkkkkk.','.kccccck.','.kccccck.','.kccccck.','.kkkkkkk.','kgggggggk','kkkkkkkkk']);
def('⛽', ['.kkkkk...','.kwwwk...','.kkkkkk..','.krrrk.k.','.krrrk.k.','.krrrkk..','.krrrk...','kkkkkkk..']);
def('📦', ['.........','.kkkkkkk.','kmmmMmmmk','kkkkkkkkk','kmmmMmmmk','kmmmMmmmk','kmmmMmmmk','kmmmMmmmk','kkkkkkkkk']);
def('🌱', ['.........','.kk...kk.','knnk.knnk','.kNnkknNk','..kkNkk..','....k....','...kmk...','..kmmmk..','.kkkkkkk.']);
def('🌙', ['...kkk...','..kyyk...','.kyyk....','.kyk.....','.kyk.....','.kyyk....','..kyyk.k.','...kyyyk.','....kkk..']);
def('🔴', ['...kkk...','.kkrrrkk.','.krRrrrk.','krrrrRrrk','krRrrrrrk','krrrrrRrk','.krrRrrk.','.kkrrrkk.','...kkk...']);
def('🏨', ['.kkkkkkk.','.kyryryk.','.kkkkkkk.','.kolollk.','.koooook.','.kolollk.','.koooook.','.kolkllk.','kkkkMkkkk']);
def('🛰', ['kbk......','bcbk.....','kbkbk....','..kkek...','...kyek..','....kekbk','.....kbcb','......kbk','.........']);
def('🏠🏘', ['....k....','...krk...','..krrrk..','.krrrrrk.','kkkkkkkkk','.kwwwwwk.','.kwbwMwk.','.kwwwMwk.','.kkkkkkk.']);
def('🏚', ['....k....','...kGk...','..kGGGk..','.kGG.GGk.','kkkk.kkkk','.kggggGk.','.kg.gMgk.','.kgggMgk.','.kkkkkkk.']);
def('🏗', ['kyyyyyyyk','..y....k.','..y....k.','..y....G.','..y......','..y......','.kyk.....','.kyk.....','kkkkk....']);
def('🎰', ['.kkkkkkk.','.krrrrrk.','.kwkwkwk.','.kykrkyk.','.kwkwkwk.','.krrrrrk.','.kkkkkkk.']);
def('🚧', ['kkkkkkkkk','koowwoowk','kwoowwook','kkkkkkkkk','.k.....k.','.k.....k.','kkk...kkk']);
def('🏢', ['.kkkkkkk.','.kgcgcgk.','.kgggggk.','.kgcgcgk.','.kgggggk.','.kgcgcgk.','.kgggggk.','.kggMggk.','.kkkkkkk.']);
def('💵💸💱', ['kkkkkkkkk','knnnnnnnk','knNnyynnk','knnnnnnNk','kkkkkkkkk']);
def('✎', ['.......kk','......kyk','.....kyk.','....kyk..','...kyk...','..kyk....','.kmk.....','kkk......']);
def('🛒', ['k........','kkkkkkkkk','.kgggggk.','.kgggggk.','..kgggk..','..kkkkkk.','...k...k.']);
def('💊', ['...kkk...','..krrrk..','..krrrk..','..kkkkk..','..kwwwk..','..kwwwk..','...kkk...']);
def('🖼', ['kkkkkkkkk','kYYYYYYYk','kYcccccYk','kYccnccYk','kYcnnncYk','kYYYYYYYk','kkkkkkkkk']);
def('📺🎬', ['..k...k..','...k.k...','kkkkkkkkk','kccccccck','kccccccck','kccccccck','kkkkkkkkk','.k.....k.']);
def('📥', ['....n....','....n....','..nnnnn..','...nnn...','....n....','k.......k','kkkkkkkkk']);
def('📤', ['....b....','...bbb...','..bbbbb..','....b....','....b....','k.......k','kkkkkkkkk']);
def('🧰', ['...kkk...','..k...k..','kkkkkkkkk','krrrrrrrk','kkkkykkkk','krrrrrrrk','kkkkkkkkk']);
def('🌫', ['.........','.ggggg...','.........','...gggggg','.........','gggggg...']);
def('⬆', ['....k....','...kyk...','..kyyyk..','.kyyyyyk.','kkkyyykkk','..kyyyk..','..kyyyk..','..kkkkk..']);
def('🔔', ['....k....','...kyk...','..kyyyk..','..kyyyk..','.kyyyyyk.','kyyyyyyyk','kkkkkkkkk','...kyk...']);
def('📍', ['..kkkkk..','.krrrrrk.','.krwrrrk.','.krrrrrk.','..krrrk..','...krk...','....k....']);
def('🧊', ['.kkkkkkk.','kwccccck.','kcccccck.','kcccccck.','kcccccck.','kcccccck.','.kkkkkkk.']);
def('🌏🌐', ['..kkkkk..','.kbbnnbk.','kbnnnbbbk','kbbnnbbbk','kbbbbnnbk','kbbbnnnbk','.kbbbnbk.','..kkkkk..']);
def('🔁', ['.kkkkkk..','k......k.','k.....kkk','.........','kkk.....k','.k......k','..kkkkkk.']);
def('👁', ['.........','..kkkkk..','.kwwwwwk.','kwwbkbwwk','kwwbbbwwk','.kwwwwwk.','..kkkkk..']);
def('🎓', ['....k....','..kkkkk..','kkkkkkkkk','..kkkkk.y','..kkkkk.y','...kkk..y']);
def('🎖', ['.rr...rr.','..rr.rr..','...rrr...','..kyyyk..','.kyyyyyk.','.kyYYyyk.','.kyyyyyk.','..kyyyk..']);
def('🎉', ['......y.r','..r..y...','.....k.y.','....kyk..','...kyryk.','..kyryk..','.kyryk...','kyyyk....','kkkk.....']);
def('🏳', ['kk.......','kwwwwwk..','kwwwwwwk.','kwwwwwk..','kwwwwwwk.','kk.......','k........','k........','kk.......']);
def('💥', ['y...o...y','.y.ooo.y.','..ooyoo..','.ooyyyoo.','ooyywyyoo','.ooyyyoo.','..ooyoo..','.y.ooo.y.','y...o...y']);
def('✓', ['.......nn','......nn.','.....nn..','nn..nn...','.nnnn....','..nn.....']);
def('✕✗', ['rr...rr','.rr.rr.','..rrr..','.rr.rr.','rr...rr']);
def('✦', ['...y...','...y...','..yyy..','yyywyyy','..yyy..','...y...','...y...']);
def('🔊', ['...w.....','..ww..w..','wwgw.w.w.','wggw..w.w','wggw..w.w','wwgw.w.w.','..ww..w..','...w.....']);
def('🔇', ['...w.....','..ww.....','wwgw.r..r','wggw..rr.','wggw..rr.','wwgw.r..r','..ww.....','...w.....']);
def('🚜', ['.........','...kkk...','..kgggkkk','..kgggk..','kkkkkkkk.','kgggggggk','kkkkkkkkk','kGkGkGkGk','.kkkkkkk.']);   // 坦克
def('🪖', ['..kkkkk..','.kNNNNNk.','kNNnNNNNk','kNNNNNNNk','kkkkkkkkk','..ksssk..','..kssk...']);                 // 步兵(鋼盔)
def('💣', ['.......kk','......kgk','.....kgk.','....kgk..','..kkgk...','.kNNNk...','kNNNNNk..','kGk.kGk..','.k...k...']);   // 火炮
def('🚚', ['kkkkkk...','kmmmmkkk.','kmMmmkcck','kmmmmkkkk','kkkkkkkkk','.kGk..kGk','..k....k.']);                  // 補給車
def('🛩', ['...k.....','...kk....','kkkkkkkkk','.kgggggck','kkkkkkkkk','...kk....','...k.....']);                  // 偵察機
def('🌍🌎', ['..kkkkk..','.kbnnbbk.','kbnnnbbbk','kbbnnbbbk','kbbbnnbbk','kbbbnnbbk','.kbbbnbk.','..kkkkk..']);

/* 國旗:真的像素國旗(使用者:「國家的國旗要正確」)。
   每一面 18×12,照實際的設計畫:日本的紅日、韓國的太極與卦、美國的條紋與星區、英國的米字、
   台灣的青天白日、中國的五星、加拿大的楓葉… 44 座城市所在的國家都有;另外常見的三色旗一併收。
   沒收到的國家退回系統的國旗表情符號(至少是對的),不亂畫一面假的。 */
const FW = 18, FH = 12;
const FC = {};
function flagDraw(code){
  const c = document.createElement('canvas'); c.width = FW; c.height = FH;
  const x = c.getContext('2d');
  const R = (col, x0, y0, w, h) => { x.fillStyle = col; x.fillRect(x0, y0, w, h); };
  const P = (col, pts) => { x.fillStyle = col; for(const [a, b] of pts) x.fillRect(a, b, 1, 1); };
  const disc = (col, cx, cy, r) => { x.fillStyle = col; for(let j = -r; j <= r; j++) for(let i = -r; i <= r; i++) if(i*i + j*j <= r*r + r*.6) x.fillRect(cx + i, cy + j, 1, 1); };
  const star = (col, cx, cy) => P(col, [[cx, cy - 1], [cx - 1, cy], [cx, cy], [cx + 1, cy], [cx - 1, cy + 1], [cx + 1, cy + 1]]);
  const h3 = (a, b, cc) => { R(a, 0, 0, FW, 4); R(b, 0, 4, FW, 4); R(cc, 0, 8, FW, 4); };
  const v3 = (a, b, cc) => { R(a, 0, 0, 6, FH); R(b, 6, 0, 6, FH); R(cc, 12, 0, 6, FH); };
  const h2 = (a, b) => { R(a, 0, 0, FW, 6); R(b, 0, 6, FW, 6); };
  const union = (x0, y0, w, h) => {          // 米字旗(縮小版)
    R('#012169', x0, y0, w, h);
    for(let i = 0; i < w; i++){ const y1 = Math.round(y0 + i * (h - 1) / (w - 1)), y2 = Math.round(y0 + (h - 1) - i * (h - 1) / (w - 1));
      P('#ffffff', [[x0 + i, y1], [x0 + i, y2]]); if(i % 2) P('#c8102e', [[x0 + i, y1], [x0 + i, y2]]); }
    const cx = x0 + Math.floor(w / 2), cy = y0 + Math.floor(h / 2);
    R('#ffffff', x0, cy - 1, w, 3); R('#ffffff', cx - 1, y0, 3, h);
    R('#c8102e', x0, cy, w, 1); R('#c8102e', cx, y0, 1, h);
  };
  const cross = (bg, fg, fg2) => {           // 北歐十字
    R(bg, 0, 0, FW, FH); R(fg, 5, 0, 3, FH); R(fg, 0, 4, FW, 3);
    if(fg2){ R(fg2, 6, 0, 1, FH); R(fg2, 0, 5, FW, 1); }
  };
  switch(code){
    case 'TW': R('#fe0000', 0, 0, FW, FH); R('#000095', 0, 0, 9, 6); disc('#ffffff', 4, 3, 2); disc('#000095', 4, 3, 1); P('#ffffff', [[4, 3]]); break;
    case 'CN': R('#de2910', 0, 0, FW, FH); disc('#ffde00', 3, 3, 1); P('#ffde00', [[3, 1], [1, 3], [5, 3], [2, 5], [4, 5], [6, 1], [7, 2], [7, 4], [6, 5]]); break;
    case 'HK': R('#de2910', 0, 0, FW, FH); P('#ffffff', [[9, 3], [8, 4], [9, 4], [10, 4], [7, 5], [8, 5], [9, 5], [10, 5], [11, 5], [8, 6], [9, 6], [10, 6], [9, 7], [8, 8], [10, 8]]); break;
    case 'JP': R('#ffffff', 0, 0, FW, FH); disc('#bc002d', 9, 6, 3); break;
    case 'KR': R('#ffffff', 0, 0, FW, FH); disc('#cd2e3a', 9, 6, 3); R('#0047a0', 6, 6, 7, 4); disc('#0047a0', 9, 7, 2); R('#ffffff', 5, 10, 9, 2);
      P('#000000', [[2, 1], [3, 2], [4, 3], [14, 1], [15, 2], [13, 2], [2, 10], [3, 9], [14, 10], [15, 9], [13, 9]]); break;
    case 'SG': h2('#ef3340', '#ffffff'); P('#ffffff', [[3, 1], [2, 2], [2, 3], [3, 4], [5, 2], [6, 1], [7, 2], [5, 4], [7, 4]]); break;
    case 'TH': R('#a51931', 0, 0, FW, 2); R('#f4f5f8', 0, 2, FW, 2); R('#2d2a4a', 0, 4, FW, 4); R('#f4f5f8', 0, 8, FW, 2); R('#a51931', 0, 10, FW, 2); break;
    case 'ID': h2('#ce1126', '#ffffff'); break;
    case 'MC': h2('#ce1126', '#ffffff'); break;
    case 'PL': h2('#ffffff', '#dc143c'); break;
    case 'VN': R('#da251d', 0, 0, FW, FH); disc('#ffff00', 9, 6, 1); P('#ffff00', [[9, 3], [9, 4], [6, 5], [7, 5], [11, 5], [12, 5], [7, 8], [11, 8]]); break;
    case 'AU': case 'NZ': R('#012169', 0, 0, FW, FH); union(0, 0, 9, 6);
      P(code === 'NZ' ? '#c8102e' : '#ffffff', [[13, 2], [15, 5], [12, 6], [13, 9], [4, 9], [4, 8], [3, 9], [5, 9], [4, 10]]); break;
    case 'KY': case 'VG': R('#012169', 0, 0, FW, FH); union(0, 0, 9, 6); R('#ffffff', 12, 4, 4, 5); R('#c8102e', 13, 5, 2, 2); R('#2e8540', 13, 7, 2, 1); break;
    case 'BM': R('#c8102e', 0, 0, FW, FH); union(0, 0, 9, 6); R('#ffffff', 12, 4, 4, 5); R('#c8102e', 13, 6, 2, 2); break;
    case 'GB': union(0, 0, FW, FH); break;
    case 'US': for(let i = 0; i < 6; i++) R(i % 2 ? '#ffffff' : '#b22234', 0, i * 2, FW, 2); R('#3c3b6e', 0, 0, 8, 6);
      for(let j = 1; j < 6; j += 2) for(let i = 1; i < 8; i += 2) P('#ffffff', [[i, j]]); break;
    case 'CA': R('#d52b1e', 0, 0, 4, FH); R('#ffffff', 4, 0, 10, FH); R('#d52b1e', 14, 0, 4, FH);
      P('#d52b1e', [[9, 2], [8, 3], [9, 3], [10, 3], [6, 4], [8, 4], [9, 4], [10, 4], [12, 4], [7, 5], [8, 5], [9, 5], [10, 5], [11, 5], [8, 6], [9, 6], [10, 6], [9, 7], [9, 8]]); break;
    case 'CH': R('#d52b1e', 0, 0, FW, FH); R('#ffffff', 8, 2, 3, 8); R('#ffffff', 5, 5, 9, 3); break;
    case 'DE': h3('#000000', '#dd0000', '#ffce00'); break;
    case 'FR': v3('#0055a4', '#ffffff', '#ef4135'); break;
    case 'IT': v3('#009246', '#ffffff', '#ce2b37'); break;
    case 'IE': v3('#169b62', '#ffffff', '#ff883e'); break;
    case 'BE': v3('#000000', '#fae042', '#ed2939'); break;
    case 'NG': v3('#008751', '#ffffff', '#008751'); break;
    case 'MX': v3('#006847', '#ffffff', '#ce1126'); R('#8b5a2b', 8, 5, 2, 2); break;
    case 'LU': h3('#ed2939', '#ffffff', '#00a1de'); break;
    case 'NL': h3('#ae1c28', '#ffffff', '#21468b'); break;
    case 'RU': h3('#ffffff', '#0039a6', '#d52b1e'); break;
    case 'AT': h3('#ed2939', '#ffffff', '#ed2939'); break;
    case 'HU': h3('#ce2939', '#ffffff', '#477050'); break;
    case 'BG': h3('#ffffff', '#00966e', '#d62612'); break;
    case 'EE': h3('#0072ce', '#000000', '#ffffff'); break;
    case 'LT': h3('#fdb913', '#006a44', '#c1272d'); break;
    case 'UA': h2('#0057b7', '#ffd700'); break;
    case 'ES': R('#aa151b', 0, 0, FW, 3); R('#f1bf00', 0, 3, FW, 6); R('#aa151b', 0, 9, FW, 3); R('#aa151b', 4, 5, 2, 2); break;
    case 'PT': R('#006600', 0, 0, 7, FH); R('#ff0000', 7, 0, 11, FH); disc('#ffcc00', 7, 6, 2); break;
    case 'IN': h3('#ff9933', '#ffffff', '#138808'); disc('#000080', 9, 6, 1); P('#ffffff', [[9, 6]]); break;
    case 'IL': R('#ffffff', 0, 0, FW, FH); R('#0038b8', 0, 1, FW, 1); R('#0038b8', 0, 10, FW, 1);
      P('#0038b8', [[9, 3], [8, 4], [10, 4], [7, 5], [11, 5], [7, 7], [11, 7], [8, 8], [10, 8], [9, 9], [7, 4], [11, 4], [7, 8], [11, 8]]); break;
    case 'AE': R('#ff0000', 0, 0, 5, FH); R('#00732f', 5, 0, 13, 4); R('#ffffff', 5, 4, 13, 4); R('#000000', 5, 8, 13, 4); break;
    case 'SA': R('#006c35', 0, 0, FW, FH); R('#ffffff', 4, 3, 10, 1); R('#ffffff', 5, 5, 8, 1); R('#ffffff', 4, 8, 10, 1); P('#ffffff', [[14, 7]]); break;
    case 'QA': R('#8a1538', 0, 0, FW, FH); R('#ffffff', 0, 0, 5, FH); for(let j = 0; j < FH; j += 2) P('#ffffff', [[5, j]]); break;
    case 'BR': R('#009c3b', 0, 0, FW, FH); for(let j = 1; j <= 10; j++){ const w = 8 - Math.abs(j - 5.5) * 1.4; R('#ffdf00', Math.round(9 - w), j, Math.round(w * 2), 1); }
      disc('#002776', 9, 6, 2); R('#ffffff', 7, 6, 5, 1); break;
    case 'CL': R('#ffffff', 0, 0, FW, 6); R('#d52b1e', 0, 6, FW, 6); R('#0039a6', 0, 0, 6, 6); star('#ffffff', 3, 3); break;
    case 'ZA': R('#e03c31', 0, 0, FW, 4); R('#001489', 0, 8, FW, 4); R('#ffffff', 0, 4, FW, 4); R('#007749', 0, 5, FW, 2);
      for(let j = 0; j < FH; j++){ const w = 6 - Math.abs(j - 5.5); R('#007749', 0, j, Math.max(0, Math.round(w)) + 1, 1); R('#000000', 0, j, Math.max(0, Math.round(w) - 1), 1); }
      P('#ffb612', [[0, 3], [0, 8]]); break;
    case 'KE': R('#000000', 0, 0, FW, 3); R('#ffffff', 0, 3, FW, 1); R('#bb0000', 0, 4, FW, 4); R('#ffffff', 0, 8, FW, 1); R('#006600', 0, 9, FW, 3);
      R('#bb0000', 8, 2, 2, 8); R('#000000', 8, 4, 2, 4); R('#ffffff', 8, 5, 2, 2); break;
    case 'TR': R('#e30a17', 0, 0, FW, FH); disc('#ffffff', 6, 6, 3); disc('#e30a17', 7, 6, 2); star('#ffffff', 11, 6); break;
    case 'SE': cross('#006aa7', '#fecc00'); break;
    case 'NO': cross('#ba0c2f', '#ffffff', '#00205b'); break;
    case 'DK': cross('#c60c30', '#ffffff'); break;
    case 'FI': cross('#ffffff', '#002f6c'); break;
    case 'GR': for(let i = 0; i < 6; i++) R(i % 2 ? '#ffffff' : '#0d5eaf', 0, i * 2, FW, 2); R('#0d5eaf', 0, 0, 7, 6); R('#ffffff', 3, 0, 1, 6); R('#ffffff', 0, 2, 7, 1); break;
    case 'MY': for(let i = 0; i < 6; i++) R(i % 2 ? '#ffffff' : '#cc0001', 0, i * 2, FW, 2); R('#010066', 0, 0, 9, 6); disc('#ffcc00', 3, 3, 2); disc('#010066', 4, 3, 1); star('#ffcc00', 6, 3); break;
    case 'PH': R('#0038a8', 0, 0, FW, 6); R('#ce1126', 0, 6, FW, 6); for(let j = 0; j < FH; j++){ const w = 6 - Math.abs(j - 5.5); R('#ffffff', 0, j, Math.round(w) + 1, 1); } disc('#fcd116', 2, 6, 1); break;
    case 'AR': h3('#74acdf', '#ffffff', '#74acdf'); disc('#f6b40e', 9, 6, 1); break;
    case 'CO': R('#fcd116', 0, 0, FW, 6); R('#003893', 0, 6, FW, 3); R('#ce1126', 0, 9, FW, 3); break;
    case 'PE': v3('#d91023', '#ffffff', '#d91023'); break;
    case 'EG': h3('#ce1126', '#ffffff', '#000000'); R('#c09300', 8, 5, 2, 2); break;
    case 'PK': R('#ffffff', 0, 0, 5, FH); R('#01411c', 5, 0, 13, FH); disc('#ffffff', 11, 6, 3); disc('#01411c', 12, 5, 2); star('#ffffff', 14, 4); break;
    case 'BD': R('#006a4e', 0, 0, FW, FH); disc('#f42a41', 8, 6, 3); break;
    /* ── 第三十輪:各國首都的國旗(簡化版 —— 18×12 放不下國徽細節,顏色與版型是對的) ── */
    case 'AL': R('#e41e20', 0, 0, FW, FH); R('#000000', 8, 3, 2, 6); R('#000000', 6, 4, 6, 2); P('#000000', [[5, 3], [12, 3], [7, 9], [10, 9]]); break;
    case 'BA': R('#002395', 0, 0, FW, FH); for(let j = 0; j < FH; j++) R('#fecb00', 5 + j, j, Math.max(0, 11 - j), 1); for(let i = 0; i < 6; i++) P('#ffffff', [[3 + i * 2, i * 2]]); break;
    case 'BY': R('#c8313e', 0, 0, FW, 8); R('#4aa657', 0, 8, FW, 4); R('#ffffff', 0, 0, 3, FH); for(let j = 0; j < FH; j += 2) P('#c8313e', [[1, j]]); break;
    case 'CY': R('#ffffff', 0, 0, FW, FH); R('#d57800', 5, 3, 8, 3); R('#d57800', 7, 2, 3, 1); P('#4e5b31', [[7, 8], [8, 9], [10, 9], [11, 8]]); break;
    case 'CZ': h2('#ffffff', '#d7141a'); for(let j = 0; j < FH; j++){ const w = 6 - Math.abs(j - 5.5); R('#11457e', 0, j, Math.round(w) + 2, 1); } break;
    case 'HR': h3('#ff0000', '#ffffff', '#171796'); for(let j = 3; j < 8; j++) for(let i = 7; i < 11; i++) P((i + j) % 2 ? '#ff0000' : '#ffffff', [[i, j]]); break;
    case 'IS': cross('#02529c', '#ffffff', '#dc1e35'); break;
    case 'LV': R('#9e3039', 0, 0, FW, FH); R('#ffffff', 0, 5, FW, 2); break;
    case 'MD': v3('#0046ae', '#ffd200', '#cc092f'); R('#8b5a2b', 8, 4, 2, 4); break;
    case 'ME': R('#d4af37', 0, 0, FW, FH); R('#c40308', 1, 1, 16, 10); R('#d4af37', 7, 3, 4, 6); break;
    case 'MK': R('#d20000', 0, 0, FW, FH); P('#ffe600', [[0, 0], [1, 1], [2, 2], [17, 0], [16, 1], [15, 2], [0, 11], [1, 10], [17, 11], [16, 10], [9, 0], [9, 1], [9, 10], [9, 11], [0, 6], [1, 6], [16, 6], [17, 6]]); disc('#ffe600', 9, 6, 2); break;
    case 'RO': v3('#002b7f', '#fcd116', '#ce1126'); break;
    case 'RS': h3('#c6363c', '#0c4076', '#ffffff'); R('#c6363c', 4, 3, 3, 5); R('#ffffff', 5, 4, 1, 3); break;
    case 'SI': h3('#ffffff', '#005da4', '#ed1c24'); R('#005da4', 3, 2, 4, 4); R('#ffffff', 4, 3, 2, 2); break;
    case 'SK': h3('#ffffff', '#0b4ea2', '#ee1c25'); R('#ffffff', 3, 2, 6, 7); R('#ee1c25', 4, 3, 4, 5); R('#ffffff', 5, 4, 2, 3); break;
    case 'KZ': R('#00afca', 0, 0, FW, FH); disc('#fec50c', 10, 5, 2); R('#fec50c', 7, 9, 7, 1); for(let j = 0; j < FH; j += 2) P('#fec50c', [[1, j]]); break;
    case 'UZ': h3('#0099b5', '#ffffff', '#1eb53a'); R('#ce1126', 0, 4, FW, 1); R('#ce1126', 0, 7, FW, 1); disc('#ffffff', 2, 2, 1); P('#0099b5', [[3, 2]]); break;
    case 'KG': R('#e8112d', 0, 0, FW, FH); disc('#ffef00', 9, 6, 3); disc('#e8112d', 9, 6, 1); break;
    case 'TJ': R('#cc0000', 0, 0, FW, 3); R('#ffffff', 0, 3, FW, 6); R('#006600', 0, 9, FW, 3); R('#f8c300', 8, 5, 3, 2); break;
    case 'TM': R('#00843d', 0, 0, FW, FH); R('#d22630', 2, 0, 3, FH); P('#ffffff', [[8, 3], [9, 2], [10, 3], [11, 4]]); break;
    case 'AM': h3('#d90012', '#0033a0', '#f2a800'); break;
    case 'AZ': h3('#0092bc', '#e4002b', '#00af66'); disc('#ffffff', 8, 6, 1); P('#e4002b', [[9, 6]]); break;
    case 'GE': R('#ffffff', 0, 0, FW, FH); R('#ff0000', 7, 0, 3, FH); R('#ff0000', 0, 5, FW, 2); P('#ff0000', [[3, 2], [14, 2], [3, 9], [14, 9]]); break;
    case 'IQ': h3('#ce1126', '#ffffff', '#000000'); R('#007a3d', 6, 5, 6, 2); break;
    case 'IR': h3('#239f40', '#ffffff', '#da0000'); R('#da0000', 8, 5, 2, 2); break;
    case 'JO': h3('#000000', '#ffffff', '#007a3d'); for(let j = 0; j < FH; j++){ const w = 7 - Math.abs(j - 5.5); R('#ce1126', 0, j, Math.round(w) + 1, 1); } P('#ffffff', [[2, 6]]); break;
    case 'KW': h3('#007a3d', '#ffffff', '#ce1126'); for(let j = 0; j < FH; j++) R('#000000', 0, j, Math.max(2, 5 - Math.abs(j - 5.5) * .5 | 0), 1); break;
    case 'LB': R('#ed1c24', 0, 0, FW, 3); R('#ffffff', 0, 3, FW, 6); R('#ed1c24', 0, 9, FW, 3); R('#00a651', 8, 4, 2, 4); R('#00a651', 7, 5, 4, 2); break;
    case 'OM': R('#db161b', 0, 0, FW, FH); R('#ffffff', 5, 0, 13, 4); R('#008000', 5, 8, 13, 4); break;
    case 'SY': h3('#ce1126', '#ffffff', '#000000'); star('#007a3d', 6, 6); star('#007a3d', 12, 6); break;
    case 'YE': h3('#ce1126', '#ffffff', '#000000'); break;
    case 'BH': R('#ce1126', 0, 0, FW, FH); R('#ffffff', 0, 0, 5, FH); for(let j = 0; j < FH; j++) P('#ffffff', [[5 + (j % 3 === 1 ? 1 : 0), j]]); break;
    case 'AF': v3('#000000', '#d32011', '#007a36'); R('#ffffff', 8, 5, 2, 2); break;
    case 'BT': for(let j = 0; j < FH; j++) for(let i = 0; i < FW; i++) P(i * FH < (FH - j) * FW ? '#ffd520' : '#ff4e12', [[i, j]]); R('#ffffff', 6, 5, 6, 2); break;
    case 'LK': R('#ffb700', 0, 0, FW, FH); R('#8d153a', 6, 1, 11, 10); R('#005f56', 1, 1, 2, 10); R('#ff5b00', 3, 1, 2, 10); R('#ffb700', 10, 4, 3, 4); break;
    case 'NP': for(let j = 0; j < FH; j++){ const w = j < 6 ? 11 - j * 1.5 : 13 - (j - 6) * 2; R('#003893', 0, j, Math.max(2, Math.round(w)), 1); R('#dc143c', 1, j, Math.max(0, Math.round(w) - 2), 1); }
      P('#ffffff', [[3, 3], [3, 8], [4, 8], [2, 8]]); break;
    case 'MN': v3('#c4272f', '#015197', '#c4272f'); R('#f9cf02', 2, 3, 2, 6); P('#f9cf02', [[2, 1], [3, 1]]); break;
    case 'KP': R('#024fa2', 0, 0, FW, FH); R('#ffffff', 0, 2, FW, 1); R('#ed1c27', 0, 3, FW, 6); R('#ffffff', 0, 9, FW, 1); disc('#ffffff', 5, 6, 2); star('#ed1c27', 5, 6); break;
    case 'KH': R('#032ea1', 0, 0, FW, 3); R('#e00025', 0, 3, FW, 6); R('#032ea1', 0, 9, FW, 3); R('#ffffff', 6, 5, 6, 3); R('#ffffff', 8, 4, 2, 1); break;
    case 'LA': R('#ce1126', 0, 0, FW, 3); R('#002868', 0, 3, FW, 6); R('#ce1126', 0, 9, FW, 3); disc('#ffffff', 9, 6, 2); break;
    case 'MM': h3('#fecb00', '#34b233', '#ea2839'); star('#ffffff', 9, 6); R('#ffffff', 8, 5, 3, 2); break;
    case 'BN': R('#f7e017', 0, 0, FW, FH); for(let i = 0; i < FW; i++){ const y = Math.round(i * .5); R('#ffffff', i, y, 1, 2); R('#000000', i, y + 2, 1, 1); } R('#cf1126', 8, 4, 3, 4); break;
    case 'TL': R('#dc241f', 0, 0, FW, FH); for(let j = 0; j < FH; j++){ const w = 9 - Math.abs(j - 5.5) * 1.6; R('#ffc726', 0, j, Math.max(0, Math.round(w)), 1); R('#000000', 0, j, Math.max(0, Math.round(w - 4)), 1); } P('#ffffff', [[2, 6]]); break;
    case 'PG': for(let j = 0; j < FH; j++) for(let i = 0; i < FW; i++) P(i * FH > j * FW ? '#ce1126' : '#000000', [[i, j]]); P('#ffffff', [[3, 6], [5, 8], [3, 9], [2, 7]]); R('#fcd116', 11, 3, 4, 2); break;
    case 'FJ': R('#68bfe5', 0, 0, FW, FH); union(0, 0, 9, 6); R('#ffffff', 11, 4, 5, 6); R('#ce1126', 11, 4, 5, 2); break;
    case 'SB': for(let j = 0; j < FH; j++) for(let i = 0; i < FW; i++){ const d = i * FH / FW + j - FH; P(Math.abs(d) < 1.3 ? '#fcd116' : d < 0 ? '#0051ba' : '#215b33', [[i, j]]); } P('#ffffff', [[2, 2], [5, 2], [3, 4], [2, 6], [5, 6]]); break;
    case 'VU': h2('#d21034', '#009543'); R('#000000', 0, 5, FW, 2); R('#fdce12', 0, 5, FW, 1);
      for(let j = 0; j < FH; j++){ const w = 7 - Math.abs(j - 5.5); R('#000000', 0, j, Math.max(0, Math.round(w)), 1); } P('#fdce12', [[2, 5], [2, 6]]); break;
    case 'GL': h2('#ffffff', '#d00c33'); disc('#d00c33', 6, 6, 3); R('#ffffff', 3, 6, 7, 3); R('#d00c33', 3, 6, 7, 0); disc('#ffffff', 6, 7, 0); for(let i = 3; i <= 9; i++) P('#ffffff', [[i, 7], [i, 8]]); break;
    case 'BO': h3('#d52b1e', '#f9e300', '#007934'); break;
    case 'BZ': R('#003f87', 0, 0, FW, FH); R('#ce1126', 0, 0, FW, 1); R('#ce1126', 0, 11, FW, 1); disc('#ffffff', 9, 6, 3); disc('#2e8540', 9, 6, 1); break;
    case 'CR': R('#002b7f', 0, 0, FW, FH); R('#ffffff', 0, 2, FW, 2); R('#ce1126', 0, 4, FW, 4); R('#ffffff', 0, 8, FW, 2); break;
    case 'CU': for(let i = 0; i < 5; i++) R(i % 2 ? '#ffffff' : '#002a8f', 0, Math.round(i * 2.4), FW, 3);
      for(let j = 0; j < FH; j++){ const w = 7 - Math.abs(j - 5.5); R('#cf142b', 0, j, Math.round(w) + 1, 1); } P('#ffffff', [[3, 6], [2, 5], [4, 5]]); break;
    case 'DO': R('#002d62', 0, 0, 8, 5); R('#ce1126', 10, 0, 8, 5); R('#ce1126', 0, 7, 8, 5); R('#002d62', 10, 7, 8, 5); R('#ffffff', 8, 0, 2, FH); R('#ffffff', 0, 5, FW, 2); break;
    case 'EC': R('#ffdd00', 0, 0, FW, 6); R('#034ea2', 0, 6, FW, 3); R('#ed1c24', 0, 9, FW, 3); R('#8b5a2b', 8, 4, 2, 4); break;
    case 'GT': v3('#4997d0', '#ffffff', '#4997d0'); R('#2e8540', 8, 5, 2, 2); break;
    case 'GY': R('#009e49', 0, 0, FW, FH); for(let j = 0; j < FH; j++){ const w = FW - Math.abs(j - 5.5) * 3; R('#ffffff', 0, j, Math.max(0, Math.round(w)), 1); R('#fcd116', 0, j, Math.max(0, Math.round(w) - 1), 1);
      const w2 = 9 - Math.abs(j - 5.5) * 1.6; R('#000000', 0, j, Math.max(0, Math.round(w2)), 1); R('#ce1126', 0, j, Math.max(0, Math.round(w2) - 1), 1); } break;
    case 'HN': h3('#0073cf', '#ffffff', '#0073cf'); P('#0073cf', [[9, 6], [6, 5], [12, 5], [6, 7], [12, 7]]); break;
    case 'HT': h2('#00209f', '#d21034'); R('#ffffff', 7, 4, 4, 4); R('#2e8540', 8, 5, 2, 2); break;
    case 'JM': for(let j = 0; j < FH; j++) for(let i = 0; i < FW; i++){ const a = i * FH / FW, b = FH - 1 - a; P(Math.abs(j - a) < 1.2 || Math.abs(j - b) < 1.2 ? '#fed100' : (j < a && j < b) || (j > a && j > b) ? '#009b3a' : '#000000', [[i, j]]); } break;
    case 'NI': h3('#0067c6', '#ffffff', '#0067c6'); R('#c9a100', 8, 5, 2, 2); break;
    case 'PA': R('#ffffff', 0, 0, 9, 6); R('#d21034', 9, 0, 9, 6); R('#005293', 0, 6, 9, 6); R('#ffffff', 9, 6, 9, 6); star('#005293', 4, 3); star('#d21034', 13, 9); break;
    case 'PY': h3('#d52b1e', '#ffffff', '#0038a8'); disc('#fcd116', 9, 6, 1); break;
    case 'SR': R('#377e3f', 0, 0, FW, FH); R('#ffffff', 0, 2, FW, 8); R('#b40a2d', 0, 3, FW, 6); star('#ecc81d', 9, 6); break;
    case 'SV': h3('#0047ab', '#ffffff', '#0047ab'); R('#c9a100', 8, 5, 2, 2); break;
    case 'TT': R('#ce1126', 0, 0, FW, FH); for(let i = 0; i < FW; i++){ const y = Math.round(i * FH / FW); R('#ffffff', i, y - 2, 1, 5); R('#000000', i, y - 1, 1, 3); } break;
    case 'UY': for(let i = 0; i < 9; i++) R(i % 2 ? '#0038a8' : '#ffffff', 0, Math.round(i * 12 / 9), FW, 2); R('#ffffff', 0, 0, 7, 6); disc('#fcd116', 3, 3, 2); break;
    case 'VE': h3('#ffcc00', '#00247d', '#cf142b'); P('#ffffff', [[5, 5], [6, 4], [8, 4], [10, 4], [12, 4], [13, 5]]); break;
    case 'AO': h2('#cc092f', '#000000'); R('#ffcb00', 7, 4, 4, 4); R('#cc092f', 8, 5, 2, 2); break;
    case 'BF': h2('#ef2b2d', '#009e49'); star('#fcd116', 9, 6); break;
    case 'BI': R('#1eb53a', 0, 0, FW, FH); for(let j = 0; j < FH; j++) for(let i = 0; i < FW; i++){ const a = i * FH / FW, b = FH - 1 - a;
      if(Math.abs(j - a) < 1 || Math.abs(j - b) < 1) P('#ffffff', [[i, j]]); else if((j < a && j < b) || (j > a && j > b)) P('#ce1126', [[i, j]]); } disc('#ffffff', 9, 6, 2); break;
    case 'BJ': R('#008751', 0, 0, 7, FH); R('#fcd116', 7, 0, 11, 6); R('#e8112d', 7, 6, 11, 6); break;
    case 'BW': R('#75aadb', 0, 0, FW, FH); R('#ffffff', 0, 4, FW, 4); R('#000000', 0, 5, FW, 2); break;
    case 'CD': R('#007fff', 0, 0, FW, FH); for(let i = 0; i < FW; i++){ const y = Math.round(FH - 1 - i * FH / FW); R('#f7d618', i, y - 2, 1, 5); R('#ce1021', i, y - 1, 1, 3); } star('#f7d618', 3, 2); break;
    case 'CF': for(let i = 0; i < 4; i++) R(['#003082', '#ffffff', '#289728', '#ffce00'][i], 0, i * 3, FW, 3); R('#d21034', 8, 0, 2, FH); star('#ffce00', 3, 1); break;
    case 'CG': for(let j = 0; j < FH; j++) for(let i = 0; i < FW; i++){ const d = i * FH / FW + j - FH; P(Math.abs(d) < 2.5 ? '#fbde4a' : d < 0 ? '#009543' : '#dc241f', [[i, j]]); } break;
    case 'CI': v3('#f77f00', '#ffffff', '#009e60'); break;
    case 'CM': v3('#007a5e', '#ce1126', '#fcd116'); star('#fcd116', 9, 6); break;
    case 'DJ': R('#6ab2e7', 0, 0, FW, 6); R('#12ad2b', 0, 6, FW, 6); for(let j = 0; j < FH; j++){ const w = 8 - Math.abs(j - 5.5) * 1.3; R('#ffffff', 0, j, Math.max(0, Math.round(w)), 1); } P('#d7141a', [[3, 6]]); break;
    case 'DZ': R('#006233', 0, 0, 9, FH); R('#ffffff', 9, 0, 9, FH); disc('#d21034', 9, 6, 3); disc('#006233', 10, 6, 2); disc('#ffffff', 10, 6, 2); R('#006233', 9, 3, 0, 0); star('#d21034', 12, 6); break;
    case 'ER': R('#4189dd', 0, 6, FW, 6); R('#12ad2b', 0, 0, FW, 6); for(let j = 0; j < FH; j++){ const w = FW - Math.abs(j - 5.5) * 3; R('#ea0437', 0, j, Math.max(0, Math.round(w)), 1); } disc('#ffc726', 4, 6, 1); break;
    case 'ET': h3('#078930', '#fcdd09', '#da121a'); disc('#0f47af', 9, 6, 2); star('#fcdd09', 9, 6); break;
    case 'GA': h3('#009e60', '#fcd116', '#3a75c4'); break;
    case 'GH': h3('#ce1126', '#fcd116', '#006b3f'); star('#000000', 9, 6); break;
    case 'GM': R('#ce1126', 0, 0, FW, 4); R('#ffffff', 0, 4, FW, 4); R('#0c1c8c', 0, 5, FW, 2); R('#3a7728', 0, 8, FW, 4); break;
    case 'GN': v3('#ce1126', '#fcd116', '#009460'); break;
    case 'GQ': h3('#3e9a00', '#ffffff', '#e32118'); for(let j = 0; j < FH; j++){ const w = 5 - Math.abs(j - 5.5) * .8; R('#0073ce', 0, j, Math.max(0, Math.round(w)), 1); } break;
    case 'GW': R('#fcd116', 7, 0, 11, 6); R('#009e49', 7, 6, 11, 6); R('#ce1126', 0, 0, 7, FH); star('#000000', 3, 6); break;
    case 'LR': for(let i = 0; i < FH; i++) R(i % 2 ? '#ffffff' : '#bf0a30', 0, i, FW, 1); R('#002868', 0, 0, 6, 6); star('#ffffff', 3, 3); break;
    case 'LS': h3('#00209f', '#ffffff', '#009543'); R('#000000', 8, 5, 3, 2); P('#000000', [[9, 4]]); break;
    case 'LY': R('#e70013', 0, 0, FW, 3); R('#000000', 0, 3, FW, 6); R('#239e46', 0, 9, FW, 3); disc('#ffffff', 8, 6, 2); disc('#000000', 9, 6, 1); star('#ffffff', 11, 6); break;
    case 'MA': R('#c1272d', 0, 0, FW, FH); P('#006233', [[9, 3], [8, 4], [10, 4], [6, 5], [7, 5], [8, 5], [10, 5], [11, 5], [12, 5], [8, 6], [10, 6], [7, 7], [11, 7], [7, 8], [11, 8]]); break;
    case 'MG': R('#ffffff', 0, 0, 6, FH); R('#fc3d32', 6, 0, 12, 6); R('#007e3a', 6, 6, 12, 6); break;
    case 'ML': v3('#14b53a', '#fcd116', '#ce1126'); break;
    case 'MR': R('#00a95c', 0, 0, FW, FH); R('#d01c1f', 0, 0, FW, 2); R('#d01c1f', 0, 10, FW, 2); disc('#ffd700', 9, 6, 2); disc('#00a95c', 9, 5, 2); star('#ffd700', 9, 4); break;
    case 'MW': h3('#000000', '#ce1126', '#339e35'); disc('#ce1126', 9, 3, 1); P('#ce1126', [[6, 3], [12, 3], [7, 2], [11, 2]]); break;
    case 'MZ': R('#007168', 0, 0, FW, 4); R('#ffffff', 0, 4, FW, 1); R('#000000', 0, 5, FW, 2); R('#ffffff', 0, 7, FW, 1); R('#fce100', 0, 8, FW, 4);
      for(let j = 0; j < FH; j++){ const w = 7 - Math.abs(j - 5.5); R('#d21034', 0, j, Math.round(w) + 1, 1); } star('#fce100', 2, 6); break;
    case 'NA': for(let j = 0; j < FH; j++) for(let i = 0; i < FW; i++){ const d = i * FH / FW + j - FH + 1; P(Math.abs(d) < 1.6 ? '#d21034' : Math.abs(d) < 2.4 ? '#ffffff' : d < 0 ? '#003580' : '#009543', [[i, j]]); } disc('#ffce00', 3, 3, 1); break;
    case 'NE': h3('#e05206', '#ffffff', '#0db02b'); disc('#e05206', 9, 6, 1); break;
    case 'RW': R('#00a1de', 0, 0, FW, 6); R('#fad201', 0, 6, FW, 3); R('#20603d', 0, 9, FW, 3); disc('#e5be01', 14, 3, 1); break;
    case 'SD': h3('#d21034', '#ffffff', '#000000'); for(let j = 0; j < FH; j++){ const w = 7 - Math.abs(j - 5.5); R('#007229', 0, j, Math.round(w) + 1, 1); } break;
    case 'SL': h3('#1eb53a', '#ffffff', '#0072c6'); break;
    case 'SN': v3('#00853f', '#fdef42', '#e31b23'); star('#00853f', 9, 6); break;
    case 'SO': R('#4189dd', 0, 0, FW, FH); star('#ffffff', 9, 6); P('#ffffff', [[9, 4], [7, 6], [11, 6]]); break;
    case 'SS': R('#000000', 0, 0, FW, 4); R('#ffffff', 0, 4, FW, 1); R('#da121a', 0, 5, FW, 2); R('#ffffff', 0, 7, FW, 1); R('#078930', 0, 8, FW, 4);
      for(let j = 0; j < FH; j++){ const w = 7 - Math.abs(j - 5.5); R('#0f47af', 0, j, Math.round(w) + 1, 1); } star('#fcdd09', 2, 6); break;
    case 'SZ': R('#3e5eb9', 0, 0, FW, FH); R('#ffd900', 0, 2, FW, 8); R('#b10c0c', 0, 3, FW, 6); R('#ffffff', 6, 5, 3, 2); R('#000000', 9, 5, 3, 2); break;
    case 'TD': v3('#002664', '#fecb00', '#c60c30'); break;
    case 'TG': for(let i = 0; i < 5; i++) R(i % 2 ? '#ffe135' : '#006a4e', 0, Math.round(i * 2.4), FW, 3); R('#d21034', 0, 0, 7, 7); star('#ffffff', 3, 3); break;
    case 'TN': R('#e70013', 0, 0, FW, FH); disc('#ffffff', 9, 6, 3); disc('#e70013', 9, 6, 2); disc('#ffffff', 10, 6, 1); star('#e70013', 10, 6); break;
    case 'TZ': for(let j = 0; j < FH; j++) for(let i = 0; i < FW; i++){ const d = i * FH / FW + j - FH + 1; P(Math.abs(d) < 1.6 ? '#000000' : Math.abs(d) < 2.6 ? '#fcd116' : d < 0 ? '#1eb53a' : '#00a3dd', [[i, j]]); } break;
    case 'UG': for(let i = 0; i < 6; i++) R(['#000000', '#fcdc04', '#d90000'][i % 3], 0, i * 2, FW, 2); disc('#ffffff', 9, 6, 2); R('#9ca69c', 9, 5, 1, 2); break;
    case 'ZM': R('#198a00', 0, 0, FW, FH); R('#de2010', 11, 5, 2, 7); R('#000000', 13, 5, 2, 7); R('#ef7d00', 15, 5, 3, 7); R('#ef7d00', 13, 2, 4, 1); break;
    case 'ZW': for(let i = 0; i < 7; i++) R(['#006400', '#ffd200', '#d40000', '#000000', '#d40000', '#ffd200', '#006400'][i], 0, Math.round(i * 12 / 7), FW, 2);
      for(let j = 0; j < FH; j++){ const w = 8 - Math.abs(j - 5.5) * 1.3; R('#000000', 0, j, Math.max(0, Math.round(w)), 1); R('#ffffff', 0, j, Math.max(0, Math.round(w) - 1), 1); } star('#d40000', 2, 6); break;
    default: return null;
  }
  return c.toDataURL();
}
PX.flagURL = code => (code in FC) ? FC[code] : (FC[code] = (() => { try{ return flagDraw(code); }catch(e){ return null; } })());
PX.flagHTML = code => {
  const u = code ? PX.flagURL(code) : null;
  if(u) return `<img class="pxflag" src="${u}" alt="${code}" title="${code}" draggable="false">`;
  // 沒畫的國家:系統的國旗表情符號(至少是對的)
  if(code && /^[A-Z]{2}$/.test(code)) return `<span class="sysflag">${String.fromCodePoint(...[...code].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65))}</span>`;
  return '';
};
/* 文字裡的表情符號 → <img>。只動文字節點,屬性(title、alt)不動 */
const KEYS = Object.keys(I).sort((a, b) => b.length - a.length);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RE = new RegExp('(' + KEYS.map(esc).join('|') + ')\\uFE0F?', 'gu');
const TEST = new RegExp('(' + KEYS.map(esc).join('|') + ')', 'u');
PX.iconURL = ch => PX.url('ic:' + ch, I[ch]);
function swapText(node){
  const t = node.nodeValue;
  if(!t || !TEST.test(t)) return;
  const p = node.parentNode;
  if(!p || /^(SCRIPT|STYLE|TEXTAREA|SELECT|TITLE)$/.test(p.nodeName)) return;
  // 下拉選單的選項裡放不了圖片:直接拿掉符號,只留文字
  if(p.nodeName === 'OPTION'){ node.nodeValue = t.replace(RE, '').replace(/^\s+/, ''); return; }
  const frag = document.createDocumentFragment();
  let last = 0;
  t.replace(RE, (m, ch, off) => {
    if(off > last) frag.appendChild(document.createTextNode(t.slice(last, off)));
    const img = document.createElement('img');
    img.className = 'pxi'; img.src = PX.iconURL(ch); img.alt = ch; img.draggable = false;
    frag.appendChild(img);
    last = off + m.length;
    return m;
  });
  if(last < t.length) frag.appendChild(document.createTextNode(t.slice(last)));
  p.replaceChild(frag, node);
}
PX.emojify = function(root){
  if(!root) return;
  if(root.nodeType === 3){ swapText(root); return; }
  if(root.nodeType !== 1) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const list = []; let n;
  while((n = w.nextNode())) if(TEST.test(n.nodeValue)) list.push(n);
  list.forEach(swapText);
};
/* 盯著整頁:任何新長出來的節點(重畫的面板、地圖標籤、浮字)都換一次 */
PX.observe = function(){
  if(PX._obs || typeof MutationObserver === 'undefined') return;
  PX._obs = new MutationObserver(ms => {
    for(const m of ms){
      if(m.type === 'characterData') swapText(m.target);
      else for(const a of m.addedNodes) PX.emojify(a);
    }
  });
  PX._obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  PX.emojify(document.body);
};
if(document.body) PX.observe(); else addEventListener('DOMContentLoaded', () => PX.observe());
})();

/* =============================================================================
   像素特效的序列幀:爆炸、衝擊波、火、煙、閃光、塵土、金幣、星星
   -----------------------------------------------------------------------------
   使用者:「爆炸特效也改成像素」。每一種特效是一條橫向的精靈表(N 格),
   CSS 用 steps(N) 一格一格跳 —— 像素遊戲的動畫就是這樣播的,沒有漸變、沒有模糊。
   形狀用座標雜湊打散(不是 Math.random),每次載入都長一樣。
   ============================================================================= */
(function(){
const P = PX.PAL;
const hsh = (x, y, f) => { let h = (x * 374761393 + y * 668265263 + f * 982451653) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
function sheet(fw, fh, n, draw){
  const c = document.createElement('canvas'); c.width = fw * n; c.height = fh;
  const x = c.getContext('2d');
  for(let f = 0; f < n; f++){
    const put = (px, py, col) => { if(px < 0 || py < 0 || px >= fw || py >= fh || !col) return; x.fillStyle = col; x.fillRect(f * fw + px, py, 1, 1); };
    draw(put, f, n);
  }
  return { url: c.toDataURL(), fw, fh, n };
}
const FX = {};
const make = {
  // 爆炸:白心 → 黃 → 橘 → 紅 → 黑煙,後半段開始破洞散掉
  boom: (S) => sheet(S, S, 9, (put, f, n) => {
    const t = f / (n - 1), R = S / 2 - 1, r = R * Math.min(1, .3 + t * 1.4), cx = S / 2, cy = S / 2;
    for(let y = 0; y < S; y++) for(let x = 0; x < S; x++){
      const d = Math.hypot(x + .5 - cx, (y + .5 - cy) * 1.1) + (hsh(x, y, 7) - .5) * 2.2;
      if(d > r) continue;
      const q = d / Math.max(1, r);
      if(t > .45 && hsh(x, y, f) < (t - .45) * 1.9) continue;          // 散開:越後面洞越多
      let col;
      if(t < .2) col = q < .6 ? P.w : P.l;
      else if(t < .45) col = q < .35 ? P.w : q < .6 ? P.y : q < .85 ? P.o : P.r;
      else if(t < .65) col = q < .3 ? P.y : q < .6 ? P.o : q < .85 ? P.r : P.K;
      else col = q < .4 ? P.R : hsh(x, y, 3) < .5 ? P.K : P.G;
      put(x, y, col);
    }
  }),
  // 衝擊波:壓扁的像素橢圓一圈一圈往外
  ring: () => sheet(44, 24, 7, (put, f, n) => {
    const t = (f + 1) / n, rx = 3 + t * 18, ry = rx * .5, cx = 22, cy = 12;
    for(let a = 0; a < 360; a += 2){
      const x = Math.round(cx + Math.cos(a * Math.PI / 180) * rx), y = Math.round(cy + Math.sin(a * Math.PI / 180) * ry);
      if(t > .5 && hsh(x, y, f) < (t - .5)) continue;
      put(x, y, t < .4 ? P.w : t < .7 ? P.l : P.y);
    }
  }),
  // 閃光:十字星芒
  flash: () => sheet(25, 25, 3, (put, f) => {
    const L = [12, 9, 5][f], c = 12;
    for(let i = -L; i <= L; i++){ put(c + i, c, P.w); put(c, c + i, P.w); if(Math.abs(i) < L * .55){ put(c + i, c + i, P.l); put(c + i, c - i, P.l); } }
    for(let y = -3; y <= 3; y++) for(let x = -3; x <= 3; x++) if(x * x + y * y <= 9 - f * 3) put(c + x, c + y, P.w);
  }),
  // 火:四格閃爍的火苗
  fire: () => sheet(10, 14, 4, (put, f) => {
    for(let y = 0; y < 14; y++) for(let x = 0; x < 10; x++){
      const w = (y / 13) * 4.6 + .4 + (hsh(x, y, f) - .5) * 1.4;
      if(Math.abs(x + .5 - 5) > w) continue;
      if(y < 3 && hsh(x, y, f + 9) < .45) continue;
      const q = Math.abs(x + .5 - 5) / Math.max(.5, w);
      put(x, y, y > 9 && q < .5 ? P.l : q < .45 ? P.y : q < .8 ? P.o : P.r);
    }
  }),
  // 煙:一團灰色、往外散
  smoke: () => sheet(14, 14, 6, (put, f, n) => {
    const t = f / (n - 1), r = 3 + t * 4;
    for(let y = 0; y < 14; y++) for(let x = 0; x < 14; x++){
      const d = Math.hypot(x + .5 - 7, y + .5 - 7) + (hsh(x, y, 5) - .5) * 2;
      if(d > r || hsh(x, y, f) < t * .8) continue;
      put(x, y, d < r * .5 ? P.g : P.G);
    }
  }),
  // 塵土:蓋房子的時候從地基揚起來
  dust: () => sheet(24, 10, 6, (put, f, n) => {
    const t = f / (n - 1);
    for(let y = 0; y < 10; y++) for(let x = 0; x < 24; x++){
      const d = Math.hypot((x + .5 - 12) / 2.4, y + .5 - 9) + (hsh(x, y, 4) - .5) * 1.5;
      if(d > 2 + t * 6 || hsh(x, y, f) < t * .9) continue;
      put(x, y, hsh(x, y, 2) < .5 ? P.s : P.m);
    }
  }),
  // 金幣:四格旋轉
  coin: () => sheet(8, 8, 4, (put, f) => {
    const w = [3.5, 2.5, 1, 2.5][f];
    for(let y = 0; y < 8; y++) for(let x = 0; x < 8; x++){
      const q = ((x + .5 - 4) / w) ** 2 + ((y + .5 - 4) / 3.5) ** 2;
      if(q > 1) continue;
      put(x, y, q > .6 ? P.Y : (x < 4 && f !== 2) ? P.l : P.y);
    }
  }),
  // 星星:出牌落地的閃光
  star: () => sheet(9, 9, 4, (put, f) => {
    const L = [4, 3, 2, 1][f];
    for(let i = -L; i <= L; i++){ put(4 + i, 4, P.l); put(4, 4 + i, P.l); }
    put(4, 4, P.w);
  }),
};
PX.fx = function(kind){
  if(FX[kind]) return FX[kind];
  try{
    FX[kind] = kind === 'boom' ? make.boom(32) : kind === 'boomBig' ? make.boom(48) : make[kind]();
  }catch(e){ FX[kind] = null; }
  return FX[kind];
};
/* 一個會播一次(或循環)的像素特效元素。z = 放大倍數,dur = 秒 */
PX.fxEl = function(kind, opt){
  opt = opt || {};
  const s = PX.fx(kind); if(!s) return null;
  const e = document.createElement('div');
  const z = opt.z || 3;
  e.className = 'pxfx' + (opt.cls ? ' ' + opt.cls : '');
  e.style.cssText = `--fw:${s.fw};--fh:${s.fh};--n:${s.n};--z:${z};--dur:${opt.dur || .8}s;--dl:${opt.delay || 0}ms;`
    + `background-image:url(${s.url});animation-iteration-count:${opt.loop ? 'infinite' : 1};` + (opt.css || '');
  return e;
};
})();
