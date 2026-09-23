import { type Kind, KIND_COUNT, fullDeck, shuffle, toCounts, isRed, isBig, sortKinds } from './cards.ts';
import { type Group, partition, partitionKeepKan, chiXi, pengXi, weiXi, paoXi, tiXi, kanXi, layDownAll, breaksKan } from './groups.ts';
import { nameOf as nameOfKind } from './cards.ts';
import { type RuleSet, hengyangDun, leiyangDun } from './rules.ts';

export type MeldType = 'peng' | 'wei' | 'pao' | 'ti' | 'long' | 'chi'; // long = 起手四张（龙）
export interface Meld {
  cids?: number[];      // 这一组每张牌的号（跟 cards 一一对应）
  type: MeldType;
  cards: Kind[];
  xi: number;
  hidden: boolean;   // 偎/提 为暗牌
  from: number;      // 来源座位（自摸为自己）
  fromCid?: number;  // 这一组里「从别家那儿拿来的」是哪一张（牌号）；自己凑成的没有这一项
  fromDrawn?: boolean; // 那一张是他**摸上来亮在桌上**的（不是从手里打出去的）
  again?: boolean;   // 重提 / 重跑：在原来的偎 / 碰上加一张，手里没动牌
  part?: boolean;    // 一次动作里附带下地的牌组（吃牌下伙的第二、第三组）：不再单独报一次
}

export type ActionType = 'hu' | 'ti' | 'pao' | 'wei' | 'peng' | 'chi' | 'pass' | 'discard' | 'play_drawn';
const ACTION_CN: Record<string, string> = { hu: '胡', ti: '提', pao: '跑', wei: '偎', peng: '碰', chi: '吃' };

export interface ActionOption {
  type: ActionType;
  card: Kind;            // 相关牌（目标牌）
  combos?: Kind[][];     // 吃的可选组合（手牌两张）
  comboLays?: Kind[][][][]; // 每个吃法对应的若干种"下伙"凑法（每种是一组牌组），息高的排前面
  xi?: number;
  unit?: number;         // 胡：每家应付分（未计放炮倍数）
}

export interface Claim {
  huDeclined?: boolean;   // 这一条已经记过一次"弃胡"了，别重复记（快窗口过一次、整条到点又一次）
  seat: number;
  options: ActionOption[];
  deadline: number;
  span?: number;        // 本次表态原本给了多久（用延时卡时按这个再给一次）
  /** 碰 / 跑 / 胡这些"快"选项的到点时间（读秒的一半）；吃可以一直等到 deadline。0 = 没有快选项 */
  fastUntil?: number;
  fastSpan?: number;     // 这半程原本给了多久（客户端按它画按钮那圈倒计时）
  fastDone?: boolean;   // 快选项的窗口已经过去了（options 保留原样，臭牌之类还要照它判）
  /** 衡阳「有胡必胡」：胡单独一个更短的窗口（5 秒，到点自动胡），跟碰 / 跑那半程分开算 */
  huUntil?: number;
  huSpan?: number;
  /** 这一条是**这一步刚开的**：它的时限已经按 lag 补过了，切片播放那一笔别再给它补第二遍
      （补两遍的话，圈会先"满着不动"一两秒，等动画放完了才开始走）。 */
  fresh?: boolean;
  /** 「影子表态」：摸牌时给摸牌者**下家**挂的那一条 —— 他一张都要不起，
      所以没有选项、界面上不显示任何按钮，服务端只是照常等它那 3 秒再推进。
      有了它，"没人要得起"跟"有人放弃了"花的时间一样长，从节奏上看不出牌。 */
  ghost?: boolean;
  decision?: { type: ActionType; combo?: Kind[]; lay?: number } | null; // null = 过
}

export interface TableCard {
  card: Kind;
  from: number;
  source: 'draw' | 'discard';
  at?: number;          // 这张牌摆上桌的时刻（用来判断碰的时限过没过）
  cid?: number;         // 牌号：同一个字有四张，靠它区分是"哪一张"（见下面 nextCid）
}

export type Phase =
  | 'init'
  | 'drawer_decide'   // 摸牌者决定如何处理摸到的牌
  | 'claim'           // 其他玩家对桌面牌 胡/跑/碰/吃 仲裁
  | 'discard'         // 某玩家出牌
  | 'ended';

export interface PlayerState {
  seat: number;
  hand: Kind[];
  melds: Meld[];
  chou: Kind[];             // 臭牌（放弃过碰的牌）
  tookCard: boolean;
  tookCount: number;        // 这一局进了几张（下地几次）：耒阳「举手胡」看这个        // 起手之后进过张（耒阳「举手胡」要求一张没进过）
  discards: Kind[];         // 本人打出且无人要的牌
  tiCount: number;
  paoCount: number;
  longCount: number;        // 提 + 跑 + 龙 总数（决定是否需要出牌与作对）
  acted: boolean;           // 是否已出过牌 / 动过手（用于地胡判定）
  declinedUnit: number;     // 耒阳：放弃过的胡的最高每家分，下次胡必须更高
  declinedHu: { card: Kind; unit: number }[];   // 耒阳：弃过的胡（哪张牌、每家多少分），纪录表里要写出来
  freeDiscards: number;     // 免出牌次数：起手多条龙时，每多一条就有一次"进张之后不出牌"
  noTake: boolean;          // 打出的牌被别家开跑之后：本局不能再主动进张（不能吃、不能碰）
  discardSrc: ('hand' | 'draw')[];   // 与 discards 一一对应：摸上来直接打出 / 从手里打出
  discardCids: number[];             // 与 discards 一一对应的牌号：同一个字四张，靠它认人
  ids: number[];                     // 手里这些牌的号（不排序、只是个袋子；同一个字的几张可以互换，随便取一个都对）
  passedChi: Kind[];        // 上家打出时本可吃而没吃的牌（之后再吃 = 吃回头牌，违规）
  violations: number;
}

export type GameEvent =
  | { t: 'deal'; dealer: number }
  | { t: 'draw'; seat: number; card: Kind; pileLeft: number; cid?: number }
  | { t: 'bupai'; seat: number; pileLeft: number }                   // 起手提后补牌（不公开）
  | { t: 'play_drawn'; seat: number; card: Kind; auto?: boolean; cid?: number }   // auto：压根没人要得起（需要捂一下再揭晓）
  | { t: 'discard'; seat: number; card: Kind; cid?: number }
  | { t: 'dead'; card: Kind; auto?: boolean; cid?: number }                       // 牌无人要，进牌池；auto：没人要得起（而不是有人点了过）
  | { t: 'meld'; seat: number; meld: Meld; fromSeat: number; noMask?: boolean; deal?: boolean }   // noMask: 这一步不用捂着慢慢揭晓；deal: 发牌时的起手龙（三家一起下，不分先后）
  | { t: 'pass'; seat: number; card: Kind }
  | { t: 'options'; seat: number; options: ActionOption[]; deadline: number }
  | { t: 'need_discard'; seat: number; deadline: number }
  | { t: 'tilong_score'; seat: number; type: 'ti' | 'long'; delta: number[] }
  | { t: 'hu'; seat: number; card: Kind; ziMo: boolean; fromSeat: number; detail: HuDetail }
  | { t: 'penalty'; seat: number; reason: string; delta: number[] }   // 违规罚分：每家 3 分
  | { t: 'delay_grant'; counts: number[] }                          // 发延时卡（开局 / 公共牌过半）
  | { t: 'delay_use'; seat: number; left: number; deadline: number } // 用掉一张延时卡，行动时间续一次
  | { t: 'liuju' }
  | { t: 'dealer_card'; seat: number; card: Kind; cid?: number }   // 发牌时亮出庄家多的那一张
  | { t: 'end'; scores: number[]; winner: number | null; dealerNext: number };

export interface HuDetail {
  handGroups: Group[];
  pair: Kind[] | null; // 作对的对子
  melds: Meld[];
  xi: number;          // 基本胡息
  extraXi: number;     // 红字额外胡
  dun: number;         // 敦（含胡牌张数加敦）
  huCardCount: number; // 胡的那张字在手中的张数（衡阳加敦）
  multiplier: number;  // 各番相乘
  redCount: number;
  redName: string;     // 大红 / 小红 / 全黑 / 一点红 / ''
  tianHu: boolean;
  diHu: boolean;
  raiseHand?: boolean;   // 耒阳举手胡
  ziMo: boolean;
  unit: number;        // 每家应付分（放炮时由放炮者按倍数独付）
  dianPao: boolean;    // 放炮（从手里打出的牌被胡）
  breakdown: string[];
  scores: number[];    // 本局每家净得分（含提龙即时分）
  bigMeldType?: string; // 'ti' | 'long' = 提龙胡；'pao' = 开跑胡
  huWay?: string;       // 胡的方式：'chi' 吃胡 / 'peng' 碰胡 / 'ti' 提龙胡 / 'pao' 开跑胡 / 'wei' 偎起胡
  huKind?: Kind;        // 胡的是哪个字（提龙胡 / 开跑胡这些没有"那一张"，就是下地的那个字）
  /* 胡的那一张落在 handGroups 的第几组（-1 = 不在手牌里，比如提龙胡 / 开跑胡）。
     同一个字手里可能有好几张（一二三 里的二、二七十 里的二），
     光看牌面永远分不清该标哪一组 —— 由引擎按这一手真正的拆法说了算。 */
  huGroupIdx?: number;
  huDelta?: number[];   // 本次胡牌的输赢
  penalty?: number[];   // 本局违规罚分小计
  tilong?: number[];    // 本局提龙即时分小计（耒阳）
}

export interface GameOptions {
  rules: RuleSet;
  baseScore: number;
  dealer: number;
  rnd?: () => number;
  now?: () => number;
  /** 每产生一个事件就回调一次（服务端用来按轮次切片、抓当时的快照） */
  onEvent?: (e: GameEvent) => void;
  /** 回放 / 复盘：时钟是停着的，所有"捂一下"的等待都跳过，照着记下来的动作一步步重跑就行 */
  replay?: boolean;
}

/**
 * 单局跑胡子状态机（纯逻辑，不含网络）。
 * 手牌数不变量：等待状态手牌 ≡ 2 (mod 3)；摸牌/得牌后 ≡ 0 即可判胡。
 */
export class Game {
  rules: RuleSet;
  baseScore: number;
  players: PlayerState[] = [];
  pile: Kind[] = [];
  dealer: number;
  phase: Phase = 'init';
  turn = 0;                      // 当前行动座位
  drawn: Kind | null = null;     // 摸牌者手上待决定的牌
  tableCard: TableCard | null = null;
  claims: Claim[] = [];
  deadline = 0;
  deadPool: Kind[] = [];         // 牌池（无人要的牌）
  delayCards: number[] = [];     // 各家手里的延时卡
  private deadlineSpan = 0;      // 当前 deadline 原本给了多久
  private pileStart = 0;         // 发完手牌时公共牌堆的张数
  private midGranted = false;    // 牌局过半的那张延时卡发过了没
  events: GameEvent[] = [];
  scores: number[];              // 本局分数变化
  winner: number | null = null;
  ended = false;
  tianHuPossible = false;
  dealerCard: Kind = -1;        // 庄家多出来、发牌就亮出来的那一张
  private dealt = false;        // 发牌阶段已结束（起手龙不算"进牌"）
  private diHuOffer = false;    // 正在问"有没有人地胡"（衡阳：庄家亮出来的那张）
  private rnd: () => number;
  private now: () => number;
  private onEvent?: (e: GameEvent) => void;
  private drawerOptions: ActionOption[] = [];
  /**
   * 牌号（cid）：一副牌 80 张，光看牌面分不出"这张大贰是哪一张大贰"。
   * 一张牌离开牌堆 / 离开手牌、变成大家看得见的那一刻发一个号，从此这张牌就是这张牌 ——
   * 客户端拿它对动画和弃牌堆，不用再靠"数张数、比牌面"去猜，也就不会出现
   * "打出来的牌闪一下又没了"。弃牌只进不出，号永远不回收。
   */
  private replayMode = false;
  /** 一副牌 80 张，牌号就是它在这副牌里的位置（0~79），开局那一刻就钉死，一局之内绝不变。
   *  `deck[id]` 就是这张牌的牌面，所以拿着号就能知道是哪一张。 */
  private pileIds: number[] = [];      // 牌堆里每张牌的号（跟 pile 一一对应）
  private nextCid = 1000;              // 兜底号：万一有来路不明的牌（理论上不该发生），从 1000 往后发
  private newCid() { return ++this.nextCid; }
  private takenIds: number[] = [];     // 刚从手里/旧牌组里拿出来、正要凑成一组的那几张牌的号
  private claimCid?: number;           // 这一次是从别家那儿要走的哪一张（牌号）—— 只为在牌面上打个「这张是他给的」的记号
  private claimDrawn = false;          // 那一张是他摸上来亮在桌上的，还是从手里打出去的
  private drawnCid = 0;
  private dealerCid = -1;
  private selfHuFrom = -1;   // 天胡 / 提龙胡 / 跑后胡 时牌的来源座位
  private selfHuDianPao = false; // 跑来的牌若是别人从手里打出的，胡了算放炮
  penaltyScores: number[] = [];       // 本局各家的违规罚分小计
  tilongScores: number[] = [];        // 本局各家的提龙即时分小计
  private bigMeldKind: Kind = -1;     // 提龙 / 开跑 胡时，那一坎的字（四张，衡阳加 4 敦）
  private bigMeldType: string = '';   // 'ti' | 'long' | 'pao'

  constructor(opts: GameOptions) {
    this.rules = opts.rules;
    this.baseScore = opts.baseScore;
    this.dealer = opts.dealer;
    this.rnd = opts.rnd ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.onEvent = opts.onEvent;
    this.replayMode = !!opts.replay;
    const n = this.rules.players;
    this.penaltyScores = new Array(n).fill(0);
    this.tilongScores = new Array(n).fill(0);
    this.delayCards = new Array(n).fill(0);
    for (let s = 0; s < n; s++) this.players.push({ seat: s, hand: [], melds: [], chou: [], tookCard: false, tookCount: 0, discards: [], tiCount: 0, paoCount: 0, longCount: 0, acted: false, declinedUnit: 0, declinedHu: [], freeDiscards: 0, noTake: false, passedChi: [], violations: 0, discardSrc: [], discardCids: [], ids: [] });
    this.scores = new Array(n).fill(0);
  }

  get n() { return this.rules.players; }

  /** 统一设置主 deadline，同时记住原本给了多久（延时卡按这个续） */
  /* 画面比服务端慢一拍：服务端一步算完就往下走，玩家那头还在放动画（切片播放）。
     `lag` = 还有多少毫秒的动画没放完 —— 定时限的时候把它加上，
     玩家**看到**这一步的时候，给他的那段时间才是完整的。
     以前不算这一笔：下家进了张又打出一张我能碰的牌，他那几帧还在放，
     我的碰窗口却从"服务端处理那一刻"就开始走了，等我看见牌，圈已经快走完了。 */
  lag = 0;
  /** 这一步刚定下的出牌时限（还没被 freshHold 挪过） */
  private deadlineFresh = false;
  private setDeadline(span: number) { this.deadlineSpan = span; this.deadline = this.now() + span + this.lag; this.deadlineFresh = true; }

  /** 这一步产生的动画排完了，服务端才知道要播多久 —— 这时候把**刚开的**窗口整体挪到
      "玩家真正看到的那一刻"。只挪刚开的，已经在走的一概不动：不是边走边找补，
      是把起点一次定准。（开窗口时按 `lag` 补的是**上一批**还没播完的那段，
      这一批自己的动画得等排完才算得出来。） */
  freshHold(ms: number) {
    const add = this.ended ? 0 : Math.max(0, Math.min(ms, 8000));
    if (add && this.deadlineFresh && this.deadline) this.deadline += add;
    this.deadlineFresh = false;
    for (const c of this.claims) {
      if (!c.fresh) continue;
      c.fresh = false;
      if (!add) continue;
      c.deadline += add;
      if (c.fastUntil) c.fastUntil += add;
      if (c.huUntil) c.huUntil += add;
      this.deadline = Math.max(this.deadline, c.deadline);
    }
  }
  next(seat: number) { return (seat + 1) % this.n; }

  // ---------- 开局 ----------
  /** 回放日志：开局那副牌 + 每一步真正生效的决定（含超时自动做的），照着走一遍就能复原整局 */
  deck: Kind[] = [];
  replay: { s: number; t: string; c?: Kind; g?: Kind[]; l?: number }[] = [];
  /** 记一步（只记真正生效的动作） */
  logStep(seat: number, type: string, payload?: { card?: Kind; combo?: Kind[]; lay?: number }) {
    const e: { s: number; t: string; c?: Kind; g?: Kind[]; l?: number } = { s: seat, t: type };
    if (payload?.card !== undefined && payload.card >= 0) e.c = payload.card;
    if (payload?.combo) e.g = payload.combo;
    if (payload?.lay) e.l = payload.lay;
    this.replay.push(e);
  }

  /** 发牌一轮抓几张：真人就是一人抓一小把、转着圈来，不是一人从牌堆上切一整段下来 */
  static DEAL_CHUNK = 3;

  start(deck?: Kind[]) {
    const cards = deck ?? shuffle(fullDeck(), this.rnd);
    this.deck = cards.slice();
    /* **轮流抓**，从庄家起，一人 DEAL_CHUNK 张转着圈发，发够为止。
       以前是一人从牌堆顶上切一整段（`cards.slice(idx, idx+cnt)`）—— 配上"接着洗"就出事了：
       接着洗是**故意**留残影的（上一局成组的牌还挨在一起），一人切一整段，
       那几摞残影就整块整块落进同一个人手里。实测起手龙从每手 0.07 条涨到 0.52 条，
       一手四条龙都出得来，牌根本没法打。轮流抓天然把挨着的牌分到三家去。 */
    const want = this.players.map((_, s) => this.rules.handSize + (s === this.dealer ? 1 : 0));
    const got: number[][] = this.players.map(() => []);   // 每家拿到的牌在这副牌里的位置（＝牌号）
    let idx = 0;
    if (this.rules.deal === 'big') {
      /* 大牌玩法：**一人切一整段** —— 庄先从牌堆顶上拿够 21 张，其余各拿 20。
         配上"接着洗"（上一局收拢的牌只搓几把），上一局成片的坎和句子就整块落进一家手里，
         坎多、龙多、大牌多。要的就是这个味道，所以只在开房时给这一档。 */
      for (let s = this.dealer, i = 0; i < this.n; i++, s = this.next(s)) {
        for (let k = 0; k < want[s] && idx < cards.length; k++) got[s].push(idx++);
      }
    } else {
      for (let s = this.dealer, guard = 0; got.some((g, i) => g.length < want[i]) && idx < cards.length && guard < 1000; s = this.next(s), guard++) {
        for (let k = 0; k < Game.DEAL_CHUNK && idx < cards.length && got[s].length < want[s]; k++) got[s].push(idx++);
      }
    }
    for (let s = 0; s < this.n; s++) {
      const ids = got[s];
      const mine = ids.map(i => cards[i]);
      // 庄家多的那一张：发牌时就亮给大家看（衡阳里别家能拿它胡＝地胡）
      if (s === this.dealer) { this.dealerCard = mine[mine.length - 1]; this.dealerCid = ids[ids.length - 1]; }
      this.players[s].hand = sortKinds(mine);
      // 牌号＝这张牌在这副牌里的位置：手牌排过序，号按"发到手里的原始顺序"装进袋子就行
      this.players[s].ids = ids.slice();
    }
    this.pile = cards.slice(idx);
    this.pileIds = Array.from({ length: this.pile.length }, (_, i) => idx + i);
    this.pileStart = this.pile.length;
    this.delayCards = this.players.map(() => this.rules.delay.atStart);
    this.emit({ t: 'deal', dealer: this.dealer });
    if (this.rules.delay.atStart > 0) this.emit({ t: 'delay_grant', counts: this.delayCards.slice() });
    // 庄家多出来的那一张（阳张）：先亮给所有人看，再摆起手龙 ——
    // 顺序反了的话画面上会先看到「下龙」再看到阳张，玩家以为服务端跑到前头去了
    if (this.dealerCard >= 0) this.emit({ t: 'dealer_card', seat: this.dealer, card: this.dealerCard, cid: this.dealerCid });
    // 起手龙：手中四张相同直接亮出（暗）。龙不出牌；手牌数校正见下
    for (let s = 0; s < this.n; s++) {
      const p = this.players[s];
      const c = toCounts(p.hand);
      for (let k = 0; k < 20; k++) if (c[k] === 4) {
        this.removeFromHand(p, k, 4);
        this.addMeld(s, { type: 'long', cards: [k, k, k, k], xi: tiXi(k), hidden: true, from: s }, s);
      }
      // 手牌数不变量：等待状态 手牌 ≡ (有龙 ? 1 : 2) (mod 3)；庄家未出牌前再 +1。
      // 起手多条龙：每多一条就少打一张牌 —— 不补牌，而是记一次"免出牌"，
      // 以后进张之后直接轮下家（跟重跑一样）。两条龙记 1 次，三条龙记 2 次，依此类推。
      const want = ((p.longCount ? 1 : 2) + (s === this.dealer ? 1 : 0)) % 3;
      p.freeDiscards = Math.max(0, p.longCount - 1);   // 两条龙 1 次，三条龙 2 次，依此类推
      // 只有一条龙（或没有龙）时才按不变量补牌；多条龙靠"免出牌"找齐，不补牌
      while (p.longCount <= 1 && p.hand.length % 3 !== want && this.pile.length) {
        p.hand = sortKinds([...p.hand, this.pile.shift()!]);
        p.ids.push(this.pileIds.shift()!);
        this.emit({ t: 'bupai', seat: s, pileLeft: this.pile.length });
      }
    }
    this.dealt = true;
    // 庄家：可天胡，否则出牌
    this.tianHuPossible = true;
    const d = this.players[this.dealer];
    const huXi = this.huXiOf(d, null);
    if (huXi !== null) { this.offerSelfHu(this.dealer, huXi); return; }
    // 衡阳：庄家亮出来的这一张，别家能胡就可以拿去胡（地胡）；耒阳不给胡
    if (this.rules.scoring === 'hengyang' && this.dealerCard >= 0 && this.offerDiHu()) return;
    this.enterDiscard(this.dealer);
  }

  /** 衡阳：庄家亮出来的那张牌先问一圈"有没有人地胡"。返回 true = 有人能胡，进入抢牌 */
  private offerDiHu(): boolean {
    const c = this.dealerCard;
    this.claims = [];
    const now = this.now();
    // 先立牌子：算分的时候就得知道"这一手是地胡"，按钮上的分才对得上结算
    this.diHuOffer = true;
    for (let s = 0; s < this.n; s++) {
      if (s === this.dealer) continue;
      const hu = this.huOption(this.players[s], c, this.dealer, false, true);
      if (hu) this.claims.push({ seat: s, options: [hu], deadline: now + this.lag + this.rules.timers.huForced, span: this.rules.timers.huForced, fastUntil: 0, fresh: true });
    }
    if (!this.claims.length) { this.diHuOffer = false; return false; }
    this.tableCard = { card: c, from: this.dealer, source: 'discard', at: now, cid: this.dealerCid };
    this.phase = 'claim';
    this.deadline = Math.max(...this.claims.map(x => x.deadline));
    for (const cl of this.claims) this.emit({ t: 'options', seat: cl.seat, options: cl.options, deadline: cl.deadline });
    return true;
  }

  /** 记一笔"弃胡"：耒阳里放弃过的分数，下一次要胡必须比它高（纪录表里的「贪」也是数这个） */
  private declineHu(seat: number, huOpt: ActionOption) {
    const p = this.players[seat];
    p.declinedUnit = Math.max(p.declinedUnit, huOpt.unit ?? 0);
    p.declinedHu.push({ card: (huOpt.card ?? this.tableCard?.card ?? -1) as Kind, unit: huOpt.unit ?? 0 });
  }

  /** 天胡 / 提龙胡：手牌已成胡，可选胡或出牌 */
  /** 返回 false = 这次不给胡（耒阳：刚才已经弃过同等分数的胡了），调用方照常往下走 */
  private offerSelfHu(seat: number, huXi: number, fromSeat = seat, dianPao = false): boolean {
    const unit0 = this.computeHu(seat, -1, fromSeat, fromSeat === seat, dianPao).detail.unit;
    // 耒阳可以弃胡：点了吃 / 碰 / 过就等于放弃了这次胡，进完张别再问一遍 ——
    // 除非这一手比刚才放弃的那次更值钱（跟抢牌阶段的规矩一致）
    if (!this.rules.mustHu && unit0 <= this.players[seat].declinedUnit) return false;
    this.selfHuFrom = fromSeat; this.selfHuDianPao = dianPao;
    this.timedOut.delete(seat);   // 这是"问他要不要胡"，跟刚才抢牌超时没关系
    this.phase = 'drawer_decide';
    this.turn = seat;
    this.drawn = null;
    const unit = unit0;
    this.drawerOptions = [{ type: 'hu', card: -1, xi: huXi, unit }];
    // 耒阳可以弃胡：给 15 秒（不是整轮 30 秒，别让人干等着以为卡住了）
    // 耒阳可以弃胡：除了"点一张牌打出去"，也给一个「过」—— 不胡，继续打牌
    if (!this.rules.mustHu) {
      this.drawerOptions.push({ type: 'pass', card: -1 }, { type: 'discard', card: -1 });
      this.setDeadline(this.rules.timers.claimPeng);
    }
    else this.setDeadline(this.rules.timers.huForced);   // 有胡必胡：到点自动胡，别再按 30 秒等
    this.emit({ t: 'options', seat, options: this.drawerOptions, deadline: this.deadline });
    return true;
  }

  // ---------- 工具 ----------
  private emit(e: GameEvent) { this.events.push(e); this.onEvent?.(e); }
  private removeFromHand(p: PlayerState, k: Kind, n: number) {
    for (let i = 0; i < n; i++) {
      const idx = p.hand.indexOf(k);
      if (idx < 0) throw new Error(`hand missing ${k}`);
      p.hand.splice(idx, 1);
      // 同一个字在手里的几张完全可以互换，取哪一号都对
      const j = p.ids.findIndex(id => this.deck[id] === k);
      this.takenIds.push(j >= 0 ? p.ids.splice(j, 1)[0] : this.newCid());
    }
  }
  /** 起手之后进过张（吃 / 碰 / 偎 / 提 / 跑）—— 耒阳的"举手胡"要求一张都没进过 */
  /** 记一笔"进张了"：发牌之后每下一次地（吃 / 碰 / 偎 / 提 / 跑）就是进了一张。
   *  起手龙是发牌发出来的，不算（`dealt` 还没置位）。 */
  private markTook(seat: number, _fromSeat: number) {
    if (!this.dealt) return;
    const p = this.players[seat];
    p.tookCard = true;
    p.tookCount = (p.tookCount ?? 0) + 1;
  }
  private addMeld(seat: number, m: Meld, fromSeat: number, noMask?: boolean) {
    const p = this.players[seat];
    // 这一组每张牌的号：刚从手里 / 旧牌组里拿出来的那几张，不够就补新号（理论上不该发生）
    const ids = this.takenIds.splice(0);
    while (ids.length < m.cards.length) ids.push(this.newCid());
    m.cids = ids.slice(0, m.cards.length);
    // 这一组里有没有「别家那张」：有就记下是哪一张，客户端好在牌头点个红点
    if (fromSeat !== seat && this.claimCid !== undefined && m.cids.includes(this.claimCid)) {
      m.fromCid = this.claimCid;
      if (this.claimDrawn) m.fromDrawn = true;
    }
    this.markTook(seat, fromSeat);
    p.melds.push(m);
    if (m.type === 'ti' || m.type === 'long') p.tiCount++;
    if (m.type === 'pao') p.paoCount++;
    if (m.type === 'ti' || m.type === 'pao' || m.type === 'long') p.longCount++;
    /* 起手龙是发牌发出来的（`dealt` 还没置位）：三家可以同时下地，不分先后。
       打上这个记号，服务端就把这一批并成一帧发、客户端也一起落地、只报一声「提龙」。 */
    this.emit({ t: 'meld', seat, meld: m, fromSeat, noMask, deal: this.dealt ? undefined : true });
    // 耒阳提龙：提（含起手龙）即时算分，大字 2 倍、小字 1 倍底分，跑不付分
    if (this.rules.scoring === 'leiyang' && (m.type === 'ti' || m.type === 'long')) {
      const per = (isBig(m.cards[0]) ? this.rules.leiyang.tiScoreBig : this.rules.leiyang.tiScoreSmall) * this.baseScore;
      if (per > 0) {
        const delta = new Array(this.n).fill(0);
        for (let s = 0; s < this.n; s++) if (s !== seat) { delta[s] -= per; delta[seat] += per; }
        for (let s = 0; s < this.n; s++) { this.scores[s] += delta[s]; this.tilongScores[s] += delta[s]; }
        this.emit({ t: 'tilong_score', seat, type: m.type as 'ti' | 'long', delta });
      }
    }
  }
  meldXi(p: PlayerState) { return p.melds.reduce((a, m) => a + m.xi, 0); }

  /** 违规罚分：违规者给其他每家 3 分（3 人局共罚 6 分） */
  static PENALTY_PER_PLAYER = 3;
  /** 抢牌超时宽限（ms）：踩着倒计时点下去的也认 */
  static CLAIM_GRACE = 800;

  private penalize(seat: number, reason: string) {
    const per = Game.PENALTY_PER_PLAYER * this.baseScore;
    const delta = new Array(this.n).fill(0);
    for (let s = 0; s < this.n; s++) if (s !== seat) { delta[s] += per; delta[seat] -= per; }
    for (let s = 0; s < this.n; s++) { this.scores[s] += delta[s]; this.penaltyScores[s] += delta[s]; }
    this.players[seat].violations++;
    this.emit({ t: 'penalty', seat, reason, delta });
  }

  /** 拆坎：手中三张同字打出一张 */
  private isBreakingKan(p: PlayerState, card: Kind) { return p.hand.filter(k => k === card).length >= 3; }
  /** 上一次因为"拆坎出牌"罚过谁的哪一张（同一手牌里只罚一次，见 actDiscard） */
  private kanWarned = '';

  /** 手牌(+card) 能否成胡；返回总息或 null */
  huXiOf(p: PlayerState, card: Kind | null): number | null {
    const hand = card === null ? p.hand : [...p.hand, card];
    if (hand.length % 3 === 1) return null;
    const r = partitionKeepKan(hand, p.hand);   // 手里原有的坎不许拆开配句子
    if (!r.complete) return null;
    let xi = r.xi + this.meldXi(p);
    // 胡的那张凑成的三张同字按"碰"算，不按"坎"（与 computeHu 保持一致）
    if (card !== null && card >= 0 && p.hand.filter(k => k === card).length < 3
      && r.groups.some(g => g.cards.length === 3 && g.cards.every(k => k === card))) xi -= kanXi(card) - pengXi(card);
    // 无胡（一点胡息都没有）：耒阳按 21 胡算。
    // 无胡意味着没跑没提没偎没碰没坎（那些都带息），手里也不会有作对的牌，全是零息的句子
    if (xi === 0 && this.rules.noXiHu > 0 && r.pairs.length === 0) xi = this.rules.noXiHu;
    return xi >= this.rules.huThreshold ? xi : null;
  }

  /** 若动作后手牌为空、又胡不了（息不够），则该动作不可选（否则无牌可出，局面会卡死） */
  private strands(p: PlayerState, removeFromHand: number, addXi: number): boolean {
    if (p.hand.length - removeFromHand !== 0) return false;
    return this.meldXi(p) + addXi < this.rules.huThreshold;
  }

  /** 吃牌组合。规则"下伙"：吃了某字后手中其余同字必须组成牌组一起下地，否则不能吃 */
  private chiCombos(p: PlayerState, card: Kind): { combo: Kind[]; lays: Kind[][][]; xi: number }[] {
    const out: { combo: Kind[]; lays: Kind[][][]; xi: number }[] = [];
    const seen = new Set<string>();
    // 坎（手里同一个字三张）永远不参与吃和下伙：先整个拿出去，剩下的牌才是能动的
    const free = this.freeHand(p);
    const uniq = [...new Set(free)];
    for (let i = 0; i < uniq.length; i++) for (let j = i; j < uniq.length; j++) {
      const a = uniq[i], b = uniq[j];
      if (a === b && free.filter(x => x === a).length < 2) continue;
      if (a === card && b === card) continue; // 三张同牌属于碰/偎
      const xi = chiXi(card, a, b);
      if (xi < 0) continue;
      const key = [a, b].sort().join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      const rest = free.slice();
      rest.splice(rest.indexOf(a), 1); rest.splice(rest.indexOf(b), 1);
      // 下伙：手里其余同字每一张都要跟别的牌凑成一句下地，所有可能的凑法都列出来（息高的排前面）
      const sols = layDownAll(rest, card).slice().sort((x, y) => y.xi - x.xi);
      if (!sols.length) continue;
      const best = sols[0];
      const removed = 2 + best.groups.length * 3;
      if (this.strands(p, removed, xi + best.xi)) continue;
      out.push({ combo: [a, b], lays: sols.map(x => x.groups), xi: xi + best.xi });
    }
    return out;
  }

  /** 手里能动的牌：把坎（同一个字三张）整组拿出去之后剩下的 */
  private freeHand(p: PlayerState): Kind[] {
    const counts = toCounts(p.hand);
    return p.hand.filter(k => counts[k] < 3);
  }

  private chiOption(p: PlayerState, card: Kind): ActionOption | null {
    const cs = this.chiCombos(p, card);
    if (!cs.length) return null;   // 吃不了就什么按钮都不给（要不起，自动过）
    return { type: 'chi', card, combos: cs.map(c => c.combo), comboLays: cs.map(c => c.lays), xi: 0 };
  }

  /** 执行吃：主组合 + 下伙牌组一起下地 */
  private execChi(seat: number, c: Kind, combo: Kind[], extras: Kind[][], fromSeat: number, noMask = false) {
    const p = this.players[seat];
    this.removeFromHand(p, combo[0], 1); this.removeFromHand(p, combo[1], 1);
    this.addMeld(seat, { type: 'chi', cards: [c, combo[0], combo[1]], xi: chiXi(c, combo[0], combo[1]), hidden: false, from: fromSeat }, fromSeat, noMask);
    for (const g of extras) {
      for (const k of g) this.removeFromHand(p, k, 1);
      const triple = g[0] === g[1] && g[1] === g[2];
      this.addMeld(seat, { type: triple ? 'wei' : 'chi', cards: g.slice(), xi: triple ? kanXi(g[0]) : chiXi(g[0], g[1], g[2]), hidden: false, from: seat, part: true }, seat);
    }
    p.acted = true;
    this.enterDiscard(seat, true);
  }

  /** 胡的选项（含每家应付分）；衡阳有胡必胡；耒阳可放弃但下次必须比放弃的分高 */
  private huOption(p: PlayerState, card: Kind | null, fromSeat: number, ziMo: boolean, dianPao: boolean): ActionOption | null {
    const huXi = this.huXiOf(p, card);
    if (huXi === null) return null;
    const r = this.computeHu(p.seat, card ?? -1, fromSeat, ziMo, dianPao);
    if (!this.rules.mustHu && r.detail.unit <= p.declinedUnit) return null;
    return { type: 'hu', card: card ?? -1, xi: huXi, unit: r.detail.unit };
  }

  /** 其他玩家对桌面牌的可选动作 */
  private claimOptions(seat: number, tc: TableCard): ActionOption[] {
    const p = this.players[seat];
    const c = tc.card;
    const opts: ActionOption[] = [];
    const inHand = p.hand.filter(x => x === c).length;
    const hu = this.huOption(p, c, tc.from, false, tc.source === 'discard');
    if (hu) opts.push(hu);   // 衡阳有胡必胡：其它动作在 actClaim 里被拒绝
    const meld = p.melds.find(m => (m.type === 'peng' || m.type === 'wei') && m.cards[0] === c);
    // 碰过的牌：只有从牌堆摸出来的第四张才能开跑，别人从手里打出的不算
    const canPao = meld ? (meld.type === 'wei' || tc.source === 'draw') : (inHand === 3 && !this.strands(p, 3, paoXi(c)));
    if (canPao) opts.push({ type: 'pao', card: c, xi: paoXi(c) });
    // 放过跑的人（自己打出的牌被别家开跑）本局不能再主动进张：碰 / 吃 都不给了
    else if (!p.noTake && inHand === 2 && !this.strands(p, 2, pengXi(c))) opts.push({ type: 'peng', card: c, xi: pengXi(c) });   // 臭牌也照样给按钮，点了算违规
    if (!p.noTake && seat === this.next(tc.from)) { const chi = this.chiOption(p, c); if (chi) opts.push(chi); }
    return opts;
  }

  /**
   * 先下地（提 / 偎 / 跑）再胡，能胡多少分？算不出来（下完地不成牌）返回 null。
   * 只算不改状态：临时把牌摆成"下完地"的样子算一遍，算完原样放回去。
   */
  /* ziMo / dianPao / fromSeat：这一胡是自摸还是别人给的。
     默认按自摸算（摸牌那一路就是自摸），抢牌那一路必须把真实情况传进来 ——
     不然自摸那 ×2 会凭空加上去，比出来的"跑胡更值钱"是假的。 */
  private meldThenHuUnit(seat: number, type: 'ti' | 'wei' | 'pao' | 'peng', c: Kind,
                         ziMo = true, dianPao = false, fromSeat = seat): number | null {
    const p = this.players[seat];
    const hand0 = p.hand.slice(), melds0 = p.melds.slice();
    const bk = this.bigMeldKind, bt = this.bigMeldType;
    const take = (n: number) => { for (let i = 0; i < n; i++) { const k = p.hand.indexOf(c); if (k < 0) return false; p.hand.splice(k, 1); } return true; };
    try {
      if (type === 'wei' || type === 'peng') {
        if (!take(2)) return null;
        p.melds = [...p.melds, type === 'wei'
          ? { type: 'wei', cards: [c, c, c], xi: weiXi(c), hidden: true, from: seat }
          : { type: 'peng', cards: [c, c, c], xi: pengXi(c), hidden: false, from: seat }];
      } else {
        const i = p.melds.findIndex(m => (type === 'ti' ? m.type === 'wei' : m.type === 'peng' || m.type === 'wei') && m.cards[0] === c);
        if (i >= 0) p.melds = p.melds.filter((_, k) => k !== i);
        else if (!take(3)) return null;
        const mt = type === 'ti' ? (i >= 0 ? 'ti' : 'long') : 'pao';
        p.melds = [...p.melds, { type: mt as Meld['type'], cards: [c, c, c, c], xi: type === 'ti' ? tiXi(c) : paoXi(c), hidden: type === 'ti', from: seat }];
      }
      if (this.huXiOf(p, null) === null) return null;
      // 碰不是"大牌组"（不加坎的那 4 敦），所以 bigMeldType 不立；提 / 偎 / 跑 要立
      this.bigMeldKind = type === 'peng' ? -1 : c;
      this.bigMeldType = type === 'peng' ? '' : type === 'wei' ? 'wei' : type === 'ti' ? 'ti' : 'pao';
      return this.computeHu(seat, -1, fromSeat, ziMo, dianPao).detail.unit;
    } finally {
      p.hand = hand0; p.melds = melds0; this.bigMeldKind = bk; this.bigMeldType = bt;
    }
  }

  /** 摸牌者的可选动作 */
  private drawerOpts(seat: number, c: Kind): ActionOption[] {
    const p = this.players[seat];
    const opts: ActionOption[] = [];
    const inHand = p.hand.filter(x => x === c).length;
    // 摸到的牌按这个队列一路往下判，前面的先执行：提（龙）> 偎 > 胡 > 跑 > 吃 > 打出。
    // 提和偎排在胡前面：自己摸到的第三张同字必须先偎，偎完再看胡不胡（偎还会加息），
    // 不能拿这张牌直接去配「壹贰叁 / 叁叁三」凑胡 —— 那种胡只能胡别人摸出来或打出来的牌。
    const wei = p.melds.find(m => m.type === 'wei' && m.cards[0] === c);
    const peng = p.melds.find(m => m.type === 'peng' && m.cards[0] === c);
    if (wei || (inHand === 3 && !this.strands(p, 3, tiXi(c)))) opts.push({ type: 'ti', card: c, xi: tiXi(c) });
    if (!opts.length && inHand === 2 && !this.strands(p, 2, weiXi(c))) opts.push({ type: 'wei', card: c, xi: weiXi(c) });
    // 耒阳：跑也排在胡前面（先跑，跑完再判胡，让玩家有机会贪更大的胡）；衡阳有胡必胡，胡在跑前面
    const paoFirst = !this.rules.mustHu;
    if (paoFirst && peng && !opts.length) opts.push({ type: 'pao', card: c, xi: paoXi(c) });
    // 提 / 偎（耒阳还有跑）轮不到时才轮到胡；
    // 轮得到的时候也要比一比：直接胡和"先下地再胡"哪个分高，高的那个才留着（见 enterDraw）
    const hu = this.huOption(p, c, seat, true, false);
    if (hu) {
      const forced = opts.find(o => o.type === 'ti' || o.type === 'wei' || o.type === 'pao');
      if (!forced) opts.push(hu);
      else {
        const after = this.meldThenHuUnit(seat, forced.type as 'ti' | 'wei' | 'pao', c);
        // 下完地也能胡：两条路比分数，高的那条留下（一样高就按老规矩先下地）。
        // 下完地胡不了：还是照老规矩先下地 —— 摸到的第三张同字必须偎 / 提，不能拿去配句子直接胡。
        if (after !== null && after < (hu.unit ?? 0)) { opts.length = 0; opts.push(hu); }
      }
    }
    if (peng && !opts.some(o => o.type === 'ti' || o.type === 'wei' || o.type === 'pao')) opts.push({ type: 'pao', card: c, xi: paoXi(c) });
    // 放过跑的人本局不能再主动进张（吃也算）
    const chi = p.noTake ? null : this.chiOption(p, c); if (chi) opts.push(chi);
    opts.push({ type: 'play_drawn', card: c });
    return opts;
  }

  // ---------- 阶段推进 ----------
  /** fromMeld：这次是"进张（碰/吃/偎/提/跑）之后"要出牌 —— 有免出牌次数时可以直接跳过 */
  private enterDiscard(seat: number, fromMeld = false) {
    const p = this.players[seat];
    if (p.hand.length === 0) {
      this.bigMeldKind = -1; this.bigMeldType = '';
      const huXi = this.huXiOf(p, null);
      if (huXi !== null) { const m = p.melds[p.melds.length - 1]; this.doHu(seat, -1, m.from, m.from === seat, m.from !== seat); return; }
      this.endLiuJu(); return;   // 兜底：手上一张牌都没有又胡不了，没法再出牌 → 按黄庄收场，别把局面卡死
    }
    // 进了牌（碰 / 吃 / 偎 / 提 / 跑）之后手里正好成牌：先问要不要胡，别直接催他出牌
    {
      const huXi = this.huXiOf(p, null);
      if (huXi !== null) {
        const m = p.melds[p.melds.length - 1];
        if (this.offerSelfHu(seat, huXi, m?.from ?? seat, !!m && m.from !== seat)) return;
      }
    }
    this.bigMeldKind = -1; this.bigMeldType = '';
    // 起手多条龙攒下的"免出牌"：进张之后这一次不用打牌，直接轮到下家（跟重跑一样）
    if (fromMeld && p.freeDiscards > 0) { p.freeDiscards--; p.acted = true; this.enterDraw(this.next(seat)); return; }
    this.phase = 'discard';
    this.turn = seat;
    this.tableCard = null;
    this.claims = [];   // 牌一离桌，这一轮的表态记录就作废
    this.drawn = null;
    this.setDeadline(this.rules.timers.discard);
    this.emit({ t: 'need_discard', seat, deadline: this.deadline });
  }

  private enterDraw(seat: number) {
    this.tianHuPossible = false;
    if (this.pile.length === 0) { this.endLiuJu(); return; }
    const c = this.pile.shift()!;
    this.turn = seat;
    this.drawn = c;
    this.drawnCid = this.pileIds.shift() ?? this.newCid();
    this.emit({ t: 'draw', seat, card: c, pileLeft: this.pile.length, cid: this.drawnCid });
    this.grantMidDelay();
    this.drawerOptions = this.drawerOpts(seat, c);
    this.phase = 'drawer_decide';
    this.setDeadline(this.rules.timers.drawerDecide);
    // 有提必提、有偎必偎：提 / 偎 是优先级最高的动作，没有"胡"可选时直接代为执行
    // 能胡时把"胡"留给玩家点（衡阳有胡必胡：点别的会被拒，超时才自动胡）
    // 有提必提、有偎必偎（耒阳还有必跑）：它们在队列里排在胡前面，直接代为执行；执行完再判胡
    const forced = this.drawerOptions.find(o => o.type === 'ti' || o.type === 'wei'
      || (!this.rules.mustHu && o.type === 'pao' && this.drawerOptions[0]?.type === 'pao'));
    if (forced) { this.actDrawer(seat, forced.type); return; }
    const hasHu = this.drawerOptions.some(o => o.type === 'hu');
    if (hasHu && this.rules.mustHu) this.setDeadline(this.rules.timers.huForced);
    // 其余情况（摸牌者只能吃 / 打出，或还可以胡）：把这张牌摆出来给所有人按优先级抢
    this.offerCard({ card: c, from: seat, source: 'draw', cid: this.drawnCid }, true);
  }

  /** 桌面出现一张公开牌（打出的摸牌或手牌），进入仲裁 */
  private offerCard(tc: TableCard, includeFrom = false) {
    this.timedOut.clear();
    tc.at = this.now();
    this.tableCard = tc;
    this.claims = [];
    const now = this.now();
    for (let s = 0; s < this.n; s++) {
      if (s === tc.from && !includeFrom) continue;
      // 摸牌者用摸牌选项（自己的吃不限于上家），其他人用应牌选项
      const options = s === tc.from
        ? this.drawerOptions.filter(o => o.type !== 'play_drawn' && o.type !== 'discard')
        : this.claimOptions(s, tc);
      if (!options.length) continue;
      // 有跑必跑：不能胡时自动替玩家跑（能胡则交给玩家选"撇跑胡"）
      // 有跑必跑：不能胡时自动替玩家跑（能胡则把"胡"按钮亮出来，由玩家自己点）
      const autoPao = !options.some(o => o.type === 'hu') && options.some(o => o.type === 'pao');
      this.claims.push({ seat: s, options, deadline: 0, fresh: true, decision: autoPao ? { type: 'pao' } : undefined });
    }
    /* 每次摸牌都给下家一个表态窗口。要得起的话上面已经给他排进 claims 了（真按钮）；
       要不起就在这儿补一条**影子表态**：没有按钮、不发 options，服务端照样等它那几秒。
       以前是"没人要得起 → 当场就死"，只靠客户端捂一下遮掩；现在是实打实的等待，
       快慢完全一样，别人从节奏上推不出这张牌有没有人要。 */
    if (tc.source === 'draw' && !this.replayMode) {   // 回放没有时钟，等不出这 3 秒，也不需要遮掩
      const nx = this.next(tc.from);
      if (nx !== tc.from && !this.claims.some(c => c.seat === nx))
        this.claims.push({ seat: nx, options: [], deadline: 0, fresh: true, ghost: true });
    }
    if (!this.claims.length) { this.cardDead(tc, true); return; }   // 压根没人要得起 → 这张得捂一下再揭晓
    // 快碰慢吃：碰 / 跑 / 胡 15 秒，吃 30 秒，各算各的、同时计时，不再砍半。
    // 优先级低的一方即便先点了也要等前面的人表态，但他的 30 秒够等前面的 15 秒。
    for (const c of this.claims) {
      // 影子表态：只占那 3 秒，没有快窗口、也没有胡窗口
      if (c.ghost) {
        c.span = this.rules.timers.ghostPass;
        c.deadline = now + this.lag + c.span;
        c.fastUntil = 0; c.fastSpan = 0; c.huUntil = 0; c.huSpan = 0;
        continue;
      }
      // 衡阳有胡必胡：胡牌按钮只给 5 秒，到点自动胡；耒阳能弃胡，照常给足时间
      const forcedHu = this.rules.mustHu && c.options.some(o => o.type === 'hu');
      const hasFast = c.options.some(o => o.type !== 'chi');
      const hasChi = c.options.some(o => o.type === 'chi');
      // 快碰慢吃：碰 / 跑 / 胡 只给读秒的一半，到点这几个按钮就收掉；吃能等满一轮读秒。
      // 两种都有的时候，整条 claim 等到吃的时限，中途先把快按钮收走。
      /* 碰 / 跑 一律是"读秒的一半"，不跟着胡的那 5 秒走 ——
         以前这两件事共用一个窗口：衡阳有胡必胡时，同一条 claim 里的碰也被砍成 5 秒，
         看着就是"碰的圈莫名其妙短了一截"。现在胡单独一个 huUntil。 */
      const lag = this.lag;   // 动画还没放完的那一段：窗口从"玩家看到"起算
      c.fastUntil = hasFast ? now + lag + this.rules.timers.claimPeng : 0;
      c.fastSpan = hasFast ? this.rules.timers.claimPeng : 0;
      c.huUntil = forcedHu ? now + lag + this.rules.timers.huForced : 0;
      c.huSpan = forcedHu ? this.rules.timers.huForced : 0;
      // 整条 claim 一律按满一轮读秒计时 —— 公共牌那圈倒计时就不会因为"有人能碰"而突然减半，
      // 别家看不出谁手里有牌。碰 / 跑 / 胡 自己在 fastUntil 那一刻收掉就行。
      c.span = this.rules.timers.claimChi;
      c.deadline = now + lag + c.span;
      void hasChi;
    }
    this.phase = 'claim';
    /* 公开的那圈倒计时（桌面中间那个）一律按**满一轮读秒**画，不管这一手实际在等谁 ——
       影子表态只有 3 秒，要是让它把公开的圈压成 3 秒，等于当场宣布"这张没人要得起"。
       圈照常转、牌提前落地，看上去就跟"有人很快点了过"一模一样。 */
    this.deadline = Math.max(now + this.lag + this.rules.timers.claimChi, ...this.claims.map(c => c.deadline));
    for (const c of this.claims) if (c.decision === undefined && !c.ghost) this.emit({ t: 'options', seat: c.seat, options: c.options, deadline: c.deadline });
    if (this.claims.some(c => c.decision)) this.resolveClaims();
  }

  /** auto = 压根没人要得起（要捂）；false = 有人点了过 / 超时才死的（大家已经等过了，立刻揭晓） */
  private cardDead(tc: TableCard, auto: boolean) {
    this.claims = [];          // 这张牌的仲裁到此为止，别把表态记录留到下一轮
    if (tc.source === 'draw' && this.drawn !== null) { this.emit({ t: 'play_drawn', seat: tc.from, card: tc.card, auto, cid: tc.cid }); this.drawn = null; }
    // 先发事件再入堆：这一帧的快照里那张牌还没进出牌堆，不然"牌堆里已经多了一张"
    // 等于提前告诉所有人"没人要得起"
    this.emit({ t: 'dead', card: tc.card, auto, cid: tc.cid });
    this.deadPool.push(tc.card);
    this.players[tc.from].discards.push(tc.card);
    this.players[tc.from].discardCids.push(tc.cid ?? this.newCid());
    this.players[tc.from].discardSrc.push(tc.source === 'draw' ? 'draw' : 'hand');
    // 自己打出去的牌之后又吃进来，也算吃回头牌（胡这张牌不受影响）
    if (!this.players[tc.from].passedChi.includes(tc.card)) this.players[tc.from].passedChi.push(tc.card);
    this.tableCard = null;
    this.claims = [];   // 牌一离桌，这一轮的表态记录就作废
    this.enterDraw(this.next(tc.from));
  }

  // ---------- 玩家动作 ----------
  /** 返回 null 表示成功，否则错误信息 */
  act(seat: number, type: ActionType, payload?: { card?: Kind; combo?: Kind[]; lay?: number }): string | null {
    if (this.ended) return 'ended';
    // 抢牌超时之后又点：给一句明白话，而不是干巴巴的 invalid action。
    // 只管抢牌阶段！提龙胡 / 开跑胡 / 偎起胡 / 天胡是自己下地之后引擎主动问的，
    // 跟刚才那张桌上的牌没关系 —— 以前这里没判阶段，12 秒内超时过一次的人
    // （机器人也算）开跑之后就再也胡不了：引擎每 200ms 重试一次、每次都被这句挡回去，整桌就卡死了
    const to = this.phase === 'claim' ? this.timedOut.get(seat) : undefined;
    if (to && ['peng', 'chi', 'pao', 'hu', 'wei', 'ti'].includes(type) && this.now() - to.at < 12000) {
      const c = this.claims.find(x => x.seat === seat);
      if (!c || c.decision !== undefined) {
        const secs = Math.round((type === 'chi' ? this.rules.timers.claimChi : this.rules.timers.claimPeng) / 1000);
        return `慢了一步：快碰慢吃，${ACTION_CN[type] ?? type}要在 ${secs} 秒内表态`;
      }
    }
    const n0 = this.events.length;
    const err = (() => {
      switch (this.phase) {
        case 'drawer_decide': return this.actDrawer(seat, type, payload);
        case 'discard': return this.actDiscard(seat, type, payload);
        case 'claim': return this.actClaim(seat, type, payload);
        default: return 'bad phase';
      }
    })();
    // 真正生效了（哪怕是"违规但照样罚分推进"）才记进回放日志
    if (!err || this.events.length > n0) this.logStep(seat, type, payload);
    return err;
  }

  private actDiscard(seat: number, type: ActionType, payload?: { card?: Kind }) {
    if (seat !== this.turn) return 'not your turn';
    if (type !== 'discard' || payload?.card === undefined) return 'must discard';
    const p = this.players[seat];
    if (!p.hand.includes(payload.card)) return 'card not in hand';
    // 拆坎出牌：罚分，并且这张牌收回来（还得另打一张）；只罚分，不禁胡。
    // 除非手里全是坎，实在挑不出别的牌，那就只能打出去（照样罚分）
    if (this.isBreakingKan(p, payload.card)) {
      const hasOther = p.hand.some(k => p.hand.filter(x => x === k).length < 3);
      /* 罚分只罚**一次**：同一手牌里同一张坎，反复点（或者机器人反复重试）不该越罚越多。
         以前每试一次就罚一次 —— 机器人两百毫秒重试一回，几十秒下来能罚出上百次违规。
         手里全是坎、实在挑不出别的牌时照样让他打出去（罚一次，牌真的出去）。 */
      const key = `${seat}:${payload.card}:${p.discards.length}:${p.melds.length}`;
      if (this.kanWarned !== key) { this.kanWarned = key; this.penalize(seat, '拆坎出牌'); }
      if (hasOther) return `${nameOfKind(payload.card)} 是坎，拆坎出牌：罚分，这张牌收回来了，请另打一张`;
    }
    this.takenIds = [];
    this.claimCid = undefined;
    this.removeFromHand(p, payload.card, 1);
    p.acted = true;
    // 自己从手里打出去的字，之后再吃回来也算吃回头牌（不管这张牌当时被谁要走了）
    if (!p.passedChi.includes(payload.card)) p.passedChi.push(payload.card);
    const cid = this.takenIds.pop() ?? this.newCid();   // 刚从手里抽出来的就是它
    this.emit({ t: 'discard', seat, card: payload.card, cid });
    this.offerCard({ card: payload.card, from: seat, source: 'discard', cid });
    return null;
  }

  private actDrawer(seat: number, type: ActionType, payload?: { card?: Kind; combo?: Kind[]; lay?: number }): string | null {
    if (seat !== this.turn) return 'not your turn';
    // 同理：抢牌阶段的「过」点下去时又回到了摸牌阶段，等于把摸到的牌打出去
    if (type === 'pass' && this.drawerOptions.some(o => o.type === 'play_drawn')) type = 'play_drawn';
    // 提龙胡 / 开跑胡 / 偎起胡问你要不要胡时点「过」＝弃胡，继续打牌
    if (type === 'pass' && this.drawn === null && this.drawerOptions.some(o => o.type === 'hu' && o.card === -1)) {
      const hu0 = this.drawerOptions.find(o => o.type === 'hu');
      const pp = this.players[seat];
      pp.declinedUnit = Math.max(pp.declinedUnit, hu0?.unit ?? 0);
      pp.declinedHu.push({ card: (this.bigMeldKind >= 0 ? this.bigMeldKind : -1) as Kind, unit: hu0?.unit ?? 0 });
      this.enterDiscard(seat);
      return null;
    }
    const opt = this.drawerOptions.find(o => o.type === type);
    if (!opt) return 'invalid action';
    const p = this.players[seat];
    const c = this.drawn;
    const huOpt = this.drawerOptions.find(o => o.type === 'hu');
    if (huOpt && type !== 'hu') {
      p.declinedUnit = Math.max(p.declinedUnit, huOpt.unit ?? 0);
      p.declinedHu.push({ card: (huOpt.card ?? c) as Kind, unit: huOpt.unit ?? 0 });
    }
    // 有提必提、有偎必偎：玩家点"过"时直接替他做，不算违规
    if (type === 'play_drawn') {
      const forced = this.drawerOptions.find(o => o.type === 'ti' || o.type === 'wei');
      if (forced) return this.actDrawer(seat, forced.type);
    }
    // 这一轮要凑组的牌号从这里开始攒：摸上来的那张先记上（它也要进组）
    this.takenIds = [];
    this.claimCid = undefined;
    if (this.drawn !== null && (type === 'ti' || type === 'pao' || type === 'wei')) this.takenIds.push(this.drawnCid);
    switch (type) {
      case 'hu': {
        if (c === null) { this.doHu(seat, -1, this.selfHuFrom, this.selfHuFrom === seat, this.selfHuDianPao); return null; } // 天胡 / 提龙胡 / 跑后胡
        this.doHu(seat, c, seat, true, false); return null;
      }
      case 'discard': { // 仅天胡放弃时（庄家 21 张出牌）
        if (payload?.card === undefined) return 'need card';
        if (!p.hand.includes(payload.card)) return 'card not in hand';
        this.phase = 'discard';
        return this.actDiscard(seat, 'discard', payload);
      }
      case 'ti': {
        const before = p.longCount;
        const wei = p.melds.findIndex(m => m.type === 'wei' && m.cards[0] === c);
        if (wei >= 0) { this.takenIds.push(...(p.melds[wei].cids ?? [])); p.melds.splice(wei, 1); } else this.removeFromHand(p, c!, 3);
        // 手中三张摸到第四张 = 龙，必须亮出；偎后摸到第四张 = 提（暗）
        this.addMeld(seat, { type: wei >= 0 ? 'ti' : 'long', cards: [c!, c!, c!, c!], xi: tiXi(c!), hidden: true, from: seat, again: wei >= 0 }, seat);
        this.afterBigMeld(seat, before, seat, false); return null;
      }
      case 'pao': {
        const before = p.longCount;
        const i = p.melds.findIndex(m => m.type === 'peng' && m.cards[0] === c);
        this.takenIds.push(...(p.melds[i]?.cids ?? []));
        p.melds.splice(i, 1);
        this.addMeld(seat, { type: 'pao', cards: [c!, c!, c!, c!], xi: paoXi(c!), hidden: false, from: seat, again: true }, seat);
        this.afterBigMeld(seat, before, seat, false); return null;
      }
      case 'wei': {
        this.removeFromHand(p, c!, 2);
        this.addMeld(seat, { type: 'wei', cards: [c!, c!, c!], xi: weiXi(c!), hidden: true, from: seat }, seat);
        p.acted = true;
        this.afterWei(seat, c!, seat, false); return null;
      }
      case 'chi': {
        let idx = Game.findCombo(opt.combos, payload?.combo);
        // 选的吃法对不上（多半是牌换了、按钮上的选项已经刷新过）：只有一种吃法就照它来，
        // 有好几种就让玩家重选，别扔一句看不懂的 bad combo
        if (idx < 0) { if ((opt.combos?.length ?? 0) !== 1) return '吃法已经变了，请重新选一次'; idx = 0; }
        const lays = opt.comboLays?.[idx] ?? [];
        const lay = Math.max(0, Math.min(payload?.lay ?? 0, lays.length - 1));
        this.execChi(seat, c!, opt.combos![idx], lays[lay] ?? [], seat, this.tableCard ? this.chiNoMask(this.tableCard, seat) : true); return null;
      }
      case 'play_drawn': {
        this.emit({ t: 'play_drawn', seat, card: c!, cid: this.drawnCid });
        this.drawn = null;
        this.offerCard({ card: c!, from: seat, source: 'draw', cid: this.drawnCid });
        return null;
      }
    }
    return 'invalid action';
  }

  /**
   * 提/跑 之后：第一次（此前没有提/跑/龙）需要出一张牌，出牌前若手牌已成胡可"提龙胡"；
   * 重提/重跑 免出牌、不能胡，轮到下家摸牌。手牌数不变量：有龙 ≡1，无龙 ≡2 (mod 3)。
   */
  private afterBigMeld(seat: number, longBefore: number, fromSeat: number, dianPao: boolean) {
    this.drawn = null;
    this.tableCard = null;
    this.claims = [];   // 牌一离桌，这一轮的表态记录就作废
    const p = this.players[seat];
    if (longBefore === 0) {
      // 第一次提 / 跑：先判定是否已成胡（提龙胡 / 开跑胡），否则出一张牌；重提 / 重跑不判胡、不出牌
      const last = p.melds[p.melds.length - 1];
      this.bigMeldKind = last?.cards[0] ?? -1;
      this.bigMeldType = last?.type ?? '';
      const huXi = this.huXiOf(p, null);
      if (huXi !== null && this.offerSelfHu(seat, huXi, fromSeat, dianPao)) return;
      this.enterDiscard(seat, true);
    } else {
      this.enterDraw(this.next(seat));
    }
  }

  /** 偎之后：手牌若已成胡可以胡（衡阳自动胡；耒阳弹窗让玩家选，不胡就照常出牌） */
  private afterWei(seat: number, kind: Kind, fromSeat: number, dianPao: boolean) {
    const p = this.players[seat];
    const huXi = this.huXiOf(p, null);
    if (huXi !== null) { this.bigMeldKind = kind; this.bigMeldType = 'wei'; if (this.offerSelfHu(seat, huXi, fromSeat, dianPao)) return; this.bigMeldKind = -1; this.bigMeldType = ''; }
    this.enterDiscard(seat, true);
  }

  /** 抢牌等待：有人表态之后，留给其他人的最后一点时间 = 读秒的 1/6（至少 1.2 秒）。
      原来是 1/10（30 秒读秒 → 3 秒），实战里太紧：下家手快点了吃，碰得起的人
      从看见牌到按下去就只剩这一下。放宽到 1/6（→ 5 秒）。
      （下限 1.2 秒是给调快了读秒的桌子留的，别比整轮读秒还长。） */
  claimGraceMs() { return Math.max(1200, Math.round(this.rules.timers.discard / 6)); }

  /** 有人已经决定要这张牌：把还没表态的人的时限压到"读秒 1/10"以内 */
  private hurryOthers() {
    const cut = this.now() + this.claimGraceMs();
    let changed = false;
    for (const c of this.claims) {
      if (c.decision !== undefined || c.deadline <= cut) continue;
      // 这两种人不催：
      //  1) 自己摸上来的那张牌 —— 摸牌人对这张牌优先权最高，不能因为下家手快就被顶掉
      //  2) 手上能胡的人 —— 胡不能被别人点得快就抢没了（耒阳还能选弃胡，更不该替他决定）
      if (this.tableCard && c.seat === this.tableCard.from) continue;
      if (c.options.some(o => o.type === 'hu')) continue;
      c.deadline = cut; changed = true;
      /* 碰 / 跑 的那个窗口也得跟着收短 —— 以前只压 deadline，不动 fastUntil：
         别人一表态，这家的 claim 两秒后就超时作废了，可他屏幕上那圈"碰"还在慢悠悠地转，
         点下去却是「已经表过态」（静音错误），看着就是"按钮还在，却不给碰"。 */
      /* 收短的时候把"这半程有多长"（span）也改成**剩下的这一段** ——
         客户端那圈是按 (还剩多少 / 这半程多长) 画的，只改到点时刻不改 span，
         圈就会"嗖"地从七八分满跳到快见底；改了之后圈从满格重新走一遍这几秒，
         看着是"时间被压短了"，而不是"圈突然跳了一下"。 */
      const left = Math.max(1, cut - this.now());
      if (c.fastUntil && c.fastUntil > cut) { c.fastUntil = cut; c.fastSpan = left; }
      if (c.huUntil && c.huUntil > cut) { c.huUntil = cut; c.huSpan = left; }
    }
    if (changed && this.claims.length) this.deadline = Math.max(...this.claims.map(c => c.deadline));
  }

  private actClaim(seat: number, type: ActionType, payload?: { combo?: Kind[]; lay?: number }) {
    // 画面比服务端慢半拍：摸牌阶段的「过（打出）」点下去时可能已经进了抢牌阶段，按"过"处理
    if (type === 'play_drawn') type = 'pass';
    const cl = this.claims.find(c => c.seat === seat);
    if (!cl) return 'no claim for you';
    if (cl.decision !== undefined) return 'already decided';
    // 快碰慢吃：碰 / 跑 / 胡 的窗口过了就只能吃（或过）。
    // 环走完到真正作废之间留 CLAIM_GRACE 的宽限 —— 画面比服务端慢半拍，
    // 踩着最后一下按的也得认，不然玩家看着环还没走完却被判"慢了一步"
    if (cl.fastDone && type !== 'chi' && type !== 'pass') {
      const secs = Math.round(this.rules.timers.claimPeng / 1000);
      return `慢了一步：快碰慢吃，${ACTION_CN[type] ?? type}要在 ${secs} 秒内表态`;
    }
    const huOpt = this.huRobbed(seat) ? undefined : cl.options.find(o => o.type === 'hu');
    if (huOpt && type !== 'hu') {
      if (this.rules.mustHu) return '有胡必胡';
      // 同一条 claim 只记一次弃胡：快窗口先过了、后面又点了别的，不能算两次「贪」
      if (!cl.huDeclined) { this.declineHu(seat, huOpt); cl.huDeclined = true; }
    }
    /* 回头牌：放弃过的字之后又来要 —— 罚分，而且这一手**根本没成立**（当他过了，牌不给他）。
       跟以前一个做法，只是**不再往上弹"这张牌退回去了"** ——
       本来就没吃进 / 碰进，说"退回去"反倒像是先给了他又收走。
       桌面上只留罚分那一句：「XX 碰回头牌，罚 6 分」。 */
    const back = this.tableCard
      && ((type === 'peng' && this.rules.chouPai && this.players[seat].chou.includes(this.tableCard.card))
        || (type === 'chi' && this.players[seat].passedChi.includes(this.tableCard.card)));
    if (back) {
      this.penalize(seat, type === 'peng' ? '碰回头牌' : '吃回头牌');
      cl.decision = null;
      this.emit({ t: 'pass', seat, card: this.tableCard!.card });
      this.resolveClaims();
      return null;   // 不报错：罚分那一句已经说清楚了
    }
    // 有跑必跑：点"过"时直接替他跑，不算违规
    if (type === 'pass' && cl.options.some(o => o.type === 'pao')) type = 'pao';
    if (type === 'pass') { cl.decision = null; }
    else {
      const opt = cl.options.find(o => o.type === type);
      if (!opt) return 'invalid action';
      if (type === 'chi') {
        let ci = Game.findCombo(opt.combos, payload?.combo);
        if (ci < 0) { if ((opt.combos?.length ?? 0) !== 1) return '吃法已经变了，请重新选一次'; ci = 0; }
        const lays = opt.comboLays?.[ci] ?? [];
        const lay = Math.max(0, Math.min(payload?.lay ?? 0, lays.length - 1));   // 越界就按第一种下伙，别报错
        cl.decision = { type, combo: opt.combos![ci], lay };
      } else cl.decision = { type };
    }
    // 已经有人明确要这张牌了：还没表态的人只再给"读秒的 1/10"（30 秒读秒 ≈ 3 秒），
    // 免得点了吃之后还要干等别人的整个碰牌时限
    if (cl.decision) this.hurryOthers();
    if (cl.decision === null) this.emit({ t: 'pass', seat, card: this.tableCard!.card });
    // 耒阳可以弃胡：前面那家放弃之后，后面被"压住胡牌按钮"的人要重新给一次机会
    if (cl.decision === null && cl.options.some(o => o.type === 'hu')) this.reopenRobbedHu(seat);
    this.resolveClaims();
    return null;
  }

  /**
   * 这次吃要不要"捂"一下再揭晓：
   *  - 牌摆出来已经超过碰的时限（碰的机会早过了）→ 不用捂
   *  - 这个字在外面（各家下地牌 + 出牌堆）连桌上这张已经看得见 3 张 → 谁都不可能手里还有两张 → 碰不了 → 不用捂
   * 其余情况要捂：不然"马上吃到"和"等一会才吃到"能看出有没有人弃了碰。
   */
  private chiNoMask(tc: TableCard, seat?: number): boolean {
    if (tc.at !== undefined && this.now() - tc.at >= this.rules.timers.claimPeng) return true;
    let seen = 1;
    for (const p of this.players) {
      seen += p.discards.filter(k => k === tc.card).length;
      for (const m of p.melds) seen += m.cards.filter(k => k === tc.card).length;
    }
    // 我自己手里的那几张别人也就拿不到了（比如我手里就有两张，别家最多剩一张，碰不起来）
    if (seat !== undefined) seen += this.players[seat].hand.filter(k => k === tc.card).length;
    return seen >= 3;
  }

  /** 前面那家弃了胡：后面本来被压住"胡"按钮、又已经点了过的人，重新亮出来再给一次时间 */
  private reopenRobbedHu(passedSeat: number) {
    const tc = this.tableCard;
    if (!tc) return;
    const dist = (s: number) => (s - tc.from + this.n) % this.n;
    const now = this.now();
    for (const c of this.claims) {
      if (c.seat === passedSeat || dist(c.seat) <= dist(passedSeat)) continue;
      if (c.decision !== null || !c.options.some(o => o.type === 'hu')) continue;
      if (this.huRobbed(c.seat)) continue;                  // 前面还有别人能抢
      c.decision = undefined;
      c.fresh = true;
      c.span = this.rules.mustHu ? this.rules.timers.huForced : this.rules.timers.claimPeng;
      c.deadline = now + this.lag + c.span;
      /* 快窗口一并重开：不重开的话 fastDone 还是 true，按钮亮着、点下去被判"慢了一步" */
      c.fastDone = false;
      c.fastUntil = c.deadline; c.fastSpan = c.span;
      c.huUntil = this.rules.mustHu ? c.deadline : 0;
      c.huSpan = this.rules.mustHu ? c.span : 0;
      this.deadline = Math.max(this.deadline, c.deadline);
      this.emit({ t: 'options', seat: c.seat, options: c.options, deadline: c.deadline });
    }
  }

  /** 前面（离出牌 / 摸牌那家更近）还有人能抢胡且没表态：这一家的"胡"先不亮出来 */
  private huRobbed(seat: number): boolean {
    if (!this.tableCard) return false;
    const tc = this.tableCard;
    const dist = (s: number) => (s - tc.from + this.n) % this.n;
    return this.claims.some(x => x.seat !== seat && x.decision === undefined
      && dist(x.seat) < dist(seat) && x.options.some(o => o.type === 'hu'));
  }

  /** 找吃法：按"哪两张"比，不管客户端传上来的先后顺序 */
  static findCombo(combos: Kind[][] | undefined, combo?: Kind[]): number {
    if (!combos || !combo || combo.length !== 2) return -1;
    const key = [...combo].sort((a, b) => a - b).join(',');
    return combos.findIndex(cb => [...cb].sort((a, b) => a - b).join(',') === key);
  }

  private static PRIO: Record<string, number> = { ti: 6, wei: 5, hu: 4, pao: 3, peng: 2, chi: 1 };
  /** 仲裁排名：先比动作优先级，再比离出牌者的座位顺序（越近越优先） */
  private claimRank(c: Claim, tc: TableCard) {
    return this.bestPrio(c.options) * 10 - ((c.seat - tc.from + this.n) % this.n);
  }
  private bestPrio(opts: ActionOption[]) { return Math.max(0, ...opts.map(o => Game.PRIO[o.type] ?? 0)); }

  /** 仲裁：高优先级未决者存在时低优先级需等待；都决定或超时后按优先级（同级按出牌者顺位）执行 */
  /**
   * 「快速吃牌」的判定：只用这一家**看得见**的信息 —— 公开的（各家弃牌 + 明着摆在桌上的下地牌）
   * 加上他自己手里的，不算桌上这一张。一个字四张，桌上这张占掉一张，余下三张里已经有两张有着落，
   * 别人手里最多只剩一张 —— 碰要两张、跑要三张，所以谁也要不起。
   * 故意不看别人的手牌，也不数别人暗着的偎 / 提 / 龙：这样"吃得快不快"只取决于人人都看得见的信息，
   * 不会从落地快慢里漏出别家手里有什么。
   */
  /**
   * 吃牌"捂一下"的时长：**固定值，不带随机**，两档都压在 1.5 秒以内 ——
   *   · 凭公开信息断定谁也碰不了（快速吃牌）：读秒的 1/30（30 秒读秒＝1.0 秒）
   *   · 断不了：读秒的 1/20（30 秒读秒＝1.5 秒）
   * 为什么要捂：不捂的话"落地快慢"本身就告诉别人"有没有人能碰"。
   * 为什么不捂满碰的那半程（15 秒）：每次吃都干等十几秒，牌局爬不动。
   * 为什么两档差得这么小：一来手感要稳，二来两档差越小、从"快慢"里漏出来的信息越少。
   * （原来是 1/25 与 1/15＝1.2 / 2.0 秒，实战里每次吃都像卡了一下，往下压了一档。）
   */
  private chiHoldMs(fast: boolean) { return Math.round(this.rules.timers.discard / (fast ? 30 : 20)); }

  private publicNoTake(card: Kind, seat: number): boolean {
    let seen = this.players[seat].hand.filter(k => k === card).length;
    for (const p of this.players) {
      seen += p.discards.filter(k => k === card).length;
      for (const m of p.melds) {
        if (m.hidden && p.seat !== seat) continue;   // 别人暗着的牌不算：他自己看不见
        seen += m.cards.filter(k => k === card).length;
      }
    }
    return seen >= 2;
  }

  private resolveClaims() {
    // 桌上那张牌已经没了（被人拿走了、或者进了牌池）：这一轮仲裁早就结束，直接收摊。
    // 不加这一句的话，"大家都过了 → cardDead" 之后 claims 还留着（decision 是 null），
    // 外面再叫一次 resolveClaims 就会拿 null 的 tableCard 去算 dist，整个 tick 每 200ms 抛一次。
    const tc = this.tableCard;
    if (!tc) { this.claims = []; return; }
    // 地胡那一轮：没人胡的话，这张牌还回庄家手里（它本来就是庄家的牌），庄家照常出牌
    if (this.diHuOffer) {
      const nw0 = this.now();
      for (const c of this.claims) if (c.decision === undefined && nw0 < c.deadline) return;   // 还在等人表态
      const took = this.claims.find(c => c.decision);
      this.claims = []; this.tableCard = null;
      // 注意：真有人胡了，得**先**把这一胡结算掉再摘牌子 —— 算分的时候还要靠它认"这是地胡"
      if (took) { this.phase = 'init'; this.execClaim(took.seat, 'hu', tc); this.diHuOffer = false; return; }
      this.diHuOffer = false;
      this.enterDiscard(this.dealer);
      return;
    }
    /* 影子表态还没到点：先等着。它没有任何选项、赢不走这张牌，
       存在的意义就是**把时间花掉**，让"谁也要不起"跟"有人放弃了"花一样长。
       但**只有它一条**的时候才需要等 —— 真有人要得起这张牌，本来就有正常的表态时间，
       没什么好遮的。（以前不分青红皂白都等：有跑必跑那种引擎当场就替他跑了的，
       也被这 3 秒挡着，看着就是"跑不自动了"。） */
    if (!this.claims.some(c => !c.ghost && c.options.length))
      for (const c of this.claims)
        if (c.ghost && c.decision === undefined && this.now() < c.deadline) return;
    // 谁能拿走这张牌：先比动作优先级，同级再比离出牌 / 摸牌那家的座位顺序（摸牌者自己排第一）。
    // 只要还有人「有可能压过已经表态的最好那个」，就得等他表态——同级也要等，
    // 不然下家先点了吃，就把摸牌者自己的吃给抢走了。
    const dist = (seat: number) => (seat - tc.from + this.n) % this.n;
    let decidedBest = -1;
    for (const c of this.claims) if (c.decision) decidedBest = Math.max(decidedBest, Game.PRIO[c.decision.type] * 10 - dist(c.seat));
    // 只等「还来得及表态」的人：自己的倒计时已经走完的（比如快碰慢吃里 15 秒的碰），
    // 反正下一跳就自动过了，不用再让吃的人干等 —— 15 秒之后吃牌直接生效
    const nw = this.now();
    // 「他还来不来得及表态」按各自的有效到点算：快按钮还没到点就等快窗口，过了就等整条读秒
    const until = (c: Claim) => (!c.fastDone && c.fastUntil ? c.fastUntil : c.deadline);
    for (const c of this.claims)
      if (c.decision === undefined && nw < until(c) && this.bestPrio(c.options) * 10 - dist(c.seat) > decidedBest) return; // 等待
    // 臭牌：放弃碰的玩家之后不能再碰该牌；放弃吃的牌记为"回头牌"，之后再吃属违规
    const decided = this.claims.filter(c => c.decision);
    decided.sort((a, b) => {
      const d = Game.PRIO[b.decision!.type] - Game.PRIO[a.decision!.type];
      if (d) return d;
      return ((a.seat - tc.from + this.n) % this.n) - ((b.seat - tc.from + this.n) % this.n);
    });
    const w0 = decided[0];
    /* 臭牌（回头牌）：**碰得起却没碰**，这张字以后就不许再碰了。
       "没碰"不只是点了过 / 超时（decision === null）——
       也包括**根本没表态**（decision === undefined：他那半程窗口先到点，仲裁就不等他了）。
       以前只认 null，于是"第一张没碰、让别人吃了，第二张又碰"这种没被记上，
       回头牌就罚不到人。牌是被别人吃走的、还是压根没人要，都一样算他放弃过。
       被更高优先级抢走的不算（别人胡了 / 别人碰了，他连出手的机会都没有），
       自己点了碰却输给胡的也不算 —— 他是表过态的。 */
    const takenByHigher = !!w0 && (w0.decision!.type === 'hu' || w0.decision!.type === 'pao' || w0.decision!.type === 'peng');
    if (this.rules.chouPai) for (const c of this.claims) {
      if (!c.options.some(o => o.type === 'peng')) continue;
      if (c.decision && c.decision.type === 'peng') continue;             // 他碰了（哪怕被胡压下去）
      if (takenByHigher && w0.seat !== c.seat) continue;                  // 被胡 / 别人的碰抢走：不怪他
      if (!this.players[c.seat].chou.includes(tc.card)) this.players[c.seat].chou.push(tc.card);
    }
    // 吃回头牌：只有自己明确放弃（点过 / 超时）才算；被别家抢走时自己根本没机会吃，不记
    for (const c of this.claims)
      if (c.decision === null && c.options.some(o => o.type === 'chi') && !this.players[c.seat].passedChi.includes(tc.card))
        this.players[c.seat].passedChi.push(tc.card);
    if (!decided.length) { this.cardDead(tc, false); return; }   // 大家都点了过 / 超时：不用再捂，直接进下一轮
    const w = w0;
    // 快速吃牌：吃要不要"等满碰的那半程"，只看公开信息 ——
    // 凭桌面 + 自己手里就能断定谁也碰不了（≥2 张有着落）→ 当场落地；
    // 断不了 → 哪怕引擎知道实际没人能碰，也照样等满，免得从"落地快慢"看出别家手里的牌。
    if (!this.replayMode && w.decision!.type === 'chi') {
      /* 该等的人已经全都表过态了（点了过 / 超时判过）：那就没什么好等的 ——
         这一档拖延本来是为了不让人从"落地快慢"看出别家手里有没有牌，
         可大家都亮过态度了，拖着只是让下家干等。 */
      const allSpoke = this.claims.every(c => c.decision !== undefined);
      if (!allSpoke) {
        const holdUntil = (tc.at ?? this.now()) + this.chiHoldMs(this.publicNoTake(tc.card, w.seat));
        if (this.now() < holdUntil) return;
      }
    }
    this.claims = [];
    this.phase = 'init';
    this.execClaim(w.seat, w.decision!.type, tc, w.decision!.combo, w.decision!.lay ?? 0);
  }

  private execClaim(seat: number, type: ActionType, tc: TableCard, combo?: Kind[], lay = 0) {
    const p = this.players[seat];
    const c = tc.card;
    const self = seat === tc.from;          // 摸牌者处理自己摸到的牌
    /* 这一手他本来能干什么、直接胡值多少 —— 只有点「胡」那一路用得上（见下面 case 'hu'）。
       注意 `this.claims` 在 resolveClaims 里**已经清空了**才调到这儿，不能指望从里头翻；
       重新算一遍就是了（claimOptions / drawerOptions 都是纯算，不动状态）。 */
    const opts0 = type !== 'hu' ? []
      : (this.claims.find(x => x.seat === seat)?.options
        ?? (self ? this.drawerOptions : this.claimOptions(seat, tc)));
    const huUnit0 = type === 'hu' ? (opts0.find(o => o.type === 'hu')?.unit ?? 0) : 0;
    this.tableCard = null;
    this.claims = [];   // 牌一离桌，这一轮的表态记录就作废
    if (self) this.drawn = null;
    // 这一轮要凑组的牌号：桌上那张先记上（吃的时候它排在组里第一张）
    this.takenIds = [];
    if (tc.cid !== undefined) this.takenIds.push(tc.cid);
    // 这一张是从别家那儿要走的：记下它的号，下地之后在牌面上点一个记号
    this.claimCid = self ? undefined : tc.cid;
    this.claimDrawn = tc.source === 'draw';
    // 这张牌是我摆上桌、被别家要走的：不管他是吃是碰，这个字对我来说就成了"回头牌"，
    // 以后再吃同一个字算违规（胡不受影响，照样可以胡这个字）
    if (!self && !this.players[tc.from].passedChi.includes(c)) this.players[tc.from].passedChi.push(c);
    switch (type) {
      case 'hu': {
        /* 点了胡：先看看**这张牌先下地再胡**是不是更值钱。
           「一对小八 + 三个大捌，来了第四张捌」就是这么亏的 —— 直接胡会把那一坎拆成
           「八八捌」去配句子，而 捌捌捌捌 开跑再胡要高好几息。
           玩家点胡表达的是"我要胡"，具体怎么拆是引擎的事：哪条路分高走哪条。
           走下地这条的话，下完地引擎马上会再问一次胡（afterBigMeld → offerSelfHu），
           衡阳有胡必胡到点自动成交，耒阳也会把按钮亮出来。 */
        /* 只改道到**跑** —— 跑本来就是"有跑必跑"，先跑再胡跟规矩一致。
           碰不行：碰是可碰可不碰的，而且这张牌一旦当成碰拿走，就不再算放炮了，
           等于替玩家改了这一手的性质（放炮那几条测试正是这么被弄翻的）。
           提 / 偎只能自摸，抢牌这一路压根到不了。 */
        const canPao = opts0.some(o => o.type === 'pao');
        const afterPao = canPao
          ? this.meldThenHuUnit(seat, 'pao', c, self, !self && tc.source === 'discard', tc.from)
          : null;
        if (afterPao !== null && afterPao > huUnit0) { this.execClaim(seat, 'pao', tc); return; }
        this.doHu(seat, c, tc.from, self, !self && tc.source === 'discard'); return;
      }
      case 'ti': {
        const before = p.longCount;
        const wei = p.melds.findIndex(m => m.type === 'wei' && m.cards[0] === c);
        if (wei >= 0) { this.takenIds.push(...(p.melds[wei].cids ?? [])); p.melds.splice(wei, 1); } else this.removeFromHand(p, c, 3);
        this.addMeld(seat, { type: wei >= 0 ? 'ti' : 'long', cards: [c, c, c, c], xi: tiXi(c), hidden: true, from: seat }, seat);
        this.afterBigMeld(seat, before, seat, false); return;
      }
      case 'wei': {
        this.removeFromHand(p, c, 2);
        this.addMeld(seat, { type: 'wei', cards: [c, c, c], xi: weiXi(c), hidden: true, from: seat }, seat);
        p.acted = true;
        this.afterWei(seat, c, tc.from, !self && tc.source === 'discard'); return;
      }
      case 'pao': {
        const before = p.longCount;
        const i = p.melds.findIndex(m => (m.type === 'peng' || m.type === 'wei') && m.cards[0] === c);
        const openMeld = i >= 0;   // 跑的是"桌上摆着的那一组"（偎 / 碰），大家都看得见
        if (i >= 0) { this.takenIds.push(...(p.melds[i].cids ?? [])); p.melds.splice(i, 1); } else this.removeFromHand(p, c, 3);
        this.addMeld(seat, { type: 'pao', cards: [c, c, c, c], xi: paoXi(c), hidden: false, from: tc.from, again: i >= 0 }, tc.from);
        // 打出去的牌被别家开跑：这一局他不能再主动进张（不能吃、不能碰），只剩偎 / 提 / 跑 / 胡。
        // 只有"看得见的偎 / 碰"才算——人家偎在桌上摆着还去喂牌，才该受限制；
        // 别人手里捂着的坎谁也不知道，被跑了不怪打牌的人，不禁吃碰。
        if (!self && tc.source === 'discard' && openMeld) this.players[tc.from].noTake = true;
        this.afterBigMeld(seat, before, tc.from, !self && tc.source === 'discard'); return;
      }
      case 'peng': {
        this.removeFromHand(p, c, 2);
        this.addMeld(seat, { type: 'peng', cards: [c, c, c], xi: pengXi(c), hidden: false, from: tc.from }, tc.from);
        p.acted = true; this.enterDiscard(seat, true); return;
      }
      case 'chi': {
        const opt = this.chiOption(p, c)!;
        const idx = Math.max(0, Game.findCombo(opt.combos, combo));
        const lays = opt.comboLays?.[idx] ?? [];
        this.execChi(seat, c, opt.combos![idx], lays[Math.min(lay, lays.length - 1)] ?? [], tc.from, this.chiNoMask(tc, seat)); return;
      }
    }
  }

  /** 公共牌派出 midAfter 张之后，每人再发一张延时卡 */
  private grantMidDelay() {
    if (this.midGranted || this.rules.delay.atMid <= 0) return;
    if (this.pileStart - this.pile.length < this.rules.delay.midAfter) return;
    this.midGranted = true;
    for (let s = 0; s < this.n; s++) this.delayCards[s] += this.rules.delay.atMid;
    this.emit({ t: 'delay_grant', counts: this.delayCards.slice() });
  }

  /** 到点没表态：手里还有延时卡就自动用掉一张，按原时长再续一次（胡、碰、跑不用延时卡） */
  private useDelay(seat: number, deadline: number, span: number, opts: ActionOption[] = []): number | null {
    if (opts.some(o => o.type === 'hu')) return null;   // 胡就是胡，不给延时
    /* 跑是"有跑必跑"、到点引擎自己就替他跑了，续时间没有意义，照旧不给。
       碰**给**：跟出牌、摸牌一样，一张卡换一次完整的思考时间，续的就是碰自己那半程读秒。 */
    if (opts.some(o => o.type === 'pao')) return null;
    if (this.delayCards[seat] <= 0 || span <= 0) return null;
    this.delayCards[seat]--;
    /* 加时间就从**现在**起算：到点才自动用卡，这会儿原来那个到点时刻已经过去了，
       照着它加只能给到不足一整段。（跟切片播放那套"事后找补"没关系，
       这一笔是规矩里明写的：一张卡换一次完整的思考时间。） */
    const nd = Math.max(deadline, this.now()) + span + this.lag;
    this.emit({ t: 'delay_use', seat, left: this.delayCards[seat], deadline: nd });
    return nd;
  }

  // ---------- 超时 ----------
  /** 由外部定时调用；超时自动处理（碰/吃超时视为放弃、摸牌超时自动打出、出牌超时自动出牌） */
  tick(now = this.now()): boolean {
    if (this.ended) return false;
    let changed = false;
    if (this.phase === 'claim') {
      // 留一点宽限：画面比服务端慢半拍，踩着倒计时最后一下点下去的也认，别判成「过」；
      // 到点自动胡 / 自动跑的那种不宽限（该胡就得准时胡）
      for (const c of this.claims) {
        if (c.decision !== undefined) continue;
        /* 影子表态：没有按钮、不发 pass 事件、也不吃延时卡 —— 到点悄悄过掉就行 */
        if (c.ghost) { if (now >= c.deadline) { c.decision = null; changed = true; } continue; }
        // 地胡那一轮：到点没点就算放过（衡阳有胡必胡，超时替他胡）
        if (this.diHuOffer) {
          if (now < c.deadline) continue;
          c.decision = this.rules.mustHu ? { type: 'hu' } : null;
          if (!c.decision) this.emit({ t: 'pass', seat: c.seat, card: this.tableCard!.card });
          changed = true; continue;
        }
        // 衡阳有胡必胡：胡那 5 秒先到点 —— 到点就替他胡（这一条到此为止，碰的窗口也就没意义了）
        if (c.huUntil && now >= c.huUntil) {
          const hu1 = c.options.find(o => o.type === 'hu');
          if (hu1) {
            const nd = this.useDelay(c.seat, c.huUntil, c.huSpan ?? 0, c.options);
            if (nd !== null) { c.huUntil = nd; c.deadline = Math.max(c.deadline, nd); this.deadline = Math.max(this.deadline, nd); changed = true; continue; }
            this.timedOut.set(c.seat, { card: this.tableCard!.card, at: now });
            c.decision = { type: 'hu' };
            this.logStep(c.seat, 'hu', { card: this.tableCard!.card });
            changed = true; continue;
          }
          c.huUntil = 0;
        }
        /* 碰那半程一到点，**立刻**先把延时卡用掉 —— 一点宽限都不能等。
           别家（吃）已经表过态的时候，同一次 tick 末尾的 resolveClaims 是按 fastUntil
           本身（不带宽限）判这条过没过的：晚哪怕一步，吃就已经落地了，
           玩家看到的就是「超时被上家吃进去了，可我的延时卡一张没少」。
           下面那个大块要等 CLAIM_GRACE，那是给"踩着最后一下点下去的人"留的，
           跟"替他用卡续时间"不是一回事。 */
        if (c.fastUntil && !c.fastDone && now >= c.fastUntil
            && c.options.some(o => o.type === 'peng')
            && !c.options.some(o => o.type === 'hu' || o.type === 'pao')) {
          /* 续的是**碰原本那半程**（claimPeng），不是 hurryOthers 压短之后剩下的那一点 ——
             一张卡换一次完整的思考时间；别人点得快能把没用卡的人催到 3 秒，
             但不该连这张卡的分量一起压掉。 */
          const full = this.rules.timers.claimPeng;
          const nd = this.useDelay(c.seat, c.fastUntil, full, c.options.filter(o => o.type === 'peng'));
          if (nd !== null) {
            c.fastUntil = nd; c.fastSpan = full;
            c.deadline = Math.max(c.deadline, nd);
            this.deadline = Math.max(this.deadline, nd);
            // 碰的按钮重新亮出来：客户端是按 fastUntil 画圈、按它收按钮的
            this.emit({ t: 'options', seat: c.seat, options: c.options, deadline: c.deadline });
            changed = true; continue;
          }
        }
        // 快选项（碰 / 跑 / 胡）的窗口到了：该自动胡 / 自动跑的照做；
        // 还留着"吃"的就只把快按钮收走，继续等他吃；什么都不剩就算放弃
        if (c.fastUntil && now >= c.fastUntil + (c.options.some(o => o.type === 'hu' || o.type === 'pao') ? 0 : Game.CLAIM_GRACE)) {
          const hu0 = c.options.find(o => o.type === 'hu');
          const pao0 = c.options.find(o => o.type === 'pao');
          // 衡阳有胡必胡：到点替他胡。耒阳可以弃胡：到点就是**放弃**，不替他胡（跑还是必跑）
          const autoHu = hu0 && this.rules.mustHu;
          if (autoHu || pao0) {
            const nd = this.useDelay(c.seat, c.fastUntil, c.span ?? 0, c.options);
            if (nd !== null) { c.fastUntil = nd; c.deadline = Math.max(c.deadline, nd); this.deadline = Math.max(this.deadline, nd); changed = true; continue; }
            this.timedOut.set(c.seat, { card: this.tableCard!.card, at: now });
            if (!autoHu && hu0 && !c.huDeclined) { this.declineHu(c.seat, hu0); c.huDeclined = true; }   // 能胡却超时：记一笔弃胡（「贪」），只记一次
            c.decision = autoHu ? { type: 'hu' } : { type: 'pao' };
            this.logStep(c.seat, autoHu ? 'hu' : 'pao', { card: this.tableCard!.card });
            changed = true; continue;
          }
          /* 碰的延时卡在上面（fastUntil 一到点）就已经结算过了，这儿不用再来一遍 */
          if (hu0 && !c.huDeclined) { this.declineHu(c.seat, hu0); c.huDeclined = true; }   // 耒阳：胡的窗口过了＝弃胡（只记一次）
          c.fastUntil = 0; c.fastDone = true;
          this.timedOut.set(c.seat, { card: this.tableCard!.card, at: now });
          if (!c.options.some(o => o.type === 'chi')) {
            c.decision = null;
            this.logStep(c.seat, 'pass', { card: this.tableCard!.card });
            this.emit({ t: 'pass', seat: c.seat, card: this.tableCard!.card });
          } else {
            this.emit({ t: 'options', seat: c.seat, options: c.options.filter(o => o.type === 'chi'), deadline: c.deadline });
          }
          changed = true; continue;
        }
        const willAuto = c.options.some(o => o.type === 'hu' || o.type === 'pao');
        if (now < c.deadline + (willAuto ? 0 : Game.CLAIM_GRACE)) continue;
        {
        /* 手里有延时卡：先自动用掉一张续时间，不急着替他做决定。
           看的是**这会儿还能干什么**：碰 / 跑 的那半程早过了（fastDone），
           options 里留着它们只是为了判臭牌 —— 拿老的去比，就成了"能碰所以不给延时"，
           于是只剩下吃的人也用不上卡。 */
        const liveOpts = c.fastDone ? c.options.filter(o => o.type === 'chi' || o.type === 'pass') : c.options;
        const nd = this.useDelay(c.seat, c.deadline, c.span ?? 0, liveOpts);
        if (nd !== null) { c.deadline = nd; this.deadline = Math.max(this.deadline, nd); changed = true; continue; }
        this.timedOut.set(c.seat, { card: this.tableCard!.card, at: now });
        // 超时：衡阳有胡必胡 → 替他胡；耒阳能弃胡 → 超时就算放弃。有跑还是必跑。
        const hu0 = c.options.find(o => o.type === 'hu');
        const hu = hu0 && this.rules.mustHu ? hu0 : undefined;
        const pao = c.options.find(o => o.type === 'pao');
        if (hu0 && !hu && !c.huDeclined) { this.declineHu(c.seat, hu0); c.huDeclined = true; }
        c.decision = hu ? { type: 'hu' } : pao ? { type: 'pao' } : null;
        this.logStep(c.seat, hu ? 'hu' : pao ? 'pao' : 'pass', { card: this.tableCard!.card });
        if (!hu && !pao) this.emit({ t: 'pass', seat: c.seat, card: this.tableCard!.card });
        changed = true;
        }
      }
      // 就算这一圈没人动，也要回头看看"压着等满半程的那个吃"到点没有
      const n0 = this.events.length, ph0 = this.phase;
      // decision 为 null 是"过"，不算有人要牌；只有桌上还有牌、且真有人点了动作时才回头看一眼
      if (changed || (this.tableCard && this.claims.some(c => c.decision))) this.resolveClaims();
      return changed || this.phase !== ph0 || this.events.length !== n0;
    }
    if (now < this.deadline) return false;
    if (this.phase === 'drawer_decide' || this.phase === 'discard') {
      const nd = this.useDelay(this.turn, this.deadline, this.deadlineSpan,
        this.phase === 'drawer_decide' ? this.drawerOptions : []);
      if (nd !== null) { this.deadline = nd; return true; }
    }
    if (this.phase === 'drawer_decide') {
      const hu0 = this.drawerOptions.find(o => o.type === 'hu');
      // 耒阳：问你"胡不胡"，到点没答就是**不胡**，接着打牌（衡阳照旧替他胡）
      if (hu0 && !this.rules.mustHu) {
        const seat = this.turn;
        this.act(seat, 'pass');
        if ((this.phase as string) === 'discard' && this.turn === seat) this.setDeadline(this.rules.timers.discard);
        return true;
      }
      const hu = hu0;
      if (hu) {
        const seat = this.turn;
        // 胡不成也不能卡在这儿：退一步让他出张牌，桌子接着打
        if (this.act(seat, 'hu') && this.phase === 'drawer_decide' && this.turn === seat) {
          if (this.drawn !== null) this.act(seat, 'play_drawn');
          else if (this.drawerOptions.some(o => o.type === 'pass')) this.act(seat, 'pass');
          if ((this.phase as string) === 'discard' && this.turn === seat) this.act(seat, 'discard', { card: this.autoDiscardCard(seat) });
        }
      }
      else if (this.drawn !== null) {
        const forced = this.drawerOptions.find(o => o.type === 'ti' || o.type === 'wei');
        this.act(this.turn, forced ? forced.type : 'play_drawn');
      }
      else this.act(this.turn, 'discard', { card: this.autoDiscardCard(this.turn) });
      return true;
    }
    if (this.phase === 'discard') {
      const seat = this.turn;
      let err = this.act(seat, 'discard', { card: this.autoDiscardCard(seat) });
      if (err) {
        /* 挑的那张被引擎拒了（拆坎、该下伙没下伙之类）：手里逐张试，能出哪张出哪张。
           以前这儿是"发一次就当走完了"（直接 return true）——act 失败的话一步没动、
           却报告"动过了"，外面每 200ms 叫一次、每次都白跑，桌子就冻在出牌这一步。 */
        for (const k of [...this.players[seat].hand]) { err = this.act(seat, 'discard', { card: k }); if (!err) break; }
      }
      // 一张都出不掉：按黄庄收场。宁可这一局算平，也绝不把整桌冻在这儿
      if (err) { this.forceLiuJu(`出牌卡住：${err}`); }
      return true;
    }
    return false;
  }

  /** 桌子推不动了的兜底：按黄庄结束这一局。原因只往日志里写，不塞进事件流（客户端不认得的事件会更乱） */
  forceLiuJu(reason = '') {
    if (this.ended) return;
    if (reason) console.error(`[强制黄庄] ${reason} · phase=${this.phase} turn=${this.turn} pile=${this.pile.length}`);
    this.endLiuJu();
  }

  /** 超时自动出牌：出对成句贡献最小的散牌，且绝不拆坎（拆坎会被拒、还要罚分） */
  autoDiscardCard(seat: number): Kind {
    const p = this.players[seat];
    const ok = (k: Kind) => p.hand.filter(x => x === k).length < 3;
    const r = partition(p.hand, true);
    const pick = [...r.singles].reverse().find(ok)
      ?? [...r.pairs].reverse().map(x => x[0]).find(ok)
      ?? [...p.hand].reverse().find(ok);
    return pick ?? p.hand[p.hand.length - 1];
  }

  // ---------- 结算 ----------
  /** 只计算不改状态（用于判断是否值得胡 / 是否高于放弃过的分） */
  private computeHu(seat: number, card: Kind, fromSeat: number, ziMo: boolean, dianPao: boolean): { detail: HuDetail; delta: number[] } {
    const p = this.players[seat];
    const hand = card >= 0 ? [...p.hand, card] : p.hand.slice();
    const part0 = partitionKeepKan(hand, p.hand);
    // partition 有 memo，复制一份再改，别污染缓存
    const part = { ...part0, groups: part0.groups.map(g => ({ ...g, cards: g.cards.slice() })) };
    const R = this.rules;
    const breakdown: string[] = [];
    let xi = part.xi + this.meldXi(p);
    // 胡的那张牌凑成的三张同字不是"坎"（坎必须是手里原有三张），按"碰"算息
    if (card >= 0 && p.hand.filter(k => k === card).length < 3) {
      const g = part.groups.find(x => x.cards.length === 3 && x.cards.every(k => k === card));
      if (g) { const diff = kanXi(card) - pengXi(card); g.xi -= diff; xi -= diff; (g as any).asPeng = true; }
    }
    // 无胡：一点胡息都没有、也没有作对的牌，耒阳按 21 胡算
    const noXi = xi === 0 && this.rules.noXiHu > 0 && part.pairs.length === 0;
    if (noXi) xi = this.rules.noXiHu;
    const all = [...hand, ...p.melds.flatMap(m => m.cards)];
    const redCount = all.filter(isRed).length;
    const tianHu = this.tianHuPossible && seat === this.dealer && card < 0 && !p.acted;
    /* 地胡：两家玩法不是一回事
       - 衡阳：闲家**起手就胡庄家亮出来的那张阳张**（庄家摸到的最后一张），也就是发牌后问的那一圈；
       - 耒阳：闲家在自己第一次动手之前就胡（桌面最多只有庄家打出的第一张牌）。 */
    const diHu0 = !tianHu && seat !== this.dealer && !p.acted && (
      this.rules.scoring === 'hengyang'
        ? this.diHuOffer && card >= 0 && fromSeat === this.dealer
        : this.deadPool.length <= 1 && this.players.every(q => q.seat === this.dealer || !q.acted));
    /* 耒阳「举手胡」：闲家**进的第一张就是胡牌的那一张** → 胡息翻倍。
       也就是胡之前一张都没进过（吃 / 碰 / 偎 / 提 / 跑 都算进张，起手龙不算）；
       提龙胡 / 开跑胡 / 偎起胡 那一下进的张就是促成这次胡的，不能把它自己算进去。 */
    const huFromMeld = card < 0 && !!this.bigMeldType;
    /* 耒阳里这一路胡就叫「举手」，没有"地胡"这个叫法：闲家一动没动就胡了，
       跟"进的第一张就是胡的那张"是同一回事，合成一个名目（翻倍也只翻一次）。 */
    const diHu = this.rules.scoring === 'leiyang' ? false : diHu0;
    // 举手胡可以在开房时关掉（关了就当普通胡算，不翻倍）
    const raiseHand = this.rules.raiseHand && this.rules.scoring === 'leiyang' && !tianHu && seat !== this.dealer
      && (diHu0 || (p.tookCount ?? 0) <= (huFromMeld ? 1 : 0));
    let extraXi = 0, dun = 0, multiplier = 1, redName = '', huCardCount = 0;

    // 番：收集起来最后合成一行（放炮倍数要等下面算完才知道）
    const mults: { label: string; v: number }[] = [];
    const huKind = card >= 0 ? card : this.bigMeldKind;

    if (R.scoring === 'hengyang') {
      // 衡阳没有"胡息翻倍"这一说：天胡 / 地胡是**分数翻倍**，跟大红 / 自摸一样当番算
      const baseDun = hengyangDun(xi);
      let addDun = 0; const addParts: string[] = [];
      // 加敦①：胡的那个字，手里的（含胡的那张）+ 已经下地的都算，打出去的不算。开房时可以关掉
      if (huKind >= 0 && R.huCardDun) {
        huCardCount = [...hand, ...p.melds.flatMap(m => m.cards)].filter(x => x === huKind).length;
        addDun += huCardCount; addParts.push(`胡${nameOfKind(huKind)}${huCardCount}张`);
      }
      // 加敦②：红字超出小红 / 大红门槛的每张加敦（不算红黑的桌子就没这一笔）
      const over = !R.redBlack ? 0
        : redCount >= R.red.bigRedMin ? redCount - R.red.bigRedMin : redCount >= R.red.smallRedMin ? redCount - R.red.smallRedMin : 0;
      if (over > 0) { extraXi = over * R.red.extraDunPerRed; addDun += extraXi; addParts.push(`红字多${over}张`); }
      dun = baseDun + addDun;
      // 第二行：胡息（折多少敦直接跟在后面）→ 加敦 → 总敦。"按 15 算"这种算法细节不写，看的人只要结果
      breakdown.push(`${xi}胡(${baseDun}敦)${addDun ? ` + ${addDun}敦（${addParts.join('、')}）` : ''} → ${dun}敦`);
      if (tianHu) mults.push({ label: '天胡', v: 2 });
      if (diHu) mults.push({ label: '地胡', v: 2 });
      // 红黑（大红 / 小红 / 全黑 / 一点红）整套可以在开房时关掉
      if (!R.redBlack) { /* 不算红黑：这一桌只比胡息 */ }
      else if (redCount >= R.red.bigRedMin) { redName = '大红'; mults.push({ label: `大红(${redCount}红)`, v: R.red.bigRedMultiplier }); }
      else if (redCount >= R.red.smallRedMin) { redName = '小红'; mults.push({ label: `小红(${redCount}红)`, v: R.red.smallRedMultiplier }); }
      else if (redCount === 0) { redName = '全黑'; mults.push({ label: '全黑', v: R.red.allBlackMultiplier }); }
      else if (redCount === 1) { redName = '一点红'; mults.push({ label: '一点红', v: R.red.oneRedMultiplier }); }
      if (ziMo) mults.push({ label: '自摸', v: R.ziMoMultiplier });
    } else {
      // 耒阳：13 红 / 全黑 / 一点红 / 天胡 / 地胡 → 胡息翻倍，翻倍后再算敦；自摸 → 敦数翻倍
      const d = R.leiyang.doubleMultiplier;
      const dbl: string[] = [];
      if (!R.redBlack) { /* 不算红黑：这一桌只比胡息 */ }
      else if (redCount >= R.leiyang.bigRedMin) { redName = '大红'; dbl.push('13红'); }
      else if (redCount === 0) { redName = '全黑'; dbl.push('全黑'); }
      else if (redCount === 1) { redName = '一点红'; dbl.push('一点红'); }
      if (tianHu) dbl.push('天胡');
      if (diHu) dbl.push('地胡');
      // 是举手胡就写一行；不是的话不用特意说明"为什么不是"，结算里已经够长了
      if (raiseHand) dbl.push('举手胡');
      /* 卡胡翻倍要先"补到卡位的上界"再翻。
         10 胡（小卡胡）本来就当 2 敦用 —— 那 2 敦对应的是 16 胡那一档；
         20 胡（大卡胡）的 4 敦对应 24 胡那一档。所以翻倍的时候拿 10 / 20 去乘是亏的：
         小卡胡应当 16×2 = 32 胡（6 敦），不是 10×2 = 20 胡（4 敦）；
         大卡胡应当 24×2 = 48 胡，不是 20×2 = 40 胡。
         不翻倍的时候照旧 —— 10 就是 10（2 敦）、20 就是 20（4 敦）。 */
      const kaBase = xi === 10 ? 16 : xi === 20 ? 24 : xi;
      const effXi = dbl.length ? kaBase * d ** dbl.length : xi;
      extraXi = effXi - xi;
      dun = leiyangDun(effXi);
      const kaNote = dbl.length && kaBase !== xi ? `卡胡按 ${kaBase} 胡翻、` : '';
      breakdown.push(`${noXi ? `无胡按 ${xi} 胡算` : `${xi}胡`}${dbl.length ? `（${kaNote}${dbl.join('、')} 胡息×${d} → ${effXi}胡）` : ''} → ${dun}敦${effXi === 10 || effXi === 20 ? '(卡胡)' : ''}`);
      if (ziMo) mults.push({ label: '自摸', v: R.ziMoMultiplier });
    }
    for (const m of mults) multiplier *= m.v;
    const unit = dun * multiplier * this.baseScore;
    const delta = new Array(this.n).fill(0);
    const isDianPao = dianPao && fromSeat !== seat;
    const pay = unit * R.dianPaoMultiplier;
    if (isDianPao) {
      // 放炮：放炮者按倍数独付，其他家不输赢（衡阳 3 倍、耒阳 2 倍）
      delta[fromSeat] -= pay; delta[seat] += pay;
    } else {
      for (let t = 0; t < this.n; t++) if (t !== seat) { delta[t] -= unit; delta[seat] += unit; }
    }
    /* 第三行：敦数 × 各种番 = 每家多少分 → 这一胡总共进账多少，
       并写明是**一家出**（放炮）还是**两家出**（自摸 / 别家打的牌没人认领那种） */
    const multTxt = mults.map(m => ` × ${m.label}${m.v}倍`).join('');
    const baseTxt = this.baseScore !== 1 ? ` × 底分${this.baseScore}` : '';
    // 写"这一胡总共进账多少"，括号里再交代是几家出、每家多少 —— 先看总数，别让人自己去乘
    breakdown.push(isDianPao
      ? `${dun}敦${multTxt}${baseTxt} = ${unit} 分 × 放炮${R.dianPaoMultiplier}倍 → 共 +${pay} 分`
      : `${dun}敦${multTxt}${baseTxt} = ${unit} 分 → 共 +${unit * (this.n - 1)} 分`);
    const scores = this.scores.map((v, i) => v + delta[i]);
    const detail: HuDetail = {
      handGroups: part.groups, pair: part.pairs[0] ?? null, melds: p.melds, xi, extraXi, dun, huCardCount, multiplier,
      redCount, redName, tianHu, diHu, raiseHand, ziMo, unit, dianPao: dianPao && fromSeat !== seat, breakdown, scores,
      bigMeldType: card < 0 ? this.bigMeldType : '',
      huKind: huKind >= 0 ? huKind : undefined,
      // 含胡牌的那一组：有好几组都带这个字时取**最后那一组**（新成的句子排在后面）
      huGroupIdx: card >= 0 ? part.groups.map(g => g.cards.includes(card)).lastIndexOf(true) : -1,
      // 胡的方式：下地那几种直接用 bigMeldType；胡一张牌的，看这张牌在哪种句子里 ——
      // 三张同字就是碰胡（坎胡），凑成顺子就是吃胡
      huWay: card < 0 ? (this.bigMeldType || 'ti')
        : (part.groups.some(g => g.cards.includes(card) && g.cards.length === 3 && g.cards.every(k => k === card)) ? 'peng' : 'chi'),
      huDelta: delta.slice(), penalty: this.penaltyScores.slice(), tilong: this.tilongScores.slice(),
    };
    return { detail, delta };
  }

  huCard: Kind = -1;                   // 胡的那一张（亮牌时摆进胡牌者的手牌里一起看）
  private timedOut = new Map<number, { card: Kind; at: number }>();   // 谁在哪张牌上超时没表态
  private doHu(seat: number, card: Kind, fromSeat: number, ziMo: boolean, dianPao: boolean) {
    const { detail, delta } = this.computeHu(seat, card, fromSeat, ziMo, dianPao);
    this.huCard = card;
    for (let s = 0; s < this.n; s++) this.scores[s] += delta[s];
    this.winner = seat;
    this.ended = true;
    this.phase = 'ended';
    this.emit({ t: 'hu', seat, card, ziMo, fromSeat, detail });
    this.emit({ t: 'end', scores: this.scores.slice(), winner: seat, dealerNext: seat });
  }

  private endLiuJu() {
    this.ended = true;
    this.phase = 'ended';
    this.emit({ t: 'liuju' });
    // 黄庄：庄家顺延给下一家
    this.emit({ t: 'end', scores: this.scores.slice(), winner: null, dealerNext: this.next(this.dealer) });
  }

  // ---------- 视图 ----------
  /** 某座位视角的可见状态（隐藏他人手牌与暗牌内容） */
  /**
   * 拍一张"当前局面"的快照。
   * 这里所有数组 / 对象都必须**拷贝一份**再交出去：服务端会把快照存进待播的帧里，
   * 隔几百毫秒才发给客户端。以前 hand / discards / deadPool 这些是直接把引擎里那个数组
   * 递出去的（同一个引用），引擎接着往前走时就把早就拍好的快照一起改了 ——
   * 画面上就成了"牌还在一轮一轮地摸，我手里的两张却凭空少了"（偎 / 提 / 跑 最容易撞上），
   * 弃牌堆、牌池提前多出一张也是同一个原因。
   */
  /**
   * 收牌：这一局打完，照牌桌上的样子把 80 张拢成一摞 ——
   * 各家面前下地的牌组（一组一组连着）、弃牌堆、桌上那张、各家手里剩的、没翻出来的公共牌。
   * 下一局拿它接着洗（见 cards.ts 的 riffleShuffle），跟真人打牌一样：
   * 上一局的坎、句子会留下一点残影，牌感跟"每局重新发一副全新的牌"完全不同。
   * 无论如何都返回完整的 80 张：对不上就补齐，绝不让下一局少牌。
   */
  collect(): Kind[] {
    const out: Kind[] = [];
    for (const p of this.players) for (const m of p.melds) out.push(...m.cards.filter(c => c >= 0));
    out.push(...this.deadPool);
    if (this.tableCard) out.push(this.tableCard.card);
    if (this.drawn !== null) out.push(this.drawn);
    if (this.huCard >= 0) out.push(this.huCard);
    for (const p of this.players) out.push(...p.hand);
    out.push(...this.pile);
    // 对账：多的丢掉、少的补上（胡的那张牌归属、中途作废的局面……宁可补齐也不能开局缺牌）
    const want = toCounts(fullDeck());
    const got = new Array(KIND_COUNT).fill(0);
    const fixed: Kind[] = [];
    for (const k of out) if (k >= 0 && k < KIND_COUNT && got[k] < want[k]) { got[k]++; fixed.push(k); }
    for (let k = 0; k < KIND_COUNT; k++) for (let i = got[k]; i < want[k]; i++) fixed.push(k);
    return fixed;
  }

  view(seat: number | null) {
    return {
      phase: this.phase,
      turn: this.turn,
      dealer: this.dealer,
      pileLeft: this.pile.length,
      drawn: this.drawn,
      tableCard: this.tableCard ? { ...this.tableCard } : null,
      deadline: this.deadline,
      /* 这一手原本给了多久 —— 客户端画圈用它，而不是"到点时刻减现在"。
         到点时刻减现在算出来的是**剩下**多少，一旦这一帧在路上耽搁了，
         圈就会从半格开始、还走得飞快；按原本的时长走，画面才跟真人手感对得上。 */
      deadlineSpan: this.deadlineSpan,
      deadPool: this.deadPool.slice(),
      delayCards: this.delayCards.slice(),
      pileRest: this.ended ? this.pile.slice() : undefined,   // 结束后把没翻出来的公共牌也摆开
      scores: this.scores.slice(),
      ended: this.ended,
      winner: this.winner,
      myOptions: this.optionsFor(seat),
      // 我已经表过态（碰/吃/过…），正在等其他玩家决定
      // 我已经表过态、还在等别家表态（客户端据此显示"排队中"，不然就是立刻生效）
      myWaiting: (() => {
        if (seat === null || this.phase !== 'claim') return false;
        const mine = this.claims.find(x => x.seat === seat);
        return !!mine && mine.decision !== undefined && this.claims.some(x => x.decision === undefined);
      })(),
      myDecided: (() => {
        if (seat === null || this.phase !== 'claim') return null;
        const c = this.claims.find(x => x.seat === seat);
        if (!c || c.decision === undefined) return null;
        return c.decision === null ? 'pass' : c.decision.type;
      })(),
      players: this.players.map(p => ({
        seat: p.seat,
        handCount: p.hand.length,
        // 一局结束后给所有人亮牌；胡牌那家把胡的那张也摆进来，看得出是怎么成的牌
        hand: seat === p.seat || this.ended
          ? (this.ended && this.winner === p.seat && this.huCard >= 0 ? sortKinds([...p.hand, this.huCard]) : p.hand.slice())
          : undefined,
        // 偎：亮一张盖两张；提：亮一张盖三张；龙 / 碰 / 跑 / 吃：全亮
        // 偎：亮一张盖两张；提：亮一张盖三张；龙 / 碰 / 跑 / 吃：全亮。
        // 盖住的那几张连**牌号**也要一起盖掉 —— 号是公开发出去过的（比如摸牌时报过），
        // 留着就能反推出盖的是哪个字
        melds: p.melds.map(m => (m.hidden && seat !== p.seat)
          ? { ...m, cards: m.cards.map((c, i) => i === 0 ? c : -1), cids: m.cids?.map((v, i) => i === 0 ? v : -1) }
          : { ...m, cards: m.cards.slice(), cids: m.cids?.slice() }),
        discards: p.discards.slice(),
        discardSrc: p.discardSrc.slice(),
        discardCids: p.discardCids.slice(),
        tiCount: p.tiCount, paoCount: p.paoCount, longCount: p.longCount,
        noTake: p.noTake,   // 放跑之后本局不能再吃 / 碰：客户端要给个明白的提示
        violations: p.violations,        // 罚了几次（头像旁边标几个「罚」）
        declined: p.declinedHu.length,   // 弃过几次胡（「贪」）
      })),
    };
  }

  /** 把当前所有决策期限整体往后推（服务端切片播放期间，别让人还没看到就开始倒计时） */
  /** 【已弃用】整体往后推时限。现在时限在开窗口那一刻就按 `lag` 定死了，不再事后找补 ——
      留着这个方法只是为了老的回放 / 测试还能调它，正常流程不会再用。 */
  extendDeadlines(ms: number) {
    if (ms <= 0 || this.ended) return;
    if (this.deadline) this.deadline += ms;
    for (const c of this.claims) {
      if (c.fresh) { c.fresh = false; continue; }
      c.deadline += ms; if (c.fastUntil) c.fastUntil += ms; if (c.huUntil) c.huUntil += ms;
    }
  }

  optionsFor(seat: number | null): { options: ActionOption[]; deadline: number; span?: number; fastUntil?: number; fastSpan?: number; huUntil?: number; huSpan?: number } | null {
    if (seat === null || this.ended) return null;
    if (this.phase === 'drawer_decide' && seat === this.turn) return { options: this.drawerOptions, deadline: this.deadline, span: this.deadlineSpan };
    if (this.phase === 'claim') {
      const c = this.claims.find(x => x.seat === seat && x.decision === undefined);
      if (c) {
        // 胡牌按座位顺序（从出牌 / 摸牌那家往下传）轮着来：前面还有人能抢胡且没表态，
        // 就先别把我的"胡"按钮亮出来，免得点了也没用。等他放弃了自然轮到我。
        const tc = this.tableCard!;
        let options = this.huRobbed(seat) ? c.options.filter(o => o.type !== 'hu') : c.options;
        // 碰 / 跑 / 胡 的窗口过了：按钮收掉，只剩吃（如果还有吃的话）
        const fastGone = c.fastDone || (!!c.fastUntil && this.now() >= c.fastUntil);
        if (fastGone) options = options.filter(o => o.type === 'chi');
        if (!options.length) return null;
        const canPass = !(this.rules.mustHu && options.some(o => o.type === 'hu'));
        return {
          options: canPass ? [...options, { type: 'pass', card: tc.card }] : options,
          deadline: c.deadline,
          span: c.span ?? 0,
          // 快窗口不许画得比这条 claim 自己的到点还长：谁把 deadline 压短了（比如别人已经表态），
          // 客户端那圈也得跟着短，不然又是"圈还在转、牌却碰不了"
          fastUntil: fastGone ? 0 : Math.min(c.fastUntil ?? 0, c.deadline),
          fastSpan: fastGone ? 0 : (c.fastSpan ?? 0),
          huUntil: c.huUntil ? Math.min(c.huUntil, c.deadline) : 0,
          huSpan: c.huSpan ?? 0,
        };
      }
    }
    if (this.phase === 'discard' && seat === this.turn) return { options: [{ type: 'discard', card: -1 }], deadline: this.deadline, span: this.deadlineSpan };
    return null;
  }
}
