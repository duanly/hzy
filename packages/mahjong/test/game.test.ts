import test from 'node:test';
import assert from 'node:assert/strict';
import { MahjongGame } from '../src/game.ts';
import { decideTurn, decideClaim } from '../src/bot.ts';
import { DECK_SIZE, HONG, nameOf, tileOf, type Tile } from '../src/tiles.ts';

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** 让四个机器人把一局打完，顺便一步步核对不变量 */
function playOne(seed: number) {
  const rnd = mulberry(seed);
  let clock = 0;
  const g = new MahjongGame({ dealer: seed % 4, now: () => clock, turnMs: 1000, claimMs: 1000 });
  g.start(undefined, rnd);
  let steps = 0;
  while (!g.ended && steps++ < 2000) {
    // 每一步都点一遍 112 张
    assert.equal(g.collect().length, DECK_SIZE, `第 ${steps} 步牌数不对`);
    if (g.phase === 'claim') {
      const cl = (g as any).claim;
      const d = decideClaim(g, cl.seat, (g as any).table.tile, cl.options);
      const err = g.act(cl.seat, d, { tile: (g as any).table.tile });
      assert.equal(err, null, `claim ${d} 被拒：${err}`);
    } else if (g.phase === 'discard') {
      const d = decideTurn(g, g.turn);
      const err = g.act(g.turn, d.type, { tile: d.tile });
      assert.equal(err, null, `${d.type} 被拒：${err}`);
    } else break;
    clock += 10;
  }
  assert.ok(g.ended, `${steps} 步还没打完，卡住了`);
  return g;
}

test('一局能打完，牌数和分数都对得上', () => {
  const g = playOne(1);
  assert.equal(g.collect().length, DECK_SIZE);
  assert.equal(g.scores.reduce((a, b) => a + b, 0), 0, '有人赢就有人输，总和必须是 0');
});

test('两千局自动对打：不卡、不丢牌、分不凭空长出来', () => {
  let hu = 0, liu = 0, gangs = 0, maxSteps = 0;
  const maHist = new Map<number, number>();
  for (let seed = 1; seed <= 2000; seed++) {
    const g = playOne(seed);
    assert.equal(g.collect().length, DECK_SIZE, `第 ${seed} 局牌数不对`);
    assert.equal(g.scores.reduce((a, b) => a + b, 0), 0, `第 ${seed} 局分数不守恒`);
    const h = g.events.find(e => e.t === 'hu') as any;
    if (h) { hu++; const m = h.ma ?? -1; maHist.set(m, (maHist.get(m) ?? 0) + 1); } else liu++;
    gangs += g.events.filter(e => e.t === 'gang').length;
    maxSteps = Math.max(maxSteps, g.events.length);
  }
  const top = [...maHist].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, n]) => `${m < 0 ? '无马' : nameOf(m)}×${n}`).join(' ');
  console.log(`  胡 ${hu} · 流局 ${liu} · 杠 ${gangs} 次 · 单局最多 ${maxSteps} 个事件 · 常见马 ${top}`);
  assert.ok(hu > 200, `两千局只胡了 ${hu} 局，太少了，规则八成哪儿卡着`);
  assert.ok(gangs > 0, '两千局一个杠都没有，杠那条路没走通');
});

test('胡牌只认自摸：别人打出来点不了炮', () => {
  // 造一副：座位 1 听五筒，座位 0 打五筒 —— 座位 1 不该有 hu 这个选项
  let clock = 0;
  const g = new MahjongGame({ dealer: 0, now: () => clock });
  g.start();
  const W = (r: number) => tileOf('wan', r), B = (r: number) => tileOf('tong', r), T = (r: number) => tileOf('tiao', r);
  g.players[1].hand = [W(1),W(2),W(3), W(4),W(5),W(6), T(7),T(8),T(9), B(2),B(2),B(2), B(5)];
  assert.deepEqual(g.claimOptions(1, B(5)), [], '点炮不算胡，也不该冒出别的选项');
  // 但自己摸到就能胡
  g.players[1].hand.push(B(5));
  assert.ok(g.turnOptions(1).includes('hu'));
});

test('红中不给碰也不给杠', () => {
  let clock = 0;
  const g = new MahjongGame({ dealer: 0, now: () => clock });
  g.start();
  g.players[1].hand = [HONG, HONG, HONG, ...g.players[1].hand.slice(3)];
  assert.deepEqual(g.claimOptions(1, HONG), [], '赖子不参与碰杠');
  assert.ok(!g.selfGangTiles(1).includes(HONG), '四张红中也不给暗杠');
});

test('杠分当场结：明杠每家 1 分，暗杠每家 2 分', () => {
  let clock = 0;
  const g = new MahjongGame({ dealer: 0, now: () => clock });
  g.start();
  const W = (r: number) => tileOf('wan', r);
  // 暗杠：手里四张
  g.players[0].hand = [W(1),W(1),W(1),W(1), ...g.players[0].hand.slice(4)];
  assert.equal(g.act(0, 'gang', { tile: W(1) }), null);
  assert.equal(g.scores[0], 6, '三家各付 2');
  assert.deepEqual(g.scores.slice(1), [-2,-2,-2]);
  assert.equal(g.scores.reduce((a,b)=>a+b,0), 0);
});

test('杠了要从公牌补一张，手上张数不能少', () => {
  let clock = 0;
  const g = new MahjongGame({ dealer: 0, now: () => clock });
  g.start();
  const W = (r: number) => tileOf('wan', r);
  g.players[0].hand = [W(1),W(1),W(1),W(1), ...g.players[0].hand.slice(4)];
  const before = g.players[0].hand.length, wall0 = g.wall.length;
  g.act(0, 'gang', { tile: W(1) });
  assert.equal(g.players[0].hand.length, before - 4 + 1, '去掉四张、补回一张');
  assert.equal(g.wall.length, wall0 - 1, '补的那张来自公牌');
  assert.equal(g.turn, 0, '杠完还是自己打');
});

test('杠分算进总计，但单独还留一份账', () => {
  let clock = 0;
  const g = new MahjongGame({ dealer: 0, now: () => clock });
  g.start();
  const W = (r: number) => tileOf('wan', r);
  g.players[0].hand = [W(1),W(1),W(1),W(1), ...g.players[0].hand.slice(4)];
  g.act(0, 'gang', { tile: W(1) });
  assert.deepEqual(g.gangScores, [6,-2,-2,-2], '杠分那一笔单独记着');
  assert.deepEqual(g.scores, [6,-2,-2,-2], '总计里已经含着它了，不是两笔钱');
  assert.equal(g.gangScores.reduce((a,b)=>a+b,0), 0);
});

test('流局不算分', () => {
  let clock = 0;
  const g = new MahjongGame({ dealer: 0, now: () => clock });
  g.start();
  g.wall = [];
  g.act(0, 'discard', { tile: g.players[0].hand[0] });
  // 没人要 → 下家要摸牌 → 牌墙空了 → 流局
  assert.equal(g.ended, true);
  assert.ok(g.events.some(e => e.t === 'liuju'));
  assert.deepEqual(g.scores, [0,0,0,0], '流局一分不动');
  assert.deepEqual(g.gangScores, [0,0,0,0]);
});
