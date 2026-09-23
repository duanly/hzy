/**
 * 胡牌判定：4 句 + 1 对，红中当赖子随便变。
 *
 * 判定的难点全在赖子上。没有赖子时，"最小的那张牌必定属于某个句子"，
 * 顺着这条贪心地拆就行；有了赖子，最小那张牌**可以不跟任何真牌组队**
 * （自己配两张赖子成刻），所以得把每一种用法都试一遍。
 *
 * 这里用的办法：永远盯住**编码最小的那张真牌**，枚举它所有可能的归宿
 * （刻 / 顺 / 将，各自再分"用几张赖子补"），递归下去。真牌用完之后，
 * 剩下的缺口能不能拿赖子填平，是一道简单的算术题。
 * 每一步都把最小那张牌消耗掉，所以必然收敛，也不会重复数同一种拆法。
 */
import { HONG, TILE_COUNT, type Counts, type Tile, toCounts } from './tiles.ts';

/** 一句：刻（三张同）/ 顺（三张连）/ 将（对子）。cards 是**补全之后**的样子 */
export interface Meld {
  type: 'ke' | 'shun' | 'pair' | 'gang';
  tiles: Tile[];
  /** 这一句里用掉了几张红中 */
  hong: number;
  /** 明的（碰 / 明杠）：别人看得见 */
  open?: boolean;
}

/** 手里还剩多少赖子够不够把缺口填上：每句 3 张，将 2 张 */
function fillable(need: number, needPair: boolean, hong: number): boolean {
  return hong >= need * 3 + (needPair ? 2 : 0);
}

/**
 * @param c        真牌计数（下标 0..26，红中不在里面）
 * @param need     还差几句
 * @param needPair 将还没凑上
 * @param hong     手里还剩几张红中
 */
function search(c: Counts, need: number, needPair: boolean, hong: number): boolean {
  if (need < 0 || hong < 0) return false;

  // 找编码最小的那张真牌
  let i = 0;
  while (i < 27 && c[i] === 0) i++;
  if (i === 27) return fillable(need, needPair, hong);   // 真牌用完了，剩下的靠赖子

  // ---- 当将（对子）----
  if (needPair) {
    if (c[i] >= 2) {
      c[i] -= 2; if (search(c, need, false, hong)) { c[i] += 2; return true; } c[i] += 2;
    }
    // 单张 + 一张赖子也能当将
    c[i] -= 1; if (search(c, need, false, hong - 1)) { c[i] += 1; return true; } c[i] += 1;
  }

  if (need > 0) {
    // ---- 当刻：手里有几张就用几张，差的拿赖子补 ----
    for (let use = Math.min(3, c[i]); use >= 1; use--) {
      c[i] -= use;
      if (search(c, need - 1, needPair, hong - (3 - use))) { c[i] += use; return true; }
      c[i] += use;
    }
    // ---- 当顺：i 必须是本花色的 1~7 位，i、i+1、i+2 同花色 ----
    if (i % 9 <= 6) {
      // i 自己一定要用掉（它是最小的那张），另外两张各自可真可赖
      for (const b of [1, 0]) for (const d of [1, 0]) {
        if ((b && c[i + 1] < 1) || (d && c[i + 2] < 1)) continue;
        const cost = (b ? 0 : 1) + (d ? 0 : 1);
        c[i] -= 1; if (b) c[i + 1] -= 1; if (d) c[i + 2] -= 1;
        const ok = search(c, need - 1, needPair, hong - cost);
        c[i] += 1; if (b) c[i + 1] += 1; if (d) c[i + 2] += 1;
        if (ok) return true;
      }
    }
  }
  return false;
}

/**
 * 这副牌能不能胡。
 * @param hand      手上的牌（含刚摸的那张、含红中），**不含**已经碰/杠下地的
 * @param meldCount 已经下地了几句（碰、杠各算一句）
 */
export function canHu(hand: Tile[], meldCount = 0): boolean {
  const need = 4 - meldCount;
  if (need < 0) return false;
  const c = toCounts(hand);
  const hong = c[HONG];
  c[HONG] = 0;
  // 张数得对得上：need 句 ×3 + 将 2 张
  const total = hand.length;
  if (total !== need * 3 + 2) return false;
  return search(c, need, true, hong);
}

/** 听哪些牌（摸到哪张能胡）。手上是 need*3+1 张的时候调用 */
export function waits(hand: Tile[], meldCount = 0): Tile[] {
  const out: Tile[] = [];
  for (let t = 0; t < TILE_COUNT; t++) {
    if (canHu([...hand, t], meldCount)) out.push(t);
  }
  return out;
}

/** 胡了之后把牌拆成一句一句的（给结算面板和复盘看）。拆不出来返回 null */
export function explain(hand: Tile[], meldCount = 0): Meld[] | null {
  const need = 4 - meldCount;
  const c = toCounts(hand);
  const hong = c[HONG];
  c[HONG] = 0;
  if (hand.length !== need * 3 + 2) return null;
  const out: Meld[] = [];
  return build(c, need, true, hong, out) ? out : null;
}

function build(c: Counts, need: number, needPair: boolean, hong: number, out: Meld[]): boolean {
  if (need < 0 || hong < 0) return false;
  let i = 0;
  while (i < 27 && c[i] === 0) i++;
  if (i === 27) {
    if (!fillable(need, needPair, hong)) return false;
    // 剩下的全用红中凑：整句的红中刻、整对的红中将
    for (let k = 0; k < need; k++) out.push({ type: 'ke', tiles: [HONG, HONG, HONG], hong: 3 });
    if (needPair) out.push({ type: 'pair', tiles: [HONG, HONG], hong: 2 });
    return true;
  }
  if (needPair) {
    if (c[i] >= 2) {
      c[i] -= 2; out.push({ type: 'pair', tiles: [i, i], hong: 0 });
      if (build(c, need, false, hong, out)) return true;
      out.pop(); c[i] += 2;
    }
    c[i] -= 1; out.push({ type: 'pair', tiles: [i, i], hong: 1 });
    if (build(c, need, false, hong - 1, out)) return true;
    out.pop(); c[i] += 1;
  }
  if (need > 0) {
    for (let use = Math.min(3, c[i]); use >= 1; use--) {
      c[i] -= use; out.push({ type: 'ke', tiles: [i, i, i], hong: 3 - use });
      if (build(c, need - 1, needPair, hong - (3 - use), out)) return true;
      out.pop(); c[i] += use;
    }
    if (i % 9 <= 6) {
      for (const b of [1, 0]) for (const d of [1, 0]) {
        if ((b && c[i + 1] < 1) || (d && c[i + 2] < 1)) continue;
        const cost = (b ? 0 : 1) + (d ? 0 : 1);
        c[i] -= 1; if (b) c[i + 1] -= 1; if (d) c[i + 2] -= 1;
        out.push({ type: 'shun', tiles: [i, i + 1, i + 2], hong: cost });
        if (build(c, need - 1, needPair, hong - cost, out)) return true;
        out.pop();
        c[i] += 1; if (b) c[i + 1] += 1; if (d) c[i + 2] += 1;
      }
    }
  }
  return false;
}
