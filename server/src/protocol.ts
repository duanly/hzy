/** 客户端 ↔ 服务端 WebSocket 协议（前后端共用类型） */
import type { VariantId, ActionType, Kind, GameEvent } from '../../packages/engine/src/index.ts';

/* 红中麻将是**另一套引擎**（packages/mahjong），它的玩法 id 不在字牌那个 VariantId 里。
   协议层要同时装得下两边，所以这儿放宽一档。
   注意：拿 variant 去查字牌规则表（RULES[...]）的地方要先判一下，别直接索引。 */
export const MJ_VARIANT_ID = 'mj_hongzhong';
export type AnyVariantId = VariantId | typeof MJ_VARIANT_ID;

export interface PublicUser {
  id: number;
  code?: string;          // 账号 ID：7~9 位字母，给玩家看的那个
  nickname: string;
  nickLeft?: number;      // 昵称还能改几次
  avatar: string;
  kind: 'guest' | 'user' | 'wechat' | 'bot';
  vip: boolean;
  points: number;
}

/** 开房时能挑的几条玩法开关。大厅固定桌一概不传 —— 全按玩法默认（全开 + 新牌轮流发） */
export interface PlayOpts {
  /** 耒阳：能不能无息胡（一点胡息都没有也能胡，按 21 胡算） */
  noXiHu?: boolean;
  /** 耒阳：举手胡（闲家一张没进就胡）翻不翻倍 */
  raiseHand?: boolean;
  /** 衡阳：算不算红黑（大红 / 小红 / 全黑 / 一点红） */
  redBlack?: boolean;
  /** 衡阳：胡的那个字有几张就加几敦 */
  huCardDun?: boolean;
  /** 发牌：'fresh' 新牌 + 轮流派牌；'big' 上一局的牌 + 切牌（大牌玩法） */
  deal?: 'fresh' | 'big';
}

export interface SeatView {
  seat: number;
  user: PublicUser | null;
  ready: boolean;
  online: boolean;
  isBot: boolean;
  kickable?: boolean;   // 真机器人（负数 id）：可以被请走；托管中的真人座位不行
  auto?: boolean;       // 真人超时了、暂时由机器人替他打（头像上挂个机器人标；他一动手就解除）
  total: number;        // 本房间累计输赢
}

export interface RoomView {
  id: string;
  isPrivate: boolean;
  variant: AnyVariantId;
  variantName: string;
  baseScore: number;
  hostId: number | null;
  status: 'waiting' | 'playing' | 'paused' | 'closed';
  seats: SeatView[];
  roundNo: number;
  mySeat: number | null;
  game: any | null;     // Game.view(seat) 结果
  ledger: LedgerEntry[];      // 只有最近 20 条（全量在服务端，客户端用不着）
  /** 之前几批的总计：座位换过人，老账封存成一行一行（当下这本账永远只有桌上这三个人） */
  batches?: LedgerBatch[];
  /** 当下这一段从第几局开始（这一局**之后**的都算当下这一段） */
  batchFrom?: number;
  /** 离桌的人各自带走的账：回来了就从这儿提出来接着算 */
  gone?: { id: number; name: string; total: number }[];
  ledgerCount?: number;       // 一共打了多少局
  tier?: string;
  name?: string;        // 桌名 / 房名
  pausedReason?: string | null;   // 封顶暂停的原因（前端挂红色横幅）
  nextRoundAt?: number | null;    // 开局 / 下一局的倒计时终点（第一局之前 game 还是 null，所以放在外面一份）
  nextRoundIn?: number | null;    // 同一个倒计时，换成"还剩多少毫秒"——手机上的钟跟服务器差几分钟也不影响
  spectating?: boolean;           // 我是房主、正在观战（只看得到下地牌和弃牌）
  /** 我能不能点「继续」：房主，或者桌长（桌上最早坐下的那个真人） */
  canResume?: boolean;
  config?: { turnSec: number; autoNextSec: number; swingCap: number; pauseEvery?: number; play?: PlayOpts };
  myRooms?: never;
}

/** 大厅：一种玩法下的固定桌 */
export interface LobbyTable { id: string; name: string; baseScore: number; variantName?: string; turnSec?: number; seats: number; humans: number; bots: number; status: 'waiting' | 'playing' | 'paused' | 'closed'; mine?: boolean }
/** 我开的私人房（大厅里给房主用：进去打 / 观战） */
export interface HostedRoom { id: string; name: string; variant: AnyVariantId; status: string; players: number; seats: number; seated: boolean }
export interface LobbyVariant { variant: VariantId; name: string; open: boolean; tables: LobbyTable[] }

export interface LedgerEntry {
  round: number;
  variant: AnyVariantId;
  winner: number | null;     // userId
  deltas: Record<number, number>; // userId → delta
  time: number;
  hu?: HuRecord | null;      // 胡牌详情（流局为 null）：输赢表里点一局就能回看
  seatNames?: string[];      // 该局各座位的昵称，配合 hu 显示
  reveal?: RoundReveal;      // 该局结束时的亮牌：各家下地牌、手里剩的牌、没翻出来的公共牌
  declines?: { seat: number; card: number; unit: number }[];   // 耒阳：本局谁弃了胡（哪张牌、每家多少分）
  tilong?: number[];    // 本局各家的提龙即时分（按座位）
  subs?: { seat: number; names: string[] }[];   // 本局中途换过人的位子：按先后列出坐过的人
  penalty?: number[];   // 本局各家的违规罚分（按座位）
  /* 这一局涉及的每个人当时叫什么（userId → 昵称）。
     纪录表的列头、结算详情的人名都先看它 —— 房间里的在线名单是会变的：
     机器人离桌、真人退出，名字就从名单里删掉了，事后再去查只剩一串 userId。
     记在这一局自己身上，谁走了都不影响回头看。 */
  names?: Record<number, string>;
}

/** 封存的一批账：座位换过人之后，上一批自成一段 —— 自己的表头、自己的那几局、自己的小计。
    纪录表是**竖着往下长**的：最新的一段在最上面，往下是第 1 批、第 2 批…… */
export interface LedgerBatch {
  no: number;
  label: string;                      // 「第1批」「第2批」…
  seats: number[];                    // 这一段的表头：当时坐着的那几位（按座位）
  names: Record<number, string>;      // userId → 当时的昵称（人走了名单里就查不到了）
  subtotal: Record<number, number>;   // 这一段自己打下来的输赢（不含之前结转的）
  from: number; until: number;        // 局号范围（含两端）
  at: number;
}

/** 一局结束时的亮牌快照（输赢表里回看那一局用） */
export interface RoundReveal {
  hands: number[][];
  melds: any[][];
  pileRest: number[];
  winner: number | null;    // 座位号
}

/** 输赢表里回看用的胡牌事件快照 */
export interface HuRecord {
  seat: number;
  card: number;
  /* 胡的**是哪一张**（牌号），不是"哪个字"。亮牌和详情里那个「胡」字按它来标。
     老纪录没有这个字段，客户端会退回按牌面找 —— 会标错，但总比一个不标强。
     偎起胡 / 提龙胡那种没有具体某一张，也是缺着的。 */
  cid?: number;
  ziMo: boolean;
  fromSeat: number;
  detail: any;
}

export interface ProfileView {
  user: PublicUser;
  games: number; wins: number; winRate: number;
  hu: number; zimo: number; dianpao: number; ti: number; pao: number; violations: number;
  bigHu: number;       // 大胡（有翻倍的那种）局数
  maxXi: number;       // 最高胡息
  maxMul: number;      // 最高倍率（当局最高倍数）
  conduct: number;     // 牌品 0..100（暂时留着，不显示）
}

export type ClientMsg =
  | { type: 'auth'; token: string; deviceId?: string }   // deviceId 只是"这次从哪台机器进来的"，不改绑定
  | { type: 'lobby.list' }
  | { type: 'lobby.join'; tier: string }
  | { type: 'lobby.tables' }                        // 大厅：按玩法列出固定桌
  | { type: 'room.bots'; add: boolean; seat?: number }   // seat = 只补这一个空位（点空位请机器人）
  | { type: 'room.kick'; seat: number }             // 桌上真人：一键请机器人 / 把机器人请出去
  /* game 不填 = 跑胡子（老客户端就是这么发的）；填 'mahjong' 就开红中麻将的房。
     麻将没有 variant 这一说，服务端会忽略它带上来的那个值。 */
  | { type: 'room.create'; game?: 'phz' | 'mahjong'; variant: VariantId; baseScore: number; password: string; turnMs?: number;
      name?: string; autoNextSec?: number; swingCap?: number; pauseEvery?: number; play?: PlayOpts }
  | { type: 'room.spectate'; roomId: string }      // 房主观战（不坐下）
  | { type: 'room.resume' }                        // 房主解除封顶暂停
  | { type: 'room.abort' }                         // 房主作废当前这一局
  | { type: 'room.join'; roomId: string; password?: string }
  /* stand = **起立离开**：明说了不再回这一桌（正在打的那一局仍由机器人替他打完，账照算）。
     不带这个字段就是"暂时走开"，跟断线一个待遇，座位留着随时回来。 */
  | { type: 'room.leave'; stand?: boolean }
  | { type: 'room.ready'; ready: boolean }
  | { type: 'room.start' }
  | { type: 'room.end' }            // 房主解散并结算
  | { type: 'room.state' }
  /* tile 是麻将那边用的（打哪张、杠哪张）；跑胡子走 card/combo/lay。
     两种玩法共用这一条消息，服务端按房间类型挑字段。 */
  | { type: 'game.act'; action: ActionType; card?: Kind; combo?: Kind[]; lay?: number; tile?: number }
  | { type: 'seat.wake' }                          // 我回来了：解除"机器人替我打"（点按钮、手动理牌都算）
  | { type: 'chat'; text: string }
  | { type: 'voice'; data: string; mime: string; durationMs: number }
  | { type: 'profile.get'; userId: number }
  | { type: 'ping'; t?: number; rtt?: number };

export type ServerMsg =
  | { type: 'auth.ok'; user: PublicUser }
  | { type: 'auth.fail'; reason: string }
  | { type: 'lobby.list'; tiers: TierInfo[]; resume?: string }   // resume：中途退出、机器人托管中的那一桌房号
  | { type: 'lobby.tables'; variants: LobbyVariant[]; resume?: string; resumeName?: string; hosted?: HostedRoom[] }
  | { type: 'room.created'; roomId: string; name: string }   // 房开好了（房主没进去，页面上问他下一步）
  | { type: 'room.state'; room: RoomView }
  | { type: 'room.left' }
  | { type: 'room.closed'; ledger: LedgerEntry[]; totals: { user: PublicUser; total: number }[] }
  | { type: 'game.events'; events: GameEvent[]; room: RoomView }
  | { type: 'chat'; from: PublicUser; text: string; time: number }
  | { type: 'voice'; from: PublicUser; data: string; mime: string; durationMs: number }
  | { type: 'profile'; profile: ProfileView }
  | { type: 'error'; message: string }
  | { type: 'pong'; t?: number; now?: number };

export interface TierInfo {
  id: string;
  name: string;
  variant: VariantId;
  baseScore: number;
  minPoints: number;
  online: number;
}
