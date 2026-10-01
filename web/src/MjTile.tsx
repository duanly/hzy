/**
 * 麻将牌组件（图片版）
 *
 * 牌体和牌面直接从原图中抠出，使用 PNG 图片展示。
 * 三种角度：
 *   - standing: 立牌（手牌，大仰角）
 *   - flat: 平牌（弃牌区/下地，牌面朝上，小仰角）
 *   - back: 牌背（背面朝上）
 */
import React from 'react';

export type Tile = number;   // 0..27，跟 packages/mahjong/src/tiles.ts 一致
export const HONG = 27;

const RANK_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

// 牌名到文件名的映射
const TILE_FACE_NAMES: Record<number, string> = {
  0: 'wan1', 1: 'wan2', 2: 'wan3', 3: 'wan4', 4: 'wan5',
  5: 'wan6', 6: 'wan7', 7: 'wan8', 8: 'wan9',
  9: 'tiao1', 10: 'tiao2', 11: 'tiao3', 12: 'tiao4', 13: 'tiao5',
  14: 'tiao6', 15: 'tiao7', 16: 'tiao8', 17: 'tiao9',
  18: 'tong1', 19: 'tong2', 20: 'tong3', 21: 'tong4', 22: 'tong5',
  23: 'tong6', 24: 'tong7', 25: 'tong8', 26: 'tong9',
  27: 'hongzhong',
};

export function mjSuit(t: Tile) {
  if (t === HONG) return 'hong';
  if (t < 9) return 'wan';
  if (t < 18) return 'tiao';
  return 'tong';
}
export function mjRank(t: Tile) { return t === HONG ? 0 : (t % 9) + 1; }
export function mjName(t: Tile) {
  if (t === HONG) return '红中';
  if (t < 0 || t > 26) return '';
  const s = mjSuit(t);
  return RANK_CN[mjRank(t) - 1] + (s === 'wan' ? '万' : s === 'tiao' ? '条' : '筒');
}

// 图片路径
function faceImgSrc(tile: Tile, variant: 'standing' | 'flat' = 'standing') {
  const name = TILE_FACE_NAMES[tile];
  if (!name) return '';
  if (variant === 'flat') {
    return `mj-tile-bodies/faces-flat/${name}-face.png`;
  }
  return `mj-tile-bodies/faces-standing/${name}-face.png`;
}

export function MjFace({ tile }: { tile: Tile }) {
  const src = faceImgSrc(tile, 'standing');
  return (
    <img
      src={src}
      alt={mjName(tile)}
      style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
      draggable={false}
    />
  );
}

/* ============================================================
   牌组件：带尺寸的外层容器
   ============================================================ */

export function MjTile({ tile, size = 'md', back, className, onClick, onPointerDown, selected, dim, style, variant = 'standing' }: {
  tile?: Tile; size?: 'xxs' | 'xs' | 'sm' | 'md' | 'ml' | 'lg'; back?: boolean;
  className?: string; onClick?: () => void; onPointerDown?: (e: React.PointerEvent) => void; selected?: boolean; dim?: boolean;
  style?: React.CSSProperties;
  variant?: 'standing' | 'flat';
}) {
  const baseCls = `mj-tile mj-${size}${variant === 'flat' ? ' mj-tile-flat' : ''}${selected ? ' mj-sel' : ''}${dim ? ' mj-dim' : ''}${back ? ' mj-back' : ''}${className ? ' ' + className : ''}`;
  const title = back || tile === undefined ? undefined : mjName(tile);

  // 背面
  if (back || tile === undefined) {
    return (
      <div className={baseCls} style={style} onClick={onClick} onPointerDown={onPointerDown} title={title}>
        <img
          src="mj-tile-bodies/tile-back.png"
          alt="牌背"
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
          draggable={false}
        />
      </div>
    );
  }

  const src = faceImgSrc(tile, variant);

  return (
    <div className={baseCls} style={style} onClick={onClick} onPointerDown={onPointerDown} title={title}>
      <img
        src={src}
        alt={mjName(tile)}
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        draggable={false}
      />
    </div>
  );
}
