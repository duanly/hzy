/**
 * 低端机降级（lite）
 *
 * 发烫的大头不是 JS，是**一直在跑的合成动画**：牌桌上随时有好几处"呼吸"的光晕，
 * 每一处都是一个独立的合成层，60 帧一秒地混合。新机器 GPU 富裕看不出来，
 * iPhone X（A11、2436×1125 的屏、dpr 3）就是实打实地一直在烧电。
 *
 * 判定：按屏幕的**逻辑尺寸**认机型。苹果这几代的点数是固定的，
 * 375×812 = iPhone X / XS / 11 Pro，414×896 = XR / 11 / XS Max，
 * 375×667 = 6～8，414×736 = 6～8 Plus —— 都是 2019 年以前的机器。
 * iPhone 12 起最窄也是 390×844，不会误伤。
 * 认不出来的（安卓、平板…）再用实测帧率兜一手。
 *
 * 想手动覆盖：localStorage.phz_lite = '1' 开、'0' 关、删掉 = 自动。
 */
const KEY = 'phz_lite';

/** 老 iPhone 的逻辑分辨率白名单（短边×长边） */
const OLD_SCREENS = ['375x812', '414x896', '375x667', '414x736', '320x568'];

function guessOld(): boolean {
  const w = Math.min(screen.width, screen.height), h = Math.max(screen.width, screen.height);
  /* 只认屏幕尺寸。**不能**看 hardwareConcurrency / deviceMemory：
     iPhone X 和 iPhone 15 都是 6 核，Safari 又不给 deviceMemory ——
     照那个判，新机器会跟着一起被降级。 */
  return OLD_SCREENS.includes(`${w}x${h}`);
}

function apply(on: boolean) {
  document.documentElement.classList.toggle('lite', on);
  (window as any).__PHZ_LITE__ = on;
}

/** 现在是不是省电模式 */
export function isLite(): boolean { return document.documentElement.classList.contains('lite'); }

/** 手动开关（null = 交回自动） */
export function setLite(v: boolean | null) {
  try { if (v === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* 无痕 */ }
  if (v !== null) apply(v);
}

/**
 * 量一段帧率：连着 rAF 采 90 帧（约 1.5 秒），取中位帧间隔。
 * 用中位数不用平均 —— 偶尔一帧卡 200ms（网络回包、解码）不该把整台机器判成慢。
 */
function measureFps(): Promise<number> {
  return new Promise(res => {
    const gaps: number[] = []; let last = performance.now(), n = 0;
    const step = (t: number) => {
      gaps.push(t - last); last = t;
      if (++n < 90) requestAnimationFrame(step);
      else { gaps.sort((a, b) => a - b); res(1000 / (gaps[gaps.length >> 1] || 16.7)); }
    };
    requestAnimationFrame(step);
  });
}

export function initPerf() {
  let saved: string | null = null;
  try { saved = localStorage.getItem(KEY); } catch { /* 无痕 */ }
  if (saved === '1' || saved === '0') { apply(saved === '1'); (window as any).__PHZ_LITE_WHY__ = '手动'; return; }

  if (guessOld()) { apply(true); (window as any).__PHZ_LITE_WHY__ = `屏${Math.min(screen.width,screen.height)}x${Math.max(screen.width,screen.height)}`; return; }

  // 认不出机型：跑起来之后量一段帧率，掉到 45 以下就降级（只量一次，不反复折腾画面）
  setTimeout(async () => {
    if (document.visibilityState !== 'visible') return;
    const fps = await measureFps();
    (window as any).__PHZ_FPS__ = Math.round(fps);
    if (fps < 45) { apply(true); (window as any).__PHZ_LITE_WHY__ = 'fps'; }
  }, 6000);
}
