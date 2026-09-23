import test from 'node:test';
import assert from 'node:assert/strict';
import { MahjongRoom, MJ_VARIANT, type Client } from '../src/mjroom.ts';
import type { UserRow } from '../src/db.ts';

/** 只实现 MahjongRoom 真正会碰的那几个方法 —— 不想为了跑用例拖一整个 sqlite 进来 */
function fakeDb() {
  const rounds: any[] = [];
  const points: any[] = [];
  const stats: any[] = [];
  return {
    rounds, points, stats,
    bumpStats: (uid: number, d: any) => stats.push({ uid, ...d }),
    addPoints: (uid: number, n: number, why: string) => points.push({ uid, n, why }),
    recordRound: (...a: any[]) => rounds.push(a),
  } as any;
}
const user = (id: number, nickname: string): UserRow => ({
  id, nickname, avatar: '', kind: 'user', vip: 0, points: 0,
} as any);

/** 虚拟时钟：读秒十几秒，真等的话一条用例要跑好几分钟 */
function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** 一个不说话的连接，只记收到了几条 */
function client(userId: number): Client & { got: any[] } {
  const got: any[] = [];
  return { userId, got, send: (m: any) => got.push(m) };
}

test('开一桌、坐满机器人、打一局：分守恒、账落库', () => {
  const db = fakeDb();
  const ck = clock();
  const r = new MahjongRoom({ id: 'MJ01', isPrivate: true, baseScore: 1, hostId: 7, autoNextMs: 10, now: ck.now }, db);
  const c = client(7);
  assert.equal(r.join(user(7, '小小春风'), c), null);
  r.fillBots();
  assert.equal(r.filledCount(), 4);
  assert.equal(r.start(7), null);
  assert.equal(r.status, 'playing');

  // 让机器人和超时把这一局推完
  // 座位 0 是真人、永远不动手，全靠读秒超时把局面推下去
  let guard = 0;
  while (r.game && !r.game.ended && guard++ < 20000) { r.tick(); ck.advance(200); }
  assert.ok(r.game?.ended, `${guard} 次 tick 还没打完`);

  const g = r.game!;
  assert.equal(g.collect().length, 112, '牌得齐');
  assert.equal(g.scores.reduce((a, b) => a + b, 0), 0, '分守恒');
  assert.equal(r.ledger.length, 1, '记了一局');
  const e = r.ledger[0];
  assert.equal(e.variant, MJ_VARIANT);
  assert.equal(Object.values(e.deltas).reduce((a, b) => a + b, 0), 0, '纪录表里的账也得守恒');
  assert.ok(e.penalty, '杠分那一份要留着');
  assert.equal(e.penalty!.reduce((a, b) => a + b, 0), 0);
  assert.equal(db.rounds.length, 1, '回放落库了');
  const saved = db.rounds[0][4];
  assert.equal(saved.replay.deck.length, 112, '存的是整副牌');
  assert.ok(saved.replay.steps.length > 0);
});

test('真人的视角看不见别人的手牌', () => {
  const db = fakeDb();
  const r = new MahjongRoom({ id: 'MJ02', isPrivate: true, baseScore: 1, hostId: 7 }, db);
  r.join(user(7, '小小春风'), client(7));
  r.fillBots();
  r.start(7);
  const v = r.view(7);
  const me = v.game.players.find((p: any) => p.seat === v.mySeat);
  assert.ok(me.hand, '自己的手牌看得见');
  for (const p of v.game.players) if (p.seat !== v.mySeat) assert.equal(p.hand, null, '别人的看不见');
  assert.equal(v.variantName, '红中麻将');
  assert.equal(v.seats.length, 4);
});

test('连打十局：庄家轮转、总账一直守恒', () => {
  const db = fakeDb();
  const ck = clock();
  const r = new MahjongRoom({ id: 'MJ03', isPrivate: true, baseScore: 2, hostId: 7, autoNextMs: 0, now: ck.now }, db);
  r.join(user(7, '小小春风'), client(7));
  r.fillBots();
  r.start(7);
  let guard = 0;
  while (r.ledger.length < 10 && guard++ < 200000) { r.tick(); ck.advance(200); }
  assert.equal(r.ledger.length, 10, `只打了 ${r.ledger.length} 局`);
  for (const e of r.ledger) assert.equal(Object.values(e.deltas).reduce((a, b) => a + b, 0), 0);
  const total = [...r.totals.values()].reduce((a, b) => a + b, 0);
  assert.equal(total, 0, '十局下来总账还是 0');
  assert.ok(r.roundNo >= 10);
});

test('中途退出：位子留着，机器人替他打完', () => {
  const db = fakeDb();
  const ck = clock();
  const r = new MahjongRoom({ id: 'MJ04', isPrivate: true, baseScore: 1, hostId: 7, now: ck.now }, db);
  r.join(user(7, '小小春风'), client(7));
  r.fillBots();
  r.start(7);
  r.leave(7, 'disconnect');
  const s = (r as any).seats[r.seatOf(7)];
  assert.equal(s.userId, 7, '位子还是他的');
  assert.equal(s.autoBot, true, '机器人接管了');
  let guard = 0;
  while (r.game && !r.game.ended && guard++ < 20000) { r.tick(); ck.advance(200); }
  assert.ok(r.game?.ended, '托管之后也能把这一局打完');
});

test('大厅里两种房间并存：开一间麻将房，跑胡子那半边看不见它', async () => {
  const { Lobby, isMj } = await import('../src/lobby.ts');
  const { DB } = await import('../src/db.ts');
  const lobby = new Lobby(new DB(':memory:'));
  const before = lobby.rooms.size;

  const mj = lobby.createMahjong(7, 2, '', { name: '红中局', turnSec: 20, claimSec: 10 });
  assert.ok(isMj(mj), 'createMahjong 出来的得是麻将房');
  assert.equal(lobby.rooms.size, before + 1);
  assert.equal(lobby.rooms.get(mj.cfg.id), mj, '按房号找得到');
  assert.equal(mj.cfg.turnSec, 20);
  assert.equal(mj.view(7).variantName, '红中麻将');

  // 大厅的固定桌列表是跑胡子专属的，不该混进麻将房
  for (const v of lobby.tables(7)) for (const t of v.tables) assert.notEqual(t.id, mj.cfg.id);
  // 场次统计也一样
  for (const t of lobby.tiers()) assert.ok(t.online >= 0);

  // 关掉之后从 rooms 里摘掉（onClosed 接上了）
  mj.close(true);
  assert.equal(lobby.rooms.has(mj.cfg.id), false, 'onClosed 该把它摘掉');
});
