/**
 * 把「几局一歇」那一屏的账画成一张图，长按就能存下来发群里。
 *
 * 为什么是自己画、不是对着 DOM 截图（html2canvas 那一路）：
 *  · 那类库要把整棵树的样式重算一遍，两百多 KB，画出来的还常跟屏幕上对不上（字体、圆角、渐变）；
 *  · 暂停那块牌子是红底白字、还可能滚动裁掉半行 —— 直接截下来并不好看，也不好发；
 *  · 这张表就是"几个名字几个数"，自己画反而干净、清楚、每台机器一个样。
 * 纯 canvas，没有任何依赖，壳里和浏览器里都能跑。
 */

export interface ShotRow { name: string; seg: number; total: number }
export interface ShotData {
  title: string;        // 「红黑 04 · 底分 1」
  sub: string;          // 「第 8 局 · 2026-09-23 01:58」
  segLabel: string;     // 「这 6 局」
  rows: ShotRow[];
  foot?: string;
}

const fmt = (n: number) => (n > 0 ? `+${n}` : String(n));
/** 中文用等宽的数字看着齐，名字还是正常字体 */
const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif';

/** 画成 PNG 的 dataURL。宽度固定 720（逻辑像素），按 dpr 放大保证清楚 */
export function drawTally(d: ShotData, dpr = Math.min(3, Math.max(2, devicePixelRatio || 2))): string {
  const W = 720;
  const PAD = 40;
  const ROW = 66;                       // 每个玩家一行
  const HEAD = 150;                     // 标题区
  const TH = 52;                        // 表头
  const H = HEAD + TH + ROW * d.rows.length + 96;

  const cv = document.createElement('canvas');
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext('2d')!;
  g.scale(dpr, dpr);

  // 底：牌桌那个绿，压暗一点，四角留白
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#1c4a37'); bg.addColorStop(1, '#0f2f22');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  // 金线框
  g.strokeStyle = 'rgba(214,183,106,.55)'; g.lineWidth = 2;
  g.strokeRect(14, 14, W - 28, H - 28);

  // 标题
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#f2e6c4'; g.font = `700 40px ${FONT}`; g.textAlign = 'center';
  g.fillText(d.title, W / 2, 78);
  g.fillStyle = 'rgba(242,230,196,.66)'; g.font = `400 24px ${FONT}`;
  g.fillText(d.sub, W / 2, 116);

  // 三列：名字靠左，两个数靠右
  const xName = PAD + 14;
  const xSeg = W - PAD - 210;
  const xTot = W - PAD - 14;
  let y = HEAD;

  g.font = `600 24px ${FONT}`; g.fillStyle = 'rgba(242,230,196,.6)';
  g.textAlign = 'left'; g.fillText('玩家', xName, y + 34);
  g.textAlign = 'right'; g.fillText(d.segLabel, xSeg, y + 34);
  g.fillText('总输赢', xTot, y + 34);
  y += TH;
  g.strokeStyle = 'rgba(214,183,106,.5)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(PAD, y); g.lineTo(W - PAD, y); g.stroke();

  const color = (v: number) => (v > 0 ? '#7ee6a4' : v < 0 ? '#ff9b7a' : 'rgba(242,230,196,.75)');
  d.rows.forEach((r, i) => {
    const top = y + i * ROW;
    if (i % 2 === 1) { g.fillStyle = 'rgba(255,255,255,.045)'; g.fillRect(PAD, top, W - PAD * 2, ROW); }
    const base = top + ROW / 2 + 12;
    g.textAlign = 'left'; g.fillStyle = '#f2e6c4'; g.font = `600 32px ${FONT}`;
    g.fillText(cut(g, r.name, xSeg - xName - 130), xName, base);
    g.textAlign = 'right';
    g.fillStyle = color(r.seg); g.font = `600 30px ${FONT}`; g.fillText(fmt(r.seg), xSeg, base);
    g.fillStyle = color(r.total); g.font = `800 38px ${FONT}`; g.fillText(fmt(r.total), xTot, base);
  });

  y += ROW * d.rows.length;
  g.strokeStyle = 'rgba(214,183,106,.35)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(PAD, y + 8); g.lineTo(W - PAD, y + 8); g.stroke();
  g.textAlign = 'center'; g.fillStyle = 'rgba(242,230,196,.45)'; g.font = `400 22px ${FONT}`;
  g.fillText(d.foot ?? '衡之娱 · 跑胡子', W / 2, y + 50);

  return cv.toDataURL('image/png');
}

/** 名字太长就截一截，末尾加省略号（按实际画出来的宽度量） */
function cut(g: CanvasRenderingContext2D, s: string, max: number) {
  if (g.measureText(s).width <= max) return s;
  let t = s;
  while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

/** 存到相册 / 下载。壳里给了 saveImage 就交给壳，否则走 <a download>；都不行就返回 false，让调用方提示长按保存 */
export function savePng(dataUrl: string, name: string): boolean {
  const nb = (window as any).NativeBridge;
  if (typeof nb?.saveImage === 'function') { try { nb.saveImage(dataUrl, name); return true; } catch { /* 继续走下面 */ } }
  try {
    const a = document.createElement('a');
    a.href = dataUrl; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    return true;
  } catch { return false; }
}

/** 复制到剪贴板（安卓 Chrome / 新一点的 WebView 支持；iOS Safari 多半不行） */
export async function copyPng(dataUrl: string): Promise<boolean> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const Item = (window as any).ClipboardItem;
    if (!Item || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new Item({ 'image/png': blob })]);
    return true;
  } catch { return false; }
}
