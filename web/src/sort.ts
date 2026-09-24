/** 自动理牌：把手牌按“成句 → 搭子 → 散牌”分组排列 */
import { partition, sortKinds, rankOf, isBig, chiXi, kanXi, type Kind } from '../../packages/engine/src/index.ts';

export interface HandGroup { cards: Kind[]; kind: 'group' | 'pair' | 'single'; xi: number }

/**
 * 一组牌的摆放顺序（数组末尾＝扇形最下面，也就是靠自己那一头）：
 * - 两张 / 成句：大字在下、小字在上；同为大写或同为小写时数大的在下（大拾在下、大壹在上）。
 *   kind 编码本身就是「小一…小十、大壹…大拾」，所以直接按 kind 升序即可。
 * - 三张里是一对带一张散牌：那一对放在下面，散牌放上面（对子内部仍按上面的规则）。
 */
/** 一列里的先后：小字在上、大字在下；同为大写或同为小写时数小的在上、数大的在下。
 *  kind 编码正好是「小一…小十、大壹…大拾」，所以直接按编码升序。 */
export function sortCol(cards: Kind[]): Kind[] { return cards.slice().sort((a, b) => a - b); }

/** 两张牌有多"搭"：同字 3，大小夹 / 连牌 / 一二三 / 二七十 2，毫无关系 0 */
export function link(a: Kind, b: Kind): number {
  if (a === b) return 3;                                          // 同一个字
  if (rankOf(a) === rankOf(b)) return 2;                          // 大小夹
  if (isBig(a) === isBig(b) && Math.abs(rankOf(a) - rankOf(b)) === 1) return 2;  // 连牌
  const set = [rankOf(a), rankOf(b)];
  if (isBig(a) === isBig(b) && ([[1, 2], [2, 3], [1, 3], [2, 7], [7, 10], [2, 10]] as number[][])
    .some(p => p[0] === Math.min(...set) && p[1] === Math.max(...set))) return 2;  // 一二三 / 二七十
  return 0;
}

/** 两组牌有多"搭"：取组间最搭的一对 */
export function affinity(ga: Kind[], gb: Kind[]): number {
  let best = 0;
  for (const a of ga) for (const b of gb) best = Math.max(best, link(a, b));
  return best;
}

export function orderCol(cards: Kind[]): Kind[] {
  if (cards.length < 3) return sortCol(cards);
  /* 同一组里，**距离最近的那两张摆下面**（靠自己那一头，看得最清），剩下的摆上面。
     以前是按 link 挑"最搭的一对"，link 只有 0/2/3 三档，二三 和 二八 一样粗；
     距离是连续的，二三（差 1）明显比 二八（差 6）该待在一起。 */
  let bi = 0, bj = 1, best = Infinity;
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const v = dist(cards[i], cards[j]);
    if (v < best) { best = v; bi = i; bj = j; }
  }
  const rest = cards.filter((_, i) => i !== bi && i !== bj);
  return [...sortCol(rest), ...sortCol([cards[bi], cards[bj]])];
}

/** 三张是不是一句？是的话给多少息，不成返回 -1 */
export function sentXi(c: Kind[]): number {
  if (c.length !== 3) return -1;
  if (c[0] === c[1] && c[1] === c[2]) return kanXi(c[0]);   // 坎
  return chiXi(c[0], c[1], c[2]);
}

/**
 * 一组搭子值多少：把二十种字挨个试一遍，看进哪一张能凑成句 —— 能进的字越多、成的句息越高就越值钱。
 * 例：二三七 能进 一 / 四 / 十（一二三、二三四、二七十），比 二三八 值钱得多。
 */
export function drawValue(cards: Kind[]): number {
  if (cards.length >= 3) {
    const x = sentXi(cards);
    if (x >= 0) return 10000 + x * 10;        // 已经成句：别再拆
  }
  let score = 0;
  for (let k = 0; k < 20; k++) {
    const all = [...cards, k as Kind];
    const last = all.length - 1;
    let best = -1;
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) for (let m = j + 1; m < all.length; m++) {
      if (i !== last && j !== last && m !== last) continue;   // 必须用上进的那一张
      const x = sentXi([all[i], all[j], all[m]]);
      if (x > best) best = x;
    }
    if (best >= 0) score += 4 + best;          // 能进就加分，息高的更值钱
  }
  return score;
}

/** 一个字"值不值钱"：它能凑出多少有息的句（二、七、十、一、三 这些比四五六值钱）。
 *  只有二十个字，开机算一次存着 —— 理牌要在手机上跑，别每次都重算。 */
const KIND_XI: number[] = (() => {
  const out: number[] = [];
  for (let k = 0; k < 20; k++) {
    let sum = 0;
    for (let a = 0; a < 20; a++) for (let b = a; b < 20; b++) {
      const x = sentXi(sortCol([k as Kind, a as Kind, b as Kind]));
      if (x > 0) sum += x;
    }
    out.push(sum);
  }
  return out;
})();
export const kindXi = (k: Kind) => KIND_XI[k] ?? 0;

/** 这几张牌"能进哪些字"：进了它就能凑成一句的那些字（按牌面缓存，理牌要跑很多遍） */
const ENTRY_CACHE = new Map<string, Set<number>>();
export function entrySet(cards: Kind[]): Set<number> {
  const key = sortCol(cards).join(',');
  const hit = ENTRY_CACHE.get(key);
  if (hit) return hit;
  const out = new Set<number>();
  for (let k = 0; k < 20; k++) {
    const all = [...cards, k as Kind];
    const last = all.length - 1;
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) for (let m = j + 1; m < all.length; m++) {
      if (i !== last && j !== last && m !== last) continue;
      if (sentXi([all[i], all[j], all[m]]) >= 0) { out.add(k); i = j = m = all.length; }
    }
  }
  if (ENTRY_CACHE.size > 4000) ENTRY_CACHE.clear();
  ENTRY_CACHE.set(key, out);
  return out;
}


/* ── 两张牌之间的「距离」 ───────────────────────────────────────────
   这是理牌的尺子：距离越小，两张牌越该待在一起。
     - 一对（同一个字）           → 0
     - 大小字（如 十 / 拾）        → 1
     - 二七十 / 贰柒拾 这类成句搭档 → 1（成了句的组合，不按数值差算）
     - 同为大字或同为小字          → 两个数之差
     - 一大一小、又不是同一个数     → 10（基本各走各的）
   一整组牌的距离：成了句就是 0；没成句的按"把三张牌串起来最省的那两条边"算
   （三个点的最小生成树 = 两条最短的边之和）—— 既是"最近的算"，也正好是三者之和。 */
const SENT_PAIRS: number[][] = [[2, 7], [7, 10], [2, 10]];   // 二七十：内部两两都算贴着
export function dist(a: Kind, b: Kind): number {
  if (a === b) return 0;
  const ra = rankOf(a), rb = rankOf(b);
  if (ra === rb) return 1;                                   // 大小夹：十 / 拾
  if (isBig(a) === isBig(b)) {
    const lo = Math.min(ra, rb), hi = Math.max(ra, rb);
    if (SENT_PAIRS.some(p => p[0] === lo && p[1] === hi)) return 1;
    return hi - lo;
  }
  return 10;
}
export function groupDist(cards: Kind[]): number {
  if (cards.length >= 3 && sentXi(sortCol(cards)) >= 0) return 0;   // 成句：整组距离 0，只有这一种情况是 0
  if (cards.length < 2) return 10;
  const es: number[] = [];
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) es.push(dist(cards[i], cards[j]));
  es.sort((x, y) => x - y);
  const mst = es.slice(0, cards.length - 1).reduce((a, b) => a + b, 0);   // 最小生成树：n 个点 n-1 条边
  /* 没成句的至少算 1 —— 不然一对（两张同字，字距 0）会跟"已经成了的一句"一样是 0，
     可它明明还差一张才算数。字与字之间的距离照旧是 0，只有**整组**这一档要加这个底。 */
  return Math.max(1, mst);
}
/** 这一组离"凑成一句"还差几张 —— 越小越笼牌（离胡越近） */
export function needCount(cards: Kind[]): number {
  if (cards.length >= 3) return sentXi(sortCol(cards)) >= 0 ? 0 : 1;
  if (cards.length === 2) return entrySet(cards).size > 0 ? 1 : 2;
  return 2;
}


/* ── 手牌从左到右的先后 ────────────────────────────────────────────
   左边放"最定型、最不用再动"的，右边放"还要挑还要打"的，眼睛从左扫到右就是
   "已经成了 → 快成了 → 还散着"。具体次序（数越小越靠左）：
     0 四张一组（龙）
     1 坎（三张同字）
     2 成句且有息的 —— 息越高越靠左（壹贰叁、贰柒拾、一二三、二七十 这些都在这一档）
     3 成句但零息的（也就是整组距离为 0 的那些）
     4 三张但没成句
     5 对子
     6 两张、还能吃进（进一张就成句）
     7 剩下的：两张不搭边的、单张
     8 四张凑一列的零碎（不是龙）——摆到最右边去
   同一档里再按"息高的在前、距离近的在前"排。 */
export function groupRank(cards: Kind[]): number {
  const n = cards.length;
  /* 四张一组：**只有龙（四张同字）才排最左**。
     以前这儿是"四张就给 0"，可四张一列还有另一个来路 —— mergeOne 最后那条兜底
     （没地方放了，把闲牌摞到最近的一组上面）。那种四张是**一堆凑不成句的零碎**，
     却拿着 0 号排头，于是就出现了"最左边一组根本不成句"。它该待在最右边。 */
  if (n >= 4) return new Set(cards).size === 1 ? 0 : 8;
  if (n === 3 && new Set(cards).size === 1) return 1;
  if (n === 3) {
    const x = sentXi(sortCol(cards));
    if (x > 0) return 2;
    if (x === 0) return 3;
    return 4;
  }
  if (n === 2) {
    if (cards[0] === cards[1]) return 5;
    return entrySet(cards).size > 0 ? 6 : 7;
  }
  return 7;
}
/** 按上面那套次序把牌组排好（只换组与组的先后，组里的牌一张不动） */
export function orderGroups<T extends { cards: Kind[] }>(gs: T[]): T[] {
  return gs.map((g, i) => [g, i] as const)
    .sort((a, b) => {
      const ra = groupRank(a[0].cards), rb = groupRank(b[0].cards);
      if (ra !== rb) return ra - rb;
      const xa = Math.max(0, sentXi(sortCol(a[0].cards))), xb = Math.max(0, sentXi(sortCol(b[0].cards)));
      if (xa !== xb) return xb - xa;                       // 息高的靠左
      const da = groupDist(a[0].cards), db = groupDist(b[0].cards);
      if (da !== db) return da - db;                       // 距离近的靠左
      return a[1] - b[1];                                  // 其余保持原先后，别无谓地抖动
    })
    .map(x => x[0]);
}
/** 同上，直接排一手"列"（每列就是一组牌） */
export function orderCols(cols: Kind[][]): Kind[][] {
  return orderGroups(cols.map(c => ({ cards: c }))).map(g => g.cards);
}

/** 一列里的先后：大小同字（大夹小）把"一样的两张"放下面、单的那张放上面，方便手动调 */
export function orderSent(c: Kind[]): Kind[] {
  if (c.length !== 3) return orderCol(c);
  if (c[0] === c[1] && c[1] === c[2]) return c.slice();
  const cnt = new Map<Kind, number>();
  for (const k of c) cnt.set(k, (cnt.get(k) ?? 0) + 1);
  const dup = [...cnt].find(([, n]) => n === 2);
  if (dup) {
    const odd = c.find(k => k !== dup[0])!;
    return [odd, dup[0], dup[0]];              // 单的在上，一对在下
  }
  return sortCol(c);                           // 一二三 / 二七十 / 连牌：小字在上、大字在下
}

/** 理牌的上限：最多 8 组（屏幕放得下这么宽），一组最多 4 张。
 *  自动理牌自己只摆到 3 张，第 4 张只在"压不到 8 组 / 不能留单张"时才用。 */
/* 屏幕按 7 组排的（手牌最宽就这么宽），所以理牌也只摆 7 组。
   四张一组**只留给龙**（四张同字）—— 别的牌四张挤一列谁也认不出是什么，
   摆不下就该拆开摞到别的组上面去。 */
export const MAX_GROUPS = 7;
export const MAX_IN_GROUP = 4;
/** 这一组能不能是四张：只有四张同字（龙）才行 */
export const canBeFour = (c: Kind[]) => c.length <= 3 || new Set(c).size === 1;
const AUTO_IN_GROUP = 3;

/** drawValue 挺贵的（20 个字 × 组合），理牌一轮要算上千次，按牌面存一下 */
const DV_CACHE = new Map<string, number>();
function dv(cards: Kind[]): number {
  const key = sortCol(cards).join(',');
  const hit = DV_CACHE.get(key);
  if (hit !== undefined) return hit;
  const v = drawValue(cards);
  if (DV_CACHE.size > 6000) DV_CACHE.clear();
  DV_CACHE.set(key, v);
  return v;
}

/** 各玩法的开胡门槛：耒阳提龙 10 胡、衡阳红黑 10 胡、六胡抢 6 胡。
    理牌时这是**必要条件** —— 胡息不够，理得再笼也胡不了。 */
export function minXiOf(variant: string): number { return variant === 'hy_liuhu' ? 6 : 10; }

export interface SortOpts {
  /** 耒阳玩法：要考虑"这手牌大概率是奔着无胡去的" */
  leiyang?: boolean;
  /** 我已经下过地了（吃 / 碰 / 偎 / 提 / 跑）：那就不是无胡了 */
  hasMeld?: boolean;
  /** 开胡门槛（见 minXiOf）：还没够的时候，理牌先往"能凑出息"的方向走 */
  minXi?: number;
  /** 已经下地的那些组贡献的息 —— 门槛算的是整手牌，不能只看手里这几张 */
  meldXi?: number;
}

/** 这手牌像不像"奔着无胡去的"：耒阳、没下地、没有坎、现在一点息都凑不出来、有息的字也没几张 */
function looksNoXi(rest: Kind[], hasKan: boolean, opts: SortOpts): boolean {
  if (!opts.leiyang || opts.hasMeld || hasKan) return false;
  if (rest.filter(k => kindXi(k) > 0).length > 4) return false;   // 手里有息的字还不少：奔着有息胡去
  const p = partition(rest, true);
  return p.groups.every(g => g.xi === 0);
}

/** 一堆牌里有没有成对的（无胡不许留对子） */
const hasPair = (c: Kind[]) => new Set(c).size < c.length;

/**
 * 自动理牌。规矩：
 *  1. **坎不拆**（硬规矩）：手里三张同字整组摆最左边；四张同字也整组摆着（拆开必然剩单张）。
 *  2. 成句的排在坎后面，息高的靠前 —— 离胡最近的先码好。
 *  3. 剩下的按"进张最值钱"凑堆（见 drawValue）：能进的字越多、成的句息越高越靠前。
 *  4. **不留单张**：凑不成 3 张就摆 2 张；真剩一张就并到最搭的那一组里。
 *  5. 自动理牌一组最多 3 张；压不到 8 组的时候才允许并成 4 张。
 *  6. 耒阳：看着像奔无胡去的（没下地、没坎、一点息凑不出来），就按无胡的路子理 ——
 *     优先零息的顺子，别留对子。
 */
export function autoSort(hand: Kind[], opts: SortOpts = {}): HandGroup[] {
  if (!hand.length) return [];
  const rest = hand.slice();
  const groups: HandGroup[] = [];
  // 1) 坎：牌码从大到小（大拾 → 小一）。四张同字整组摆，拆开反而要剩一张单的
  const kans: { k: Kind; n: number }[] = [];
  for (const k of [...new Set(hand)]) {
    const n = hand.filter(x => x === k).length;
    if (n >= 3) { kans.push({ k, n: Math.min(n, MAX_IN_GROUP) }); for (let i = 0; i < n; i++) rest.splice(rest.indexOf(k), 1); }
  }
  kans.sort((a, b) => b.k - a.k);
  for (const { k, n } of kans) groups.push({ cards: new Array(n).fill(k), kind: 'group', xi: kanXi(k) });

  const noXi = looksNoXi(rest, kans.length > 0, opts);

  // 2) 成句的：息从高到低（无胡路子上零息的顺子照样是"成句"，一样先码好）
  const r = partition(rest, true);
  for (const g of r.groups.slice().sort((a, b) => b.xi - a.xi)) groups.push({ cards: orderSent(sortKinds(g.cards)), kind: 'group', xi: g.xi });

  // 3) 剩下的零碎：每次挑最值钱的一堆，3 张为主；张数除不尽就摆一堆 2 张，绝不剩单张
  let left = [...r.pairs.flat(), ...r.singles];
  const breakPenalty = (pick: Kind[], pool: Kind[]) => {
    if (sentXi(sortKinds(pick)) >= 0) return 0;          // 凑成一句：值得拆
    let n = 0;
    for (const k of new Set(pick)) {
      const inPool = pool.filter(x => x === k).length;
      const inPick = pick.filter(x => x === k).length;
      if (inPool >= 2 && inPick === 1) n++;              // 池子里是一对，却只抽走一张 = 拆了
    }
    return n * 400;
  };
  /* 开胡门槛：胡息不够，理成花也白搭 —— 所以只要还没够，就给"能凑出息"的摆法加权；
     一旦够了就不再管它，免得为了多几息把笼牌的路走窄。
     一堆牌能出多少息：已经成句的就是它的息；没成句的看进一张之后最高能成多少息。 */
  const need = Math.max(0, (opts.minXi ?? 0) - (opts.meldXi ?? 0)
    - groups.reduce((a, g) => a + g.xi, 0));
  const bestXi = (pick: Kind[]) => {
    const x = sentXi(sortKinds(pick));
    if (x >= 0) return x;
    let b = 0;
    for (const k of entrySet(pick)) {
      for (let i = 0; i < pick.length; i++) for (let j = i + 1; j < pick.length; j++) {
        const v = sentXi(sortKinds([pick[i], pick[j], k as Kind]));
        if (v > b) b = v;
      }
    }
    return b;
  };
  /** 这一堆值多少：进张价值 + 留下的好对子 - 拆对子的账；无胡路子上另算 */
  const score = (pick: Kind[], pool: Kind[]) => {
    /* 距离这一项：同一组里的牌越近越好。乘 24 是量纲对齐 ——
       drawValue 一档差不多值二三十分，一格距离压一档，正好能掰手腕。 */
    let v = dv(pick) - breakPenalty(pick, pool) - groupDist(pick) * 24;
    if (need > 0 && !noXi) v += Math.min(bestXi(pick), need) * 30;   // 还没开胡：先把息凑够
    // 两种摆法都不拆对子时，让"更值钱的那一对"干干净净地留着：
    // 二二五五九 → 五五九 + 二二（二比五值钱，二七十、一二三都有息）
    for (const k of new Set(pool)) {
      if (pool.filter(x => x === k).length >= 2 && !pick.includes(k)) v += kindXi(k) * 0.05;
    }
    if (noXi) {
      // 无胡：一对都不能留，零息的顺子才是正路
      if (hasPair(pick)) v -= 600;
      const x = sentXi(sortKinds(pick));
      if (x === 0) v += 400;              // 已经是零息的一句
      else if (x > 0) v -= 200;           // 有息的句子反而坏了无胡
      v -= pick.reduce((a, k) => a + (kindXi(k) > 0 ? 30 : 0), 0);   // 带息的字先打出去
    }
    return v;
  };
  /** 这一轮摆几张：除得尽就 3 张；除不尽（余 1）先摆 2 张，免得最后剩一张单的 */
  const takeSize = (n: number) => (n <= 2 ? n : n === 4 || n % 3 === 1 ? 2 : 3);
  /** 剩下这些牌里，有没有三张正好凑成一句的 */
  const hasSent = (pool: Kind[]) => {
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) for (let m = j + 1; m < pool.length; m++)
      if (sentXi(sortKinds([pool[i], pool[j], pool[m]])) >= 0) return true;
    return false;
  };
  let guard = 40;
  while (left.length >= 2 && guard-- > 0) {
    /* 2/2 不一定要凑成 3/1：硬凑三张容易把对子拆了。
       只有这堆牌里**真有三张能成一句**的时候才摆 3 张；
       张数是单数、非摆一组三张不可的时候当然还是摆 3 张（不然最后要剩单牌）。 */
    const size0 = takeSize(left.length);
    const size = size0 === 3 && left.length % 2 === 0 && !hasSent(left) ? 2 : size0;
    let best: number[] = [], bestS = -Infinity;
    const pickAt = (idx: number[]) => idx.map(i => left[i]);
    if (size === 2) {
      for (let i = 0; i < left.length; i++) for (let j = i + 1; j < left.length; j++) {
        const v = score(pickAt([i, j]), left);
        if (v > bestS) { bestS = v; best = [i, j]; }
      }
    } else {
      for (let i = 0; i < left.length; i++) for (let j = i + 1; j < left.length; j++) for (let m = j + 1; m < left.length; m++) {
        const v = score(pickAt([i, j, m]), left);
        if (v > bestS) { bestS = v; best = [i, j, m]; }
      }
    }
    if (best.length !== size) best = size === 2 ? [0, 1] : [0, 1, 2];   // 兜底：绝不能原地打转
    const pick = pickAt(best);
    left = left.filter((_, i) => !best.includes(i));
    const c = sortKinds(pick);
    groups.push({ cards: pick.length === 3 ? orderSent(c) : sortCol(c), kind: pick.length === 2 && c[0] === c[1] ? 'pair' : 'group', xi: Math.max(0, sentXi(c)) });
  }
  // 真剩一张（手牌总数就是那么个零头）：并到最搭的一组里，别单独摆一列
  for (const k of left) mergeOne(groups, k);
  return orderGroups(fitGroups(groups));
}

/**
 * 把一张落单的牌并进最搭的那一组：先找还没满 3 张的，都满了就并成 4 张的一组（坎除外，坎不掺别的牌）。
 * 这张牌跟谁都不搭（凑不出进张）的时候，**优先摞到对子上面** ——
 * 对子本来就等着进张，这张闲牌摆在它头上，进了牌顺手就把它打出去，位置好找。
 */
/** 一组牌整理成 HandGroup（三张的按"成句"的顺序摆） */
function mkGroup(c0: Kind[]): HandGroup {
  const c = sortCol(c0);
  const kind: HandGroup['kind'] = c.length === 1 ? 'single' : c.length === 2 && c[0] === c[1] ? 'pair' : c.length === 2 ? 'group' : 'group';
  return { cards: c.length === 3 ? orderSent(c) : c, kind, xi: Math.max(0, sentXi(c)) };
}

/**
 * 四张牌拆成两列：先试 2/2，再试 1/3；
 * **对子不许拆散**（柒捌玖玖 → 柒捌 + 玖玖，不会拆成 柒玖 + 捌玖），
 * 其余按"两边各自的进张价值之和"挑最高的那一种。
 */
function splitFour(c0: Kind[]): [Kind[], Kind[]] {
  const c = sortCol(c0);
  const cands: [Kind[], Kind[]][] = [];
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const a = [c[i], c[j]], b = c.filter((_, x) => x !== i && x !== j);
    cands.push([a, b]);                       // 2/2
  }
  /* 1/3 只在"三张已经成句"的时候才用 —— 成了的句子不拆，多出来的那张单独站一列。
     其余情况一律 2/2，不留单张。 */
  for (let i = 0; i < 4; i++) {
    const rest = c.filter((_, j) => j !== i);
    if (sentXi(rest) >= 0) cands.push([[c[i]], rest]);
  }
  const pairKept = (a: Kind[], b: Kind[]) => {
    // 原来有几对，拆完还剩几对：一对都没拆散才算"保住了"
    const cnt = (xs: Kind[]) => { const m = new Map<number, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return [...m.values()].filter(v => v >= 2).length; };
    return cnt(a) + cnt(b) >= cnt(c);
  };
  let best: [Kind[], Kind[]] = [c.slice(0, 2), c.slice(2)], bestScore = -1e9;
  for (const [a, b] of cands) {
    const score = drawValue(a) + drawValue(b)
      /* 对子不拆，优先级最高 —— 高过"保住一个已经成了的句子"：
         柒捌玖玖 拆成「柒捌 | 玖玖」，比拆成「玖 | 柒捌玖」顺眼得多，
         一对玖摆在一起，等它进张的时候一眼就看见。 */
      + (pairKept(a, b) ? 12000 : 0)
      + (a.length === 2 && b.length === 2 ? 3000 : 0);   // 能 2/2 就 2/2（不留单张）；成了的句子那一档另算
    if (score > bestScore) { bestScore = score; best = [a, b]; }
  }
  return best;
}

function mergeOne(groups: HandGroup[], k: Kind) {
  const isKan = (g: HandGroup) => g.cards.length >= 3 && new Set(g.cards).size === 1;
  const isPair = (g: HandGroup) => g.cards.length === 2 && g.cards[0] === g.cards[1];
  const pick = (lim: number) => {
    let t = -1, bestAff = -1, bestPair = 0, bestLen = 99;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (isKan(g) || g.cards.length >= lim) continue;
      const aff = affinity(g.cards, [k]);
      const pair = aff === 0 && isPair(g) ? 1 : 0;   // 谁都不搭：对子优先
      if (aff > bestAff || (aff === bestAff && (pair > bestPair || (pair === bestPair && g.cards.length < bestLen)))) {
        bestAff = aff; bestPair = pair; bestLen = g.cards.length; t = i;
      }
    }
    return t;
  };
  // 已经成句的那几组先别动（拆散了可惜）
  let t = pick(AUTO_IN_GROUP);
  /* 没地方放了：只要列数还没到顶，就**拆开摆两列**，别硬凑成四张一组 ——
     四张挤在一列，看着就不像牌了（柒捌玖玖 摆成一列，谁也认不出那是一对玖）。
     拆的时候优先 2/2，对子不拆；实在不行才 1/3。 */
  if (t < 0 && groups.length < MAX_GROUPS) {
    let bi = -1, bestAff = -1;
    for (let i = 0; i < groups.length; i++) {
      if (isKan(groups[i]) || groups[i].cards.length !== 3) continue;
      const aff = affinity(groups[i].cards, [k]);
      if (aff > bestAff) { bestAff = aff; bi = i; }
    }
    if (bi >= 0) {
      const [a, b] = splitFour([...groups[bi].cards, k]);
      groups[bi] = mkGroup(a);
      groups.push(mkGroup(b));
      return;
    }
  }
  /* 实在没地方放才考虑摆四张 —— 而且**只有龙（四张同字）才准四张一列**。
     别的牌四张挤一列，谁也认不出那是什么，宁可先摞在别人头上。 */
  if (t < 0) {
    let bi = -1, bestAff = -1;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.cards.length !== 3 || !canBeFour([...g.cards, k])) continue;
      const aff = affinity(g.cards, [k]);
      if (aff > bestAff) { bestAff = aff; bi = i; }
    }
    t = bi;
  }
  if (t < 0) {
    // 龙也凑不成：摞到"最近"的那一组上面（哪怕四张），总好过单独占一列
    let bi = -1, bestD = Infinity;
    for (let i = 0; i < groups.length; i++) {
      if (isKan(groups[i]) || groups[i].cards.length >= MAX_IN_GROUP) continue;
      const d = groupDist([...groups[i].cards, k]);
      if (d < bestD) { bestD = d; bi = i; }
    }
    t = bi;
  }
  if (t < 0) { groups.push({ cards: [k], kind: 'single', xi: 0 }); return; }
  const c = sortCol([...groups[t].cards, k]);
  groups[t] = { cards: c.length === 3 ? orderSent(c) : c, kind: 'group', xi: Math.max(0, sentXi(c)) };
}

/** 收口：组数压到 8 以内（并的时候先按 3 张封顶，实在压不下去才允许 4 张）。坎一律不参与合并 */
function fitGroups(groups: HandGroup[]): HandGroup[] {
  const out = groups.filter(g => g.cards.length);
  const isKan = (g: HandGroup) => g.cards.length >= 3 && new Set(g.cards).size === 1;
  const pass = (lim: number) => {
    let guard = 40;
    while (out.length > MAX_GROUPS && guard-- > 0) {
      let a = -1, b = -1, bestAff = -1, bestLen = 99;
      for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
        if (isKan(out[i]) || isKan(out[j])) continue;                 // 坎不拆也不掺别的牌
        const merged = [...out[i].cards, ...out[j].cards];
        const len = merged.length;
        if (len > lim || !canBeFour(merged)) continue;     // 四张一列只给龙
        const aff = affinity(out[i].cards, out[j].cards);
        if (aff > bestAff || (aff === bestAff && len < bestLen)) { bestAff = aff; bestLen = len; a = i; b = j; }
      }
      if (a < 0) break;
      const c = sortCol([...out[a].cards, ...out[b].cards]);
      out[a] = { cards: c.length === 3 ? orderSent(c) : c, kind: 'group', xi: Math.max(0, sentXi(c)) };
      out.splice(b, 1);
    }
  };
  pass(AUTO_IN_GROUP);
  if (out.length > MAX_GROUPS) pass(MAX_IN_GROUP);
  scatterTail(out);
  return out;
}

/**
 * 最后的收口：组数还是超了，就**把最右边那一组拆散**，一张一张补给左边不满三张的组。
 *
 * 上面那两轮 pass 是"两组并成一组"，可它有并不动的时候 —— 比如七组都齐齐整整三张、
 * 外面还多出一组两张：任何两组并起来都超过四张，于是就卡在八组。
 * 拆最右边那一组是最不心疼的：按 groupRank 排完，最右边本来就是最散、最该打出去的那几张。
 * 拆下来的每张牌找"并进去之后整组距离最小"的那一组落脚（坎不掺别的牌）。
 */
function scatterTail(out: HandGroup[]) {
  const isKan = (g: HandGroup) => g.cards.length >= 3 && new Set(g.cards).size === 1;
  const putIn = (k: Kind, lim: number) => {
    let bi = -1, bestD = Infinity;
    for (let i = 0; i < out.length; i++) {
      if (isKan(out[i]) || out[i].cards.length >= lim) continue;
      const d = groupDist([...out[i].cards, k]);
      if (d < bestD) { bestD = d; bi = i; }
    }
    if (bi < 0) return false;
    const c = sortCol([...out[bi].cards, k]);
    out[bi] = { cards: c.length === 3 ? orderSent(c) : c, kind: 'group', xi: Math.max(0, sentXi(c)) };
    return true;
  };
  let guard = 20;
  while (out.length > MAX_GROUPS && guard-- > 0) {
    // 先按左右次序排好，这样"最右边"才是真的最右边
    const ord = orderGroups(out.slice());
    out.length = 0; out.push(...ord);
    let ti = -1;
    for (let i = out.length - 1; i >= 0; i--) if (!isKan(out[i])) { ti = i; break; }
    if (ti < 0) break;                       // 全是坎：拆不得，认了
    const tail = out[ti].cards.slice();
    out.splice(ti, 1);
    // 先补给不满三张的；都满了才退一步允许并成四张；实在没地方放就摆回去（下一轮再说）
    for (const k of tail) if (!putIn(k, AUTO_IN_GROUP) && !putIn(k, MAX_IN_GROUP)) out.push({ cards: [k], kind: 'single', xi: 0 });
  }
}

/**
 * 亮牌时的分组：成句 / 对子先成组，剩下的散牌按"搭不搭"三张一并 ——
 * 一手牌最多 21 张，三张一组正好 7 组，两侧玩家的一行放得下。
 */
export function revealCols(hand: Kind[], maxCols = 7): Kind[][] {
  const out = autoSort(hand).map(g => g.cards.slice());
  let guard = 40;
  while (guard-- > 0) {
    const small = out.filter(c => c.length < 3).length;
    if (!small || (out.length <= maxCols && small <= 1)) break;
    let a = -1, b = -1, bestAff = -1, bestLen = 99;
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
      if (out[i].length + out[j].length > 3) continue;
      const aff = affinity(out[i], out[j]);
      if (aff > bestAff || (aff === bestAff && out[i].length + out[j].length < bestLen)) {
        bestAff = aff; bestLen = out[i].length + out[j].length; a = i; b = j;
      }
    }
    if (a < 0) break;                       // 并不动了就算了
    out[a] = sortCol([...out[a], ...out[b]]); out.splice(b, 1);
  }
  // 张数多的排前面（靠玩家那一头），一样多的保持原来的先后
  return out.map((c, i) => [c, i] as const).sort((x, y) => y[0].length - x[0].length || x[1] - y[1]).map(x => x[0]);
}


/**
 * 「胡」字标在**哪一组下地牌**上 —— 认牌号，不认牌面。
 *
 * 出过的岔子：吃了「壹贰叁」下地，后来摸到一张叁**吊对**胡。
 * 吊对胡的那张进的是"那一对"，不在手里的句子里，所以按牌面找的时候
 * 手牌那一轮扑空、接着就在下地牌里撞上了壹贰叁里的那个叁 —— 「胡」字就标在了那儿。
 * 桌上看着像是"有笑不笑、逃笑胡的"，冤枉人。
 *
 * 牌号对不上就**一组都不标**（返回 -1），让它继续往后落到"那一对"上去。
 * 老纪录没有牌号（cid 缺着）才退回按牌面找：会标错，但总比整局一个「胡」字都没有强。
 */
export function markInMelds(melds: { cards: Kind[]; cids?: number[] }[], cid: number | undefined | null,
                     card: Kind | null | undefined): number {
  if (typeof cid === 'number') return melds.findIndex(m => m.cids?.includes(cid));
  return melds.findIndex(m => card !== null && card !== undefined && card >= 0 && m.cards.includes(card));
}
