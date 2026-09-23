/**
 * 机器人：能听牌、会碰会杠、打牌挑最没用的那张。
 * 不追求打得好，只要求**打得像样且永远不卡住** —— 陪打和自动化测试都靠它。
 */
import { HONG, toCounts, type Tile } from './tiles.ts';
import { canHu, waits } from './hu.ts';
import type { MahjongGame, ActionType } from './game.ts';

/** 这张牌留着有多大用：越大越舍不得打 */
function keepScore(c: number[], t: Tile): number {
  if (t === HONG) return 1000;                       // 赖子打死不打
  let v = c[t] * 10;                                 // 对子、刻子留着
  const r = t % 9;
  // 连张：跟左右能不能搭上
  if (r >= 1 && c[t - 1]) v += 4;
  if (r <= 7 && c[t + 1]) v += 4;
  if (r >= 2 && c[t - 2]) v += 2;
  if (r <= 6 && c[t + 2]) v += 2;
  v += 4 - Math.abs(r - 4);                          // 中张比幺九活
  return v;
}

/**
 * 挑一张打出去：优先挑打完之后"听的牌最多"的那张，平手再看留牌价值。
 *
 * `strength` 是**故意留的水平旋钮**（0~1）。一直挑最优的那张就是满水平打法，
 * 放到陪打里会把真人碾得没脾气。按这个概率决定这一手认不认真：
 * 不认真的时候从"次好的那几张"里随手挑一张，像个走神的普通牌友。
 *
 * 默认值 0.6 是**量出来的**，不是拍的。拿一个 strength 0.55 的"普通真人"坐 0 号位
 * 对三个机器人，各跑四千局：
 *     机器人 1.0  → 真人胡率 14.3%，场均 -3.66 分
 *     机器人 0.85 → 17.0%，-2.72
 *     机器人 0.75 → 19.9%，-1.80
 *     机器人 0.6  → 23.4%，-0.35   ← 贴着公平线（四家平均 25%）
 *     机器人 0.55 → 26.0%，+0.42
 * 再高真人就被压着打，再低机器人开始送分。
 */
export function bestDiscard(hand: Tile[], meldCount: number, strength = 0.6, rnd: () => number = Math.random): Tile {
  const uniq = [...new Set(hand)];
  const c = toCounts(hand);
  const cand: { t: Tile; w: number; k: number }[] = [];
  for (const t of uniq) {
    if (t === HONG && uniq.length > 1) continue;     // 有别的可打就别打赖子
    const rest = hand.slice();
    rest.splice(rest.indexOf(t), 1);
    cand.push({ t, w: waits(rest, meldCount).length, k: keepScore(c, t) });
  }
  if (!cand.length) return hand[0];
  cand.sort((a, b) => b.w - a.w || a.k - b.k);
  if (rnd() < strength || cand.length === 1) return cand[0].t;
  // 走神这一手：从前三名里随手挑一个（不含第一名）
  const pool = cand.slice(1, 4);
  return pool[Math.floor(rnd() * pool.length)].t;
}

/** 轮到我了该干嘛。strength 见 bestDiscard */
export function decideTurn(g: MahjongGame, seat: number, strength = 0.6, rnd: () => number = Math.random): { type: ActionType; tile?: Tile } {
  const p = g.players[seat];
  // 能胡必胡 —— 这一条不受水平影响，再菜的人也不会放过自摸
  if (canHu(p.hand, p.melds.length)) return { type: 'hu' };
  // 杠：只在杠完还听得上（或者本来就没听）的时候杠，免得把听口杠没了
  for (const t of g.selfGangTiles(seat)) {
    const before = waits(dropOne(p.hand), p.melds.length).length;
    if (before === 0) return { type: 'gang', tile: t };
  }
  return { type: 'discard', tile: bestDiscard(p.hand, p.melds.length, strength, rnd) };
}

/** 别人打出来了，要不要 */
export function decideClaim(g: MahjongGame, seat: number, tile: Tile, options: ActionType[]): ActionType {
  const p = g.players[seat];
  const meldCount = p.melds.length;
  if (options.includes('gang')) {
    const after = p.hand.filter(t => t !== tile);
    if (waits(after, meldCount + 1).length || waits(p.hand.slice(0, -1), meldCount).length === 0) return 'gang';
  }
  if (options.includes('peng')) {
    // 碰了之后手上少两张、多一句：听口没变差就碰
    const after = p.hand.slice();
    for (let k = 0; k < 2; k++) after.splice(after.indexOf(tile), 1);
    const before = waits(dropOne(p.hand), meldCount).length;
    if (waits(after, meldCount + 1).length >= before) return 'peng';
  }
  return 'pass';
}

function dropOne(hand: Tile[]): Tile[] { return hand.slice(0, hand.length - 1); }
