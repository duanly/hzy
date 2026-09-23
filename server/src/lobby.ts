import { randomInt } from 'node:crypto';
import { Room } from './room.ts';
import { MahjongRoom } from './mjroom.ts';
import type { DB } from './db.ts';
import type { TierInfo, LobbyVariant } from './protocol.ts';
import { getRules, type VariantId } from '../../packages/engine/src/index.ts';

export const TIERS: TierInfo[] = [
  { id: 'hh_1', name: '红黑·初级场', variant: 'hy_honghei', baseScore: 1, minPoints: 0, online: 0 },
  { id: 'hh_5', name: '红黑·中级场', variant: 'hy_honghei', baseScore: 5, minPoints: 200, online: 0 },
  { id: 'hh_20', name: '红黑·高级场', variant: 'hy_honghei', baseScore: 20, minPoints: 1000, online: 0 },
  { id: 'lh_1', name: '六胡抢·初级场', variant: 'hy_liuhuqiang', baseScore: 1, minPoints: 0, online: 0 },
  { id: 'lh_5', name: '六胡抢·中级场', variant: 'hy_liuhuqiang', baseScore: 5, minPoints: 200, online: 0 },
  { id: 'tl_1', name: '提龙·初级场', variant: 'ly_tilong', baseScore: 1, minPoints: 0, online: 0 },
  { id: 'tl_5', name: '提龙·中级场', variant: 'ly_tilong', baseScore: 5, minPoints: 200, online: 0 },
];

/** 大厅固定桌：每种玩法一批固定的桌子，进去就坐，不再每次新建房间。
 *  底分档位后台可改（暂时写在这儿）：红黑 / 提龙 各 8+8+4 桌，六胡抢暂不开放。 */
export const TABLE_PLAN: { variant: VariantId; prefix: string; name: string; open: boolean; tiers: { baseScore: number; count: number }[] }[] = [
  { variant: 'hy_honghei', prefix: 'HH', name: '衡阳红黑', open: true, tiers: [{ baseScore: 1, count: 8 }, { baseScore: 5, count: 8 }, { baseScore: 20, count: 4 }] },
  { variant: 'ly_tilong', prefix: 'TL', name: '耒阳提龙', open: true, tiers: [{ baseScore: 1, count: 8 }, { baseScore: 5, count: 8 }, { baseScore: 20, count: 4 }] },
  { variant: 'hy_liuhuqiang', prefix: 'LH', name: '衡阳六胡抢', open: false, tiers: [{ baseScore: 1, count: 10 }, { baseScore: 5, count: 10 }] },
];

/** 一组桌子（同一个玩法下的一个底分档）：读秒 / 自动开局 / 机器人思考都能单独给这一组配。
 *  留空（undefined）就跟着玩法那一层的默认值走。 */
export interface TierConfig {
  baseScore: number;
  count: number;
  turnSec?: number;      // 这一组的每步读秒；不填 = 用玩法默认
  autoNextSec?: number;  // 这一组一局结束到下一局；不填 = 用玩法默认
  botThink?: boolean;    // 这一组的机器人要不要装作在想（随机停一下）；不填 = 用玩法默认
  pauseEvery?: number;   // 这一组打满多少局歇一次；不填 = 用玩法默认（0 = 不歇）
}

/** 固定桌的可配置项（后台改，存在 settings 表里） */
export interface TableConfig {
  variant: VariantId;
  open: boolean;
  turnSec: number;       // 玩法默认：每步读秒
  autoNextSec: number;   // 玩法默认：一局结束到下一局
  botThink: boolean;     // 玩法默认：机器人思考停顿
  pauseEvery: number;    // 玩法默认：打满多少局歇一次（0 = 一直打下去）
  tiers: TierConfig[];
}

/** 这一组桌子实际吃到的配置：组里填了就用组里的，没填就用玩法那一层的 */
export function tierSettings(v: TableConfig, t: TierConfig) {
  return {
    turnSec: t.turnSec ?? v.turnSec,
    autoNextSec: t.autoNextSec ?? v.autoNextSec,
    botThink: t.botThink ?? v.botThink,
    pauseEvery: t.pauseEvery ?? v.pauseEvery,
  };
}

/** 大厅里两种房间并存：跑胡子的 Room 和红中麻将的 MahjongRoom。
    它们是**并列的两套**（见 mjroom.ts 开头），只在这儿和路由那儿碰面。 */
export type AnyRoom = Room | MahjongRoom;
/** 是不是麻将房 —— 路由里要分流的地方都用它判，别去比 cfg 里的字段 */
export function isMj(r: AnyRoom): r is MahjongRoom { return r instanceof MahjongRoom; }

export class Lobby {
  rooms = new Map<string, AnyRoom>();
  /** 只要跑胡子那些房 —— 大厅固定桌、场次、快速加入都只涉及跑胡子，
      麻将现在只有私人房。少了这个过滤，下面每一处都要写 instanceof。 */
  private phz(): Room[] { return [...this.rooms.values()].filter((r): r is Room => !isMj(r)); }
  private db: DB;
  constructor(db: DB) { this.db = db; this.ensureTables(); }

  /** 固定桌配置：后台改过就用后台的，没改过用默认方案 */
  tableConfig(): TableConfig[] {
    const saved = this.db.getSetting<TableConfig[] | null>('tables', null);
    return TABLE_PLAN.map(v => {
      const s = saved?.find(x => x.variant === v.variant);
      return {
        variant: v.variant, open: s?.open ?? v.open,
        turnSec: s?.turnSec ?? 20, autoNextSec: s?.autoNextSec ?? 7,
        botThink: s?.botThink ?? false,
        pauseEvery: s?.pauseEvery ?? 0,
        tiers: s?.tiers?.length ? s.tiers : v.tiers,
      };
    });
  }
  saveTableConfig(cfg: TableConfig[]) {
    const clean = this.tableConfig().map(cur => {
      const n = cfg.find(x => x.variant === cur.variant);
      if (!n) return cur;
      const sec = (x: unknown, lo: number, hi: number) => {
        const v0 = Math.floor(Number(x));
        return Number.isFinite(v0) && v0 > 0 ? Math.max(lo, Math.min(hi, v0)) : undefined;
      };
      return {
        variant: cur.variant,
        open: !!n.open,
        turnSec: sec(n.turnSec, 10, 120) ?? cur.turnSec,
        autoNextSec: sec(n.autoNextSec, 3, 120) ?? cur.autoNextSec,
        botThink: !!n.botThink,
        // 几局一歇：0 就是一直打下去（后台留空 / 填 0 都算 0）
        pauseEvery: Math.max(0, Math.min(999, Math.floor(Number(n.pauseEvery) || 0))),
        tiers: (n.tiers ?? cur.tiers).slice(0, 6).map(t => ({
          baseScore: Math.max(1, Math.min(1000, Math.floor(t.baseScore || 1))),
          count: Math.max(0, Math.min(40, Math.floor(t.count || 0))),
          // 这三项留空就是"跟玩法默认走"，别给它补成一个数，不然以后改默认值这一组就跟不动了
          turnSec: sec(t.turnSec, 10, 120),
          autoNextSec: sec(t.autoNextSec, 3, 120),
          botThink: t.botThink === undefined || t.botThink === null ? undefined : !!t.botThink,
          pauseEvery: t.pauseEvery === undefined || t.pauseEvery === null ? undefined
            : Math.max(0, Math.min(999, Math.floor(Number(t.pauseEvery) || 0))),
        })),
      };
    });
    this.db.setSetting('tables', clean);
    this.ensureTables(true);
    return clean;
  }

  /** 开服时（以及后台改配置之后）把固定桌建好 / 调整 */
  ensureTables(reconfigure = false) {
    const wanted = new Set<string>();
    for (const v of this.tableConfig()) {
      const plan = TABLE_PLAN.find(x => x.variant === v.variant)!;
      if (!v.open) continue;
      const rules = getRules(v.variant);
      let n = 0;
      for (const t of v.tiers) {
        // 这一组自己的读秒 / 自动开局 / 机器人思考（没单独配就跟玩法默认）
        const st = tierSettings(v, t);
        for (let i = 0; i < t.count; i++) {
          n++;
          const id = `${plan.prefix}${String(n).padStart(2, '0')}`;
          wanted.add(id);
          const name = `${plan.name.slice(-2)} ${String(n).padStart(2, '0')}`;
          const turnMs = st.turnSec * 1000;
          const ruleOverride = { timers: { ...rules.timers, drawerDecide: turnMs, claimChi: turnMs, discard: turnMs, claimPeng: Math.round(turnMs / 2) } };
          const got = this.rooms.get(id);
          // 固定桌只可能是跑胡子的（麻将现在只有私人房）；万一撞上同名的麻将房，当没有、重新建
          const exist = got && !isMj(got) ? got : undefined;
          if (exist) {
            if (!reconfigure) continue;
            // 改配置：底分 / 读秒 / 自动开局立刻生效（牌局进行中的那一桌下一局才变）
            exist.cfg.baseScore = t.baseScore;
            exist.cfg.name = name;
            exist.cfg.turnSec = st.turnSec;
            exist.cfg.autoNextMs = st.autoNextSec * 1000;
            exist.cfg.botThink = st.botThink;
            exist.cfg.pauseEvery = st.pauseEvery;
            exist.cfg.ruleOverride = ruleOverride;
            // 没在打牌就立刻换上新时限；正在打的那一局保持原样，下一局开局时自己会重算
            if (exist.status !== 'playing') exist.applyRules();
            exist.broadcast();
            continue;
          }
          const room = new Room({
            id, isPrivate: false, variant: v.variant, baseScore: t.baseScore, tier: v.variant,
            fixed: true, name, turnSec: st.turnSec, autoNextMs: st.autoNextSec * 1000,
            botThink: st.botThink, pauseEvery: st.pauseEvery, ruleOverride,
          }, this.db);
          this.register(room);
        }
      }
    }
    // 桌子数量调少了：把多出来的空桌撤掉（有人在打的留着）
    if (reconfigure) {
      for (const r of this.phz()) {
        const id = r.cfg.id;
        if (!r.cfg.fixed || wanted.has(id)) continue;
        if (r.status === 'playing' || r.humanCount() > 0) continue;
        r.close(true);
        this.rooms.delete(id);
      }
    }
  }

  /** 按玩法列出固定桌（前端大厅用） */
  tables(userId?: number | null): LobbyVariant[] {
    const cfg = this.tableConfig();
    return TABLE_PLAN.map(v => ({
      variant: v.variant, name: v.name, open: cfg.find(c => c.variant === v.variant)?.open ?? v.open,
      tables: this.phz().filter(r => r.cfg.fixed && r.cfg.variant === v.variant)
        .sort((a, b) => a.cfg.id.localeCompare(b.cfg.id))
        .map(r => ({
          id: r.cfg.id, name: r.cfg.name ?? r.cfg.id, baseScore: r.cfg.baseScore,
          variantName: r.rules.name, turnSec: r.cfg.turnSec ?? 20,
          seats: r.seats.length, humans: r.humanCount(), bots: r.seats.filter(s => s.isBot).length, status: r.status,
          mine: userId != null && r.seatOf(userId) >= 0,   // 我在这一桌有座位（托管中也算）：随时可以回去
        })),
    }));
  }

  tiers(): TierInfo[] {
    return TIERS.map(t => ({ ...t, online: this.phz().filter(r => r.cfg.tier === t.id).reduce((a, r) => a + r.humanCount(), 0) }));
  }

  /** 快速加入：找到该场次有空位且未开局的房间，否则新建 */
  quickJoin(tierId: string): Room | null {
    const tier = TIERS.find(t => t.id === tierId);
    if (!tier) return null;
    for (const r of this.phz()) {
      if (r.cfg.tier === tierId && r.status === 'waiting' && r.filledCount() < r.seats.length) return r;
    }
    const room = new Room({ id: 'L' + randomInt(100000, 999999), isPrivate: false, variant: tier.variant, baseScore: tier.baseScore, tier: tier.id, botFillDelayMs: 4000 }, this.db);
    this.register(room);
    return room;
  }

  createPrivate(hostId: number, variant: VariantId, baseScore: number, password = '',
                opt: { turnMs?: number; name?: string; autoNextMs?: number; swingCap?: number; pauseEvery?: number;
                       play?: import('./protocol.ts').PlayOpts } = {}): Room {
    let id: string;
    do { id = String(randomInt(100000, 999999)); } while (this.rooms.has(id));
    const turnMs = opt.turnMs;
    const ruleOverride = turnMs ? { timers: { ...getRules(variant).timers, drawerDecide: turnMs, claimChi: turnMs, discard: turnMs, claimPeng: Math.round(turnMs / 2) } } : undefined;
    const room = new Room({
      id, isPrivate: true, variant, baseScore, password, hostId, ruleOverride,
      name: opt.name, turnSec: turnMs ? Math.round(turnMs / 1000) : undefined,
      autoNextMs: opt.autoNextMs, swingCap: opt.swingCap, pauseEvery: opt.pauseEvery, play: opt.play,
    }, this.db);
    this.register(room);
    return room;
  }

  /** 开一间红中麻将的私人房 */
  createMahjong(hostId: number, baseScore: number, password = '',
                opt: { turnSec?: number; claimSec?: number; name?: string; autoNextMs?: number; botStrength?: number } = {}): MahjongRoom {
    let id: string;
    do { id = String(randomInt(100000, 999999)); } while (this.rooms.has(id));
    const room = new MahjongRoom({
      id, isPrivate: true, baseScore, password, hostId,
      name: opt.name, turnSec: opt.turnSec, claimSec: opt.claimSec,
      autoNextMs: opt.autoNextMs, botStrength: opt.botStrength,
    }, this.db);
    this.rooms.set(id, room);
    room.onClosed = r => this.rooms.delete(r.cfg.id);
    return room;
  }

  private register(room: Room) {
    this.rooms.set(room.cfg.id, room);
    room.onClosed = r => this.rooms.delete(r.cfg.id);
  }

  tick() {
    for (const r of this.rooms.values()) {
      try { r.tick(); } catch (e) { console.error('room tick error', r.cfg.id, e); }
      // 私人房 2 小时无活动自动关闭
      const fixed = !isMj(r) && r.cfg.fixed;
      if (!fixed && r.status !== 'closed' && Date.now() - r.lastActivity > 2 * 3600 * 1000) r.close();
    }
  }
}
