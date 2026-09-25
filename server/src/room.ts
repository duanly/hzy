import { Game, getRules, botDecide, riffleShuffle, type RuleSet, type VariantId, type GameEvent, type ActionType, type Kind } from '../../packages/engine/src/index.ts';
import type { DB, UserRow } from './db.ts';
import type { PublicUser, RoomView, SeatView, LedgerEntry, LedgerBatch, PlayOpts, ServerMsg } from './protocol.ts';

export interface Client {
  send(msg: ServerMsg): void;
  userId: number;
  /** 这条连接最近量到的往返延迟（毫秒）：客户端 ping 里带上来的。量不到就是 0 */
  rtt?: number;
}

interface Seat {
  userId: number | null;
  isBot: boolean;
  ready: boolean;
  client: Client | null;
  botName?: string;
  botAt?: number;    // 机器人下一次行动时间
  /** 真人超时（延时卡也用完了）：暂时由机器人替他打牌。他自己一动手（点按钮 / 理牌）就解除 */
  autoBot?: boolean;
  /** 连着超时几回了：**第二回**才交给机器人 —— 头一回可能只是走开倒个水 */
  misses?: number;
  /* 刚（重）连上来、而这会儿还有帧没播完：这一批剩下的帧**不要发给他**。
     他手里没有任何底子，那些帧是"当时的快照"、里头 myOptions 是被故意抹掉的
     —— 发过去只会让他眼睁睁看着自己该出牌却一个按钮都没有。见 sendFrames。 */
  freshJoin?: boolean;
  awayAt?: number;   // 玩家中途退出、交给机器人托管的时刻（回来可以接着打）
  vacatedAt?: number;   // 这个位子什么时候空出来的：补位按先后，谁先走空谁先被接
  /** 他什么时候坐下的：桌上最早坐下的那个真人就是「桌长」（几局一歇时由他点继续） */
  seatedAt?: number;
  /** 他**主动起立**走的（不是断线、也不是暂时离开）：这一局打完就真让出去，
      重连也不再把他送回来。没这个标记的就是"人还没走远"，随时接着打。 */
  stood?: boolean;
}

const BOT_NAMES = ['老李', '阿英', '满哥', '细妹', '胖子', '刘叔', '春花', '二毛', '德哥', '小周'];
let botSeq = -1;

export interface RoomConfig {
  id: string;
  isPrivate: boolean;
  variant: VariantId;
  baseScore: number;
  password?: string;
  hostId?: number;
  tier?: string;
  botFillDelayMs?: number;   // 大厅：等待多久后用机器人补位
  fixed?: boolean;           // 大厅固定桌：不会被关闭，人走光了就重置回空桌
  name?: string;             // 桌名 / 房名
  turnSec?: number;          // 每步读秒（房主设置，后台也能看）
  autoNextMs?: number;       // 一局结束到下一局的间隔
  swingCap?: number;         // 总输赢（任意一家的累计分绝对值）达到这个数就自动暂停；0 / 不填 = 不限
  /** 几局一歇：每打满这么多局就暂停一次，等桌上的人点「继续」。0 / 不填 = 一直打下去 */
  pauseEvery?: number;
  botThink?: boolean;        // 机器人要不要装作在想（随机停一下）；不填 = 不装，轮到就出手
  ruleOverride?: Partial<RuleSet>;
  /** 开房时挑的玩法开关（大厅不填 = 按玩法默认，全开 + 新牌轮流发） */
  play?: PlayOpts;
}

export class Room {
  cfg: RoomConfig;
  rules: RuleSet;
  seats: Seat[];
  game: Game | null = null;
  status: RoomView['status'] = 'waiting';
  roundNo = 0;
  dealer = 0;
  ledger: LedgerEntry[] = [];
  /** 这一间房里各人的战况：打了几局、胡了几把、点了几炮（房主在「我的房间」里看） */
  roomStats = new Map<number, { games: number; hu: number; dianpao: number }>();
  totals = new Map<number, number>();
  /* 上一局打完收拢的那 80 张牌（照牌桌上的样子：下地的牌组、弃牌堆、各家手牌、没翻出来的牌堆）。
     下一局拿它接着洗 —— 跟真人打牌一样，不是每局重新发一副全新的牌。 */
  private carryDeck: Kind[] | null = null;
  /* 账本分批：座位上的人换了，就把上一批的总计封存成一行（第一批、第二批…），
     桌面上那本账永远只有当下这三个人的三列。
     之前来过的人再回来，他那一笔从封存的批次里**提出来**接着算（见 openBatch）。 */
  batches: LedgerBatch[] = [];
  /** 离桌的人各自带走的总账（userId → 总输赢）。他回来了就从这儿"提出来"接着算 */
  gone = new Map<number, number>();
  /** 当前这一批是哪几个真人（排过序的 userId）：跟它一比就知道有没有换人 */
  private batchRoster = '';
  private batchNo = 0;
  /** 当下这一批是从第几局开始的（这一局之后的都算这一批） */
  private batchFrom = 0;
  /** 这一批开局那会儿各人已经有多少分：`totals - batchStart` 就是这一批自己打下来的小计 */
  private batchStart = new Map<number, number>();
  /** 这一批坐着的是哪几位（按座位，含机器人）：封存的时候当那一段的表头 */
  private batchSeats: number[] = [];
  users = new Map<number, PublicUser>();
  /* 名字册：只进不出。房间里的 users 是"现在还在这儿的人"，人一走就删 ——
     于是纪录表、结算详情事后去查名字，只剩一串 userId（机器人是负数，更难看）。
     这本册子记着每个坐过这张桌的人当时叫什么，谁走了都还在。 */
  private nameBook = new Map<number, string>();
  /** 这个人叫什么：先看现在还在不在，不在就翻名字册 */
  private nameOf(id: number | null | undefined): string | null {
    if (id === null || id === undefined) return null;
    return this.users.get(id)?.nickname ?? this.nameBook.get(id) ?? null;
  }
  /** users.set 的同时记一笔名字，别让它跟着人一起消失 */
  private remember(u: PublicUser) { this.users.set(u.id, u); this.nameBook.set(u.id, u.nickname); }
  /** 人已经不在房里了：照名字册拼一个只够显示的身份（负数 id 是机器人） */
  private fallbackUser(id: number): PublicUser | null {
    const nickname = this.nameBook.get(id);
    if (!nickname) return null;
    return { id, nickname, avatar: id < 0 ? 'bot:0' : 'avatar:0', kind: id < 0 ? 'bot' : 'user', vip: false, points: 0 };
  }
  createdAt = Date.now();
  pausedReason: string | null = null;
  /** 本局每个座位坐过的人（按先后）：中途换人时用来记"谁接了谁的位子" */
  roundSeatUsers: number[][] = [];          // 自动暂停的原因（封顶暂停时前端挂红色横幅）
  spectators = new Map<number, Client>();      // 房主观战：不占座位，只看下地牌和弃牌
  lastActivity = Date.now();
  private eventCursor = 0;
  // ---- 按轮次切片播放：服务端自动连着跑完的一串动作，切成一帧一帧、中间留出动画时间发给客户端 ----
  private frames: { evs: GameEvent[]; delay: number; gviews: any[]; evAt: number }[] = [];   // 待发送的帧（含当时各座位的牌局快照）
  private cur: GameEvent[] = [];                                // 正在攒的这一帧
  private frameAt = 0;                                          // 下一帧的发送时间
  private holdUntil = 0;                                        // 全部帧发完的时间：机器人在这之前不动手
  /** 每个动作在画面上占的时长。**必须跟 web/src/Table.tsx 的 EV_MS 一一对上。**
      这张表是"玩家看到这一步要花多久"的唯一依据：行动窗口的时限就是按它往后推的
      （见 syncLag / game.lag）。服务端估短了，窗口就会在玩家还没看到那张牌之前
      先开始读秒 —— 碰、胡那种半程的窗口本来就短，差个几百毫秒就够人错过一手。
      以前这儿 meld 写 850（客户端是 1000）、pass 干脆没有（客户端 150）：
      一步差一点，连着几步就差出一大截。 */
  private static ANIM: Record<string, number> = {
    deal: 250, draw: 650, discard: 600, play_drawn: 600, dead: 900, dealer_card: 2400,
    meld: 1000, bupai: 200, pass: 150, penalty: 700, tilong_score: 400, hu: 600,
  };
  /** 一帧到此为止：这些动作各自是一个"看得见的步骤" */
  /** 客户端最多允许落后服务端多久（毫秒）。见 flush() 里"动画欠账封顶"那一段。
      客户端自己的兜底是 4 秒整批丢弃，这儿留足余量。 */
  private static MAX_ANIM_LAG_MS = 1800;
  private static SLICE_END = new Set(['draw', 'discard', 'play_drawn', 'dead', 'meld', 'penalty', 'tilong_score', 'hu', 'liuju', 'deal', 'dealer_card']);

  private onGameEvent(e: GameEvent) {
    this.cur.push(e);
    // 吃牌带的下伙牌组（part）跟"吃"是同一个动作：不切帧，跟吃牌一起发、一起落地
    if (e.t === 'meld' && (e.meld as any).part) return;
    /* 起手龙也一样：三家可以同时下，不用分先后。一条一帧的话，龙多的时候
       要一条一条挨着播（每条 1 秒）、一句一句挨着报，又慢又吵。攒在一帧里一起亮。 */
    if (e.t === 'meld' && (e as any).deal) return;
    if (Room.SLICE_END.has(e.t)) this.closeFrame();
  }
  /** 假装玩家在想：2.4~3.6 秒 */
  /** 中途退出后座位给他留多久（托管中），过了才让给别人 */
  static AWAY_KEEP_MS = 10 * 60 * 1000;
  /** 这些"停一拍"的时间都跟着读秒走：读秒 30 秒时还是原来的手感（想 2.4~3.6 秒、捂牌 3~5 秒） */
  private turnSec() { return this.cfg.turnSec ?? Math.round(this.rules.timers.discard / 1000) ?? 30; }
  private thinkMs() { const t = this.turnSec(); return Math.round(t * 80 + Math.random() * t * 40); }
  /** 揭晓前统一"排队"的时间：读秒的 1/10 ~ 1/6，别固定成一个数，不然也能看出规律 */
  private holdMs() { const t = this.turnSec(); return Math.round(t * 100 + Math.random() * t * 67); }
  private closeFrame(tail = false) {
    if (!this.cur.length) return;
    // 收尾时剩下的都是 options / need_discard 这类没有画面的事件，并进上一帧，别单独多发一条
    /* 收尾时 `cur` 里剩的一般都是 options / need_discard 这类没画面的事件，并进上一帧就行。
       但起手龙那一批是**故意攒着不切帧**的，它们是看得见的动作 —— 并进阳张那一帧的话，
       龙会跟阳张同时冒出来、两句话也撞在一起。有画面就让它自己单独成一帧。 */
    const visual = this.cur.some(e => (Room.ANIM[e.t] ?? 0) > 0);
    if (tail && !visual && this.frames.length) {
      const last = this.frames[this.frames.length - 1];
      last.evs = [...last.evs, ...this.cur];
      last.gviews = [...this.seats.map((_, i) => this.game!.view(i)), this.game!.view(null)];
      last.evAt = this.game!.events.length;
      this.cur = [];
      return;
    }
    const k = Number(process.env.BOT_SPEED || 1);
    // 服务端自己判完就往下走的步骤（牌没人要得起、重跑不用出牌），单独切出来多停一会儿，
    // 装成"大家在想"，别让开跑、胡牌一瞬间就完事
    const last = this.cur[this.cur.length - 1];
    // 服务端自己判完就往下走的步骤：牌没人要得起、系统代为执行的提 / 偎 / 龙 / 跑
    const think = !!last && ((last.t === 'dead' && (last as any).auto === true)
      || (last.t === 'meld' && ['pao', 'ti', 'long', 'wei'].includes(last.meld.type)));
    /* 起手龙是**同时**下地的：三条龙一起亮，占的还是一条龙的时间，不是三倍 */
    const dealMelds = this.cur.filter(e => e.t === 'meld' && (e as any).deal).length;
    const anim = this.cur.reduce((a, e) => a + ((e.t === 'meld' && (e as any).deal) ? 0 : (Room.ANIM[e.t] ?? 0)), 0)
      + (dealMelds ? Room.ANIM.meld : 0);
    const ms = think ? this.thinkMs() : anim;
    // 测试 / 压测模式（BOT_SPEED 很小）动画时间短到看不见，就不分帧，一口气发完
    const delay = k < 0.5 ? 0 : Math.round(ms * k);
    // 抓这一刻各座位看到的牌局：客户端按帧播放时，按钮和倒计时才不会跑到画面前面
    // 最后多存一份"旁观视角"（谁的手牌都看不见），给房主观战用
    const gviews = [...this.seats.map((_, i) => this.game!.view(i)), this.game!.view(null)];
    // evAt：拍这张快照的时候引擎走到第几个事件了 —— 发这一帧时如果引擎已经往前走了，
    // 就绝不能把"实时状态"盖上去（不然玩家会先看到偎好的牌下地、过一会儿才听到「偎」）
    this.frames.push({ evs: this.cur, delay, gviews, evAt: this.game!.events.length });
    this.cur = [];
  }
  private pausedAt: number | null = null;
  private pausedTotal = 0;
  private nextRoundAt: number | null = null;
  private waitingSince: number | null = null;
  onClosed?: (room: Room) => void;

  private db: DB;
  /** 按当前配置算出这一桌的规则（后台改了读秒之后重算一次） */
  applyRules() {
    this.rules = getRules(this.cfg.variant, this.cfg.ruleOverride);
    /* 开房时挑的那几条：没挑的一概不动（大厅就是这一路，全按玩法默认）。
       「无息胡」在引擎里是个分数（耒阳 21 胡），开关关掉就是 0 —— 0 表示这一桌不许无息胡。 */
    const pl = this.cfg.play;
    if (pl) {
      const base = getRules(this.cfg.variant);
      this.rules = {
        ...this.rules,
        noXiHu: pl.noXiHu === undefined ? this.rules.noXiHu : (pl.noXiHu ? (base.noXiHu || 21) : 0),
        raiseHand: pl.raiseHand ?? this.rules.raiseHand,
        redBlack: pl.redBlack ?? this.rules.redBlack,
        huCardDun: pl.huCardDun ?? this.rules.huCardDun,
        deal: pl.deal ?? this.rules.deal,
      };
    }
    // TIMER_SPEED 可整体缩放决策时限（测试用，生产保持 1）
    const ts = Number(process.env.TIMER_SPEED || 1);
    if (ts !== 1) {
      const t = this.rules.timers;
      // huForced 也跟着缩（测试用）：生产保持 1，它就一直是那 5 秒
      // 展开写，别一项一项列 —— 漏掉哪一项它就成了 undefined，时限算出来是 NaN，那一手会永远等下去
      this.rules = { ...this.rules, timers: { ...t, drawerDecide: t.drawerDecide * ts, claimPeng: t.claimPeng * ts, claimChi: t.claimChi * ts, discard: t.discard * ts, huForced: t.huForced * ts, ghostPass: t.ghostPass * ts } };
    }
  }

  constructor(cfg: RoomConfig, db: DB) {
    this.db = db;
    this.cfg = cfg;
    this.applyRules();
    this.seats = Array.from({ length: this.rules.players }, () => ({ userId: null, isBot: false, ready: false, client: null }));
  }

  /** 房间时钟：暂停期间不流逝，保证倒计时公平 */
  now = () => (this.pausedAt ?? Date.now()) - this.pausedTotal;

  // ---------- 成员 ----------
  publicUser(u: UserRow): PublicUser {
    // 不带账号码：那是本人的钥匙之一，牌桌上不能给别人看见
    return { id: u.id, nickname: u.nickname, avatar: u.avatar, kind: u.kind, vip: !!u.vip, points: u.points };
  }
  seatOf(userId: number) { return this.seats.findIndex(s => s.userId === userId); }
  humanCount() { return this.seats.filter(s => s.userId !== null && !s.isBot).length; }
  /** 中途退出、正由机器人托管、还在保留期内的真人座位 */
  awayCount() { return this.seats.filter(s => s.userId !== null && s.userId > 0 && s.awayAt !== undefined && !s.stood
    && Date.now() - s.awayAt <= Room.AWAY_KEEP_MS).length; }
  filledCount() { return this.seats.filter(s => s.userId !== null).length; }

  /**
   * 桌长：桌上**最早坐下的那个真人**（还在线的）。
   * 「几局一歇」歇下来之后由他点「继续」—— 私人房房主当然也能点。
   * 他走了自动顺延给下一个，不用谁来交接；一个真人都没有就返回 null（等人来）。
   */
  captainId(): number | null {
    const hs = this.seats.filter(s => s.userId !== null && s.userId > 0 && !s.isBot && s.client && s.seatedAt !== undefined);
    if (!hs.length) return null;
    hs.sort((a, b) => (a.seatedAt! - b.seatedAt!) || (a.userId! - b.userId!));
    return hs[0].userId!;
  }
  /** 这个人能不能点「继续」：房主，或者桌长 */
  canResume(userId: number) { return this.cfg.hostId === userId || this.captainId() === userId; }

  /** 值不值得把他送回这一桌（重连、点大厅时都看它）：
      **只有正在打的那一局**才算"有局在身" —— 桌子还空着等人的时候，
      他坐不坐那儿都无所谓，不该把他锁在这一桌上（开好房坐下、想去别处打的正是这种）。
      主动起立走的也不送。 */
  resumable(userId: number) {
    if (this.status === 'closed') return false;
    const i = this.seatOf(userId);
    if (i < 0 || this.seats[i].stood) return false;
    if (this.status === 'playing' && this.game && !this.game.ended) return true;
    /* 还没在打牌的桌子分几种看：
       - **大厅的桌**：他是点了"开始游戏"随机坐下的，正排着队等人齐 ——
         网络抖一下就把他扔回大厅、还得再点一次，不合适，送他回原桌接着等。
       - **私人房、已经开过局**：两局之间的空当也算"这一摊还在打"。
         以前这儿一律返回 false，于是上一局刚打完、手机锁屏两秒再回来，
         位子就被当场收走了（auth 里那句 `r.leave(...)`）——
         桌上从此 2/3 个人干等，谁也不知道第三个人去哪了。压测里那次
         "打完第 1 局就一直卡在 waiting" 就是这么来的。真要走人有「起立」。
       - **私人房、一局没打过**：开好房坐下就走开的那种。位子让出来，
         别把他锁在自己这一桌上 —— "想去大厅打两把，结果点哪儿都回自己房"
         就是这么来的。想回来从「我的房间」或者房号再进一次就是了。 */
    if (!this.cfg.isPrivate) return true;
    return this.status === 'paused' || this.roundNo > 0;
  }

  join(user: UserRow, client: Client, password?: string): string | null {
    if (this.status === 'closed') return '房间已关闭';
    /* 房主也上桌打牌。以前私人房的房主一进来就被塞去观战 ——
       有了主页「我的房间」那张管理页（人头、积分牌、读秒、暂停、清空都在那儿），
       观战这条路就没必要了，房主跟别人一样坐下来打。 */
    const existing = this.seatOf(user.id);
    if (existing >= 0) { // 重连 / 托管后回来接着打
      const s = this.seats[existing];
      s.client = client; s.isBot = false; s.awayAt = undefined; s.botAt = undefined; s.autoBot = false; s.misses = 0; s.stood = false;
      /* 正在播动画的时候回来的：剩下那几帧跳过，直接给他实时状态。
         不这么做的话，他会先收到一串旧快照（myOptions 被抹成 null），
         于是"重连回来轮到我出牌，可吃碰过全不见了，读秒还在走" —— 三人房压测里
         每次掉线重连必现，按钮空 2.5~3 秒；牌桌越忙、动画越长，空得越久。 */
      s.freshJoin = this.frames.length > 0;
      s.seatedAt ??= Date.now();   // 老座位可能还没记过（回来的人排在原来的位置上）
      this.remember(this.publicUser(user));
      this.broadcast();
      return null;
    }
    // 补位按退出先后：谁的位子先空出来，进来的人就先接谁的（真实牌桌上就是这么接的）
    const empties = this.seats.map((st, i) => ({ st, i })).filter(x => x.st.userId === null);
    empties.sort((a, b) => (a.st.vacatedAt ?? 0) - (b.st.vacatedAt ?? 0) || a.i - b.i);
    let idx = empties.length ? empties[0].i : -1;
    if (idx < 0 && this.status !== 'playing') {
      idx = this.seats.findIndex(s => s.isBot && (s.userId ?? 0) < 0);   // 负数 id = 真机器人
      if (idx >= 0) { const bid = this.seats[idx].userId; if (bid !== null) this.users.delete(bid); }
    }
    if (idx < 0) return '房间已满';
    // 进房间就算准备好了：人齐 3 秒倒计时自动开局，不用再点「准备」
    this.seats[idx] = { userId: user.id, isBot: false, ready: true, client, seatedAt: Date.now() };
    // 本局这个位子换人了：记下来（纪录表 / 战绩里要看得出"谁接了谁的位子"）
    if (this.game && !this.game.ended) {
      const hist = this.roundSeatUsers[idx] ?? (this.roundSeatUsers[idx] = []);
      if (hist[hist.length - 1] !== user.id) hist.push(user.id);
    }
    this.remember(this.publicUser(user));
    if (!this.totals.has(user.id)) this.totals.set(user.id, 0);
    this.lastActivity = Date.now();
    if (this.waitingSince === null) this.waitingSince = Date.now();
    if (this.status === 'paused' && this.filledCount() === this.seats.length) this.resume();
    this.broadcast();
    return null;
  }

  /**
   * 离开这一桌。三种走法：
   * - `disconnect`：断线。座位给他留着（大厅由机器人托管、私人房另有 60 秒宽限），回来接着打。
   * - `leave`：点了返回大厅。跟断线一个待遇 —— 人多半还会回来。
   * - `stand`：**起立离开**。明说了不再回这一桌。
   *   大厅：正在打的那一局照样由机器人替他打完（账本来就按开局时坐这儿的人算），
   *   座位打上"已起立"的印子 —— 重连不再把他送回来，本局一结束位子就真让出去。
   *   私人房：位子当场空出来，牌局暂停等人补位（补位的人直接接手这手牌）。
   *   私人房只有这一种走法会按停桌子。
   */
  leave(userId: number, reason: 'leave' | 'disconnect' | 'stand' = 'leave') {
    const idx = this.seatOf(userId);
    if (idx < 0) return;
    const s = this.seats[idx];
    if (reason === 'stand') s.stood = true;
    if (this.status === 'playing' && this.game && !this.game.ended) {
      /* 只有**起立**（明说了不回这一桌）才把私人房按停。
         以前是私人房只要有人离桌就当场空位 + 暂停 —— 可"返回大厅看一眼"和"断线两分钟"
         都会走到这儿，于是三个人打得好好的，一个人退出去，另外两个干坐着等。
         退出和断线跟大厅一个待遇：机器人先替他打着，位子和分数都留着（awayAt），
         桌子照转，他从大厅那条「返回牌局」点回来就接着打。
         起立才是真的离开位置：位子当场空出来，三人桌少一个打不下去，这才暂停等人补位
         （补位的人直接接手这手牌）。 */
      if (this.cfg.isPrivate && reason === 'stand') {
        this.db.bumpStats(userId, { escapes: 1 });
        s.client = null; s.userId = null; s.isBot = false; s.ready = false; s.stood = false; s.vacatedAt = Date.now();
        this.pause();
      } else {
        // 机器人接管，座位和分数都给他留着（`awayAt`），随时回来接着打
        s.client = null; s.isBot = true; s.awayAt = Date.now();
        // 自己走的（点返回 / 起立）才记一笔；断线不算逃跑
        if (reason !== 'disconnect') { s.botName = this.nameOf(userId) ?? undefined; this.db.bumpStats(userId, { escapes: 1 }); }
      }
    } else {
      // 没在打牌：不管怎么走的，位子当场就空出来
      s.client = null; s.userId = null; s.isBot = false; s.ready = false; s.stood = false; s.vacatedAt = Date.now();
    }
    this.lastActivity = Date.now();
    /* 有房主的私人房：人走光了也先留着，等牌友进来（2 小时没动静才由大厅回收）。
       房主现在是坐下来打的，走开了桌上就可能一个人没有 —— 这时候要是顺手把房解散了，
       VIP开好的房就白开了；房间的生死交给房主自己在「我的房间」里点解散。 */
    /* 人走空但房间留着（房主开的私人房）：局数、账本、接着洗的那副牌一起归零 ——
       下一拨人进来是从第 1 局重新开始，不该接着上一拨的局数数下去。 */
    if (this.keepAlive()) {
      this.dropBots();
      if (this.humanCount() === 0 && this.awayCount() === 0 && this.status !== 'playing') {
        this.roundNo = 0; this.settledRound = -1; this.roundClosed = -1; this.carryDeck = null;
        this.pausedReason = null; this.nextRoundAt = null;
      }
      this.broadcast(); return;
    }
    if (this.humanCount() === 0 && this.awayCount() === 0 && this.spectators.size === 0) this.close();
    else { this.dropBots(); this.broadcast(); }
  }

  /** 桌上没有真人在线时，把纯机器人请走（托管中的真人座位留着）；牌局进行中先不动 */
  private dropBots() {
    if (this.status === 'playing' || this.humanCount() > 0) return;
    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i];
      if (s.isBot && (s.userId ?? 0) < 0) { this.users.delete(s.userId!); this.seats[i] = { userId: null, isBot: false, ready: false, client: null }; }
    }
    this.waitingSince = null;
  }

  setReady(userId: number, ready: boolean) {
    const idx = this.seatOf(userId); if (idx < 0) return;
    this.seats[idx].ready = ready;
    this.broadcast();
  }

  /* 这个位子上一回坐的是哪个机器人（id / 名字 / 头像）。
     真人退到大厅再回来的这一路上，房里没真人了 → 机器人被请走 → 人回来又补机器人。
     以前每补一次就发一个全新的负数 id，账本按 id 记，于是**同名同位**的机器人
     在纪录表里成了一个新人：前面那几局全是「-」、合计 0（看着就是"分数没了"）。
     所以按座位把身份留着，位子空着没被真人占过就原样请回来。 */
  private botSeat = new Map<number, { id: number; name: string; seq: number }>();

  addBot(seatIdx: number) {
    const keep = this.botSeat.get(seatIdx);
    // 沿用老身份的前提：这个 id 没在别的位子上坐着（不然一个 id 两份账）
    const reuse = keep && !this.seats.some(s => s.userId === keep.id) ? keep : null;
    let id: number, name: string, seq: number;
    if (reuse) { ({ id, name, seq } = reuse); }
    else {
      botSeq = (botSeq + 1) % BOT_NAMES.length;
      seq = botSeq;
      id = -(Date.now() % 1000000) * 10 - seatIdx - 1; // 负数 id 表示机器人
      name = BOT_NAMES[seq];
    }
    this.seats[seatIdx] = { userId: id, isBot: true, ready: true, client: null, botName: name };
    this.remember({ id, nickname: name, avatar: `bot:${seq}`, kind: 'bot', vip: false, points: 0 });
    this.botSeat.set(seatIdx, { id, name, seq });
    // 老身份回来了：账原样接着走（离桌那本里存着的也提出来），不是从 0 重新记
    if (!this.totals.has(id)) this.totals.set(id, this.gone.get(id) ?? 0);
    this.gone.delete(id);
  }

  // ---------- 流程 ----------
  canStart() { return this.filledCount() === this.seats.length && this.seats.every(s => s.ready); }

  start(byUserId?: number): string | null {
    if (this.status === 'playing') return '已经开始';
    // 房主在观战（没坐下）时，桌上的人自己就能开；房主坐在桌上就还是房主说了算
    if (this.cfg.isPrivate && byUserId !== undefined && byUserId !== this.cfg.hostId && this.roundNo === 0
      && this.cfg.hostId !== undefined && this.seatOf(this.cfg.hostId) >= 0) return '只有房主可以开始';
    if (this.filledCount() < this.seats.length) return '人数不够';
    this.startRound();
    return null;
  }

  /** 这一批是哪几个真人：机器人（负数 id）不算 —— 机器人换来换去不该把账本切一刀 */
  private rosterKey() {
    return this.seats.map(s => s.userId).filter((id): id is number => id !== null && id > 0).sort((a, b) => a - b).join(',');
  }
  /**
   * 座位上的人换了：把上一批封存成一行，桌面上重开一本只有当下这三个人的账。
   * 「之前的人回来了就接着算」—— 凡是在封存批次里有账的，这一笔**提出来**带进新的一批，
   * 封存那一行里就不再留他（不然同一笔钱会被数两遍）。所以第一批那一行剩下的，
   * 正好是"已经走了、没再回来"的那些人。
   */
  private openBatch() {
    const key = this.rosterKey();
    if (key === this.batchRoster) return;
    const seatsNow = this.seats.map(s => s.userId).filter((id): id is number => id !== null);
    const live = new Set(seatsNow);
    const nameMap = (ids: Iterable<number>) => {
      const m: Record<number, string> = {};
      for (const id of ids) { const nm = this.nameOf(id); if (nm) m[id] = nm; }
      return m;
    };
    // 上一批封存成**单独一段**（自己的表头、自己的那几局、自己的小计），摆在纪录表下面
    if (this.batchRoster !== '' && this.batchSeats.length && this.roundNo > this.batchFrom) {
      const subtotal: Record<number, number> = {};
      for (const id of this.batchSeats) subtotal[id] = (this.totals.get(id) ?? 0) - (this.batchStart.get(id) ?? 0);
      this.batchNo++;
      this.batches.unshift({            // 新的排前面：纪录表从上往下就是"由近及远"
        no: this.batchNo, label: `第${this.batchNo}批`,
        seats: this.batchSeats.slice(), names: nameMap(this.batchSeats), subtotal,
        from: this.batchFrom + 1, until: this.roundNo, at: Date.now(),
      });
    }
    /* 走掉的人：账不清零，整笔挪进「离桌」那本里存着。
       他哪天回来，这一笔**原样提出来接着算** —— 位子上一直是同一个人的，
       合计更是从头到尾连着走，不跟着分段重来。 */
    for (const [id, v] of [...this.totals]) if (!live.has(id)) { this.gone.set(id, v); this.totals.delete(id); }
    for (const id of seatsNow) {
      if (this.totals.has(id)) continue;
      if (this.gone.has(id)) { this.totals.set(id, this.gone.get(id)!); this.gone.delete(id); }   // 回来了：老账提出来
      else this.totals.set(id, 0);
    }
    this.batchStart = new Map(this.totals);
    this.batchSeats = seatsNow;
    this.batchFrom = this.roundNo;
    this.batchRoster = key;
  }

  private startRound() {
    this.applyRules();      // 后台改过读秒：这一局按新的来（正在打的那一局不受影响）
    this.openBatch();       // 换人了就切一本新账（老账封存成「第 N 批」那一行）
    this.roundNo++;
    this.status = 'playing';
    this.nextRoundAt = null;
    this.frames = []; this.cur = []; this.frameAt = 0; this.holdUntil = 0;
    this.game = new Game({
      rules: this.rules, baseScore: this.cfg.baseScore, dealer: this.dealer, now: this.now,
      onEvent: e => this.onGameEvent(e),
    });
    this.eventCursor = 0;
    this.lastProgress = Date.now(); this.lastSig = '';
    this.roundSeatUsers = this.seats.map(st => (st.userId !== null ? [st.userId] : []));
    for (const st of this.seats) st.vacatedAt = undefined;
    /* 托管**一局一清**：超时次数归零，机器人替打的状态也解除。
       原先 misses 是跨局累加的 —— 第一局走开倒杯水漏了一手、第三局网卡了一下漏一手，
       两笔加起来就被判"连着两次"交给机器人了，人还坐在这儿呢。
       而且解除只认"他自己点一下按钮"（wake），一局都没碰屏幕就一直替他打下去。
       现在的规矩：**同一局里**超时两次才托管，新一局重新开始算。
       真人要是还没回来，新一局里照样会再超时两次，自然又托管 —— 不会因此卡住桌子。 */
    for (const st of this.seats) { st.misses = 0; if (st.autoBot) { st.autoBot = false; st.botAt = undefined; } }
    /* 洗牌：默认「接着洗」—— 上一局打完的牌照牌桌上的样子收拢，切两半对插搓几把再发，
       跟真人打牌一个路数（上一局的坎、句子会留下一点残影）。
       第一局、或者收上来的牌对不上数，就退回原来那套"全新一副、完全随机"。 */
    const carry = this.rules.deal === 'big' && this.carryDeck && this.carryDeck.length === 80
      ? riffleShuffle(this.carryDeck) : undefined;
    this.game.start(carry);
    for (const s of this.seats) s.ready = true;
    this.scheduleBots();
    this.flush();
  }

  /** 房主给房间起个名字（空的话就回落到房号）—— 开了好几间时，靠名字认人比靠房号快 */
  setName(name: string) {
    const n = name.trim().slice(0, 12);
    this.cfg.name = n || undefined;
    this.broadcast();
    return n;
  }

  /** 房主（或后台）改这一桌的读秒：没在打牌就立刻生效，正在打的那一局打完再换 */
  setTurnSec(sec: number) {
    const s = Math.max(10, Math.min(120, Math.floor(sec)));
    const turnMs = s * 1000;
    const base = getRules(this.cfg.variant).timers;
    this.cfg.turnSec = s;
    /* 虚拟过牌也跟着读秒走：读秒 30 秒时是 3 秒（1/10），读秒调快调慢手感才一致。
       封在 1.5~6 秒之间 —— 再短遮不住、再长每摸一张都要干等。 */
    const ghost = Math.max(1500, Math.min(6000, Math.round(turnMs / 10)));
    this.cfg.ruleOverride = { timers: { ...base, drawerDecide: turnMs, claimChi: turnMs, discard: turnMs, claimPeng: Math.round(turnMs / 2), ghostPass: ghost } };
    if (this.status !== 'playing') this.applyRules();
    this.broadcast();
    return s;
  }

  /** 房主清空这个房间的数据：积分牌（累计输赢）和记录表一起归零，牌局本身不动 */
  clearData() {
    this.ledger = [];
    this.roomStats.clear();
    // 局数一起归零：清了账还接着数第 9 局，「几局一歇」就歇得莫名其妙
    this.roundNo = 0; this.settledRound = -1; this.roundClosed = -1; this.carryDeck = null;
    this.batches = []; this.batchNo = 0; this.batchFrom = 0; this.gone.clear();
    this.batchSeats = this.seats.map(x => x.userId).filter((id): id is number => id !== null);
    this.batchStart = new Map(); this.batchRoster = this.rosterKey();
    for (const k of [...this.totals.keys()]) this.totals.set(k, 0);
    this.db.clearRoomRounds(this.cfg.id, this.cfg.hostId ?? -1);
    this.broadcast();
  }

  /** 房主暂停 / 继续：正在打的那一局挂起（房间时钟一起停），等着的房间也不许自动开局 */
  hostPause(reason = '房主暂停了牌局') {
    this.pausedReason = reason;
    this.pause();
    this.broadcast();
  }
  hostStart() {
    this.pausedReason = null;
    if (this.status === 'paused') this.resume();
    else if (this.status === 'waiting' && this.canStart()) this.nextRoundAt = Date.now() + 3000;
    this.broadcast();
  }

  pause() {
    if (this.status !== 'playing') return;
    this.status = 'paused';
    this.pausedAt = Date.now();
    this.broadcast();
  }
  resume() {
    if (this.status !== 'paused') return;
    if (this.pausedAt !== null) { this.pausedTotal += Date.now() - this.pausedAt; this.pausedAt = null; }
    this.status = 'playing';
    this.scheduleBots();
    this.flush();
  }

  /** 桌上真人里最大的单程延迟（毫秒）：帧发出去到手机收到，路上要走这么久。
      封到 500ms —— 再差的网另算，不能让一个人的烂网把全桌的等待拖没边。 */
  private halfRtt() {
    let m = 0;
    for (const s of this.seats) if (s.client && !s.isBot) m = Math.max(m, s.client.rtt ?? 0);
    return Math.min(500, Math.round(m / 2));
  }

  /** 还有多少毫秒的动画没放完：引擎定时限时要加上这一段（玩家看到才开始算）。
      除了没播完的帧，还得算上**这一帧在路上要走的那一截**（单程延迟）——
      以前这一截一概当 0，等于默认手机跟服务器贴在一起。 */
  /* 再加一道富余：上面那张表是"理想情况"，真机上还得算进这些没法预估的零碎 ——
     手机掉帧、事件队列的 rAF 排队、Safari 后台降频、补动画时多花的那几十毫秒。
     估多了只是窗口宽一点点（玩家多几百毫秒，不影响别人）；估少了就是玩家眼睁睁
     错过一手碰。宁可宽一点：按还没播完的那段加一成，再兜底 200ms。 */
  private static LAG_SLACK = 0.1;
  private static LAG_FLOOR = 200;
  private syncLag() {
    if (!this.game) return;
    const left = Math.max(0, this.holdUntil - Date.now());
    this.game.lag = Math.round(left * (1 + Room.LAG_SLACK)) + (left > 0 ? Room.LAG_FLOOR : 0) + this.halfRtt();
  }

  act(userId: number, action: ActionType, payload?: { card?: Kind; combo?: Kind[]; lay?: number }): string | null {
    if (this.status !== 'playing' || !this.game) return '牌局未进行';
    this.syncLag();
    const seat = this.seatOf(userId);
    if (seat < 0) return '不在座位上';
    this.wake(userId);                    // 自己动手了 = 人回来了，机器人退下
    const before = this.game.events.length;
    const err = this.game.act(seat, action, payload);
    // 纯粹被拒（什么也没发生）：直接把消息回给他
    if (err && this.game.events.length === before) return err;
    // 违规（吃回头牌、拆坎出牌…）会"带着错误消息"照样罚分、照样推进局面：
    // 只要引擎吐了事件，就得照常 flush + 重新安排机器人，不然这些帧要等到下次超时才发得出去。
    // 注意只能走一次 afterAct —— 走两次会把结算跑两遍，纪录表里就会多出一条一模一样的。
    this.lastActivity = Date.now();
    this.afterAct();
    return err;
  }

  /** 玩家回来了（点了按钮 / 动手理牌）：机器人立刻退下，这一手交还给他 */
  wake(userId: number) {
    const seat = this.seatOf(userId);
    if (seat < 0) return;
    const s = this.seats[seat];
    s.misses = 0;                      // 人回来了，之前那次超时不再算数
    if (!s.autoBot) return;
    s.autoBot = false; s.botAt = undefined;
    this.broadcast();
  }

  private afterAct() {
    this.flush();
    if (this.game?.ended) this.settle();
    else this.scheduleBots();
  }

  private scheduleBots() {
    if (!this.game) return;
    const t = Date.now();
    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i];
      if (!s.isBot && !s.autoBot) continue;
      const opt = this.game.optionsFor(i);
      if (opt && s.botAt === undefined) {
        // 默认：机器人不"思考"，轮到它就动手。唯一要等的是这一步的动画帧发完（holdUntil），
        // 不然它会跑到画面前头去。再加一丁点随机（0~180ms），免得三家永远整齐划一地同一跳出手。
        // 后台把这一组的「机器人思考」打开之后，改成随机停一下（跟着读秒走：30 秒读秒 = 2.4~3.6 秒）。
        const k = Number(process.env.BOT_SPEED || 1);
        /* 替真人打的时候慢一点（1.5 秒）：人要是正好回来了，得给他抢回这一手的机会 */
        const wait = s.autoBot && s.client ? 1500
          : this.cfg.botThink ? this.thinkMs() : 120 + Math.random() * 180;
        s.botAt = Math.max(t, this.holdUntil) + Math.round(wait * k);
      } else if (!opt) s.botAt = undefined;
    }
  }

  /* 看门狗：这一局**有多久没往前挪过**了。
     帧发完了、机器人也该动了、引擎的时限也早过了，却一步都不动 —— 那就是卡住了。
     宁可强制按黄庄收场（这一局算平），也绝不把一桌人冻在那儿干等。
     真发生了一定往日志里写清楚是哪一步卡的，回头照着查。 */
  private lastProgress = Date.now();
  private lastSig = '';
  private static STUCK_MS = 25000;

  /** 由外部每 200ms 调用 */
  tick() {
    const t = Date.now();
    if (this.status === 'closed') return;
    // 大厅：等待超时用机器人补位
    // 固定桌：机器人只在有人点「请机器人」时才进来，不再自动补位
    if (this.status === 'waiting' && !this.cfg.isPrivate && !this.cfg.fixed && this.waitingSince !== null && this.humanCount() > 0) {
      const delay = this.cfg.botFillDelayMs ?? 4000;
      if (t - this.waitingSince >= delay) {
        for (let i = 0; i < this.seats.length; i++) if (this.seats[i].userId === null) this.addBot(i);
        this.waitingSince = null;
        // 上一局刚结束的话要等结算倒计时走完，别 4 秒就把下一局开起来
        if (this.canStart() && (this.nextRoundAt === null || t >= this.nextRoundAt)) { this.nextRoundAt = null; this.startRound(); }
        else this.broadcast();
      }
    }
    // 人齐了就开局：3 秒倒计时（大厅固定桌和私人房都一样；上一局打完 / 踢人作废之后按 nextRoundAt 的倒计时来）
    // 暂停中的房间不自动开局 —— 房主按了暂停，就别让它自己又开起来
    if (this.status === 'waiting' && this.pausedReason === null && this.humanCount() > 0 && this.canStart()) {
      if (this.nextRoundAt === null) { this.nextRoundAt = t + 3000; this.broadcast(); }
      if (t >= this.nextRoundAt) { this.nextRoundAt = null; this.startRound(); return; }
    }
    /* 没发完的帧**永远**要接着发 —— 哪怕这一局已经结算完、状态回到 waiting，
       哪怕房间这会儿是暂停的。这一句必须排在下面那几道 return 前面。
       踩过两次，都是同一个道理：
        · 第一次是 `status !== 'playing'` 那道。点炮胡的时候「打牌」和「胡牌」
          常常在同一批帧里，第一帧发出去之后 frameAt 推到了未来，剩下「胡」那一帧
          还排着队，紧接着 settle() 就把 status 改成了 waiting —— 那一帧再也发不出去，
          客户端收不到 hu，结算面板不弹，一直闷到下一局 deal 才有动静。
        · 第二次是下面 `pausedReason` 那道。afterAct() 是先把帧排进队列、
          紧接着 settle()，而 settle → closeRound 里满足"打满 N 局"就把 pausedReason 设上了；
          于是从下一次 tick 起就在这儿掉头走人，队列里的帧永远发不出去。
          黄庄最容易撞上 —— 最后几张牌连着没人要，尾巴上排着一长串帧。
          表现就是老板说的"黄庄遇到满局暂停会卡死"。
       教训写在这儿：这一句往下挪一行都可能再犯。 */
    if (this.game && this.frames.length) this.sendFrames();
    if (this.pausedReason !== null) return;   // 封顶 / 满局暂停：等房主点继续（帧已经在上面发过了）
    if (this.status === 'waiting' && this.nextRoundAt !== null && t >= this.nextRoundAt) {
      this.nextRoundAt = null;
      // 桌上一个真人都没有（全是机器人 / 都在托管）就别自己接着打，不然这桌永远满着，谁也进不来
      if (this.humanCount() > 0 && this.filledCount() === this.seats.length && this.seats.every(s => s.ready)) this.startRound();
    }
    // 固定桌：没人在线、托管时间也过了 —— 清空重来，别让机器人一直占着
    if (this.cfg.fixed && this.status !== 'playing' && this.humanCount() === 0 && this.awayCount() === 0
      && this.seats.some(s => s.userId !== null)) { this.resetTable(); return; }
    if (this.status !== 'playing' || !this.game) return;
    // 守门狗：这一局其实已经结束了，房间却还挂在"进行中" —— 结算那一步出过岔子。
    // 帧发完之后强行收尾，绝不让桌子冻在"报了胡了"的那一刻。
    if (this.game.ended && !this.frames.length && this.roundClosed !== this.roundNo) {
      console.error(`[兜底] 房间 ${this.cfg.id} 第 ${this.roundNo} 局已结束却还在 playing，强行收尾`);
      this.settle();
      return;
    }
    this.sendFrames();
    if (this.frames.length) return;      // 还有帧没发完，先别让引擎和机器人往前跑
    // 机器人行动
    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i];
      if ((s.isBot || s.autoBot) && s.botAt !== undefined && t >= s.botAt) {
        s.botAt = undefined;
        const d = botDecide(this.game, i);
        if (d) {
          /* 机器人这一手也要按"玩家看到"起算：它走的是 game.act，不经过 Room.act，
             以前没人给它填 lag —— 机器人一打牌，别家的碰窗口就从服务端这一刻开始走，
             等动画放到那儿，圈已经去了一大截（吃的圈是客户端自己按"第一次看见"归一化的，
             所以看着没事 —— 两边不一样就是这么来的）。 */
          this.syncLag();
          let err = this.game.act(i, d.type, d);
          if (err) {
            // 机器人选了个引擎不认的动作（比如有胡必胡时去提）：别让桌子卡死，退而求其次
            console.error('bot act error', err, d);
            const fb = this.game.optionsFor(i)?.options ?? [];
            const hu = fb.find(o => o.type === 'hu');
            const any = hu ?? fb.find(o => o.type !== 'chi') ?? fb[0];
            /* 出牌那一路选项里的 card 是 -1（占位，不是真牌）—— 照它打必然被拒，
               然后每 200ms 重试一次、次次被拒，桌子就假死在出牌这一步。
               这儿得自己挑一张真牌（引擎那套"不拆坎"的挑法）。 */
            if (any?.type === 'discard') err = this.game.act(i, 'discard', { card: this.game.autoDiscardCard(i) });
            else if (any) err = this.game.act(i, any.type, { card: any.card, combo: any.combos?.[0] });
            if (err) console.error('bot fallback failed', err);
          }
          this.afterAct();
        }
        if (this.status !== 'playing') return;
      }
    }
    /* 看门狗：局面签名一变就说明挪动过了。**死死不动**超过 STUCK_MS 才算卡住 ——
       正常等人表态最多也就一轮读秒（默认 30 秒），所以这儿只在"连引擎的时限都早过了"
       的时候才动手（下面那个 deadline 判断）。 */
    {
      const g0 = this.game;
      const sig = `${g0.phase}|${g0.turn}|${g0.events.length}|${g0.pile.length}|${g0.deadline}`;
      if (sig !== this.lastSig) { this.lastSig = sig; this.lastProgress = t; }
      else if (!this.frames.length && t - this.lastProgress > Room.STUCK_MS
        && g0.deadline > 0 && this.now() > g0.deadline + Room.STUCK_MS) {
        const who = this.seats.map((s, i) => `${i}:${s.isBot ? '机' : s.autoBot ? '托' : '人'}${s.userId ?? '空'}`).join(' ');
        console.error(`[卡住] 房间 ${this.cfg.id} 第 ${this.roundNo} 局 ${Math.round((t - this.lastProgress) / 1000)} 秒没动`
          + ` · phase=${g0.phase} turn=${g0.turn} pile=${g0.pile.length} drawn=${g0.drawn}`
          + ` · deadline 过了 ${Math.round((this.now() - g0.deadline) / 1000)} 秒 · 座位 ${who}`
          + ` · claims=${JSON.stringify((g0 as any).claims?.map((c: any) => ({ s: c.seat, o: c.options.map((x: any) => x.type), d: c.decision, g: c.ghost })))}`
          + ` · 最后几步 ${g0.events.slice(-8).map(e => e.t).join('>')}`);
        // 先请引擎自己再走一步；还是不动就按黄庄收场
        const moved = g0.tick(this.now());
        if (!moved || this.lastSig === `${g0.phase}|${g0.turn}|${g0.events.length}|${g0.pile.length}|${g0.deadline}`) {
          g0.forceLiuJu('房间看门狗');
        }
        this.lastProgress = t;
        this.afterAct();
        return;
      }
    }
    // 超时处理
    const before = this.game.events.length;
    this.syncLag();   // tick 里也会开新窗口（自动跑 / 自动胡之后的下一步），一样要按"玩家看到"起算
    if (this.game.tick(this.now())) {
      // 记录超时的人类玩家
      for (const e of this.game.events.slice(before)) {
        /* **只认"轮到你出牌却没出"这一种超时。**
           以前 pass 也算 —— 可 pass 是别人打了一张、你吃得起但不想吃，
           到点自动放过。那是一个**正经的选择**，不是人不在：
           牌局照样往下走，谁也没被耽误。按那个记，坐在桌上安安静静不吃两张牌
           就被判成"跑了"交给机器人，正是老板说的"要不起也被接手"。
           真不在的人跑不掉：轮到谁谁就得出牌，一局之内必然撞上这条。 */
        if (e.t === 'discard' || e.t === 'play_drawn') {
          const s = this.seats[e.seat];
          if (s && !s.isBot && s.userId !== null && s.userId > 0) {
            this.db.bumpStats(s.userId, { timeouts: 1 });
            /* 超时（延时卡也用完了）先记一笔：**连着第二回**才交给机器人接着打，
               头一回就接管太急了 —— 人可能只是走开倒杯水、或者网卡了一下。
               接管之后头像上挂个机器人标，他自己点一下按钮 / 理一次牌就收回来（wake）。 */
            s.misses = (s.misses ?? 0) + 1;
            if (s.misses >= 2) s.autoBot = true;
          }
        }
      }
      this.afterAct();
    }
  }

  private settledRound = -1;   // 已经结算过的局号：防止同一局结算两次（纪录表出现重复行）
  private roundClosed = -1;   // 已经"收过尾"的局号：收尾那一段必须只跑一次，也必须一定跑到

  /**
   * 一局打完：① 记分 / 写纪录表 / 存回放，② 收尾（换庄、状态改回等待、排下一局）。
   * 这两段分开、各自 try 起来 —— 以前是一整段，①里随便哪句抛个异常（比如某种胡法的详情少个字段），
   * 整个 settle 就断在那儿：房间还挂着 status='playing'、game.ended=true，
   * tick() 什么也不做，桌子就永远冻在"报了胡了"的那一刻。异常还被 WS 那层吞成一句 error 弹窗。
   */
  private settle() {
    const g = this.game!;
    if (this.settledRound !== this.roundNo) {
      this.settledRound = this.roundNo;
      try { this.settleLedger(g); }
      catch (e) {
        console.error(`[结算出错] 房间 ${this.cfg.id} 第 ${this.roundNo} 局（${this.cfg.variant}）`
          + ` winner=${g.winner} hu=${JSON.stringify(g.events.find(x => x.t === 'hu') ?? null)}`, e);
      }
    }
    if (this.roundClosed === this.roundNo) return;
    this.roundClosed = this.roundNo;
    try { this.closeRound(g); }
    catch (e) {
      // 收尾也炸了：至少别让桌子冻住 —— 状态改回等待，过一会儿开下一局
      console.error(`[收尾出错] 房间 ${this.cfg.id} 第 ${this.roundNo} 局`, e);
      this.status = 'waiting';
      this.nextRoundAt = Date.now() + 8000;
      try { this.broadcast(); } catch { /* ignore */ }
    }
  }

  private settleLedger(g: Game) {
    const deltas: Record<number, number> = {};
    for (let i = 0; i < this.seats.length; i++) {
      /* 这一局的输赢记在**开局时坐这个位子的人**头上 ——
         打到一半走人、别人（或机器人）接手，账不该算到接手的人身上。
         roundSeatUsers[i] 记着这一局这个位子先后坐过谁，取第一个。 */
      const uid = this.roundSeatUsers[i]?.[0] ?? this.seats[i].userId;
      if (uid === null || uid === undefined) continue;
      deltas[uid] = g.scores[i];
      this.totals.set(uid, (this.totals.get(uid) ?? 0) + g.scores[i]);
      if (uid > 0) {
        const p = g.players[i];
        const won = g.winner === i;
        const huEv = g.events.find(e => e.t === 'hu') as Extract<GameEvent, { t: 'hu' }> | undefined;
        // 这一间房自己的一本账（总的那本在 db 里，按人算；这本按房算）
        const rs = this.roomStats.get(uid) ?? { games: 0, hu: 0, dianpao: 0 };
        rs.games++;
        if (won) rs.hu++;
        if (huEv && !huEv.ziMo && huEv.fromSeat === i) rs.dianpao++;
        this.roomStats.set(uid, rs);
        const mul = won ? (huEv?.detail?.multiplier ?? 1) : 0;    // 本局倍率（翻倍的就是大胡）
        this.db.bumpStats(uid, {
          games: 1, wins: won ? 1 : 0, hu: won ? 1 : 0,
          zimo: won && huEv?.ziMo ? 1 : 0,
          dianpao: huEv && !huEv.ziMo && huEv.fromSeat === i ? 1 : 0,
          bighu: mul > 1 ? 1 : 0,
          max_xi: won ? (huEv?.detail?.xi ?? 0) : 0,
          max_mul: mul,
          ti: p.tiCount, pao: p.paoCount, violations: p.violations,
          points_won: g.scores[i] > 0 ? g.scores[i] : 0, points_lost: g.scores[i] < 0 ? -g.scores[i] : 0,
        });
        if (!this.cfg.isPrivate && g.scores[i] !== 0) this.db.addPoints(uid, g.scores[i], `lobby:${this.cfg.id}:${this.roundNo}`);
      }
    }
    /** 这一局这个位子算谁的：开局坐这儿的那个人（中途换人不改账） */
    const ownerOf = (i: number): number | null => this.roundSeatUsers[i]?.[0] ?? this.seats[i].userId ?? null;
    const winnerUid = g.winner !== null ? ownerOf(g.winner) : null;
    const hu = g.events.find(e => e.t === 'hu') as Extract<GameEvent, { t: 'hu' }> | undefined;
    const entry: LedgerEntry = {
      round: this.roundNo, variant: this.cfg.variant, winner: winnerUid, deltas, time: Date.now(),
      hu: hu ? { seat: hu.seat, card: hu.card, cid: hu.cid, ziMo: hu.ziMo, fromSeat: hu.fromSeat, detail: hu.detail } : null,
      seatNames: this.seats.map((s, i) => this.nameOf(ownerOf(i)) ?? this.nameOf(s.userId) ?? '空位'),
      // 耒阳可以弃胡：谁弃了、弃的哪张、当时值多少分，都记到纪录表里
      declines: g.players.flatMap(p => p.declinedHu.map(d => ({ seat: p.seat, card: d.card as number, unit: d.unit }))),
      // 分项：黄庄那种没有胡牌详情的局，也能看清这分是怎么来的（提龙即时分 / 违规罚分）
      tilong: g.tilongScores.slice(), penalty: g.penaltyScores.slice(),
      // 本局中途换过人的位子：一局里就可能超过三个人打过
      subs: this.roundSeatUsers.map((ids, seat) => ({ seat, names: ids.map(id => this.nameOf(id) ?? `#${id}`) }))
        .filter(x => x.names.length > 1),
      /* 这一局涉及的人当时叫什么，随这一局一起记下来 ——
         机器人打完就离桌、真人也可能退出，房间的在线名单里立刻就没了他；
         纪录表的列头和结算详情事后再查，就只剩一串 userId。 */
      names: (() => {
        const m: Record<number, string> = {};
        for (const id of new Set([...Object.keys(deltas).map(Number), ...this.roundSeatUsers.flat()])) {
          const nm = this.nameOf(id); if (nm) m[id] = nm;
        }
        return m;
      })(),
      // 亮牌快照：输赢表里回看这一局时，桌面长什么样照样摆出来
      reveal: (() => {
        const rv = g.view(null) as any;
        return {
          hands: rv.players.map((p: any) => (p.hand ?? []).slice()),
          melds: rv.players.map((p: any) => p.melds.map((m: any) => ({ ...m, hidden: false }))),
          pileRest: (rv.pileRest ?? []).slice(),
          winner: g.winner,
        };
      })(),
    };
    this.ledger.push(entry);
    // 一并存下这一局的"回放序列"：开局那副牌 + 每一步真正生效的决定（平均不到 1KB），
    // 照着 Game.start(deck) 再把这些步走一遍就能完整复原这一局
    this.db.recordRound(this.cfg.id, this.cfg.variant, this.cfg.isPrivate, winnerUid !== null && winnerUid > 0 ? winnerUid : null,
      { ...entry, roomName: this.cfg.name ?? this.cfg.id, detail: g.events.find(e => e.t === 'hu') ?? null,
        replay: { dealer: g.dealer, deck: g.deck, steps: g.replay } },
      [...new Set([...this.seats.map(s => s.userId), ...this.roundSeatUsers.flat()])]
        .filter((id): id is number => id !== null && id > 0),
      this.cfg.hostId ?? null);
  }

  /** 收尾：换庄、状态改回等待、清人、排下一局。这一段无论如何都要跑到 */
  private closeRound(g: Game) {
    // 先把这一局的牌收拢起来，下一局接着洗（收牌失败不能影响收尾，兜底回到随机洗）
    try { const c = g.collect(); this.carryDeck = c.length === 80 ? c : null; } catch { this.carryDeck = null; }
    const endEv = g.events.find(e => e.t === 'end') as Extract<GameEvent, { t: 'end' }> | undefined;
    this.dealer = endEv ? endEv.dealerNext : (this.dealer + 1) % this.seats.length;
    this.status = 'waiting';
    // 大厅：托管的座位给他留 Room.AWAY_KEEP_MS，过了这个点还不回来才真正让出去
    for (const s of this.seats) {
      // 起立走的不等这十分钟：他已经说了不回来，这一局打完位子就让出去
      if (s.isBot && s.userId !== null && s.userId > 0 && (s.stood || Date.now() - (s.awayAt ?? 0) > Room.AWAY_KEEP_MS)) {
        s.userId = null; s.isBot = false; s.ready = false; s.awayAt = undefined; s.stood = false; s.vacatedAt = Date.now();
      }
    }
    if (!this.keepAlive() && this.humanCount() === 0 && this.awayCount() === 0 && this.spectators.size === 0) { this.close(); return; }
    if (!this.cfg.isPrivate) {
      this.waitingSince = Date.now();
      for (const s of this.seats) if (s.userId !== null) s.ready = true;
    }
    this.dropBots();   // 人都走光了：机器人也散了，桌子腾出来给别人
    // 封顶：看的是整个房间的总输赢（赢家赢到的总分，等于输家输掉的总分），不是某一家
    const cap = this.cfg.swingCap ?? 0;
    const swing = [...this.totals.values()].reduce((a, v) => a + Math.max(0, v), 0);
    if (cap > 0 && swing >= cap) {
      this.pausedReason = `房间总输赢已达 ${swing} 分（上限 ${cap}），牌局暂停`;
      this.nextRoundAt = null;
      this.broadcast();
      return;
    }
    /* 几局一歇：打满这么多局就停一停，让大家看看账、抽根烟、决定还打不打。
       由房主或桌长（桌上最早坐下的那个真人）点「继续」。 */
    const every = this.cfg.pauseEvery ?? 0;
    if (every > 0 && this.roundNo > 0 && this.roundNo % every === 0) {
      this.pausedReason = `已经打满 ${this.roundNo} 局，歇一歇 —— 点「继续」接着打`;
      this.nextRoundAt = null;
      this.broadcast();
      return;
    }
    // 从"胡牌的那一刻"起算，倒计时走完就开下一局（房主可设）
    // 从"这一局的动画全部播完"起算（holdUntil 是最后一帧发出去的时间）：
    // 黄庄那种最后几张牌连着没人要的，客户端要播好一会儿，不留时间的话结算面板一闪而过甚至看不到
    this.nextRoundAt = Math.max(Date.now(), this.holdUntil) + (this.cfg.autoNextMs ?? 7000) * Number(process.env.BOT_SPEED || 1);
    this.broadcast();
  }

  /** 大厅固定桌：人走光了不关桌，把它清回空桌等下一拨人 */
  private resetTable() {
    this.game = null; this.frames = []; this.cur = [];
    this.status = 'waiting'; this.roundNo = 0; this.nextRoundAt = null; this.settledRound = -1; this.roundClosed = -1;
    this.ledger = []; this.totals.clear(); this.batches = []; this.batchNo = 0; this.batchFrom = 0;
    this.gone.clear(); this.batchStart.clear(); this.batchSeats = []; this.batchRoster = '';
    this.botSeat.clear();   // 机器人身份也一起忘掉，不然清完账它还背着老 id
    this.carryDeck = null; this.waitingSince = null;
    this.seats = this.seats.map(() => ({ userId: null, isBot: false, ready: false, client: null }));
    this.broadcast();
  }

  /** 加机器人 / 把机器人请出去（只有桌上有真人时才让操作，且不在牌局进行中） */
  bots(add: boolean, seat?: number): string | null {
    if (this.status === 'playing') return '牌局进行中，等这一局打完再说';
    if (this.humanCount() === 0) return '桌上没人';
    if (add) {
      // 指了座位就只补那一个（点空位请机器人）；没指就把空位全补上
      if (seat !== undefined) {
        if (seat < 0 || seat >= this.seats.length) return '没有这个座位';
        if (this.seats[seat].userId !== null) return '这个位子有人了';
        this.addBot(seat);
      } else {
        for (let i = 0; i < this.seats.length; i++) if (this.seats[i].userId === null) this.addBot(i);
      }
      this.waitingSince = Date.now();
    } else {
      for (let i = 0; i < this.seats.length; i++) {
        const s = this.seats[i];
        // 只请走真机器人；托管中的真人座位给人家留着
        if (s.isBot && (s.userId ?? 0) < 0) { this.users.delete(s.userId!); this.seats[i] = { userId: null, isBot: false, ready: false, client: null }; }
      }
      this.waitingSince = null;   // 别马上又补回来
    }
    this.broadcast();
    return null;
  }

  /** 房主开的私人房：人走光了也不自动解散（散不散由房主说了算） */
  private keepAlive() { return this.cfg.isPrivate && this.cfg.hostId != null && this.status !== 'closed'; }

  /** 房主观战：不坐下，只看桌上的下地牌和弃牌（留着兼容老客户端，正常已经不走这条路） */
  spectate(user: UserRow, client: Client): string | null {
    if (this.status === 'closed') return '房间已关闭';
    if (this.cfg.hostId !== user.id) return '只有房主可以观战';
    if (this.seatOf(user.id) >= 0) return '你已经在座位上了';
    this.spectators.set(user.id, client);
    this.remember(this.publicUser(user));
    client.send({ type: 'room.state', room: this.view(user.id) });
    return null;
  }
  unspectate(userId: number) { this.spectators.delete(userId); }

  /** 房主强制作废当前这一局：不结算、不计分，人齐了重开（补位补不齐时用） */
  abortRound(userId: number): string | null {
    if (this.cfg.hostId !== userId) return '只有房主可以作废本局';
    if (!this.game || this.game.ended) return '现在没有在打的牌局';
    this.game = null; this.frames = []; this.cur = []; this.frameAt = 0; this.holdUntil = 0;
    this.status = 'waiting';
    this.roundNo = Math.max(0, this.roundNo - 1);
    this.settledRound = -1;
    this.pausedReason = null;
    this.nextRoundAt = null;
    for (const st of this.seats) { st.botAt = undefined; if (st.userId !== null) st.ready = true; }
    this.broadcast();
    return null;
  }

  /** 点「继续」：解除暂停（封顶 / 几局一歇都走这儿）。
      房主可以点；没房主的大厅桌、以及房主不在场的时候，桌长（最早坐下的那个真人）也可以点。 */
  hostResume(userId: number): string | null {
    if (!this.canResume(userId)) return '等房主或桌上第一位玩家点继续';
    if (this.pausedReason === null) return null;
    this.pausedReason = null;
    if (this.status === 'paused' && this.game && !this.game.ended) this.resume();
    else { this.status = 'waiting'; this.nextRoundAt = Date.now() + (this.cfg.autoNextMs ?? 7000); this.broadcast(); }
    return null;
  }

  /** 踢人：只能踢机器人；牌局进行中踢 = 本局作废，15 秒后重开 */
  kick(byUserId: number, seatIdx: number): string | null {
    if (this.seatOf(byUserId) < 0) return '先坐到桌上';
    const s = this.seats[seatIdx];
    if (!s || s.userId === null) return '这个位置上没人';
    if (!s.isBot || s.userId > 0) return '只能踢机器人';
    const wasPlaying = this.status === 'playing' || this.status === 'paused';
    this.users.delete(s.userId);
    this.seats[seatIdx] = { userId: null, isBot: false, ready: false, client: null };
    if (wasPlaying) {
      // 本局作废：不结算、不记分，倒计时 15 秒之后重开一局
      this.game = null; this.frames = []; this.cur = []; this.frameAt = 0; this.holdUntil = 0;
      this.status = 'waiting';
      // 这一局作废：局号还给它（下一局还是这个号），结算标记也要清掉，
      // 不然下一局打完会被当成"已经结算过"，房间就永远停在 playing 了
      this.roundNo = Math.max(0, this.roundNo - 1);
      this.settledRound = -1;
      this.nextRoundAt = Date.now() + 15000;
      for (const st of this.seats) if (st.userId !== null) st.ready = true;
      for (const st of this.seats) st.botAt = undefined;
    }
    this.waitingSince = null;   // 别马上又自动补回来
    this.lastActivity = Date.now();
    this.broadcast();
    return null;
  }

  close(force = false) {
    // 固定桌不关：清空重来（后台撤桌时 force = true 才真关）
    if (this.cfg.fixed && !force && this.status !== 'closed') { this.resetTable(); return; }
    if (this.status === 'closed') return;
    this.status = 'closed';
    /* 结算总表：人早走了 users 里就没有他 —— 按名字册补一个最小的身份出来，
       不然这一栏要么整行不见，要么显示成一串 userId。 */
    const totals = [...this.totals.entries()]
      .map(([id, total]) => ({ user: this.users.get(id) ?? this.fallbackUser(id), total }))
      .filter(x => !!x.user) as { user: PublicUser; total: number }[];
    for (const s of this.seats) s.client?.send({ type: 'room.closed', ledger: this.ledger, totals });
    this.onClosed?.(this);
  }

  // ---------- 视图与广播 ----------
  view(forUserId: number | null, gView?: any): RoomView {
    const mySeat = forUserId === null ? -1 : this.seatOf(forUserId);
    const seats: SeatView[] = this.seats.map((s, i) => ({
      seat: i,
      user: s.userId === null ? null : (this.users.get(s.userId) ?? null),
      ready: s.ready,
      online: s.isBot || !!s.client,
      isBot: s.isBot,
      kickable: s.isBot && (s.userId ?? 0) < 0,
      auto: !!s.autoBot,
      total: s.userId === null ? 0 : (this.totals.get(s.userId) ?? 0),
    }));
    const g = gView ?? (this.game ? this.game.view(mySeat >= 0 ? mySeat : null) : null);
    return {
      id: this.cfg.id, isPrivate: this.cfg.isPrivate, variant: this.cfg.variant, variantName: this.rules.name,
      baseScore: this.cfg.baseScore, hostId: this.cfg.hostId ?? null, status: this.status, seats,
      roundNo: this.roundNo, mySeat: mySeat >= 0 ? mySeat : null,
      game: g ? { ...g, serverNow: this.now(), nextRoundAt: this.nextRoundAt } : null,
      /* 纪录表只发最近 20 条：客户端只用得着最后一条（结算面板）和"打了多少局"，
         而 ledger 是一局一条往上加的 —— 全量带上的话，一桌打到三位数局数，
         每一次广播都要多背几十 KB，几千桌同时打就是白白几十兆的流量。 */
      ledger: this.ledger.slice(-20), ledgerCount: this.ledger.length,
      /* 换过人的房间：之前那几批各自成一段（自己的表头 + 自己的那几局），排在纪录表下面；
         离桌的人各自把账带着，单独列一行 —— 回来了就从那儿提出来接着算。 */
      batches: this.batches.length ? this.batches : undefined,
      batchFrom: this.batchFrom || undefined,
      gone: this.gone.size
        ? [...this.gone].map(([id, total]) => ({ id, name: this.nameOf(id) ?? `#${Math.abs(id)}`, total }))
        : undefined,
      tier: this.cfg.tier, name: this.cfg.name,
      pausedReason: this.pausedReason,
      nextRoundAt: this.nextRoundAt,
      // 倒计时按"还剩多少"发：客户端拿绝对时间去减自己的钟，手机时间不准就会数出几千秒来
      nextRoundIn: this.nextRoundAt === null ? null : Math.max(0, this.nextRoundAt - Date.now()),
      spectating: mySeat < 0 && this.spectators.has(forUserId ?? -1),
      // 我能不能点「继续」：房主，或者桌长（桌上最早坐下的那个真人）
      canResume: forUserId !== null && this.canResume(forUserId),
      config: { turnSec: this.cfg.turnSec ?? 20, autoNextSec: Math.round((this.cfg.autoNextMs ?? 7000) / 1000),
        swingCap: this.cfg.swingCap ?? 0, pauseEvery: this.cfg.pauseEvery ?? 0,
        play: { noXiHu: this.rules.noXiHu > 0, raiseHand: this.rules.raiseHand,
          redBlack: this.rules.redBlack, huCardDun: this.rules.huCardDun, deal: this.rules.deal } },
    };
  }

  private pendingBroadcast = false;
  broadcast() {
    // 还有帧没发完：实时状态先别发，不然客户端会抢在动画前面把局面画出来（牌先落进弃牌堆又消失）
    if (this.frames.length) { this.pendingBroadcast = true; return; }
    this.pendingBroadcast = false;
    for (const s of this.seats) if (s.client && s.userId !== null) s.client.send({ type: 'room.state', room: this.view(s.userId) });
    for (const [uid, c] of this.spectators) c.send({ type: 'room.state', room: this.view(uid) });
  }

  /** 把新产生的牌局事件按座位过滤后推送 */
  flush() {
    if (!this.game) return;
    this.closeFrame(true);
    this.eventCursor = this.game.events.length;
    // 有些动作不产生事件（比如点了碰但还要等更高优先级的人表态），也得把最新状态发出去
    if (!this.frames.length) {
      this.game.freshHold(0);   // 没有新动画，起点就是现在；把"刚开的窗口"标记清掉
      for (const s of this.seats) if (s.client && s.userId !== null) s.client.send({ type: 'game.events', events: [], room: this.view(s.userId) });
      return;
    }
    // 胡牌、系统代做的提 / 偎 / 跑 / 龙：动作出现之前先停一下 ——
    // 摸出来的那张牌要先明给大家看清楚，再下地，别牌一摸出来手里的对子就没了
    const k = Number(process.env.BOT_SPEED || 1);
    const AUTO = new Set(['ti', 'wei', 'pao', 'long']);
    // 「没人要得起」也要停一下再揭晓：不然这张牌掉进牌池的速度比别人点过还快，
    // 等于告诉摸牌的人"这张是真没人要"，而不是"有人弃碰弃吃"
    // 牌死了要不要停一下，看它是怎么死的：压根没人要得起（auto）才需要装成"大家在想"；
    // 有人点了过 / 超时才死的，大家已经实打实等过了，立刻进下一轮，别再干等
    const autoDead = (e: GameEvent) => (e.t === 'dead' || e.t === 'play_drawn') && (e as any).auto === true;
    const needPause = (f: { evs: GameEvent[] }) => f.evs.some(e => e.t === 'hu' || autoDead(e)
      || (e.t === 'meld' && AUTO.has(e.meld.type)));
    // 只有「吃」和「没人要得起」这两种需要先捂一下再揭晓：
    // 吃的优先级最低，"马上吃到"还是"等了一会才吃到"能看出有没有人弃碰（说明他手里有两张）；
    // 碰 / 偎 / 提 / 跑 / 胡 都是高优先级，点了就该立刻有反应，不用等。
    // 点了过、超时弃牌这种"人已经等过了"的，不再捂。
    const masked = (f: { evs: GameEvent[] }) => f.evs.some(e => autoDead(e)
      || (e.t === 'meld' && e.meld.type === 'chi' && !e.noMask));
    if (k >= 0.5) {
      // 捂的是"揭晓的那一帧"，不一定是第一帧：摸牌之后才发现没人要得起时，
      // 这段等待要加在摸牌那一帧后面，不然摸出来的牌"啪"一下就掉进出牌区，等于告诉人家真没人要
      const idx = this.frames.findIndex(masked);
      if (idx === 0) this.frameAt = Math.max(this.frameAt, Date.now() + Math.round(this.holdMs() * k));
      else if (idx > 0) this.frames[idx - 1].delay = Math.max(this.frames[idx - 1].delay, Math.round(this.holdMs() * k));
    }
    if (k >= 0.5) for (let i = 1; i < this.frames.length; i++) {
      // 前一帧自己就是"停顿过的那一步"（比如摸牌后已经停过），就别再叠一次
      const isHu = this.frames[i].evs.some(e => e.t === 'hu' || e.t === 'liuju');
      // 胡牌一定要单独停一拍：偎起胡 / 开跑胡 / 提龙胡 是"先下地、再胡"两步，
      // 不然偎的报牌还没落地，结算面板就盖上来了
      if (needPause(this.frames[i]) && (isHu || !needPause(this.frames[i - 1]))) {
        // 胡牌之前停久一点（像是想了想才按的胡）；提 / 跑 / 偎 这些只要 0.5 秒 ——
        // 让摸出来 / 打出来的那张牌先落到明牌位置，再接着下地，动作才连得上
        // 提 / 跑 / 偎：0.5 秒就够 —— 摸出来 / 打出来的那张牌先落到明牌位置，再接着下地，动作才连得上。
        // 胡牌、以及"没人要得起"（play_drawn / dead）要停久一点：前者像是想了想才按胡，
        // 后者得跟"有人弃碰弃吃"的节奏一样，不然从快慢就能看出是真没人要还是有人放弃了
        const slow = this.frames[i].evs.some(e => e.t === 'hu' || e.t === 'liuju' || autoDead(e));
        const ms = slow ? this.thinkMs() : 500;
        this.frames[i - 1].delay = Math.max(this.frames[i - 1].delay, Math.round(ms * k));
      }
    }
    /* ── 动画欠账封顶 ──────────────────────────────────────────────
     * 三个真人打的时候没有机器人提速，每一手的停顿都是实打实的：
     * 一次"没人要得起"要捂 holdMs()（跟读秒成正比，12 秒读秒时约 1.2~2 秒），
     * 后面 dead 那一帧再 900ms，胡牌前还要再想一拍。几手下来就积起来了 ——
     * 三人真人房压测里量到队列最多压着 **4798ms** 的动画。
     *
     * 而客户端自己的兜底是"排队超过 4 秒就整批扔掉、直接跳到最新局面"。
     * 两头一凑，玩家看到的就是老板描述的那样：读秒卡着不动（画面上是那张
     * 早就过期的旧快照，圈贴着红），然后哗啦跳过好几个状态，轮到下一个人
     * 又卡一下再跳 —— 一路这样转到胡牌或者流局，中间压根来不及出手。
     * 落后一旦形成就还不回来，所以"节奏乱一次，这一局后面就全乱"。
     *
     * 封顶之后：桌面闲着的时候节奏照旧，忙起来就把这一批的停顿等比压缩，
     * 宁可动画快一点，也不让人落在服务端后头。
     *
     * 代价说明白：压缩的时候"捂一下再揭晓"那段也会跟着短。那段本来是用来
     * 遮掩"这张牌到底是没人要得起、还是有人弃了碰"的。忙起来遮得没那么严实 ——
     * 但跟"整局都点不动"比，这个代价可以接受。 */
    {
      const pending = Math.max(0, this.frameAt - Date.now());      // 上一批还欠着多久
      const total = this.frames.reduce((a, f) => a + f.delay, 0);  // 这一批要播多久
      if (pending + total > Room.MAX_ANIM_LAG_MS) {
        // 先把上一批欠的往回收一点，再给这一批留出剩下的额度
        if (pending > Room.MAX_ANIM_LAG_MS) this.frameAt = Date.now() + Room.MAX_ANIM_LAG_MS;
        const room = Math.max(250, Room.MAX_ANIM_LAG_MS - Math.min(pending, Room.MAX_ANIM_LAG_MS));
        if (total > room) {
          const shrink = room / total;
          // 每帧至少留 40ms：全压成 0 的话客户端会一次性收到一大串，又成了"哗啦跳几个状态"
          for (const f of this.frames) f.delay = Math.max(40, Math.round(f.delay * shrink));
        }
      }
    }
    // 除了立刻发的第一帧，后面的帧要等各自的动画时间；这段等待里机器人也按住不动
    // 每一帧的 delay 决定"下一帧"什么时候发，所以总等待 = 除最后一帧外所有帧的 delay。
    // 注意 frameAt 只能往后走：上一批还没播完时有人出牌，不能把已经排好的停顿一笔勾销。
    const doneAt = Math.max(Date.now(), this.frameAt) + this.frames.slice(0, -1).reduce((a, f) => a + f.delay, 0);
    /* **最后一帧自己也要播**。doneAt 只算到"最后一帧发出去"那一刻，可玩家要等它播完
       才看得见那张牌 —— 而窗口（碰的那半程尤其短）恰恰就是这一帧开的。
       漏掉这一段，玩家看到牌的时候圈已经走掉一截：出牌 600ms、摸牌 650ms，
       庄家第一张更惨 —— 前面压着 2.4 秒的阳张，一步一步全少算。
       （frameAt 在 sendFrames 里本来就把这一段记上了，所以**下一批**是对的，
       唯独开这一批窗口的时候没算 —— 少的就是这一笔。） */
    const lastAnim = this.frames.length ? this.frames[this.frames.length - 1].delay : 0;
    /* 时限**只在开窗口那一刻定一次**（那会儿已经按"还有多少动画没播完"补过了），
       之后不再事后找补。以前是边播边往后推，推的量又是按帧的停顿估出来的 ——
       玩家看到的就是圈先满着不动一会儿，然后忽快忽慢，没个准。定死了反而看得明白。 */
    this.holdUntil = Math.max(this.holdUntil, doneAt + lastAnim);
    /* 开窗口的时候只补得上**上一批**没播完的那段（lag）；这一步自己要播多久，
       得等上面把帧排完才算得出来。差的这一截在这儿一次性补上，
       只补"这一步刚开的窗口"，已经在走的一概不动 —— 还是只认起点，不事后找补。
       （不补的话就是：别人打出一张我能碰的牌，牌还在飞，我的碰窗口已经走掉一大半，
       等按钮真出现在屏幕上，那圈几乎没得走了；吃的圈是客户端自己归一化的，所以看着正常。） */
    // doneAt 是"最后一帧发出去"的时刻，还要加上它在路上走的那一截，才是"玩家看到"；
    // 减掉开窗口时已经按 lag 补过的（lag 本身也含这一截），剩下的才是这回要补的
    this.game.freshHold(Math.max(0, doneAt + lastAnim - Date.now()) + this.halfRtt() - this.game.lag);
    this.sendFrames();
  }

  /** 到点就把下一帧发出去；没到点等下一次 tick */
  private sendFrames() {
    if (!this.game || !this.frames.length) return;
    const now = Date.now();
    let staleTail = false;   // 这一批的最后一帧发的是"当时的快照"，不是实时状态
    while (this.frames.length && now >= this.frameAt) {
      const f = this.frames.shift()!;
      // 这一批的最后一帧：画面已经追上服务端了，直接发实时状态 ——
      // 用当时的快照会把按钮吞掉（比如偎完那一帧拍的还是"摸牌"阶段，
      // myOptions 被判成旧画面清空，结果该出牌的人一个按钮都看不到，只能干等超时）
      // 这一批的最后一帧、而且引擎确实没再往前走：才敢发实时状态。
      // 机器人提速之后，一帧还没发出去引擎就可能已经又走了一步（比如接着偎了），
      // 这时候再发实时状态，画面就会跑到播报前头去。
      const last = !this.frames.length && f.evAt === this.game.events.length;
      if (!this.frames.length) staleTail = !last;
      for (let i = 0; i < this.seats.length; i++) {
        const s = this.seats[i];
        if (!s.client || s.userId === null) continue;
        const mine = f.evs.filter(e => e.t !== 'options' || e.seat === i);
        /* 半路回来的人：这一批的动画他从头就没看，补播没有意义，
           还会把他的按钮按掉。直接给实时状态，让他立刻能打。 */
        if (s.freshJoin) { s.client.send({ type: 'game.events', events: [], room: this.view(s.userId) }); continue; }
        const gv = last ? undefined : f.gviews[i];
        if (gv && this.game) {
          if (gv.phase === this.game.phase) {
            gv.deadline = this.game.deadline;
            (gv as any).deadlineSpan = (this.game as any).deadlineSpan ?? (gv as any).deadlineSpan;
            const live = this.game.optionsFor(i);
            // 快照是"当时"拍的，期限在切片播放期间被整体往后推过 —— 按钮那圈倒计时也得用最新的，
            // 不然玩家看到的窗口比服务端真正给的短一截。
            // 更要紧的是**服务端已经没有我的选项了**（窗口关了 / 这一轮已经定了）：
            // 那就把按钮收掉。以前这里只在 live 有值时才覆盖，live 为 null 时留着旧快照 ——
            // 于是碰的按钮还在那儿转圈，点下去却"没有任何反应"（错误码是静音的 already decided）。
            /* **按钮一律以实时的为准，快照里有没有都一样。**
               以前这儿外面套着 `if (gv.myOptions)` —— 只在"快照里本来就有按钮"时才去校正。
               于是出现这么一种：快照是在**轮到我之前**拍的（myOptions 是 null），
               可上面两行已经把 deadline 换成实时的了 —— 发出去就是
               **读秒是新的、按钮是空的**，正好就是老板说的
               「倒计时还在，我的吃、碰甚至过牌按钮都不见了」。
               三人真人房压测里这条最常出现在 dead（这张牌没人要）那一帧后面：
               牌一进池子就轮到我出牌了，可我收到的还是那张"还没轮到我"的快照。
               既然已经认定 phase 跟实时一致、也已经采用了实时的 deadline，
               那按钮就没有理由还用旧的 —— 半新半旧才是病根。 */
            if (live) {
              gv.myOptions = {
                ...(gv.myOptions ?? {}),
                options: live.options,
                deadline: live.deadline,
                span: (live as any).span,
                fastUntil: (live as any).fastUntil,
                fastSpan: (live as any).fastSpan,
                huUntil: (live as any).huUntil,
                huSpan: (live as any).huSpan,
              } as any;
            } else gv.myOptions = null;
          } else {
            // 这一帧是旧画面：局面早就往前走了，别把当时的按钮（比如摸牌那一瞬的「打出」）
            // 留在屏幕上，点了也没用，还会泄漏信息
            gv.myOptions = null;
          }
        }
        s.client.send({ type: 'game.events', events: mine, room: this.view(s.userId, gv) });
      }
      for (const [uid, c] of this.spectators) {
        const mine = f.evs.filter(e => e.t !== 'options');
        c.send({ type: 'game.events', events: mine, room: this.view(uid, last ? this.game.view(null) : f.gviews[this.seats.length]) });
      }
      // 最后一帧的时长也要算：下一批（下一个动作）得等这一步播完再来
      this.frameAt = now + f.delay;
    }
    /* 帧发完了，把攒下的状态补发一次。
       `staleTail`：这一批的最后一帧发的是**当时的快照**（引擎在这一帧发出去之前又往前走了一步，
       所以不敢发实时状态）—— 那客户端就停在那个快照上了，后面又没有帧来纠正它。
       出过一次这样的事：打出去的那张牌还留在手上，得等下一个动作才恢复。补一次实时状态。 */
    // 这一批播完了：半路回来的人重新跟上正常节奏
    if (!this.frames.length) for (const s of this.seats) s.freshJoin = false;
    if (!this.frames.length && (this.pendingBroadcast || staleTail)) this.broadcast();
  }

  chat(from: PublicUser, msg: ServerMsg) {
    for (const s of this.seats) if (s.client) s.client.send(msg);
  }
}
