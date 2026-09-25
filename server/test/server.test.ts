import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { botDecide } from '../../packages/engine/src/index.ts';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * 语音包写到哪儿。这儿踩过两个坑，都是"单跑一遍绿、连跑几遍红"那种最难查的：
 *
 * 1. 原先目录名只带 pid。这机器上 pid 只有两三位（69、340、361…），转一圈很快撞回来，
 *    而目录又一直没人清 —— 新一轮就跑进上一轮留下的目录里。
 * 2. 就算目录每轮都是新的，**一个文件里十几条用例还是共用同一个**。
 *    「在线合成」那条建的语音套留在里头，谁先谁后一变，「语音包」那条就中招。
 *
 * 中招的样子都一样：目录里只要躺着一套语音包，"没挑套的时候自动顶一套上来"那条逻辑
 * 就把它顶上来，于是拿到的是 /voice/packs/xxx/peng.mp3，而用例等的是 /voice/peng.mp3。
 *
 * 所以干脆**每起一次服务端就给一个全新的目录**，用例之间彻底不相干，
 * 谁先谁后、并行串行都无所谓。跑完整棵删掉。
 * （前提是没有哪条用例起两次服务端、指望文件留着 —— 确认过，没有。）
 */
const VOICE_ROOT = join(tmpdir(), `phz-voice-test-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
let voiceSeq = 0;
after(() => { try { rmSync(VOICE_ROOT, { recursive: true, force: true }); } catch { /* 删不掉就算了，不值得让测试挂 */ } });

function startServer(extraEnv: Record<string, string> = {}) {
  const p = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
    cwd: root, env: { ...process.env, ...extraEnv, PORT: String(PORT), DB_PATH: ':memory:', NODE_ENV: 'test', BOT_SPEED: '0.08', TIMER_SPEED: '0.12',
      // 语音包写到临时目录，别弄脏真实的 data/voice（为什么一条用例一个目录，见 VOICE_ROOT 上面那段）
      VOICE_DIR: join(VOICE_ROOT, `v${++voiceSeq}`) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stderr.on('data', d => { const s = String(d); if (!s.includes('ExperimentalWarning') && !s.includes('strip-types') && !s.includes('SQLite')) process.stderr.write(s); });
  p.stdout.on('data', d => { const s = String(d); if (s.includes('bot act error')) process.stderr.write(s); });
  return new Promise<typeof p>(res => p.stdout.on('data', d => { if (String(d).includes('http://')) res(p); }));
}

class WS {
  ws: WebSocket; queue: any[] = []; waiters: ((m: any) => void)[] = [];
  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    this.ws.onmessage = e => { const m = JSON.parse(String(e.data)); const w = this.waiters.shift(); if (w) w(m); else this.queue.push(m); };
  }
  open() { return new Promise<void>(r => { this.ws.onopen = () => r(); }); }
  send(m: any) { this.ws.send(JSON.stringify(m)); }
  next(): Promise<any> { if (this.queue.length) return Promise.resolve(this.queue.shift()); return new Promise(r => this.waiters.push(r)); }
  async until(pred: (m: any) => boolean, timeoutMs = 20000): Promise<any> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { const m = await Promise.race([this.next(), new Promise(r => setTimeout(() => r(null), timeoutMs))]); if (m && pred(m)) return m; if (!m) break; }
    throw new Error('timeout waiting for message');
  }
}

test('服务端：游客登录 → 大厅 → 机器人补位 → 打完一局', async () => {
  const srv = await startServer();
  try {
    const r = await fetch(`${BASE}/api/auth/guest`, { method: 'POST', body: JSON.stringify({ nickname: '测试' }) });
    const { token, user } = await r.json() as any;
    assert.ok(token); assert.equal(user.nickname, '测试');

    // 注册 / 登录
    const reg = await fetch(`${BASE}/api/auth/register`, { method: 'POST', body: JSON.stringify({ username: 'abc123', password: '123456', nickname: '阿三' }) });
    assert.equal(reg.status, 200);
    const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', body: JSON.stringify({ username: 'abc123', password: 'wrong' }) });
    assert.equal(login.status, 401);
    const wx = await fetch(`${BASE}/api/auth/wechat`, { method: 'POST', body: JSON.stringify({ code: 'devcode' }) });
    assert.equal(wx.status, 200);

    const ws = new WS(); await ws.open();
    ws.send({ type: 'auth', token });
    const ok = await ws.until(m => m.type === 'auth.ok');
    assert.equal(ok.user.id, user.id);
    ws.send({ type: 'lobby.list' });
    const tiers = await ws.until(m => m.type === 'lobby.list');
    assert.ok(tiers.tiers.length >= 3);
    ws.send({ type: 'lobby.join', tier: 'hh_1' });
    let state = await ws.until(m => m.type === 'room.state');
    assert.equal(state.room.mySeat, 0);
    // 等机器人补位并开局
    state = await ws.until(m => (m.type === 'room.state' || m.type === 'game.events') && m.room.status === 'playing', 15000);
    assert.equal(state.room.seats.filter((s: any) => s.isBot).length, 2);

    // 人类玩家用机器人逻辑代打，直到一局结束
    let ended = false; let steps = 0;
    while (!ended && steps++ < 600) {
      const m = await ws.until(m => m.type === 'game.events' || m.type === 'room.state', 30000);
      const g = m.room.game;
      if (m.type === 'game.events' && m.events.some((e: any) => e.t === 'end')) { ended = true; break; }
      if (g?.myOptions) {
        const opts = g.myOptions.options;
        const types = opts.map((o: any) => o.type);
        if (types.includes('hu')) ws.send({ type: 'game.act', action: 'hu' });
        else if (types.includes('discard')) ws.send({ type: 'game.act', action: 'discard', card: g.players[0].hand[0] });
        else if (types.includes('play_drawn')) ws.send({ type: 'game.act', action: 'play_drawn' });
        else ws.send({ type: 'game.act', action: 'pass' });
      }
    }
    assert.ok(ended, '一局应当结束');
    // 纪录表里这一局只能有一条（结算跑两遍的话会出现一模一样的重复行）
    const after = await ws.until(m => (m.type === 'room.state' || m.type === 'game.events') && m.room.ledger?.length, 15000);
    const rounds = after.room.ledger.map((l: any) => l.round);
    assert.equal(new Set(rounds).size, rounds.length, `纪录表有重复行：${JSON.stringify(rounds)}`);
    /* 每一局自己记着"参与的人当时叫什么"：机器人打完就离桌、真人也可能退出，
       到那会儿房间的在线名单里已经没有他了 —— 名字只能从这儿来，
       不然纪录表的列头就成了一串 userId（机器人是负数），结算详情里是"空位 +x 分"。 */
    const last = after.room.ledger[after.room.ledger.length - 1];
    assert.ok(last.names, '纪录表每一局要带上人名');
    for (const id of Object.keys(last.deltas)) {
      assert.ok(last.names[id], `userId ${id} 没记下名字`);
      assert.ok(!/^-?\d+$/.test(last.names[id]), `userId ${id} 的"名字"是个数字：${last.names[id]}`);
    }
    assert.ok(Object.keys(last.names).some(id => Number(id) < 0), '机器人（负数 id）也要有名字');
    assert.ok(last.seatNames?.every((n: string) => n && n !== '空位'), `座位名不该是空位：${JSON.stringify(last.seatNames)}`);
    // 把机器人请走：他从房间的在线名单里没了，但纪录表里那一局的名字得照样在
    const botSeat = after.room.seats.findIndex((x: any) => x.isBot);
    ws.send({ type: 'room.kick', seat: botSeat });
    const gone = await ws.until(m => m.type === 'room.state' && !m.room.seats[botSeat].user, 10000);
    const last2 = gone.room.ledger[gone.room.ledger.length - 1];
    assert.deepEqual(last2.names, last.names, '人走了，那一局记下的名字不该跟着消失');
    assert.deepEqual(last2.seatNames, last.seatNames, '人走了，座位名也不该变成空位');
    // 资料
    ws.send({ type: 'profile.get', userId: user.id });
    const prof = await ws.until(m => m.type === 'profile');
    assert.equal(prof.profile.games, 1);
    ws.send({ type: 'room.leave' });
    await ws.until(m => m.type === 'room.left');
    ws.ws.close();
  } finally { srv.kill(); }
});

test('超时托管：人不动就交给机器人替打，头像挂机器人标；人一动手就收回来', async () => {
  const srv = await startServer();
  try {
    const { token } = await (await fetch(`${BASE}/api/auth/guest`, { method: 'POST', body: JSON.stringify({ nickname: '发呆' }) })).json() as any;
    const ws = new WS(); await ws.open();
    ws.send({ type: 'auth', token }); await ws.until(m => m.type === 'auth.ok');
    ws.send({ type: 'lobby.join', tier: 'hh_1' });
    await ws.until(m => m.type === 'room.state');
    await ws.until(m => (m.type === 'room.state' || m.type === 'game.events') && m.room.status === 'playing', 15000);
    // 什么都不点：等到超时，座位应当被机器人接管
    const auto = await ws.until(m => (m.type === 'room.state' || m.type === 'game.events')
      && m.room.seats[m.room.mySeat]?.auto === true, 40000);
    assert.equal(auto.room.seats[auto.room.mySeat].auto, true, '超时之后该挂机器人标');
    // 牌局还得接着走（机器人替他打，不是卡在那儿）
    const round0 = auto.room.game?.turn;
    await ws.until(m => m.type === 'game.events' && m.room.game && m.room.game.turn !== round0, 30000);
    // 人回来了：点一下就收回来
    ws.send({ type: 'seat.wake' });
    const back = await ws.until(m => (m.type === 'room.state' || m.type === 'game.events')
      && m.room.seats[m.room.mySeat]?.auto === false, 15000);
    assert.equal(back.room.seats[back.room.mySeat].auto, false, '自己动手了就该解除托管');
    ws.ws.close();
  } finally { srv.kill(); }
});

test('账号 ID 登录要原设备解绑；账号码不外泄；复盘能自己清空', async () => {
  const srv = await startServer();
  try {
    const a = await (await fetch(`${BASE}/api/auth/device`, { method: 'POST', body: JSON.stringify({ deviceId: 'devA0000000', nickname: '老王' }) })).json() as any;
    const code = a.user.code as string;
    assert.match(code, /^[a-z]{7,9}$/, '账号 ID 是 7~9 位字母');
    // 别人看我的资料：不能带账号码
    const prof = await (await fetch(`${BASE}/api/profile/${a.user.id}`)).json() as any;
    assert.equal(prof.user.code, undefined, '别人看得到的资料里不能有账号 ID');
    // 换一台设备光凭账号码登录：挡住
    const r1 = await fetch(`${BASE}/api/auth/code`, { method: 'POST', body: JSON.stringify({ code, deviceId: 'devB1111111' }) });
    assert.equal(r1.status, 403, '新设备不能直接用账号 ID 登录');
    // 原设备这边看得到"有人要登录"
    const me1 = await (await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${a.token}` } })).json() as any;
    assert.equal(me1.bindReq?.deviceId, 'devB1111111');
    assert.equal(me1.user.code, code, '本人看得到自己的账号 ID');
    // 原设备点「解除绑定」之后，新设备才登得上；老设备的登录票同时作废
    const ub = await fetch(`${BASE}/api/auth/unbind`, { method: 'POST', headers: { Authorization: `Bearer ${a.token}` }, body: '{}' });
    assert.equal(ub.status, 200);
    const r2 = await fetch(`${BASE}/api/auth/code`, { method: 'POST', body: JSON.stringify({ code, deviceId: 'devB1111111' }) });
    assert.equal(r2.status, 200, '解绑之后新设备登得上');
    const b = await r2.json() as any;
    assert.equal(b.user.id, a.user.id, '还是同一个账号');
    const old = await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${a.token}` } });
    assert.equal(old.status, 401, '账号搬走之后老设备的登录票要作废');
    // 复盘可以自己清空
    const cl = await fetch(`${BASE}/api/rounds/clear`, { method: 'POST', headers: { Authorization: `Bearer ${b.token}` }, body: '{}' });
    assert.equal(cl.status, 200);
    const rounds = await (await fetch(`${BASE}/api/rounds`, { headers: { Authorization: `Bearer ${b.token}` } })).json() as any;
    assert.deepEqual(rounds.rounds, [], '清完就看不到了');
  } finally { srv.kill(); }
});

test('代理：开房上限管住、能一键停用；昵称脏字挡回去', async () => {
  const srv = await startServer();
  try {
    const a = await (await fetch(`${BASE}/api/auth/device`, { method: 'POST', body: JSON.stringify({ deviceId: 'devAgent001', nickname: '老王' }) })).json() as any;
    // 脏字昵称：注册和改名都得挡住
    const dirty = await fetch(`${BASE}/api/auth/device`, { method: 'POST', body: JSON.stringify({ deviceId: 'devDirty001', nickname: '傻逼王' }) });
    assert.equal(dirty.status, 400, '带脏字的昵称不许注册');
    const ren = await fetch(`${BASE}/api/auth/nickname`, { method: 'POST', headers: { Authorization: `Bearer ${a.token}` }, body: JSON.stringify({ nickname: '阿蠢' }) });
    assert.equal(ren.status, 400, '带脏字的昵称不许改');
    assert.match((await ren.json() as any).error, /不能带/);

    const adm = await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin8888' }) })).json() as any;
    const A = (p: string, b: any) => fetch(`${BASE}/api/admin/${p}`, { method: 'POST', headers: { Authorization: `Bearer ${adm.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    // 设成代理：自动进「代理」分组，开房上限设成 1
    assert.equal((await A('agent', { id: a.user.id, start: true, roomLimit: 1 })).status, 200);
    const agents = await (await fetch(`${BASE}/api/admin/agents`, { headers: { Authorization: `Bearer ${adm.token}` } })).json() as any;
    const me0 = agents.agents.find((x: any) => x.id === a.user.id);
    assert.ok(me0 && me0.canOpenRoom && me0.roomLimit === 1, '代理列表里有他、上限是 1');
    // 月卡：设成代理时自动给一个月，续一次再加一个月
    // 月卡按自然月算：到期日一律落在某月 1 号 0 点，本月剩下的天数白送
    assert.ok(me0.cardLeft >= 28, `设成代理就该有一个月的卡（现在 ${me0.cardLeft} 天）`);
    assert.equal(new Date(me0.cardUntil).getDate(), 1, '到期日是某月 1 号');
    assert.equal(new Date(me0.cardUntil).getHours(), 0, '到期时刻是 0 点');
    assert.equal((await A('agent', { id: a.user.id, renewCard: 1 })).status, 200);
    const after = await (await fetch(`${BASE}/api/admin/agents`, { headers: { Authorization: `Bearer ${adm.token}` } })).json() as any;
    const me1 = after.agents.find((x: any) => x.id === a.user.id);
    assert.ok(me1.cardLeft >= me0.cardLeft + 27, '再续一次就是再加一个自然月');
    assert.equal(new Date(me1.cardUntil).getDate(), 1, '还是落在 1 号');

    const ws = new WS(); await ws.open();
    ws.send({ type: 'auth', token: a.token }); await ws.until(m => m.type === 'auth.ok');
    ws.send({ type: 'room.create', variant: 'ly_tilong', baseScore: 1 });
    await ws.until(m => m.type === 'room.created');
    ws.send({ type: 'room.create', variant: 'ly_tilong', baseScore: 1 });          // 第二个：超上限
    const err = await ws.until(m => m.type === 'error');
    assert.match(err.message, /最多同时开 1 个房间/);

    // 一键停用：权限收回，连房间一起解散
    assert.equal((await A('agent', { id: a.user.id, stop: true, closeRooms: true })).status, 200);
    ws.send({ type: 'room.create', variant: 'ly_tilong', baseScore: 1 });
    const err2 = await ws.until(m => m.type === 'error');
    assert.match(err2.message, /没有开房权限/);
    // 权限恢复了、但卡停掉：照样开不了房（权限永久，卡会到期）
    await A('agent', { id: a.user.id, start: true });
    await A('agent', { id: a.user.id, stopCard: true });
    ws.send({ type: 'room.create', variant: 'ly_tilong', baseScore: 1 });
    const err3 = await ws.until(m => m.type === 'error');
    assert.match(err3.message, /月卡/);
    ws.ws.close();
  } finally { srv.kill(); }
});

test('私人房：房主自己也上桌打、凭房号进、满员锁房、暂停与继续', async () => {
  const srv = await startServer();
  try {
    const users: any[] = [];
    for (const n of ['甲', '乙', '丙', '丁', '戊']) users.push(await (await fetch(`${BASE}/api/auth/guest`, { method: 'POST', body: JSON.stringify({ nickname: n }) })).json());
    const conns: WS[] = [];
    for (const u of users) { const w = new WS(); await w.open(); w.send({ type: 'auth', token: u.token }); await w.until(m => m.type === 'auth.ok'); conns.push(w); }
    // 新注册的玩家默认没有开房权限：先用后台给甲开
    const adm = await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin8888' }) })).json() as any;
    assert.ok(adm.token, '管理员应当能登录');
    const grant = await fetch(`${BASE}/api/admin/user`, {
      method: 'POST', headers: { Authorization: `Bearer ${adm.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: users[0].user.id, canOpenRoom: true }),
    });
    assert.equal(grant.status, 200);
    // 没给权限之前开不了房
    conns[1].send({ type: 'room.create', variant: 'ly_tilong', baseScore: 1 });
    const noPerm = await conns[1].until(m => m.type === 'error');
    assert.match(noPerm.message, /开房权限/);
    // 甲 开房：开好就完事，人不进去（管房在主页「我的房间」，想打自己点进去）
    conns[0].send({ type: 'room.create', variant: 'ly_tilong', baseScore: 2, swingCap: 0 });
    const made = await conns[0].until(m => m.type === 'room.created');
    const roomId = made.roomId;
    // 房主自己进去打，跟普通玩家一样入座
    conns[0].send({ type: 'room.join', roomId });
    const st = await conns[0].until(m => m.type === 'room.state');
    assert.ok(!st.room.spectating, '房主不再是观战身份');
    assert.equal(st.room.mySeat, 0, '房主自己坐第一个位子');
    // 房号不存在进不去
    conns[1].send({ type: 'room.join', roomId: '000001' });
    const err = await conns[1].until(m => m.type === 'error');
    assert.match(err.message, /不存在/);
    // 乙丙 凭房号入座（不用密码）—— 三人玩法，加上房主正好坐满
    for (let i = 1; i <= 2; i++) {
      conns[i].send({ type: 'room.join', roomId });
      await conns[i].until(m => m.type === 'room.state' && m.room.mySeat === i);
    }
    // 满员锁房
    conns[3].send({ type: 'room.join', roomId });
    const full = await conns[3].until(m => m.type === 'error');
    assert.match(full.message, /已满/);
    // 人齐 + 都准备好 → 3 秒倒计时自动开局
    for (let i = 0; i <= 2; i++) conns[i].send({ type: 'room.ready', ready: true });
    await conns[0].until(m => m.room?.status === 'playing', 12000);
    // 房主坐在桌上，看得见自己的牌
    const mine = await conns[0].until(m => m.room?.game?.players, 8000);
    assert.ok((mine.room.game.hand ?? mine.room.game.players[0].hand ?? []).length > 0, '房主该有自己的手牌');
    /* 乙 点「返回大厅」：跟大厅一个待遇 —— 机器人先替他打着，桌子照转。
       （以前这儿是当场空位 + 暂停：三个人打得好好的，一个人出去看一眼，
       另外两个就干坐着等。只有「起立」才该按停。） */
    conns[1].send({ type: 'room.leave' });
    const away = await conns[0].until(m => m.room?.seats?.[1]?.isBot === true, 8000);
    assert.equal(away.room.status, 'playing', '一个人退出，另外两个接着打，不许暂停');
    assert.ok(away.room.seats[1].user, '位子还是他的 —— 退出不等于让位');
    // 退到大厅：那条「返回牌局」要认得出这一桌，不然人就找不着自己那间房了
    conns[1].send({ type: 'lobby.tables' });
    const lob = await conns[1].until(m => m.type === 'lobby.tables');
    assert.equal(lob.resume, roomId, '大厅能一键点回来');
    assert.match(lob.resumeName ?? '', /房间/, '横幅上要写清楚是哪一间');
    // 点回来，接着打
    conns[1].send({ type: 'room.join', roomId });
    await conns[1].until(m => m.type === 'room.state' && m.room.mySeat === 1);
    // 乙 起立 → 这才是真的离开位置：位子空出来，牌局暂停；戊 补位 → 继续，接手他的座位
    conns[1].send({ type: 'room.leave', stand: true });
    const paused = await conns[0].until(m => m.room?.status === 'paused');
    assert.equal(paused.room.seats[1].user, null);
    conns[4].send({ type: 'room.join', roomId });
    const resumed = await conns[4].until(m => m.room?.status === 'playing' && m.room.mySeat === 1);
    assert.ok(resumed.room.game.players[1].hand.length > 0);
    // 人全走光了也不解散：房主开的房，散不散由房主自己说了算
    for (let i of [0, 2, 4]) conns[i].send({ type: 'room.leave' });
    await new Promise(r => setTimeout(r, 800));
    const still = await fetch(`${BASE}/api/myrooms`, { headers: { authorization: `Bearer ${users[0].token}` } }).then(r => r.json()) as any;
    assert.equal(still.rooms.length, 1, '人走光了房间还在');
    for (const c of conns) c.ws.close();
  } finally { srv.kill(); }
});

test('断线重连：回到原房间，不会被旧连接踢出', async () => {
  const srv = await startServer();
  try {
    const u = await (await fetch(`${BASE}/api/auth/guest`, { method: 'POST', body: JSON.stringify({ nickname: '重连' }) })).json() as any;
    const w1 = new WS(); await w1.open(); w1.send({ type: 'auth', token: u.token }); await w1.until(m => m.type === 'auth.ok');
    w1.send({ type: 'lobby.join', tier: 'hh_1' });
    const st = await w1.until(m => m.type === 'room.state');
    const roomId = st.room.id;
    // 模拟断线后用新连接重新登录
    const w2 = new WS(); await w2.open(); w2.send({ type: 'auth', token: u.token });
    await w2.until(m => m.type === 'auth.ok');
    const back = await w2.until(m => m.type === 'room.state', 8000);
    assert.equal(back.room.id, roomId, '重连后仍在原房间');
    assert.ok(back.room.mySeat !== null, '座位还在');
    // 旧连接关闭后不应把人踢出去
    w1.ws.close();
    await new Promise(r => setTimeout(r, 600));
    w2.send({ type: 'room.state' });
    const again = await w2.until(m => m.type === 'room.state', 8000);
    assert.equal(again.room.id, roomId, '旧连接关闭不影响新连接');
    w2.ws.close();
  } finally { srv.kill(); }
});

test('牌桌配置：读秒 / 自动开局 / 机器人思考能分组配，留空的跟玩法默认', async () => {
  const { DB } = await import('../src/db.ts');
  const { Lobby, isMj } = await import('../src/lobby.ts');
  const lobby = new Lobby(new DB(':memory:'));
  /** 大厅里现在两种房间并存，固定桌那部分只看跑胡子的 */
  const phz = () => [...lobby.rooms.values()].filter(r => !isMj(r)) as import('../src/room.ts').Room[];
  const cfg = lobby.tableConfig();
  const hh = cfg.find(c => c.variant === 'hy_honghei')!;
  lobby.saveTableConfig([{
    ...hh, open: true, turnSec: 30, autoNextSec: 15, botThink: false,
    tiers: [
      { baseScore: 1, count: 2 },                                               // 全跟默认
      { baseScore: 5, count: 2, turnSec: 20, autoNextSec: 8, botThink: true },  // 这一组自己说了算
    ],
  }]);
  const rooms = phz().filter(r => r.cfg.variant === 'hy_honghei' && r.cfg.fixed)
    .sort((a, b) => a.cfg.id.localeCompare(b.cfg.id));
  assert.equal(rooms.length, 4, `这个玩法应当建 4 桌，实际 ${rooms.length}`);
  const [a1, a2, b1, b2] = rooms;
  for (const r of [a1, a2]) {
    assert.equal(r.cfg.turnSec, 30, '没单独配的那一组跟玩法默认读秒');
    assert.equal(r.cfg.botThink, false, '没单独配的那一组机器人不装思考');
    assert.equal(r.rules.timers.discard, 30000, '读秒要落到真正的时限上');
    assert.equal(r.rules.timers.claimPeng, 15000, '碰的窗口还是一半');
  }
  for (const r of [b1, b2]) {
    assert.equal(r.cfg.baseScore, 5);
    assert.equal(r.cfg.turnSec, 20, '这一组单独配的读秒');
    assert.equal(r.cfg.autoNextMs, 8000, '这一组单独配的自动开局');
    assert.equal(r.cfg.botThink, true, '这一组的机器人要装思考');
    assert.equal(r.rules.timers.discard, 20000);
    assert.equal(r.rules.timers.claimPeng, 10000);
  }
  // 存进去再读出来：留空的还得是空的（以后改玩法默认，这一组要跟着动）
  const back = lobby.tableConfig().find(c => c.variant === 'hy_honghei')!;
  assert.equal(back.tiers[0].turnSec, undefined, '留空的不能被补成一个数');
  assert.equal(back.tiers[0].botThink, undefined);
  assert.equal(back.tiers[1].turnSec, 20);
  assert.equal(back.tiers[1].botThink, true);
  // 改玩法默认：留空的那一组跟着变，配了的那一组不动
  lobby.saveTableConfig([{ ...back, turnSec: 45 }]);
  const now = phz().filter(r => r.cfg.variant === 'hy_honghei' && r.cfg.fixed)
    .sort((a, b) => a.cfg.id.localeCompare(b.cfg.id));
  assert.equal(now[0].cfg.turnSec, 45, '跟默认的那一组跟着改了');
  assert.equal(now[3].cfg.turnSec, 20, '单独配过的那一组不受影响');
});

test('回放只留最近 200 局：新的进来，旧的连回放一起删掉', async () => {
  const { DB } = await import('../src/db.ts');
  const db = new DB(':memory:');
  const KEEP = DB.KEEP_ROUNDS;
  for (let i = 1; i <= KEEP + 30; i++) {
    db.recordRound('HH01', 'hy_honghei', false, 7, { round: i, roomName: '红黑 01', deltas: { 7: 1 }, replay: { dealer: 0, deck: [], steps: [] } }, [7]);
  }
  // 另一张桌子的局不受影响（是按房间各留各的）
  for (let i = 1; i <= 5; i++) {
    db.recordRound('TL03', 'ly_tilong', false, 7, { round: i, roomName: '提龙 03', deltas: { 7: 2 }, replay: { dealer: 0, deck: [], steps: [] } }, [7]);
  }
  const mine = db.myRounds(7, 1000);
  assert.equal(mine.filter(r => r.roomId === 'HH01').length, KEEP, `这张桌子只该留 ${KEEP} 局`);
  assert.equal(mine.filter(r => r.roomId === 'TL03').length, 5, '别的桌子不受影响');
  assert.equal(mine[0].round, 5, '最新的排最前面');
  assert.equal(Math.min(...mine.filter(r => r.roomId === 'HH01').map(r => r.round)), 31, '删掉的是最早那几局');
  assert.equal(mine.find(r => r.roomId === 'HH01')!.roomName, '红黑 01', '桌名要记下来（回放按场次归类要用）');
});

test('我的房间：房主自己管房 —— 读秒 / 暂停 / 开始 / 清空 / 解散，别人一概插不上手', async () => {
  const srv = await startServer();
  try {
    // 管理员登录，给一个玩家开房权限
    const adm = await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin8888' }) })).json() as any;
    assert.ok(adm.token, '管理员要登得进去');
    const host = await (await fetch(`${BASE}/api/auth/guest`, { method: 'POST', body: JSON.stringify({ nickname: '房主' }) })).json() as any;
    const other = await (await fetch(`${BASE}/api/auth/guest`, { method: 'POST', body: JSON.stringify({ nickname: '路人' }) })).json() as any;
    await fetch(`${BASE}/api/admin/user`, {
      method: 'POST', headers: { authorization: `Bearer ${adm.token}` },
      body: JSON.stringify({ id: host.user.id, canOpenRoom: true }),
    });

    const get = (t: string) => fetch(`${BASE}/api/myrooms`, { headers: { authorization: `Bearer ${t}` } }).then(r => r.json() as any);
    const post = (t: string, b: any) => fetch(`${BASE}/api/myroom`, { method: 'POST', headers: { authorization: `Bearer ${t}` }, body: JSON.stringify(b) });

    let mine = await get(host.token);
    assert.equal(mine.canOpen, true, '给了权限就该认');
    assert.equal(mine.rooms.length, 0, '还没开房');

    // 开一个房
    const ws = new WS(); await ws.open();
    ws.send({ type: 'auth', token: host.token });
    await ws.until(m => m.type === 'auth.ok');
    ws.send({ type: 'room.create', variant: 'hy_honghei', baseScore: 2, password: '', turnMs: 30000, name: '自家房' });
    const made = await ws.until(m => m.type === 'room.created');
    const roomId = made.roomId;

    mine = await get(host.token);
    assert.equal(mine.rooms.length, 1, '开的房要在「我的房间」里看得见');
    assert.equal(mine.rooms[0].id, roomId);
    assert.equal(mine.rooms[0].turnSec, 30);
    assert.equal(mine.rooms[0].seats.length, 3, '积分牌按座位摆');

    // 别人看不到，也动不了
    assert.equal((await get(other.token)).rooms.length, 0, '别人的房间一个也看不到');
    assert.equal((await post(other.token, { id: roomId, action: 'pause' })).status, 403, '不是房主就不许动');

    // 改房名：空的回落到房号，脏字挡回去
    assert.equal((await post(host.token, { id: roomId, action: 'rename', name: '老友局' })).status, 200);
    assert.equal((await get(host.token)).rooms[0].name, '老友局', '房名改得动');
    assert.equal((await post(host.token, { id: roomId, action: 'rename', name: '傻逼房' })).status, 400, '脏字房名不许用');
    assert.equal((await post(host.token, { id: roomId, action: 'rename', name: '' })).status, 200);
    assert.equal((await get(host.token)).rooms[0].name, roomId, '清空房名就回落到房号');
    await post(host.token, { id: roomId, action: 'rename', name: '老友局' });

    // 调读秒
    assert.equal((await post(host.token, { id: roomId, action: 'turnSec', value: 45 })).status, 200);
    assert.equal((await get(host.token)).rooms[0].turnSec, 45, '读秒改得动');
    await post(host.token, { id: roomId, action: 'turnSec', value: 999 });
    assert.equal((await get(host.token)).rooms[0].turnSec, 120, '超出范围要夹住');

    // 暂停 / 开始
    await post(host.token, { id: roomId, action: 'pause' });
    assert.ok((await get(host.token)).rooms[0].paused, '暂停了要看得出来');
    await post(host.token, { id: roomId, action: 'start' });
    assert.equal((await get(host.token)).rooms[0].paused, null, '开始之后不该还挂着暂停');

    // 清空数据：房主这边归零，但局本身不删（玩家自己的战绩照旧看得到）
    const { DB } = await import('../src/db.ts');
    void DB;
    assert.equal((await post(host.token, { id: roomId, action: 'clear' })).status, 200);
    assert.equal((await get(host.token)).rooms[0].rounds, 0, '积分牌清空了');
    const seen = await fetch(`${BASE}/api/room/${roomId}/rounds`, { headers: { authorization: `Bearer ${host.token}` } }).then(r => r.json()) as any;
    assert.equal(seen.rounds.length, 0, '房主的记录表从现在重新记');

    // 解散
    assert.equal((await post(host.token, { id: roomId, action: 'close' })).status, 200);
    assert.equal((await get(host.token)).rooms.length, 0, '解散之后就不在列表里了');
    ws.ws.close();
  } finally { srv.kill(); }
});

test('ping/pong 量往返延迟：pong 原样带回发出时刻和服务端收到的时刻', async () => {
  const srv = await startServer();
  try {
    const r = await fetch(`${BASE}/api/auth/guest`, { method: 'POST', body: JSON.stringify({ nickname: '量延迟' }) });
    const { token } = await r.json() as any;
    const ws = new WS(); await ws.open();
    ws.send({ type: 'auth', token });
    await ws.until(m => m.type === 'auth.ok');

    const t0 = Date.now();
    ws.send({ type: 'ping', t: t0 });
    const pong = await ws.until(m => m.type === 'pong');
    // 客户端靠这两个数算 rtt 和时钟偏差：t 是它自己发出的那一刻，now 是服务端收到的那一刻
    assert.equal(pong.t, t0, 'pong 要把客户端发出的时刻原样带回来');
    assert.ok(typeof pong.now === 'number' && pong.now > 0, 'pong 要带服务端此刻的时间');
    assert.ok(Date.now() - t0 < 5000, '一个来回不该要这么久');

    // 上报 rtt：服务端拿它给倒计时补"消息在路上走的那一截"。乱填的要挡掉，不能崩
    ws.send({ type: 'ping', t: Date.now(), rtt: 120 });
    await ws.until(m => m.type === 'pong');
    ws.send({ type: 'ping', t: Date.now(), rtt: -5 });
    await ws.until(m => m.type === 'pong');
    ws.send({ type: 'ping', t: Date.now(), rtt: 999999 });
    await ws.until(m => m.type === 'pong');
    ws.send({ type: 'ping' });                       // 老客户端：什么都不带
    await ws.until(m => m.type === 'pong');
    ws.ws.close();
  } finally { srv.kill(); }
});

test('开了房坐下，照样能去别的桌打：只有正在打的那一局才把你送回去', async () => {
  const srv = await startServer();
  try {
    const r = await fetch(`${BASE}/api/auth/guest`, { method: 'POST', body: JSON.stringify({ nickname: '房主' }) });
    const { token, user } = await r.json() as any;
    // 给开房权限 + 月卡
    const adm = await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin8888' }) })).json() as any;
    const gp = await fetch(`${BASE}/api/admin/user`, { method: 'POST', headers: { authorization: `Bearer ${adm.token}` },
      body: JSON.stringify({ id: user.id, canOpenRoom: true }) });
    assert.equal(gp.status, 200, '给开房权限失败');

    const ws = new WS(); await ws.open();
    ws.send({ type: 'auth', token });
    await ws.until(m => m.type === 'auth.ok');
    ws.send({ type: 'room.create', variant: 'hy_honghei', baseScore: 1, password: '', name: '我的房' });
    const created = await ws.until(m => m.type === 'room.created' || m.type === 'error', 8000);
    assert.equal(created.type, 'room.created', `开房失败：${JSON.stringify(created)}`);
    const myRoom = created.roomId;

    // 进自己房坐下（还没开局）
    ws.send({ type: 'room.join', roomId: myRoom });
    let st = await ws.until(m => m.type === 'room.state' && m.room.id === myRoom);
    assert.ok(st.room.mySeat >= 0, '应当坐下了');
    assert.equal(st.room.status, 'waiting');

    /* 断线重连：桌子还空着等人，不该把他锁在自己那一桌上 ——
       以前 auth 一律"有座位就送回去"，于是开好房坐下之后点哪儿都回自己房。 */
    ws.ws.close();
    await new Promise(r => setTimeout(r, 300));
    const ws2 = new WS(); await ws2.open();
    ws2.send({ type: 'auth', token });
    await ws2.until(m => m.type === 'auth.ok');
    const restored = await ws2.until(m => m.type === 'room.state' || m.type === 'room.left', 8000);
    assert.equal(restored.type, 'room.left', '空着等人的桌子不该自动送回去');

    // 而且位子也让出来了，别占着
    ws2.send({ type: 'lobby.tables' });
    const tb = await ws2.until(m => m.type === 'lobby.tables');
    assert.ok(!tb.resume, `不该还提示"返回牌局"：${tb.resume}`);

    // 去大厅打：进的是大厅的桌，不是自己那间私人房
    ws2.send({ type: 'lobby.join', tier: 'hh_1' });
    const lob = await ws2.until(m => m.type === 'room.state', 8000);
    assert.notEqual(lob.room.id, myRoom, '点大厅的桌子不该被送回自己开的房');
    assert.equal(lob.room.isPrivate, false);
    ws2.ws.close();
  } finally { srv.kill(); }
});

test('起立离开：这一局机器人替你打完，位子不再留，重连也不把你送回来', async () => {
  const srv = await startServer();
  try {
    const u = await (await fetch(`${BASE}/api/auth/guest`, { method: 'POST', body: JSON.stringify({ nickname: '起立' }) })).json() as any;
    const w1 = new WS(); await w1.open();
    w1.send({ type: 'auth', token: u.token }); await w1.until(m => m.type === 'auth.ok');
    w1.send({ type: 'lobby.join', tier: 'hh_1' });
    const st = await w1.until(m => m.type === 'room.state');
    const roomId = st.room.id;
    // 等开局：起立要的就是"打到一半走人"这个场景
    await w1.until(m => (m.type === 'room.state' || m.type === 'game.events') && m.room.status === 'playing', 15000);

    w1.send({ type: 'room.leave', stand: true });
    await w1.until(m => m.type === 'room.left');
    w1.ws.close();
    await new Promise(r => setTimeout(r, 400));

    // 重连：牌局多半还在打，但他已经起立了，不该再被送回去
    const w2 = new WS(); await w2.open();
    w2.send({ type: 'auth', token: u.token }); await w2.until(m => m.type === 'auth.ok');
    const restored = await w2.until(m => m.type === 'room.state' || m.type === 'room.left', 8000);
    assert.equal(restored.type, 'room.left', '起立走的人不该被送回原桌');
    w2.send({ type: 'lobby.tables' });
    const tb = await w2.until(m => m.type === 'lobby.tables');
    assert.notEqual(tb.resume, roomId, '也不该再提示"返回牌局"');
    w2.ws.close();
  } finally { srv.kill(); }
});

test('只是回大厅（没起立）：位子留着，重连接着打', async () => {
  const srv = await startServer();
  try {
    const u = await (await fetch(`${BASE}/api/auth/guest`, { method: 'POST', body: JSON.stringify({ nickname: '暂离' }) })).json() as any;
    const w1 = new WS(); await w1.open();
    w1.send({ type: 'auth', token: u.token }); await w1.until(m => m.type === 'auth.ok');
    w1.send({ type: 'lobby.join', tier: 'hh_1' });
    const st = await w1.until(m => m.type === 'room.state');
    const roomId = st.room.id;
    await w1.until(m => (m.type === 'room.state' || m.type === 'game.events') && m.room.status === 'playing', 15000);

    w1.send({ type: 'room.leave' });            // 不带 stand：暂时走开
    await w1.until(m => m.type === 'room.left');
    w1.ws.close();
    await new Promise(r => setTimeout(r, 400));

    const w2 = new WS(); await w2.open();
    w2.send({ type: 'auth', token: u.token }); await w2.until(m => m.type === 'auth.ok');
    const back = await w2.until(m => m.type === 'room.state' || m.type === 'room.left', 8000);
    assert.equal(back.type, 'room.state', '没起立就该回到原桌接着打');
    assert.equal(back.room.id, roomId);
    assert.ok(back.room.mySeat >= 0, '座位还在');
    w2.ws.close();
  } finally { srv.kill(); }
});

test('几局一歇：打满设定的局数就暂停，房主 / 桌长点继续才接着打', async () => {
  const { DB } = await import('../src/db.ts');
  const { Lobby } = await import('../src/lobby.ts');
  const db = new DB(':memory:');
  const lobby = new Lobby(db);
  const room = lobby.createPrivate(1, 'hy_honghei', 1, '', { pauseEvery: 2 });
  assert.equal(room.cfg.pauseEvery, 2);

  const seat = (name: string) => {
    const u = db.createUser({ nickname: name, kind: 'guest' });
    room.join(u, { send() {}, userId: u.id });
    return u;
  };
  const a = seat('甲'), b = seat('乙'), c = seat('丙');

  /* 桌长 = 桌上最早坐下的那个真人（走了自动顺延）。
     大厅的桌子没有房主，几局一歇就全靠他点继续。 */
  assert.equal(room.captainId(), a.id, '最早坐下的是桌长');
  assert.equal(room.canResume(a.id), true);
  assert.equal(room.canResume(b.id), false, '后坐下的不是桌长');

  // 打两局（直接把局数推到位，再走收尾）
  room.roundNo = 2;
  (room as any).closeRound({ events: [], scores: [0, 0, 0] });
  assert.ok(room.pausedReason?.includes('歇一歇'), `该歇一歇了：${room.pausedReason}`);
  assert.equal((room as any).nextRoundAt, null, '暂停期间不排下一局');

  // 不是房主也不是桌长：点不动
  assert.ok(room.hostResume(b.id), '别人点不动继续');
  assert.ok(room.pausedReason, '还停着');
  // 桌长点得动
  assert.equal(room.hostResume(a.id), null);
  assert.equal(room.pausedReason, null, '继续之后就不停了');

  // 桌长走了：顺延给下一个
  room.leave(a.id, 'stand');
  assert.equal(room.captainId(), b.id, '桌长走了顺延给下一个');
  assert.equal(room.canResume(b.id), true);
  // 房主（没坐在桌上）照样点得动
  assert.equal(room.canResume(1), true, '房主一直点得动');
  void c;
});

test('不设几局一歇的房间照旧一直打下去', async () => {
  const { DB } = await import('../src/db.ts');
  const { Lobby } = await import('../src/lobby.ts');
  const db = new DB(':memory:');
  const lobby = new Lobby(db);
  const room = lobby.createPrivate(1, 'hy_honghei', 1, '');
  const u = db.createUser({ nickname: '单', kind: 'guest' }); room.join(u, { send() {}, userId: u.id });
  room.roundNo = 50;
  (room as any).closeRound({ events: [], scores: [0, 0, 0] });
  assert.equal(room.pausedReason, null, '没设就不该暂停');
});

test('语音包：后台传 mp3 存到数据目录，客户端看得到；名字乱来的挡回去', async () => {
  const srv = await startServer();
  try {
    const adm = await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin8888' }) })).json() as any;
    const H = { authorization: `Bearer ${adm.token}`, 'Content-Type': 'application/json' };
    const list = await (await fetch(`${BASE}/api/admin/voice`, { headers: H })).json() as any;
    assert.ok(list.items.length >= 33, '动作 + 牌名都要列出来');
    assert.equal(list.items.find((x: any) => x.key === 'wei')?.label, '笑起', '偎在衡阳报的是「笑起」');
    assert.equal(list.items.find((x: any) => x.key === 'long')?.label, '提龙', 'long 跟 ti 报同一句');

    const fake = Buffer.from('ID3-not-really-an-mp3').toString('base64');
    const up = await (await fetch(`${BASE}/api/admin/voice`, { method: 'POST', headers: H,
      body: JSON.stringify({ files: [{ key: 'peng', data: fake }, { key: '../evil', data: fake }, { key: 'nope', data: fake }] }) })).json() as any;
    assert.deepEqual(up.saved, ['peng']);
    assert.deepEqual(up.skipped.sort(), ['../evil', 'nope'], '白名单之外的一律不落盘');

    // 客户端拿得到清单（服务端直接把"哪一条播哪个地址"算好），也取得到文件
    /* 地址后面挂着 `?v=<改动时间>`（后台重新生成之后地址就变了，客户端的缓存才会换新的），
       比对的时候把它去掉。 */
    const bare = (u?: string) => (u ?? '').split('?')[0];
    const keys = await (await fetch(`${BASE}/api/voice`)).json() as any;
    assert.equal(bare(keys.clips.peng), '/voice/peng.mp3');
    const f = await fetch(`${BASE}/voice/peng.mp3`);
    assert.equal(f.status, 200);

    /* 多套声音：玩家像挑字体一样挑一套，后台还能给每个玩法指定默认的那一套。
       格式也按真实的来 —— iOS 现场录出来是 m4a，硬安个 .mp3 的名字就放不出来了。 */
    const P = (b: any) => fetch(`${BASE}/api/admin/voice`, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(r => r.json()) as Promise<any>;
    const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('ftypM4A ')]).toString('base64');
    const p1 = await P({ newPack: '衡阳老王' });
    const p2 = await P({ newPack: '普通话女声' });
    assert.ok(p1.id && p2.id && p1.id !== p2.id);
    await P({ pack: p1.id, files: [{ key: 'peng', mime: 'audio/mpeg', data: fake }, { key: 'wei', mime: 'audio/mp4', data: m4a }] });
    await P({ pack: p2.id, files: [{ key: 'peng', mime: 'audio/mpeg', data: fake }] });
    await P({ setVariant: 'ly_tilong', usePack: p1.id });

    // 耒阳没自己挑 → 用后台给耒阳配的那一套；内置那一套永远垫底
    const ly = await (await fetch(`${BASE}/api/voice?v=ly_tilong`)).json() as any;
    assert.equal(bare(ly.clips.peng), `/voice/packs/${p1.id}/peng.mp3`, '耒阳用配好的那一套');
    assert.equal(bare(ly.clips.wei), `/voice/packs/${p1.id}/wei.m4a`);
    assert.equal(ly.clips.chi, undefined, '这一条谁都没录');
    /* 衡阳没配 → 自动用**录得最全的那一套**。
       以前这儿是两手空空（只剩内置那一套），后果很难受：后台明明生成了一整套，
       牌桌上还是系统机器音 —— 因为谁也没想到还要再去「各玩法默认」里点一下。
       装好一套就该听得见；后台真配了的话，配的说了算。 */
    const hy = await (await fetch(`${BASE}/api/voice?v=hy_honghei`)).json() as any;
    assert.equal(hy.auto, true, '没配就自动挑一套');
    assert.equal(bare(hy.clips.peng), `/voice/packs/${p1.id}/peng.mp3`, '自动挑录得最全的那一套');
    assert.equal(bare(hy.clips.wei), `/voice/packs/${p1.id}/wei.m4a`);
    // 玩家自己挑了一套 → 盖过玩法默认
    const mine = await (await fetch(`${BASE}/api/voice?v=ly_tilong&p=${p2.id}`)).json() as any;
    assert.equal(bare(mine.clips.peng), `/voice/packs/${p2.id}/peng.mp3`, '玩家自己挑的说了算');
    assert.equal(mine.clips.wei, undefined, '这一套没录 wei，也不该去翻别的套');
    assert.equal(mine.auto, false, '玩家自己挑了，就不是自动挑的');

    const got = await fetch(`${BASE}/voice/packs/${p1.id}/wei.m4a`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'audio/mp4', 'm4a 要按 audio/mp4 发，别按 mp3 发');
    // 玩家能挑的套（一条都没录的不给看）
    const packs = await (await fetch(`${BASE}/api/voice?packs=1`)).json() as any;
    assert.equal(packs.packs.length, 2);
    // 删整套：指着它的那个玩法也要松手
    await P({ dropPack: p1.id });
    const after = await (await fetch(`${BASE}/api/voice?packs=1`)).json() as any;
    assert.equal(after.packs.length, 1);
    assert.equal(after.byVariant.ly_tilong, undefined, '整套删了，玩法那条指向也得清掉');

    // 目录穿越：静态文件只许在 web/dist 里面找
    for (const bad of ['/voice/..%2F..%2Fpackage.json', '/x/..%2F..%2F..%2Fetc%2Fhostname', '/..%2Fserver%2Fdata%2Fpaohuzi.db']) {
      assert.equal((await fetch(`${BASE}${bad}`)).status, 404, `${bad} 不该读得到`);
    }
    // 正常的静态文件照旧
    assert.equal((await fetch(`${BASE}/`)).status, 200);

    await P({ dropPack: p2.id });            // 把剩下那一套也删了，不然"自动挑一套"还会顶上来
    await fetch(`${BASE}/api/admin/voice`, { method: 'POST', headers: H, body: JSON.stringify({ del: 'peng' }) });
    assert.equal((await (await fetch(`${BASE}/api/voice`)).json() as any).clips.peng, undefined, '删掉之后清单里也没了');
  } finally { srv.kill(); }
});

/* 在线合成报牌声：服务端连一次 Edge 的「大声朗读」接口，把整套合成成 mp3 存下来。
   这里不去真连微软（测试机不一定出得了网，人家也不该被我们的 CI 敲），
   而是**照同一套协议起一个假服务**，看两件事：
   1. 我们手写的那个 WS 客户端（握手、掩码、二进制帧里的头部长度）到底对不对；
   2. 合成回来的 mp3 有没有按 key 落到这一套的目录里，客户端清单里跟着出现。 */
test('在线合成：照百炼的协议走一遍，整套报牌声落成 mp3', async () => {
  const { createServer } = await import('node:http');
  /* 假的百炼。真接口就是一次普通的 HTTPS POST，所以这儿拿个 http server 顶上就行 ——
     比原来那个 Edge 的 WebSocket 假服务简单太多（那一版要自己拼帧）。
     两个路径：/tts 合成，/mt 翻译。 */
  const asked: string[] = [];          // 每次请求要念的那句
  const spoke: string[] = [];          // 用的哪个发音人
  const langs: string[] = [];          // language_type 传的是什么
  const mt: { text: string; to: string }[] = [];
  /** 一段真有幅度的 WAV。**不能用全 0 的静音** —— trimWav 会把首尾静音掐掉，
      整片都是静音就被掐成空的，后面什么也测不出来。 */
  const wav = (ms = 120) => {
    const rate = 24000, n = Math.round(rate * ms / 1000);
    const d = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) d.writeInt16LE(Math.round(Math.sin(i / 8) * 9000), i * 2);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + d.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(d.length, 40);
    return Buffer.concat([h, d]);
  };
  const fake = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const j = JSON.parse(raw || '{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      if ((req.url ?? '').includes('/mt')) {
        const text = j.input.messages[0].content;
        const to = j.parameters.translation_options.target_lang;
        mt.push({ text, to });
        // 翻译结果做个看得出来的记号，好断言它确实填回去了
        res.end(JSON.stringify({ output: { choices: [{ message: { content: `<${to}>${text}` } }] } }));
        return;
      }
      asked.push(j.input.text); spoke.push(j.input.voice); langs.push(j.input.language_type);
      res.end(JSON.stringify({ output: { audio: { data: wav().toString('base64') } } }));
    });
  });
  await new Promise<void>(r => fake.listen(18899, '127.0.0.1', r));
  const srv = await startServer({
    DASHSCOPE_TTS_URL: 'http://127.0.0.1:18899/tts',
    DASHSCOPE_MT_URL: 'http://127.0.0.1:18899/mt',
    DASHSCOPE_API_KEY: 'sk-test',
  });
  try {
    const adm = await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin8888' }) })).json() as any;
    const H = { authorization: `Bearer ${adm.token}`, 'Content-Type': 'application/json' };
    const P = (b: any) => fetch(`${BASE}/api/admin/voice`, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(r => r.json()) as Promise<any>;

    const list = await (await fetch(`${BASE}/api/admin/voice`, { headers: H })).json() as any;
    // 整张表都在：48 个音色，分普通话 / 方言 / 外语三组
    assert.equal(list.voices.length, 48, '音色要是百炼文档上那一整张表');
    assert.ok(list.voices.every((v: any) => v.id.startsWith('a:')), '只剩百炼这一家，不该再有微软 / 谷歌的');
    const byGroup = (g: string) => list.voices.filter((v: any) => v.group === g).length;
    assert.deepEqual([byGroup('普通话'), byGroup('方言'), byGroup('外语')], [28, 10, 10]);
    assert.ok(list.voices.some((v: any) => v.id === 'a:Roy'), '闽南话那个要在');
    assert.ok(list.voices.some((v: any) => v.id === 'a:Eldric Sage'), 'id 里带空格的不许被顺手去掉');
    assert.equal(list.langs.length, 10, '十种语言');

    const pk = await P({ newPack: '在线合成' });
    const gen = await P({ pack: pk.id, gen: { voice: 'a:Cherry', keys: ['peng', 'wei', 'your_turn'] } });
    assert.deepEqual(gen.failed, [], `合成不该失败：${JSON.stringify(gen.failed)}`);
    assert.deepEqual(gen.saved.sort(), ['peng', 'wei', 'your_turn']);
    // 念的是牌桌上真正报的那一句 —— 偎报「笑起」，不是「偎」
    assert.deepEqual(asked, ['碰', '笑起', '该你出牌']);
    assert.deepEqual([...new Set(spoke)], ['Cherry'], '发音人要原样传过去，a: 前缀得剥掉');
    assert.deepEqual([...new Set(langs)], ['Chinese'], '没指定语言就是中文');

    /* 存成什么后缀，**取决于这台机器上有没有 ffmpeg**：
       百炼回的是 WAV（接口不让挑格式），有 ffmpeg 才转成 mp3、体积小八倍，
       没有就照原样存 WAV —— 一样能放，只是包大。
       这儿原先写死了 .mp3：我的 Mac 和开发容器都装了 ffmpeg，跑着一直是绿的，
       推到 CI 上（runner 没有 ffmpeg）当场红。**别把本机装了什么当成前提**。 */
    const haveFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
    const ext = haveFfmpeg ? 'mp3' : 'wav';
    const clips = await (await fetch(`${BASE}/api/voice?p=${pk.id}`)).json() as any;
    assert.equal((clips.clips.wei ?? '').split('?')[0], `/voice/packs/${pk.id}/wei.${ext}`,
      haveFfmpeg ? '有 ffmpeg：转成 mp3 存' : '没有 ffmpeg：照原样存 WAV');
    const f = await fetch(`${BASE}${clips.clips.wei}`);
    assert.equal(f.status, 200);
    // 后缀和 Content-Type 必须对得上，不然浏览器可能不认
    assert.equal(f.headers.get('content-type'), haveFfmpeg ? 'audio/mpeg' : 'audio/wav');
    assert.ok((await f.arrayBuffer()).byteLength > 200, '存下来的不该是个空壳');

    // 再点一次「只补缺的」：已经有的不重做
    const again = await P({ pack: pk.id, gen: { voice: 'a:Cherry', keys: [] } });
    assert.ok(!again.saved.includes('peng'), '已经有的那几条不该重做');
    assert.ok(again.saved.includes('hu'), '缺的那几条要补上');

    /* 念什么可以自己改：嫌「碰」太秃就写「碰啦」—— 合出来念的是"碰啦"，
       可**文件名还是 peng.<后缀>**（客户端只认 key，不管里头念的是什么）。 */
    asked.length = 0;
    const st = await P({ pack: pk.id, setText: 'peng', text: '碰啦' });
    assert.equal(st.say, '碰啦');
    const list2 = await (await fetch(`${BASE}/api/admin/voice?pack=${pk.id}`, { headers: H })).json() as any;
    const row = list2.items.find((x: any) => x.key === 'peng');
    assert.equal(row.say, '碰啦'); assert.equal(row.custom, true);
    assert.equal(row.label, '碰', 'label 还是这一条本来的叫法');
    /* 改完词，「生成缺的」要认得出这一条过时了 —— 以前只看"文件在不在"，
       改完词一点「生成缺的」什么都不动，非得整套重做才行。 */
    assert.equal(list2.items.find((x: any) => x.key === 'peng').stale, true, '念法改了＝这一条过时了');
    const fix = await P({ pack: pk.id, gen: { voice: 'a:Cherry' } });
    assert.deepEqual(fix.saved, ['peng'], '只重做改过词的那一条，别的一概不动');
    assert.deepEqual(asked, ['碰啦'], '合成时念的是改过的那句');
    const clips2 = await (await fetch(`${BASE}/api/voice?p=${pk.id}`)).json() as any;
    assert.equal((clips2.clips.peng ?? '').split('?')[0], `/voice/packs/${pk.id}/peng.${ext}`, '文件名不跟着变');
    /* 一条可以写几种说法（用 / 隔开）：一句合一条，peng / peng-2 / peng-3，
       牌桌上随机挑一条念。 */
    asked.length = 0;
    await P({ pack: pk.id, setText: 'peng', text: '碰 / 碰啦 / 我碰了' });
    const three = await P({ pack: pk.id, gen: { voice: 'a:Cherry' } });
    assert.deepEqual(three.saved, ['peng']);
    assert.deepEqual(asked, ['碰', '碰啦', '我碰了'], '三种说法各合一条');
    const cl3 = await (await fetch(`${BASE}/api/voice?p=${pk.id}`)).json() as any;
    assert.equal(cl3.takes.peng.length, 3, '这一条有三个录法');
    assert.ok(cl3.takes.peng[0].startsWith(`/voice/packs/${pk.id}/peng.${ext}?v=`), '地址带着改动时间，改过就换');
    assert.ok(cl3.takes.peng[1].includes(`peng-2.${ext}`));
    assert.equal(cl3.clips.peng, cl3.takes.peng[0], 'clips 留第一条给老客户端垫底');
    for (const u of cl3.takes.peng) assert.equal((await fetch(`${BASE}${u}`)).status, 200, `${u} 取得到`);
    const listT = await (await fetch(`${BASE}/api/admin/voice?pack=${pk.id}`, { headers: H })).json() as any;
    assert.equal(listT.items.find((x: any) => x.key === 'peng').takes, 3, '后台也看得到有三条');
    // 改回一种说法：多出来的那两条要清掉
    await P({ pack: pk.id, setText: 'peng', text: '碰啦' });
    await P({ pack: pk.id, gen: { voice: 'a:Cherry' } });
    const cl1 = await (await fetch(`${BASE}/api/voice?p=${pk.id}`)).json() as any;
    assert.equal(cl1.takes.peng.length, 1, '改回一种说法，多的那两条要清掉');

    /* ── 外语：先把念法翻过去，再拿翻好的文本合成 ──
       要紧的是这个次序。TTS 只会念不会翻，直接把 language_type 设成 English
       去念中文，出来是一团糟。 */
    const tr = await P({ pack: pk.id, translate: { to: 'English' } });
    assert.equal(tr.failed.length, 0, `翻译不该失败：${JSON.stringify(tr.failed)}`);
    assert.ok(tr.done.length > 20, '整套都要翻');
    assert.ok(mt.every(x => x.to === 'English'), '目标语言要传对');
    // 翻的是当前那句（还有汉字就翻当前的），「碰啦」是刚改过的
    assert.ok(mt.some(x => x.text === '碰啦'), '自己改过的念法要带着味道一起翻');
    const listE = await (await fetch(`${BASE}/api/admin/voice?pack=${pk.id}`, { headers: H })).json() as any;
    assert.equal(listE.items.find((x: any) => x.key === 'peng').say, '<English>碰啦', '翻完填回「念什么」那一栏');

    // 再翻一次：这会儿念法已经是外语了，要退回内置中文原句去翻，不能英译英
    mt.length = 0;
    await P({ pack: pk.id, translate: { to: 'Japanese' } });
    assert.ok(mt.some(x => x.text === '碰'), '已经是外语的那条，要退回中文原句再翻');
    assert.ok(!mt.some(x => x.text.startsWith('<English>')), '不许拿翻译结果再翻一遍');

    // 拿翻好的文本合成：language_type 要跟着走
    asked.length = 0; langs.length = 0;
    const jp = await P({ pack: pk.id, gen: { voice: 'a:Ono Anna', lang: 'Japanese', keys: ['peng'], all: true } });
    assert.deepEqual(jp.saved, ['peng']);
    assert.deepEqual([...new Set(langs)], ['Japanese'], '挑了日语，language_type 就得是 Japanese');
    assert.deepEqual([...new Set(spoke.slice(-1))], ['Ono Anna'], 'id 里的空格要原样传过去');

    // 留空＝恢复默认
    await P({ pack: pk.id, setText: 'peng', text: '' });
    const list3 = await (await fetch(`${BASE}/api/admin/voice?pack=${pk.id}`, { headers: H })).json() as any;
    assert.equal(list3.items.find((x: any) => x.key === 'peng').custom, false, '留空就恢复默认');
  } finally { srv.kill(); fake.close(); }
});
