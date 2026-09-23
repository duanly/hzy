"""把 pick/ 里挑好的那 20 个字，换成**原分辨率**的同一张（描线才描得细）。
做法：重新从截图里抠一遍（这次不缩小），拿每个候选跟 pick/ 里那张比一比，最像的就是它。"""
import cv2, numpy as np, os, sys, glob
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract import glyph_boxes

def crops(paths):
    out = []
    for p in paths:
        im, ink, boxes = glyph_boxes(p)
        for (x, y, w, h) in boxes:
            c = 255 - ink[y:y+h, x:x+w]
            sq = np.full((max(w, h) + 12, max(w, h) + 12), 255, np.uint8)
            oy, ox = (sq.shape[0] - h) // 2, (sq.shape[1] - w) // 2
            sq[oy:oy+h, ox:ox+w] = c
            out.append(sq)
    return out

def score(a, b):
    """两张图像不像：都缩到 96×96 比黑点重合度（IoU）"""
    A = cv2.resize(a, (96, 96), interpolation=cv2.INTER_AREA) < 128
    B = cv2.resize(b, (96, 96), interpolation=cv2.INTER_AREA) < 128
    inter = (A & B).sum(); union = (A | B).sum()
    return inter / max(1, union)

if __name__ == '__main__':
    cand = crops(sys.argv[1:])
    print('候选', len(cand), '个')
    for f in sorted(glob.glob('pick/*.png')):
        cur = cv2.imread(f, 0)
        best, bs = None, -1
        for c in cand:
            v = score(cur, c)
            if v > bs: bs, best = v, c
        if bs > 0.86:
            cv2.imwrite(f, best)
            print(f'{os.path.basename(f)} ← {best.shape[0]}px（像 {bs:.2f}）')
        else:
            print(f'{os.path.basename(f)} 没找到更清楚的（最像 {bs:.2f}），保持原样')
