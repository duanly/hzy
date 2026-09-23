import test from 'node:test';
import assert from 'node:assert/strict';
import { MahjongGame } from '../src/game.ts';
import { HONG, DECK_SIZE, tileOf } from '../src/tiles.ts';
import { decideTurn, decideClaim } from '../src/bot.ts';

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* Room 那边是照着字牌引擎的形状写的。这几条钉住"麻将这套也长成那个形状"，
   免得以后改着改着又对不上 —— 对不上的时候报错会出现在 Room 里，很难往这边想。 */

test('deck：开局那副牌原样留着，112 张', () => {
  const g = new MahjongGame({ now: () => 0 });
  g.start();
  assert.equal(g.deck.length, DECK_SIZE);
  assert.equal(g.wall.length + 52 + 1, DECK_SIZE, '发了 4×13 张、庄家又摸了 1 张');
});

test('lag：新开的时限从「玩家看到」那一刻起算', () => {
  let clock = 1000;
  const g = new MahjongGame({ now: () => clock, turnMs: 15000 });
  g.lag = 800;
  g.start();
  assert.equal(g.deadline, 1000 + 15000 + 800, '算上了这一帧的播放时间');
});

test('freshHold：只推刚开出来那个时限，推过一次就不再推', () => {
  let clock = 0;
  const g = new MahjongGame({ now: () => clock, turnMs: 15000 });
  g.start();
  const d0 = g.deadline;
  g.freshHold(600);
  assert.equal(g.deadline, d0 + 600);
  g.freshHold(600);
  assert.equal(g.deadline, d0 + 600, '同一个时限不能一帧续一次，不然就没边了');
});

test('optionsFor：轮到谁谁才有选项，别人是 null', () => {
  let clock = 0;
  const g = new MahjongGame({ dealer: 2, now: () => clock });
  g.start();
  const o = g.optionsFor(2);
  assert.ok(o, '庄家该有选项');
  assert.ok(o!.options.includes('discard'));
  assert.equal(o!.deadline, g.deadline);
  assert.equal(g.optionsFor(0), null, '没轮到的人没有选项');
  assert.equal(g.optionsFor(null), null);
});

test('autoDiscardCard：托管替打，但绝不打红中', () => {
  let clock = 0;
  const g = new MahjongGame({ dealer: 0, now: () => clock });
  g.start();
  const W = (r: number) => tileOf('wan', r);
  g.players[0].hand = [W(3), HONG, HONG];
  assert.equal(g.autoDiscardCard(0), W(3), '手里还有别的就别打赖子');
  g.players[0].hand = [HONG, HONG];
  assert.equal(g.autoDiscardCard(0), HONG, '满手赖子才认了');
});

test('replay：每一步生效的决定都记着，能照着重跑', () => {
  let clock = 0;
  const g = new MahjongGame({ dealer: 0, now: () => clock });
  g.start();
  const t = g.players[0].hand[0];
  g.act(0, 'discard', { tile: t });
  assert.deepEqual(g.replay[0], { s: 0, t: 'discard', c: t });
});

test('回放：照着 deck + steps 重跑，终局必须一模一样（三百局）', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = mulberry(seed * 31337);
    let clock = 0;
    const g = new MahjongGame({ dealer: seed % 4, now: () => clock, turnMs: 1000, claimMs: 1000 });
    g.start(undefined, rnd);
    let steps = 0;
    while (!g.ended && steps++ < 3000) {
      if (g.phase === 'claim') { const cl = (g as any).claim; g.act(cl.seat, decideClaim(g, cl.seat, (g as any).table.tile, cl.options), { tile: (g as any).table.tile }); }
      else if (g.phase === 'discard') { const d = decideTurn(g, g.turn, 0.6, rnd); g.act(g.turn, d.type, { tile: d.tile }); }
      else break;
      clock += 10;
    }

    // ---- 照记下来的那副牌和那些步子重跑一遍 ----
    let clock2 = 0;
    const r = new MahjongGame({ dealer: seed % 4, now: () => clock2, turnMs: 1e9, claimMs: 1e9 });
    r.start(g.deck);
    for (const st of g.replay) {
      const err = r.act(st.s, st.t as any, { tile: st.c });
      assert.equal(err, null, `第 ${seed} 局重跑到 ${JSON.stringify(st)} 被拒：${err}`);
    }
    assert.deepEqual(r.scores, g.scores, `第 ${seed} 局重跑出来的分对不上`);
    assert.equal(r.winner, g.winner, `第 ${seed} 局赢家对不上`);
    assert.equal(r.ma, g.ma, `第 ${seed} 局翻的马对不上`);
    assert.deepEqual(r.players.map(p => p.hand), g.players.map(p => p.hand), `第 ${seed} 局终局手牌对不上`);
    assert.deepEqual(r.gangScores, g.gangScores);
  }
});
