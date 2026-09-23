/**
 * 红中麻将牌局状态机
 *
 * 规矩（跟老板确认过的）：
 *  · 112 张，红中是赖子；四个人打，庄家 14 张，闲家 13 张。
 *  · 只能碰、杠，**不能吃**；只能自摸胡，**不点炮**。
 *  · 杠了从公牌摸一张补上。
 *  · 胡了翻公牌的下一张当马：点数即倍数，一点和红中都算 9 倍。
 *    胡分 = 底分 ×(1 + 马倍) ×(没用红中 ? 2 : 1)，三家各付全额。
 *  · 杠分当场结：明杠（含碰杠）1 倍底分，暗杠 2 倍，三家各付。
 *  · 公牌摸完＝流局，不算分。
 *
 * 一个很省事的结论：**抢牌不会撞车**。碰要手里两张、明杠要三张，
 * 同一种牌总共四张、打出去那张还占一张 —— 所以一张弃牌最多只有一个人要得起，
 * 不用像字牌那边排优先级、等表态。
 */
import { HONG, DECK_SIZE, fullDeck, nameOf, toCounts, type Tile } from './tiles.ts';
import { canHu, explain, type Meld as HuMeld } from './hu.ts';
import { DEFAULT_RULES, scoreGang, scoreHu, type MahjongRules, type HuScore } from './score.ts';

export type ActionType = 'discard' | 'peng' | 'gang' | 'hu' | 'pass';
export type Phase = 'init' | 'discard' | 'claim' | 'ended';

/** 下地的一句（碰 / 杠）。暗杠只有自己看得见牌面 */
export interface OpenMeld {
  type: 'peng' | 'gang';
  gang?: 'ming' | 'an' | 'bu';   // 明杠 / 暗杠 / 碰杠（补杠）
  tile: Tile;
  from?: number;                 // 牌是谁打出来的
}

export interface Player {
  seat: number;
  hand: Tile[];          // 手里的（不含下地的）
  melds: OpenMeld[];
  discards: Tile[];
}

export type GameEvent =
  | { t: 'deal'; hands: Tile[][]; dealer: number }
  | { t: 'draw'; seat: number; tile: Tile; left: number }
  | { t: 'discard'; seat: number; tile: Tile }
  | { t: 'peng'; seat: number; tile: Tile; from: number }
  | { t: 'gang'; seat: number; tile: Tile; kind: 'ming' | 'an' | 'bu'; from?: number; scores: number[] }
  | { t: 'pass'; seat: number; tile: Tile }
  | { t: 'hu'; seat: number; tile: Tile; ma: Tile | null; detail: HuScore | null; melds: HuMeld[] | null; scores: number[] }
  | { t: 'liuju'; reason: string }
  | { t: 'options'; seat: number; options: ActionType[]; deadline: number };

export interface GameOptions {
  rules?: MahjongRules;
  dealer?: number;
  now?: () => number;
  onEvent?: (e: GameEvent) => void;
  /** 读秒（毫秒）。0 = 不计时，全靠外面驱动 */
  turnMs?: number;
  claimMs?: number;
}

export class MahjongGame {
  readonly rules: MahjongRules;
  readonly n = 4;
  players: Player[] = [];
  /** 公牌（牌墙）：从头往外摸 */
  wall: Tile[] = [];
  /** 开局那副牌（洗好的 112 张，原样留着）。回放就靠它 + replay 重跑一遍 */
  deck: Tile[] = [];
  dealer: number;
  turn = 0;
  phase: Phase = 'init';
  ended = false;
  winner: number | null = null;
  /** 这一局各家的总输赢（**已经含杠分**） */
  scores = [0, 0, 0, 0];
  /** 其中杠分那一笔单独再记一份 —— 跟字牌那边的罚分一个路子：
      算进总计里，但纪录表和结算面板要能单独把它拎出来给人看 */
  gangScores = [0, 0, 0, 0];
  /** 刚打出来那张、还在桌上等人要的牌 */
  table: { tile: Tile; from: number } | null = null;
  /** 刚摸上来那张（自摸判定要用它） */
  drawn: Tile | null = null;
  /** 胡了之后翻出来的那张马（翻开摆在桌上，不回牌墙） */
  ma: Tile | null = null;
  events: GameEvent[] = [];
  /** 回放用：每一步真正生效的决定 */
  replay: { s: number; t: string; c?: Tile }[] = [];
  deadline = 0;
  /* 画面比服务端慢一拍：服务端一步算完就往下走，玩家那头还在放动画。
     Room 会把"这一帧要播多久"塞进 lag，新开的时限从**玩家看到**那一刻起算。
     字牌那套引擎里是同一个机制、同一个名字 —— Room 直接拿来就能用。 */
  lag = 0;
  private deadlineFresh = false;
  private turnMs: number;
  private claimMs: number;
  private now: () => number;
  private onEvent?: (e: GameEvent) => void;
  /** 这一局谁还能要桌上那张牌（碰 / 杠），以及他表过态没有 */
  private claim: { seat: number; options: ActionType[]; decided: boolean } | null = null;

  constructor(o: GameOptions = {}) {
    this.rules = o.rules ?? DEFAULT_RULES;
    this.dealer = o.dealer ?? 0;
    this.now = o.now ?? Date.now;
    this.onEvent = o.onEvent;
    this.turnMs = o.turnMs ?? 15000;
    this.claimMs = o.claimMs ?? 10000;
    this.turn = this.dealer;
    for (let s = 0; s < this.n; s++) this.players.push({ seat: s, hand: [], melds: [], discards: [] });
  }

  private emit(e: GameEvent) { this.events.push(e); this.onEvent?.(e); }
  private setDeadline(span: number) { this.deadline = this.now() + span + this.lag; this.deadlineFresh = true; }

  /**
   * 这一帧要播 ms 毫秒：把**刚开出来的**那个时限整体往后推，
   * 让玩家是从"看见"开始数秒，而不是从服务端算完开始。
   * 只推新开的（deadlineFresh），已经在走的不动 —— 不然每来一帧都续一次，时限就没边了。
   */
  freshHold(ms: number) {
    const add = this.ended ? 0 : Math.max(0, Math.min(ms, 8000));
    if (add && this.deadlineFresh && this.deadline) this.deadline += add;
    this.deadlineFresh = false;
  }
  private log(seat: number, t: string, c?: Tile) { this.replay.push(c === undefined ? { s: seat, t } : { s: seat, t, c }); }
  private next(s: number) { return (s + 1) % this.n; }

  /** 开局。deck 不给就用内置的洗牌 */
  start(deck?: Tile[], rnd: () => number = Math.random) {
    this.wall = deck && deck.length === DECK_SIZE ? deck.slice() : shuffle(fullDeck(), rnd);
    this.deck = this.wall.slice();
    for (let s = 0; s < this.n; s++) {
      const p = this.players[s];
      p.hand = this.wall.splice(0, 13);
      sortHand(p.hand);
    }
    this.emit({ t: 'deal', hands: this.players.map(p => p.hand.slice()), dealer: this.dealer });
    this.phase = 'discard';
    this.turn = this.dealer;
    this.draw(this.dealer);          // 庄家先摸一张，凑够 14
  }

  /** 摸一张。牌墙空了就流局 */
  private draw(seat: number) {
    if (!this.wall.length) { this.liuju('公牌摸完了'); return; }
    const t = this.wall.shift()!;
    this.players[seat].hand.push(t);
    sortHand(this.players[seat].hand);
    this.drawn = t;
    this.turn = seat;
    this.phase = 'discard';
    this.table = null;
    this.claim = null;
    this.setDeadline(this.turnMs);
    this.emit({ t: 'draw', seat, tile: t, left: this.wall.length });
    this.emitOptions(seat, this.turnOptions(seat));
  }

  /** 轮到我了，我能干什么 */
  turnOptions(seat: number): ActionType[] {
    const p = this.players[seat];
    const out: ActionType[] = ['discard'];
    if (canHu(p.hand, p.melds.length)) out.push('hu');
    if (this.selfGangTiles(seat).length) out.push('gang');
    return out;
  }

  /** 自己能杠哪些牌：手里四张（暗杠），或者碰过的那张又摸到（碰杠） */
  selfGangTiles(seat: number): Tile[] {
    const p = this.players[seat];
    const c = toCounts(p.hand);
    const out: Tile[] = [];
    // 红中是赖子，不参与碰杠 —— 杠掉就等于把万能牌锁死了，没人会这么打
    for (let t = 0; t < 27; t++) if (c[t] >= 4) out.push(t);
    for (const m of p.melds) if (m.type === 'peng' && c[m.tile] >= 1) out.push(m.tile);
    return out;
  }

  /** 别人打出这张，我能干什么 */
  claimOptions(seat: number, tile: Tile): ActionType[] {
    if (tile === HONG) return [];                 // 赖子不给碰不给杠
    const c = toCounts(this.players[seat].hand);
    const out: ActionType[] = [];
    if (c[tile] >= 3) out.push('gang');
    if (c[tile] >= 2) out.push('peng');
    return out;
  }

  private emitOptions(seat: number, options: ActionType[]) {
    if (options.length) this.emit({ t: 'options', seat, options, deadline: this.deadline });
  }

  // ---------- 外面调这个 ----------
  act(seat: number, type: ActionType, payload: { tile?: Tile } = {}): string | null {
    if (this.ended) return '这一局已经结束了';

    if (this.phase === 'discard') {
      if (seat !== this.turn) return '还没轮到你';
      const p = this.players[seat];
      if (type === 'hu') {
        if (!canHu(p.hand, p.melds.length)) return '还胡不了';
        this.log(seat, 'hu');
        this.doHu(seat);
        return null;
      }
      if (type === 'gang') {
        const t = payload.tile;
        if (t === undefined || !this.selfGangTiles(seat).includes(t)) return '这张杠不了';
        this.log(seat, 'gang', t);
        this.doSelfGang(seat, t);
        return null;
      }
      if (type === 'discard') {
        const t = payload.tile;
        if (t === undefined) return '得先挑一张打出去';
        const i = p.hand.indexOf(t);
        if (i < 0) return '这张不在你手里';
        p.hand.splice(i, 1);
        p.discards.push(t);
        this.drawn = null;
        this.log(seat, 'discard', t);
        this.emit({ t: 'discard', seat, tile: t });
        this.offer(t, seat);
        return null;
      }
      return '这会儿不能这么做';
    }

    if (this.phase === 'claim') {
      const cl = this.claim;
      if (!cl || cl.seat !== seat) return '没你的事';
      if (cl.decided) return '你已经表过态了';
      const tile = this.table!.tile;
      if (type === 'pass') {
        cl.decided = true;
        this.log(seat, 'pass');
        this.emit({ t: 'pass', seat, tile });
        this.afterClaim();
        return null;
      }
      if (!cl.options.includes(type)) return '这一手你做不了';
      cl.decided = true;
      if (type === 'peng') { this.log(seat, 'peng', tile); this.doPeng(seat, tile); return null; }
      if (type === 'gang') { this.log(seat, 'gang', tile); this.doMingGang(seat, tile); return null; }
      return '这会儿不能这么做';
    }
    return '这会儿不能这么做';
  }

  /** 把打出去那张挂到桌上，看有没有人要 */
  private offer(tile: Tile, from: number) {
    this.table = { tile, from };
    // 抢牌不会撞车：一张牌最多一个人要得起（见文件开头）
    for (let d = 1; d < this.n; d++) {
      const s = (from + d) % this.n;
      const opts = this.claimOptions(s, tile);
      if (opts.length) {
        this.claim = { seat: s, options: opts, decided: false };
        this.phase = 'claim';
        this.setDeadline(this.claimMs);
        this.emitOptions(s, [...opts, 'pass']);
        return;
      }
    }
    this.afterClaim();
  }

  /** 没人要 / 表完态了：轮到下家摸牌 */
  private afterClaim() {
    if (this.ended) return;
    const from = this.table?.from ?? this.turn;
    this.table = null;
    this.claim = null;
    this.draw(this.next(from));
  }

  /** 桌上那张被人要走了：从打牌那家的弃牌堆里拿掉，它已经进别人的下地牌组了 */
  private takeFromDiscards() {
    const from = this.table!.from, tile = this.table!.tile;
    const d = this.players[from].discards;
    const i = d.lastIndexOf(tile);
    if (i >= 0) d.splice(i, 1);
  }

  private doPeng(seat: number, tile: Tile) {
    const p = this.players[seat];
    this.takeFromDiscards();
    for (let k = 0; k < 2; k++) p.hand.splice(p.hand.indexOf(tile), 1);
    p.melds.push({ type: 'peng', tile, from: this.table!.from });
    this.emit({ t: 'peng', seat, tile, from: this.table!.from });
    // 碰完轮到他打牌（不摸牌）
    this.table = null; this.claim = null; this.drawn = null;
    this.turn = seat;
    this.phase = 'discard';
    this.setDeadline(this.turnMs);
    this.emitOptions(seat, this.turnOptions(seat));
  }

  private doMingGang(seat: number, tile: Tile) {
    const p = this.players[seat];
    this.takeFromDiscards();
    for (let k = 0; k < 3; k++) p.hand.splice(p.hand.indexOf(tile), 1);
    p.melds.push({ type: 'gang', gang: 'ming', tile, from: this.table!.from });
    this.payGang(seat, 'ming');
    this.emit({ t: 'gang', seat, tile, kind: 'ming', from: this.table!.from, scores: this.scores.slice() });
    this.table = null; this.claim = null;
    this.draw(seat);                 // 杠了从公牌补一张
  }

  private doSelfGang(seat: number, tile: Tile) {
    const p = this.players[seat];
    const c = toCounts(p.hand);
    const bu = p.melds.find(m => m.type === 'peng' && m.tile === tile);
    if (c[tile] >= 4) {
      for (let k = 0; k < 4; k++) p.hand.splice(p.hand.indexOf(tile), 1);
      p.melds.push({ type: 'gang', gang: 'an', tile });
      this.payGang(seat, 'an');
      this.emit({ t: 'gang', seat, tile, kind: 'an', scores: this.scores.slice() });
    } else if (bu) {
      p.hand.splice(p.hand.indexOf(tile), 1);
      bu.type = 'gang'; bu.gang = 'bu';
      this.payGang(seat, 'bu');     // 碰杠跟明杠一个价
      this.emit({ t: 'gang', seat, tile, kind: 'bu', scores: this.scores.slice() });
    } else return;
    this.draw(seat);
  }

  private payGang(seat: number, kind: 'ming' | 'an' | 'bu') {
    const { perPlayer } = scoreGang(kind, this.n - 1, this.rules);
    for (let s = 0; s < this.n; s++) if (s !== seat) {
      this.scores[s] -= perPlayer; this.scores[seat] += perPlayer;
      this.gangScores[s] -= perPlayer; this.gangScores[seat] += perPlayer;
    }
  }

  private doHu(seat: number) {
    const p = this.players[seat];
    const melds = explain(p.hand, p.melds.length);
    const hongUsed = p.hand.filter(t => t === HONG).length;
    // 翻马：公牌里的下一张。牌正好摸完的话就没马可翻了
    const ma = this.wall.length ? this.wall.shift()! : null;
    this.ma = ma;
    const detail = ma === null ? null : scoreHu(ma, hongUsed, this.n - 1, this.rules);
    const per = detail
      ? detail.perPlayer
      // 没马可翻：只剩胡牌本身那一倍（无中胡照样翻倍）
      : this.rules.baseScore * (hongUsed === 0 ? this.rules.noHongMultiplier : 1);
    for (let s = 0; s < this.n; s++) if (s !== seat) { this.scores[s] -= per; this.scores[seat] += per; }
    this.winner = seat;
    this.ended = true;
    this.phase = 'ended';
    this.emit({ t: 'hu', seat, tile: this.drawn ?? -1, ma, detail, melds, scores: this.scores.slice() });
  }

  private liuju(reason: string) {
    this.ended = true;
    this.phase = 'ended';
    this.emit({ t: 'liuju', reason });
  }

  /** 超时驱动：到点了替他做个最省事的决定 */
  tick(now = this.now()): boolean {
    if (this.ended || now < this.deadline) return false;
    if (this.phase === 'claim' && this.claim && !this.claim.decided) {
      this.act(this.claim.seat, 'pass');
      return true;
    }
    if (this.phase === 'discard') {
      const p = this.players[this.turn];
      // 到点不替他胡（胡不胡是人自己的选择），随手打一张出去
      const t = p.hand[p.hand.length - 1];
      if (t !== undefined) { this.act(this.turn, 'discard', { tile: t }); return true; }
    }
    return false;
  }

  /**
   * 这个座位这会儿能干什么（Room 拿它排机器人、也发给客户端画按钮）。
   * 形状照着字牌那套来，Room 那边的调度代码不用改。
   */
  optionsFor(seat: number | null): { options: ActionType[]; deadline: number; span?: number } | null {
    if (seat === null || this.ended) return null;
    if (this.phase === 'discard' && seat === this.turn)
      return { options: this.turnOptions(seat), deadline: this.deadline, span: this.turnMs };
    if (this.phase === 'claim' && this.claim && this.claim.seat === seat && !this.claim.decided)
      return { options: [...this.claim.options, 'pass'], deadline: this.deadline, span: this.claimMs };
    return null;
  }

  /** 超时 / 托管时替他挑一张打出去。挑的是最没用的那张，但绝不打红中 */
  autoDiscardCard(seat: number): Tile {
    const h = this.players[seat].hand;
    for (let i = h.length - 1; i >= 0; i--) if (h[i] !== HONG) return h[i];
    return h[h.length - 1];       // 满手红中这种事不会发生，兜个底
  }

  /** 发给客户端的视角：别人的手牌看不见，暗杠只露张数 */
  view(seat: number | null) {
    /* 把"这会儿能干什么"一起发下去。
       字牌那边是靠 options 事件推给客户端的，麻将这套没有帧切片，
       每次广播都是一张完整快照 —— 按钮该亮哪些直接写在快照里最省事，
       客户端也不用自己攒状态、不会出现"重连之后按钮没了"。 */
    const opt = seat === null ? null : this.optionsFor(seat);
    return {
      options: opt?.options ?? [], optionsSpan: opt?.span ?? 0,
      /** 桌上那张牌能碰 / 杠的话，按钮打在哪张牌上 */
      claimTile: this.phase === 'claim' ? this.table?.tile ?? null : null,
      gangTiles: seat !== null && this.phase === 'discard' && this.turn === seat ? this.selfGangTiles(seat) : [],
      phase: this.phase, turn: this.turn, dealer: this.dealer,
      wallLeft: this.wall.length, table: this.table, ma: this.ma, scores: this.scores.slice(),
      winner: this.winner, deadline: this.deadline,
      players: this.players.map(p => ({
        seat: p.seat,
        hand: seat === p.seat || this.ended ? p.hand.slice() : null,
        handCount: p.hand.length,
        melds: p.melds.map(m => ({ ...m, tile: m.gang === 'an' && seat !== p.seat && !this.ended ? -1 : m.tile })),
        discards: p.discards.slice(),
      })),
    };
  }

  /** 把这一局的 112 张收回来点一遍 —— 出过一次错就知道这个有多值 */
  collect(): Tile[] {
    const out: Tile[] = [...this.wall];
    for (const p of this.players) {
      out.push(...p.hand, ...p.discards);
      for (const m of p.melds) for (let k = 0; k < (m.type === 'gang' ? 4 : 3); k++) out.push(m.tile);
    }
    // 桌上那张**不单独数**：它打出去的时候就进了弃牌堆，被人要走时才从那儿挪走。
    // 两头都数就成了 113 张 —— 这正是 collect 这个函数存在的意义。
    // 翻出来的马是从牌墙里抽走的，得补回来数上，不然少一张。
    if (this.ma !== null) out.push(this.ma);
    return out;
  }
}

function sortHand(h: Tile[]) { h.sort((a, b) => a - b); }
function shuffle(a: Tile[], rnd: () => number): Tile[] {
  const d = a.slice();
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
export { nameOf };
