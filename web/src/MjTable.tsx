/**
 * 麻将牌桌 · 通用版
 *
 * 布局参考腾讯欢乐麻将（上海敲麻）：
 *  · 绿色桌布 + 暗织纹
 *  · 四家玩家信息卡（头像+名字+分数），各占一方
 *  · 中央：牌墙四面围起来，中间是「东南西北」+ 骰子 + 剩余张数
 *  · 弃牌区在牌墙内侧，四家各占一边
 *  · 自己的手牌沿底部铺开，下地牌在手牌内侧（靠桌子中央那侧）
 *  · 行动按钮在右侧/右下角
 *
 * 牌面暂时用 SVG，后面替换成图片只动 MjTile。
 */
import React, { useMemo } from 'react';
import { MjTile, mjName, HONG, type Tile } from './MjTile.tsx';

/** 倒计时环颜色：绿 → 黄 → 红 */
function ringColor(f: number) {
  const x = Math.max(0, Math.min(1, f));
  const hue = x > 0.4 ? 35 + ((x - 0.4) / 0.6) * (140 - 35) : 2 + (x / 0.4) * (35 - 2);
  const sat = 78 + (1 - x) * 12, light = 48 + (1 - x) * 6;
  return `hsl(${hue.toFixed(0)}, ${sat.toFixed(0)}%, ${light.toFixed(0)}%)`;
}

/** 圆形头像倒计时环（圆形头像用圆的 stroke-dasharray） */
function TurnRing({ frac, size = 40 }: { frac: number; size?: number }) {
  const pad = 2;
  const r = (size - pad * 2) / 2;
  const cx = size / 2, cy = size / 2;
  const len = 2 * Math.PI * r;
  return (
    <svg className="mj-turn-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(0,0,0,.3)" strokeWidth="3" />
      <circle cx={cx} cy={cy} r={r} fill="none"
        stroke={ringColor(frac)} strokeWidth="3" strokeLinecap="round"
        strokeDasharray={len} strokeDashoffset={len * (1 - frac)}
        transform={`rotate(-90 ${cx} ${cy})`} />
    </svg>
  );
}

export interface MjSeatView {
  seat: number;
  hand: Tile[] | null;
  handCount: number;
  melds: { type: 'peng' | 'gang'; gang?: 'ming' | 'an' | 'bu'; tile: Tile }[];
  discards: Tile[];
  name: string;
  total: number;
  isDealer?: boolean;
  isTurn?: boolean;
  delay?: number;
  fouls?: number;
  huTile?: Tile;
}

export interface MjTableView {
  players: MjSeatView[];
  mySeat: number;
  wallLeft: number;
  table: { tile: Tile; from: number } | null;
  ma: Tile | null;
  roundNo: number;
  baseScore: number;
  dealer: number;
}

/**
 * 牌墙：两张一叠码在四边。
 * 112 张 = 56 墩，四面各 14 墩。按剩余张数算出还剩几墩，平摊到四边。
 */
function Wall({ left }: { left: number }) {
  const stacks = Math.ceil(left / 2);
  const per = [0, 1, 2, 3].map(i => Math.floor(stacks / 4) + (i < stacks % 4 ? 1 : 0));
  const sides = ['top', 'right', 'bottom', 'left'] as const;
  return (
    <>
      {sides.map((side, i) => (
        <div key={side} className={`mj-wall mj-wall-${side}`}>
          {Array.from({ length: per[i] }, (_, k) => (
            <span key={k} className="mj-stack">
              <i className="mj-stack-b" />
              <i className="mj-stack-t" />
            </span>
          ))}
        </div>
      ))}
    </>
  );
}

/** 弃牌区：四家各占一边，各排自己的（照欢乐麻将摆法） */
function DiscardPool({ lanes }: { lanes: Tile[][] }) {
  // lanes: 0=我(下) 1=下家(右) 2=对家(上) 3=上家(左)
  return (
    <div className="mj-discard-area">
      <div className="mj-discard-lane mj-discard-top">
        {lanes[2].map((t, i) => <MjTile key={i} tile={t} size="xs" />)}
      </div>
      <div className="mj-discard-lane mj-discard-bottom">
        {lanes[0].map((t, i) => <MjTile key={i} tile={t} size="xs" />)}
      </div>
      <div className="mj-discard-lane mj-discard-left">
        {lanes[3].map((t, i) => <MjTile key={i} tile={t} size="xs" />)}
      </div>
      <div className="mj-discard-lane mj-discard-right">
        {lanes[1].map((t, i) => <MjTile key={i} tile={t} size="xs" />)}
      </div>
    </div>
  );
}

/** 状态标签：杠次数 / 延时卡 / 罚分 */
function MjTags({ p }: { p: MjSeatView }) {
  const gangs = p.melds.filter(m => m.type === 'gang').length;
  const items: React.ReactNode[] = [];
  const add = (key: string, cls: string, text: string, n: number) => {
    if (n <= 0) return;
    items.push(<b key={key} className={`st ${cls}`}>{text}{n > 1 ? n : ''}</b>);
  };
  add('g', 'st-gang', '杠', gangs);
  add('t', 'st-delay', '延', p.delay ?? 0);
  add('f', 'st-foul', '罚', p.fouls ?? 0);
  if (!items.length) return null;
  return <div className="mj-tags">{items}</div>;
}

/** 玩家信息卡 */
function PlayerCard({ p, ringFrac }: { p: MjSeatView; ringFrac?: number }) {
  return (
    <div className="mj-player">
      <div style={{ position: 'relative' }}>
        <div className="mj-avatar">{p.name.slice(0, 2)}</div>
        {p.isDealer && <span className="mj-dealer-badge">庄</span>}
        {p.isTurn && ringFrac !== undefined && ringFrac > 0 && <TurnRing frac={ringFrac} size={40} />}
      </div>
      <div className="mj-player-info">
        <span className="mj-player-name">{p.name}</span>
        <span className={`mj-player-score ${p.total > 0 ? 'pos' : p.total < 0 ? 'neg' : ''}`}>
          {p.total > 0 ? `+${p.total}` : p.total}
        </span>
        <MjTags p={p} />
      </div>
    </div>
  );
}

/**
 * 一方玩家（手牌 + 下地牌）
 * rel: 0=我(下) 1=下家(右) 2=对家(上) 3=上家(左)
 */
function SeatHand({ p, rel, mine, picked, ringFrac, onTilePointerDown }: {
  p: MjSeatView; rel: 0 | 1 | 2 | 3; mine: boolean;
  picked?: number; ringFrac?: number;
  onTilePointerDown?: (e: React.PointerEvent, t: Tile, i: number) => void;
}) {
  const pos = ['bottom', 'right', 'top', 'left'][rel];
  const size: 'sm' | 'md' = mine ? 'md' : 'sm';
  const isSide = rel === 1 || rel === 3; // 左右两家

  return (
    <div className={`mj-seat mj-seat-${pos} ${p.isTurn ? 'mj-turn' : ''}`}>
      <PlayerCard p={p} ringFrac={ringFrac} />

      <div className="mj-row" style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
        {/* 手牌 */}
        <div className="mj-hand">
          {mine ? (
            p.hand!.map((t, i) => (
              <MjTile key={i} tile={t} size={size}
                selected={picked === i}
                onPointerDown={onTilePointerDown ? (e) => onTilePointerDown(e, t, i) : undefined}
                className={[
                  i === p.hand!.length - 1 && p.hand!.length % 3 === 2 ? 'mj-drawn' : undefined,
                  p.huTile !== undefined && t === p.huTile ? 'mj-hu' : undefined,
                ].filter(Boolean).join(' ') || undefined} />
            ))
          ) : isSide ? (
            /* 左右两家：只露一张背面 + 张数 */
            <span className="mj-hand-count">
              <MjTile back size={size} />
              <i>{p.handCount}</i>
            </span>
          ) : (
            /* 对家：背面横排 */
            Array.from({ length: p.handCount }, (_, i) => <MjTile key={i} back size={size} />)
          )}
        </div>

        {/* 下地牌（碰/杠） */}
        {p.melds.length > 0 && (
          <div className="mj-melds">
            {p.melds.map((m, i) => (
              <span key={i} className={`mj-meld${m.gang === 'an' ? ' mj-angang' : ''}`}>
                {m.type === 'peng'
                  ? [0, 1, 2].map(k => <MjTile key={k} tile={m.tile} size={size} />)
                  : [0, 1, 2, 3].map(k => (
                    <MjTile key={k} tile={m.tile} size={size}
                      back={m.gang === 'an' && !mine} />
                  ))}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 中心装饰：东南西北 + 风位 + 剩余张数 */
function CenterDeco({ wallLeft, dealerWind }: { wallLeft: number; dealerWind: string }) {
  return (
    <div className="mj-center-deco">
      <div className="mj-wind-ring">
        <span className="w-n">北</span>
        <span className="w-s">南</span>
        <span className="w-e">东</span>
        <span className="w-w">西</span>
      </div>
      <div className="mj-center-wind">{dealerWind}</div>
      <div className="mj-center-count">剩 <b>{wallLeft}</b> 张</div>
    </div>
  );
}

const WIND_NAMES = ['东', '南', '西', '北'];

export function MjTable({ v, picked, ringFrac, onTilePointerDown }: {
  v: MjTableView; picked?: number; ringFrac?: number;
  onTilePointerDown?: (e: React.PointerEvent, t: Tile, i: number) => void;
}) {
  // 相对座位：0=我(下) 1=下家(右) 2=对家(上) 3=上家(左)
  const rel = (seat: number) => ((seat - v.mySeat + 4) % 4) as 0 | 1 | 2 | 3;

  // 弃牌按相对座位分四路
  const lanes = useMemo(() => {
    const lanes: Tile[][] = [[], [], [], []];
    for (const p of v.players) lanes[rel(p.seat)] = p.discards.slice();
    return lanes;
  }, [v.players]);

  // 庄家座位号（从 players 里找 isDealer 的）
  const dealerSeat = v.players.find(p => p.isDealer)?.seat ?? 0;
  // 庄家的风位字（东=0 对应庄家）—— 显示在中心
  const dealerWind = WIND_NAMES[(dealerSeat - v.mySeat + 4) % 4] || '东';

  return (
    <div className="mj-table">
      {/* 中央区域：牌墙 + 弃牌 + 中心装饰 */}
      <div className="mj-center">
        <Wall left={v.wallLeft} />
        <DiscardPool lanes={lanes} />
        <CenterDeco wallLeft={v.wallLeft} dealerWind={dealerWind} />

        {/* 刚打出来、还在等人要的那张：从弃牌堆拎出来亮一下 */}
        {v.table && (
          <div className="mj-just-discard">
            <MjTile tile={v.table.tile} size="sm" />
          </div>
        )}

        {/* 翻出来的马 */}
        {v.ma !== null && (
          <div className="mj-ma-display">
            <div className="mj-ma-label">马</div>
            <MjTile tile={v.ma} size="sm" />
          </div>
        )}
      </div>

      {/* 四方玩家 */}
      {v.players.map(p => (
        <SeatHand key={p.seat} p={p}
          rel={rel(p.seat)}
          mine={p.seat === v.mySeat}
          picked={p.seat === v.mySeat ? picked : undefined}
          ringFrac={p.isTurn ? ringFrac : undefined}
          onTilePointerDown={p.seat === v.mySeat ? onTilePointerDown : undefined} />
      ))}
    </div>
  );
}
