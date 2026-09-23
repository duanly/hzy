import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, fullDeck, isRed, shuffle, riffleShuffle, type Kind } from '../src/cards.ts';
import { partition, partitionKeepKan, chiXi } from '../src/groups.ts';
import { Game } from '../src/game.ts';
import { getRules, hengyangDun, leiyangDun } from '../src/rules.ts';
import { botDecide } from '../src/bot.ts';

const S = (r: number) => kindOf(r, false);
const B = (r: number) => kindOf(r, true);

test('牌组与红字', () => {
  assert.equal(fullDeck().length, 80);
  assert.equal(fullDeck().filter(isRed).length, 24);
});

test('顺子息', () => {
  assert.equal(chiXi(B(1), B(2), B(3)), 6);
  assert.equal(chiXi(S(1), S(2), S(3)), 3);
  assert.equal(chiXi(S(2), S(7), S(10)), 3);
  assert.equal(chiXi(B(2), S(7), B(10)), -1);
  assert.equal(chiXi(S(3), S(4), S(5)), 0);
  assert.equal(chiXi(S(3), B(4), S(5)), -1);
  assert.equal(chiXi(S(2), S(2), B(2)), 0);
  assert.equal(chiXi(S(2), S(2), S(2)), -1);
});

test('胡牌分解：全大字一二三×7 = 42 息', () => {
  const hand: number[] = [];
  for (let i = 0; i < 7; i++) hand.push(B(1), B(2), B(3));
  // 每种牌只有 4 张，这里仅测试分解算法本身
  const r = partition(hand, false);
  assert.equal(r.complete, true);
  assert.equal(r.xi, 42);
});

test('胡牌分解：坎 + 顺 + 连牌', () => {
  const hand = [B(5), B(5), B(5), S(2), S(7), S(10), S(3), S(4), S(5)];
  const r = partition(hand, false);
  assert.equal(r.complete, true);
  assert.equal(r.xi, 6 + 3 + 0);
});

test('作对规则：有龙时手牌 ≡2 需恰好一个对子，无龙时不能有对子', () => {
  const base = [B(5), B(5), B(5), S(2), S(7), S(10), S(3), S(4), S(5)];
  assert.equal(partition([...base, S(9), S(9)], false).complete, true);   // 11 张：3 组 + 1 对
  assert.equal(partition([...base, S(9), S(8)], false).complete, false);
  assert.equal(partition([...base, S(9)], false).complete, false);          // 10 张 ≡1 不能胡
  assert.equal(partition([...base, S(9), S(9), S(8), S(8), S(6)], false).complete, false); // 两个对子 ✗
});

test('计敦', () => {
  assert.equal(hengyangDun(10), 3); assert.equal(hengyangDun(12), 2); assert.equal(hengyangDun(15), 3); assert.equal(hengyangDun(21), 5);
  assert.equal(leiyangDun(10), 2); assert.equal(leiyangDun(13), 1); assert.equal(leiyangDun(17), 2); assert.equal(leiyangDun(20), 4); assert.equal(leiyangDun(21), 3); assert.equal(leiyangDun(24), 4);
});

test('不完整手牌分解返回搭子', () => {
  const hand = [B(5), B(5), S(1), S(2), S(9)];
  const r = partition(hand, true);
  assert.equal(r.complete, false);
  assert.ok(r.pairs.length >= 1);
});

test('完整对局：机器人自打到结束（多局、三种玩法）', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let now = 0;
  const variants = ['hy_honghei', 'hy_liuhuqiang', 'ly_tilong'] as const;
  let hus = 0, liuju = 0;
  for (let g = 0; g < 150; g++) {
    const game = new Game({ rules: getRules(variants[g % 3]), baseScore: 1, dealer: g % 3, rnd, now: () => now });
    game.start();
    let steps = 0;
    while (!game.ended && steps++ < 2000) {
      let acted = false;
      for (let s = 0; s < game.n; s++) {
        const d = botDecide(game, s);
        if (d) { const err = game.act(s, d.type, d); assert.equal(err, null, `seat ${s} ${d.type} ${err}`); acted = true; break; }
      }
      if (!acted) { now += 20000; game.tick(now); }
    }
    assert.ok(game.ended, 'game should end');
    // 手牌数不变量：有龙 ≡1、无龙 ≡2（胡牌者含胡的那张则 ≡0/≡2）
    for (const p of game.players) {
      if (game.winner === p.seat) continue;
      assert.equal(p.hand.length % 3, p.longCount ? 1 : 2, `seat ${p.seat} hand ${p.hand.length} long ${p.longCount}`);
    }
    assert.equal(game.scores.reduce((a, b) => a + b, 0), 0, 'zero-sum');
    if (game.winner !== null) hus++; else liuju++;
  }
  assert.ok(hus > 0);
  console.log(`胡牌 ${hus} 局，流局 ${liuju} 局`);
});

function setup(h0: number[], h1: number[], h2: number[], now: () => number, variant: 'hy_honghei' | 'ly_tilong' = 'hy_honghei') {
  const game = new Game({ rules: getRules(variant), baseScore: 1, dealer: 0, now });
  game.players[0].hand = h0; game.players[1].hand = h1; game.players[2].hand = h2;
  game.pile = [S(1), S(2), S(3), S(4), S(5)];
  (game as any).enterDiscard(0);
  return game;
}
// 用不重复的"闲牌"把手牌补到 20 张：不会凑出坎，也不改变显式指定那些牌的张数
const POOL = [S(4), S(5), S(6), B(4), B(5), B(6), S(3), B(3), S(1), B(1), S(8), B(8), S(9), B(9), S(2), B(2), S(7), B(7), S(10), B(10)];
const pad = (cards: number[], avoid: number[] = [], total = 20) => {
  const out = cards.slice(); const used = new Set([...cards, ...avoid]);
  for (const k of POOL) { if (out.length >= total) break; if (!used.has(k)) { out.push(k); used.add(k); } }
  return out;
};

test('碰优先于吃：吃需等待碰方决定；碰方过后吃生效', () => {
  let now = 0;
  const game = setup(pad([B(9)]), pad([B(8), B(10)], [B(9)]), pad([B(9), B(9)]), () => now);
  assert.equal(game.act(0, 'discard', { card: B(9) }), null);
  assert.equal(game.phase, 'claim');
  assert.ok(game.optionsFor(1)!.options.some(o => o.type === 'chi'));
  assert.ok(game.optionsFor(2)!.options.some(o => o.type === 'peng'));
  assert.equal(game.act(1, 'chi', { combo: [B(8), B(10)] }), null);
  assert.equal(game.phase, 'claim', '吃需要等待碰方');
  assert.equal(game.act(2, 'pass'), null);
  now += 3100; game.tick(now);     // 吃要"捂一下"（读秒的 1/10）才落地，见 publicNoTake
  assert.equal(game.phase, 'discard');
  assert.equal(game.turn, 1);
  assert.equal(game.players[1].melds[0].type, 'chi');
});

test('碰方超时视为放弃，吃方生效', () => {
  let now = 0;
  const game = setup(pad([B(9)]), pad([B(8), B(10)], [B(9)]), pad([B(9), B(9)]), () => now);
  game.act(0, 'discard', { card: B(9) });
  game.act(1, 'chi', { combo: [B(8), B(10)] });
  now += 16000; game.tick(now);
  assert.equal(game.phase, 'discard');
  assert.equal(game.turn, 1);
  assert.ok(game.players[2].chou.includes(B(9)), '放弃碰后成为臭牌');
});

test('碰方选择碰则吃方落空', () => {
  let now = 0;
  const game = setup(pad([B(9)]), pad([B(8), B(10)], [B(9)]), pad([B(9), B(9)]), () => now);
  game.act(0, 'discard', { card: B(9) });
  game.act(1, 'chi', { combo: [B(8), B(10)] });
  assert.equal(game.act(2, 'peng'), null);
  assert.equal(game.turn, 2);
  assert.equal(game.players[2].melds[0].type, 'peng');
  assert.equal(game.players[1].melds.length, 0);
});

test('提龙玩法：提即时算分', () => {
  let now = 0;
  const game = new Game({ rules: getRules('ly_tilong'), baseScore: 2, dealer: 0, now: () => now });
  game.players[0].hand = pad([B(9), B(9), B(9)]);
  game.players[1].hand = pad([]); game.players[2].hand = pad([]);
  game.pile = [B(9), S(1), S(2), S(3)];
  (game as any).enterDraw(0);
  // 提排在队列最前面，系统直接代为执行
  assert.equal(game.players[0].melds[0].type, 'long', '手中三张摸到第四张提（龙）');
  assert.equal(game.players[0].melds[0].hidden, true, '龙亮一张盖三张');
  assert.equal(game.view(1).players[0].melds[0].cards.filter((c: number) => c >= 0).length, 1, '别人只看到一张');
  assert.deepEqual(game.scores, [8, -4, -4], '大字提每家付 2 倍底分');
  assert.equal(game.phase, 'discard', '第一次提需要出牌');
  assert.equal(game.turn, 0);
  assert.equal(game.players[0].hand.length, 17);
  game.act(0, 'discard', { card: game.players[0].hand[0] });
  assert.equal(game.players[0].hand.length % 3, 1);
});

test('偎优先于胡：两张在手摸到第三张必须偎，除非正好胡', () => {
  let now = 0;
  const game = new Game({ rules: getRules('hy_honghei'), baseScore: 1, now: () => now, dealer: 0 });
  game.players[0].hand = pad([B(9), B(9)]);
  game.players[1].hand = pad([]); game.players[2].hand = pad([]);
  game.pile = [B(9), S(1)];
  (game as any).enterDraw(0);
  if (!game.players[0].melds.length) {           // 这副牌同时能胡 → 由玩家选，显式偎
    assert.ok(game.optionsFor(0)!.options.some(o => o.type === 'wei'));
    assert.equal(game.act(0, 'wei'), null);
  }
  assert.equal(game.players[0].melds[0]?.type, 'wei', '两张在手摸到第三张偎');
  assert.equal(game.phase, 'discard', '偎后出牌');
});

test('六胡抢：4 人，庄 15 闲 14', () => {
  const game = new Game({ rules: getRules('hy_liuhuqiang'), baseScore: 1, dealer: 1 });
  game.start();
  assert.equal(game.players.length, 4);
  const ok = game.players.every(p => (p.hand.length + p.melds.filter(m => m.type === 'long').length * 4) === (p.seat === 1 ? 15 : 14) || p.melds.length > 0);
  assert.ok(ok);
});

test('吃牌要下伙：手中其余同字必须一起下地', () => {
  let now = 0;
  // 上家打 贰；下家手中 壹叁 可吃，但另有一张 贰 无法成组 → 不能吃
  const g1 = setup(pad([B(2)]), [B(1), B(3), B(2), S(4), S(4), S(4), S(6), S(6), S(6), S(8), S(8), S(8), B(4), B(4), B(4), B(6), B(6), B(6), S(5), S(9)], pad([]), () => now);
  assert.equal(g1.act(0, 'discard', { card: B(2) }), null);
  assert.ok(!g1.optionsFor(1)?.options.some(o => o.type === 'chi'), '有一张贰散着，吃不进，连按钮都不给');
  // 另有 贰柒拾 可与剩下的贰成组 → 可吃，且两组一起下地
  const g2 = setup(pad([B(2)]), pad([B(1), B(3), B(2), B(7), B(10)]), pad([]), () => now);
  assert.equal(g2.act(0, 'discard', { card: B(2) }), null);
  const chi = g2.optionsFor(1)!.options.find(o => o.type === 'chi')!;
  assert.ok(chi);
  assert.equal(g2.act(1, 'chi', { combo: chi.combos![0] }), null);
  now += 3100; g2.tick(now);       // 吃要"捂一下"才落地
  assert.equal(g2.players[1].melds.length, 2, '主组合 + 下伙一起下地');
  assert.equal(g2.players[1].hand.length % 3, 0, '吃 + 下伙后待出牌');
});

test('放炮：衡阳放炮者付三倍其他家不输赢；公牌被胡不算放炮', () => {
  let now = 0;
  const hand1 = [B(1), B(1), B(2), B(2), B(3), B(3), S(2), S(7), S(10), B(5), B(5), B(5), S(4), S(4), S(4), B(8), B(8), B(8), S(6), S(6)];
  const g = setup([S(6), S(4), S(4), S(4), S(8), S(8), S(8), B(1), B(1), B(1), B(3), B(3), B(3), B(4), B(4), B(4), B(6), B(6), B(6), S(9)], hand1, pad([]), () => now);
  g.act(0, 'discard', { card: S(6) });
  const hu = g.optionsFor(1)!.options;
  assert.ok(hu.some(o => o.type === 'hu'), '应当把胡牌按钮给出来');
  assert.ok(!hu.some(o => o.type === 'pass'), '衡阳有胡必胡，不能过');
  assert.equal(g.act(1, 'pass'), '有胡必胡');
  assert.equal(g.act(1, 'hu'), null);
  assert.equal(g.scores[2], 0, '另一家不输赢');
  assert.equal(g.scores[0], -g.scores[1]);
  const ev = g.events.find(e => e.t === 'hu') as any;
  assert.equal(ev.detail.dianPao, true);
  assert.equal(g.scores[1], ev.detail.unit * 3);
});

test('耒阳可放弃胡，下次胡必须更高', () => {
  let now = 0;
  const game = new Game({ rules: getRules('ly_tilong'), baseScore: 1, dealer: 0, now: () => now });
  const hand1 = [B(1), B(1), B(2), B(2), B(3), B(3), S(2), S(7), S(10), B(5), B(5), B(5), S(4), S(4), S(4), B(8), B(8), B(8), S(6), S(6)];
  game.players[0].hand = pad([S(6)]); game.players[1].hand = hand1; game.players[2].hand = pad([]);
  game.pile = [S(1), S(3), S(6), S(8)];
  (game as any).enterDiscard(0);
  game.act(0, 'discard', { card: S(6) });
  assert.ok(game.optionsFor(1)!.options.some(o => o.type === 'pass'), '耒阳可以过');
  assert.equal(game.act(1, 'pass'), null);
  assert.ok(game.players[1].declinedUnit > 0);
  // 弃胡要留下明细（哪张牌、每家多少分），纪录表里要用；没胡成也得记着
  assert.equal(game.players[1].declinedHu.length, 1);
  assert.equal(game.players[1].declinedHu[0].card, S(6));
  assert.ok(game.players[1].declinedHu[0].unit > 0);
});

test('违规罚分：拆坎出牌、吃回头牌；该偎自动执行', () => {
  let now = 0;
  // 拆坎
  const g1 = setup(pad([B(9), B(9), B(9)]), pad([]), pad([]), () => now);
  const err = g1.act(0, 'discard', { card: B(9) });
  assert.ok(err && err.includes('拆坎'), '拆坎出牌被挡回来，并给出说明');
  assert.deepEqual(g1.scores, [-6, 3, 3], '照样罚分');
  assert.equal(g1.events.filter(e => e.t === 'penalty').length, 1);
  assert.equal(g1.players[0].hand.filter(k => k === B(9)).length, 3, '牌收回来了');
  assert.equal(g1.huXiOf(g1.players[0], null), null, '本局禁胡');
  // 该偎不偎
  const g2 = new Game({ rules: getRules('hy_honghei'), baseScore: 1, dealer: 0, now: () => now });
  g2.players[0].hand = pad([B(9), B(9)]); g2.players[1].hand = pad([]); g2.players[2].hand = pad([]);
  g2.pile = [B(9), S(1), S(2)];
  (g2 as any).enterDraw(0);
  if (!g2.players[0].melds.length) g2.act(0, 'wei');     // 这副牌同时能胡时由玩家选
  assert.equal(g2.players[0].melds[0]?.type, 'wei', '偎（不罚分）');
  assert.deepEqual(g2.scores, [0, 0, 0], '自动 / 主动做正确动作都不罚分');
  // 吃回头牌：上家打贰没吃，第二次打贰再吃 → 罚
  const g3 = setup(pad([B(2), B(2)]), pad([B(1), B(3), B(1), B(3)]), pad([]), () => now, 'ly_tilong');
  g3.act(0, 'discard', { card: B(2) });
  assert.ok(g3.optionsFor(1)!.options.some(o => o.type === 'chi'));
  g3.act(1, 'pass');
  assert.ok(g3.players[1].passedChi.includes(B(2)));
});

test('下家打出的牌：上家不能吃，但能碰 / 跑 / 胡', () => {
  let now = 0;
  // 座位 1 是座位 0 的下家；座位 1 出 玖，座位 0 有两张玖 → 可碰；座位 2 是 1 的下家 → 可吃
  const g = setup(pad([B(9), B(9)]), pad([B(9)]), pad([B(8), B(10)]), () => now);
  g.act(0, 'discard', { card: S(1) });
  // 让座位 1 拿到出牌权：所有人过
  for (let s = 0; s < 3; s++) if (g.optionsFor(s)?.options.some(o => o.type === 'pass')) g.act(s, 'pass');
  // 座位 1 摸牌后打出摸到的牌
  if (g.phase === 'drawer_decide' && g.turn === 1) g.act(1, 'play_drawn');
  if (g.phase === 'claim') for (let s = 0; s < 3; s++) if (g.optionsFor(s)?.options.some(o => o.type === 'pass')) g.act(s, 'pass');
  // 现在座位 2 摸牌… 直接构造：座位 1 出玖
  (g as any).enterDiscard(1);
  assert.equal(g.act(1, 'discard', { card: B(9) }), null);
  const o0 = g.optionsFor(0)!.options.map(o => o.type);
  assert.ok(o0.includes('peng'), '上家可以碰下家打出的牌');
  assert.ok(!o0.includes('chi'), '上家不能吃下家的牌');
  assert.ok(g.optionsFor(2)!.options.some(o => o.type === 'chi'), '下家可以吃');
});

test('有跑必跑：不能胡时自动跑', () => {
  let now = 0;
  const g = setup(pad([B(9)]), pad([B(9), B(9), B(9)]), pad([]), () => now, 'ly_tilong');
  g.act(0, 'discard', { card: B(9) });
  if (!g.players[1].melds.length) {                      // 同时能胡 → 由玩家选
    assert.ok(g.optionsFor(1)!.options.some(o => o.type === 'pao'));
    assert.equal(g.act(1, 'pao'), null);
  }
  assert.equal(g.players[1].melds[0]?.type, 'pao', '跑');
  assert.deepEqual(g.scores, [0, 0, 0], '做了正确动作不罚分');
});

test('别家的碰优先于摸牌者自己的吃', () => {
  let now = 0;
  const game = new Game({ rules: getRules('hy_honghei'), baseScore: 1, dealer: 0, now: () => now });
  // 座位 0 摸到 贰，手里有 壹叁 可以自己吃；座位 1 手里两张 贰 可以碰
  game.players[0].hand = pad([B(1), B(3)]);
  game.players[1].hand = pad([B(2), B(2)]);
  game.players[2].hand = pad([]);
  game.pile = [B(2), S(1), S(3), S(5)];
  (game as any).enterDraw(0);
  assert.equal(game.phase, 'claim', '摸到的牌要给所有人抢');
  assert.ok(game.optionsFor(0)!.options.some(o => o.type === 'chi'), '摸牌者可以吃');
  assert.ok(game.optionsFor(1)!.options.some(o => o.type === 'peng'), '别家可以碰');
  const chi = game.optionsFor(0)!.options.find(o => o.type === 'chi')!;
  assert.equal(game.act(0, 'chi', { combo: chi.combos![0] }), null);
  assert.equal(game.phase, 'claim', '吃要等有碰的人表态');
  assert.equal(game.act(1, 'peng'), null);
  assert.equal(game.players[1].melds[0]?.type, 'peng', '碰赢了吃');
  assert.equal(game.players[0].melds.length, 0);
  assert.equal(game.turn, 1, '碰的人出牌');
});

test('吃牌时被吃的那张排在牌组最上面', () => {
  let now = 0;
  // 座位 0 打出 小二；座位 1 用 一、三 吃
  const g = setup(pad([S(2)]), pad([S(1), S(3)]), pad([]), () => now);
  assert.equal(g.act(0, 'discard', { card: S(2) }), null);
  const chi = g.optionsFor(1)!.options.find(o => o.type === 'chi')!;
  assert.equal(g.act(1, 'chi', { combo: chi.combos![0] }), null);
  now += 3100; g.tick(now);        // 吃要"捂一下"才落地
  const m = g.players[1].melds[0];
  assert.equal(m.type, 'chi');
  assert.equal(m.cards[0], S(2), '来牌（小二）在第一张，显示时排最上面');
});

test('下伙不能拆坎：三个小七 + 小八小十对，吃小九只能下八九十', () => {
  let now = 0;
  const hand1 = pad([S(7), S(7), S(7), S(2), S(10), S(10), S(8), S(8), S(9)]);
  const g = setup(pad([S(9)]), hand1, pad([]), () => now);
  assert.equal(g.act(0, 'discard', { card: S(9) }), null);
  const chi = g.optionsFor(1)!.options.find(o => o.type === 'chi');
  assert.ok(chi, '应当可以吃');
  // 所有给出的吃法都不能拆掉小七的坎
  for (let i = 0; i < chi!.combos!.length; i++) {
    for (const sol of (chi!.comboLays?.[i] ?? [[]])) {
      const used = [...chi!.combos![i], ...sol.flat()];
      const left = 3 - used.filter(k => k === S(7)).length;
      assert.ok(left === 3 || left === 0, `吃法 ${i} 拆了小七的坎，剩 ${left} 张`);
    }
  }
});

test('两家都能吃：都给满 30s，同时计时（快碰慢吃）', () => {
  let now = 0;
  const AV = [S(6), S(5), S(7), B(6)];
  const g = setup(pad([S(5), S(7)], AV), pad([S(5), S(7)], AV), pad([], AV), () => now);
  (g as any).pile = [S(6)];
  (g as any).enterDraw(0);
  const d0 = g.optionsFor(0)?.deadline, d1 = g.optionsFor(1)?.deadline;
  assert.equal(d0, 30000, '摸牌者吃：30s');
  assert.equal(d1, 30000, '下家吃：30s，同时计时');
});

test('回头牌只算自己放弃过的：被别家吃走不算', () => {
  let now = 0;
  const g = setup(pad([S(4), S(4)], []), pad([S(3), S(5)], []), pad([S(3), S(5)], []), () => now);
  g.act(0, 'discard', { card: S(4) });
  g.act(1, 'chi', { combo: [S(3), S(5)] });
  assert.equal(g.players[2].passedChi.length, 0, '没轮到表态就不该记回头牌');
});

test('自己打出去的牌又吃进来 = 吃回头牌违规', () => {
  let now = 0;
  const AV = [S(3), S(5), S(4), B(3), B(5), B(4), S(2), S(7), S(10)];
  const g = setup(pad([S(4), S(3), S(5)], AV), pad([], AV), pad([], AV), () => now);
  g.act(0, 'discard', { card: S(4) });     // 无人要 → 进牌池
  assert.ok(g.players[0].passedChi.includes(S(4)), '自己打出的字要记为回头牌');
  /* 别人再打出同一个字：座位 0 想吃 → 罚分，这一手不算数（牌不给他）。
     只是**不再弹"这张牌退回去了"** —— 本来就没吃进去，说退像是先给了又收走。 */
  const v0 = g.players[0].violations;
  (g as any).offerCard({ card: S(4), from: 2, source: 'discard' });
  const err = g.act(0, 'chi', { combo: [S(3), S(5)] });
  assert.equal(err, null, '不往上报错：罚分那一句已经说清楚了');
  assert.equal(g.players[0].violations, v0 + 1, '吃自己打过的字要算违规');
  const pen = g.events.filter((e: any) => e.t === 'penalty' && e.reason === '吃回头牌');
  assert.equal(pen.length, 1, '罚一次，事件里写明是吃回头牌');
  assert.equal(g.players[0].melds.filter(m => m.type === 'chi').length, 0, '牌没给他');
});

test('碰给满 15s：后面排着的吃有 30s，等得起不用砍半', () => {
  let now = 0;
  const AV = [S(6), S(5), S(7), B(6)];
  // 座位 0 打小六：座位 1（下家）能吃 五六七，座位 2 手里两张小六能碰
  const g = setup(pad([S(6)], AV), pad([S(5), S(7)], AV), pad([S(6), S(6)], AV), () => now);
  g.act(0, 'discard', { card: S(6) });
  const peng = g.optionsFor(2)!, chi = g.optionsFor(1)!;
  assert.ok(peng.options.some(o => o.type === 'peng'));
  assert.ok(chi.options.some(o => o.type === 'chi'));
  assert.equal(peng.fastUntil, 15000, '碰的按钮给满 15s');
  assert.equal(peng.deadline, 30000, '公共牌那圈照常走满一轮，别让人看出有人能碰');
  assert.equal(chi.deadline, 30000, '吃排在后面，给满 30s');
});

test('拆坎不能吃：手里三个大捌，吃小八不能下「八八捌」/「八捌捌」', () => {
  let now = 0;
  const AV = [S(8), B(8), S(6), S(7), B(6), B(7), S(9), S(10), B(9), B(10)];
  // 座位 2 打小八；座位 0 手里 一张小八 + 三张大捌，唯一能成的组都要动大捌的坎 → 不能吃
  const g = setup(pad([S(8), B(8), B(8), B(8)], AV), pad([], AV), pad([], AV), () => now);
  const opts = (g as any).chiCombos(g.players[0], S(8));
  assert.equal(opts.length, 0, '不该给出拆坎的吃法：' + JSON.stringify(opts.map((o: any) => [o.combo, o.extras])));
});

test('坎不参与吃和下伙：手里三个小九时，吃法里绝不会动到这三张', () => {
  const AV = [S(9), S(7), S(8), B(7), B(8), B(9)];
  let now = 0;
  const g = setup(pad([S(7), S(8), S(9), S(9), S(9)], AV), pad([], AV), pad([], AV), () => now);
  const opts = (g as any).chiCombos(g.players[0], S(9));
  for (const o of opts) for (const lay of o.lays) {
    const used = [...o.combo, ...lay.flat()].filter((k: number) => k === S(9)).length;
    assert.equal(used, 0, '小九是坎，吃和下伙都不许动它');
  }
});

test('开跑胡：别人的牌配手里三张开跑，胡时那个字四张 +4 敦，且记为 pao 不是提龙', () => {
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let now = 0; let checked = 0;
  for (let i = 0; i < 600 && checked < 3; i++) {
    const game = new Game({ rules: getRules('hy_honghei'), baseScore: 1, dealer: i % 3, rnd, now: () => now });
    game.start();
    let steps = 0;
    while (!game.ended && steps++ < 2000) {
      let acted = false;
      for (let s = 0; s < game.n; s++) { const d = botDecide(game, s); if (d) { game.act(s, d.type, d); acted = true; break; } }
      if (!acted) { now += 20000; game.tick(now); }
    }
    const hu = game.events.find(e => e.t === 'hu') as any;
    if (!hu || hu.card >= 0) continue;
    assert.ok(['pao', 'ti', 'long', 'wei'].includes(hu.detail.bigMeldType), '要记下是开跑 / 提龙 / 偎');
    const want = hu.detail.bigMeldType === 'wei' ? 3 : 4;
    assert.equal(hu.detail.huCardCount, want, '那个字连下地的张数');
    assert.ok(hu.detail.breakdown.some((b: string) => b.includes(`+ ${want}敦`)), `要加 ${want} 敦`);
    checked++;
  }
  assert.ok(checked > 0, '应当采到提龙 / 开跑胡的样本');
});

test('加敦：胡的那个字手里 + 下地的都算（打出去的不算）', () => {
  let now = 0;
  // 座位 0 碰过一个小五（下地 3 张），手上再摸/吃进一张小五并用它胡 → 加敦要按 4 张算
  const g = setup(pad([S(5)], []), pad([], []), pad([], []), () => now);
  const p = g.players[0];
  p.melds.push({ type: 'chi', cards: [S(5), S(5), B(5)], xi: 0, hidden: false, from: 0 } as any);
  const r = (g as any).computeHu(0, S(5), 0, true, false);
  // 手里 1 张 + 胡进来的那张 + 下地牌组里的 2 张 = 4 张
  assert.equal(r.detail.huCardCount, 4, '手里（含胡的那张）+ 下地的都要算');
});

test('碰过的牌：别人从手里打出的第四张不能开跑，摸出来的可以', () => {
  let now = 0;
  const AV = [S(6), B(6)];
  const mk = () => {
    const g = setup(pad([], AV), pad([], AV), pad([S(6)], AV), () => now);
    g.players[0].melds.push({ type: 'peng', cards: [S(6), S(6), S(6)], xi: 1, hidden: false, from: 2 } as any);
    return g;
  };
  // 从手里打出 → 不能跑
  const g1 = mk();
  const o1 = (g1 as any).claimOptions(0, { card: S(6), from: 2, source: 'discard' });
  assert.ok(!o1.some((o: any) => o.type === 'pao'), '打出来的第四张不能开跑');
  // 从牌堆摸出来 → 可以跑
  const g2 = mk();
  const o2 = (g2 as any).claimOptions(0, { card: S(6), from: 2, source: 'draw' });
  assert.ok(o2.some((o: any) => o.type === 'pao'), '摸出来的第四张可以开跑');
});

test('本局有过违规就不能胡牌', () => {
  let now = 0;
  const hand1 = [B(1), B(1), B(2), B(2), B(3), B(3), S(2), S(7), S(10), B(5), B(5), B(5), S(4), S(4), S(4), B(8), B(8), B(8), S(6), S(6)];
  const g = setup([S(6), S(4), S(4), S(4), S(8), S(8), S(8), B(1), B(1), B(1), B(3), B(3), B(3), B(4), B(4), B(4), B(6), B(6), B(6), S(9)], hand1, pad([]), () => now);
  g.players[1].violations = 1;
  g.act(0, 'discard', { card: S(6) });
  assert.equal(g.ended, false, '违规过的人不能胡');
  assert.equal(g.winner, null);
});

test('胡的那张凑成的三张同字按碰算息，不按坎算', () => {
  let now = 0;
  const g = setup(pad([], []), pad([], []), pad([], []), () => now);
  const p = g.players[0];
  // 手里两张小三 + 壹贰叁；胡进来一张小三 → 三三三 是「碰」(小字 1 息)，不是「坎」(3 息)
  p.hand = [S(3), S(3), B(1), B(2), B(3)];
  const r = (g as any).computeHu(0, S(3), 0, true, false);
  assert.equal(r.detail.xi, 7, '壹贰叁 6 息 + 碰小三 1 息 = 7 息（按坎算会是 9）');
});

test('胡进来凑成的三张大字按碰算：9 息不够 10 息，不能胡', () => {
  let now = 0;
  const g = setup(pad([], []), pad([], []), pad([], []), () => now);
  const p = g.players[0];
  p.hand = [B(1), B(1), S(10), S(9), S(8)];
  p.melds.push({ type: 'chi', cards: [B(6), B(7), B(8)], xi: 6, hidden: false, from: 1 } as any);
  const r = (g as any).computeHu(0, B(1), 1, false, true);
  assert.equal(r.detail.xi, 9, '吃 6 息 + 碰大壹 3 息 + 十九八 0 息 = 9 息（按坎算会错成 12）');
  assert.equal(g.huXiOf(p, B(1)), null, '9 息不到起胡线，不能胡');
});

test('摸牌顺序跟着动作走：谁打的牌没人要，就轮到他的下家摸', () => {
  let now = 0;
  const AV = [B(9), S(9), S(5), S(4), S(6), B(4), B(5), B(6)];
  // 场景一：我(0)打牌 → 上家(2)开跑 → 上家打出的牌没人要 → 轮到我(0)摸牌
  const g = setup(pad([B(9)], AV), pad([], AV), pad([B(9), B(9), B(9)], AV), () => now);
  g.act(0, 'discard', { card: B(9) });
  assert.ok(g.players[2].melds.some(m => m.type === 'pao'), '上家应当开跑');
  assert.equal(g.turn, 2, '跑完轮到上家出牌');
  // 注意：放跑的人（我）本局不能再吃 / 碰，所以这张牌很可能直接没人要 —— 看"下一个摸牌的是谁"
  let n0 = g.events.length;
  g.act(2, 'discard', { card: g.players[2].hand[0] });
  now += 100000; g.tick(now);
  assert.equal((g.events.slice(n0).find(e => e.t === 'draw') as any)?.seat, 0, '上家打的牌没人要 → 轮到他的下家（我）摸牌');

  // 场景二：上家(2)打牌 → 我(0)开跑 → 我打出的牌没人要 → 轮到我的下家(1)摸牌
  now = 0;
  const g2 = setup(pad([B(9), B(9), B(9)], AV), pad([], AV), pad([B(9)], AV), () => now);
  (g2 as any).enterDiscard(2);
  g2.act(2, 'discard', { card: B(9) });
  assert.ok(g2.players[0].melds.some(m => m.type === 'pao'), '我应当开跑');
  assert.equal(g2.turn, 0, '跑完轮到我出牌');
  n0 = g2.events.length;
  g2.act(0, 'discard', { card: g2.players[0].hand[0] });
  now += 100000; g2.tick(now);
  assert.equal((g2.events.slice(n0).find(e => e.t === 'draw') as any)?.seat, 1, '我打的牌没人要 → 轮到我的下家摸牌');
});

test('摸牌顺序：我的牌被下家吃走，他打的牌没人要 → 轮到他的下家（我的上家）摸牌', () => {
  let now = 0;
  const AV = [S(4), S(3), S(5), B(3), B(4), B(5), S(2), S(7), S(10)];
  const g = setup(pad([S(4)], AV), pad([S(3), S(5)], AV), pad([], AV), () => now);
  g.act(0, 'discard', { card: S(4) });
  g.act(1, 'chi', { combo: [S(3), S(5)] });
  now += 3100; g.tick(now);        // 吃要"捂一下"才落地
  assert.equal(g.turn, 1, '吃完轮到下家出牌');
  g.act(1, 'discard', { card: g.players[1].hand[0] });
  now += 100000; g.tick(now);
  assert.equal(g.turn, 2, '他打的牌没人要 → 轮到他的下家（我的上家）摸牌');
});

test('衡阳有胡必胡：胡牌按钮固定 5 秒，到点自动胡', () => {
  let now = 0;
  const hand1 = [B(1), B(1), B(2), B(2), B(3), B(3), S(2), S(7), S(10), B(5), B(5), B(5), S(4), S(4), S(4), B(8), B(8), B(8), S(6), S(6)];
  const g = setup([S(6), S(4), S(4), S(4), S(8), S(8), S(8), B(1), B(1), B(1), B(3), B(3), B(3), B(4), B(4), B(4), B(6), B(6), B(6), S(9)], hand1, pad([]), () => now);
  g.act(0, 'discard', { card: S(6) });
  const o = g.optionsFor(1)!;
  assert.ok(o.options.some(x => x.type === 'hu'));
  /* 胡跟碰各有各的窗口（`huUntil` / `fastUntil`）：
     胡是**固定 5 秒**（必胡，没什么好想的，别让三家干等），碰 / 跑 是读秒的一半。 */
  assert.equal(o.huUntil, 5000, '有胡必胡：胡牌按钮固定 5 秒');
  assert.equal(o.fastUntil, 15000, '碰 / 跑 还是读秒的一半，跟胡那 5 秒各算各的');
  assert.equal(o.deadline, 30000, '公共牌那圈照常走满一轮');
  now = 5001; g.tick(now);
  assert.equal(g.ended, true, '5 秒到点自动胡');
  assert.equal(g.winner, 1);
});

test('一局结束后亮出所有人的手牌和剩下的公共牌', () => {
  let now = 0;
  const hand1 = [B(1), B(1), B(2), B(2), B(3), B(3), S(2), S(7), S(10), B(5), B(5), B(5), S(4), S(4), S(4), B(8), B(8), B(8), S(6), S(6)];
  const g = setup([S(6), S(4), S(4), S(4), S(8), S(8), S(8), B(1), B(1), B(1), B(3), B(3), B(3), B(4), B(4), B(4), B(6), B(6), B(6), S(9)], hand1, pad([]), () => now);
  const before = g.view(0) as any;
  assert.equal(before.players[1].hand, undefined, '进行中看不到别人的手牌');
  assert.equal(before.pileRest, undefined);
  g.act(0, 'discard', { card: S(6) });
  g.act(1, 'hu');
  const after = g.view(0) as any;
  assert.ok(Array.isArray(after.players[1].hand), '结束后能看到别人的手牌');
  assert.ok(Array.isArray(after.pileRest), '结束后能看到剩下的公共牌');
});

test('延时卡：开局一张，到点自动用掉一张续时间；公共牌派出 15 张后再发一张', () => {
  let now = 0;
  const g = new Game({ rules: getRules('hy_honghei'), baseScore: 1, dealer: 0, now: () => now });
  g.start();
  assert.deepEqual(g.delayCards, [1, 1, 1], '开局每人一张');

  // 庄家出牌到点：先自动用掉一张延时卡，行动时间再续 30 秒，牌还没打出去
  now = 30001; g.tick(now);
  assert.equal(g.delayCards[0], 0, '到点自动消耗一张延时卡');
  assert.equal(g.phase, 'discard', '续了时间，还没替他出牌');
  assert.equal(g.players[0].discards.length, 0);

  // 再到点：没卡了，按原来的规则自动出牌
  const before0 = g.players[0].hand.length;
  now = 60002; g.tick(now);
  assert.ok(g.players[0].hand.length < before0 || g.turn !== 0, '没有延时卡了，超时自动出牌');

  // 一直打到公共牌派出 15 张，每人再得一张
  const start = (g.view(0) as any).pileLeft + g.players[0].discards.length;   // 仅用来确认牌堆在消耗
  assert.ok(start > 0);
  for (let i = 0; i < 400 && !g.ended; i++) {
    now += 61000;
    g.tick(now);
    if (g.delayCards.some(c => c > 0)) break;
  }
  assert.ok(g.delayCards.some(c => c > 0), '公共牌派出 15 张之后又发了延时卡');
});

test('判胡不许拆坎：手里三张同字不能留两张来作对', () => {
  // 三三三 + 四五：旧算法会拆成「三四五 + 对三」，现在不认
  const kept = partitionKeepKan([S(3), S(3), S(3), S(4), S(5)], [S(3), S(3), S(3), S(4), S(5)]);
  assert.equal(kept.complete, false, '拆坎凑出来的胡不算胡');
  assert.equal(partition([S(3), S(3), S(3), S(4), S(5)], false).complete, true, '（不带限制时是能凑的）');
  // 三张都用进句子里可以：壹贰叁 × 3
  const ok = partitionKeepKan([B(1), B(1), B(1), B(2), B(2), B(2), B(3), B(3), B(3)], [B(1), B(1), B(1), B(2), B(2), B(2), B(3), B(3), B(3)]);
  assert.equal(ok.complete, true, '坎整组算坎、或三张都进句子都可以');
});

test('胡牌不吃延时卡：有胡必胡到点就自动胡', () => {
  let now = 0;
  const hand1 = [B(1), B(1), B(2), B(2), B(3), B(3), S(2), S(7), S(10), B(5), B(5), B(5), S(4), S(4), S(4), B(8), B(8), B(8), S(6), S(6)];
  const g = setup([S(6), S(4), S(4), S(4), S(8), S(8), S(8), B(1), B(1), B(1), B(3), B(3), B(3), B(4), B(4), B(4), B(6), B(6), B(6), S(9)], hand1, pad([]), () => now);
  g.delayCards = [2, 2, 2];
  g.act(0, 'discard', { card: S(6) });
  now = 5001; g.tick(now);
  assert.equal(g.ended, true, '胡牌到点直接胡，不拿延时卡续命');
  assert.deepEqual(g.delayCards, [2, 2, 2], '延时卡一张没少');
});

test('摸牌者优先：下家先点了吃，也要等摸牌者先表态', () => {
  let now = 0;
  // 座位 1 摸到小二，自己能吃（手里 小一 小三），座位 2 也能吃
  const hand1 = pad([S(1), S(3)], [S(2)]);
  const hand2 = pad([S(1), S(3)], [S(2)]);
  const g = setup([S(2)], hand1, hand2, () => now);
  g.act(0, 'discard', { card: g.players[0].hand[0] });
  // 现在座位 1 摸到小二（牌堆第一张）
  const o1 = g.optionsFor(1);
  const o2 = g.optionsFor(2);
  if (!o1 || !o2) return;                       // 牌型不巧就跳过（补牌是随机的）
  if (!o1.options.some(o => o.type === 'chi') || !o2.options.some(o => o.type === 'chi')) return;
  const combo2 = o2.options.find(o => o.type === 'chi')!.combos![0];
  assert.equal(g.act(2, 'chi', { combo: combo2 }), null, '下家可以先点吃');
  assert.equal(g.ended, false);
  assert.equal(g.players[2].melds.length, 0, '但不能立刻成交：要等摸牌者先表态');
  const combo1 = o1.options.find(o => o.type === 'chi')!.combos![0];
  assert.equal(g.act(1, 'chi', { combo: combo1 }), null);
  assert.equal(g.players[1].melds.length, 1, '摸牌者优先吃到');
  assert.equal(g.players[2].melds.length, 0);
});

test('同一张牌既能碰又能吃：两个按钮都给出来', () => {
  let now = 0;
  // 上家打小二；我手里两张小二（可碰）+ 小七小十（可吃二七十），剩下的两张小二配大贰下伙
  const mine = [S(2), S(2), B(2), S(7), S(10), B(6), B(6), B(6), S(9), S(9), B(9), S(4), S(6), S(5), B(1), B(3), S(1), S(3), S(8), S(8)];
  const g = setup(pad([S(2)]), mine, pad([]), () => now);
  assert.equal(g.act(0, 'discard', { card: S(2) }), null);
  const o = g.optionsFor(1)!;
  const types = o.options.map(x => x.type);
  assert.ok(types.includes('peng'), '能碰');
  const chi = o.options.find(x => x.type === 'chi');
  assert.ok(chi && chi.combos!.length, '也能吃（下伙 二二贰）');
  // 选吃 = 放弃碰
  assert.equal(g.act(1, 'chi', { combo: [S(7), S(10)] }), null);
  now += 2100; g.tick(now);        // 吃要"捂一下"（读秒的 1/15）才落地
  assert.equal(g.players[1].melds.length, 2, '吃 + 下伙一起下地');
});

test('坎不参与吃和下伙：宁可不给吃的按钮', () => {
  let now = 0;
  // 我手里两张小二 + 大贰三张（坎）：吃小二要下伙二二贰，会把贰坎拆掉 → 不能吃
  const mine = [S(2), S(2), B(2), B(2), B(2), S(7), S(10), B(6), B(6), B(6), S(9), S(9), B(9), S(4), S(6), S(5), B(1), S(1), S(3), S(8)];
  const g = setup(pad([S(2)]), mine, pad([]), () => now);
  assert.equal(g.act(0, 'discard', { card: S(2) }), null);
  assert.ok(!g.optionsFor(1)?.options.some(x => x.type === 'chi'), '贰是坎，下伙动不了它 → 不给吃');
  assert.ok(g.act(1, 'chi', { combo: [S(7), S(10)] }), '真发上来也会被拒');
});

test('判胡先把坎提出来：三张大拾不能拆成「贰柒拾」和「十拾拾」', () => {
  const hand = [B(10), B(10), B(10), B(2), B(7), S(10), S(10)];
  const kept = partitionKeepKan(hand, hand);
  assert.equal(kept.complete, false, '拆拾坎凑出来的不算成牌');
  // 坎整组留着、剩下的自己成句才行
  const good = [B(10), B(10), B(10), S(1), S(2), S(3)];
  const r2 = partitionKeepKan(good, good);
  assert.equal(r2.complete, true, '拾坎 + 一二三 可以');
  assert.equal(r2.groups.length, 2);
});

test('坎不参与吃：手里三张小八，上家出大捌，不能用「八八捌」吃', () => {
  let now = 0;
  const mine = pad([S(8), S(8), S(8), S(1), S(3), S(5)], [B(8)]);
  const g = setup(pad([B(8)]), mine, pad([]), () => now);
  assert.equal(g.act(0, 'discard', { card: B(8) }), null);
  const chi = g.optionsFor(1)?.options.find(x => x.type === 'chi');
  const combos = (chi?.combos ?? []).map(c => c.slice().sort().join(','));
  assert.ok(!combos.includes([S(8), S(8)].join(',')), '八八捌 这种吃法不存在');
  assert.ok(!(chi?.comboLays ?? []).flat(3).includes(S(8)), '小八坎也不会被拉去下伙');
});

test('手上出空又胡不了：不会卡死（动作不给选；真到了就黄庄收场）', () => {
  let now = 0;
  const g = new Game({ rules: getRules('hy_honghei'), baseScore: 1, dealer: 0, now: () => now });
  const p = g.players[0];
  p.hand = [];
  p.melds = [{ type: 'peng', cards: [S(1), S(1), S(1)], xi: 1, hidden: false, from: 0 }];
  p.violations = 1;                       // 违规过 → 禁胡
  (g as any).enterDiscard(0);
  assert.equal(g.ended, true, '没牌可出又不能胡 → 黄庄结束，不会卡在出牌阶段');
});

test('碰回头牌：臭牌照样给碰的按钮，点了算违规 —— 罚分、牌不给，但不弹"退回去"', () => {
  let now = 0;
  const AV = [S(6), B(6)];
  // 座位 2 手里两张小六：第一次别人打小六他过了 → 臭牌
  const g = setup(pad([S(6), S(6)], AV), pad([], AV), pad([S(6), S(6)], AV), () => now);
  g.act(0, 'discard', { card: S(6) });
  assert.ok(g.optionsFor(2)?.options.some(o => o.type === 'peng'), '第一次能碰');
  g.act(2, 'pass');
  now += 100000; g.tick(now);
  assert.ok(g.players[2].chou.includes(S(6)), '放弃过的字记成臭牌');
  // 第二次又出现：按钮照给
  (g as any).offerCard({ card: S(6), from: 0, source: 'discard' });
  assert.ok(g.optionsFor(2)?.options.some(o => o.type === 'peng'), '臭牌照样给碰的按钮');
  const v0 = g.players[2].violations;
  const err = g.act(2, 'peng');
  assert.equal(err, null, '不往上报错（不再说"这张牌退回去了"）');
  assert.equal(g.players[2].violations, v0 + 1, '算一次违规');
  assert.ok(g.events.some((e: any) => e.t === 'penalty' && e.reason === '碰回头牌'), '罚分事件写明碰回头牌');
  assert.equal(g.players[2].melds.filter(m => m.type === 'peng').length, 0, '这一手不算数：牌不给他');
  assert.equal(g.huXiOf(g.players[2], null), null, '本局禁胡');
});

test('抢牌窗口按"玩家看到"起算：动画还没放完的那一段要补上', () => {
  let now = 0;
  const AV = [S(6)];
  const g = setup(pad([S(6)], AV), pad([S(5), S(7)], AV), pad([S(6), S(6)], AV), () => now);
  /* 服务端一步算完就往下走，玩家那头还在放前面几帧的动画（下家进张、打牌……）。
     lag = 还剩多少毫秒没放完 —— 窗口得从"他看到这张牌"开始算，
     不然等他看见，圈已经快走完了。 */
  (g as any).lag = 3000;
  g.act(0, 'discard', { card: S(6) });
  const o: any = g.optionsFor(2);
  assert.ok(o.options.some((x: any) => x.type === 'peng'));
  assert.equal(o.fastUntil, 3000 + 15000, '碰的窗口＝动画剩余 + 读秒的一半');
  assert.equal(o.fastSpan, 15000, '给客户端画圈的"这半程有多长"不变');
  assert.equal(o.deadline, 3000 + 30000, '整条 claim 也一样往后挪');
});

test('时限只在开窗口那一刻定一次，之后不再挪', () => {
  let now = 0;
  const AV = [S(6)];
  const g = setup(pad([S(6)], AV), pad([S(5), S(7)], AV), pad([S(6), S(6)], AV), () => now);
  (g as any).lag = 2000;                 // 开窗口那会儿，前面还有 2 秒动画没放完
  g.act(0, 'discard', { card: S(6) });
  const t0 = (g.optionsFor(2) as any).fastUntil;
  assert.equal(t0, 2000 + 15000, '按 lag 补过一次：到点时刻就此定死');
  // 中途 tick 几次（正常流程里不会再有人去挪它）
  now = 3000; g.tick(now);
  now = 6000; g.tick(now);
  assert.equal((g.optionsFor(2) as any).fastUntil, t0, '中途没人再动这个时刻');
  assert.equal((g.optionsFor(2) as any).fastSpan, 15000, '"这半程有多长"也不变，圈才走得匀');
});

test('打牌也用得上延时卡：到点自动用掉一张，从现在起再给一整段', () => {
  let now = 0;
  const AV: number[] = [];
  const g = setup(pad([], AV), pad([], AV), pad([], AV), () => now);
  g.delayCards = [2, 2, 2];
  assert.equal(g.phase, 'discard');
  const span = (g as any).deadlineSpan;
  now = span + 1000; g.tick(now);            // 读秒到点（还多拖了 1 秒）
  assert.equal(g.delayCards[0], 1, '用掉一张');
  assert.equal(g.phase, 'discard', '没有替他把牌打出去');
  assert.equal(g.deadline, now + span, '从现在起再给一整段，不是照着老的到点时刻加');
  assert.ok(g.events.some((e: any) => e.t === 'delay_use' && e.seat === 0));
});

test('既能碰又能吃：碰那半程到点，延时卡把碰的按钮也续回来', () => {
  let now = 0;
  const AV = [S(6), S(5), S(7)];
  // 座位 1 是下家：既吃得起（五 七），手里又有两张小六碰得起
  const g = setup(pad([S(6)], AV), pad([S(5), S(7), S(6), S(6)], AV), pad([], AV), () => now);
  g.delayCards = [2, 2, 2];
  g.act(0, 'discard', { card: S(6) });
  const fast0 = (g.optionsFor(1) as any).fastUntil;
  now = 16000; g.tick(now);                    // 碰那半程（15 秒 + 宽限）到点
  assert.equal(g.delayCards[1], 1, '该用掉一张延时卡');
  const opt = g.optionsFor(1) as any;
  assert.ok(opt.options.some((o: any) => o.type === 'peng'), '碰的按钮要回来，不是只剩吃');
  assert.ok(opt.fastUntil > fast0, '碰那半程续上了');
  assert.ok(opt.deadline >= opt.fastUntil, '整条时限跟着往后，别让圈还在走、这一手已经作废');
  assert.ok(g.events.some((e: any) => e.t === 'delay_use' && e.seat === 1), '发了用卡的事件');
});

test('吃不空等：该等的人都表过态了，吃当场就落地', () => {
  let now = 0;
  const AV = [S(5), S(6), S(7)];
  // 座位 2（上家）碰得起小六，座位 1（下家）吃得起
  const g = setup(pad([S(6)], AV), pad([S(5), S(7)], AV), pad([S(6), S(6)], AV), () => now);
  g.act(0, 'discard', { card: S(6) });
  g.act(2, 'pass');                       // 上家当场点过：优先级空出来了
  now += 50; g.tick(now);
  g.act(1, 'chi', { combo: [S(5), S(7)] });
  now += 50; g.tick(now);
  /* 以前这儿还要再干等一档（那一档是为了不让人从"落地快慢"看出别家有没有牌），
     可上家已经明说过了，等下去只是让下家干坐着。 */
  assert.ok(g.players[1].melds.some(m => m.type === 'chi'), '上家表过态了，吃该当场落地');
});

test('臭牌：碰得起却让别人吃走了，照样记臭牌（下一张再碰就是回头牌）', () => {
  let now = 0;
  const AV = [S(5), S(6), S(7)];
  // 座位 2 手里两张小六（碰得起，但他是上家、吃不了）；座位 1 是下家，手里 五 七，等着吃小六
  const g = setup(pad([S(6)], AV), pad([S(5), S(7)], AV), pad([S(6), S(6)], AV), () => now);
  g.act(0, 'discard', { card: S(6) });
  assert.ok(g.optionsFor(2)?.options.some(o => o.type === 'peng'), '座位 2 碰得起');
  /* 座位 1 当场点吃 → 催场把座位 2 的时限压到抢牌宽限那一档。
     压到的那一刻仲裁就不等他了，可**替他判「过」还要再等一档宽限**——
     中间这一截他的表态是"根本没有"（undefined），以前只认"点了过 / 超时"（null），
     于是这张字没记成臭牌，下一张再碰也就罚不到人了。 */
  g.act(1, 'chi', { combo: [S(5), S(7)] });
  now += g.claimGraceMs(); g.tick(now);
  assert.ok(g.players[2].chou.includes(S(6)), '碰得起却没碰、牌被别人吃走：照样记臭牌');
});

test('摸牌优先级队列：自己摸到第三张同字先偎，偎完再判胡，不能拿它直接配句子胡', () => {
  let now = 0;
  const g = new Game({ rules: getRules('hy_honghei'), baseScore: 1, dealer: 0, now: () => now });
  // 手里两张大叁 + 壹贰（配上摸到的大叁就能凑「壹贰叁」+「叁叁」对来胡），但摸到的大叁必须先偎
  g.players[0].hand = [B(3), B(3), B(1), B(2), S(1), S(2), S(3), S(4), S(5), S(6), B(5), B(5), B(5), S(8)];
  g.players[1].hand = [S(9), S(9), S(9)];
  g.players[2].hand = [S(7), S(7), S(7)];
  g.pile = [B(3), S(10), B(10), S(2)];
  (g as any).enterDraw(0);
  const wei = g.players[0].melds.find(m => m.type === 'wei');
  assert.ok(wei && wei.cards[0] === B(3), '先偎：摸到的第三张大叁跟手里两张一起偎起来');
  assert.equal(g.players[0].hand.filter(k => k === B(3)).length, 0, '手里那两张跟着下地了');
});

test('吃不用捂的两种情况：碰的时限过了、或者外面已经看得见三张', () => {
  let now = 0;
  const AV = [S(6), S(5), S(7), B(6)];
  const g = setup(pad([S(6)], AV), pad([S(5), S(7)], AV), pad([S(6), S(6)], AV), () => now);
  g.act(0, 'discard', { card: S(6) });
  const tc = (g as any).tableCard;
  assert.equal((g as any).chiNoMask(tc), false, '刚打出来、外面也没几张：要捂着');
  now += 15000;                                   // 碰的时限（15s）过了
  assert.equal((g as any).chiNoMask(tc), true, '碰的机会早过了，不用再捂');
  now = 0;
  // 外面已经看得见三张（含桌上这张）→ 谁都不可能手里有两张
  g.players[1].discards.push(S(6));
  g.players[2].discards.push(S(6));
  assert.equal((g as any).chiNoMask(tc), true, '外面看得见三张，碰不起来，不用捂');
});

test('我自己手里就有两张的时候，吃也不用捂（别人碰不起来）', () => {
  let now = 0;
  const AV = [S(6), S(5), S(7)];
  // 座位 1 手里两张小六 + 小五小七：上家打小六，他能碰也能吃
  const g = setup(pad([S(6)], AV), pad([S(6), S(6), S(5), S(7)], AV), pad([], AV), () => now);
  g.act(0, 'discard', { card: S(6) });
  const tc = (g as any).tableCard;
  assert.equal((g as any).chiNoMask(tc), false, '光看外面的牌还是要捂');
  assert.equal((g as any).chiNoMask(tc, 1), true, '算上我手里那两张，外面只剩一张，谁也碰不了 → 不用捂');
});

test('抢牌超时之后再点：给一句"快碰慢吃"的明白话，而不是 invalid action', () => {
  let now = 0;
  const AV = [S(6), B(6)];
  const g = setup(pad([S(6)], AV), pad([], AV), pad([S(6), S(6)], AV), () => now);
  g.act(0, 'discard', { card: S(6) });
  assert.ok(g.optionsFor(2)?.options.some(o => o.type === 'peng'), '座位 2 能碰');
  now += 20000; g.tick(now);                       // 碰的 15 秒过了
  const err = g.act(2, 'peng');
  assert.ok(err && err.includes('快碰慢吃'), '给出超时提示：' + err);
});

test('耒阳无胡：一点胡息都没有、也没有作对的牌，按 21 胡算', () => {
  const g = new Game({ rules: getRules('ly_tilong'), baseScore: 1, dealer: 0 });
  const p = g.players[0];
  // 二贰贰 / 三三叁 / 六七八 / 六七八 / 十十拾：全是零息的句子，没有对子、没有坎
  const full = [S(2), B(2), B(2), S(3), S(3), B(3), S(6), S(7), S(8), S(6), S(7), S(8), S(10), S(10), B(10)];
  p.hand = full.slice(0, full.length - 1);
  assert.equal(g.huXiOf(p, B(10)), 21, '无胡按 21 胡算');
  // 有作对的牌就不算无胡
  const p2 = g.players[1];
  p2.hand = [S(3), S(4), S(5), S(3), S(4), S(5), S(6), S(7), S(8), S(6), S(7), S(9), S(9)];
  assert.equal(g.huXiOf(p2, S(8)), null, '手里还有一对九：不算无胡');
  // 衡阳没有这一条
  const g2 = new Game({ rules: getRules('hy_honghei'), baseScore: 1, dealer: 0 });
  g2.players[0].hand = p.hand.slice();
  assert.equal(g2.huXiOf(g2.players[0], B(10)), null, '衡阳不认无胡');
});

test('碰 / 吃 / 偎 之后手里正好成牌：先问要不要胡，而不是催着出牌', () => {
  let now = 0;
  const g = new Game({ rules: getRules('hy_honghei'), baseScore: 1, dealer: 0, now: () => now });
  const p = g.players[0];
  // 下地：偎拾 + 碰二；手里 壹贰叁 / 五六七 / 叁肆伍 / 柒捌玖 / 九九玖 —— 已经成牌了
  p.hand = [B(1), B(2), B(3), S(5), S(6), S(7), B(3), B(4), B(5), B(7), B(8), B(9), S(9), S(9), B(9)];
  p.melds = [
    { type: 'wei', cards: [B(10), B(10), B(10)], xi: 6, hidden: true, from: 0 },
    { type: 'peng', cards: [S(2), S(2), S(2)], xi: 1, hidden: false, from: 1 },
  ];
  (g as any).enterDiscard(0);
  const o = g.optionsFor(0);
  assert.equal(g.phase, 'drawer_decide', '不是出牌阶段');
  assert.ok(o?.options.some(x => x.type === 'hu'), '把胡牌按钮给出来：' + JSON.stringify(o));
});

test('一张牌有几种胡法时，按分数最高的那条走（先下地再胡 vs 直接胡）', () => {
  for (const [variant, first] of [['ly_tilong', 'auto'], ['hy_honghei', 'auto']] as const) {
    let now = 0;
    const g = new Game({ rules: getRules(variant), baseScore: 1, dealer: 0, now: () => now });
    const p = g.players[0];
    // 已经碰了小六：摸到第四张小六，既能跑、这张牌也正好能胡
    p.melds = [{ type: 'peng', cards: [S(6), S(6), S(6)], xi: 1, hidden: false, from: 1 }];
    p.hand = [B(1), B(2), B(3), B(1), B(2), B(3), S(5), S(7), S(2), S(7), S(10)];
    const opts = (g as any).drawerOpts(0, S(6)) as { type: string; unit?: number }[];
    const direct = (g as any).huOption(g.players[0], S(6), 0, true, false)?.unit ?? -1;
    const after = (g as any).meldThenHuUnit(0, 'pao', S(6));
    // 衡阳有胡必胡：胡排在跑前面，直接胡
    // 耒阳：跑排在胡前面 —— 下完地也能胡就比分数，高的留下；下完地胡不了还是先下地（自摸大叁规则）
    const better = variant === 'hy_honghei' ? 'hu'
      : (after === null || after >= direct ? 'pao' : 'hu');
    assert.equal(opts[0].type, better,
      `${variant}：直接胡 ${direct} 分 / 先跑再胡 ${after} 分，应该走 ${better}，实际 ${opts.map(o => o.type).join('/')}`);
    assert.ok(first === 'auto');
  }
});

test('放跑之后不能再主动进张：打出的牌被别家（桌上摆着偎）开跑，本局不能吃 / 碰', () => {
  let now = 0;
  const AV = [B(9), S(9), S(5), S(4), S(6), B(4), B(5), B(6)];
  const g = setup(pad([B(9), S(3), S(5)], AV), pad([], AV), pad([], AV), () => now);
  // 上家把大玖偎在桌上（看得见），这时候再喂给他第四张才算"放跑"
  (g as any).addMeld(2, { type: 'wei', cards: [B(9), B(9), B(9)], xi: 6, hidden: true, from: 2 }, 2);
  g.act(0, 'discard', { card: B(9) });
  assert.ok(g.players[2].melds.some(m => m.type === 'pao'), '上家应当开跑');
  assert.equal(g.players[0].noTake, true, '放跑的人被记上"不能再进张"');
  // 上家打出 S(4)：我本来能吃（S3 S5 在手），现在不给吃
  g.act(2, 'discard', { card: S(4) });
  const mine = g.optionsFor(0);
  assert.ok(!mine?.options.some(o => o.type === 'chi' || o.type === 'peng'), `不该再有吃 / 碰，实际 ${mine?.options.map(o => o.type).join('/')}`);
});

test('起手多条龙：每多一条就有一次"进张之后不出牌"', () => {
  let now = 0;
  const g = new Game({ rules: getRules('ly_tilong'), baseScore: 1, dealer: 0, now: () => now });
  // 闲家 1 起手两条龙
  const p = g.players[1];
  p.hand = []; p.melds = []; p.longCount = 0;
  const long = [S(9), S(9), S(9), S(9), B(9), B(9), B(9), B(9)];
  p.hand = [...long, S(1), S(4), S(6), B(2), B(5), B(8)];
  // 照发牌那段的逻辑处理起手龙
  for (const k of [S(9), B(9)]) {
    (g as any).removeFromHand(p, k, 4);
    (g as any).addMeld(1, { type: 'long', cards: [k, k, k, k], xi: 9, hidden: true, from: 1 }, 1);
  }
  p.freeDiscards = Math.max(0, p.longCount - 1);
  assert.equal(p.longCount, 2);
  assert.equal(p.freeDiscards, 1, '两条龙 = 一次免出牌');
  // 进张（碰）之后应当直接轮到下家，不用出牌
  g.players[0].hand = [S(7), S(3), S(4), S(5), B(3), B(4), B(5)];
  p.hand = [...p.hand, S(7), S(7)];
  (g as any).enterDiscard(0);
  g.act(0, 'discard', { card: S(7) });
  assert.equal(g.act(1, 'peng'), null, '碰');
  assert.equal(p.freeDiscards, 0, '用掉一次免出牌');
  assert.notEqual(g.turn, 1, '碰完不用出牌，直接轮到下家');
});

test('吃回头牌：自己打出去的字被别家要走了，之后再吃同一个字照样违规（胡不受影响）', () => {
  let now = 0;
  const AV = [S(8), B(8), S(6), S(7), S(9), S(10), B(6), B(7)];
  // 我(0)打出小八 → 下家(1)碰走；之后上家(2)打小八，我吃 → 吃回头牌
  const g = setup(pad([S(8), S(6), S(7)], AV), pad([S(8), S(8)], AV), pad([S(8)], AV), () => now);
  g.act(0, 'discard', { card: S(8) });
  assert.equal(g.act(1, 'peng'), null, '下家碰走');
  assert.ok(g.players[0].passedChi.includes(S(8)), '被别家要走了也记成回头牌');
  const before = g.scores[0];
  (g as any).enterDiscard(2);
  g.act(2, 'discard', { card: S(8) });
  const msg = g.act(0, 'chi', { combo: [S(6), S(7)] });
  assert.equal(msg, null, '不往上报错');
  assert.ok(g.events.some((e: any) => e.t === 'penalty' && e.reason === '吃回头牌'), '罚分事件写明吃回头牌');
  assert.equal(g.players[0].melds.filter(m => m.type === 'chi').length, 0, '牌没给他');
  assert.ok(g.scores[0] < before, '要罚分');
});

test('耒阳弃胡之后进张：不再问第二遍（分数没变高就不给胡）', () => {
  let now = 0;
  const g = new Game({ rules: getRules('ly_tilong'), baseScore: 1, dealer: 0, now: () => now });
  const p = g.players[0];
  p.hand = [B(1), B(2), B(3), S(5), S(6), S(7), B(3), B(4), B(5), B(7), B(8), B(9), S(9), S(9), B(9)];
  p.melds = [
    { type: 'wei', cards: [B(10), B(10), B(10)], xi: 6, hidden: true, from: 0 },
    { type: 'peng', cards: [S(2), S(2), S(2)], xi: 1, hidden: false, from: 1 },
  ];
  (g as any).enterDiscard(0, true);
  assert.equal(g.phase, 'drawer_decide', '第一次要问胡');
  const unit = g.optionsFor(0)!.options.find(o => o.type === 'hu')!.unit!;
  // 弃掉这次胡（点"出牌"）之后，同样的牌型不该再问一遍
  p.declinedUnit = unit;
  (g as any).enterDiscard(0, true);
  assert.equal(g.phase, 'discard', '弃过之后直接出牌，不再问胡');
});

test('吃牌下伙：三叁叁 + 三四五，吃小三要给出两种吃法（三三叁 / 三四五）', () => {
  let now = 0;
  const g = new Game({ rules: getRules('ly_tilong'), baseScore: 1, dealer: 0, now: () => now });
  const p = g.players[0];
  p.hand = [S(3), B(3), B(3), S(3), S(4), S(5), S(8), B(8), S(10), B(10), S(1), B(1), S(6), B(6)];
  const opt = (g as any).chiOption(p, S(3));
  const combos = (opt?.combos ?? []).map((c: number[]) => c.slice().sort((a: number, b: number) => a - b).join(','));
  assert.ok(combos.includes([S(3), B(3)].sort((a, b) => a - b).join(',')), '要有"三叁"这种吃法（吃成 三三叁）');
  assert.ok(combos.includes([S(4), S(5)].sort((a, b) => a - b).join(',')), '要有"四五"这种吃法（吃成 三四五）');
  // 两种吃法各自的下伙都只有一种
  for (const lays of opt.comboLays) assert.equal(lays.length, 1);
});

test('开跑之后问胡：耒阳可以点「过」弃胡继续打牌', () => {
  let now = 0;
  const AV = [B(9), S(9), S(5), S(4), S(6), B(4), B(5), B(6)];
  const g = setup(pad([B(9)], AV), pad([], AV), pad([B(9), B(9), B(9)], AV), () => now, 'ly_tilong');
  g.act(0, 'discard', { card: B(9) });
  assert.ok(g.players[2].melds.some(m => m.type === 'pao'), '上家开跑');
  // 上家跑完轮到他出牌（这副牌胡不了，就直接是出牌阶段）——构造一个"跑完能胡"的局面来验证「过」
  const p = g.players[2];
  p.hand = [B(1), B(2), B(3), S(5), S(6), S(7), B(3), B(4), B(5)];
  (g as any).bigMeldKind = B(9); (g as any).bigMeldType = 'pao';
  const huXi = (g as any).huXiOf(p, null);
  assert.notEqual(huXi, null, '这副牌应当已经成胡');
  assert.equal((g as any).offerSelfHu(2, huXi, 2, false), true);
  const opts = g.optionsFor(2)!.options.map(o => o.type);
  assert.ok(opts.includes('hu') && opts.includes('pass'), `要同时给胡和过：${opts.join('/')}`);
  assert.equal(g.act(2, 'pass'), null, '点过＝弃胡');
  assert.equal(g.phase, 'discard', '弃胡之后继续打牌');
  assert.ok(g.players[2].declinedUnit > 0, '记下弃过的胡');
});

test('回放：开局那副牌 + 每一步生效的决定，就能完整复原一局', () => {
  for (const v of ['hy_honghei', 'ly_tilong'] as const) {
    for (let i = 0; i < 12; i++) {
      let now = 0;
      const g = new Game({ rules: getRules(v), baseScore: 1, dealer: i % 3, now: () => now });
      g.start();
      let guard = 0;
      while (!g.ended && guard++ < 3000) {
        let acted = false;
        for (let s = 0; s < g.players.length; s++) { const d = botDecide(g, s); if (d) { g.act(s, d.type, d); acted = true; break; } }
        if (!acted) { now += 30000; g.tick(now); }
      }
      // 照着回放序列重跑（时钟不走，超时那些已经记成显式动作了）
      const g2 = new Game({ rules: getRules(v), baseScore: 1, dealer: i % 3, now: () => 0, replay: true });
      g2.start(g.deck);
      for (const st of g.replay) { if (g2.ended) break; g2.act(st.s, st.t as any, { card: st.c, combo: st.g, lay: st.l }); }
      assert.equal(g2.ended, g.ended, `第 ${i} 局回放应当同样结束`);
      assert.deepEqual(g2.scores, g.scores, `第 ${i} 局回放的分数应当一致`);
      assert.equal(g2.winner, g.winner);
      assert.ok(JSON.stringify({ d: g.deck, a: g.replay }).length < 4000, '回放序列应当很小');
    }
  }
});

test('吃：二七十 / 八九十 都给按钮；放跑之后（noTake）才不给', () => {
  const S = (r: number) => r - 1, B = (r: number) => 10 + r - 1;
  const g: any = new Game({ rules: getRules('ly_tilong'), baseScore: 1, dealer: 0, now: () => 0 });
  g.start();
  const me = g.players[1];
  me.hand = [S(4), S(4), S(4), S(6), S(7), S(8), B(7), B(8), B(9), S(2), S(8), S(9), B(1), B(1)];
  me.melds = [
    { type: 'chi', cards: [S(10), S(2), S(7)], xi: 3, hidden: false, from: 0 },
    { type: 'wei', cards: [S(5), S(5), S(5)], xi: 3, hidden: true, from: 1 },
  ];
  const tc = { card: S(10), from: 0, source: 'discard', at: 0 };
  const chi = g.claimOptions(1, tc).find((o: any) => o.type === 'chi');
  assert.ok(chi, '手里有二七、八九，上家打小十应当能吃');
  assert.equal(chi.combos.length, 2, '二七 / 八九 两种吃法都要给');
  me.noTake = true;
  assert.ok(!g.claimOptions(1, tc).some((o: any) => o.type === 'chi'), '放跑之后本局不能再吃');
});

test('放跑限制只认"看得见的偎"：手里的坎被跑不禁吃碰', () => {
  const S = (r: number) => r - 1;
  const mk = (fromMeld: boolean) => {
    const g: any = new Game({ rules: getRules('ly_tilong'), baseScore: 1, dealer: 0, now: () => 0 });
    g.start();
    const me = g.players[0], he = g.players[1];
    me.hand = [S(3), S(4), S(5), S(9)];            // 打出去的那张：小九
    he.hand = fromMeld ? [S(1), S(2)] : [S(9), S(9), S(9), S(1), S(2)];
    he.melds = fromMeld ? [{ type: 'wei', cards: [S(9), S(9), S(9)], xi: 3, hidden: true, from: 1 }] : [];
    g.phase = 'discard'; g.turn = 0; g.drawn = null;
    g.act(0, 'discard', { card: S(9) });            // 我打小九
    g.act(1, 'pao', { card: S(9) });                // 他开跑
    return g.players[0].noTake;
  };
  assert.equal(mk(true), true, '桌上摆着偎还喂牌：本局不能再吃碰');
  assert.equal(mk(false), false, '人家手里捂着的坎被跑：不该禁吃碰');
});

test('抢牌等待：有人点了吃，其他人只再给"读秒的 1/10"', () => {
  let now = 0;
  const AV = [S(1), S(2), S(3), S(4), S(5), S(6), B(1), B(2)];
  // 座位 0 打小四：座位 1 能吃（手里三五），座位 2 能碰（手里两张小四）
  const g = setup(pad([S(4), S(1), S(2)], AV), pad([S(3), S(5)], AV), pad([S(4), S(4)], AV), () => now);
  g.act(0, 'discard', { card: S(4) });
  const chi = (g as any).claims.find((c: any) => c.seat === 1);
  const peng = (g as any).claims.find((c: any) => c.seat === 2);
  assert.ok(chi && peng, '一个能吃一个能碰');
  const pengDeadline0 = peng.deadline;
  g.act(1, 'chi', { combo: [S(3), S(5)] });          // 下家先点了吃
  assert.ok(peng.deadline <= now + g.claimGraceMs() + 5, `碰的时限应当被压到抢牌宽限（${g.claimGraceMs()}ms），实际还剩 ${peng.deadline - now}`);
  assert.ok(peng.deadline < pengDeadline0, '应当比原来的碰牌时限短');
  // 压缩之后照样是"快碰慢吃"：这段时间里点碰，碰赢
  now += 1000;
  g.tick(now);
  assert.equal(g.act(2, 'peng', {}), null, '这 3 秒里点碰应当还有效');
  assert.ok(g.players[2].melds.some(m => m.type === 'peng'), '碰优先于吃');
});

test('自己摸上来的牌：下家先点吃也抢不走，摸牌人的吃优先', () => {
  let now = 0;
  const AV = [S(1), S(3), S(5), S(6), S(8), S(9), S(2), S(10), S(7)];
  // 座位 0 手里有二、十（能凑二七十），下家（座位 1）手里有六、八（能凑六七八）
  const g = setup(pad([S(2), S(10)], AV), pad([S(6), S(8)], AV), pad([], AV), () => now);
  (g as any).pile = [S(7), S(1), S(3)];
  (g as any).enterDraw(0);                          // 座位 0 摸到小七
  const mine = (g as any).claims.find((c: any) => c.seat === 0);
  const next = (g as any).claims.find((c: any) => c.seat === 1);
  assert.ok(mine?.options.some((o: any) => o.type === 'chi'), '摸牌人自己能吃');
  assert.ok(next?.options.some((o: any) => o.type === 'chi'), '下家也能吃');
  const myDeadline = mine.deadline;
  g.act(1, 'chi', { combo: [S(6), S(8)] });         // 下家手快先点
  assert.equal(mine.deadline, myDeadline, '摸牌人的时限不该被下家点吃压短');
  now += 5000;                                      // 过了"读秒 1/10"那点时间
  g.tick(now);
  assert.equal(g.act(0, 'chi', { combo: [S(2), S(10)] }), null, '摸牌人这时候点吃还应当有效');
  assert.ok(g.players[0].melds.some(m => m.type === 'chi'), '牌归摸牌人');
  assert.ok(!g.players[1].melds.length, '下家没抢到');
});

test('快碰慢吃：碰的窗口过了按钮就收掉，吃的人接着等满一轮', () => {
  let now = 0;
  const AV = [S(6), B(6)];
  const g = setup(pad([S(6)], AV), pad([S(5), S(7)], AV), pad([S(6), S(6)], AV), () => now);
  g.act(0, 'discard', { card: S(6) });
  const chi0 = g.optionsFor(1)!, peng0 = g.optionsFor(2)!;
  assert.ok(chi0.options.some(o => o.type === 'chi'), '座位 1 能吃');
  assert.equal(chi0.deadline, 30000, '吃：等满一轮读秒');
  assert.ok(!chi0.fastUntil, '吃没有"快"窗口');
  assert.ok(peng0.options.some(o => o.type === 'peng'), '座位 2 能碰');
  assert.equal(peng0.fastUntil, 15000, '碰：读秒的一半');
  now += 16000; g.tick(now);
  assert.ok((g.act(2, 'peng') ?? '').includes('快碰慢吃'), '碰的窗口过了再点要给明白话');
  assert.ok(g.optionsFor(1)?.options.some(o => o.type === 'chi'), '吃还在');
  assert.equal(g.act(1, 'chi', { combo: [S(5), S(7)] }), null, '吃照样生效');
  assert.equal(g.turn, 1);
});

test('庄家多的那一张发牌就亮出来', () => {
  let now = 0;
  const g = new Game({ rules: getRules('hy_honghei'), baseScore: 1, dealer: 0, now: () => now });
  g.start();
  assert.ok(g.dealerCard >= 0, '记下了庄家多出来的那一张');
  const ev = g.events.find(e => e.t === 'dealer_card') as any;
  assert.ok(ev, '发了 dealer_card 事件');
  assert.equal(ev.seat, 0);
  assert.equal(ev.card, g.dealerCard);
});

test('耒阳：庄家亮出来的那张不给别家胡（没有地胡这一问）', () => {
  let now = 0;
  const g = new Game({ rules: getRules('ly_tilong'), baseScore: 1, dealer: 0, now: () => now });
  g.start();
  assert.equal(g.phase, 'discard', '直接让庄家出牌');
  assert.equal(g.turn, 0);
});

test('耒阳举手胡：一张没进过张就胡，胡息翻倍', () => {
  const g = new Game({ rules: getRules('ly_tilong'), baseScore: 1, dealer: 0 });
  const p = g.players[1];
  // 一手成句的牌 + 一张等着凑对的
  p.hand = [S(1), S(2), S(3), B(1), B(2), B(3), S(5), S(6), S(7), B(5), B(6), B(7), S(9), S(9), S(9), B(9), B(9), B(9), S(4)];
  (g as any).dealt = true;
  (g as any).deadPool = [S(8), B(8)];   // 牌局已经走了几轮，不是地胡
  p.acted = true;
  const d: any = (g as any).computeHu(1, S(4), 0, false, true).detail;
  assert.ok(d.raiseHand, '算举手胡');
  assert.ok(d.breakdown.join(' ').includes('举手胡'), '算分说明里写明举手胡');
  p.tookCard = true;
  p.tookCount = 1;
  const d2: any = (g as any).computeHu(1, S(4), 0, false, true).detail;
  assert.ok(!d2.raiseHand, '进过张就不算举手胡');
});

test('快碰慢吃：环走完之后还留一点宽限，踩着最后一下点的碰也认', () => {
  let now = 0;
  const AV = [S(6), B(6)];
  const g = setup(pad([S(6)], AV), pad([S(5), S(7)], AV), pad([S(6), S(6)], AV), () => now);
  g.act(0, 'discard', { card: S(6) });
  const o = g.optionsFor(2)!;
  assert.equal(o.fastUntil, 15000);
  assert.equal(o.fastSpan, 15000, '把"这半程给了多久"也告诉客户端');
  now = 15400; g.tick(now);                      // 环刚走完、还在宽限里
  assert.equal(g.act(2, 'peng'), null, '宽限之内点的碰照样算数');
});

test('快碰慢吃：宽限过了才判"慢了一步"', () => {
  let now = 0;
  const AV = [S(6), B(6)];
  const g = setup(pad([S(6)], AV), pad([S(5), S(7)], AV), pad([S(6), S(6)], AV), () => now);
  g.act(0, 'discard', { card: S(6) });
  now = 16200; g.tick(now);                      // 15000 + 800 的宽限也过了
  assert.ok((g.act(2, 'peng') ?? '').includes('快碰慢吃'));
});

test('开跑胡：刚抢牌超时过，也不该挡住"要不要胡"（整桌卡死的老毛病）', () => {
  let now = 0;
  const AV = [S(6), B(6)];
  const g = setup(pad([S(6)], AV), pad([S(5), S(7)], AV), pad([S(6), S(6)], AV), () => now, 'ly_tilong');
  g.act(0, 'discard', { card: S(6) });
  now = 16200; g.tick(now);                         // 座位 2 没表态：记了一笔"抢牌超时"
  assert.ok((g as any).timedOut.has(2), '确实记了超时');
  assert.ok((g.act(2, 'peng') ?? '').includes('快碰慢吃'), '这时候再去碰确实该挡');
  // 模拟"开跑之后引擎回头问他：胡不胡"
  const p = g.players[2];
  p.hand = [S(1), S(2), S(3), B(1), B(2), B(3), S(5), S(6), S(7), B(5), B(6), B(7), S(9), S(9), S(9), B(9), B(9), B(9), S(4), S(4)];
  p.acted = true;
  const xi = (g as any).huXiOf(p, null);
  assert.notEqual(xi, null, '这手牌本来就成胡');
  assert.equal((g as any).offerSelfHu(2, xi), true, '引擎问了他胡不胡');
  assert.equal(g.act(2, 'hu'), null, '胡得成 —— 以前这里会被"快碰慢吃"挡回去，然后每 200ms 重试一次，整桌卡死');
  assert.ok(g.ended, '这一局结束了');
});

test('每 200ms 打一次 tick（跟服务端一样）：随机有人发呆也不能抛异常', () => {
  // room tick error: Cannot read properties of null (reading 'from') —— 大家都过了之后
  // claims 没清干净，下一跳 resolveClaims 拿 null 的 tableCard 去算 dist
  for (let i = 0; i < 200; i++) {
    let now = 0;
    const g = new Game({ rules: getRules(i % 2 ? 'ly_tilong' : 'hy_honghei'), baseScore: 1, dealer: i % 3, now: () => now });
    g.start();
    for (let step = 0; step < 4000 && !g.ended; step++) {
      for (let s = 0; s < 3; s++) {
        if (Math.random() < 0.4) continue;              // 这一家发呆，等超时
        const d = botDecide(g, s);
        if (d) { g.act(s, d.type, d); break; }
      }
      now += 200;
      assert.doesNotThrow(() => g.tick(now), `第 ${i} 局第 ${step} 跳 tick 抛异常`);
    }
  }
});

test('耒阳：胡牌超时＝弃胡，不替他胡（衡阳才有胡必胡）', () => {
  let now = 0;
  // 座位 1 一副等着胡小四的牌（跟"举手胡"那个用例同一副）；座位 0 打小四
  const hand1 = [S(1), S(2), S(3), B(1), B(2), B(3), S(5), S(6), S(7), B(5), B(6), B(7), S(9), S(9), S(9), B(9), B(9), B(9), S(4)];
  const g = setup(pad([S(4)], [S(4)]), hand1, pad([], [S(4)]), () => now, 'ly_tilong');
  assert.equal(g.act(0, 'discard', { card: S(4) }), null);
  const o = g.optionsFor(1);
  assert.ok(o?.options.some(x => x.type === 'hu'), '给了胡牌按钮');
  now = 40000; g.tick(now);
  assert.ok(!g.ended, '超时不替他胡');
  assert.equal(g.players[1].declinedHu.length, 1, '记一笔弃胡（纪录表里的「贪」）');
  assert.ok(g.players[1].declinedUnit > 0, '放弃过的分数记下来了，下次要胡得更高');
});

test('牌号：一副 80 张，号从发牌起钉死、绝不重号，号对得上牌面', () => {
  for (let i = 0; i < 60; i++) {
    let now = 0;
    const g: any = new Game({ rules: getRules(i % 2 ? 'ly_tilong' : 'hy_honghei'), baseScore: 1, dealer: i % 3, now: () => now });
    g.start();
    for (let step = 0; step < 3000 && !g.ended; step++) {
      let acted = false;
      for (let s = 0; s < 3; s++) { const d = botDecide(g, s); if (d) { g.act(s, d.type, d); acted = true; break; } }
      if (!acted) { now += 30000; g.tick(now); }
    }
    const seen = new Map<number, string>();
    const check = (id: number, kind: number, where: string) => {
      assert.ok(!seen.has(id), `牌号 ${id} 重复了：${where} 跟 ${seen.get(id)}`);
      seen.set(id, where);
      assert.equal(g.deck[id], kind, `${where}：${id} 号应当是 ${g.deck[id]}，却记成了 ${kind}`);
    };
    for (const p of g.players) {
      p.discards.forEach((k: number, j: number) => check(p.discardCids[j], k, `座位${p.seat}的第${j}张弃牌`));
      for (const m of p.melds) (m.cids ?? []).forEach((id: number, j: number) => check(id, m.cards[j], `座位${p.seat}的${m.type}`));
      for (const id of p.ids) check(id, g.deck[id], `座位${p.seat}手里`);
    }
    for (const id of g.pileIds) check(id, g.deck[id], '牌堆');
    // 胡掉的那一张（被人从桌上拿走胡了）不在任何一堆里，允许差这一张
    const missing = [...Array(80).keys()].filter(id => !seen.has(id));
    assert.ok(missing.length <= 1, `牌号只允许差"正被胡掉的那一张"，实际差了 ${missing.length} 张`);
    if (missing.length === 1) assert.equal(g.deck[missing[0]], g.huCard, '差的那一张就是胡的那一张');
  }
});

test('弃胡只记一次：超时之后引擎自己又走了几跳，「贪」不能越数越多', () => {
  let now = 0;
  const hand1 = [S(1), S(2), S(3), B(1), B(2), B(3), S(5), S(6), S(7), B(5), B(6), B(7), S(9), S(9), S(9), B(9), B(9), B(9), S(4)];
  const g = setup(pad([S(4)], [S(4)]), hand1, pad([], [S(4)]), () => now, 'ly_tilong');
  assert.equal(g.act(0, 'discard', { card: S(4) }), null);
  assert.ok(g.optionsFor(1)!.options.some(o => o.type === 'hu'));
  // 一路 tick 到底：快窗口过一次、整条读秒又过一次，中间服务端还会反复调 tick
  for (let i = 0; i < 40; i++) { now += 1000; g.tick(now); }
  assert.equal(g.players[1].declinedHu.length, 1, `弃胡只该记一次，实际 ${g.players[1].declinedHu.length} 次`);
});

test('耒阳举手胡：闲家进的第一张就是胡的那张才算', () => {
  const mk = () => { const g: any = new Game({ rules: getRules('ly_tilong'), baseScore: 1, dealer: 0 }); g.dealt = true; return g; };
  // 一次都没进过张
  const g0 = mk();
  assert.equal(g0.players[1].tookCount, 0);
  // 碰了一次 = 进了一张
  const g1 = mk();
  g1.addMeld(1, { type: 'peng', cards: [S(9), S(9), S(9)], xi: 0, hidden: false, from: 0 }, 0);
  assert.equal(g1.players[1].tookCount, 1, '碰算进张');
  // 自己摸的提也算进张（进的就是那第四张）
  const g2 = mk();
  g2.addMeld(1, { type: 'ti', cards: [S(9), S(9), S(9), S(9)], xi: 0, hidden: true, from: 1 }, 1);
  assert.equal(g2.players[1].tookCount, 1, '提也算进张');
  // 起手龙是发出来的，不算
  const g3: any = new Game({ rules: getRules('ly_tilong'), baseScore: 1, dealer: 0 });
  g3.addMeld(1, { type: 'long', cards: [S(9), S(9), S(9), S(9)], xi: 0, hidden: true, from: 1 }, 1);
  assert.equal(g3.players[1].tookCount, 0, '起手龙不算进张');
});

test('理牌：随便什么牌都不能卡死（曾经 二二三三三肆肆 会原地打转）', async () => {
  const { autoSort, revealCols } = await import('../../../web/src/sort.ts');
  // 就是那一手：坎 + 两个对子。拆对子要扣分，分数成了负的，
  // 而"最好成绩"的初值写的是 -1 —— 所有候选都被挡在门外，一张牌都挑不出来，于是原地打转。
  const bad = [S(2), S(2), S(3), S(3), S(3), B(4), B(4)] as Kind[];
  const t0 = Date.now();
  assert.equal(autoSort(bad).reduce((a, g) => a + g.cards.length, 0), bad.length, '牌一张都不能少');
  assert.ok(Date.now() - t0 < 500, '不能卡住');
  // 再随机来一批：每一手都要在 200ms 内理完、张数对得上
  for (let i = 0; i < 300; i++) {
    const deck = shuffle(fullDeck(), Math.random);
    const n = 2 + Math.floor(Math.random() * 20);
    const hand = deck.slice(0, n);
    const a = Date.now();
    const g = autoSort(hand);
    assert.ok(Date.now() - a < 200, `理牌太慢/卡住了：${hand.join(',')}`);
    assert.equal(g.reduce((x, y) => x + y.cards.length, 0), hand.length, `牌少了：${hand.join(',')}`);
    const c = revealCols(hand);
    assert.equal(c.reduce((x, y) => x + y.length, 0), hand.length, `亮牌牌少了：${hand.join(',')}`);
  }
});

test('衡阳天胡：庄家 21 张就成胡，分数翻倍', () => {
  const g: any = new Game({ rules: getRules('hy_honghei'), baseScore: 1, dealer: 0 });
  const d = g.players[0];
  // 庄家 21 张，整整齐齐七句
  d.hand = [S(1), S(2), S(3), B(1), B(2), B(3), S(5), S(6), S(7), B(5), B(6), B(7),
            S(9), S(9), S(9), B(9), B(9), B(9), S(4), S(4), S(4)];
  g.dealt = true; g.tianHuPossible = true; d.acted = false;
  const hu: any = g.computeHu(0, -1, 0, true, false).detail;
  assert.ok(hu.tianHu, '算天胡');
  assert.ok(hu.breakdown.join(' ').includes('天胡'), '算分说明里写明天胡');
  // 同一手牌，不算天胡的时候敦数要少
  g.tianHuPossible = false;
  const plain: any = g.computeHu(0, -1, 0, true, false).detail;
  assert.ok(!plain.tianHu);
  assert.equal(hu.unit, plain.unit * 2, '衡阳天胡是分数×2，不是胡息翻倍');
  assert.ok(!hu.breakdown.join(' ').includes('胡息'), '衡阳没有胡息翻倍这一说');
});

test('衡阳地胡：闲家起手胡庄家的阳张，分数翻倍', () => {
  let now = 0;
  const g: any = new Game({ rules: getRules('hy_honghei'), baseScore: 1, dealer: 0, now: () => now });
  g.start();
  const c = g.dealerCard;
  // 给闲家 1 摆一副就等这张阳张的牌：其余整句 + 差这一张的一对
  const other = [S(1), S(2), S(3), B(1), B(2), B(3), S(5), S(6), S(7), B(5), B(6), B(7),
                 S(9), S(9), S(9), B(9), B(9), B(9)].filter(k => k !== c);
  g.players[1].hand = [...other.slice(0, 18), c, c];
  g.players[1].acted = false;
  const hu: any = g.computeHu(1, c, 0, false, true).detail;
  // start() 之后 diHuOffer 是不是立着不一定（要看这副牌能不能胡），这里直接把那一问摆上
  g.diHuOffer = true;
  const di: any = g.computeHu(1, c, 0, false, true).detail;
  assert.ok(di.diHu, '胡阳张算地胡');
  assert.ok(di.breakdown.join(' ').includes('地胡'), '算分说明里写明地胡');
  g.diHuOffer = false;
  const plain: any = g.computeHu(1, c, 0, false, true).detail;
  assert.ok(!plain.diHu, '不是那一问就不算地胡');
  assert.equal(di.unit, plain.unit * 2, '衡阳地胡也是分数×2');
  assert.ok(hu !== null);
});

test('衡阳地胡：没人胡阳张就还给庄家，有人胡就当场结算', () => {
  let now = 0;
  const mk = () => {
    const g: any = new Game({ rules: getRules('hy_honghei'), baseScore: 1, dealer: 0, now: () => now });
    g.start();
    return g;
  };
  // ① 没人胡：那张牌还回庄家手里，庄家照常出牌（不进弃牌堆）
  const g0 = mk();
  /* 阳张**钉死**，别跟着洗牌走。
     以前这里用的是随机发到的那张：撞上「小十」的时候，
     [小一 小一 大拾 大拾] + 小十 会被判成能胡（大小写同号那几张在**只剩四张手牌**这种
     凑出来的局面下会算成一句）—— 真实牌局里手上永远是二十张，碰不到这个边界，
     但测试就这么隔三差五红一次。钉死阳张，这一条就只测它该测的那件事。 */
  g0.dealerCard = S(5);
  for (let s = 1; s < 3; s++) g0.players[s].hand = [S(1), S(1), B(10), B(10)];
  g0.phase = 'init'; g0.tableCard = null; g0.claims = []; g0.diHuOffer = false;
  assert.equal(g0.offerDiHu(), false, '没人胡得了这张，就别问了');
  assert.equal(g0.diHuOffer, false, '牌子要摘干净');

  // ② 有人胡：问一圈，到点自动胡（衡阳有胡必胡），结算里记着地胡
  const g1 = mk();
  g1.dealerCard = S(4);          // 同样钉死，别看运气
  const c = g1.dealerCard;
  const other = [S(1), S(2), S(3), B(1), B(2), B(3), S(5), S(6), S(7), B(5), B(6), B(7),
                 S(9), S(9), S(9), B(9), B(9), B(9)].filter((k: number) => k !== c);
  g1.players[1].hand = [...other.slice(0, 18), c, c];
  g1.players[1].acted = false;
  g1.players[2].hand = [S(4), S(4), B(4), B(4)].filter((k: number) => k !== c);
  g1.phase = 'init'; g1.tableCard = null; g1.claims = []; g1.diHuOffer = false;
  assert.equal(g1.offerDiHu(), true, '有人胡得了就得问');
  assert.equal(g1.phase, 'claim');
  now += 10000; g1.tick(now);   // 地胡那一问也是那 5 秒
  assert.ok(g1.ended, '到点自动胡，当场结算');
  assert.equal(g1.winner, 1);
  const ev = g1.events.find((e: any) => e.t === 'hu') as any;
  assert.ok(ev.detail.diHu, '结算里记着地胡');
  assert.ok(ev.detail.breakdown.join(' ').includes('地胡'), '算分说明里写明地胡');
});

test('理牌：2/2 不硬凑成 3/1，对子不许拆（除非那三张真能成一句）', async () => {
  const { autoSort } = await import('../../../web/src/sort.ts');
  const shape = (h: Kind[]) => autoSort(h).map(g => g.cards.slice().sort((a, b) => a - b).join('-')).sort().join(' | ');
  // 两对：就该摆成两组对子，不能变成"三张 + 一张"
  const two = autoSort([S(2), S(2), S(5), S(5)] as Kind[]);
  assert.ok(two.every(g => g.cards.length === 2), `两对要摆成 2/2：${JSON.stringify(two.map(g => g.cards))}`);
  // 三对也一样，摆成三组
  const three = autoSort([S(2), S(2), S(5), S(5), S(8), S(8)] as Kind[]);
  assert.ok(three.every(g => g.cards.length === 2), `三对要摆成 2/2/2：${JSON.stringify(three.map(g => g.cards))}`);
  // 那三张真能成一句的时候，还是要凑成句（一二三 摆一组，剩下的对子不动）
  assert.ok(shape([S(1), S(2), S(3), S(5), S(5)] as Kind[]).includes('0-1-2'), '一二三 要摆成一句');
});

test('理牌：最多 8 组、一组最多 4 张、不留单张、坎不拆', async () => {
  const { autoSort, sentXi: sentXi3 } = await import('../../../web/src/sort.ts');
  const kanOf = (g: any) => g.cards.length >= 3 && new Set(g.cards).size === 1;
  const check = (hand: Kind[], why: string) => {
    const gs = autoSort(hand);
    const flat = gs.flatMap(g => g.cards);
    assert.equal(flat.length, hand.length, `${why}：牌少了 ${hand.join(',')}`);
    assert.ok(gs.length <= 8, `${why}：${gs.length} 组，超过 8 组`);
    for (const g of gs) assert.ok(g.cards.length <= 4, `${why}：一组 ${g.cards.length} 张，超过 4 张`);
    /* 不留单张。两个例外，都是"拆了更难看"：
       1) 除它以外全是坎 —— 「二二二 + 八」，坎不能拆，也不该把闲牌掺进坎里；
       2) 除它以外全是**成了的句子** —— 「贰柒拾 + 小四」，为了不留单张去拆散一个句子不值当，
          （一组塞四张更不行：四张挤一列，谁也认不出里头是什么。） */
    const sent3 = (g: any) => g.cards.length === 3 && sentXi3(g.cards) >= 0;
    const onlyKans = gs.filter(g => g.cards.length !== 1).every(g => kanOf(g) || sent3(g));
    if (hand.length >= 2 && !onlyKans) {
      assert.ok(!gs.some(g => g.cards.length === 1), `${why}：留了单张 ${JSON.stringify(gs.map(g => g.cards))}`);
    }
    assert.ok(gs.filter(g => g.cards.length === 1).length <= 1, `${why}：单张不能超过一组`);
    // 坎不拆：手里凑得出几个坎，理完就得有几个坎
    const kanKinds = [...new Set(hand)].filter(k => hand.filter(x => x === k).length >= 3);
    for (const k of kanKinds) {
      assert.ok(gs.some(g => kanOf(g) && g.cards[0] === k), `${why}：坎被拆了（${k}）`);
    }
    return gs;
  };
  check([S(2), S(2), S(3), S(3), S(3), B(4), B(4)] as Kind[], '坎 + 两对');
  check([S(1), S(1), S(1), B(1), B(1), B(1), S(5), S(6), S(7), B(9), B(9), B(10)] as Kind[], '两个坎');
  check([S(9), S(9), S(3), S(5), S(6), B(2), B(7), B(10), S(1), S(2), S(3)] as Kind[], '零碎一手');
  // 随机压一批：300 手，每手都得守规矩、200ms 内理完
  for (let i = 0; i < 300; i++) {
    const deck = shuffle(fullDeck(), Math.random);
    const hand = deck.slice(0, 2 + Math.floor(Math.random() * 20));
    const t0 = Date.now();
    check(hand, '随机');
    assert.ok(Date.now() - t0 < 200, `理牌太慢：${hand.join(',')}`);
  }
});

test('理牌：耒阳没下地又一点息都没有，按无胡的路子理（不留对子）', async () => {
  const { autoSort } = await import('../../../web/src/sort.ts');
  // 肆伍陆 捌玖拾 都是零息的顺子，外加一对小四 —— 奔无胡就该把对子拆开、顺子码好
  const hand = [S(4), S(5), S(6), B(8), B(9), B(10), S(4), S(8)] as Kind[];
  const noXi = autoSort(hand, { leiyang: true, hasMeld: false });
  const has = (g: any[], c: Kind[]) => g.some(x => sortNums(x.cards).join(',') === sortNums(c).join(','));
  assert.ok(has(noXi, [S(4), S(5), S(6)]), `零息顺子要码出来：${JSON.stringify(noXi.map(g => g.cards))}`);
  assert.ok(has(noXi, [B(8), B(9), B(10)]), `零息顺子要码出来：${JSON.stringify(noXi.map(g => g.cards))}`);
  // 下过地了就不是无胡了：照常按有息的路子理，牌一张不能少
  const normal = autoSort(hand, { leiyang: true, hasMeld: true });
  assert.equal(normal.flatMap(g => g.cards).length, hand.length);
});

function sortNums(c: number[]) { return c.slice().sort((a, b) => a - b); }

test('耒阳：一动没动就胡，算的是「举手」，不叫地胡（只翻一次）', () => {
  const g: any = new Game({ rules: getRules('ly_tilong'), baseScore: 1, dealer: 0 });
  const p = g.players[1];
  p.hand = [S(1), S(2), S(3), B(1), B(2), B(3), S(5), S(6), S(7), B(5), B(6), B(7), S(9), S(9), S(9), B(9), B(9), B(9), S(4)];
  g.dealt = true;
  g.deadPool = [S(8)];         // 庄家刚打出第一张，闲家一动没动
  p.acted = false;
  const d: any = g.computeHu(1, S(4), 0, false, true).detail;
  assert.equal(d.diHu, false, '耒阳没有"地胡"这个名目');
  assert.ok(d.raiseHand, '算举手');
  const line = d.breakdown.join(' ');
  assert.ok(line.includes('举手胡'), '算分说明写举手胡');
  assert.ok(!line.includes('地胡'), '别再写地胡');
  // 翻倍只翻一次：跟"普通举手胡"的分一模一样
  const g2: any = new Game({ rules: getRules('ly_tilong'), baseScore: 1, dealer: 0 });
  const p2 = g2.players[1];
  p2.hand = p.hand.slice();
  g2.dealt = true; g2.deadPool = [S(8), B(8), S(3), B(3)]; p2.acted = true;
  const d2: any = g2.computeHu(1, S(4), 0, false, true).detail;
  assert.ok(d2.raiseHand, '牌局走了几轮、但一张没进过，照样算举手');
  assert.equal(d.unit, d2.unit, '举手只翻一次，不会因为"又是地胡"再翻一次');
});

test('快照要是拷贝：引擎往前走，早先拍的 view() 一个字都不许变', () => {
  // 这就是"牌还在一轮一轮地摸，我手里的两张却凭空少了"的根子：
  // 服务端把快照存进待播的帧里、隔几百毫秒才发，而 view() 以前直接把引擎里的数组递出去，
  // 引擎接着偎 / 提 / 打牌，就把早就拍好的那些帧一起改了。
  for (let round = 0; round < 20; round++) {
    let now = 0;
    const g = new Game({ rules: getRules(round % 2 ? 'ly_tilong' : 'hy_honghei'), baseScore: 1, dealer: 0, now: () => now });
    g.start();
    const snaps: { v: any; s: string }[] = [];
    const shoot = () => {
      for (let seat = 0; seat < 3; seat++) { const v = g.view(seat); snaps.push({ v, s: JSON.stringify(v) }); }
      const v = g.view(null); snaps.push({ v, s: JSON.stringify(v) });
    };
    shoot();
    for (let step = 0; step < 120 && !g.ended; step++) {
      now += 500;
      let moved = false;
      for (let seat = 0; seat < 3; seat++) {
        const d = botDecide(g, seat);
        if (!d) continue;
        g.act(seat, d.type, d);
        moved = true;
        shoot();
      }
      if (!moved) { now += 40000; g.tick(now); shoot(); }
    }
    for (const { v, s } of snaps) assert.equal(JSON.stringify(v), s, '早先拍的快照被引擎改掉了');
  }
});

test('昵称：四个字排得下，表情包不许截成半个', async () => {
  const { avatarText, clampNick, chars } = await import('../../../web/src/nick.ts');
  assert.equal(chars('细妹子🌸').length, 4, '表情算一个字');
  assert.equal(avatarText('老李', 4), '老李');
  assert.equal(avatarText('衡阳老倌', 4), '衡阳老倌', '四个字整个写进头像框');
  assert.equal(avatarText('衡阳老倌', 2), '衡阳', '窄框写前两个字');
  assert.equal(avatarText('细妹子🌸', 2), '🌸', '放不下就拿表情当头像');
  assert.equal(avatarText('🐉', 2), '🐉');
  assert.equal(clampNick(' 刘大满哥哥 ', 4), '刘大满哥');
  assert.equal(clampNick('阿英😀好吗', 4), '阿英😀好', '表情占一个字，且不会被截半');
  assert.equal([...clampNick('👨‍👩‍👧', 4)].length <= 4, true, '组合表情也不会炸');
});

test('freshHold：这一步的动画排完之后，把刚开的窗口一次挪到"玩家看到"那一刻', () => {
  let now = 0;
  const AV = [S(6)];
  const g = setup(pad([S(6)], AV), pad([S(5), S(7)], AV), pad([S(6), S(6)], AV), () => now);
  /* 开窗口那会儿服务端只知道**上一批**还没播完多久（lag）；
     这一步自己要播多久（牌飞出去、报牌），得等帧排完才算得出来。
     freshHold 就是把差的那一截一次补上。 */
  (g as any).lag = 1000;
  g.act(0, 'discard', { card: S(6) });
  const before: any = g.optionsFor(2);
  assert.equal(before.fastUntil, 1000 + 15000);

  g.freshHold(800);                    // 这一步自己的动画还要 800ms 才播到
  const after: any = g.optionsFor(2);
  assert.equal(after.fastUntil, 1800 + 15000, '刚开的窗口整体往后挪');
  assert.equal(after.fastSpan, 15000, '"这半程有多长"不变 —— 圈还是走满一整段');

  // 只补一次：标记已经清掉了，再调一次不会叠加
  g.freshHold(800);
  assert.equal((g.optionsFor(2) as any).fastUntil, 1800 + 15000, '同一个窗口不补第二遍');

  // 已经在走的窗口，后面那一步的动画不该再推它
  now = 3000;
  g.freshHold(500);
  assert.equal((g.optionsFor(2) as any).fastUntil, 1800 + 15000, '不是 fresh 的一概不动');
});

test('freshHold 补的量有上限：再离谱的动画也不能把窗口拖成无限长', () => {
  let now = 0;
  const AV = [S(6)];
  const g = setup(pad([S(6)], AV), pad([S(5), S(7)], AV), pad([S(6), S(6)], AV), () => now);
  g.act(0, 'discard', { card: S(6) });
  g.freshHold(60000);
  assert.equal((g.optionsFor(2) as any).fastUntil, 8000 + 15000, '最多补 8 秒');
});

test('点了吃、前面还有人没表态：这一手先记下来排队，不是白点', () => {
  let now = 0;
  const AV = [S(6)];
  // 座 0 打出 陆，座 1（下家）能吃 5-6-7，座 2 手里两张 陆 能碰（优先级比吃高）
  const g = setup(pad([S(6)], AV), pad([S(5), S(7)], AV), pad([S(6), S(6)], AV), () => now);
  g.act(0, 'discard', { card: S(6) });
  assert.ok((g.optionsFor(1) as any)?.options.some((x: any) => x.type === 'chi'), '座 1 看得到吃');
  assert.ok((g.optionsFor(2) as any)?.options.some((x: any) => x.type === 'peng'), '座 2 看得到碰');

  assert.equal(g.act(1, 'chi', { combo: [S(5), S(7)] }), null, '点吃不报错：这一手记下了');
  const v1: any = g.view(1);
  assert.equal(v1.myOptions, null, '轮不到我了，服务端不再给我选项');
  assert.equal(v1.myWaiting, true, '正在等别家表态');
  assert.equal(v1.myDecided, 'chi', '记着我点的是吃 —— 界面靠它把那个按钮留在屏幕上等结果');
  assert.equal(g.phase, 'claim', '牌局还停在抢牌阶段，等座 2 说话');

  // 座 2 放行 → 吃成立
  g.act(2, 'pass');
  assert.equal(g.players[1].melds.filter(m => m.type === 'chi').length, 1, '别家一放行，这张牌就吃进来了');
});

test('点了吃、但被优先级更高的人碰走：吃不成，牌归他，我这边回到原样', () => {
  let now = 0;
  const AV = [S(6)];
  const g = setup(pad([S(6)], AV), pad([S(5), S(7)], AV), pad([S(6), S(6)], AV), () => now);
  g.act(0, 'discard', { card: S(6) });
  assert.equal(g.act(1, 'chi', { combo: [S(5), S(7)] }), null);
  g.act(2, 'peng');
  assert.equal(g.players[2].melds.filter(m => m.type === 'peng').length, 1, '碰的优先级高，牌给他');
  assert.equal(g.players[1].melds.length, 0, '我没吃到，手牌一张没动');
  assert.equal(g.view(1).myWaiting, false, '不用再等了');
});

/* 红点那个记号：牌面上要分得清「我从手里打出去的」和「我摸上来亮在桌上的」。
   规则是这样：手里打出去的，谁要走都算我喂的；摸上来那张被吃才算，被碰被跑不算。
   引擎这边只管把事实记清楚 —— 哪一张是从别家来的（fromCid）、那一张当初是不是摸的（fromDrawn）。 */
test('下地牌记得住：从别家要来的是哪一张、那张是他打出来的还是摸出来的', () => {
  let now = 0;
  const AV = [S(6), B(6)];
  // ① 0 家从手里打出小六，2 家碰走 —— 是"打出去的"，没有 fromDrawn
  {
    const g = setup(pad([S(6)], AV), pad([], AV), pad([S(6), S(6)], AV), () => now);
    g.act(0, 'discard', { card: S(6) });
    g.act(2, 'peng', {});
    const m = g.players[2].melds.find(x => x.type === 'peng')!;
    assert.ok(m, '碰成了');
    assert.equal(m.from, 0, '这一组是拿 0 家的牌凑的');
    assert.ok(m.fromCid !== undefined && m.cids!.includes(m.fromCid), '记下了是哪一张');
    assert.equal(m.fromDrawn, undefined, '他是从手里打出去的，不是摸出来的');
  }
  // ② 0 家摸上来一张小六（自己用不上）亮在桌上，2 家碰走 —— 这一张是"摸出来的"
  {
    const g = setup(pad([], AV), pad([], AV), pad([S(6), S(6)], AV), () => now);
    g.pile = [S(6)];
    (g as any).enterDraw(0);
    g.act(2, 'peng', {});
    const m = g.players[2].melds.find(x => x.type === 'peng')!;
    assert.ok(m, '碰成了');
    assert.equal(m.from, 0);
    assert.equal(m.fromDrawn, true, '这一张是他摸上来亮在桌上的');
  }
});

/* ---------- 摸牌：谁也要不起时，下家那个"看不见的过牌按钮" ---------- */

test('摸出来的牌没人要得起：照样等下家那 3 秒，界面上不给他任何按钮', () => {
  let now = 0;
  const AV = [S(3)];
  // 0 家摸一张小三：1、2 两家都要不起（手里凑不出、也没同字）
  const g = setup(pad([], AV), pad([], AV), pad([], AV), () => now);
  // 三家手里都是大字散牌：小三这一张谁也凑不上（吃、碰、偎、提、跑、胡全都够不着）
  for (const p of g.players) p.hand = [B(1), B(4), B(6), B(8)];
  g.pile = [S(3)];
  (g as any).enterDraw(0);
  assert.equal(g.phase, 'claim', '摸出来的牌要摆上桌等一轮，不能当场就死');
  const ghost = (g.claims as any[]).filter(c => c.ghost);
  assert.equal(ghost.length, 1, '给下家挂了一条影子表态');
  assert.equal(ghost[0].seat, 1, '影子表态挂在摸牌者的下家身上');
  assert.equal(g.optionsFor(1), null, '虚拟按钮不显示：下家那儿一个选项都没有');
  // 公开的那圈倒计时照常是满一轮读秒 —— 压成 3 秒就等于告诉全桌"这张没人要得起"
  assert.equal(g.deadline - now, g.rules.timers.claimChi, '桌面那圈倒计时长度跟"有人要得起"时一模一样');

  now = 2000; g.tick(now);
  assert.equal(g.phase, 'claim', '不到 3 秒不许推进');
  now = 3100; g.tick(now);
  assert.ok(g.events.some(e => e.t === 'dead'), '3 秒到了这张牌才进牌池');
});

test('影子表态不吃延时卡、也不发「过」的播报', () => {
  let now = 0;
  const g = setup(pad([]), pad([]), pad([]), () => now);
  for (const p of g.players) p.hand = [B(1), B(4), B(6), B(8)];
  g.delayCards = [3, 3, 3];
  g.pile = [S(3)];
  (g as any).enterDraw(0);
  now = 5000; g.tick(now);
  assert.deepEqual(g.delayCards, [3, 3, 3], '虚拟按钮不该把人家的延时卡烧掉');
  assert.ok(!g.events.some(e => e.t === 'pass' && (e as any).seat === 1), '也不该报一声「过」—— 他压根没有按钮');
});

/* ---------- 碰也能用延时卡 ---------- */

test('碰那半程到点：手里有延时卡就续一次，按碰自己原来的读秒', () => {
  let now = 0;
  const AV = [S(6)];
  // 座位 2 只碰得起（吃不了：吃只能吃上家，2 家的上家是 1）
  const g = setup(pad([S(6)], AV), pad([], AV), pad([S(6), S(6)], AV), () => now);
  g.delayCards = [2, 2, 2];
  g.act(0, 'discard', { card: S(6) });
  const fast0 = (g.optionsFor(2) as any).fastUntil;
  assert.equal(fast0 - now, g.rules.timers.claimPeng, '碰先给半程读秒');
  now = 16500; g.tick(now);   // 半程 15 秒 + 那点宽限
  assert.equal(g.delayCards[2], 1, '到点自动用掉一张延时卡');
  const fast1 = (g.optionsFor(2) as any).fastUntil;
  assert.ok(fast1 > fast0, '碰的窗口续上了，不是直接判过');
  assert.ok(fast1 - now >= g.rules.timers.claimPeng - 200, '续的就是碰自己那半程的时长');
  assert.ok(g.events.some(e => e.t === 'delay_use' && (e as any).seat === 2), '发了用卡的事件');
});

test('下家一吃就把我催到 3 秒：碰那半程到点，延时卡照样要用掉', () => {
  let now = 0;
  const AV = [B(9), B(8), B(10)];
  // 0 打出大玖；1 是 0 的下家，吃得起；2 手里两张大玖，碰得起（碰比吃大，本该等他表态）
  const g = setup(pad([B(9)], AV), pad([B(8), B(10)], AV), pad([B(9), B(9)], AV), () => now);
  g.delayCards = [1, 1, 1];
  assert.equal(g.act(0, 'discard', { card: B(9) }), null);
  // 下家立刻点吃 —— hurryOthers 把座位 2 的窗口压到"读秒的 1/10"
  assert.equal(g.act(1, 'chi', { combo: [B(8), B(10)] }), null);
  const cut = (g.optionsFor(2) as any).fastUntil;
  assert.ok(cut - now <= g.claimGraceMs() + 50, '被催短了');
  now = cut; g.tick(now);
  assert.equal(g.delayCards[2], 0, '压短了也得用卡：以前这儿卡一张没少，牌直接被吃走');
  assert.equal(g.phase, 'claim', '还在等他碰，吃没落地');
  const o = g.optionsFor(2) as any;
  assert.ok(o.options.some((x: any) => x.type === 'peng'), '碰的按钮回来了');
  assert.ok(o.fastUntil - now >= g.rules.timers.claimPeng - 200,
    '续的是碰原本那半程，不是被催短之后剩下的那一点');
  assert.ok(g.events.some((e: any) => e.t === 'delay_use' && e.seat === 2));
  // 卡用完了，再到点才轮到吃
  now = o.fastUntil + 1000; g.tick(now);
  assert.equal(g.delayCards[2], 0);
});

/* ---------- 收牌 / 接着洗 ---------- */

test('收牌：一局打完照样收得齐 80 张；接着洗留得住上一局的牌形', () => {
  for (const v of ['hy_honghei', 'ly_tilong'] as const) {
    let now = 0;
    const g = new Game({ rules: getRules(v), baseScore: 1, dealer: 0, now: () => now });
    g.start();
    let guard = 0;
    while (!g.ended && guard++ < 3000) {
      let acted = false;
      for (let s = 0; s < g.players.length; s++) { const d = botDecide(g, s); if (d) { g.act(s, d.type, d); acted = true; break; } }
      if (!acted) { now += 40000; g.tick(now); }
    }
    const got = g.collect();
    assert.equal(got.length, 80, `${v}：收上来应当正好 80 张`);
    const cnt = new Array(20).fill(0);
    for (const k of got) cnt[k]++;
    assert.ok(cnt.every(c => c === 4), `${v}：每个字各 4 张`);
    // 拿它开下一局：发得出牌、张数对得上
    const g2 = new Game({ rules: getRules(v), baseScore: 1, dealer: 1, now: () => 0 });
    g2.start(riffleShuffle(got, Math.random, 3));
    const total = g2.players.reduce((a, p) => a + p.hand.length + p.melds.reduce((b, m) => b + m.cards.length, 0), 0) + g2.pile.length + (g2.drawn === null ? 0 : 1);
    assert.equal(total, 80, `${v}：接着洗之后开局，牌一张不多一张不少`);
  }
});

test('接着洗：不是均匀随机 —— 上一局的相邻牌形留得下来', () => {
  // 一副"整整齐齐"的牌（每个字四张挨着）：真人洗几把之后还看得出成堆，完全随机就打散了
  const tidy: Kind[] = [];
  for (let k = 0; k < 20; k++) for (let i = 0; i < 4; i++) tidy.push(k);
  const adj = (a: Kind[]) => { let n = 0; for (let i = 1; i < a.length; i++) if (a[i] === a[i - 1]) n++; return n; };
  let riffleAdj = 0, randAdj = 0;
  for (let i = 0; i < 40; i++) { riffleAdj += adj(riffleShuffle(tidy)); randAdj += adj(shuffle(tidy)); }
  assert.ok(riffleAdj / 40 > randAdj / 40 + 1,
    `接着洗应当比完全随机留下更多相邻同字（实测 ${(riffleAdj / 40).toFixed(1)} vs ${(randAdj / 40).toFixed(1)}）`);
  // 但也不能"没洗"：80 张全挨着是 60 对，搓三把之后该散开不少
  assert.ok(riffleAdj / 40 < 40, '也不能等于没洗');
});

test('有跑必跑：引擎当场就替他跑，不该被"影子表态"那几秒挡着', () => {
  let now = 0;
  const AV = [S(6)];
  const g = setup(pad([], AV), pad([], AV), pad([], AV), () => now, 'ly_tilong');
  // 2 家碰过小六、摆在桌上；0 家从牌堆摸出第四张小六 → 2 家必跑（碰过的牌只有摸出来的第四张能开跑）
  g.players[0].hand = [B(1), B(4), B(6), B(8)];
  g.players[1].hand = [B(2), B(5), B(9), B(3)];   // 下家什么也要不起 → 会给他挂一条影子表态
  g.players[2].hand = [B(1), B(4), B(6), B(8)];
  g.players[2].melds = [{ type: 'peng', cards: [S(6), S(6), S(6)], xi: 0, hidden: false, from: 1, cids: [1, 2, 3] } as any];
  g.pile = [S(6), S(1), S(2), S(3)];
  (g as any).enterDraw(0);
  assert.ok(g.players[2].melds.some(m => m.type === 'pao'),
    '真有人要得起这张牌，就不该被下家那条影子表态压着等 —— 该当场就跑');
});

test('点胡走分高的那条路：能开跑就别把那一坎拆去配句子', () => {
  let now = 0;
  const AV = [B(8), S(8)];
  const g: any = setup(pad([B(8)], AV), pad([], AV), pad([], AV), () => now);
  // 1 家：三个大捌 + 一对小八，其余凑成整句（一二三 ×N），只差第四张大捌
  g.players[1].hand = [B(8), B(8), B(8), S(8), S(8),
    S(1), S(2), S(3), B(1), B(2), B(3), S(1), S(2), S(3), B(1), B(2), B(3), S(4), S(5), S(6)];
  g.players[2].hand = [S(9), S(10), B(9), B(10)];
  const tc = { card: B(8), from: 0, source: 'discard', at: 0 };
  const opts = g.claimOptions(1, tc);
  const hu = opts.find((o: any) => o.type === 'hu');
  if (!hu) { /* 这副牌凑不成胡就不验了，换个形状再说 */ return; }
  const pao = opts.find((o: any) => o.type === 'pao');
  assert.ok(pao, '三张大捌在手，来第四张应当能开跑');
  // 这张是 0 家从手里打出来的：不是自摸、而且算放炮 —— 比分数得按真实情况算
  const afterPao = g.meldThenHuUnit(1, 'pao', B(8), false, true, 0);
  if (afterPao === null || afterPao <= hu.unit) return;   // 这副牌本来就是直接胡更高，不验
  g.act(0, 'discard', { card: B(8) });
  now += 50; g.tick(now);
  g.act(1, 'hu', { card: B(8) });
  now += 50; g.tick(now);
  assert.ok(g.players[1].melds.some((m: any) => m.type === 'pao'), '点胡之后应当先把这一坎开跑再胡');
  // 跑完引擎会再问一次胡（衡阳有胡必胡：那 5 秒到点自动成交）
  now += 6000; g.tick(now);
  const huEv: any = g.events.find((e: any) => e.t === 'hu');
  assert.ok(huEv, '最后还是胡了');
  assert.ok(huEv.detail.unit >= afterPao, `分数按跑胡那条路算（${huEv.detail.unit} 应 ≥ ${afterPao}）`);
});

/* ---------- 房间二维码（自己写的编码器，见 web/src/qr.ts） ---------- */
test('二维码：定型的那一张点阵一个点都不许变', async () => {
  const { qrMatrix, qrSvg } = await import('../../../web/src/qr.ts');
  /* 这一张是拿 zxing 解回来核对过的（连同另外约 800 组：各种长度 × 四档纠错 × 版本 1~10）。
     钉在这儿当基准 —— 生成器里哪怕挪动一位，这个测试就会红。
     （当初踩的坑：生成多项式存成了"低次在前"，而带余除法按"高次在前"算，
       图形、格式信息、数据位全对，就是扫不出来。） */
  const want = ['111111101100001111111', '100000101100101000001', '101110101001101011101',
    '101110100110001011101', '101110101000101011101', '100000100111101000001',
    '111111101010101111111', '000000000111100000000', '100111111100110010111',
    '101000001000101011110', '000010100010011011001', '010110010101000000100',
    '010111111000001000100', '000000001001100001111', '111111101110111111000',
    '100000101011110101100', '101110101111101100111', '101110101001100101100',
    '101110100110001010011', '100000100110011000111', '111111101001000101000'];
  const got = qrMatrix('L6WS8s', 'M').map(r => r.map(v => (v ? '1' : '0')).join(''));
  assert.deepEqual(got, want);

  // 版本随内容长短自己挑：短的 21×21（版本 1），房间那个网址是 33×33（版本 4）
  assert.equal(qrMatrix('a', 'M').length, 21);
  assert.equal(qrMatrix('http://paohuzi.yytbank.cn:1991/?room=123456', 'M').length, 33);
  // 四周要留静区（扫码枪认这圈白边）
  assert.ok(qrSvg('abc').includes('viewBox="0 0 29 29"'), '21 + 4×2 的静区');
  assert.throws(() => qrMatrix('x'.repeat(400)), /装不下/);
});
