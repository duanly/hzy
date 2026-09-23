/**
 * 牌面字体：挑的都是手机 / 电脑上**本来就有**的书法字体 ——
 * 行楷（王羲之那一路的行书味）、魏碑（柳公权、欧阳询那种碑刻骨力）、楷、隶、宋、圆、手写。
 *
 * 每一款给一串候选（苹果的、微软的、安卓的都排进去），开机时**实测这台机器到底有没有**，
 * 没有的就不往选单里放 —— 免得点了半天"看着都一样"（其实是全都回落到同一个默认字体了）。
 */
import { GLYPHS_READY } from './glyphs.ts';

export type CardFont = string;

export interface FontOption {
  id: string;
  name: string;      // 选单里显示的全名
  short: string;     // 按钮上那一个字
  stack: string;     // CSS font-family
  probe: string;     // 用来探测"这台机器有没有装"的那个字体名（第一候选）
  wide?: number;     // 横向微调（有的字体偏窄，撑一点才饱满）
  weight?: number;   // 字重：书法体压太粗会被系统合成 / 回落，给 500~700 就够
}

/** 备选清单：从最想要的排到最保底的 */
export const FONT_LIST: FontOption[] = [
  /* 「雁字体」：照实物截图一个个描出来的矢量字（web/src/glyphs.ts）—— 名字取自衡阳的雁。
     它不是系统字体 —— 牌面那两个字直接画成 SVG，别的地方还是用后面这串保底字体。
     二十个字没描齐之前不进选单（fontOptions 里过滤掉）。 */
  { id: 'shot', name: '雁字体（照实物描的）', short: '雁', probe: '', wide: 1, weight: 700,
    stack: '"STKaiti", "KaiTi", "Noto Serif SC", serif' },
  /* 每一款都把 **PostScript 名** 排在前头（iOS 的 WebView 常常只认这个），后面再跟显示名兜底。
     同一款字体的不同字重（细 / 粗）分开列 —— 反正是弹出来的单子，多摆几款不占地方。
     weight：书法体多半只有一两个字重，硬压 900 系统会合成粗体甚至回落到黑体，所以各给各的。 */
  { id: 'sys', name: '系统', short: '系', probe: '', wide: 1.05, weight: 900,
    stack: '"Baoli SC", "STLiti", "LiSu", "STKaiti", "KaiTi", "Noto Serif SC", "Songti SC", serif' },

  // —— 楷 ——
  { id: 'kai', name: '华文楷体', short: '楷', probe: 'Kaiti SC', wide: 1.02, weight: 600,
    stack: '"STKaiti", "KaitiSC-Regular", "Kaiti SC", "华文楷体", "KaiTi", "楷体", serif' },
  { id: 'kai-b', name: '华文楷体 · 粗', short: '楷', probe: 'Kaiti SC', wide: 1.02, weight: 800,
    stack: '"STKaitiSC-Bold", "KaitiSC-Bold", "Kaiti SC", "STKaiti", "华文楷体", serif' },

  // —— 行书 / 手写 ——
  { id: 'xing', name: '行楷 · 细', short: '行', probe: 'Xingkai SC', wide: 1.02, weight: 500,
    stack: '"XingkaiSC-Light", "Xingkai SC", "STXingkai", "华文行楷", cursive' },
  { id: 'xing-b', name: '行楷 · 粗', short: '行', probe: 'Xingkai SC', wide: 1.02, weight: 700,
    stack: '"XingkaiSC-Bold", "Xingkai SC", "STXingkai", "华文行楷", cursive' },
  { id: 'pen3', name: '翩翩 · 细', short: '翩', probe: 'HanziPen SC', wide: 1, weight: 400,
    stack: '"HanziPenSC-W3", "HanziPen SC", "翩翩体-简", cursive' },
  { id: 'pen5', name: '翩翩 · 粗', short: '翩', probe: 'HanziPen SC', wide: 1, weight: 600,
    stack: '"HanziPenSC-W5", "HanziPen SC", "翩翩体-简", cursive' },
  { id: 'han5', name: '手札体 · 细', short: '札', probe: 'Hannotate SC', wide: 1, weight: 500,
    stack: '"HannotateSC-W5", "Hannotate SC", "手札体-简", cursive' },
  { id: 'han7', name: '手札体 · 粗', short: '札', probe: 'Hannotate SC', wide: 1, weight: 700,
    stack: '"HannotateSC-W7", "Hannotate SC", "手札体-简", cursive' },

  // —— 碑 / 隶 ——
  { id: 'wei', name: '魏碑', short: '碑', probe: 'Weibei SC', wide: 1.04, weight: 600,
    stack: '"WeibeiSC-Bold", "Weibei SC", "Weibei TC", "STXinwei", "华文新魏", serif' },
  { id: 'baoli', name: '报隶', short: '隶', probe: 'Baoli SC', wide: 1.05, weight: 600,
    stack: '"BaoliSC-Regular", "Baoli SC", "STLiti", "华文隶书", "LiSu", serif' },
  { id: 'libian', name: '隶变', short: '隶', probe: 'Libian SC', wide: 1.05, weight: 600,
    stack: '"LibianSC-Regular", "Libian SC", "STLiti", "华文隶书", serif' },

  // —— 宋 / 黑 / 圆 ——
  { id: 'song', name: '宋体', short: '宋', probe: 'Songti SC', wide: 1.08, weight: 700,
    stack: '"STSong", "SongtiSC-Regular", "Songti SC", "宋体", "SimSun", "Noto Serif SC", serif' },
  { id: 'song-b', name: '宋体 · 黑', short: '宋', probe: 'Songti SC', wide: 1.08, weight: 900,
    stack: '"STSongti-SC-Black", "STSongti-SC-Bold", "Songti SC", "STSong", serif' },
  { id: 'yuan', name: '圆体', short: '圆', probe: 'Yuanti SC', wide: 1, weight: 600,
    stack: '"YuantiSC-Regular", "Yuanti SC", "STYuanti", "圆体-简", sans-serif' },
  { id: 'yuan-b', name: '圆体 · 粗', short: '圆', probe: 'Yuanti SC', wide: 1, weight: 800,
    stack: '"STYuanti-SC-Bold", "YuantiSC-Bold", "Yuanti SC", "STYuanti", sans-serif' },
  { id: 'wawa', name: '娃娃体', short: '娃', probe: 'Wawati SC', wide: 1, weight: 500,
    stack: '"WawatiSC-Regular", "Wawati SC", "娃娃体-简", cursive' },
  { id: 'yuppy', name: '雅痞', short: '雅', probe: 'Yuppy SC', wide: 1, weight: 600,
    stack: '"YuppySC-Regular", "Yuppy SC", "雅痞-简", sans-serif' },
  { id: 'lanting', name: '兰亭黑', short: '兰', probe: 'Lantinghei SC', wide: 1.02, weight: 700,
    stack: '"FZLTHJW--GB1-0", "Lantinghei SC", "兰亭黑-简", "PingFang SC", sans-serif' },
  { id: 'ping', name: '苹方（黑体）', short: '黑', probe: 'PingFang SC', wide: 1.04, weight: 700,
    stack: '"PingFangSC-Semibold", "PingFang SC", "Heiti SC", "Hiragino Sans GB", sans-serif' },
];

/** 保底：万一一款都判不出来，至少还有"系统"那一款 */
const FALLBACK: FontOption = FONT_LIST[0];

/**
 * 这台机器上真的装了这个字体吗？
 * **不能量宽度** —— 中文字都是全角等宽，换不换字体宽度都一样，量了也白量
 * （之前"四款看着都一样、后来只剩系统默认"就是栽在这儿）。
 * 改成：把同一个字分别用"候选字体"和"通用字体"画到画布上，**比像素**；画出来不一样才算装了。
 */
function inkHash(font: string, ch: string): string {
  const cv = document.createElement('canvas');
  cv.width = 48; cv.height = 48;
  const c = cv.getContext('2d', { willReadFrequently: true } as any);
  if (!c) return '';
  c.fillStyle = '#fff'; c.fillRect(0, 0, 48, 48);
  c.fillStyle = '#000'; c.textBaseline = 'alphabetic';
  c.font = `40px ${font}`;
  c.fillText(ch, 4, 42);
  const d = c.getImageData(0, 0, 48, 48).data;
  let h = '';
  for (let y = 0; y < 48; y += 3) {
    let row = 0;
    for (let x = 0; x < 48; x += 3) row = (row * 2 + (d[(y * 48 + x) * 4] < 128 ? 1 : 0)) >>> 0;
    h += row.toString(36) + '.';
  }
  return h;
}

function hasFont(family: string): boolean {
  if (!family) return true;
  try {
    for (const ch of ['壹', '柒']) {
      const base = ['sans-serif', 'serif'].map(b => inkHash(b, ch));
      const mine = inkHash(`"${family}", sans-serif`, ch);
      if (!mine) return true;                       // 画不出来就别拦着
      if (base.every(b => b !== mine)) return true; // 跟通用字体画得不一样 → 这款真的在
    }
    return false;
  } catch { return true; }
}

let cache: FontOption[] | null = null;
/** 选单里列哪些：**全都列**。真机上探测不一定准（有的字体在画布里取不到），
 *  与其自作聪明把人家有的字体藏起来，不如都摆出来、让玩家照着样子挑。 */
export function fontOptions(): FontOption[] {
  if (!cache) cache = FONT_LIST.filter(f => f.id !== 'shot' || GLYPHS_READY);
  return cache;
}

/* 用过的字体记在本地：**挑过的排在最前面**，下次点开单子一眼就看见，不用从头翻。
   现在这款永远在第一个，后面按"最近用过"的先后排，剩下的保持原来的次序。 */
const RECENT_KEY = 'phz_fontrecent';
function recent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]; } catch { return []; }
}
function pushRecent(id: string) {
  try {
    const r = [id, ...recent().filter(x => x !== id)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(r));
  } catch { /* 无痕模式：这次用着就行 */ }
}
/** 选单里的排法：当前这款 → 最近用过的 → 其余按原顺序 */
export function fontOptionsSorted(): FontOption[] {
  const list = fontOptions();
  const order = [cur.id, ...recent()];
  const rank = (f: FontOption) => { const i = order.indexOf(f.id); return i < 0 ? order.length : i; };
  return list.map((f, i) => [f, i] as const)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .map(x => x[0]);
}
/** 这款是不是"用过的"（选单里给它标一下，跟没碰过的分开） */
export const usedFont = (id: string) => recent().includes(id);
/** 现在用的是不是那套"描出来的"矢量字（牌面要画 SVG，不走字体） */
export const glyphFontOn = () => cur.id === 'shot' && GLYPHS_READY;
/** 这台机器大概有没有这款（只用来在选单里标一句灰字提示，不拿来过滤） */
export function maybeMissing(f: FontOption): boolean {
  try { return !!f.probe && !hasFont(f.probe); } catch { return false; }
}

function pick(id: string | null): FontOption {
  const list = fontOptions();
  return list.find(f => f.id === id) ?? list[0];
}

/** 整个界面（标题、按钮、昵称…）要不要也跟着用这一款 */
let uiToo = (() => { try { return localStorage.getItem('phz_uifont') === '1'; } catch { return false; } })();
export const uiFontOn = () => uiToo;
export function setUiFont(v: boolean) {
  uiToo = v;
  try { localStorage.setItem('phz_uifont', v ? '1' : '0'); } catch { /* ignore */ }
  apply();
}
/** 界面文字的保底字体（关掉"整个界面"时就用它） */
const UI_BASE = '-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

let cur: FontOption = (() => {
  let saved: string | null = null;
  try { saved = localStorage.getItem('phz_cardfont'); } catch { /* ignore */ }
  return pick(saved);
})();

export const cardFont = () => cur;

export function setCardFontNow(id: string) {
  cur = pick(id);
  try { localStorage.setItem('phz_cardfont', cur.id); } catch { /* ignore */ }
  pushRecent(cur.id);
  apply();
}
/** 把当前这款写到 <html> 上，牌面、下地牌、回放里的牌一起变 */
function apply() {
  try {
    const r = document.documentElement;
    r.style.setProperty('--card-font', cur.stack);
    r.style.setProperty('--card-wide', String(cur.wide ?? 1.04));
    r.style.setProperty('--card-weight', String(cur.weight ?? 900));
    /* 整个界面也跟着换：书法体后面照旧挂一串保底（缺字、标点、数字还得靠它们），
       顺手把界面字重压回正常，不然书法体糊成一团。 */
    r.style.setProperty('--ui-font', uiToo ? `${cur.stack}, ${UI_BASE}` : UI_BASE);
    r.classList.toggle('ui-font-on', uiToo);
    /* 光靠 body 上那个变量不够保险：有些元素（按钮、输入框、以及自带 font-family 的块）
       不一定继承得到。这里再补一张样式表，把界面字体**直接写死**到这些选择器上。 */
    let tag = document.getElementById('phz-ui-font') as HTMLStyleElement | null;
    if (!tag) { tag = document.createElement('style'); tag.id = 'phz-ui-font'; document.head.appendChild(tag); }
    /* 一个个数选择器总有漏网的（自带 font-family 的块、更高优先级的规则、
       甚至某些控件根本不继承）。开着"整个界面"的时候干脆一刀切：全都改，
       再把几个必须保留系统字体的地方单独挑回来。 */
    const UI = `${cur.stack}, ${UI_BASE}`;
    tag.textContent = uiToo
      ? `html.ui-font-on * { font-family: ${UI} !important; }
         /* 字体单子里的样张：各写各的那一款（行内变量给的），不能被一刀切盖掉 */
         html.ui-font-on .font-sample { font-family: var(--sample-font, ${UI}) !important; }
         /* 单子里的字体名、以及飘出来的提示条：小字用书法体看不清，留系统字体 */
         html.ui-font-on .font-name, html.ui-font-on .font-name i,
         html.ui-font-on .toast { font-family: ${UI_BASE} !important; }`
      : '';
    r.setAttribute('data-cardfont', cur.id);
    /* 有的 WebKit 改了 CSS 变量之后不重新算继承下来的 font-family，
       这里强制走一次重排（代价就是一帧），保证换完立刻看得见。 */
    const b = document.body;
    if (b) { b.style.visibility = 'hidden'; void b.offsetHeight; b.style.visibility = ''; }
  } catch { /* ignore */ }
}
try { apply(); } catch { /* ignore */ }

/** 下一款（选单里轮着来） */
export function nextFont(): FontOption {
  const list = fontOptions();
  const i = list.findIndex(f => f.id === cur.id);
  return list[(i + 1) % list.length];
}
