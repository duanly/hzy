import { type Kind, type Counts, KIND_COUNT, rankOf, isBig, kindOf, sameRankOther, toCounts } from './cards.ts';

/** 句子类型 */
export type GroupType =
  | 'kan'   // 坎：手中暗三张
  | 'wei'   // 偎：摸牌暗碰（三张暗）
  | 'peng'  // 碰：明三张
  | 'pao'   // 跑：明四张
  | 'ti'    // 提：暗四张
  | 'chi'   // 吃/顺：一二三、二七十、连牌、大小同字
  | 'pair'  // 理牌用：对子 / 搭子
  | 'single';

export interface Group {
  type: GroupType;
  cards: Kind[];
  xi: number;      // 胡息
}

/** 判断 3 张是否成"顺"类句子，并返回息（不成返回 -1） */
export function chiXi(a: Kind, b: Kind, c: Kind): number {
  const ks = [a, b, c].sort((x, y) => rankOf(x) - rankOf(y) || x - y);
  const r = ks.map(rankOf);
  const big = ks.map(isBig);
  const allBig = big.every(Boolean), allSmall = big.every(v => !v);
  // 大小同字：二二贰 / 二贰贰
  if (r[0] === r[1] && r[1] === r[2]) {
    return (allBig || allSmall) ? -1 : 0; // 三张同样的应为坎，不属于顺
  }
  const set = r.join(',');
  if (set === '1,2,3' || set === '2,7,10') {
    if (allBig) return 6;
    if (allSmall) return 3;
    return -1; // 一二三 / 二七十 必须纯大字或纯小字
  }
  // 连牌：必须同大小
  if ((allBig || allSmall) && r[1] === r[0] + 1 && r[2] === r[1] + 1) return 0;
  return -1;
}

export function kanXi(k: Kind): number { return isBig(k) ? 6 : 3; }
export function weiXi(k: Kind): number { return isBig(k) ? 6 : 3; }
export function pengXi(k: Kind): number { return isBig(k) ? 3 : 1; }
export function paoXi(k: Kind): number { return isBig(k) ? 9 : 6; }
export function tiXi(k: Kind): number { return isBig(k) ? 12 : 9; }

/** 生成所有包含 kind k 的三张组合候选（用于分解 DP） */
function candidatesContaining(k: Kind): Kind[][] {
  const out: Kind[][] = [];
  out.push([k, k, k]);
  const o = sameRankOther(k);
  out.push([k, k, o]);
  out.push([k, o, o]);
  const r = rankOf(k);
  const patterns: number[][] = [];
  if ([1, 2, 3].includes(r)) patterns.push([1, 2, 3]);
  if ([2, 7, 10].includes(r)) patterns.push([2, 7, 10]);
  for (const start of [r - 2, r - 1, r]) {
    if (start >= 1 && start + 2 <= 10) {
      const p = [start, start + 1, start + 2];
      if (!(p[0] === 1 && p[2] === 3)) patterns.push(p);
    }
  }
  for (const p of patterns) {
    const others = p.filter(x => x !== r);
    const isSeq123or2710 = (p[0] === 1 && p[2] === 3) || (p[0] === 2 && p[2] === 10);
    if (isSeq123or2710) {
      const big = isBig(k);
      out.push([k, kindOf(others[0], big), kindOf(others[1], big)]);
    } else {
      const big = isBig(k);
      out.push([k, kindOf(others[0], big), kindOf(others[1], big)]);
    }
  }
  return out;
}

export interface PartitionResult {
  complete: boolean;
  groups: Group[];      // 三张句子
  pairs: Kind[][];      // 搭子（仅 allowPartial）
  singles: Kind[];      // 散牌（仅 allowPartial）
  xi: number;           // 句子总息
  score: number;        // 内部评估分
}

const memo = new Map<string, PartitionResult>();

/**
 * 手牌分解。complete 模式要求全部成句；partial 模式允许搭子与散牌，
 * 目标：最大化 (成句数*1000 + 搭子数*100 + 息)。
 */
/**
 * 完整分解：张数 ≡ 0 (mod 3) 时必须全部成组；≡ 2 时必须恰好一个对子（有提/跑/龙时的"作对"）；≡ 1 不能胡。
 * 部分分解（理牌 / 机器人评估）允许搭子与散牌。
 */
/**
 * 判胡专用的分解：手里原有的坎（同一个字三张）先整组挑出来当坎，
 * 剩下的牌再照常分解 —— 坎不许拆开配别的句子（例如三张大拾拆成「贰柒拾」和「十拾拾」是不认的）。
 * kanBase 是"进张之前"的手牌（胡的那一张凑成的三张不算坎）。
 */
export function partitionKeepKan(cards: Kind[], kanBase: Kind[]): PartitionResult {
  const base = toCounts(kanBase);
  const rest = cards.slice();
  const kanGroups: Group[] = [];
  let kanXiSum = 0;
  for (let k = 0; k < KIND_COUNT; k++) {
    while (base[k] >= 3 && rest.filter(x => x === k).length >= 3) {
      for (let i = 0; i < 3; i++) rest.splice(rest.indexOf(k), 1);
      base[k] -= 3;
      kanGroups.push({ cards: [k, k, k], xi: kanXi(k), type: 'kan' });
      kanXiSum += kanXi(k);
    }
  }
  if (!kanGroups.length) return partition(cards, false);
  const sub = partition(rest, false);
  return { ...sub, groups: [...kanGroups, ...sub.groups], xi: sub.xi + kanXiSum, complete: sub.complete };
}

export function partition(cards: Kind[], allowPartial = false): PartitionResult {
  const counts = toCounts(cards);
  if (allowPartial) return solve(counts, true, 0);
  const rem = cards.length % 3;
  if (rem === 1) return { complete: false, groups: [], pairs: [], singles: [], xi: 0, score: -1 };
  return solve(counts, false, rem === 2 ? 1 : 0);
}

function solve(counts: Counts, allowPartial: boolean, pairBudget: number, banPair = 0): PartitionResult {
  const key = (allowPartial ? 'p' : 'c') + pairBudget + '|' + banPair + '|' + counts.join('');
  const hit = memo.get(key);
  if (hit) return hit;
  if (memo.size > 300000) memo.clear();
  const res = solveInner(counts, allowPartial, pairBudget, banPair);
  memo.set(key, res);
  return res;
}

function solveInner(counts: Counts, allowPartial: boolean, pairBudget: number, banPair = 0): PartitionResult {
  let k = 0;
  while (k < KIND_COUNT && counts[k] === 0) k++;
  if (k === KIND_COUNT) return { complete: pairBudget === 0, groups: [], pairs: [], singles: [], xi: 0, score: pairBudget === 0 ? 0 : -1 };

  let best: PartitionResult | null = null;
  const consider = (r: PartitionResult | null) => {
    if (!r) return;
    if (!best || r.score > best.score) best = r;
  };

  for (const cand of candidatesContaining(k)) {
    const need = toCounts(cand);
    let ok = true;
    for (let i = 0; i < KIND_COUNT; i++) if (need[i] > counts[i]) { ok = false; break; }
    if (!ok) continue;
    let xi: number; let type: GroupType;
    if (cand[0] === cand[1] && cand[1] === cand[2]) { xi = kanXi(k); type = 'kan'; }
    else { xi = chiXi(cand[0], cand[1], cand[2]); type = 'chi'; if (xi < 0) continue; }
    const next = counts.slice();
    for (const c of cand) next[c]--;
    const sub = solve(next, allowPartial, pairBudget, banPair);
    if (!sub.complete && !allowPartial) continue;
    consider({
      complete: sub.complete,
      groups: [{ type, cards: cand, xi }, ...sub.groups],
      pairs: sub.pairs, singles: sub.singles,
      xi: sub.xi + xi, score: sub.score + 1000 + xi,
    });
  }

  if (!allowPartial && pairBudget > 0 && counts[k] >= 2 && !((banPair >> k) & 1)) {
    // 作对：恰好一个对子（手里原有的坎不许留两张来作对）
    const next = counts.slice(); next[k] -= 2;
    const sub = solve(next, false, pairBudget - 1, banPair);
    if (sub.complete) consider({ complete: true, groups: sub.groups, pairs: [[k, k], ...sub.pairs], singles: [], xi: sub.xi, score: sub.score + 100 });
  }

  if (allowPartial) {
    // 搭子：对子 / 大小同字 / 一二三、二七十 中两张 / 相邻两张
    const partners = new Set<Kind>();
    partners.add(k);
    partners.add(sameRankOther(k));
    const r = rankOf(k);
    const pats: number[][] = [];
    if ([1, 2, 3].includes(r)) pats.push([1, 2, 3]);
    if ([2, 7, 10].includes(r)) pats.push([2, 7, 10]);
    for (const p of pats) for (const x of p) if (x !== r) partners.add(kindOf(x, isBig(k)));
    for (const d of [-1, 1]) if (r + d >= 1 && r + d <= 10) partners.add(kindOf(r + d, isBig(k)));
    for (const p of partners) {
      const next = counts.slice();
      next[k]--; if (next[p] <= 0) continue; next[p]--;
      const sub = solve(next, true, 0);
      const pairXi = (p === k) ? (isBig(k) ? 2 : 1) : 0; // 对子略优先（可发展为坎/碰）
      consider({ complete: false, groups: sub.groups, pairs: [[k, p], ...sub.pairs], singles: sub.singles,
        xi: sub.xi, score: sub.score + 100 + pairXi });
    }
    // 散牌
    const next = counts.slice(); next[k]--;
    const sub = solve(next, true, 0);
    consider({ complete: false, groups: sub.groups, pairs: sub.pairs, singles: [k, ...sub.singles], xi: sub.xi, score: sub.score });
  }
  return best ?? { complete: false, groups: [], pairs: [], singles: [], xi: 0, score: -1 };
}

/**
 * 下伙：吃牌后，手中其余的 k 必须全部组成三张牌组一起下地。
 * 返回所有可行的分组方案（每组都含 k），由调用方按"不能拆坎"等规则挑选。
 */
export function layDownAll(hand: Kind[], k: Kind): { groups: Kind[][]; xi: number }[] {
  const counts = toCounts(hand);
  if (counts[k] === 0) return [{ groups: [], xi: 0 }];
  const out: { groups: Kind[][]; xi: number }[] = [];
  const seen = new Set<string>();
  const cands = [...candidatesContaining(k), [k, k, k]];
  for (const cand of cands) {
    const need = toCounts(cand);
    let ok = true;
    for (let i = 0; i < KIND_COUNT; i++) if (need[i] > counts[i]) { ok = false; break; }
    if (!ok) continue;
    const xi = cand[0] === cand[1] && cand[1] === cand[2] ? kanXi(k) : chiXi(cand[0], cand[1], cand[2]);
    if (xi < 0) continue;
    const rest = hand.slice();
    for (const c of cand) rest.splice(rest.indexOf(c), 1);
    for (const sub of layDownAll(rest, k)) {
      const groups = [cand.slice(), ...sub.groups];
      const key = groups.map(g => g.slice().sort().join('-')).sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ groups, xi: xi + sub.xi });
    }
  }
  return out;
}

/** 兼容旧用法：取息最大的一种下伙方案 */
export function layDownWith(hand: Kind[], k: Kind): { groups: Kind[][]; xi: number } | null {
  const all = layDownAll(hand, k);
  if (!all.length) return null;
  return all.reduce((a, b) => (b.xi > a.xi ? b : a));
}

/**
 * 不能拆坎：手里原有 3 张的字（坎），要么整个留在手上，要么三张作为同一组（偎）一起下地；
 * 不能把坎里的牌分到不同牌组里用掉（例如手里三个大捌，吃小八下「八八捌」「八捌捌」就是拆坎）。
 * groups 是本次要下地的所有牌组（不含来牌），用来判断坎是不是整组下地。
 */
export function breaksKan(handCounts: Counts, used: Counts, groups: Kind[][] = []): boolean {
  for (let i = 0; i < KIND_COUNT; i++) {
    const before = handCounts[i], u = used[i] ?? 0;
    if (before < 3 || u === 0) continue;
    // 这个字被整坎下地的张数（三张同字自成一组）
    const whole = groups.filter(g => g.length === 3 && g[0] === i && g[1] === i && g[2] === i).length * 3;
    if (u !== whole) return true;                       // 坎被拆散进了别的牌组
    if (before - u > 0 && before - u < 3) return true;  // 手上剩下零散的残牌
  }
  return false;
}
