/**
 * 红中麻将的房间。
 *
 * **这是跟 `room.ts`（跑胡子）并列的另一套**，不是它的子类，也不共用代码。
 * 两种玩法的帧节奏、结算字段、报牌声、甚至"一局里结算几次"都不一样，
 * 硬凑成一个通用 Room 的话，改任何一边都要提心吊胆看另一边。
 * 分开写的代价是座位 / 记账 / 托管那几段是各写各的 —— 认了，
 * 换来的是**改哪个玩法就只动哪个文件**。
 *
 * 跟 room.ts 的对应关系（要改的时候照着找）：
 *   Room.startRound  ↔ MahjongRoom.startRound
 *   Room.settle      ↔ MahjongRoom.settle
 *   Room.scheduleBots↔ MahjongRoom.scheduleBots
 *   Room.view        ↔ MahjongRoom.view
 */
import { MahjongGame, decideTurn, decideClaim, DEFAULT_RULES, nameOf,
  type MahjongRules, type GameEvent, type ActionType, type Tile } from '../../packages/mahjong/src/index.ts';
import type { DB, UserRow } from './db.ts';
import type { PublicUser, RoomView, SeatView, LedgerEntry, ServerMsg } from './protocol.ts';

export interface Client { send(msg: ServerMsg): void; userId: number; rtt?: number }

interface Seat {
  userId: number | null;
  isBot: boolean;
  ready: boolean;
  client: Client | null;
  botName?: string;
  botAt?: number;
  /** 真人超时、暂时交给机器人替打；他一动手就解除 */
  autoBot?: boolean;
  misses?: number;
  seatedAt?: number;
  stood?: boolean;
}

const BOT_NAMES = ['老李', '阿英', '满哥', '细妹', '胖子', '刘叔', '春花', '二毛', '德哥', '小周'];
let botSeq = -1;

export interface MjRoomConfig {
  id: string;
  isPrivate: boolean;
  baseScore: number;
  password?: string;
  hostId?: number;
  name?: string;
  turnSec?: number;
  claimSec?: number;
  autoNextMs?: number;
  /** 机器人水平 0~1，见 bot.ts。不填用量出来的默认值 */
  botStrength?: number;
  botThink?: boolean;
  rules?: Partial<MahjongRules>;
  /** 取时间的函数。默认 Date.now —— 留这个口子是为了能拿虚拟时钟跑用例：
      读秒动辄十几秒，真等的话一条用例要跑几分钟。引擎那边也是同一个做法。 */
  now?: () => number;
}

/** 这个玩法的 id。protocol 里的 VariantId 是字牌那几个，这儿先按字符串走，
    接进大厅的时候再统一放宽（那是下一步的事，现在动它会牵一大片） */
export const MJ_VARIANT = 'mj_hongzhong';
export const MJ_NAME = '红中麻将';

export class MahjongRoom {
  cfg: MjRoomConfig;
  rules: MahjongRules;
  seats: Seat[] = [];
  status: 'waiting' | 'playing' | 'paused' | 'closed' = 'waiting';
  game: MahjongGame | null = null;
  roundNo = 0;
  dealer = 0;
  ledger: LedgerEntry[] = [];
  totals = new Map<number, number>();
  users = new Map<number, PublicUser>();
  private nameBook = new Map<number, string>();
  spectators = new Map<number, Client>();
  nextRoundAt: number | null = null;
  pausedReason: string | null = null;
  /** Lobby 靠它回收空房（跟 Room 同名同义） */
  lastActivity = Date.now();
  onClosed?: (r: MahjongRoom) => void;
  private db: DB;
  private now: () => number;
  /** 这一局的座位上都坐过谁（中途换人时纪录表要看得出来） */
  private roundSeatUsers: number[][] = [];
  private settledRound = -1;

  constructor(cfg: MjRoomConfig, db: DB) {
    this.cfg = cfg;
    this.db = db;
    this.now = cfg.now ?? Date.now;
    this.rules = { ...DEFAULT_RULES, baseScore: cfg.baseScore, ...(cfg.rules ?? {}) };
    this.seats = Array.from({ length: 4 }, () => ({ userId: null, isBot: false, ready: false, client: null }));
  }

  // ---------- 人 ----------
  publicUser(u: UserRow): PublicUser {
    return { id: u.id, nickname: u.nickname, avatar: u.avatar, kind: u.kind as any, vip: !!u.vip, points: u.points };
  }
  private remember(u: PublicUser) { this.users.set(u.id, u); this.nameBook.set(u.id, u.nickname); }
  private nameOfUser(id: number | null | undefined): string | null {
    if (id === null || id === undefined) return null;
    return this.users.get(id)?.nickname ?? this.nameBook.get(id) ?? null;
  }
  seatOf(userId: number) { return this.seats.findIndex(s => s.userId === userId); }
  filledCount() { return this.seats.filter(s => s.userId !== null).length; }
  humanCount() { return this.seats.filter(s => s.userId !== null && !s.isBot).length; }

  join(user: UserRow, client: Client, password?: string): string | null {
    if (this.status === 'closed') return '房间已关闭';
    if (this.cfg.isPrivate && this.cfg.password && password !== this.cfg.password) return '房间密码不对';
    const had = this.seatOf(user.id);
    if (had >= 0) {                       // 回来了：坐回原位
      const s = this.seats[had];
      s.client = client; s.isBot = false; s.autoBot = false; s.misses = 0; s.stood = false;
      s.seatedAt ??= this.now();
      this.remember(this.publicUser(user));
      this.broadcast();
      return null;
    }
    let idx = this.seats.findIndex(s => s.userId === null);
    if (idx < 0 && this.status !== 'playing') idx = this.seats.findIndex(s => s.isBot && (s.userId ?? 0) < 0);
    if (idx < 0) return '房间已满';
    const old = this.seats[idx].userId;
    if (old !== null && old < 0) this.users.delete(old);
    this.seats[idx] = { userId: user.id, isBot: false, ready: true, client, seatedAt: this.now() };
    this.remember(this.publicUser(user));
    if (!this.totals.has(user.id)) this.totals.set(user.id, 0);
    if (this.game && !this.game.ended) {
      const h = this.roundSeatUsers[idx] ?? (this.roundSeatUsers[idx] = []);
      if (h[h.length - 1] !== user.id) h.push(user.id);
    }
    this.broadcast();
    return null;
  }

  leave(userId: number, reason: 'leave' | 'disconnect' | 'stand' = 'leave') {
    const i = this.seatOf(userId);
    if (i < 0) { this.spectators.delete(userId); return; }
    const s = this.seats[i];
    if (this.status === 'playing') {
      // 牌局进行中：位子留着，机器人替他打完这一局
      s.isBot = true; s.client = null; s.autoBot = true;
      if (reason === 'stand') s.stood = true;
      this.scheduleBots();
    } else {
      this.seats[i] = { userId: null, isBot: false, ready: false, client: null };
    }
    this.broadcast();
  }

  addBot(seatIdx: number) {
    botSeq = (botSeq + 1) % BOT_NAMES.length;
    const id = -(this.now() % 1000000) * 10 - seatIdx - 1;
    const name = BOT_NAMES[botSeq];
    this.seats[seatIdx] = { userId: id, isBot: true, ready: true, client: null, botName: name };
    this.remember({ id, nickname: name, avatar: `bot:${botSeq}`, kind: 'bot' as any, vip: false, points: 0 });
    if (!this.totals.has(id)) this.totals.set(id, 0);
  }

  fillBots() { for (let i = 0; i < 4; i++) if (this.seats[i].userId === null) this.addBot(i); }

  // ---------- 一局 ----------
  canStart() { return this.filledCount() === 4 && this.seats.every(s => s.ready); }

  start(byUserId?: number): string | null {
    if (this.status === 'playing') return '已经开始';
    if (this.cfg.isPrivate && byUserId !== undefined && this.cfg.hostId !== undefined
      && byUserId !== this.cfg.hostId && this.roundNo === 0 && this.seatOf(this.cfg.hostId) >= 0)
      return '只有房主可以开始';
    if (this.filledCount() < 4) return '人数不够';
    this.startRound();
    return null;
  }

  private startRound() {
    this.roundNo++;
    this.status = 'playing';
    this.nextRoundAt = null;
    this.game = new MahjongGame({
      rules: this.rules, dealer: this.dealer,
      now: this.now,
      turnMs: (this.cfg.turnSec ?? 15) * 1000,
      claimMs: (this.cfg.claimSec ?? 10) * 1000,
      onEvent: e => this.onGameEvent(e),
    });
    this.roundSeatUsers = this.seats.map(s => (s.userId !== null ? [s.userId] : []));
    this.game.start();
    for (const s of this.seats) { s.ready = true; s.misses = 0; }
    this.scheduleBots();
    this.broadcast();
  }

  private onGameEvent(e: GameEvent) {
    // 麻将的画面比字牌简单得多（没有下伙牌组、没有同时下龙），
    // 所以不做帧切片，事件照原样往下发，客户端自己排动画。
    if (e.t === 'hu' || e.t === 'liuju') this.settle();
  }

  // ---------- 动作 ----------
  act(userId: number, action: ActionType, payload?: { tile?: Tile }): string | null {
    const i = this.seatOf(userId);
    if (i < 0) return '你不在这一桌';
    if (!this.game || this.game.ended) return '这会儿没在打牌';
    this.wake(userId);
    const err = this.game.act(i, action, payload ?? {});
    if (!err) { this.scheduleBots(); this.broadcast(); }
    return err;
  }

  /** 人回来了：机器人退下 */
  wake(userId: number) {
    const i = this.seatOf(userId);
    if (i < 0) return;
    const s = this.seats[i];
    if (s.autoBot && s.client) { s.autoBot = false; s.isBot = false; s.misses = 0; }
  }

  private scheduleBots() {
    const g = this.game;
    if (!g || g.ended) return;
    const now = this.now();
    for (let i = 0; i < 4; i++) {
      const s = this.seats[i];
      const isBot = s.isBot || s.autoBot;
      if (!isBot || !g.optionsFor(i)) { s.botAt = undefined; continue; }
      if (s.botAt === undefined) {
        const t = this.cfg.turnSec ?? 15;
        s.botAt = now + (this.cfg.botThink ? Math.round(t * 80 + Math.random() * t * 40) : 0);
      }
    }
  }

  /** 由外面每 50ms 叫一次 */
  tick() {
    const g = this.game;
    if (this.status === 'closed') return;
    if (g && !g.ended) {
      const now = this.now();
      for (let i = 0; i < 4; i++) {
        const s = this.seats[i];
        if (s.botAt === undefined || now < s.botAt) continue;
        const opts = g.optionsFor(i);
        if (!opts) { s.botAt = undefined; continue; }
        s.botAt = undefined;
        const st = this.cfg.botStrength;
        if (g.phase === 'claim') {
          const tile = (g as any).table?.tile as Tile | undefined;
          if (tile === undefined) continue;
          const d = decideClaim(g, i, tile, opts.options.filter(o => o !== 'pass'));
          g.act(i, d, { tile });
        } else {
          const d = decideTurn(g, i, st);
          g.act(i, d.type, { tile: d.tile });
        }
        this.scheduleBots();
        this.broadcast();
        return;
      }
      // 真人超时：第二回才交给机器人（头一回可能只是走开倒杯水）
      if (g.tick(now)) {
        const seat = g.phase === 'claim' ? (g as any).claim?.seat : g.turn;
        const s = this.seats[seat ?? -1];
        if (s && !s.isBot) { s.misses = (s.misses ?? 0) + 1; if (s.misses >= 2) s.autoBot = true; }
        this.scheduleBots();
        this.broadcast();
      }
      return;
    }
    // 一局打完了：歇一会儿开下一局
    if (this.status === 'playing' && g?.ended) {
      this.nextRoundAt ??= this.now() + (this.cfg.autoNextMs ?? 7000);
      if (this.now() >= this.nextRoundAt) { this.closeRound(); }
    }
  }

  // ---------- 结算 ----------
  private settle() {
    const g = this.game;
    if (!g || this.settledRound === this.roundNo) return;
    this.settledRound = this.roundNo;
    const ownerOf = (i: number) => this.roundSeatUsers[i]?.[0] ?? this.seats[i].userId;
    const deltas: Record<number, number> = {};
    for (let i = 0; i < 4; i++) {
      const uid = ownerOf(i);
      if (uid === null || uid === undefined) continue;
      deltas[uid] = g.scores[i];
      this.totals.set(uid, (this.totals.get(uid) ?? 0) + g.scores[i]);
      if (uid > 0) {
        const hu = g.winner === i;
        this.db.bumpStats(uid, { games: 1, wins: hu ? 1 : 0, hu: hu ? 1 : 0, zimo: hu ? 1 : 0,
          points_won: g.scores[i] > 0 ? g.scores[i] : 0, points_lost: g.scores[i] < 0 ? -g.scores[i] : 0 });
        if (!this.cfg.isPrivate && g.scores[i] !== 0) this.db.addPoints(uid, g.scores[i], `mj:${this.cfg.id}:${this.roundNo}`);
      }
    }
    const huEv = g.events.find(e => e.t === 'hu') as Extract<GameEvent, { t: 'hu' }> | undefined;
    const entry: LedgerEntry = {
      round: this.roundNo,
      variant: MJ_VARIANT as any,        // 见 MJ_VARIANT 的注释
      winner: g.winner !== null ? (ownerOf(g.winner) ?? null) : null,
      deltas, time: this.now(),
      hu: huEv ? ({
        seat: huEv.seat, card: huEv.tile, ziMo: true, fromSeat: huEv.seat,
        detail: { ma: huEv.ma, maName: huEv.ma === null ? '没马可翻' : nameOf(huEv.ma),
          breakdown: huEv.detail?.breakdown ?? ['牌摸完了，没马可翻'],
          noHong: huEv.detail?.noHong ?? false, melds: huEv.melds, scores: g.scores.slice() },
      } as any) : null,
      seatNames: this.seats.map((_, i) => this.nameOfUser(ownerOf(i)) ?? `座位${i + 1}`),
      /* 杠分：算进总计了，这儿再单独留一份给纪录表拎出来看 —— 跟字牌的罚分一个路子 */
      penalty: g.gangScores.slice(),
      subs: this.roundSeatUsers.map((ids, seat) => ({ seat, names: ids.map(id => this.nameOfUser(id) ?? `#${Math.abs(id)}`) }))
        .filter(x => x.names.length > 1),
      names: (() => {
        const m: Record<number, string> = {};
        for (const id of new Set(this.roundSeatUsers.flat())) { const n = this.nameOfUser(id); if (n) m[id] = n; }
        return m;
      })(),
      reveal: {
        hands: g.players.map(p => p.hand.slice()),
        melds: g.players.map(p => p.melds.map(m => ({ ...m, hidden: false }))),
        pileRest: g.wall.slice(),
        winner: g.winner,
      } as any,
    };
    this.ledger.push(entry);
    this.db.recordRound(this.cfg.id, MJ_VARIANT, this.cfg.isPrivate,
      entry.winner !== null && entry.winner > 0 ? entry.winner : null,
      { ...entry, roomName: this.cfg.name ?? this.cfg.id, detail: huEv ?? null,
        replay: { dealer: g.dealer, deck: g.deck, steps: g.replay } },
      [...new Set(this.roundSeatUsers.flat())].filter((id): id is number => id !== null && id > 0),
      this.cfg.hostId ?? null);
  }

  /** 收尾：换庄、清走起立的人、排下一局 */
  private closeRound() {
    // 庄家胡了连庄，别人胡了下家坐庄（流局也下家坐庄）
    const g = this.game;
    if (g && g.winner !== null && g.winner !== this.dealer) this.dealer = (this.dealer + 1) % 4;
    else if (g && g.winner === null) this.dealer = (this.dealer + 1) % 4;
    for (let i = 0; i < 4; i++) {
      const s = this.seats[i];
      if (s.stood || (s.autoBot && !s.client)) this.seats[i] = { userId: null, isBot: false, ready: false, client: null };
    }
    this.game = null;
    this.status = 'waiting';
    this.nextRoundAt = null;
    if (this.filledCount() < 4 && this.humanCount() > 0) this.fillBots();
    if (this.canStart()) this.startRound(); else this.broadcast();
  }

  // ---------- 视图 ----------
  view(forUserId: number | null): RoomView {
    const mySeat = forUserId === null ? -1 : this.seatOf(forUserId);
    const g = this.game;
    const seats: SeatView[] = this.seats.map((s, i) => ({
      seat: i,
      user: s.userId === null ? null : (this.users.get(s.userId) ?? null),
      ready: s.ready,
      online: !!s.client,
      isBot: s.isBot,
      kickable: s.isBot && (s.userId ?? 0) < 0,
      auto: !!s.autoBot,
      total: s.userId === null ? 0 : (this.totals.get(s.userId) ?? 0),
    }));
    return {
      id: this.cfg.id, isPrivate: this.cfg.isPrivate,
      variant: MJ_VARIANT as any, variantName: MJ_NAME,
      baseScore: this.cfg.baseScore, hostId: this.cfg.hostId ?? null,
      status: this.status, seats, roundNo: this.roundNo,
      mySeat: mySeat >= 0 ? mySeat : null,
      game: g ? { ...g.view(mySeat >= 0 ? mySeat : null), serverNow: this.now(), nextRoundAt: this.nextRoundAt } : null,
      ledger: this.ledger.slice(-20), ledgerCount: this.ledger.length,
      name: this.cfg.name,
      nextRoundAt: this.nextRoundAt,
      pausedReason: this.pausedReason,
      canResume: true,
      config: { turnSec: this.cfg.turnSec ?? 15, autoNextSec: Math.round((this.cfg.autoNextMs ?? 7000) / 1000), swingCap: 0 },
    };
  }

  private touch() { this.lastActivity = this.now(); }

  broadcast() {
    this.touch();
    for (const s of this.seats) if (s.client) s.client.send({ type: 'room.state', room: this.view(s.userId) } as any);
    for (const [uid, c] of this.spectators) c.send({ type: 'room.state', room: this.view(uid) } as any);
  }

  // ---------- index.ts 会调的那几个：方法名跟 Room 对齐，不然路由那边要为两种房间各写一遍 ----------

  setReady(userId: number, ready: boolean) {
    const i = this.seatOf(userId);
    if (i < 0) return;
    this.seats[i].ready = ready;
    this.broadcast();
  }

  /** 断线重连要不要把他送回这一桌 —— 语义照 Room 来 */
  resumable(userId: number) {
    if (this.status === 'closed') return false;
    const i = this.seatOf(userId);
    if (i < 0 || this.seats[i].stood) return false;
    if (this.status === 'playing' && this.game && !this.game.ended) return true;
    return !this.cfg.isPrivate;
  }

  spectate(user: UserRow, client: Client): string | null {
    if (this.status === 'closed') return '房间已关闭';
    if (this.cfg.hostId !== user.id) return '只有房主可以观战';
    if (this.seatOf(user.id) >= 0) return '你已经在座位上了';
    this.spectators.set(user.id, client);
    this.remember(this.publicUser(user));
    client.send({ type: 'room.state', room: this.view(user.id) } as any);
    return null;
  }
  unspectate(userId: number) { this.spectators.delete(userId); }

  canResume(userId: number) { return this.cfg.hostId === userId || this.captainId() === userId; }
  /** 桌长：桌上最早坐下的那个真人 */
  captainId(): number | null {
    const live = this.seats.filter(s => s.userId !== null && s.userId > 0 && !s.isBot);
    if (!live.length) return null;
    return live.sort((a, b) => (a.seatedAt ?? 0) - (b.seatedAt ?? 0))[0].userId;
  }

  hostPause(reason = '房主暂停了牌局') { this.pausedReason = reason; this.status = 'paused'; this.broadcast(); }
  hostResume(userId: number): string | null {
    if (!this.canResume(userId)) return '只有房主或桌长可以继续';
    this.pausedReason = null;
    if (this.status === 'paused') this.status = this.game && !this.game.ended ? 'playing' : 'waiting';
    this.broadcast();
    return null;
  }

  /** 房主强行把这一局作废（不算分），直接开下一局 */
  abortRound(userId: number): string | null {
    if (this.cfg.hostId !== userId) return '只有房主可以作废这一局';
    if (!this.game || this.game.ended) return '这会儿没在打牌';
    this.settledRound = this.roundNo;   // 别让它再结算一次
    this.game = null;
    this.status = 'waiting';
    this.nextRoundAt = null;
    if (this.canStart()) this.startRound(); else this.broadcast();
    return null;
  }

  setName(name: string) { this.cfg.name = name.trim().slice(0, 16) || undefined; this.broadcast(); }
  /** 房主在「我的房间」里点开始 */
  hostStart() { this.pausedReason = null; if (this.status === 'paused') this.status = 'waiting'; if (this.canStart()) this.startRound(); else this.broadcast(); }

  setTurnSec(sec: number) { this.cfg.turnSec = Math.max(5, Math.min(120, Math.floor(sec))); this.broadcast(); }

  /** 清空这个房间的账（纪录表、总计一起清） */
  clearData() {
    this.ledger = [];
    this.totals = new Map([...this.totals.keys()].map(k => [k, 0]));
    this.roundNo = 0;
    this.settledRound = -1;
    this.broadcast();
  }

  bots(add: boolean, seat?: number): string | null {
    if (this.status === 'playing') return '牌局进行中，等这一局打完';
    if (add) {
      if (seat !== undefined) { if (this.seats[seat]?.userId !== null) return '这个位子有人'; this.addBot(seat); }
      else this.fillBots();
    } else {
      for (let i = 0; i < 4; i++) {
        if (seat !== undefined && i !== seat) continue;
        const s = this.seats[i];
        if (s.isBot && (s.userId ?? 0) < 0) this.seats[i] = { userId: null, isBot: false, ready: false, client: null };
      }
    }
    this.broadcast();
    return null;
  }

  kick(byUserId: number, seatIdx: number): string | null {
    if (this.cfg.hostId !== byUserId) return '只有房主可以请人下桌';
    const s = this.seats[seatIdx];
    if (!s || s.userId === null) return '这个位子没人';
    if (this.status === 'playing') return '牌局进行中，等这一局打完';
    this.seats[seatIdx] = { userId: null, isBot: false, ready: false, client: null };
    this.broadcast();
    return null;
  }

  close(force = false) {
    if (!force && this.status === 'playing') return;
    this.status = 'closed';
    this.broadcast();
    this.onClosed?.(this);
  }
}
