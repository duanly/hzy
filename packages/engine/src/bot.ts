import { type Kind, isBig, toCounts } from './cards.ts';
import { partition, chiXi } from './groups.ts';
import { type Game, type ActionType } from './game.ts';

export interface BotDecision { type: ActionType; card?: Kind; combo?: Kind[] }

/**
 * 机器人：基于手牌分解的启发式评估。
 * 评估 = 成句数*1000 + 搭子*100 + 息*20 + 对子潜力 - 孤张惩罚
 */
export function evaluateHand(hand: Kind[], meldXi: number, threshold: number, dead: Kind[] = []): number {
  const r = partition(hand, true);
  let score = r.groups.length * 1000 + r.pairs.length * 100 + (r.xi + meldXi) * 20;
  const deadCounts = toCounts(dead);
  for (const [a, b] of r.pairs) {
    if (a === b) score += isBig(a) ? 40 : 20;          // 对子可发展为碰/偎
    if (a === b && deadCounts[a] >= 2) score -= 60;    // 死对子
  }
  for (const s of r.singles) {
    // 孤张：剩余张数越少越没用
    const left = 4 - deadCounts[s];
    score -= (4 - left) * 5;
  }
  // 息不足以起胡时，惩罚（推动机器人保留大字/对子）
  const potential = r.xi + meldXi + r.pairs.filter(([a, b]) => a === b).reduce((x, [a]) => x + (isBig(a) ? 3 : 1), 0);
  if (potential < threshold) score -= (threshold - potential) * 15;
  return score;
}

function bestDiscard(game: Game, seat: number, hand: Kind[]): { card: Kind; score: number } {
  const p = game.players[seat];
  const meldXi = game.meldXi(p);
  const counts = new Map<number, number>(); for (const k of hand) counts.set(k, (counts.get(k) ?? 0) + 1);
  let uniq = [...new Set(hand)].filter(k => (counts.get(k) ?? 0) < 3); // 不拆坎
  if (!uniq.length) uniq = [...new Set(hand)];
  /* 一张牌都挑不出来（手是空的）：返回 -1，让调用方知道"这儿没得打"。
     以前返回的是 undefined，一路传到 act 里变成"must discard"被拒 ——
     机器人每两百毫秒重试一次、次次被拒，既不报错也不出事件，整桌就那么假死在出牌这一步。 */
  if (!uniq.length) return { card: -1 as Kind, score: -Infinity };
  let best = { card: uniq[0], score: -Infinity };
  for (const c of uniq) {
    const h = hand.slice(); h.splice(h.indexOf(c), 1);
    let s = evaluateHand(h, meldXi, game.rules.huThreshold, game.deadPool);
    // 安全性：已打出多张的牌更安全
    const seen = game.deadPool.filter(x => x === c).length;
    s += seen * 3;
    if (s > best.score) best = { card: c, score: s };
  }
  return best;
}

export function botDecide(game: Game, seat: number): BotDecision | null {
  const opt = game.optionsFor(seat);
  if (!opt) return null;
  const types = new Set(opt.options.map(o => o.type));
  const p = game.players[seat];
  const meldXi = game.meldXi(p);
  const thr = game.rules.huThreshold;

  // 衡阳有胡必胡：能胡就只能胡，提也不行（引擎会拒绝别的动作）
  if (game.rules.mustHu && types.has('hu')) return { type: 'hu' };
  if (types.has('ti')) return { type: 'ti' };
  if (types.has('hu')) return { type: 'hu' };
  if (types.has('wei')) return { type: 'wei' };   // 规则：两张在手摸到第三张必须偎
  if (types.has('pao')) return { type: 'pao' };

  if (game.phase === 'discard') {
    const d = bestDiscard(game, seat, p.hand).card;
    return d >= 0 ? { type: 'discard', card: d } : null;   // 挑不出来就别出手，交给引擎超时那一路兜底
  }

  if (game.phase === 'drawer_decide' && types.has('discard')) {
    // 庄家 21 张放弃天胡（不会发生，兜底）
    const d = bestDiscard(game, seat, p.hand).card;
    return d >= 0 ? { type: 'discard', card: d } : null;
  }

  const card = opt.options[0].card;
  // 回头牌不要碰 / 不要吃：拿了就是违规（罚分 + 本局禁胡），机器人不干这种事
  const tc: number | undefined = (game as any).tableCard?.card;
  const backPeng = tc !== undefined && p.chou.includes(tc);
  const backChi = tc !== undefined && p.passedChi.includes(tc);
  const baseline = evaluateHand(p.hand, meldXi, thr, game.deadPool);

  if (types.has('peng') && !backPeng) {
    const h = p.hand.slice(); h.splice(h.indexOf(card), 1); h.splice(h.indexOf(card), 1);
    const after = bestDiscard(game, seat, h).score + (isBig(card) ? 3 : 1) * 20 + 1000;
    if (after >= baseline) return { type: 'peng' };
  }
  if (!backChi && types.has('chi') && !p.passedChi.includes(card)) {
    const o = opt.options.find(x => x.type === 'chi')!;
    let best: { combo: Kind[]; score: number } | null = null;
    for (const combo of o.combos ?? []) {
      const h = p.hand.slice(); h.splice(h.indexOf(combo[0]), 1); h.splice(h.indexOf(combo[1]), 1);
      const xi = chiXi(card, combo[0], combo[1]);
      const s = bestDiscard(game, seat, h).score + xi * 20 + 1000;
      if (!best || s > best.score) best = { combo, score: s };
    }
    if (best && best.score > baseline) return { type: 'chi', combo: best.combo };
  }
  if (game.phase === 'drawer_decide') return { type: 'play_drawn' };
  return { type: 'pass' };
}
