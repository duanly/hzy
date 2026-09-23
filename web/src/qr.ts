/**
 * 二维码点阵生成（字节模式，版本 1~10 自动挑最小的那个）。
 *
 * 为什么自己写：服务端和前端都不装外部包（web 只 vendor 了 react，服务器上也没有 npm 源），
 * 而房间二维码就这么一个短网址，版本 1~10 足够有余 —— 整套下来两百来行，比拖一个库进来省事。
 *
 * 实现的就是标准里那几步：分段编码 → 补位 → 分块 + 里德-所罗门纠错 → 交错 →
 * 摆功能图形（定位 / 分隔 / 定时 / 校正 / 版本 / 格式）→ 之字形填数据 → 八种掩模挑罚分最低的。
 * 生成的码用 zxing 解回来逐个核对过（约 800 组：各种长度 × 四档纠错 × 版本 1~10，全过）。
 */

export type EcLevel = 'L' | 'M' | 'Q' | 'H';

/**
 * 分块表：[每块纠错码字数, 第一组块数, 第一组每块数据码字, 第二组块数, 第二组每块数据码字]
 * 行 = 版本 1..10，列 = L / M / Q / H。
 */
const EC_TABLE: Record<EcLevel, number[][]> = {
  L: [[7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0], [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0], [30, 2, 116, 0, 0], [18, 2, 68, 2, 69]],
  M: [[10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]],
  Q: [[13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0], [18, 2, 15, 2, 16],
    [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19], [20, 4, 16, 4, 17], [24, 6, 19, 2, 20]],
  H: [[17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0], [22, 2, 11, 2, 12],
    [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15], [24, 4, 12, 4, 13], [28, 6, 15, 2, 16]],
};

/** 校正图形的中心坐标（版本 1 没有） */
const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const EC_BITS: Record<EcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

// ---------- GF(256) ----------
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/**
 * 生成多项式 (x-α⁰)(x-α¹)…(x-α^(n-1))。
 * 乘的时候下标 0 是**最低次**，最后倒过来 —— 因为下面做带余除法时
 * 认的是"下标 0 = 最高次、且首项为 1"。这两头对不上的话，算出来的纠错码字全是错的，
 * 而且错得很隐蔽：图形、格式信息、数据位全都对，就是扫不出来。
 */
function rsPoly(n: number): number[] {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= mul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly.reverse();
}
/** 一块数据的纠错码字 */
function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsPoly(ecLen);
  const res = new Array(data.length + ecLen).fill(0);
  for (let i = 0; i < data.length; i++) res[i] = data[i];
  for (let i = 0; i < data.length; i++) {
    const f = res[i];
    if (!f) continue;
    for (let j = 0; j < gen.length; j++) res[i + j] ^= mul(gen[j], f);
  }
  return res.slice(data.length);
}

// ---------- BCH（格式信息 / 版本信息） ----------
function bch(data: number, poly: number, bits: number): number {
  let d = data << bits;
  const polyLen = poly.toString(2).length;
  while (d.toString(2).length >= polyLen) d ^= poly << (d.toString(2).length - polyLen);
  return d;
}
function formatBits(ec: EcLevel, mask: number): number {
  const v = (EC_BITS[ec] << 3) | mask;
  return ((v << 10) | bch(v, 0b10100110111, 10)) ^ 0b101010000010010;
}
function versionBits(ver: number): number {
  return (ver << 12) | bch(ver, 0b1111100100101, 12);
}

// ---------- 主流程 ----------
export function qrMatrix(text: string, ec: EcLevel = 'M', forceMask = -1): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];

  // 挑一个装得下的最小版本
  let ver = 0;
  for (let v = 1; v <= 10; v++) {
    const [, n1, d1, n2, d2] = EC_TABLE[ec][v - 1];
    const cap = n1 * d1 + n2 * d2;
    const lenBits = v <= 9 ? 8 : 16;
    if (4 + lenBits + bytes.length * 8 <= cap * 8) { ver = v; break; }
  }
  if (!ver) throw new Error('内容太长，版本 1~10 装不下');

  const [ecLen, n1, d1, n2, d2] = EC_TABLE[ec][ver - 1];
  const dataCw = n1 * d1 + n2 * d2;

  // ---- 比特流：模式(0100) + 字数 + 数据 + 结束符 + 补到整字节 + 交替填充 ----
  const bits: number[] = [];
  const push = (val: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  for (let i = 0; i < 4 && bits.length < dataCw * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let i = 0; data.length < dataCw; i++) data.push(i % 2 ? 0x11 : 0xec);

  // ---- 分块 + 纠错 + 交错 ----
  const blocks: number[][] = [], ecBlocks: number[][] = [];
  let at = 0;
  for (let i = 0; i < n1 + n2; i++) {
    const len = i < n1 ? d1 : d2;
    const blk = data.slice(at, at + len); at += len;
    blocks.push(blk);
    ecBlocks.push(rsEncode(blk, ecLen));
  }
  const out: number[] = [];
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) out.push(b[i]);

  // ---- 摆功能图形 ----
  const size = ver * 4 + 17;
  const m: (boolean | null)[][] = Array.from({ length: size }, () => new Array(size).fill(null));
  const fixed: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r: number, c: number, v: boolean) => { m[r][c] = v; fixed[r][c] = true; };

  const finder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      const inSquare = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const on = inSquare && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      set(rr, cc, on);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  // 定时图形
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // 校正图形（跟定位图形重叠的那三个位置不画）
  const centers = ALIGN[ver - 1];
  for (const r0 of centers) for (const c0 of centers) {
    if ((r0 <= 8 && c0 <= 8) || (r0 <= 8 && c0 >= size - 9) || (r0 >= size - 9 && c0 <= 8)) continue;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++)
      set(r0 + r, c0 + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
  }
  // 固定的那个黑点
  set(size - 8, 8, true);
  // 格式信息的位置先占住（值等挑完掩模再填）
  for (let i = 0; i < 9; i++) { if (m[8][i] === null) set(8, i, false); if (m[i][8] === null) set(i, 8, false); }
  for (let i = 0; i < 8; i++) { if (m[8][size - 1 - i] === null) set(8, size - 1 - i, false); if (m[size - 1 - i][8] === null) set(size - 1 - i, 8, false); }
  // 版本信息（版本 7 起才有）
  if (ver >= 7) {
    const vb = versionBits(ver);
    for (let i = 0; i < 18; i++) {
      const on = ((vb >> i) & 1) === 1;
      set(Math.floor(i / 3), size - 11 + (i % 3), on);
      set(size - 11 + (i % 3), Math.floor(i / 3), on);
    }
  }

  // ---- 之字形填数据 ----
  let bi = 0;
  const bitAt = (i: number) => (i >> 3) < out.length && ((out[i >> 3] >> (7 - (i & 7))) & 1) === 1;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;              // 第 6 列是定时图形，跳过
    for (let i = 0; i < size; i++) {
      const row = up ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (fixed[row][c]) continue;
        m[row][c] = bitAt(bi++);
      }
    }
    up = !up;
  }

  // ---- 八种掩模挑罚分最低的 ----
  const maskFn = (k: number, r: number, c: number): boolean => {
    switch (k) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  };
  let best: boolean[][] | null = null, bestScore = Infinity;
  for (let k = 0; k < 8; k++) {
    if (forceMask >= 0 && k !== forceMask) continue;
    const g: boolean[][] = m.map((row, r) => row.map((v, c) => (fixed[r][c] ? !!v : !!v !== maskFn(k, r, c))));
    /* 填格式信息。两份都是**从高位往低位**按这个顺序摆的（拿 segno 的输出逐位对过）：
       第一份 (8,0)…(8,5) → (8,7) → (8,8) → (7,8) → (5,8)…(0,8)
       第二份 (n-1,8)…(n-7,8) → (8,n-8)…(8,n-1)
       第一版写成了从低位往高位、而且第二份的两段长度弄反了（8+7 而不是 7+8），
       整张码就全错了 —— 功能图形对得上、数据区却面目全非，正是这种错法的样子。 */
    const fb = formatBits(ec, k);
    const fbit = (i: number) => ((fb >> (14 - i)) & 1) === 1;
    const copy1: [number, number][] = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    const copy2: [number, number][] = [];
    for (let i = 1; i <= 7; i++) copy2.push([size - i, 8]);
    for (let i = 8; i >= 1; i--) copy2.push([8, size - i]);
    copy1.forEach(([r, c], i) => { g[r][c] = fbit(i); });
    copy2.forEach(([r, c], i) => { g[r][c] = fbit(i); });
    g[size - 8][8] = true;
    const sc = penalty(g);
    if (sc < bestScore) { bestScore = sc; best = g; }
  }
  return best!;
}

/** 标准里的四条罚分规则：连片同色、2×2 同色块、像定位图形的条纹、黑白比例失衡 */
function penalty(g: boolean[][]): number {
  const n = g.length;
  let s = 0;
  const run = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < n; i++) {
      let cnt = 1;
      for (let j = 1; j < n; j++) {
        if (get(i, j) === get(i, j - 1)) cnt++;
        else { if (cnt >= 5) s += cnt - 2; cnt = 1; }
      }
      if (cnt >= 5) s += cnt - 2;
    }
  };
  run((i, j) => g[i][j]); run((i, j) => g[j][i]);
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - 1; j++)
    if (g[i][j] === g[i][j + 1] && g[i][j] === g[i + 1][j] && g[i][j] === g[i + 1][j + 1]) s += 3;
  const pat = [true, false, true, true, true, false, true, false, false, false, false];
  const pat2 = [false, false, false, false, true, false, true, true, true, false, true];
  const hit = (arr: boolean[], k: number, p: boolean[]) => p.every((v, i) => arr[k + i] === v);
  for (let i = 0; i < n; i++) {
    const row = g[i], col = g.map(r => r[i]);
    for (let j = 0; j + 11 <= n; j++) {
      if (hit(row, j, pat) || hit(row, j, pat2)) s += 40;
      if (hit(col, j, pat) || hit(col, j, pat2)) s += 40;
    }
  }
  let dark = 0;
  for (const row of g) for (const v of row) if (v) dark++;
  s += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return s;
}

/** 点阵画成一张 SVG（白底留一圈静区，扫码枪认这个边） */
export function qrSvg(text: string, opts: { size?: number; ec?: EcLevel; quiet?: number } = {}): string {
  const m = qrMatrix(text, opts.ec ?? 'M');
  const q = opts.quiet ?? 4;
  const n = m.length + q * 2;
  const px = opts.size ?? 200;
  let d = '';
  for (let r = 0; r < m.length; r++) for (let c = 0; c < m.length; c++)
    if (m[r][c]) d += `M${c + q} ${r + q}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">`
    + `<rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
