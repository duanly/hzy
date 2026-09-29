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
import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  /** 刚摸上来那张：自己看得到牌面（Tile），别人只知道有没有（true/null），UI 上单独放在最右边 */
  drawn: Tile | true | null;
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

/** 弃牌区：四家各占一边，8张一排 */
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

/** 玩家信息卡（倒计时环移到中心圆圈，头像只保留发光） */
function PlayerCard({ p }: { p: MjSeatView }) {
  return (
    <div className="mj-player">
      <div style={{ position: 'relative' }}>
        <div className="mj-avatar">{p.name.slice(0, 2)}</div>
        {p.isDealer && <span className="mj-dealer-badge">庄</span>}
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
 * 一方玩家（头像 + 手牌 + 下地牌）
 * rel: 0=我(下) 1=下家(右) 2=对家(上) 3=上家(左)
 *
 * 布局（以底部我家为基准，逆时针旋转 90° 到下一家）：
 *   [头像]  [手牌← →下地牌]
 *   - 头像靠边线（距1.5张牌距离）
 *   - 手牌从靠近头像那边码起
 *   - 下地牌从对侧码起（从右往左）
 */
function SeatHand({ p, rel, mine, picked, onTilePointerDown }: {
  p: MjSeatView; rel: 0 | 1 | 2 | 3; mine: boolean;
  picked?: number;
  onTilePointerDown?: (e: React.PointerEvent, t: Tile, i: number) => void;
}) {
  const pos = ['bottom', 'right', 'top', 'left'][rel];
  const size: 'sm' | 'md' = mine ? 'md' : 'sm';

  const hasDrawn = p.drawn !== null && p.drawn !== undefined;
  // 基础手牌数（去掉刚摸的那张）
  const baseCount = hasDrawn ? p.handCount - 1 : p.handCount;

  const handEl = mine ? (
    <div className="mj-hand">
      {p.hand!.map((t, i) => {
        // 最后一张是刚摸的：加上 mj-drawn 类（前面空一张牌距离）
        const isDrawn = hasDrawn && i === p.hand!.length - 1;
        return (
          <MjTile key={i} tile={t} size={size}
            selected={picked === i}
            onPointerDown={onTilePointerDown ? (e) => onTilePointerDown(e, t, i) : undefined}
            className={[
              isDrawn ? 'mj-drawn' : undefined,
              p.huTile !== undefined && t === p.huTile ? 'mj-hu' : undefined,
            ].filter(Boolean).join(' ') || undefined} />
        );
      })}
    </div>
  ) : (
    <div className="mj-hand">
      {/* baseCount 张牌背（正常手牌） */}
      {Array.from({ length: baseCount }, (_, i) => (
        <MjTile key={`b${i}`} back size={size} />
      ))}
      {/* 刚摸的那张：单独隔开，牌背 */}
      {hasDrawn && (
        <MjTile key="d" back size={size} className="mj-drawn" />
      )}
    </div>
  );

  const meldsEl = p.melds.length > 0 && (
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
  );

  return (
    <div className={`mj-seat mj-seat-${pos} ${p.isTurn ? 'mj-turn' : ''}`}>
      <div className="mj-seat-inner">
        {/* 头像：靠边线 */}
        <div className="mj-player-wrap">
          <PlayerCard p={p} />
        </div>

        {/* 手牌：居中 */}
        <div className="mj-hand-wrap">
          {handEl}
        </div>

        {/* 下地牌：靠另一侧 */}
        <div className="mj-melds-wrap">
          {meldsEl}
        </div>
      </div>
    </div>
  );
}

/** 轮到谁的指针：跑胡子同款 —— 花瓣底座+尖针 */
function TurnPointer({ angle, color }: { angle: number; color: string }) {
  const petals = [0, 72, 144, 216, 288];
  return (
    <svg className="mj-turn-pointer" width="26" height="40" viewBox="0 0 22 34"
      style={{
        filter: `drop-shadow(0 0 5px ${color})`,
        transform: `translate(-50%, -50%) rotate(${angle}deg) translateY(-42px)`,
      }}>
      {/* 针 */}
      <path d="M 11 11 L 13.2 26 L 8.8 26 Z" fill={color} />
      <circle cx="11" cy="11" r="2.4" fill={color} />
      {/* 花座 */}
      {petals.map(a => (
        <circle key={a} r="2.6" fill={color} opacity="0.92"
          cx={11 + Math.sin(a * Math.PI / 180) * 4.2}
          cy={28 - Math.cos(a * Math.PI / 180) * 4.2} />
      ))}
      {/* 底座：正好落在圆环上的那个点 */}
      <circle cx="11" cy="28" r="3.4" fill="#fff" stroke={color} strokeWidth="1.6" />
    </svg>
  );
}

/**
 * 中心装饰：倒计时环 + 指针（跑胡子款）+ 剩余张数 + 风位字
 *
 * rel: 0=bottom(我) 1=right 2=top 3=left
 * 指针角度（从 12 点顺时针）：bottom→180° right→90° top→0° left→270°
 * 环从指针处逆时针走，所以先镜像再转，起点落在指针上。
 */
function CenterDeco({ wallLeft, currentRel, ringFrac }: {
  wallLeft: number; currentRel: 0 | 1 | 2 | 3; ringFrac?: number;
}) {
  const pointerDeg = [180, 90, 0, 270][currentRel];
  // 环的旋转：让起点（3点钟方向）转到指针位置，再镜像（-1 scaleX）让它逆时针走
  const ringSpin = pointerDeg - 90;  // -90 是因为 stroke 默认从 3 点方向开始

  const size = 100;
  const cx = size / 2, cy = size / 2;
  const r = 33;  // 跟跑胡子一样的半径比例
  const len = 2 * Math.PI * r;
  const frac = ringFrac ?? 1;
  const color = ringColor(frac);

  return (
    <div className="mj-center-deco">
      {/* 风位字：东南西北环绕 */}
      <div className="mj-wind-ring">
        <span className="w-n">北</span>
        <span className="w-s">南</span>
        <span className="w-e">东</span>
        <span className="w-w">西</span>
      </div>

      {/* 倒计时环：跑胡子同款，细线贴着环走 */}
      <svg className="mj-center-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`}
        style={{ transform: `rotate(${ringSpin}deg) scaleX(-1)` }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,.13)" strokeWidth="3" />
        <circle cx={cx} cy={cy} r={r} fill="none"
          stroke={color} strokeWidth="3" strokeLinecap="round"
          strokeDasharray={len} strokeDashoffset={len * (1 - frac)} />
      </svg>

      {/* 指针：指向当前玩家 */}
      <TurnPointer angle={pointerDeg} color={color} />

      {/* 剩余张数（跑胡子 deck-head 同款） */}
      <div className="mj-center-count">
        <span>{wallLeft}</span>
      </div>
    </div>
  );
}

export function MjTable({ v, picked, ringFrac, onTilePointerDown,
  onBack, onSettings, onHistory, onRules,
}: {
  v: MjTableView; picked?: number; ringFrac?: number;
  onTilePointerDown?: (e: React.PointerEvent, t: Tile, i: number) => void;
  onBack?: () => void;
  onSettings?: () => void;
  onHistory?: () => void;
  onRules?: () => void;
}) {
  // 相对座位：0=我(下) 1=下家(右) 2=对家(上) 3=上家(左)
  const rel = (seat: number) => ((seat - v.mySeat + 4) % 4) as 0 | 1 | 2 | 3;

  // 弃牌按相对座位分四路
  const lanes = useMemo(() => {
    const lanes: Tile[][] = [[], [], [], []];
    for (const p of v.players) lanes[rel(p.seat)] = p.discards.slice();
    return lanes;
  }, [v.players]);

  // 当前轮到的玩家（相对位置）
  const currentSeat = v.players.find(p => p.isTurn)?.seat ?? v.mySeat;
  const currentRel = rel(currentSeat);

  // 明牌来自哪一家（相对位置 → 方位词）
  const discardFromRel = v.table ? rel(v.table.from) : -1;
  const discardFromPos = ['bottom', 'right', 'top', 'left'][discardFromRel] || '';

  // 亮牌飞行动画：table 从有到无时，保留一会儿播放缩小+淡出动画，再飞入弃牌区
  const [ghostTile, setGhostTile] = useState<{ tile: Tile; from: number } | null>(null);
  const [ghostFalling, setGhostFalling] = useState(false);
  const prevTableRef = useRef<{ tile: Tile; from: number } | null>(null);
  useEffect(() => {
    const cur = v.table ? { tile: v.table.tile, from: v.table.from } : null;
    const prev = prevTableRef.current;
    if (cur) {
      // 新的一张亮牌出现了
      setGhostTile(cur);
      setGhostFalling(false);
    } else if (prev && !cur) {
      // 亮牌消失了 → 播放飞行动画
      setGhostTile(prev);
      setGhostFalling(true);
      const t = setTimeout(() => {
        setGhostTile(null);
        setGhostFalling(false);
      }, 350);
      return () => clearTimeout(t);
    }
    prevTableRef.current = cur;
  }, [v.table?.tile, v.table?.from]);
  const ghostRel = ghostTile ? rel(ghostTile.from) : -1;
  const ghostPos = ['bottom', 'right', 'top', 'left'][ghostRel] || '';

  return (
    <div className="mj-table">
      {/* 顶栏：左返回 / 中房间信息 / 右设置+记录+玩法 */}
      <div className="mj-topbar">
        <div className="mj-tb-left">
          {onBack && <button className="mj-tb-btn" title="返回" onClick={onBack}>
            <span style={{ fontSize: 22, lineHeight: 1 }}>‹‹</span>
          </button>}
        </div>
        <div className="mj-tb-center">
          <span className="mj-tb-room">第 {v.roundNo} 局 · 底分 {v.baseScore}</span>
        </div>
        <div className="mj-tb-right">
          {onSettings && <button className="mj-tb-btn" title="设置" onClick={onSettings}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
              strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3.2" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 9v-.09a1.65 1.65 0 0 0 1.51-1H9a2 2 0 0 1 0-4h-.09A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0-1.51 1H15a2 2 0 0 1 0 4h.09a1.65 1.65 0 0 0 1.51 1Z" />
            </svg>
          </button>}
          {onHistory && <button className="mj-tb-btn" title="牌局记录" onClick={onHistory}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
              strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
              <path d="M3.5 9h17M3.5 14.5h17M9.5 9v11M15 9v11" />
            </svg>
          </button>}
          {onRules && <button className="mj-tb-btn" title="玩法说明" onClick={onRules}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
              strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M9.3 9.2a2.8 2.8 0 0 1 5.4.9c0 1.9-2.7 2.1-2.7 4" />
              <circle cx="12" cy="17.4" r="1.05" fill="currentColor" stroke="none" />
            </svg>
          </button>}
        </div>
      </div>

      {/* 中央区域：弃牌 + 中心装饰（倒计时环+箭头+剩余张数） */}
      <div className="mj-center">
        <DiscardPool lanes={lanes} />
        <CenterDeco wallLeft={v.wallLeft} currentRel={currentRel} ringFrac={ringFrac} />

        {/* 亮牌区：刚打出来的牌先亮在风位字外侧（大牌），没人要再飞入弃牌区 */}
        {ghostTile && (
          <div className={`mj-just-discard mj-from-${ghostPos} ${ghostFalling ? 'mj-falling' : ''}`}>
            <MjTile tile={ghostTile.tile} size="sm" />
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
          onTilePointerDown={p.seat === v.mySeat ? onTilePointerDown : undefined} />
      ))}
    </div>
  );
}
