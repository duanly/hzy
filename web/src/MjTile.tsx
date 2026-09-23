/**
 * 麻将牌面：万 / 条 / 筒 各 1~9 + 红中。
 *
 * 全是**画出来的**（内联 SVG），不用图片也不用字体：
 *  · 条和筒本来就是图形，拿字体拼不出来；
 *  · 图片要么糊要么大，一套 28 张还得考虑两倍图；
 *  · SVG 随便缩放都清楚，配色也能跟着主题走。
 * 万字用汉字（一~九 + 万），那本来就是字。
 */
import React from 'react';

export type Tile = number;   // 0..27，跟 packages/mahjong/src/tiles.ts 一致
export const HONG = 27;

const RANK_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
export function mjSuit(t: Tile) { return t === HONG ? 'hong' : t < 9 ? 'wan' : t < 18 ? 'tiao' : 'tong'; }
export function mjRank(t: Tile) { return t === HONG ? 0 : (t % 9) + 1; }
export function mjName(t: Tile) {
  if (t === HONG) return '红中';
  const s = mjSuit(t);
  return RANK_CN[mjRank(t) - 1] + (s === 'wan' ? '万' : s === 'tiao' ? '条' : '筒');
}

/* ---------- 一个筒：同心双环 ---------- */
function Tong({ x, y, r }: { x: number; y: number; r: number }) {
  return <g>
    <circle cx={x} cy={y} r={r} className="mj-ink-fill" />
    <circle cx={x} cy={y} r={r * 0.62} className="mj-paper-fill" />
    <circle cx={x} cy={y} r={r * 0.3} className="mj-red-fill" />
  </g>;
}

/* ---------- 一根条：竹节 ---------- */
function Tiao({ x, y, h, w, red }: { x: number; y: number; h: number; w: number; red?: boolean }) {
  const cls = red ? 'mj-red-fill' : 'mj-green-fill';
  return <g>
    <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx={w * 0.45} className={cls} />
    {/* 中间勒一道，看着像竹节 */}
    <rect x={x - w / 2} y={y - h * 0.08} width={w} height={h * 0.16} className="mj-paper-fill" />
  </g>;
}

/** 一条（幺鸡）：传统上画只鸟。这儿画个简化的雀，比一根光条认得快 */
function YaoJi({ cx, cy, s }: { cx: number; cy: number; s: number }) {
  return <g>
    <ellipse cx={cx} cy={cy + s * 0.18} rx={s * 0.26} ry={s * 0.38} className="mj-green-fill" />
    <circle cx={cx} cy={cy - s * 0.32} r={s * 0.19} className="mj-green-fill" />
    <path d={`M${cx + s * 0.17} ${cy - s * 0.34} l${s * 0.22} ${s * 0.07} l${-s * 0.22} ${s * 0.09} z`} className="mj-red-fill" />
    <circle cx={cx - s * 0.06} cy={cy - s * 0.36} r={s * 0.045} className="mj-ink-fill" />
    <path d={`M${cx - s * 0.2} ${cy + s * 0.12} q${-s * 0.24} ${s * 0.22} ${s * 0.04} ${s * 0.38}`}
      className="mj-red-stroke" fill="none" strokeWidth={s * 0.08} strokeLinecap="round" />
  </g>;
}

/* 点子怎么摆 —— **筒和条不是一个排法**，两张表分开。
   筒是圆点，三筒斜着一串、五筒摆成梅花，这是真牌上的样子；
   条是竖着的竹节，讲究的是成行成列。一开始我两边共用一张表，
   结果三条、五条被摆成了筒的斜线和梅花点，一眼就不对。 */
const TONG_LAYOUT: Record<number, [number, number][]> = {
  1: [[50, 50]],
  2: [[50, 30], [50, 70]],
  3: [[28, 26], [50, 50], [72, 74]],                       // 斜着一串
  4: [[32, 32], [68, 32], [32, 68], [68, 68]],
  5: [[30, 28], [70, 28], [50, 50], [30, 72], [70, 72]],   // 梅花
  6: [[33, 26], [67, 26], [33, 50], [67, 50], [33, 74], [67, 74]],
  7: [[26, 20], [50, 26], [74, 32], [32, 62], [68, 62], [32, 84], [68, 84]],   // 上三斜、下四方
  8: [[33, 20], [67, 20], [33, 40], [67, 40], [33, 60], [67, 60], [33, 80], [67, 80]],
  9: [[27, 26], [50, 26], [73, 26], [27, 50], [50, 50], [73, 50], [27, 74], [50, 74], [73, 74]],
};
const TIAO_LAYOUT: Record<number, [number, number][]> = {
  1: [[50, 50]],                                            // 幺鸡，另画
  2: [[50, 29], [50, 71]],
  3: [[50, 24], [35, 70], [65, 70]],                        // 上一下二
  4: [[33, 30], [67, 30], [33, 70], [67, 70]],
  5: [[31, 25], [69, 25], [50, 50], [31, 75], [69, 75]],    // 上二中一下二，中间那根是红的
  6: [[27, 30], [50, 30], [73, 30], [27, 70], [50, 70], [73, 70]],
  7: [[50, 18], [27, 50], [50, 50], [73, 50], [27, 80], [50, 80], [73, 80]],   // 顶上一根红的
  8: [[29, 30], [43, 30], [57, 30], [71, 30], [29, 70], [43, 70], [57, 70], [71, 70]],
  9: [[27, 24], [50, 24], [73, 24], [27, 50], [50, 50], [73, 50], [27, 76], [50, 76], [73, 76]],
};
/* 条上哪几根是红的（下标对着上面那张表）：真牌上不是全绿 */
const TIAO_RED: Record<number, number[]> = { 1: [], 2: [], 3: [], 4: [], 5: [2], 6: [], 7: [0], 8: [], 9: [] };

export function MjFace({ tile }: { tile: Tile }) {
  if (tile === HONG) {
    return <svg viewBox="0 0 100 100" className="mj-face">
      <text x="50" y="50" className="mj-red-text mj-big" dominantBaseline="central" textAnchor="middle">中</text>
    </svg>;
  }
  const suit = mjSuit(tile), n = mjRank(tile);
  if (suit === 'wan') {
    return <svg viewBox="0 0 100 100" className="mj-face">
      <text x="50" y="33" className="mj-ink-text mj-mid" dominantBaseline="central" textAnchor="middle">{RANK_CN[n - 1]}</text>
      <text x="50" y="72" className="mj-red-text mj-mid" dominantBaseline="central" textAnchor="middle">万</text>
    </svg>;
  }
  if (suit === 'tong') {
    const pts = TONG_LAYOUT[n];
    const r = n <= 2 ? 15 : n <= 4 ? 13 : n <= 6 ? 11.5 : 9.5;
    return <svg viewBox="0 0 100 100" className="mj-face">
      {pts.map(([x, y], i) => <Tong key={i} x={x} y={y} r={r} />)}
    </svg>;
  }
  // 条
  if (n === 1) return <svg viewBox="0 0 100 100" className="mj-face"><YaoJi cx={50} cy={50} s={52} /></svg>;
  const pts = TIAO_LAYOUT[n];
  const h = n <= 2 ? 36 : n <= 5 ? 26 : n <= 6 ? 24 : 20;
  const w = n <= 4 ? 12 : n <= 6 ? 10 : 8.5;
  const reds = TIAO_RED[n] ?? [];
  return <svg viewBox="0 0 100 100" className="mj-face">
    {pts.map(([x, y], i) => <Tiao key={i} x={x} y={y} h={h} w={w} red={reds.includes(i)} />)}
  </svg>;
}

/**
 * 一张牌。size 跟字牌那套对齐：xxs 复盘用、xs 别人的弃牌、sm 下地、md 自己的手牌。
 * back = 背面（别人的手牌）。
 */
export function MjTile({ tile, size = 'md', back, className, onClick, selected, dim, style }: {
  tile?: Tile; size?: 'xxs' | 'xs' | 'sm' | 'md'; back?: boolean;
  className?: string; onClick?: () => void; selected?: boolean; dim?: boolean;
  style?: React.CSSProperties;
}) {
  const cls = `mj-tile mj-${size}${selected ? ' mj-sel' : ''}${dim ? ' mj-dim' : ''}${back ? ' mj-back' : ''}${className ? ' ' + className : ''}`;
  return (
    <div className={cls} style={style} onClick={onClick} title={back || tile === undefined ? undefined : mjName(tile)}>
      {!back && tile !== undefined && <MjFace tile={tile} />}
    </div>
  );
}
