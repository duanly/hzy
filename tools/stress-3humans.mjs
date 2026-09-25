/**
 * 三个"真人"开私人房打牌的压力环境。
 *
 * 为什么要这个：一直都是拿机器人测的，可机器人不会断线、不会犹豫、
 * 不会两个人同时抢着点 —— 老板今天真人开房才撞出来的那几样，机器人一辈子撞不出来。
 * 这儿用三条真的 WebSocket 连接当三个人，中间随机掐线重连，
 * 每收到一条消息就把客户端能看见的东西挨个对一遍。
 */
// Node 22 自带 WebSocket 客户端，不用装包
const PORT = process.env.PORT || 18970;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const problems = [];
const seen = new Set();
function bug(kind, detail) {
  const k = kind + '|' + detail.slice(0, 80);
  if (seen.has(k)) return;            // 同一种只报一次，不然刷屏
  seen.add(k);
  problems.push({ kind, detail });
  console.log(`  ⚠️  [${kind}] ${detail}`);
}

class Human {
  constructor(name) { this.name = name; this.room = null; this.seat = null; this.acts = 0; this.reconnects = 0; this.lastDeadline = 0; }

  async login() {
    const r = await fetch(`${BASE}/api/auth/guest`, { method: 'POST', body: JSON.stringify({ nickname: this.name }) });
    const j = await r.json(); this.token = j.token; this.uid = j.user.id;
  }
  connect() {
    return new Promise(res => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      this.ws.onmessage = e => this.onMsg(JSON.parse(String(e.data)));
      this.ws.onerror = () => {};
      this.ws.onopen = () => { this.send({ type: 'auth', token: this.token }); res(); };
    });
  }
  send(m) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }

  onMsg(m) {
    if (m.type === 'room.created') this.createdId = m.roomId ?? m.id ?? m.room?.id;
    if (m.type === 'room.state' || m.type === 'game.events') {
      this.room = m.room; this.lastAt = Date.now(); this.lastKind = m.type;
      this.lastEvs = (m.events || []).map(e => e.t).join(',');
      this.check(m.room); this.maybeAct(m.room);
    }
    if (m.type === 'error' && !/已经表过态|还没轮到|有胡必胡/.test(m.message || '')) bug('服务端报错', `${this.name}: ${m.message}`);
  }

  /**
   * 客户端视角的检查。
   *
   * **必须看"持续多久"，不能看单条消息。** 服务端是帧切片发的：
   * 播动画那几帧是当时的快照，里头 myOptions 被**故意**抹成 null
   *（不然旧画面上会留着点不动的按钮）—— 那是设计如此，不是 bug。
   * 一条条地判就会满屏假警报（我第一版就是这么误报的）。
   * 真正的毛病是"**一直**没回来"：所以记下从什么时候开始不对，
   * 超过 2.5 秒还没恢复才算数 —— 那也正是人眼能看出"按钮没了"的时长。
   */
  check(r) {
    const g = r.game; if (!g) return;
    if (r.mySeat !== null && this.seat !== null && r.mySeat !== this.seat)
      bug('座位漂移', `${this.name} 的座位从 ${this.seat} 变成了 ${r.mySeat} —— 重连之后接错位子`);
    if (r.mySeat !== null) this.seat = r.mySeat;
    this.last = r;
  }

  /** 每半秒按最新快照体检一次（模拟人眼看到的画面） */
  sample() {
    const r = this.last, g = r?.game;
    if (!g || g.ended || r.status !== 'playing') { this.badSince = 0; this.dlBadSince = 0; return; }
    const now = g.serverNow + (Date.now() - (this.lastAt || Date.now()));
    const mine = g.turn === r.mySeat && g.phase === 'discard';
    const hasOpts = !!g.myOptions?.options?.length;

    // ① 该我出牌、读秒还在走，却一直没有按钮
    if (mine && g.deadline > g.serverNow + 800 && !hasOpts) {
      this.badSince ||= Date.now();
      if (Date.now() - this.badSince > 2500)
        bug('按钮一直不回来', `${this.name} 该他出牌 · 最后一条消息是 ${this.lastKind}`
          + `[${this.lastEvs || '空'}]，${Date.now() - this.lastAt}ms 前收到的`
          + ` · myOptions=${JSON.stringify(g.myOptions)} · phase=${g.phase} turn=${g.turn} mySeat=${r.mySeat}`
          + ` · 空了 ${Date.now() - this.badSince}ms（重连 ${this.reconnects} 次）`);
    } else this.badSince = 0;

    // ② 读秒终点已经过去了，局面却还停在这儿 —— 客户端那个圈会一直贴着红不动
    if (g.deadline && g.deadline < g.serverNow - 2500) {
      this.dlBadSince ||= Date.now();
      if (Date.now() - this.dlBadSince > 3000)
        bug('读秒过点还不动', `${this.name} deadline 比 serverNow 早 ${g.serverNow - g.deadline}ms，`
          + `已经僵了 ${Date.now() - this.dlBadSince}ms · phase=${g.phase} turn=${g.turn}`);
    } else this.dlBadSince = 0;

    // ③ 有按钮却没期限：圈画不出来
    if (hasOpts && !g.myOptions.deadline) bug('有按钮没期限', `${this.name} 有按钮却没有 deadline`);
  }

  maybeAct(r) {
    const g = r.game; if (!g || g.ended) return;
    const opts = g.myOptions?.options; if (!opts?.length) return;
    if (this.pending) return;
    this.pending = true;
    // 真人手速：想一下再点
    setTimeout(() => {
      this.pending = false;
      const cur = this.room?.game?.myOptions?.options; if (!cur?.length) return;
      const pick = cur.find(o => o.type === 'hu') || cur.find(o => o.type === 'pao') || cur.find(o => o.type === 'ti')
        || cur.find(o => o.type === 'wei') || cur.find(o => o.type === 'discard') || cur[0];
      this.acts++;
      if (pick.type === 'discard' || pick.type === 'play_drawn') {
        /* 出牌要从**这一刻**的手牌里挑：拿旧快照里的牌会被服务端顶回
           "card not in hand" —— 那是我这个假客户端的毛病，不是服务端的。 */
        const hand = this.room?.game?.players?.[this.seat]?.hand ?? [];
        if (!hand.length) return;
        this.send({ type: 'game.act', action: pick.type, card: hand[hand.length - 1] });
      } else if (pick.type === 'chi') {
        this.send({ type: 'game.act', action: 'chi', combo: pick.combos?.[0], lay: 0 });
      } else this.send({ type: 'game.act', action: pick.type, card: pick.card });
    }, 250 + Math.random() * 600);
  }
}

// ---- 开打 ----
const humans = [new Human('甲哥'), new Human('乙妹'), new Human('丙叔')];
for (const h of humans) await h.login();
for (const h of humans) { await h.connect(); await sleep(120); }

// 游客开不了私人房：拿后台把甲哥设成能开房的（相当于线上给他配了张卡）
{
  const adm = await (await fetch(`${BASE}/api/admin/login`, { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin8888' }) })).json();
  const H = { authorization: `Bearer ${adm.token}`, 'Content-Type': 'application/json' };
  const r2 = await fetch(`${BASE}/api/admin/agent`, { method: 'POST', headers: H, body: JSON.stringify({ id: humans[0].uid, start: true }) });
  if (!r2.ok) { console.log('给开房权限失败:', await r2.text()); process.exit(1); }
  await sleep(200);
}
humans[0].send({ type: 'room.create', variant: 'hy_honghei', baseScore: 1, password: '', turnMs: 12000, autoNextSec: 2 });
await sleep(700);
const roomId = humans[0].room?.id ?? humans[0].createdId;
if (!roomId) { console.log('建房失败 —— 最后收到的消息里没有房号'); process.exit(1); }
console.log(`开了私人房 ${roomId}，三个人进去`);
// 开房的人不会自动坐下，得自己 join 一下
humans[0].send({ type: 'room.join', roomId }); await sleep(250);
humans[1].send({ type: 'room.join', roomId }); await sleep(250);
humans[2].send({ type: 'room.join', roomId }); await sleep(1200);
console.log('座位:', humans.map(h => `${h.name}=${h.room?.mySeat}`).join(' '));

// 边打边掐线：每隔几秒挑一个人断开，1~3 秒后重连（手机锁屏 / 切后台就是这样）
const RUN_MS = Number(process.env.RUN_MS || 70000);
const t0 = Date.now();
let cuts = 0;
const ROOM = roomId;
const sampler = setInterval(() => { for (const h of humans) h.sample(); }, 500);
const cutter = setInterval(async () => {
  const h = humans[Math.floor(Math.random() * humans.length)];
  cuts++;
  h.ws.close();
  h.reconnects++;
  await sleep(800 + Math.random() * 2200);
  await h.connect();
}, 6000);

while (Date.now() - t0 < RUN_MS) {
  await sleep(2000);
  const r = humans.find(h => h.room)?.room;
  process.stdout.write(`\r  第 ${r?.roundNo ?? 0} 局 · ${r?.status} · 出手 ${humans.reduce((a, h) => a + h.acts, 0)} 次 · 掐线 ${cuts} 次 · 发现 ${problems.length} 类问题   `);
}
clearInterval(cutter); clearInterval(sampler);
console.log('\n');
const r = humans.find(h => h.room)?.room;
console.log(`跑完：打到第 ${r?.roundNo} 局，房间状态 ${r?.status}，总出手 ${humans.reduce((a, h) => a + h.acts, 0)} 次，掐线 ${cuts} 次`);
if (process.env.DUMP) console.log('座位：', JSON.stringify(r?.seats?.map(s => ({ seat: s.seat, user: s.user?.nickname ?? null, ready: s.ready, online: s.online, isBot: s.isBot, auto: s.auto })), null, 0),
  '\n暂停理由：', r?.pausedReason, ' nextRoundIn:', r?.nextRoundIn);
console.log(problems.length ? `\n共 ${problems.length} 类问题：` : '\n没发现问题');
for (const p of problems) console.log(`  · [${p.kind}] ${p.detail}`);
process.exit(0);
