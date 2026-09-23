/**
 * 跑胡子（字牌）牌型定义
 * 80 张：大写 壹～拾、小写 一～十，各 4 张。
 * kind 编码：0..9 = 小写 一～十，10..19 = 大写 壹～拾
 */
export type Kind = number; // 0..19

export const SMALL_NAMES = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
export const BIG_NAMES = ['壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖', '拾'];

export const KIND_COUNT = 20;
export const DECK_SIZE = 80;

export function rankOf(k: Kind): number { return (k % 10) + 1; }        // 1..10
export function isBig(k: Kind): boolean { return k >= 10; }
export function kindOf(rank: number, big: boolean): Kind { return (big ? 10 : 0) + (rank - 1); }
export function sameRankOther(k: Kind): Kind { return isBig(k) ? k - 10 : k + 10; }
export function nameOf(k: Kind): string { return isBig(k) ? BIG_NAMES[k - 10] : SMALL_NAMES[k]; }
/** 红字：二七十 / 贰柒拾 */
export function isRed(k: Kind): boolean { const r = rankOf(k); return r === 2 || r === 7 || r === 10; }

export function fullDeck(): Kind[] {
  const d: Kind[] = [];
  for (let k = 0; k < KIND_COUNT; k++) for (let i = 0; i < 4; i++) d.push(k);
  return d;
}

/** 洗牌（可注入随机源便于测试） */
export function shuffle(cards: Kind[], rnd: () => number = Math.random): Kind[] {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 真人洗牌：把上一局收拢的牌切两半对插（riffle），每次落 1~3 张，最后再切一刀。
 * 跟 shuffle() 的均匀随机不一样 —— 上一局成组的牌会留下一点"残影"，
 * 坎、句子的分布跟真桌上接着洗的那副牌是一个味道。
 * times 越大越接近完全随机。默认 5 把：残影还留得住，但不会浓到"上一局的坎原封不动传下来"
 * —— 配合轮流发牌（见 Game.start），起手龙的概率就落回正常范围了。
 */
export function riffleShuffle(cards: Kind[], rnd: () => number = Math.random, times = 5): Kind[] {
  let a = cards.slice();
  if (a.length < 4) return a;
  for (let t = 0; t < times; t++) {
    // 切牌：中间上下浮动一成（真人切不了正中间）
    const mid = Math.max(1, Math.min(a.length - 1, Math.round(a.length / 2 + (rnd() - 0.5) * a.length * 0.2)));
    const L = a.slice(0, mid), R = a.slice(mid);
    const out: Kind[] = [];
    let i = 0, j = 0;
    while (i < L.length || j < R.length) {
      // 哪一堆先落：按两堆剩下的张数分（厚的那堆先落的多）
      const fromL = j >= R.length ? true : i >= L.length ? false : rnd() < (L.length - i) / (L.length - i + R.length - j);
      // 一次落 1~3 张 —— 这一笔就是"真人洗牌"和"完全随机"的分界：落得越多，原来的顺序留得越多
      const n = 1 + Math.floor(rnd() * 3);
      if (fromL) for (let k = 0; k < n && i < L.length; k++) out.push(L[i++]);
      else for (let k = 0; k < n && j < R.length; k++) out.push(R[j++]);
    }
    a = out;
  }
  const cut = Math.floor(rnd() * a.length);
  return [...a.slice(cut), ...a.slice(0, cut)];
}

export type Counts = number[]; // length 20

export function toCounts(cards: Kind[]): Counts {
  const c = new Array(KIND_COUNT).fill(0);
  for (const k of cards) c[k]++;
  return c;
}

export function fromCounts(c: Counts): Kind[] {
  const out: Kind[] = [];
  for (let k = 0; k < KIND_COUNT; k++) for (let i = 0; i < c[k]; i++) out.push(k);
  return out;
}

export function sortKinds(cards: Kind[]): Kind[] {
  return cards.slice().sort((a, b) => rankOf(a) - rankOf(b) || a - b);
}
