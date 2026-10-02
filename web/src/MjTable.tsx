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
import { sayDraw } from './mjvoice.ts';
import { cue } from './voice.ts';

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
  handIds: number[] | null;
  handCount: number;
  /** 刚摸上来那张：自己看得到牌面（Tile），别人只知道有没有（true/null） */
  drawn: Tile | true | null;
  /** 刚摸上来那张的唯一 id（只有自己有），用于准确定位哪一张 */
  drawnId: number | null;
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
  dice: [number, number];
  phase: 'init' | 'discard' | 'claim' | 'ended';
  roundNo: number;
  baseScore: number;
  dealer: number;
  nextRoundAt: number | null;
  serverNow: number;
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

/** 玩家信息卡：头像在最边上，昵称直接显示在头像里（最多4字），分数在头像下方
 *  非自己：手牌张数也显示在头像旁边（跟头像连在一起）
 */
function PlayerCard({ p, justDrew, showHandCount }: {
  p: MjSeatView; justDrew?: boolean; showHandCount?: boolean;
}) {
  return (
    <div className="mj-player">
      <div className="mj-avatar-row">
        <div style={{ position: 'relative' }} className={justDrew ? 'mj-avatar-glow' : ''}>
          <div className="mj-avatar">
            {p.name.slice(0, 2)}
            {showHandCount && (
              <span className={`mj-hand-count-avatar${justDrew ? ' mj-just-drew' : ''}`}>
                {p.handCount}
              </span>
            )}
          </div>
          {p.isDealer && <span className="mj-dealer-badge">庄</span>}
        </div>
      </div>
      <MjTags p={p} />
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
function SeatHand({ p, rel, mine, picked, onTilePointerDown, bubbles = [], drawPhase }: {
  p: MjSeatView; rel: 0 | 1 | 2 | 3; mine: boolean;
  picked?: number;
  onTilePointerDown?: (e: React.PointerEvent, t: Tile, i: number) => void;
  bubbles?: { id: number; seat: number; text: string; ms?: number }[];
  drawPhase?: 'flying' | 'landing';
}) {
  const pos = ['bottom', 'right', 'top', 'left'][rel];
  const size: 'sm' | 'ml' = mine ? 'ml' : 'sm';

  const hasDrawn = p.drawn !== null && p.drawn !== undefined;

  // 用 handIds 里的 drawnId 判断哪一张是刚摸的（同面值多张时能准确定位）
  const drawnIdx = mine && p.drawnId !== null && p.handIds
    ? p.handIds.indexOf(p.drawnId) : -1;

  const handEl = mine ? (
    <div className="mj-hand">
      {p.hand!.map((t, i) => {
        const isDrawn = i === drawnIdx;
        return (
          <MjTile key={p.handIds?.[i] ?? i} tile={t} size={size}
            selected={picked === i}
            onPointerDown={onTilePointerDown ? (e) => onTilePointerDown(e, t, i) : undefined}
            className={[
              isDrawn ? 'mj-drawn' : undefined,
              isDrawn && drawPhase === 'flying' ? 'mj-drawn-flying' : undefined,
              isDrawn && drawPhase === 'landing' ? 'mj-drawn-landing' : undefined,
              p.huTile !== undefined && t === p.huTile ? 'mj-hu' : undefined,
            ].filter(Boolean).join(' ') || undefined} />
        );
      })}
    </div>
  ) : (
    <div className="mj-hand">
      <span className={`mj-hand-count${hasDrawn ? ' mj-just-drew' : ''}`}>
        <MjTile back size={size} />
        <i>{p.handCount}</i>
      </span>
    </div>
  );

  // 新的碰/杠靠近手牌一侧：bottom 新在左，left 新在上 → 反转组的顺序
  const meldsForDisplay = (pos === 'bottom' || pos === 'left')
    ? [...p.melds].reverse()
    : p.melds;
  // 组内也反转：靠近手牌的那一张完整可见，往远离手牌的方向叠
  const reverseMeldTiles = pos === 'bottom' || pos === 'left';
  const meldsEl = p.melds.length > 0 && (
    <div className="mj-melds">
      {meldsForDisplay.map((m, i) => {
        const count = m.type === 'peng' ? 3 : 4;
        const indices = reverseMeldTiles
          ? [...Array(count).keys()].reverse()
          : [...Array(count).keys()];
        return (
          <span key={i} className={`mj-meld${m.gang === 'an' ? ' mj-angang' : ''}`}>
            {indices.map(k => (
              <MjTile key={k} tile={m.tile} size={mine ? 'md' : 'sm'} variant="flat"
                back={m.gang === 'an' && !mine} />
            ))}
          </span>
        );
      })}
    </div>
  );

  return (
    <div className={`mj-seat mj-seat-${pos} ${p.isTurn ? 'mj-turn' : ''}`}>
      <div className="mj-seat-inner">
        {/* 头像：靠边线 */}
        <div className="mj-player-wrap">
          <PlayerCard p={p} justDrew={p.drawn !== null && p.drawn !== undefined} showHandCount={!mine} />
          {bubbles.filter(b => b.seat === p.seat).map(b => (
            <div key={b.id} className="bubble"
              style={{ ['--bub-d' as any]: `${b.ms ?? 1150}ms` }}>
              {b.text}
            </div>
          ))}
        </div>

        {/* 手牌：居中 */}
        <div className="mj-hand-wrap">
          {handEl}
        </div>

        {/* 下地牌：靠另一侧 */}
        {p.melds.length > 0 && (
          <div className="mj-melds-wrap">
            {meldsEl}
          </div>
        )}
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
 * 环从指针处逆时针走：stroke 默认 3 点起点顺时针，正 dashoffset 时减少方向是逆时针，
 * 所以把起点旋转到指针位置 + 正 offset = 从指针处逆时针减少。
 */
function CenterDeco({ wallLeft, currentRel, ringFrac, nextSec }: {
  wallLeft: number; currentRel: 0 | 1 | 2 | 3; ringFrac?: number; nextSec?: number;
}) {
  // 指针始终逆时针旋转：用累积角度，每次按逆时针方向转到目标位置
  const targetDeg = [180, 90, 0, 270][currentRel];
  const spinRef = useRef(180); // 初始对准底部（我的位置）
  const [pointerDeg, setPointerDeg] = useState(180);
  const prevRelRef = useRef(currentRel);
  useEffect(() => {
    if (prevRelRef.current === currentRel) return;
    const cur = ((spinRef.current % 360) + 360) % 360;
    const tgt = ((targetDeg % 360) + 360) % 360;
    // 计算逆时针方向的差值（负值 = 逆时针）
    let diff = tgt - cur;
    if (diff > 0) diff -= 360; // 逆时针转
    spinRef.current += diff;
    setPointerDeg(spinRef.current);
    prevRelRef.current = currentRel;
  }, [currentRel, targetDeg]);
  // 旋转：让 stroke 起点（3点钟方向）转到指针位置
  const ringSpin = pointerDeg - 90;

  const size = 100;
  const cx = size / 2, cy = size / 2;
  const r = 33;
  const len = 2 * Math.PI * r;
  const frac = ringFrac ?? 1;
  const isNext = nextSec !== undefined;
  const color = isNext ? '#4fc3f7' : ringColor(frac);
  const ringFracToUse = isNext ? Math.max(0, Math.min(1, nextSec / 7)) : frac;

  return (
    <div className={`mj-center-deco${isNext ? ' mj-next-mode' : ''}`}>
      {/* 风位字：东南西北环绕（下一局时北字位置换成倒计时） */}
      <div className="mj-wind-ring">
        <span className="w-n">北</span>
        <span className="w-s">南</span>
        <span className="w-e">东</span>
        <span className="w-w">西</span>
      </div>

      {/* 下一局倒计时：放在顶部"北"字位置 */}
      {isNext && (
        <div className="mj-next-countdown">
          <svg className="mj-next-ring" width="36" height="36" viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="14" fill="none" stroke="rgba(255,255,255,.15)" strokeWidth="2" />
            <circle cx="18" cy="18" r="14" fill="none"
              stroke="#4fc3f7" strokeWidth="2" strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 14}
              strokeDashoffset={2 * Math.PI * 14 * (1 - ringFracToUse)}
              style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }} />
          </svg>
          <span>{nextSec}</span>
        </div>
      )}

      {/* 倒计时环：起点对准指针，逆时针方向减少 */}
      <svg className="mj-center-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`}
        style={{ transform: `rotate(${isNext ? -90 : ringSpin}deg)` }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,.13)" strokeWidth="3" />
        <circle cx={cx} cy={cy} r={r} fill="none"
          stroke={color} strokeWidth="3" strokeLinecap="round"
          strokeDasharray={len} strokeDashoffset={len * (1 - ringFracToUse)} />
      </svg>

      {/* 指针：指向当前玩家（下一局模式不显示） */}
      {!isNext && <TurnPointer angle={pointerDeg} color={color} />}

      {/* 剩余张数（下一局模式不显示） */}
      {!isNext && (
        <div className="mj-center-count">
          <span>{wallLeft}</span>
        </div>
      )}
    </div>
  );
}

/** 骰子（两颗）—— 拟物 3D 立方体 */
function Dice({ values, rolling }: { values: [number, number]; rolling: boolean }) {
  const dotPositions: Record<number, [number, number][]> = {
    1: [[50, 50]],
    2: [[28, 28], [72, 72]],
    3: [[28, 28], [50, 50], [72, 72]],
    4: [[28, 28], [72, 28], [28, 72], [72, 72]],
    5: [[28, 28], [72, 28], [50, 50], [28, 72], [72, 72]],
    6: [[26, 22], [74, 22], [26, 50], [74, 50], [26, 78], [74, 78]],
  };

  // 累积旋转角度：rolling 时不断累加，停下时落在目标面上
  const [rot, setRot] = useState<[number, number]>([20, -25]); // 初始角度：展示立体感
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (rolling) {
      let last = performance.now();
      const sx = 540 + Math.random() * 360;
      const sy = 720 + Math.random() * 480;
      const step = (now: number) => {
        const dt = (now - last) / 1000;
        last = now;
        setRot(r => [r[0] + sx * dt, r[1] + sy * dt]);
        rafRef.current = requestAnimationFrame(step);
      };
      rafRef.current = requestAnimationFrame(step);
      return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    } else {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      setRot(r => {
        const targetForFace = (v: number): [number, number] => {
          // 让正确的面朝前，同时保持一点倾斜角度显示立体感
          switch (v) {
            case 1: return [20, -25];
            case 2: return [-70, -25];
            case 3: return [20, 65];
            case 4: return [20, -115];
            case 5: return [110, -25];
            case 6: return [20, 155];
            default: return [20, -25];
          }
        };
        const t1 = targetForFace(values[0]);
        const t2 = targetForFace(values[1]);
        const snap = (cur: number, target: number) => {
          const full = 360;
          const diff = target - cur;
          // 朝当前旋转方向，转到最接近的目标角度
          const turns = Math.floor(cur / full);
          let best = target + turns * full;
          if (Math.abs(best + full - cur) < Math.abs(best - cur)) best += full;
          if (Math.abs(best - full - cur) < Math.abs(best - cur)) best -= full;
          // 保证至少再转半圈以上才有"减速停下"的感觉
          if (Math.abs(best - cur) < 180) best += (best > cur ? full : -full);
          return best;
        };
        return [snap(r[0], t1[0]), snap(r[1], t2[1])];
      });
    }
  }, [rolling, values[0], values[1]]);

  const size = 48;
  const half = size / 2;

  // 每个面：白色底面 + 渐变高光 + 红色点数
  const dieFace = (n: number, transform: string, shade: 'light' | 'mid' | 'dark') => {
    const bg = shade === 'light'
      ? 'linear-gradient(135deg, #ffffff 0%, #f5f0e0 100%)'
      : shade === 'mid'
      ? 'linear-gradient(135deg, #f8f4e6 0%, #e8e0c8 100%)'
      : 'linear-gradient(135deg, #e8e0c8 0%, #d8d0b4 100%)';
    return (
      <div className="mj-die-face" style={{ transform, background: bg, borderRadius: 8 }} key={n}>
        <div className="mj-die-shine" />
        {dotPositions[n].map(([cx, cy], j) => (
          <i key={j} className="mj-die-pip" style={{ left: `${cx}%`, top: `${cy}%` }} />
        ))}
      </div>
    );
  };

  return (
    <div className={`mj-dice ${rolling ? 'mj-dice-rolling' : ''}`}>
      {values.map((v, i) => (
        <div key={i} className="mj-die-wrap">
          <div className="mj-die"
            style={{
              width: size, height: size,
              transform: `rotateX(${rot[i]}deg) rotateY(${rot[1 - i]}deg)`,
            }}>
            {/* 前 1 · 后 6 · 右 3 · 左 4 · 上 2 · 下 5 */}
            {dieFace(1, `translateZ(${half}px)`, 'light')}
            {dieFace(6, `rotateY(180deg) translateZ(${half}px)`, 'dark')}
            {dieFace(3, `rotateY(90deg) translateZ(${half}px)`, 'mid')}
            {dieFace(4, `rotateY(-90deg) translateZ(${half}px)`, 'mid')}
            {dieFace(2, `rotateX(90deg) translateZ(${half}px)`, 'light')}
            {dieFace(5, `rotateX(-90deg) translateZ(${half}px)`, 'dark')}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 翻马动画：3D 翻转 */
function MaFlip({ tile, onDone }: { tile: Tile; onDone?: () => void }) {
  const [flipped, setFlipped] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => { setFlipped(true); onDone?.(); }, 3000);
    return () => clearTimeout(t);
  }, [tile, onDone]);
  return (
    <div className="mj-ma-flip-wrap">
      <div className="mj-ma-flip-label">翻马</div>
      <div className={`mj-ma-flip ${flipped ? 'mj-ma-flipped' : ''}`}>
        <div className="mj-ma-face mj-ma-back">
          <div className="mj-tile-back-face" style={{ width: '100%', height: '100%' }} />
        </div>
        <div className="mj-ma-face mj-ma-front">
          <MjTile tile={tile} size="md" variant="flat" />
        </div>
      </div>
      {flipped && <div className="mj-ma-flip-name">{mjName(tile)}</div>}
    </div>
  );
}

export function MjTable({ v, picked, ringFrac, now, onTilePointerDown,
  onBack, onSettings, onHistory, onRules,
  bubbles = [], banner,
}: {
  v: MjTableView; picked?: number; ringFrac?: number; now: number;
  onTilePointerDown?: (e: React.PointerEvent, t: Tile, i: number) => void;
  onBack?: () => void;
  onSettings?: () => void;
  onHistory?: () => void;
  onRules?: () => void;
  bubbles?: { id: number; seat: number; text: string; ms?: number }[];
  banner?: { text: string; sub?: string } | null;
}) {
  // 相对座位：0=我(下) 1=下家(右) 2=对家(上) 3=上家(左)
  const rel = (seat: number) => ((seat - v.mySeat + 4) % 4) as 0 | 1 | 2 | 3;

  // 弃牌按相对座位分四路
  const lanes = useMemo(() => {
    const lanes: Tile[][] = [[], [], [], []];
    for (const p of v.players) lanes[rel(p.seat)] = p.discards.slice();
    return lanes;
  }, [v.players]);

  // 四家弃牌中最新一张的光晕（只有一张牌有，10s后消失）
  const [glowSeat, setGlowSeat] = useState<number | null>(null);
  const glowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevLanesRef = useRef<Tile[][]>([[], [], [], []]);
  useEffect(() => {
    for (let i = 0; i < 4; i++) {
      const cur = lanes[i];
      const prev = prevLanesRef.current[i];
      if (cur.length > prev.length) {
        // 新打出的牌 → 光晕移到这家，之前的自动消失
        setGlowSeat(i);
        if (glowTimerRef.current) clearTimeout(glowTimerRef.current);
        glowTimerRef.current = setTimeout(() => {
          setGlowSeat(null);
        }, 10000);
      }
    }
    prevLanesRef.current = lanes.map(l => [...l]);
  }, [lanes]);

  // 指针指向的玩家：
  //   - 出牌阶段：指向当前出牌的玩家
  //   - 叫碰/杠/胡阶段（有明牌在桌上）：指针停留在打出牌的那家
  const pointerSeat = v.table ? v.table.from : (v.players.find(p => p.isTurn)?.seat ?? v.mySeat);
  const pointerRel = rel(pointerSeat);

  // 下一局倒计时
  const nextSec = v.phase === 'ended' && v.nextRoundAt
    ? Math.max(0, Math.ceil((v.nextRoundAt - now) / 1000))
    : undefined;

  // 下一局倒计时 ≤5s 时每秒滴答一声
  const prevNextSecRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (nextSec === undefined) { prevNextSecRef.current = undefined; return; }
    const prev = prevNextSecRef.current;
    if (prev !== undefined && nextSec < prev && nextSec > 0 && nextSec <= 5) {
      cue('mj_tick');
    }
    prevNextSecRef.current = nextSec;
  }, [nextSec]);

  // ============== 骰子动画 ==============
  const [showDice, setShowDice] = useState(false);
  const [diceRolling, setDiceRolling] = useState(false);
  const prevRoundRef = useRef(v.roundNo);
  useEffect(() => {
    if (v.roundNo !== prevRoundRef.current && v.phase !== 'ended') {
      // 新一局开始：播骰子动画
      setShowDice(true);
      setDiceRolling(true);
      const t1 = setTimeout(() => setDiceRolling(false), 1000);
      const t2 = setTimeout(() => setShowDice(false), 2200);
      prevRoundRef.current = v.roundNo;
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
    prevRoundRef.current = v.roundNo;
  }, [v.roundNo, v.phase]);

  // ============== 摸牌动画 ==============
  // 检测 wallLeft 减少（有人摸牌）
  // 我方：金橙色流星从中心飞到手牌
  // 其他三家：翠绿色星光从中心飞向头像，头像发光
  const [drawAnim, setDrawAnim] = useState<{
    seat: number; phase: 'start' | 'fly' | 'end'; tile: Tile | 'star';
  } | null>(null);
  const prevWallRef = useRef(v.wallLeft);
  const prevPhaseRef = useRef(v.phase);
  const drawTimersRef = useRef<number[]>([]);

  const clearDrawTimers = () => {
    drawTimersRef.current.forEach(t => clearTimeout(t));
    drawTimersRef.current = [];
  };

  useEffect(() => {
    if (prevWallRef.current > v.wallLeft && v.wallLeft > 0 && v.phase === 'discard'
        && prevPhaseRef.current !== 'ended') {
      const turnPlayer = v.players.find(p => p.isTurn);
      if (turnPlayer) {
        const isMine = turnPlayer.seat === v.mySeat;
        const seat = turnPlayer.seat;

        if (isMine && turnPlayer.drawn !== null && turnPlayer.drawn !== true) {
          // 我方：金橙色水滴形流星从中心飞向下边（总时长 ~1.3s）
          const tile = turnPlayer.drawn as Tile;
          clearDrawTimers();
          sayDraw();
          cue('mj_draw');
          // 立即设为 start：手牌中的 drawn 牌立刻隐藏（缩成光点），星光在中心出现
          setDrawAnim({ seat, phase: 'start', tile });
          const t1 = window.setTimeout(() => {
            setDrawAnim(prev => prev ? { ...prev, phase: 'fly' } : null);  // 飞出去
          }, 150);
          const t2 = window.setTimeout(() => {
            setDrawAnim(prev => prev ? { ...prev, phase: 'end' } : null);  // 到达淡出
          }, 1050);
          const t3 = window.setTimeout(() => {
            setDrawAnim(null);
          }, 1350);
          drawTimersRef.current.push(t1, t2, t3);
        } else if (!isMine) {
          // 其他三家：金橙色水滴形流星飞向各自边的中心（总时长 ~1.4s）
          clearDrawTimers();
          cue('mj_draw');
          setDrawAnim({ seat, phase: 'start', tile: 'star' });   // 中心光点出现
          const t1 = window.setTimeout(() => {
            setDrawAnim(prev => prev ? { ...prev, phase: 'fly' } : null);  // 飞出去
          }, 150);
          const t2 = window.setTimeout(() => {
            setDrawAnim(prev => prev ? { ...prev, phase: 'end' } : null);  // 到达淡出
          }, 1050);
          const t3 = window.setTimeout(() => {
            setDrawAnim(null);
          }, 1350);
          drawTimersRef.current.push(t1, t2, t3);
        }

        prevWallRef.current = v.wallLeft;
        prevPhaseRef.current = v.phase;
        return clearDrawTimers;
      }
    }
    prevWallRef.current = v.wallLeft;
    prevPhaseRef.current = v.phase;
  }, [v.wallLeft, v.phase, v.players, v.mySeat]);

  const drawRel = drawAnim ? rel(drawAnim.seat) : -1;
  const drawPos = ['bottom', 'right', 'top', 'left'][drawRel] || '';
  const drawIsMine = drawAnim ? drawAnim.seat === v.mySeat : false;

  // ============== 亮牌（打牌）动画 ==============
  // 打出的牌（中央不再显示，只在被碰/杠时播放蓝光飞行动画）
  //   - 没人要：直接落入弃牌区
  //   - 有人碰/杠：蓝光从中心飞向碰/杠那家
  const [ghostTile, setGhostTile] = useState<{ tile: Tile; from: number } | null>(null);
  // phase: flyIn（飞入）→ wait（等待）→ flyOut（被碰/杠飞走）→ fall（落入弃牌）
  const [ghostPhase, setGhostPhase] = useState<'flyIn' | 'wait' | 'flyOut' | 'fall'>('wait');
  // 如果是被碰/杠，飞到哪家
  const [ghostTo, setGhostTo] = useState<number | null>(null);
  // 碰/杠蓝光飞行动画：从出牌者弃牌区飞向碰/杠玩家
  const [meldAnim, setMeldAnim] = useState<{ fromSeat: number; toSeat: number; phase: 'start' | 'fly' | 'end' } | null>(null);
  const prevTableRef = useRef<{ tile: Tile; from: number } | null>(null);
  const prevMeldsRef = useRef<number[]>([0, 0, 0, 0]); // 记录各家 meld 数量，用于检测谁碰/杠了
  const appearAtRef = useRef<number>(0); // 亮牌出现的时间，用于最小展示时间
  const MIN_SHOW_MS = 800; // 亮牌最少展示 800ms 再飞走（没人要也让玩家看清）

  useEffect(() => {
    const cur = v.table ? { tile: v.table.tile, from: v.table.from } : null;
    const prev = prevTableRef.current;
    let cleanup: (() => void) | null = null;

    if (cur && (!prev || prev.tile !== cur.tile || prev.from !== cur.from)) {
      // 新的一张亮牌出现了 → 从出牌者位置飞入明牌区
      // 同一家的摸牌动画立刻让位
      setDrawAnim(prev => {
        if (prev && prev.seat === cur.from) return null;
        return prev;
      });
      setGhostTo(null);
      setGhostPhase('flyIn');
      setGhostTile(cur);
      // flyIn 动画 300ms 后进入 wait 状态
      const t = setTimeout(() => {
        setGhostPhase('wait');
        appearAtRef.current = Date.now();
      }, 300);
      cleanup = () => clearTimeout(t);
    } else if (prev && !cur) {
      // 亮牌从服务端消失了 → 判断是被碰/杠了还是没人要
      const elapsed = Date.now() - appearAtRef.current;
      const wait = Math.max(0, MIN_SHOW_MS - elapsed);

      // 检查各家 meld 数量变化，找出谁碰/杠了
      let claimant: number | null = null;
      for (let i = 0; i < 4; i++) {
        const meldCount = v.players[i]?.melds?.length ?? 0;
        if (meldCount > prevMeldsRef.current[i]) {
          claimant = v.players[i].seat;
          break;
        }
      }

      const t = setTimeout(() => {
        if (claimant !== null && prev) {
          // 被碰/杠了 → 播放蓝光飞行动画，从出牌者弃牌区飞向碰/杠那家
          setMeldAnim({ fromSeat: prev.from, toSeat: claimant, phase: 'start' });
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              setMeldAnim(prev => prev ? { ...prev, phase: 'fly' } : prev);
            });
          });
          const tFly = setTimeout(() => {
            setMeldAnim(prev => prev ? { ...prev, phase: 'end' } : prev);
          }, 700);
          const tEnd = setTimeout(() => {
            setMeldAnim(null);
          }, 900);
          setGhostTile(null);
          setGhostPhase('wait');
          (cleanup as any) = () => { clearTimeout(t); clearTimeout(tFly); clearTimeout(tEnd); };
        } else {
          // 没人要 → 落入弃牌区
          setGhostPhase('fall');
          const t2 = setTimeout(() => {
            setGhostTile(null);
            setGhostPhase('wait');
            setGhostTo(null);
          }, 400);
          (cleanup as any) = () => { clearTimeout(t); clearTimeout(t2); };
        }
      }, wait);
      if (!cleanup) cleanup = () => clearTimeout(t);
    }

    // 不管走哪个分支，都要更新 ref（放在 return 之前会被 return 跳过）
    prevTableRef.current = cur;
    prevMeldsRef.current = v.players.map(p => p.melds?.length ?? 0);

    if (cleanup) return cleanup;
  }, [v.table?.tile, v.table?.from, v.players]);
  const ghostRel = ghostTile ? rel(ghostTile.from) : -1;
  const ghostPos = ['bottom', 'right', 'top', 'left'][ghostRel] || '';
  const ghostToRel = ghostTo !== null ? rel(ghostTo) : -1;
  const ghostToPos = ['bottom', 'right', 'top', 'left'][ghostToRel] || '';

  // ============== 翻马动画 ==============
  const [maAnimating, setMaAnimating] = useState(false);
  const prevMaRef = useRef<Tile | null>(null);
  useEffect(() => {
    if (v.ma !== null && prevMaRef.current === null && v.phase === 'ended') {
      // 马刚翻出来 → 播翻转动画
      setMaAnimating(true);
      const t = setTimeout(() => setMaAnimating(false), 3000);
      prevMaRef.current = v.ma;
      return () => clearTimeout(t);
    }
    if (v.ma === null) {
      prevMaRef.current = null;
      setMaAnimating(false);
    }
  }, [v.ma, v.phase]);

  // 根据屏幕尺寸计算牌的缩放比例，以及中央正方形的尺寸
  const tableRef = useRef<HTMLDivElement>(null);
  const [tileScale, setTileScale] = useState(1);
  const [centerSize, setCenterSize] = useState(0);
  useEffect(() => {
    const updateScale = () => {
      const vmin = Math.min(window.innerWidth, window.innerHeight);
      // 基准 440px，最小 0.75，最大 1.4
      const scale = Math.min(1.4, Math.max(0.75, vmin / 440));
      setTileScale(scale);

      // 计算中央正方形尺寸：宽的 62% vs 高的 58% 取较小值（窄屏用 55% / 52%）
      const el = tableRef.current;
      if (el) {
        const w = el.clientWidth;
        const h = el.clientHeight;
        const isNarrow = w / h < 4 / 3;
        const wPct = isNarrow ? 0.55 : 0.62;
        const hPct = isNarrow ? 0.52 : 0.58;
        const size = Math.min(w * wPct, h * hPct);
        setCenterSize(size);
      }
    };
    updateScale();
    window.addEventListener('resize', updateScale);
    const ro = new ResizeObserver(updateScale);
    if (tableRef.current) ro.observe(tableRef.current);
    return () => {
      window.removeEventListener('resize', updateScale);
      ro.disconnect();
    };
  }, []);

  return (
    <div className="mj-table" ref={tableRef} style={{
      ['--tile-scale' as any]: tileScale,
      ['--center-size' as any]: centerSize ? `${centerSize}px` : '0px',
    }}>
      <div className="mj-table-inner">
        {/* 中央区域：中心装饰（倒计时环+箭头+剩余张数） */}
      <div className="mj-center">
        <CenterDeco wallLeft={v.wallLeft} currentRel={pointerRel}
          ringFrac={ringFrac} nextSec={nextSec} />

        {/* 亮牌区：没人要的牌从中央落入弃牌区（中央不再停留展示） */}
        {ghostTile && ghostPhase === 'fall' && (
          <div className={`mj-just-discard mj-ghost-fall mj-from-${ghostPos}`}>
            <MjTile tile={ghostTile.tile} size="xs" variant="flat" />
          </div>
        )}

        {/* 骰子动画 */}
        {showDice && (
          <Dice values={v.dice} rolling={diceRolling} />
        )}

        {/* 翻马动画（居中播放，结束后马牌在结算面板展示） */}
        {maAnimating && v.ma !== null && (
          <MaFlip tile={v.ma} />
        )}

        {/* 开局横幅 */}
        {banner && (
          <div className="mj-banner">
            <div className="mj-banner-text">{banner.text}</div>
            {banner.sub && <div className="mj-banner-sub">{banner.sub}</div>}
          </div>
        )}

      </div>

      {/* 四家弃牌区：贴桌面四边内侧 */}
      {lanes.map((lane, i) => {
        if (!lane.length) return null;
        const pos = ['bottom', 'right', 'top', 'left'][i];
        return (
          <div key={i} className={`mj-discard-lane mj-discard-${pos}`}>
            {lane.map((t, j) => {
              const isLast = j === lane.length - 1;
              const showGlow = isLast && glowSeat === i;
              return (
                <span key={j} className={`mj-discard-tile${showGlow ? ' mj-discard-glow' : ''}`}>
                  <MjTile tile={t} size="sm" variant="flat" />
                </span>
              );
            })}
          </div>
        );
      })}

      {/* 摸牌动画：星光从桌面中心飞向玩家头像 */}
      {drawAnim && (
        <div className={`mj-draw-anim mj-draw-${drawPos} mj-draw-${drawAnim.phase}`}>
          {drawIsMine && drawAnim.tile !== 'star' ? (
            <div className="mj-draw-tile">
              <MjTile tile={drawAnim.tile as Tile} size="xs" variant="flat" />
            </div>
          ) : null}
          <div className="mj-draw-meteor" />
        </div>
      )}

      {/* 碰/杠蓝光动画：从出牌者弃牌区飞向碰/杠那家 */}
      {meldAnim && (() => {
        const fromRel = rel(meldAnim.fromSeat);
        const toRel = rel(meldAnim.toSeat);
        const fromPos = ['bottom', 'right', 'top', 'left'][fromRel];
        const toPos = ['bottom', 'right', 'top', 'left'][toRel];
        return (
          <div className={`mj-meld-anim mj-meld-from-${fromPos} mj-meld-to-${toPos} mj-meld-${meldAnim.phase}`}>
            <div className="mj-meld-beam" />
          </div>
        );
      })()}

      {/* 四方玩家 */}
      {v.players.map(p => {
        const r = rel(p.seat);
        return (
          <SeatHand key={p.seat} p={p}
            rel={r}
            mine={p.seat === v.mySeat}
            picked={p.seat === v.mySeat ? picked : undefined}
            onTilePointerDown={p.seat === v.mySeat ? onTilePointerDown : undefined}
            bubbles={bubbles}
            drawPhase={
              p.seat === v.mySeat && drawAnim && drawAnim.seat === p.seat
                ? (drawAnim.phase === 'end' ? 'landing' : 'flying')
                : undefined
            } />
        );
      })}
      </div>
    </div>
  );
}
