#!/usr/bin/env python3
"""勢力圖層用的「省 / 州」邊界(provinces.json)。

使用者:「勢力範圍不要用圓圈,把勢力範圍內的地區顏色畫明顯一點」。
所以每一座城市算好「它方圓 460 公里內有哪些省 / 州」與距離,執行時依那座城的勢力半徑
(170~460 公里,見 index.html 的 tyCityZones)挑出範圍內的省,整塊塗上第一名的顏色。

來源:Natural Earth 10m admin-1 states/provinces(公有領域)。這支程式在開發時跑一次,
不在執行時抓 40MB 的原始檔。

用法:python3 tools/make-provinces.py <ne_10m_admin_1_states_provinces.geojson>
輸出:provinces.json = { "P": [ [ring, ...], ... ],   # 每一個省:多邊形的外環(經度, 緯度),簡化過
                         "S": { site: [[省的索引, 距離公里], ...] } }
"""
import json, math, re, sys

MAX_KM = 460          # 勢力半徑的上限(跟 tyCityZones 的上限一致)
PER_SITE = 40         # 一座城最多收幾個省(英國那種切得很細的國家不會爆量)
TOL = 0.06            # 簡化容許誤差(度):地圖貼圖一度大約 11 像素,這個看不出差別

def km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[1], a[0], b[1], b[0]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(min(1, h)))

def dp(pts, tol):
    """Douglas–Peucker"""
    if len(pts) < 5: return pts
    stack, keep = [(0, len(pts) - 1)], {0, len(pts) - 1}
    while stack:
        i, j = stack.pop()
        ax, ay = pts[i]; bx, by = pts[j]
        dx, dy = bx - ax, by - ay; L = math.hypot(dx, dy) or 1e-12
        best, bi = -1, -1
        for k in range(i + 1, j):
            px, py = pts[k]
            d = abs(dy * px - dx * py + bx * ay - by * ax) / L
            if d > best: best, bi = d, k
        if best > tol:
            keep.add(bi); stack += [(i, bi), (bi, j)]
    return [pts[k] for k in sorted(keep)]

def inside(pt, ring):
    x, y, c = pt[0], pt[1], False
    for i in range(len(ring)):
        x1, y1 = ring[i]; x2, y2 = ring[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1: c = not c
    return c

def sites():
    """從 index.html 讀出所有城市(44 座主要 + 各國首都)"""
    s = open('index.html', encoding='utf8').read()
    out = {}
    for m in re.finditer(r"\{ id:'(\w+)',[^}]*?lat:(-?[\d.]+), lng:(-?[\d.]+)", s):
        out[m.group(1)] = (float(m.group(3)), float(m.group(2)))
    src = re.search(r"const TY_MINOR_SRC = `([\s\S]*?)`", s).group(1)
    for l in src.strip().split('\n'):
        iso, cn, nm, reg, lat, lng, tax = l.split('|')
        out['m_' + iso.lower()] = (float(lng), float(lat))
    return out

def main(path):
    S = sites()
    feats = json.load(open(path, encoding='utf8'))['features']
    provs = []                                     # (label 點, [外環...])
    for f in feats:
        g = f['geometry']
        if not g: continue
        polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
        rings = [p[0] for p in polys if p and len(p[0]) > 3]
        if not rings: continue
        p = f['properties']
        lab = (p.get('longitude') or rings[0][0][0], p.get('latitude') or rings[0][0][1])
        provs.append((lab, rings))
    used, P, out = {}, [], {}
    for sid, c in S.items():
        near = []
        for i, (lab, rings) in enumerate(provs):
            d = km(c, lab)
            home = any(inside(c, r) for r in rings) if d < 900 else False
            if home: d = 0
            if d <= MAX_KM: near.append((d, i))
        near.sort()
        lst = []
        for d, i in near[:PER_SITE]:
            if i not in used:
                rings = []
                for r in provs[i][1]:
                    pts = [(round(x, 2), round(y, 2)) for x, y in r]
                    m = len(pts) // 2          # 封閉的環頭尾是同一點:切兩半各自簡化,不然第一段長度是 0 會整個被丟掉
                    q = dp(pts[:m + 1], TOL) + dp(pts[m:], TOL)[1:]
                    if len(q) >= 4: rings.append([[x, y] for x, y in q])
                if not rings: continue
                used[i] = len(P); P.append(rings)
            lst.append([used[i], int(round(d))])
        out[sid] = lst
    json.dump({ 'P': P, 'S': out }, open('provinces.json', 'w', encoding='utf8'), ensure_ascii=False, separators=(',', ':'))
    print(len(S), 'sites ·', len(P), 'provinces')

if __name__ == '__main__':
    main(sys.argv[1])
