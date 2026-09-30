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

/** 玩家信息卡：头像在最边上，昵称直接显示在头像里（最多4字），分数在头像下方 */
function PlayerCard({ p }: { p: MjSeatView }) {
  return (
    <div className="mj-player">
      <div style={{ position: 'relative' }}>
        <div className="mj-avatar">{p.name.slice(0, 4)}</div>
        {p.isDealer && <span className="mj-dealer-badge">庄</span>}
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
function SeatHand({ p, rel, mine, picked, onTilePointerDown, bubbles = [], discards, showDot }: {
  p: MjSeatView; rel: 0 | 1 | 2 | 3; mine: boolean;
  picked?: number;
  onTilePointerDown?: (e: React.PointerEvent, t: Tile, i: number) => void;
  bubbles?: { id: number; seat: number; text: string; ms?: number }[];
  discards?: Tile[];
  showDot?: boolean;
}) {
  const pos = ['bottom', 'right', 'top', 'left'][rel];
  const size: 'sm' | 'md' = mine ? 'md' : 'sm';

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
              p.huTile !== undefined && t === p.huTile ? 'mj-hu' : undefined,
            ].filter(Boolean).join(' ') || undefined} />
        );
      })}
    </div>
  ) : (
    <div className="mj-hand">
      <span className="mj-hand-count">
        <MjTile back size={size} />
        <i>{p.handCount}</i>
      </span>
    </div>
  );

  const meldsEl = p.melds.length > 0 && (
    <div className="mj-melds">
      {p.melds.map((m, i) => (
        <span key={i} className={`mj-meld${m.gang === 'an' ? ' mj-angang' : ''}`}>
          {m.type === 'peng'
            ? [0, 1, 2].map(k => <MjTile key={k} tile={m.tile} size="sm" variant="flat" />)
            : [0, 1, 2, 3].map(k => (
              <MjTile key={k} tile={m.tile} size="sm" variant="flat"
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
        <div className="mj-melds-wrap">
          {meldsEl}
        </div>
      </div>

      {/* 弃牌区：放在下地牌靠近中心的一侧，间距30px */}
      {discards && discards.length > 0 && (
        <div className={`mj-discard-lane mj-lane-${pos}`}>
          {discards.map((t, i) => {
            const isLast = i === discards.length - 1;
            return (
              <span key={i} className={`mj-discard-tile${isLast ? ' mj-last-discard' : ''}`}>
                <MjTile tile={t} size="sm" variant="flat" />
                {isLast && showDot && <i className="mj-discard-dot" />}
              </span>
            );
          })}
        </div>
      )}
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
    <div className="mj-center-deco">
      {/* 风位字：东南西北环绕 */}
      <div className="mj-wind-ring">
        <span className="w-n">北</span>
        <span className="w-s">南</span>
        <span className="w-e">东</span>
        <span className="w-w">西</span>
      </div>

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

      {/* 下一局倒计时文字 / 剩余张数 */}
      {isNext ? (
        <div className="mj-center-next">
          <b>下一局</b>
          <span>{nextSec}s</span>
        </div>
      ) : (
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

  // 每家弃牌的蓝点状态（10s闪烁后消失）
  const [dotVisible, setDotVisible] = useState<boolean[]>([false, false, false, false]);
  const dotTimersRef = useRef<(ReturnType<typeof setTimeout> | null)[]>([null, null, null, null]);
  const prevLanesRef = useRef<Tile[][]>([[], [], [], []]);
  useEffect(() => {
    for (let i = 0; i < 4; i++) {
      const cur = lanes[i];
      const prev = prevLanesRef.current[i];
      if (cur.length > prev.length) {
        setDotVisible(prev => { const n = [...prev]; n[i] = true; return n; });
        if (dotTimersRef.current[i]) clearTimeout(dotTimersRef.current[i]!);
        dotTimersRef.current[i] = setTimeout(() => {
          setDotVisible(prev => { const n = [...prev]; n[i] = false; return n; });
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
  // 检测 wallLeft 减少（有人摸牌），触发从中心飞到对应玩家手牌的动画
  const [drawAnim, setDrawAnim] = useState<{ seat: number; phase: 'fly' | 'hover' | 'land'; tile: Tile | 'back' } | null>(null);
  const prevWallRef = useRef(v.wallLeft);
  const prevPhaseRef = useRef(v.phase);
  const prevTurnRef = useRef(v.dealer);
  const drawTimersRef = useRef<number[]>([]);

  const clearDrawTimers = () => {
    drawTimersRef.current.forEach(t => clearTimeout(t));
    drawTimersRef.current = [];
  };

  useEffect(() => {
    // wallLeft 减少 = 有人摸了一张牌
    if (prevWallRef.current > v.wallLeft && v.wallLeft > 0 && v.phase === 'discard'
        && prevPhaseRef.current !== 'ended') {
      const turnPlayer = v.players.find(p => p.isTurn);
      if (turnPlayer) {
        const isMine = turnPlayer.seat === v.mySeat;
        const tile: Tile | 'back' = isMine && turnPlayer.drawn !== null && turnPlayer.drawn !== true
          ? turnPlayer.drawn as Tile : 'back';
        // 延迟 1s 再开始摸牌动画，让玩家看清指针转动和弃牌
        const seat = turnPlayer.seat;
        clearDrawTimers();
        const t0 = window.setTimeout(() => {
          setDrawAnim({ seat, phase: 'fly', tile });
          // 慢速飞行 600ms → 悬停 200ms → 落下 200ms
          const t1 = window.setTimeout(() => {
            setDrawAnim(prev => prev ? { ...prev, phase: 'hover' } : null);
          }, 600);
          const t2 = window.setTimeout(() => {
            setDrawAnim(prev => prev ? { ...prev, phase: 'land' } : null);
          }, 800);
          const t3 = window.setTimeout(() => {
            setDrawAnim(null);
          }, 1000);
          drawTimersRef.current = drawTimersRef.current.filter(t => t !== t0);
          drawTimersRef.current.push(t1, t2, t3);
        }, 1000);
        drawTimersRef.current.push(t0);
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

  // ============== 亮牌（打牌）动画 ==============
  const [ghostTile, setGhostTile] = useState<{ tile: Tile; from: number } | null>(null);
  const [ghostFalling, setGhostFalling] = useState(false);
  const prevTableRef = useRef<{ tile: Tile; from: number } | null>(null);
  const appearAtRef = useRef<number>(0); // 亮牌出现的时间，用于最小展示时间
  const MIN_SHOW_MS = 800; // 亮牌最少展示 800ms 再飞走（没人要也让玩家看清）
  useEffect(() => {
    const cur = v.table ? { tile: v.table.tile, from: v.table.from } : null;
    const prev = prevTableRef.current;
    if (cur && (!prev || prev.tile !== cur.tile || prev.from !== cur.from)) {
      // 新的一张亮牌出现了 → 同一家的摸牌动画立刻让位（避免两张牌重叠）
      setDrawAnim(prev => {
        if (prev && prev.seat === cur.from) return null;
        return prev;
      });
      setGhostTile(cur);
      setGhostFalling(false);
      appearAtRef.current = Date.now();
    } else if (prev && !cur) {
      // 亮牌从服务端消失了 → 检查是否满足最小展示时间
      const elapsed = Date.now() - appearAtRef.current;
      const wait = Math.max(0, MIN_SHOW_MS - elapsed);
      const t = setTimeout(() => {
        setGhostFalling(true);
        const t2 = setTimeout(() => {
          setGhostTile(null);
          setGhostFalling(false);
        }, 350);
        return () => clearTimeout(t2);
      }, wait);
      return () => clearTimeout(t);
    }
    prevTableRef.current = cur;
  }, [v.table?.tile, v.table?.from]);
  const ghostRel = ghostTile ? rel(ghostTile.from) : -1;
  const ghostPos = ['bottom', 'right', 'top', 'left'][ghostRel] || '';

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

  return (
    <div className="mj-table">
      {/* 中央区域：中心装饰（倒计时环+箭头+剩余张数） */}
      <div className="mj-center">
        <CenterDeco wallLeft={v.wallLeft} currentRel={pointerRel}
          ringFrac={ringFrac} nextSec={nextSec} />

        {/* 亮牌区：刚打出来的牌先亮在风位字外侧（大牌），没人要再飞入弃牌区 */}
        {ghostTile && (
          <div className={`mj-just-discard mj-from-${ghostPos} ${ghostFalling ? 'mj-falling' : ''}`}>
            <MjTile tile={ghostTile.tile} size="sm" variant="flat" />
          </div>
        )}

        {/* 摸牌动画：牌从中心飞到玩家手牌上方 */}
        {drawAnim && (
          <div className={`mj-draw-anim mj-draw-${drawPos} mj-draw-${drawAnim.phase}`}>
            {drawAnim.tile === 'back'
              ? <MjTile back size="sm" variant="flat" />
              : <MjTile tile={drawAnim.tile} size="sm" variant="flat" />}
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
            discards={lanes[r]}
            showDot={dotVisible[r]} />
        );
      })}
    </div>
  );
}
