/**
 * 麻将牌面组件
 *
 * 两套渲染模式：
 *  1. 图片模式（推荐）：从 /mj-tiles/ 加载真实牌面图片
 *     文件名：wan1~wan9 / tiao1~tiao9 / tong1~tong9 / hongzhong
 *  2. SVG 模式（兜底）：内联 SVG 绘制，图片缺失时自动回退
 *
 * 以后换图片只需要往 public/mj-tiles/ 里放，不用改代码。
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

/** 把牌号转成图片文件名 */
function tileImgName(t: Tile): string {
  if (t === HONG) return 'hongzhong';
  const suit = mjSuit(t);
  const rank = mjRank(t);
  return `${suit}${rank}`;
}

/* =========================================================
   SVG 牌面（兜底用，图片缺失时显示）
   ========================================================= */

function Tong({ x, y, r }: { x: number; y: number; r: number }) {
  return <g>
    <circle cx={x} cy={y} r={r} className="mj-ink-fill" />
    <circle cx={x} cy={y} r={r * 0.62} className="mj-paper-fill" />
    <circle cx={x} cy={y} r={r * 0.3} className="mj-red-fill" />
  </g>;
}

function Tiao({ x, y, h, w, red }: { x: number; y: number; h: number; w: number; red?: boolean }) {
  const cls = red ? 'mj-red-fill' : 'mj-green-fill';
  return <g>
    <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx={w * 0.45} className={cls} />
    <rect x={x - w / 2} y={y - h * 0.08} width={w} height={h * 0.16} className="mj-paper-fill" />
  </g>;
}

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

const TONG_LAYOUT: Record<number, [number, number][]> = {
  1: [[50, 50]],
  2: [[50, 30], [50, 70]],
  3: [[28, 26], [50, 50], [72, 74]],
  4: [[32, 32], [68, 32], [32, 68], [68, 68]],
  5: [[30, 28], [70, 28], [50, 50], [30, 72], [70, 72]],
  6: [[33, 26], [67, 26], [33, 50], [67, 50], [33, 74], [67, 74]],
  7: [[26, 20], [50, 26], [74, 32], [32, 62], [68, 62], [32, 84], [68, 84]],
  8: [[33, 20], [67, 20], [33, 40], [67, 40], [33, 60], [67, 60], [33, 80], [67, 80]],
  9: [[27, 26], [50, 26], [73, 26], [27, 50], [50, 50], [73, 50], [27, 74], [50, 74], [73, 74]],
};
const TIAO_LAYOUT: Record<number, [number, number][]> = {
  1: [[50, 50]],
  2: [[50, 29], [50, 71]],
  3: [[50, 24], [35, 70], [65, 70]],
  4: [[33, 30], [67, 30], [33, 70], [67, 70]],
  5: [[31, 25], [69, 25], [50, 50], [31, 75], [69, 75]],
  6: [[27, 30], [50, 30], [73, 30], [27, 70], [50, 70], [73, 70]],
  7: [[50, 18], [27, 50], [50, 50], [73, 50], [27, 80], [50, 80], [73, 80]],
  8: [[29, 30], [43, 30], [57, 30], [71, 30], [29, 70], [43, 70], [57, 70], [71, 70]],
  9: [[27, 24], [50, 24], [73, 24], [27, 50], [50, 50], [73, 50], [27, 76], [50, 76], [73, 76]],
};
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
  // tiao
  if (n === 1) return <svg viewBox="0 0 100 100" className="mj-face"><YaoJi cx={50} cy={50} s={52} /></svg>;
  const pts = TIAO_LAYOUT[n];
  const h = n <= 2 ? 36 : n <= 5 ? 26 : n <= 6 ? 24 : 20;
  const w = n <= 4 ? 12 : n <= 6 ? 10 : 8.5;
  const reds = TIAO_RED[n] ?? [];
  return <svg viewBox="0 0 100 100" className="mj-face">
    {pts.map(([x, y], i) => <Tiao key={i} x={x} y={y} h={h} w={w} red={reds.includes(i)} />)}
  </svg>;
}

/* =========================================================
   牌组件：图片优先，SVG 兜底
   ========================================================= */

export function MjTile({ tile, size = 'md', back, className, onClick, onPointerDown, selected, dim, style }: {
  tile?: Tile; size?: 'xxs' | 'xs' | 'sm' | 'md' | 'lg'; back?: boolean;
  className?: string; onClick?: () => void; onPointerDown?: (e: React.PointerEvent) => void; selected?: boolean; dim?: boolean;
  style?: React.CSSProperties;
}) {
  const [hasImg, setHasImg] = React.useState<boolean | null>(null); // null=加载中, true=成功, false=失败
  const baseCls = `mj-tile mj-${size}${selected ? ' mj-sel' : ''}${dim ? ' mj-dim' : ''}${back ? ' mj-back' : ''}${hasImg ? ' mj-tile-has-img' : ''}${className ? ' ' + className : ''}`;
  const title = back || tile === undefined ? undefined : mjName(tile);

  // 背面：纯 CSS，不用图
  if (back || tile === undefined) {
    return <div className={baseCls} style={style} onClick={onClick} onPointerDown={onPointerDown} title={title} />;
  }

  // 正面：图片在上，SVG 在下当兜底
  // 图片加载中 / 失败时显示 SVG；加载成功后图片盖在上面
  const imgSrc = `/mj-tiles/${tileImgName(tile)}.png`;

  return (
    <div className={baseCls} style={style} onClick={onClick} onPointerDown={onPointerDown} title={title}>
      {/* SVG 兜底：始终渲染，图片加载成功后会被盖住 */}
      {hasImg !== true && (
        <div className="mj-face-fallback" style={{ width: '100%', height: '100%' }}>
          <MjFace tile={tile} />
        </div>
      )}
      {/* 图片：加载成功后显示 */}
      {hasImg !== false && (
        <img
          src={imgSrc}
          alt=""
          className="mj-tile-img"
          style={{ position: 'absolute', inset: 0, opacity: hasImg === true ? 1 : 0, transition: 'opacity .15s' }}
          onLoad={() => setHasImg(true)}
          onError={() => setHasImg(false)}
          draggable={false}
        />
      )}
    </div>
  );
}
