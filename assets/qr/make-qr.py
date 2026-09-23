"""衡之娱入口二维码：绿绒底 + 金框 + 中间嵌 App 图标，扫了直接用浏览器打开 H5。

域名已经备案上线（80 端口），所以网址里不再带 :1991 —— 少几个字符，
二维码的版本号就低一档，码点更大更好扫。"""
import cv2, numpy as np
from PIL import Image, ImageDraw, ImageFont

URL = 'http://paohuzi.yytbank.cn'
ICON = '/home/claude/paohuzi/web/public/icon-512.png'
SERIF = '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc'
SANS  = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'

# —— 二维码：纠错等级 H（能挡 30%，中间盖图标也扫得出来）——
p = cv2.QRCodeEncoder_Params(); p.correction_level = cv2.QRCodeEncoder_CORRECT_LEVEL_H
m = cv2.QRCodeEncoder_create(p).encode(URL)
n = m.shape[0]
SC = 24                                   # 一个码点画多大
qr = Image.fromarray(m).convert('L').resize((n*SC, n*SC), Image.NEAREST).convert('RGB')

# 白底 + 静默区
QZ = 4 * SC
side = qr.width + QZ*2
card = Image.new('RGB', (side, side), 'white')
card.paste(qr, (QZ, QZ))

# —— 中间嵌图标：先挖一块白底（留个圆角白边），再把图标放上去 ——
ic = int(side * 0.20)
icon = Image.open(ICON).convert('RGBA').resize((ic, ic), Image.LANCZOS)
pad = int(ic * 0.10)
plate = Image.new('RGBA', (ic + pad*2, ic + pad*2), (0, 0, 0, 0))
d = ImageDraw.Draw(plate)
d.rounded_rectangle([0, 0, plate.width-1, plate.height-1], radius=int(plate.width*0.22), fill='white')
mask = Image.new('L', (ic, ic), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, ic-1, ic-1], radius=int(ic*0.20), fill=255)
plate.paste(icon, (pad, pad), mask)
card.paste(plate, ((side - plate.width)//2, (side - plate.height)//2), plate)

# —— 外面这张海报：绿绒底 + 金边 ——
W = side + 120
H = side + 380
bg = Image.new('RGB', (W, H), (12, 60, 44))
g = Image.new('RGB', (W, H))
gd = ImageDraw.Draw(g)
for y in range(H):                        # 上深下浅一点，像牌桌绒布
    k = y / H
    gd.line([(0, y), (W, y)], fill=(int(10+14*k), int(58+22*k), int(42+16*k)))
bg = g
d = ImageDraw.Draw(bg)
d.rounded_rectangle([18, 18, W-19, H-19], radius=28, outline=(198, 158, 74), width=3)

f_title = ImageFont.truetype(SERIF, 62)
f_sub   = ImageFont.truetype(SANS, 30)
f_url   = ImageFont.truetype(SANS, 28)
f_tip   = ImageFont.truetype(SANS, 26)

def center(text, font, y, fill):
    w = d.textbbox((0, 0), text, font=font)[2]
    d.text(((W - w)//2, y), text, font=font, fill=fill)

center('衡 之 娱', f_title, 54, (242, 201, 118))
center('衡阳红黑 · 六胡抢 · 耒阳提龙', f_sub, 140, (226, 236, 230))

# 二维码贴上去（白卡再加个圆角外框）
qx, qy = (W - side)//2, 196
d.rounded_rectangle([qx-10, qy-10, qx+side+9, qy+side+9], radius=18, fill='white')
bg.paste(card, (qx, qy))

center('扫码用浏览器打开就能玩', f_tip, qy + side + 26, (226, 236, 230))
center(URL, f_url, qy + side + 72, (242, 201, 118))

bg.save('hengzhiyu-qr.png')
print('size', bg.size)

# —— 自检：把海报再扫一遍，认得出来才算数 ——
arr = cv2.cvtColor(np.array(bg), cv2.COLOR_RGB2BGR)
det = cv2.QRCodeDetector()
print('扫出来：', repr(det.detectAndDecode(cv2.cvtColor(arr, cv2.COLOR_BGR2GRAY))[0]))
small = cv2.resize(arr, (360, int(360 * H / W)))   # 缩到手机屏幕那么小也要认得出
print('缩小后：', repr(det.detectAndDecode(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY))[0]))
