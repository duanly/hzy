/**
 * 红中麻将的牌桌。
 *
 * 摆法（照老板说的来）：
 *  · 四家各占一方，围成中间那个正方形 —— 跟真麻将桌一样。
 *  · 每一方：头像在**角上**（那一方的左端），往右是手牌，再往右是下地的牌组。
 *    手牌 + 下地一共就是 13~14 张，所以碰了杠了，下地正好补上手牌空出来的位置，
 *    整条的长度基本不变 —— 这也是为什么这一行的宽度可以写死。
 *  · 打出去的牌全丢**中央**，横七竖八不用摆齐，跟真桌上一样乱，
 *    但**每张都露着牌面**：角度和偏移都限制在格子内，不让互相压住。
 *  · 牌墙（公共牌）在中央外圈，四边各一摞，只是让人一眼看出还剩多少。
 *
 * 牌面走 MjTile，以后换成真图片只动那一个文件，这儿不用管。
 */
import React, { useMemo } from 'react';
import { MjTile, mjName, HONG, type Tile } from './MjTile.tsx';

/** 倒计时圈颜色：绿 → 黄 → 红（跟跑胡子同一个函数） */
function ringColor(f: number) {
  const x = Math.max(0, Math.min(1, f));
  const hue = x > 0.4 ? 35 + ((x - 0.4) / 0.6) * (140 - 35) : 2 + (x / 0.4) * (35 - 2);
  const sat = 78 + (1 - x) * 12, light = 48 + (1 - x) * 6;
  return `hsl(${hue.toFixed(0)}, ${sat.toFixed(0)}%, ${light.toFixed(0)}%)`;
}
/** 头像外圈那一圈倒计时（方头像用圆角框），照跑胡子 */
function TurnRing({ frac, size }: { frac: number; size: number }) {
  const GAP = 4, box = size + GAP * 2, h = size + GAP * 2;
  const pad = 2, bw = box - pad * 2, bh = h - pad * 2, r = Math.min(10, Math.round(bh / 3));
  const len = 2 * (bw - 2 * r) + 2 * (bh - 2 * r) + 2 * Math.PI * r;
  return <svg className="turn-ring" width={box} height={h} viewBox={`0 0 ${box} ${h}`}
    style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)' }}>
    <rect x={pad} y={pad} width={bw} height={bh} rx={r} fill="none" stroke="rgba(0,0,0,.35)" strokeWidth="3" />
    <rect x={pad} y={pad} width={bw} height={bh} rx={r} fill="none" stroke={ringColor(frac)} strokeWidth="3" strokeLinecap="round"
      strokeDasharray={`${len}`} strokeDashoffset={`${len * (1 - frac)}`} />
  </svg>;
}

export interface MjSeatView {
  seat: number;
  hand: Tile[] | null;      // 别人的看不见，只给张数
  handCount: number;
  melds: { type: 'peng' | 'gang'; gang?: 'ming' | 'an' | 'bu'; tile: Tile }[];
  discards: Tile[];
  name: string;
  total: number;
  isDealer?: boolean;
  isTurn?: boolean;
  /** 手里还剩几张延时卡（麻将引擎现在还没这套，给了就显示） */
  delay?: number;
  /** 违规罚分次数 */
  fouls?: number;
  /** 胡的那一张（亮牌时标个「胡」） */
  huTile?: Tile;
}

export interface MjTableView {
  players: MjSeatView[];
  mySeat: number;
  wallLeft: number;
  table: { tile: Tile; from: number } | null;   // 刚打出来、还在等人要的那张
  ma: Tile | null;
  roundNo: number;
  baseScore: number;
}

/**
 * 牌墙：**两张一叠**码在四边 —— 就是真桌上那个样子。
 * 112 张全码起来是 56 墩、四面各 14 墩；摸一张就从最前头少半墩，摸两张少一整墩。
 * 这儿按还剩多少张算出还剩几墩，平摊到四边画出来。
 * 只画背面，一墩就是两张背面错开几个像素叠着 —— 侧面看过去那点厚度就是靠这个。
 */
function Wall({ left }: { left: number }) {
  const stacks = Math.ceil(left / 2);                 // 剩几墩（最后一墩可能只剩一张）
  const per = [0, 1, 2, 3].map(i => Math.floor(stacks / 4) + (i < stacks % 4 ? 1 : 0));
  const sides = ['top', 'right', 'bottom', 'left'] as const;
  return <>
    {sides.map((side, i) => (
      <div key={side} className={`mj-wall mj-wall-${side}`}>
        {Array.from({ length: per[i] }, (_, k) => (
          <span key={k} className="mj-stack">
            <i className="mj-stack-b" /><i className="mj-stack-t" />
          </span>
        ))}
      </div>
    ))}
  </>;
}

/** 中央弃牌：四家各占一边、各排一行（6 张一行、按打出顺序）—— 照欢乐麻将的摆法，不再混成一堆 */
function DiscardPool({ lanes }: { lanes: Tile[][] }) {
  // lanes 按相对座位：0=我（下）、1=下家（右）、2=对家（上）、3=上家（左）
  const lane = (ts: Tile[], cls: string) => (
    <div className={`mj-lane ${cls}`}>{ts.map((t, i) => <MjTile key={i} tile={t} size="xs" />)}</div>
  );
  return (
    <div className="mj-pool">
      {lane(lanes[2], 'mj-lane-top')}
      {lane(lanes[3], 'mj-lane-left')}
      {lane(lanes[0], 'mj-lane-bottom')}
      {lane(lanes[1], 'mj-lane-right')}
    </div>
  );
}

/**
 * 头像旁边那排状态标识，样式沿用跑胡子那套（.st / .st-delay / .st-foul）——
 * 两个玩法摆在一起看的时候，同样的东西长得一样，玩家不用重新认。
 *   杠（金）按次数 · 延时卡（绿）按张数 · 罚（红）按次数
 */
function MjTags({ p }: { p: MjSeatView }) {
  const gangs = p.melds.filter(m => m.type === 'gang').length;
  const items: React.ReactNode[] = [];
  const tag = (key: string, cls: string, text: string, n: number) => {
    if (n <= 0) return;
    items.push(<b key={key} className={`st ${cls}${n > 1 ? ' has-n' : ''}`}>{text}{n > 1 && <i className="st-n">{n}</i>}</b>);
  };
  tag('g', 'st-gang', '杠', gangs);
  tag('t', 'st-delay', '延', p.delay ?? 0);
  tag('f', 'st-foul', '罚', p.fouls ?? 0);
  if (!items.length) return null;
  return <div className="st-row mj-tags">{items}</div>;
}

/** 一方：头像在角上，手牌在左，下地在右 */
function SeatSide({ p, rel, mine, picked, ringFrac, onTilePointerDown }: {
  p: MjSeatView; rel: 0 | 1 | 2 | 3; mine: boolean;
  picked?: number; ringFrac?: number;
  onTilePointerDown?: (e: React.PointerEvent, t: Tile, i: number) => void;
}) {
  const pos = ['bottom', 'right', 'top', 'left'][rel];
  /* 手牌和下地牌一样大（md）：自己的手牌和下地牌平铺、一个尺寸，别家的背面 sm */
  const size: 'sm' | 'md' = mine ? 'md' : 'sm';
  return (
    <div className={`mj-side mj-${pos} ${p.isTurn ? 'mj-turn' : ''}`}>
      {/* 头像钉在这一方的左端 —— 四个人的头像就落在四个角上 */}
      <div className="mj-who">
        <span className="mj-avatar-wrap">
          <div className="mj-avatar">{p.name.slice(0, 2)}</div>
          {p.isTurn && ringFrac !== undefined && ringFrac > 0 && <TurnRing frac={ringFrac} size={34} />}
        </span>
        <div className="mj-who-txt">
          {/* 昵称给足四个字，跟跑胡子那边一个规矩（再长就截断） */}
          <b className="mj-nick">{p.name.slice(0, 4)}{p.isDealer && <i className="mj-zhuang">庄</i>}</b>
          <span className={`mj-total ${p.total > 0 ? 'pos' : p.total < 0 ? 'neg' : ''}`}>{p.total > 0 ? `+${p.total}` : p.total}</span>
          <MjTags p={p} />
        </div>
      </div>
      <div className="mj-row">
        {/* 手牌：自己的露面，对家背面横排，左右两家只露一张背面 + 张数 */}
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
          ) : (rel === 1 || rel === 3) ? (
            /* 左右两家竖着放不下 13 张：只露一张背面，角上标张数 */
            <span className="mj-hand-count"><MjTile back size={size} /><i>{p.handCount}</i></span>
          ) : (
            Array.from({ length: p.handCount }, (_, i) => <MjTile key={i} back size={size} />)
          )}
        </div>
        {/* 下地：碰 / 杠。暗杠整组扣着 —— 服务端对别人的暗杠只发 tile=-1，
            (view() 里就是「暗杠只露张数」)，所以四张全走背面，不能露出牌面 */}
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
      </div>
    </div>
  );
}

export function MjTable({ v, picked, ringFrac, onTilePointerDown }: {
  v: MjTableView; picked?: number; ringFrac?: number;
  onTilePointerDown?: (e: React.PointerEvent, t: Tile, i: number) => void;
}) {
  // 四家按"我在下方"转一圈：我 0、下家 1（右）、对家 2（上）、上家 3（左）
  const rel = (seat: number) => ((seat - v.mySeat + 4) % 4) as 0 | 1 | 2 | 3;
  // 中央弃牌：四家按相对座位分列，各家按打出顺序排
  const lanes = useMemo(() => {
    const lanes: Tile[][] = [[], [], [], []];
    for (const p of v.players) lanes[rel(p.seat)] = p.discards.slice();
    return lanes;
  }, [v.players]);

  return (
    <div className="mj-table">
      {/* 中央：只剩个「剩 N 张」角标 + 弃牌堆（牌墙不画了，腾地方） */}
      <div className="mj-center">
        <div className="mj-pool-box">
          <span className="mj-wall-count">剩 {v.wallLeft} 张</span>
          <DiscardPool lanes={lanes} />
        </div>
        {/* 明牌区：刚打出来、还在等人要的那张，亮在中央 */}
        {v.table && <div className="mj-just"><span className="mj-just-tag">明</span><MjTile tile={v.table.tile} size="sm" className="mj-table-tile" /></div>}
        {/* 翻出来的马 */}
        {v.ma !== null && <div className="mj-ma-box"><MjTile tile={v.ma} size="sm" className="mj-ma" /></div>}
      </div>

      {v.players.map(p => (
        <SeatSide key={p.seat} p={p} rel={rel(p.seat)} mine={p.seat === v.mySeat}
          picked={p.seat === v.mySeat ? picked : undefined}
          ringFrac={ringFrac}
          onTilePointerDown={p.seat === v.mySeat ? onTilePointerDown : undefined} />
      ))}
    </div>
  );
}
