"""把抠出来的字（黑字白底的小图）描成 SVG 路径，生成 web/src/glyphs.ts。

用法：
  1) python3 extract.py 截图1.jpg 截图2.jpg ...      → 抠图到 cut/，并出一张 sheet.png 对照
  2) 人工把 cut/xx.png 改名成「字」.png（一 二 … 十 壹 贰 … 拾），放到 pick/ 下
  3) python3 trace.py                                → 生成 ../../web/src/glyphs.ts

描线用 OpenCV 的轮廓 + 多边形逼近：字牌的字笔画粗、拐角硬，多边形足够像；
比起位图，SVG 路径能随牌面大小无级缩放，也不占几 KB。
"""
import cv2, numpy as np, os, sys

SMALL = list('一二三四五六七八九十')
BIG = list('壹贰叁肆伍陆柒捌玖拾')
ORDER = SMALL + BIG                      # 跟引擎的 kind 编码一一对应：0~9 小、10~19 大

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'web', 'src', 'glyphs.ts')

def trace(path: str, box=100.0, up=4, eps=4.0, smooth=2) -> str:
    """描一个字。
    截图里的字才 140 像素见方，直接描出来的轮廓全是台阶（手机上看就是"毛边"）。
    所以先**放大 4 倍再糊一下**，让台阶化成平滑的边，再在这个尺度上描线；
    最后按拐角软硬做一次"切角"（Chaikin）：**平缓的地方磨圆，尖角原样留着** ——
    书法字的出锋、顿笔都是尖的，一律磨圆就没筋骨了。
    """
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None: raise SystemExit(f'读不了 {path}')
    _, bw = cv2.threshold(img, 128, 255, cv2.THRESH_BINARY_INV)      # 笔画=白
    bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    big = cv2.resize(bw, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC)
    big = cv2.GaussianBlur(big, (2 * up + 1, 2 * up + 1), 0)
    _, big = cv2.threshold(big, 128, 255, cv2.THRESH_BINARY)
    cnts, _ = cv2.findContours(big, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if not len(cnts): return ''
    xs = np.vstack([c.reshape(-1, 2) for c in cnts])
    x0, y0 = xs.min(0); x1, y1 = xs.max(0)
    k = box / max(x1 - x0, y1 - y0, 1)
    ox = (box - (x1 - x0) * k) / 2; oy = (box - (y1 - y0) * k) / 2
    parts = []
    for c in cnts:
        if cv2.contourArea(c) < 6 * up * up: continue               # 太小的碎点不要（多半是压缩噪点）
        p = cv2.approxPolyDP(c, eps, True).reshape(-1, 2).astype(float)
        if len(p) < 3: continue
        for _ in range(smooth): p = chaikin(p)
        d = []
        for i, (x, y) in enumerate(p):
            X = (x - x0) * k + ox; Y = (y - y0) * k + oy
            d.append(f'{"M" if i == 0 else "L"}{X:.1f} {Y:.1f}')
        parts.append(''.join(d) + 'Z')
    return ''.join(parts)


def chaikin(p, keep_deg=72.0):
    """切角：每条边取 1/4、3/4 两点代替原来的顶点 —— 但**拐得太急的顶点原样保留**
    （夹角小于 keep_deg 就算尖角：捺脚、出锋这些地方不能磨）。"""
    n = len(p)
    out = []
    for i in range(n):
        a, b, c = p[i - 1], p[i], p[(i + 1) % n]
        v1, v2 = a - b, c - b
        n1, n2 = np.linalg.norm(v1), np.linalg.norm(v2)
        ang = 180.0 if n1 < 1e-6 or n2 < 1e-6 else np.degrees(
            np.arccos(np.clip(np.dot(v1, v2) / (n1 * n2), -1, 1)))
        if ang < keep_deg:                      # 尖角：留着
            out.append(b)
        else:                                   # 平缓：切成两点
            out.append(b + 0.25 * (a - b))
            out.append(b + 0.25 * (c - b))
    return np.array(out)


def main():
    pick = os.path.join(HERE, 'pick')
    got = {}
    for i, ch in enumerate(ORDER):
        f = os.path.join(pick, f'{ch}.png')
        if os.path.exists(f):
            got[i] = trace(f)
    if not got: raise SystemExit('pick/ 里一个字都没有')
    lines = ['/* 牌面手写体：照实物截图一个个描出来的（assets/glyphs/trace.py 生成，别手改）。',
             ' * 键是引擎的 kind：0~9 是小一~小十，10~19 是大壹~大拾；值是 100×100 画布里的 SVG 路径。 */',
             'export const GLYPHS: Record<number, string> = {']
    for k in sorted(got): lines.append(f"  {k}: '{got[k]}',")
    lines.append('};')
    lines.append('/** 二十个字齐了才把这款字体摆进选单 —— 缺字的半成品比系统字体还难看 */')
    lines.append('export const GLYPHS_READY = Object.keys(GLYPHS).length >= 20;')
    with open(OUT, 'w', encoding='utf-8') as f: f.write('\n'.join(lines) + '\n')
    print('写好了', OUT, '共', len(got), '个字')

if __name__ == '__main__':
    main()
