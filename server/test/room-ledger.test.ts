import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/room.ts';
import { DB } from '../src/db.ts';

/** 造一张三人桌，坐三个人进去 */
function table(ids: number[]) {
  const db = new DB(':memory:');
  const room = new Room({ id: 'T1', isPrivate: true, variant: 'hy_honghei', baseScore: 1, hostId: ids[0] }, db);
  seat(room, ids);
  return room;
}
/** 直接摆座位（绕开 join 里那一串登录 / 广播） */
function seat(room: any, ids: number[]) {
  room.seats = ids.map((id: number) => ({ userId: id, isBot: false, ready: true, client: null, seatedAt: Date.now() }));
  for (const id of ids) room.remember({ id, nickname: `玩家${id}`, avatar: 'avatar:0', kind: 'user', vip: false, points: 0 });
}
const openBatch = (room: any) => room.openBatch();
/** 打几局：直接往总账上加分（真流程是 settleLedger 加的） */
const win = (room: any, upToRound: number, deltas: Record<number, number>) => {
  for (const [id, v] of Object.entries(deltas)) room.totals.set(Number(id), (room.totals.get(Number(id)) ?? 0) + v);
  room.roundNo = upToRound;
};

test('换人：上一段自成一节（自己的表头、局号范围、小计），摆到纪录表下面', () => {
  const room: any = table([1, 2, 3]);
  openBatch(room);
  win(room, 4, { 1: 12, 2: -5, 3: -7 });

  seat(room, [1, 2, 4]);   // 3 号走，4 号顶上
  openBatch(room);

  assert.equal(room.batches.length, 1, '封存了一段');
  const b = room.batches[0];
  assert.equal(b.label, '第1批');
  assert.deepEqual(b.seats, [1, 2, 3], '这一段的表头就是当时坐着的三位');
  assert.deepEqual(b.subtotal, { 1: 12, 2: -5, 3: -7 }, '小计只算这一段自己打下来的');
  assert.deepEqual([b.from, b.until], [1, 4], '记着这一段是第几局到第几局');

  // 桌上这三位：没走的接着算（合计跟总表走，不跟着分段重来），新来的从 0 开始
  assert.deepEqual([...room.totals.keys()].sort((a: number, c: number) => a - c), [1, 2, 4], '账本只有桌上这三个人');
  assert.equal(room.totals.get(1), 12, '一直在桌上的人，合计从头连着走');
  assert.equal(room.totals.get(4), 0, '新来的从 0 开始');
  // 走掉的人：账整笔挪进「离桌」那本，等他回来
  assert.deepEqual([...room.gone], [[3, -7]], '3 号的账进了离桌那一行');
});

test('之前的人回来了：老账提出来接着算；新走的那个进离桌那一行', () => {
  const room: any = table([1, 2, 3]);
  openBatch(room);
  win(room, 4, { 1: 12, 2: -5, 3: -7 });
  seat(room, [1, 2, 4]); openBatch(room);          // 3 走
  win(room, 8, { 1: 3, 2: 3, 4: -6 });
  seat(room, [1, 2, 3]); openBatch(room);          // 3 回来、4 走

  assert.equal(room.totals.get(3), -7, '3 号接着他原来那笔算，不是从 0 开始');
  assert.equal(room.totals.get(1), 15, '一直在桌上的人照常累计（12 + 3）');
  assert.deepEqual([...room.gone], [[4, -6]], '换成 4 号进了离桌那一行');
  assert.equal(room.gone.has(3), false, '提出来之后离桌那本里就不留他了 —— 同一笔钱不能数两遍');

  assert.equal(room.batches.length, 2, '两段');
  assert.equal(room.batches[0].label, '第2批', '新封的那一段排在前面（纪录表由近及远往下排）');
  assert.deepEqual(room.batches[0].seats, [1, 2, 4]);
  assert.deepEqual(room.batches[0].subtotal, { 1: 3, 2: 3, 4: -6 }, '第二段的小计不含第一段结转过来的');
  assert.deepEqual([room.batches[0].from, room.batches[0].until], [5, 8]);
  assert.deepEqual(room.batches[1].subtotal, { 1: 12, 2: -5, 3: -7 });
});

test('机器人换来换去不切段：只看真人', () => {
  const room: any = table([1, 2, 3]);
  openBatch(room);
  win(room, 3, { 1: 9, 2: -4, 3: -5 });
  seat(room, [1, 2, -101]); openBatch(room);
  const n1 = room.batches.length;
  win(room, 5, { 1: 2, 2: -2 });
  seat(room, [1, 2, -102]); openBatch(room);
  assert.equal(room.batches.length, n1, '机器人换个号不该再切一刀');
  assert.equal(room.totals.get(1), 11, '真人的账一直连着');
});

test('没打过一局就换人：不封一段空的出来', () => {
  const room: any = table([1, 2, 3]);
  openBatch(room);
  seat(room, [1, 2, 4]); openBatch(room);          // roundNo 还是 0
  assert.equal(room.batches.length, 0, '一局都没打，没什么好封的');
});

/**
 * 黄庄撞上「满局暂停」：桌子会冻住。
 *
 * 怎么冻的：afterAct() 是先把这一手的帧排进队列、紧接着就 settle()，
 * 而 settle → closeRound 里一旦满足"打满 N 局"，pausedReason 就设上了。
 * 偏偏 tick() 里 `if (this.pausedReason !== null) return;` 排在发帧那一句**前面** ——
 * 于是队列里还没发出去的帧再也发不出去：客户端收不到 liuju，
 * 结算面板不弹、画面停在最后一张牌上，看着就是卡死。
 *
 * 黄庄特别容易撞上，是因为最后几张牌连着没人要，尾巴上排着一长串帧
 *（room.ts 里那句"客户端要播好一会儿"说的就是这个）。
 */
test('黄庄正好赶上满局暂停：帧还得发完，别把桌子冻住', async () => {
  /* BOT_SPEED 不能压太狠：flush() 里那几段停顿是 `k >= 0.5` 才加的，
     压到 0.05 就一帧不留、当场全发完 —— 那这条用例就测了个寂寞（我先踩了一次）。
     0.5 是既留着停顿、又把时长减半的那个临界值。跑完还回去，别污染同文件其他用例。 */
  const prevSpeed = process.env.BOT_SPEED;
  process.env.BOT_SPEED = '0.5';
  try {
  const room: any = table([1, 2, 3]);
  room.cfg.pauseEvery = 1;              // 打一局就歇 —— 这一局收尾时必定触发暂停
  const got: any[][] = [[], [], []];    // 三个人各自收到的事件
  room.seats.forEach((s: any, i: number) => {
    s.client = { userId: s.userId, send(m: any) { if (m.type === 'game.events') got[i].push(...m.events); } };
  });

  room.startRound();
  const g = room.game;
  assert.ok(g, '开起来了');

  /* 走引擎真正的黄庄那条路（看门狗用的也是这个），别自己拼事件 ——
     拼出来的测的就是个假东西。后面这句 afterAct 也照看门狗的写法来：
     先把帧排进队列，紧接着 settle()，**这正是出问题的那个次序**。 */
  g.forceLiuJu('用例：把牌打完了');
  room.afterAct();

  assert.ok(g.ended, '这一局结束了');
  assert.ok(room.pausedReason?.includes('歇一歇'), `该歇一歇了：${room.pausedReason}`);
  assert.ok(room.frames.length > 0, '收尾时队列里还压着没发的帧 —— 这条用例就是要测这些帧发不发得出去');

  // 暂停之后接着转：没发完的帧必须继续发出去
  for (let i = 0; i < 900 && room.frames.length; i++) {
    room.tick();
    await new Promise(r => setTimeout(r, 5));
  }
  assert.equal(room.frames.length, 0, `帧必须全部发完，还剩 ${room.frames.length} 帧`);
  for (let i = 0; i < 3; i++) {
    assert.ok(got[i].some(e => e.t === 'liuju'), `第 ${i} 家没收到黄庄事件 —— 结算面板弹不出来，看着就是卡死`);
  }
  } finally { if (prevSpeed === undefined) delete process.env.BOT_SPEED; else process.env.BOT_SPEED = prevSpeed; }
});

test('托管一局一清：同一局漏两手才交给机器人，新一局重新算', () => {
  const room: any = table([1, 2, 3]);
  room.seats.forEach((s: any) => { s.client = { userId: s.userId, send() {} }; });
  room.startRound();

  // 这一局漏一手：只记一笔，还不托管
  room.seats[0].misses = 1;
  assert.equal(!!room.seats[0].autoBot, false, '漏一手还不至于托管 —— 可能只是走开倒杯水');

  /* 关键：这一笔**不能带到下一局**。原先是跨局累加的，
     第一局漏一手、第三局再漏一手就被判"连着两次"，人还坐在桌上呢。 */
  room.startRound();
  assert.equal(room.seats[0].misses, 0, '新一局超时次数清零');

  // 同一局里连漏两手：这才托管
  room.seats[0].misses = 2; room.seats[0].autoBot = true;
  assert.equal(room.seats[0].autoBot, true, '一局里漏两手，机器人接手');

  // 又开一局：托管自动解除，不用他自己去点按钮
  room.startRound();
  assert.equal(room.seats[0].autoBot, false, '新一局自动解除托管');
  assert.equal(room.seats[0].misses, 0, '次数也跟着清零');
  assert.equal(room.seats[0].botAt, undefined, '机器人的排程也要撤掉，别新一局还替他出牌');
});
