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

/** 固定的伪随机：同一张牌永远歪同一个角度，重绘不会跳 */
function jitter(seed: number) {
  let a = (seed * 2654435761) >>> 0;
  a ^= a >>> 15; a = Math.imul(a, 0x2545f491); a ^= a >>> 13;
  const r1 = ((a >>> 0) % 1000) / 1000;
  a = Math.imul(a ^ (a >>> 7), 0x9e3779b1);
  const r2 = ((a >>> 0) % 1000) / 1000;
  a = Math.imul(a ^ (a >>> 11), 0x85ebca6b);
  const r3 = ((a >>> 0) % 1000) / 1000;
  return { rot: (r1 - 0.5) * 44, dx: (r2 - 0.5) * 9, dy: (r3 - 0.5) * 9 };
}

/** 中央那一堆弃牌：按格子铺开，每张在自己格子里歪一点、挪一点 —— 乱但不互相压 */
function DiscardPool({ tiles }: { tiles: { tile: Tile; from: number; i: number }[] }) {
  // 每行放几张：牌多了就铺宽一点，始终塞得进中央那块地方
  const per = tiles.length <= 24 ? 8 : tiles.length <= 40 ? 10 : 12;
  return (
    <div className="mj-pool" style={{ gridTemplateColumns: `repeat(${per}, 1fr)` }}>
      {tiles.map(({ tile, i }) => {
        const j = jitter(i * 31 + tile);
        return (
          <span key={i} className="mj-pool-cell">
            <MjTile tile={tile} size="sm"
              style={{ transform: `translate(${j.dx}px, ${j.dy}px) rotate(${j.rot}deg)` }} />
          </span>
        );
      })}
    </div>
  );
}

/** 一方：头像在角上，手牌在左，下地在右 */
function SeatSide({ p, rel, mine, onDiscard, picked }: {
  p: MjSeatView; rel: 0 | 1 | 2 | 3; mine: boolean;
  onDiscard?: (t: Tile, i: number) => void; picked?: number;
}) {
  const pos = ['bottom', 'right', 'top', 'left'][rel];
  /* 左右两家是**竖着**排的：13 张手牌再加下地，用 xs 一列就下去 400 多像素，
     手机横屏根本装不下。侧面用 xxs，对家（横着排）用 xs。 */
  const size: 'xxs' | 'xs' | 'md' = mine ? 'md' : (rel === 1 || rel === 3) ? 'xxs' : 'xs';
  return (
    <div className={`mj-side mj-${pos} ${p.isTurn ? 'mj-turn' : ''}`}>
      {/* 头像钉在这一方的左端 —— 四个人的头像就落在四个角上 */}
      <div className="mj-who">
        <div className="mj-avatar">{p.name.slice(0, 2)}</div>
        <div className="mj-who-txt">
          <b>{p.name}{p.isDealer && <i className="mj-zhuang">庄</i>}</b>
          <span className={p.total > 0 ? 'pos' : p.total < 0 ? 'neg' : ''}>{p.total > 0 ? `+${p.total}` : p.total}</span>
        </div>
      </div>
      <div className="mj-row">
        {/* 手牌：自己的露面，别家只给背面 */}
        <div className="mj-hand">
          {p.hand
            ? p.hand.map((t, i) => (
              <MjTile key={i} tile={t} size={size}
                selected={picked === i}
                onClick={onDiscard ? () => onDiscard(t, i) : undefined}
                className={i === p.hand!.length - 1 && p.hand!.length % 3 === 2 ? 'mj-drawn' : undefined} />
            ))
            : Array.from({ length: p.handCount }, (_, i) => <MjTile key={i} back size={size} />)}
        </div>
        {/* 下地：碰 / 杠。暗杠中间两张扣着 */}
        <div className="mj-melds">
          {p.melds.map((m, i) => (
            <span key={i} className={`mj-meld${m.gang === 'an' ? ' mj-angang' : ''}`}>
              {m.type === 'peng'
                ? [0, 1, 2].map(k => <MjTile key={k} tile={m.tile} size={size} />)
                : [0, 1, 2, 3].map(k => (
                  <MjTile key={k} tile={m.tile} size={size}
                    back={m.gang === 'an' && !mine && (k === 1 || k === 2)} />
                ))}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function MjTable({ v, onDiscard, picked }: {
  v: MjTableView; onDiscard?: (t: Tile, i: number) => void; picked?: number;
}) {
  // 四家按"我在下方"转一圈：我 0、下家 1（右）、对家 2（上）、上家 3（左）
  const rel = (seat: number) => ((seat - v.mySeat + 4) % 4) as 0 | 1 | 2 | 3;
  // 中央那一堆：四家的弃牌混在一起，按打出的先后铺
  const pool = useMemo(() => {
    const all: { tile: Tile; from: number; i: number }[] = [];
    for (const p of v.players) p.discards.forEach((t, k) => all.push({ tile: t, from: p.seat, i: p.seat * 100 + k }));
    return all;
  }, [v.players]);

  return (
    <div className="mj-table">
      {/* 中央：牌墙一圈 + 弃牌一堆 */}
      <div className="mj-center">
        <div className="mj-pool-box">
          <span className="mj-wall-left">公共牌剩 {v.wallLeft} 张</span>
          <DiscardPool tiles={pool} />
        </div>
        {/* 刚打出来那张：亮一下，让人看清是哪一张 */}
        {v.table && <div className="mj-just"><MjTile tile={v.table.tile} size="sm" className="mj-table-tile" /></div>}
        {/* 翻出来的马 */}
        {v.ma !== null && <div className="mj-ma-box"><MjTile tile={v.ma} size="sm" className="mj-ma" /></div>}
      </div>

      {v.players.map(p => (
        <SeatSide key={p.seat} p={p} rel={rel(p.seat)} mine={p.seat === v.mySeat}
          onDiscard={p.seat === v.mySeat ? onDiscard : undefined} picked={p.seat === v.mySeat ? picked : undefined} />
      ))}
    </div>
  );
}
