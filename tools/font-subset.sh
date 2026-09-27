#!/bin/sh
# 像素字型子集化:把 Fusion Pixel 12px 繁中切到只剩這個遊戲用得到的字。
# 加了新的中文字(新的卡牌、新的說明)要重跑一次,不然新字會退回系統字型。
#   pip install fonttools brotli
#   npm pack @fontsource/fusion-pixel-12px-proportional-tc && tar xzf fontsource-*.tgz
#   sh tools/font-subset.sh package/files/fusion-pixel-12px-proportional-tc-latin-400-normal.woff2
set -e
SRC="$1"
python3 - <<'PY'
chars=set()
for f in ['index.html','world3d.js','pixel.js','README.md']:
    chars|=set(open(f,encoding='utf8').read())
chars|=set(chr(c) for c in range(0x20,0x7f))
chars|=set('，。、：；！？「」『』（）《》〈〉…—–·●○■□▲▼◆◇★☆→←↑↓✓✕×÷±≈≤≥%％$＄€¥£０１２３４５６７８９')
open('/tmp/empire-chars.txt','w',encoding='utf8').write(''.join(sorted(c for c in chars if ord(c)>=0x20)))
PY
pyftsubset "$SRC" --text-file=/tmp/empire-chars.txt --flavor=woff2 --layout-features='*' \
  --output-file=fonts/fusion-pixel-12-tc.woff2
ls -la fonts/fusion-pixel-12-tc.woff2
