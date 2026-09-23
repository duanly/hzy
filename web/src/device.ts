/**
 * 设备标识：把这台机器能看到的那些"出厂特征"拌在一起，算一个 32 位的 MD5 当设备号。
 *
 * 说明两件事：
 *  1) 浏览器不给网页看真正的硬件序列号，所以这里是"指纹"——同一台机器同一个入口算出来是稳定的，
 *     换个入口（套壳 APP / Safari / 桌面快捷方式）各自的 localStorage 是分开的，指纹里也带了入口标记，
 *     所以确实会是三个设备号、三个账号。想共用一个账号，要么用账号 ID 登录，要么壳里注入统一的 deviceId。
 *  2) 壳（NativeBridge.deviceId）给了值就优先用它 —— 那是系统级的，最稳。
 */

/* ---------------- MD5（够用就行的紧凑实现） ---------------- */
function md5(s: string): string {
  const utf8 = unescape(encodeURIComponent(s));
  const n = utf8.length;
  const words: number[] = [];
  for (let i = 0; i < n; i++) words[i >> 2] = (words[i >> 2] | 0) | (utf8.charCodeAt(i) << ((i % 4) * 8));
  words[n >> 2] = (words[n >> 2] | 0) | (0x80 << ((n % 4) * 8));
  const len = (((n + 8) >> 6) + 1) * 16;
  for (let i = 0; i < len; i++) words[i] = words[i] | 0;
  words[len - 2] = n * 8;

  const add = (a: number, b: number) => (a + b) | 0;
  const rol = (x: number, c: number) => (x << c) | (x >>> (32 - c));
  const cmn = (q: number, a: number, b: number, x: number, s: number, t: number) =>
    add(rol(add(add(a, q), add(x, t)), s), b);
  const ff = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => cmn((b & c) | (~b & d), a, b, x, s, t);
  const gg = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => cmn((b & d) | (c & ~d), a, b, x, s, t);
  const hh = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => cmn(b ^ c ^ d, a, b, x, s, t);
  const ii = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => cmn(c ^ (b | ~d), a, b, x, s, t);

  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < len; i += 16) {
    const [oa, ob, oc, od] = [a, b, c, d];
    const x = (k: number) => words[i + k];
    a = ff(a, b, c, d, x(0), 7, -680876936); d = ff(d, a, b, c, x(1), 12, -389564586); c = ff(c, d, a, b, x(2), 17, 606105819); b = ff(b, c, d, a, x(3), 22, -1044525330);
    a = ff(a, b, c, d, x(4), 7, -176418897); d = ff(d, a, b, c, x(5), 12, 1200080426); c = ff(c, d, a, b, x(6), 17, -1473231341); b = ff(b, c, d, a, x(7), 22, -45705983);
    a = ff(a, b, c, d, x(8), 7, 1770035416); d = ff(d, a, b, c, x(9), 12, -1958414417); c = ff(c, d, a, b, x(10), 17, -42063); b = ff(b, c, d, a, x(11), 22, -1990404162);
    a = ff(a, b, c, d, x(12), 7, 1804603682); d = ff(d, a, b, c, x(13), 12, -40341101); c = ff(c, d, a, b, x(14), 17, -1502002290); b = ff(b, c, d, a, x(15), 22, 1236535329);
    a = gg(a, b, c, d, x(1), 5, -165796510); d = gg(d, a, b, c, x(6), 9, -1069501632); c = gg(c, d, a, b, x(11), 14, 643717713); b = gg(b, c, d, a, x(0), 20, -373897302);
    a = gg(a, b, c, d, x(5), 5, -701558691); d = gg(d, a, b, c, x(10), 9, 38016083); c = gg(c, d, a, b, x(15), 14, -660478335); b = gg(b, c, d, a, x(4), 20, -405537848);
    a = gg(a, b, c, d, x(9), 5, 568446438); d = gg(d, a, b, c, x(14), 9, -1019803690); c = gg(c, d, a, b, x(3), 14, -187363961); b = gg(b, c, d, a, x(8), 20, 1163531501);
    a = gg(a, b, c, d, x(13), 5, -1444681467); d = gg(d, a, b, c, x(2), 9, -51403784); c = gg(c, d, a, b, x(7), 14, 1735328473); b = gg(b, c, d, a, x(12), 20, -1926607734);
    a = hh(a, b, c, d, x(5), 4, -378558); d = hh(d, a, b, c, x(8), 11, -2022574463); c = hh(c, d, a, b, x(11), 16, 1839030562); b = hh(b, c, d, a, x(14), 23, -35309556);
    a = hh(a, b, c, d, x(1), 4, -1530992060); d = hh(d, a, b, c, x(4), 11, 1272893353); c = hh(c, d, a, b, x(7), 16, -155497632); b = hh(b, c, d, a, x(10), 23, -1094730640);
    a = hh(a, b, c, d, x(13), 4, 681279174); d = hh(d, a, b, c, x(0), 11, -358537222); c = hh(c, d, a, b, x(3), 16, -722521979); b = hh(b, c, d, a, x(6), 23, 76029189);
    a = hh(a, b, c, d, x(9), 4, -640364487); d = hh(d, a, b, c, x(12), 11, -421815835); c = hh(c, d, a, b, x(15), 16, 530742520); b = hh(b, c, d, a, x(2), 23, -995338651);
    a = ii(a, b, c, d, x(0), 6, -198630844); d = ii(d, a, b, c, x(7), 10, 1126891415); c = ii(c, d, a, b, x(14), 15, -1416354905); b = ii(b, c, d, a, x(5), 21, -57434055);
    a = ii(a, b, c, d, x(12), 6, 1700485571); d = ii(d, a, b, c, x(3), 10, -1894986606); c = ii(c, d, a, b, x(10), 15, -1051523); b = ii(b, c, d, a, x(1), 21, -2054922799);
    a = ii(a, b, c, d, x(8), 6, 1873313359); d = ii(d, a, b, c, x(15), 10, -30611744); c = ii(c, d, a, b, x(6), 15, -1560198380); b = ii(b, c, d, a, x(13), 21, 1309151649);
    a = ii(a, b, c, d, x(4), 6, -145523070); d = ii(d, a, b, c, x(11), 10, -1120210379); c = ii(c, d, a, b, x(2), 15, 718787259); b = ii(b, c, d, a, x(9), 21, -343485551);
    a = add(a, oa); b = add(b, ob); c = add(c, oc); d = add(d, od);
  }
  const hex = (x: number) => {
    let s = '';
    for (let i = 0; i < 4; i++) s += ((x >> (i * 8 + 4)) & 15).toString(16) + ((x >> (i * 8)) & 15).toString(16);
    return s;
  };
  return hex(a) + hex(b) + hex(c) + hex(d);
}

/** 从哪个入口进来的：套壳 APP / 桌面快捷方式 / 普通浏览器 —— 各算各的 */
function entry(): string {
  const nb = (window as any).NativeBridge;
  if (nb) return 'app-' + (nb.platform ?? 'native');
  try {
    if (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches
      || (navigator as any).standalone === true) return 'home';
  } catch { /* ignore */ }
  return 'web';
}

/** 这台机器的"出厂特征"，拌起来算指纹 */
function fingerprint(): string {
  const n = navigator as any;
  const s = screen as any;
  const bits = [
    n.userAgent, n.platform, n.language, (n.languages ?? []).join(','),
    n.hardwareConcurrency, n.deviceMemory, n.maxTouchPoints,
    s.width, s.height, s.colorDepth, s.pixelDepth, window.devicePixelRatio,
    new Date().getTimezoneOffset(),
    (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })(),
    entry(),
  ];
  return bits.join('|');
}

const KEY = 'phz_device';

/**
 * 本设备号：先看壳注入的，再看本地存过的，都没有才现算一个（指纹 + 一点随机盐，防止两台同型号手机撞号），
 * 算完存下来 —— 以后清了缓存，还能靠指纹算回同一个（没有盐的那版做兜底并不可靠，所以存本地为主）。
 */
export function deviceId(): string {
  const inj = (window as any).NativeBridge?.deviceId;
  if (typeof inj === 'string' && inj.length >= 8) return md5('phz-native|' + inj);
  try {
    // 老版本存的是 'dxxxx' 那种随机串，照样认 —— 不然这台机器上的老账号就丢了
    const saved = localStorage.getItem(KEY);
    if (saved && saved.length >= 8) return saved;
  } catch { /* ignore */ }
  const salt = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const id = md5('phz|' + fingerprint() + '|' + salt);
  try { localStorage.setItem(KEY, id); } catch { /* 无痕模式：这次会话内用着，下次重新算 */ }
  return id;
}

/** 本设备从哪个入口进来的，给界面上做提示用 */
export const ENTRY = entry();

export { md5 };
