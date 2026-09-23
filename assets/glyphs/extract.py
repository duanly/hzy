"""从游戏截图里把牌面上的字一个个抠出来。
牌是白底黑字：先把"牌身"找出来（白色区域 + 把字的笔画填回去），
再在牌身范围内取深色像素 = 笔画，最后把同一个字的笔画聚成一团。"""
import cv2, numpy as np, sys, os

def glyph_boxes(path, ink=120, paper=185, dilate=15, ymin=0.40):
    im = cv2.imread(path); H, W = im.shape[:2]
    g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
    b, gr, r = cv2.split(im)
    white = (g > paper).astype(np.uint8) * 255
    tile = cv2.morphologyEx(white, cv2.MORPH_CLOSE, np.ones((45, 45), np.uint8))   # 牌身（笔画填平）
    tile = cv2.erode(tile, np.ones((5, 5), np.uint8))                              # 缩掉牌沿那一圈
    dark = (g < ink).astype(np.uint8) * 255
    red = ((r.astype(int) - g.astype(int) > 40) & (r > 90)).astype(np.uint8) * 255  # 红字（貳、伍…）
    ink_m = cv2.bitwise_or(dark, red)
    ink_m = cv2.bitwise_and(ink_m, tile)
    ink_m[:int(H * ymin)] = 0
    m = cv2.dilate(ink_m, np.ones((dilate, dilate), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    out = []
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if 55 <= w <= 220 and 30 <= h <= 220 and a > 900:
            pad = dilate // 2
            out.append((x + pad, y + pad, w - 2 * pad, h - 2 * pad))
    out = [trim_top(ink_m, b) for b in out]
    out.sort(key=lambda b: (round(b[1] / 90), b[0]))
    return im, ink_m, out


def trim_top(ink, box, gap=8, thin=0.14):
    """上面那一小条通常是"被这张牌压住的上一张牌的末梢"，不是这个字的一部分：
    按行把墨迹分成几段，最上面那段又薄（不到整体的 14%）、又跟下面隔着空白，就砍掉。
    三、二 这种本来就分几段的字不会误伤 —— 它们每一段都厚得多。"""
    x, y, w, h = box
    rows = (ink[y:y+h, x:x+w] > 0).sum(1)
    bands, st = [], None
    for i, v in enumerate(rows):
        if v and st is None: st = i
        elif not v and st is not None: bands.append((st, i)); st = None
    if st is not None: bands.append((st, len(rows)))
    while len(bands) >= 2:
        (a0, a1), (b0, _) = bands[0], bands[1]
        if (a1 - a0) < h * thin and (b0 - a1) >= gap:
            bands.pop(0)
        else:
            break
    if not bands: return box
    top = bands[0][0]; bot = bands[-1][1]
    return (x, y + top, w, max(1, bot - top))

if __name__ == '__main__':
    srcs = sys.argv[1:] or ['shot.jpg']
    os.makedirs('cut', exist_ok=True)
    tiles, names = [], []
    for si, src in enumerate(srcs):
        im, ink, boxes = glyph_boxes(src)
        print(src, '抠到', len(boxes), '个字')
        vis = im.copy()
        for i, (x, y, w, h) in enumerate(boxes):
            cv2.rectangle(vis, (x, y), (x + w, y + h), (0, 0, 255), 3)
            crop = 255 - ink[y:y+h, x:x+w]            # 黑字白底
            sq = np.full((max(w, h) + 12, max(w, h) + 12), 255, np.uint8)
            oy, ox = (sq.shape[0] - h) // 2, (sq.shape[1] - w) // 2
            sq[oy:oy+h, ox:ox+w] = crop
            name = f'{si}-{i:02d}'
            cv2.imwrite(f'cut/{name}.png', sq)                       # 原分辨率：描线用这一份
            small = cv2.resize(sq, (128, 128), interpolation=cv2.INTER_AREA)
            tiles.append(small); names.append(name)
        cv2.imwrite(f'boxes-{si}.png', vis)
    # 联系表：一排 8 个
    per = 8
    rows = (len(tiles) + per - 1) // per
    sheet = np.full((rows * 140, per * 140), 255, np.uint8)
    for i, t in enumerate(tiles):
        r, c = divmod(i, per)
        sheet[r*140+6:r*140+134, c*140+6:c*140+134] = t
        cv2.putText(sheet, names[i], (c*140+6, r*140+136), cv2.FONT_HERSHEY_SIMPLEX, .4, 0, 1)
    cv2.imwrite('sheet.png', sheet)
    print('对照表 sheet.png：照着把 cut/*.png 改名成「字」.png 放进 pick/，再跑 trace.py')
