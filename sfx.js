/* =============================================================================
   sfx.js —— 8-bit 音效 + 手機震動
   -----------------------------------------------------------------------------
   使用者:「所有卡牌和東西都要和炸彈一樣的回饋感,可以是動畫或是震動等等」。
   畫面上的回饋之外再加兩層:聲音(像素遊戲就該配晶片音樂那種嗶嗶聲)與震動(手機)。

   · 聲音全部用 WebAudio 即時合成(方波、三角波、白噪音),沒有任何音檔要下載
   · 瀏覽器規定要使用者碰過畫面才能出聲:第一次點擊時才建立 AudioContext
   · 右上角有靜音鈕,選擇存在 localStorage(跟遊戲存檔分開)
   · 震動只有支援 navigator.vibrate 的手機會有(iPhone 的 Safari 不支援,那就只有聲音與畫面)
   ⚠ 這個檔案不碰遊戲狀態,也不用遊戲的種子亂數。
   ============================================================================= */
(function(){
'use strict';
const SFX = window.SFX = {};
const KEY = 'empire-sfx';
let ctx = null, master = null, noiseBuf = null;
SFX.on = (() => { try{ return localStorage.getItem(KEY) !== 'off'; }catch(e){ return true; } })();
SFX.toggle = () => { SFX.on = !SFX.on; try{ localStorage.setItem(KEY, SFX.on ? 'on' : 'off'); }catch(e){} if(SFX.on) SFX.play('click'); return SFX.on; };

function ac(){
  if(ctx) return ctx;
  const C = window.AudioContext || window.webkitAudioContext; if(!C) return null;
  try{
    ctx = new C();
    master = ctx.createGain(); master.gain.value = .16; master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * .6, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let x = 12345;
    for(let i = 0; i < d.length; i++){ x = (x * 1103515245 + 12345) & 0x7fffffff; d[i] = x / 0x3fffffff - 1; }
  }catch(e){ ctx = null; }
  return ctx;
}
// 第一次碰畫面時解鎖聲音(iOS / Chrome 的自動播放規定)
addEventListener('pointerdown', () => { const c = ac(); if(c && c.state === 'suspended') c.resume(); }, { capture: true, passive: true });

/* 一個音:波形、起始頻率 → 結束頻率、長度、音量、延遲 */
function tone(type, f0, f1, dur, vol, at){
  const c = ac(); if(!c) return;
  const t = c.currentTime + (at || 0);
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t);
  if(f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0008, t + dur);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + .02);
}
/* 噪音:爆炸、引擎、揚塵。濾波頻率掃下去 = 「轟」的尾巴 */
function noise(dur, vol, f0, f1, at){
  const c = ac(); if(!c || !noiseBuf) return;
  const t = c.currentTime + (at || 0);
  const s = c.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
  const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
  const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0008, t + dur);
  s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + dur + .02);
}
const arp = (notes, step, type, vol) => notes.forEach((f, i) => tone(type || 'square', f, f, step * 1.3, vol || .5, i * step));

const LIB = {
  click:   () => tone('square', 880, 660, .04, .25),
  pick:    () => { tone('square', 440, 880, .08, .35); },
  launch:  () => { tone('square', 300, 1200, .22, .3); noise(.25, .15, 3000, 800); },
  drop:    () => { tone('square', 220, 70, .14, .6); noise(.12, .3, 1200, 200); },
  coin:    () => { tone('square', 988, 988, .06, .35); tone('square', 1319, 1319, .18, .35, .06); },
  build:   () => { arp([262, 330, 392, 523], .06); noise(.3, .18, 600, 120, .05); },
  upgrade: () => arp([392, 494, 587, 784, 988], .05),
  deal:    () => { arp([330, 415, 494], .07, 'triangle', .6); tone('square', 659, 659, .25, .25, .21); },
  unit:    () => { tone('square', 150, 150, .05, .5); tone('square', 150, 150, .05, .5, .1); tone('square', 200, 200, .12, .5, .2); },
  unlock:  () => arp([523, 659, 784, 1047, 1319, 1568], .05, 'square', .4),
  deny:    () => { tone('square', 140, 110, .09, .5); tone('square', 140, 110, .12, .5, .12); },
  next:    () => { arp([392, 523, 659], .08, 'square', .45); tone('triangle', 784, 784, .35, .5, .24); },
  jet:     () => { noise(1.1, .22, 2400, 500); tone('sawtooth', 180, 90, 1, .08); },
  boom:    () => { noise(.7, .9, 2200, 60); tone('square', 110, 40, .35, .6); },
  boomBig: () => { noise(1.3, 1, 3000, 40); tone('square', 90, 30, .6, .8); noise(.4, .5, 800, 100, .15); },
  hit:     () => { tone('square', 330, 165, .1, .45); },
};
SFX.play = function(name){
  if(!SFX.on) return;
  const f = LIB[name]; if(!f) return;
  try{ const c = ac(); if(!c || c.state !== 'running') return; f(); }catch(e){}
};
/* 震動(手機):短短一下 = 出牌落地;長一點 = 爆炸;兩下 = 被擋 */
const BUZZ = { tap: 12, land: 28, boom: [40, 30, 70], boomBig: [80, 40, 140], deny: [18, 40, 18], next: [15, 30, 15, 30, 40] };
SFX.buzz = function(kind){
  if(!SFX.on) return;
  try{ if(navigator.vibrate) navigator.vibrate(BUZZ[kind] || 15); }catch(e){}
};
/* 一起來:聲音 + 震動 */
SFX.fx = (sound, buzz) => { SFX.play(sound); if(buzz) SFX.buzz(buzz); };
})();
