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
