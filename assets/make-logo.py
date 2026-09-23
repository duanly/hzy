# 衡之娱 图标：三张牌叠成一把扇子 —— 字牌「貳」、麻将「發」、扑克「黑桃A」
# 正好是衡阳最常玩的三样：字牌、麻将、扑克。
from PIL import Image, ImageDraw, ImageFont
import math, os

ROOT = '/home/claude/paohuzi'
SEAL = f'{ROOT}/assets/fonts/LXGWSeal-Regular.ttf'          # 字牌那套篆书
SERIF = '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc'
S = 1024                                                     # 先画大，最后缩
FELT1, FELT2 = (22, 92, 66), (8, 42, 32)
GOLD = (198, 160, 78)
RED  = (176, 28, 38)
GREEN= (22, 122, 72)
INK  = (26, 26, 26)
FACE = (250, 248, 242)


def fish(L, color, alpha=255):
    """一条草鱼（侧身）：纺锤形的身子、分叉的尾、背鳍腹鳍各一片，再点个眼睛。
       草鱼最好看的就是那身鳞 —— 大片、排得齐、每一片压着下一片，
       所以鳞是一行行半圆弧叠出来的（行与行错开半格），再压一道深色的背、
       一条浅色的肚子和一根侧线，这样才有层次，不是一块死色。
       画在一张 L×L 的透明纸上，鱼头朝右。"""
    im = Image.new('RGBA', (L, L), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = color + (alpha,)
    def mix(t):                                   # 往深里调（t 越大越深）
        return tuple(int(v * (1 - t)) for v in color) + (alpha,)
    def lite(t):                                  # 往浅里调
        return tuple(int(v + (255 - v) * t) for v in color) + (alpha,)
    cy = L * .5
    bx0, bx1 = L * .22, L * .92                   # 身子：左窄右宽的纺锤，拉长
    bh = L * .082                                 # 草鱼身子细长 —— 宁可瘦，胖了就不像草鱼了

    # 鳍和尾（先画，让身子压在上面）
    d.polygon([(bx0 + L * .04, cy), (L * .02, cy - L * .125), (L * .11, cy)], fill=c)
    d.polygon([(bx0 + L * .04, cy), (L * .02, cy + L * .125), (L * .11, cy)], fill=c)
    d.polygon([(L * .46, cy - bh * .7), (L * .58, cy - L * .19), (L * .68, cy - bh * .75)], fill=c)
    d.polygon([(L * .49, cy + bh * .7), (L * .56, cy + L * .155), (L * .66, cy + bh * .75)], fill=c)
    # 鳍条：从鳍根拉向鳍尖的几道细线，鳍才不是一块死板的三角。
    # 起点在鳍根那条边上按比例取，终点只走到鳍尖的八成 —— 这样线一定落在鳍里头，不会戳出去。
    lw = max(1, int(L * .006))
    def rays(a, b, tip, n=3, reach=.82, t0=.35):
        for k in range(1, n + 1):
            t = t0 + (1 - t0) * k / (n + 1)
            p0 = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            p1 = (p0[0] + (tip[0] - p0[0]) * reach, p0[1] + (tip[1] - p0[1]) * reach)
            d.line([p0, p1], fill=mix(.35), width=lw)
    rays((L * .46, cy - bh * .7), (L * .68, cy - bh * .75), (L * .58, cy - L * .19))            # 背鳍
    rays((L * .49, cy + bh * .7), (L * .66, cy + bh * .75), (L * .56, cy + L * .155), n=2)      # 腹鳍
    rays((L * .11, cy), (bx0 + L * .04, cy), (L * .02, cy - L * .125), n=2, reach=.9)           # 尾（上叉）
    rays((L * .11, cy), (bx0 + L * .04, cy), (L * .02, cy + L * .125), n=2, reach=.9)           # 尾（下叉）

    body = [bx0, cy - bh, bx1, cy + bh]
    d.ellipse(body, fill=c)

    # —— 鳞片：一行行半圆弧，行间错开半格，只盖在身子上 ——
    mask = Image.new('L', (L, L), 0)
    ImageDraw.Draw(mask).ellipse(body, fill=255)
    sc = Image.new('RGBA', (L, L), (0, 0, 0, 0))
    ds = ImageDraw.Draw(sc)
    ds.ellipse([bx0, cy - bh * .05, bx1, cy + bh], fill=lite(.34))      # 浅色的肚子
    ds.ellipse([bx0, cy - bh, bx1, cy - bh * .30], fill=mix(.26))       # 深色的背
    pitch = L * .058
    r = pitch * .62
    rows = int((bh * 2) / (pitch * .62)) + 2
    cols = int((bx1 - bx0) / (pitch * .72)) + 2
    for iy in range(rows):
        y = cy - bh + pitch * .60 * iy
        for ix in range(cols):
            x = bx0 + pitch * .72 * ix + (pitch * .36 if iy % 2 else 0)
            ds.arc([x - r, y - r, x + r, y + r], start=-72, end=72, fill=mix(.42), width=lw)
    sc.putalpha(Image.composite(sc.getchannel('A'), Image.new('L', (L, L), 0), mask))
    im.alpha_composite(sc)
    d.line([(bx0 + L * .06, cy + bh * .18), (bx1 - L * .06, cy + bh * .02)], fill=mix(.4), width=lw)   # 侧线

    # —— 眼睛 ——
    # 挖个洞当眼睛是死的。真鱼的眼是一层套一层：外面一圈眼眶，里面一圈虹膜，
    # 中间一点瞳仁，瞳仁上还挂着一粒高光 —— 就是那一粒让眼睛显得是湿的、活的。
    # 上面再压两道弧当眼睑，一粗一细，像双眼皮，眼睛这才有厚度不是贴上去的圆片。
    ea = min(255, int(alpha * 1.45))                # 眼睛比身子实，不然这点层次全糊掉
    ex, ey = L * .790, cy - L * .016
    r0, r1, r2 = L * .031, L * .0245, L * .0115
    d.ellipse([ex - r0, ey - r0, ex + r0, ey + r0], fill=tuple(int(v * .55) for v in color) + (ea,))        # 眼眶
    d.ellipse([ex - r1, ey - r1, ex + r1, ey + r1], fill=tuple(int(v + (255 - v) * .86) for v in color) + (ea,))  # 虹膜
    d.ellipse([ex - r2, ey - r2, ex + r2, ey + r2], fill=(10, 30, 24, ea))                                  # 瞳仁
    hx, hy, h = ex - r2 * .45, ey - r2 * .5, L * .0072
    d.ellipse([hx - h, hy - h, hx + h, hy + h], fill=(255, 255, 255, ea))                                   # 高光
    h2 = L * .0036
    d.ellipse([ex + r2 * .45 - h2, ey + r2 * .5 - h2, ex + r2 * .45 + h2, ey + r2 * .5 + h2],
              fill=(255, 255, 255, int(ea * .55)))                                                          # 下方一粒回光，更水润
    # —— 嘴：微微张着，上下唇分得开 ——
    # 一条缝是看不出唇的，所以分三层：中间一道深色的口缝（张开的那点空），
    # 上面压一条厚些的上唇（吻端本来就厚，压住下唇），下面一条薄些的下唇。
    mx, my = L * .888, cy + L * .012                                   # 嘴角，靠吻端偏下
    d.polygon([(L * .830, my - L * .012), (mx + L * .026, my - L * .004),
               (mx + L * .024, my + L * .015), (L * .832, my + L * .017)], fill=mix(.72))   # 口缝
    lipw = max(2, int(L * .017))
    d.line([(L * .812, my - L * .030), (L * .862, my - L * .018), (mx + L * .028, my - L * .004)],
           fill=lite(.46), width=lipw, joint='curve')                                        # 上唇（厚，压住下唇）
    d.line([(L * .836, my + L * .032), (L * .874, my + L * .026), (mx + L * .024, my + L * .015)],
           fill=lite(.12), width=max(2, lipw - 4), joint='curve')                            # 下唇（薄一点）
    # 两根短须：从嘴角往后下方垂，末梢细一点 —— 分两段画，后半段更细就有收锋的味道
    # 短须：草鱼那两根是短而粗的，不是龙须那种飘带 —— 长度只留三分之一，粗细照旧
    for sy, dx1, dy1, dx2, dy2 in ((L * .000, L * .017, L * .011, L * .032, L * .027),
                                   (L * .016, L * .013, L * .017, L * .023, L * .035)):
        d.line([(mx + L * .016, my + sy), (mx - dx1, my + sy + dy1)],
               fill=lite(.22), width=max(2, int(L * .0105)), joint='curve')
        d.line([(mx - dx1, my + sy + dy1), (mx - dx2, my + sy + dy2)],
               fill=lite(.10), width=max(1, int(L * .0065)), joint='curve')

    ew = max(1, int(L * .006))
    d.arc([ex - r0 * 1.06, ey - r0 * 1.16, ex + r0 * 1.06, ey + r0 * .96], 200, 340,
          fill=tuple(int(v * .5) for v in color) + (ea,), width=ew)                                         # 上眼睑
    d.arc([ex - r0 * 1.24, ey - r0 * 1.40, ex + r0 * 1.24, ey + r0 * 1.08], 214, 326,
          fill=tuple(int(v * .72) for v in color) + (int(ea * .7),), width=max(1, ew - 1))                  # 双眼皮那道细的
    return im

def bend(im, amp, phase=0.0, power=1.6):
    """把一条画直了的鱼**扭出弧度**来：一列一列地上下错开，错多少按正弦走。
       鱼头那一端错得少、鱼尾那一端错得多（power 那个次方就是干这个的）——
       活鱼摆尾就是这样，头基本不动、劲全在后半截。
       amp 是最大错开多少像素，phase 换一个相位就换一种姿势。"""
    import math
    L = im.width
    out = Image.new('RGBA', (L, L), (0, 0, 0, 0))
    for x in range(L):
        t = x / (L - 1)                     # 0 = 尾，1 = 头（鱼头朝右）
        w = (1 - t) ** power                # 越靠尾巴摆得越狠
        dy = amp * w * math.sin(math.pi * 1.15 * t + phase)
        out.alpha_composite(im.crop((x, 0, x + 1, L)), (x, int(round(dy))))
    return out


def swim(im, L, x, y, ang, color, alpha, flip=False, amp=0.0, phase=0.0):
    f = fish(L, color, alpha)
    if amp: f = bend(f, amp, phase)
    if flip: f = f.transpose(Image.FLIP_LEFT_RIGHT)
    f = f.rotate(ang, resample=Image.BICUBIC)
    im.alpha_composite(f, (int(x - L / 2), int(y - L / 2)))

def fish_front(L, color, alpha=255):
    """正对着人的一条：只看得见圆圆的头、两边张开的胸鳍，身子往后收成一道细影。
       游到跟前来看你 —— 三条里留一条这么画，整幅才不像贴纸。"""
    im = Image.new('RGBA', (L, L), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = color + (alpha,)
    cx, cy = L * .5, L * .5
    # 身子往后缩成一小截（透视：越远越窄），尾鳍在最后面露一点点
    d.polygon([(cx - L * .10, cy - L * .02), (cx + L * .10, cy - L * .02),
               (cx + L * .045, cy - L * .30), (cx - L * .045, cy - L * .30)], fill=c)
    d.polygon([(cx - L * .085, cy - L * .27), (cx + L * .085, cy - L * .27), (cx, cy - L * .40)], fill=c)
    # 两片胸鳍往两边张开
    d.polygon([(cx - L * .10, cy - L * .01), (cx - L * .40, cy + L * .16), (cx - L * .08, cy + L * .15)], fill=c)
    d.polygon([(cx + L * .10, cy - L * .01), (cx + L * .40, cy + L * .16), (cx + L * .08, cy + L * .15)], fill=c)
    # 头：正对着看的时候就是一个圆脑袋
    d.ellipse([cx - L * .21, cy - L * .17, cx + L * .21, cy + L * .27], fill=c)
    e = L * .048
    for sx in (-L * .098, L * .098):                                                                                            # 两只眼
        d.ellipse([cx + sx - e, cy - L * .045 - e, cx + sx + e, cy - L * .045 + e], fill=(0, 0, 0, 0))
    d.ellipse([cx - L * .045, cy + L * .13, cx + L * .045, cy + L * .21], fill=(0, 0, 0, 0))                                    # 嘴
    return im

def face_you(im, L, x, y, ang, color, alpha):
    f = fish_front(L, color, alpha).rotate(ang, resample=Image.BICUBIC)
    im.alpha_composite(f, (int(x - L / 2), int(y - L / 2)))

def bg():
    im = Image.new('RGB', (S, S), FELT2)
    d = ImageDraw.Draw(im)
    cx = cy = S / 2
    for i in range(int(S * 0.72), 0, -2):                    # 中间亮一点的绒面
        t = i / (S * 0.72)
        c = tuple(int(FELT2[k] + (FELT1[k] - FELT2[k]) * (1 - t) ** 1.5) for k in range(3))
        d.ellipse([cx - i, cy - i, cx + i, cy + i], fill=c)
    # 两道金圈
    for r, w in ((S * 0.455, 6), (S * 0.432, 2)):
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=GOLD, width=w)
    return im

def ripples(im):
    """湖面荡开的水纹：几道长长的正弦线，越往下越疏、越淡 ——
       跟牌桌上那张底图是一个路数，压在最底下不抢戏。"""
    import math
    lay = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    for i, (y0, amp, wav, a, w) in enumerate((
            (S * .28, S * .028, 1.6, 46, 4), (S * .41, S * .036, 1.25, 54, 5),
            (S * .55, S * .042, 1.05, 54, 5), (S * .69, S * .038, 1.45, 44, 5),
            (S * .82, S * .030, 1.8, 36, 4))):
        pts = [(x, y0 + amp * math.sin(2 * math.pi * wav * x / S + i * 1.3)) for x in range(0, S + 8, 8)]
        d.line(pts, fill=(196, 232, 210, a), width=w, joint='curve')
        pts2 = [(x, y + S * .016) for x, y in pts]
        d.line(pts2, fill=(8, 40, 30, int(a * .8)), width=max(2, w - 1), joint='curve')   # 波纹下面那道暗边，才有起伏
    # 只留在金圈里面
    m = Image.new('L', (S, S), 0)
    ImageDraw.Draw(m).ellipse([S * .5 - S * .432, S * .5 - S * .432, S * .5 + S * .432, S * .5 + S * .432], fill=255)
    lay.putalpha(Image.composite(lay.getchannel('A'), Image.new('L', (S, S), 0), m))
    im.paste(lay, (0, 0), lay)


def card(w, h, draw_face):
    """一张牌：白脸、圆角、细金边；draw_face(d, w, h) 往上画字。"""
    pad = 18
    im = Image.new('RGBA', (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    r = int(w * 0.13)
    box = [pad, pad, pad + w, pad + h]
    d.rounded_rectangle([box[0] + 5, box[1] + 8, box[2] + 5, box[3] + 8], r, fill=(0, 0, 0, 90))   # 影子
    d.rounded_rectangle(box, r, fill=FACE, outline=(214, 196, 150), width=3)
    face = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    draw_face(ImageDraw.Draw(face), w, h)
    im.alpha_composite(face, (pad, pad))
    return im

def centered(d, box, text, font, fill):
    x0, y0, x1, y1 = box
    b = d.textbbox((0, 0), text, font=font)
    d.text((x0 + (x1 - x0 - (b[2] - b[0])) / 2 - b[0],
            y0 + (y1 - y0 - (b[3] - b[1])) / 2 - b[1]), text, font=font, fill=fill)

CW, CH = 250, 350

def face_zi(d, w, h):            # 字牌：红底白字「貳」，跟牌桌上一个样
    d.rounded_rectangle([w * .11, h * .09, w * .89, h * .91], int(w * .09), fill=RED)
    centered(d, (w * .11, h * .09, w * .89, h * .91), '貳', ImageFont.truetype(SERIF, int(h * .60)), FACE)

def face_fa(d, w, h):            # 麻将：绿色的「發」
    centered(d, (0, h * .04, w, h * .96), '發', ImageFont.truetype(SERIF, int(h * .66)), GREEN)

def face_spade(d, w, h):         # 扑克：黑桃 A（角标 + 中间一颗大黑桃）
    fa = ImageFont.truetype(SERIF, int(h * .19))
    fs = ImageFont.truetype(SERIF, int(h * .17))
    d.text((w * .10, h * .05), 'A', font=fa, fill=INK)
    d.text((w * .11, h * .23), '♠', font=fs, fill=INK)
    centered(d, (0, h * .18, w, h * .98), '♠', ImageFont.truetype(SERIF, int(h * .52)), INK)

im = bg()
ripples(im)                                   # 水波压在最底下，牌和鱼都浮在它上面
# 三张牌摆成一把小扇子：發在左、貳在中（最前）、黑桃A在右
# 三张牌叠成一把扇子：叠得多一点（只露半张脸），整把再往右歪 15° —— 太正了像摆拍
fan = Image.new('RGBA', (S, S), (0, 0, 0, 0))
for face, ang, dx, dy, sc in ((face_fa, -25, -196, 44, .90), (face_spade, 25, 196, 44, .90), (face_zi, 0, 0, -22, 1.0)):
    c = card(int(CW * sc), int(CH * sc), face).rotate(-ang, resample=Image.BICUBIC, expand=True)
    fan.alpha_composite(c, (int(S / 2 - c.width / 2 + dx), int(S / 2 - c.height / 2 + dy)))
fan = fan.rotate(-15, resample=Image.BICUBIC, center=(S / 2, S / 2))     # 负角度 = 往右歪
im.paste(fan, (0, 0), fan)

# 「娱」跟「鱼」同音 —— 空处放三条草鱼，游得散一点，别排队。
# 颜色用比绒面亮一档的青玉，压着背景走，不跟牌抢眼。
sch = Image.new('RGBA', (S, S), (0, 0, 0, 0))
JADE = (150, 205, 172)
# 三条都是侧身，但各摆各的：一条身子几乎直（正巡游）、一条弓着腰使劲、一条轻轻摆尾。
swim(sch, int(S * .28), S * .250, S * .742, 14, JADE, 122, amp=S * .026, phase=0.4)             # 左下，最大的一条，朝右上
swim(sch, int(S * .19), S * .765, S * .285, -22, JADE, 104, flip=True, amp=S * .050, phase=2.0)  # 右上，朝左，弓得最狠
swim(sch, int(S * .175), S * .760, S * .785, -6, JADE, 100, amp=S * .034, phase=3.6)             # 右下，轻轻摆尾
im.paste(sch, (0, 0), sch)

os.makedirs('/tmp/claude-0/logo/out', exist_ok=True)
for name, size in (('icon-512.png', 512), ('icon-192.png', 192), ('apple-touch-icon.png', 180), ('favicon.png', 64)):
    im.resize((size, size), Image.LANCZOS).save(f'/tmp/claude-0/logo/out/{name}')
im.resize((512, 512), Image.LANCZOS).save('/tmp/claude-0/logo/preview.png')
print('done')
