/**
 * 麻将牌面组件（纯 SVG 矢量版）
 *
 * 牌面统一用 SVG 绘制：
 *  - 万子 / 风牌 / 红中 / 白板：用中文字体（跟跑胡子一致）
 *  - 条子：SVG 矢量绘制的竹节形
 *  - 筒子：SVG 矢量绘制的同心圆
 *
 * 牌体：白底 + 绿色侧边 + 顶部高光 + 底部阴影，立体效果
 */
import React from 'react';

export type Tile = number;   // 0..27，跟 packages/mahjong/src/tiles.ts 一致
export const HONG = 27;

const RANK_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const RANK_BIG = ['壹', '貳', '參', '肆', '伍', '陸', '柒', '捌', '玖'];  // 大写数字（万子上面那个）
const WIND_CN: Record<number, string> = { 0: '东', 1: '南', 2: '西', 3: '北' };

export function mjSuit(t: Tile) {
  if (t === HONG) return 'hong';
  if (t < 9) return 'wan';
  if (t < 18) return 'tiao';
  return 'tong';
}
export function mjRank(t: Tile) { return t === HONG ? 0 : (t % 9) + 1; }
export function mjName(t: Tile) {
  if (t === HONG) return '红中';
  const s = mjSuit(t);
  return RANK_CN[mjRank(t) - 1] + (s === 'wan' ? '万' : s === 'tiao' ? '条' : '筒');
}

/* ============================================================
   牌体背景：白色 + 绿边 + 立体效果
   ============================================================ */

function TileBody({ children }: { children?: React.ReactNode }) {
  return (
    <svg viewBox="0 0 60 80" className="mj-face" preserveAspectRatio="xMidYMid meet">
      <defs>
        {/* 牌面白色渐变（顶部稍亮，底部稍暗） */}
        <linearGradient id="mj-face-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#e8e8e8" />
        </linearGradient>
        {/* 侧边绿色渐变 */}
        <linearGradient id="mj-side-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2d8b4a" />
          <stop offset="50%" stopColor="#1e6b36" />
          <stop offset="100%" stopColor="#144a23" />
        </linearGradient>
        {/* 顶部高光 */}
        <linearGradient id="mj-top-glow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.8" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        {/* 浮雕效果 - 内阴影 */}
        <filter id="mj-emboss" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="0.8" result="blur" />
          <feSpecularLighting in="blur" surfaceScale="1.5" specularConstant="0.5"
            specularExponent="20" lightingColor="#ffffff" result="specOut">
            <fePointLight x="-50" y="-50" z="80" />
          </feSpecularLighting>
          <feComposite in="specOut" in2="SourceAlpha" operator="in" result="specOut2" />
          <feComposite in="SourceGraphic" in2="specOut2" operator="arithmetic"
            k1="0" k2="1" k3="1" k4="0" />
        </filter>
      </defs>

      {/* 底部阴影 */}
      <rect x="2" y="3" width="56" height="76" rx="5" fill="rgba(0,0,0,0.25)" />

      {/* 侧边（绿色） */}
      <rect x="1" y="2" width="58" height="76" rx="5" fill="url(#mj-side-grad)" />

      {/* 牌面（白色） */}
      <rect x="2" y="1" width="56" height="72" rx="4" fill="url(#mj-face-grad)" />

      {/* 顶部高光条 */}
      <rect x="3" y="2" width="54" height="6" rx="3" fill="url(#mj-top-glow)" />

      {/* 牌面内容区 */}
      <g transform="translate(2, 1)">
        {children}
      </g>
    </svg>
  );
}

/* ============================================================
   万子：上面数字（黑），下面「万」（红）
   ============================================================ */

function WanFace({ n }: { n: number }) {
  return (
    <TileBody>
      <svg x="0" y="0" width="56" height="72" viewBox="0 0 56 72">
        {/* 上面的大写数字 */}
        <text x="28" y="25" textAnchor="middle" dominantBaseline="middle"
          style={{ fontSize: '24px', fontWeight: 900, fill: '#1a1a1a',
            fontFamily: '"STKaiti", "KaiTi", "楷体", "Ma Shan Zheng", serif' }}>
          {RANK_BIG[n - 1]}
        </text>
        {/* 下面的万字（繁体） */}
        <text x="28" y="54" textAnchor="middle" dominantBaseline="middle"
          style={{ fontSize: '30px', fontWeight: 900, fill: '#c41e1e',
            fontFamily: '"STKaiti", "KaiTi", "楷体", "Ma Shan Zheng", serif' }}>
          萬
        </text>
      </svg>
    </TileBody>
  );
}

/* ============================================================
   红中
   ============================================================ */

function HongFace() {
  return (
    <TileBody>
      <svg x="0" y="0" width="56" height="72" viewBox="0 0 56 72">
        <text x="28" y="38" textAnchor="middle" dominantBaseline="middle"
          style={{ fontSize: '44px', fontWeight: 900, fill: '#c41e1e',
            fontFamily: '"STKaiti", "KaiTi", "楷体", "Ma Shan Zheng", serif',
            textShadow: '1px 1px 0 rgba(255,255,255,0.4)' }}>
          中
        </text>
      </svg>
    </TileBody>
  );
}

/* ============================================================
   筒子：同心圆图案
   ============================================================ */

/** 单个筒 */
function Tong({ cx, cy, r, color }: { cx: number; cy: number; r: number; color: string }) {
  return (
    <g>
      {/* 外圈 */}
      <circle cx={cx} cy={cy} r={r} fill={color} />
      <circle cx={cx} cy={cy} r={r * 0.78} fill="#fff" />
      <circle cx={cx} cy={cy} r={r * 0.58} fill={color} />
      <circle cx={cx} cy={cy} r={r * 0.4} fill="#fff" />
      <circle cx={cx} cy={cy} r={r * 0.22} fill={color} />
      {/* 高光 */}
      <ellipse cx={cx - r * 0.25} cy={cy - r * 0.3} rx={r * 0.15} ry={r * 0.1}
        fill="rgba(255,255,255,0.6)" />
    </g>
  );
}

/** 一筒（特殊：大花） */
function Tong1Face() {
  return (
    <TileBody>
      <svg x="0" y="0" width="56" height="72" viewBox="0 0 56 72">
        <g transform="translate(28, 36)">
          {/* 最外圈绿 */}
          <circle r="22" fill="#2d8b4a" />
          <circle r="19.5" fill="#fff" />
          {/* 花瓣圈 */}
          <circle r="17" fill="#2d8b4a" />
          {/* 8 个花瓣（白色月牙形） */}
          {[0, 45, 90, 135, 180, 225, 270, 315].map((deg, i) => (
            <ellipse key={i}
              cx={Math.cos(deg * Math.PI / 180) * 13.5}
              cy={Math.sin(deg * Math.PI / 180) * 13.5}
              rx="3.5" ry="5.5"
              fill="#fff"
              transform={`rotate(${deg}, ${Math.cos(deg * Math.PI / 180) * 13.5}, ${Math.sin(deg * Math.PI / 180) * 13.5})`}
            />
          ))}
          {/* 中心红圈 */}
          <circle r="9" fill="#fff" />
          <circle r="7.5" fill="#c41e1e" />
          <circle r="5" fill="#fff" />
          <circle r="3" fill="#c41e1e" />
          {/* 高光 */}
          <ellipse cx="-5" cy="-8" rx="4" ry="2.5" fill="rgba(255,255,255,0.5)" />
        </g>
      </svg>
    </TileBody>
  );
}

const TONG_COLORS: Record<number, string[]> = {
  1: ['#2d8b4a'],
  2: ['#1a8a38', '#1a8a38'],
  3: ['#1a8a38', '#c41e1e', '#1a1a1a'],
  4: ['#1a1a1a', '#1a8a38', '#1a8a38', '#1a1a1a'],
  5: ['#1a8a38', '#1a1a1a', '#c41e1e', '#1a1a1a', '#1a8a38'],
  6: ['#1a8a38', '#1a8a38', '#1a1a1a', '#1a1a1a', '#1a8a38', '#1a8a38'],
  7: ['#1a8a38', '#1a8a38', '#1a8a38', '#c41e1e', '#1a1a1a', '#1a1a1a', '#1a1a1a'],
  8: ['#1a1a1a', '#1a1a1a', '#1a8a38', '#1a8a38', '#1a8a38', '#1a8a38', '#1a1a1a', '#1a1a1a'],
  9: ['#c41e1e', '#c41e1e', '#c41e1e', '#1a8a38', '#1a8a38', '#1a8a38', '#1a1a1a', '#1a1a1a', '#1a1a1a'],
};

/** 筒子布局：[row, col] 位置 */
const TONG_LAYOUT: Record<number, [number, number][]> = {
  2: [[0, 0], [2, 0]],
  3: [[0, 0], [1, 1], [2, 0]],
  4: [[0, 0], [0, 2], [2, 0], [2, 2]],
  5: [[0, 0], [0, 2], [1, 1], [2, 0], [2, 2]],
  6: [[0, 0], [0, 2], [1, 0], [1, 2], [2, 0], [2, 2]],
  7: [[0, 0], [0, 1], [0, 2], [1, 1], [2, 0], [2, 1], [2, 2]],
  8: [[0, 0], [0, 2], [1, 0], [1, 2], [2, 0], [2, 2], [3, 0], [3, 2]],
  9: [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]],
};

function TongFace({ n }: { n: number }) {
  if (n === 1) return <Tong1Face />;

  const colors = TONG_COLORS[n] ?? [];
  const layout = TONG_LAYOUT[n] ?? [];

  // 计算布局尺寸
  const rows = Math.max(...layout.map(([r]) => r)) + 1;
  const cols = Math.max(...layout.map(([, c]) => c)) + 1;
  const cellW = 52 / (cols + 0.5);
  const cellH = 68 / (rows + 0.5);
  const r = Math.min(cellW, cellH) * 0.38;
  const offsetX = (56 - (cols - 1) * cellW - 2 * r) / 2 + r;
  const offsetY = (72 - (rows - 1) * cellH - 2 * r) / 2 + r;

  return (
    <TileBody>
      <svg x="0" y="0" width="56" height="72" viewBox="0 0 56 72">
        {layout.map(([row, col], i) => (
          <Tong key={i}
            cx={offsetX + col * cellW}
            cy={offsetY + row * cellH}
            r={r}
            color={colors[i] ?? '#1a8a38'} />
        ))}
      </svg>
    </TileBody>
  );
}

/* ============================================================
   条子：波浪花边长条形
   ============================================================ */

/**
 * 单个条子（竖放）：三节波浪花边形状，中间一道白缝
 * 形状像花生壳/八字形长椭圆，两侧各有 3 个波浪凸起
 */
function TiaoStick({ cx, cy, w, h, color }: { cx: number; cy: number; w: number; h: number; color: string }) {
  const hw = w / 2;
  const hh = h / 2;
  // 用 path 画波浪边的长条形
  // 左右两侧各有 3 个波浪凸起（上、中、下）
  const sideWave = (xBase: number, dir: 1 | -1) => {
    // 从顶部开始，向下走，侧边有波浪
    const bulge = hw * 0.28;  // 波浪凸起的大小
    return `
      M ${xBase} ${cy - hh}
      Q ${xBase + dir * bulge} ${cy - hh * 0.68} ${xBase} ${cy - hh * 0.36}
      Q ${xBase + dir * bulge} ${cy - hh * 0.04} ${xBase} ${cy + hh * 0.04}
      Q ${xBase + dir * bulge} ${cy + hh * 0.36} ${xBase} ${cy + hh * 0.68}
      Q ${xBase + dir * bulge} ${cy + hh} ${xBase} ${cy + hh}
    `;
  };

  return (
    <g>
      {/* 主体：波浪边长条 */}
      <path
        d={`
          ${sideWave(cx - hw, -1)}
          L ${cx + hw} ${cy + hh}
          Q ${cx + hw + 1 * 0} ${cy + hh * 0.68} ${cx + hw} ${cy + hh * 0.36}
          Q ${cx + hw + hw * 0.28} ${cy + hh * 0.04} ${cx + hw} ${cy - hh * 0.04}
          Q ${cx + hw + hw * 0.28} ${cy - hh * 0.36} ${cx + hw} ${cy - hh * 0.68}
          Q ${cx + hw} ${cy - hh} ${cx + hw} ${cy - hh}
          Z
        `}
        fill={color}
      />
      {/* 顶部圆弧 */}
      <ellipse cx={cx} cy={cy - hh + hw * 0.3} rx={hw * 0.85} ry={hw * 0.5} fill={color} />
      {/* 底部圆弧 */}
      <ellipse cx={cx} cy={cy + hh - hw * 0.3} rx={hw * 0.85} ry={hw * 0.5} fill={color} />
      {/* 中间白色竖线（缝隙） */}
      <rect x={cx - hw * 0.15} y={cy - hh + hw * 0.6} width={hw * 0.3} height={h - hw * 1.2}
        fill="#fff" rx={hw * 0.12} />
      {/* 高光 */}
      <ellipse cx={cx - hw * 0.35} cy={cy - hh * 0.3} rx={hw * 0.12} ry={hh * 0.25}
        fill="rgba(255,255,255,0.3)" />
    </g>
  );
}

/** 一条（幺鸡） */
function YaoJiFace() {
  return (
    <TileBody>
      <svg x="0" y="0" width="56" height="72" viewBox="0 0 56 72">
        <g transform="translate(28, 36)">
          {/* 简化版幺鸡：鸟形图案 */}
          {/* 身体 */}
          <ellipse cx="0" cy="2" rx="12" ry="14" fill="#1a8a38" />
          {/* 肚子白色 */}
          <ellipse cx="0" cy="5" rx="7" ry="8" fill="#fff" />
          {/* 头 */}
          <circle cx="-3" cy="-14" r="7" fill="#1a8a38" />
          {/* 眼睛 */}
          <circle cx="-5" cy="-15" r="2.5" fill="#fff" />
          <circle cx="-5" cy="-15" r="1.3" fill="#c41e1e" />
          {/* 嘴 */}
          <path d="M-10,-12 l-6,-2 l6,-1 z" fill="#c41e1e" />
          {/* 冠子 */}
          <path d="M-5,-20 q0,-4 3,-5 q2,3 0,5 z" fill="#c41e1e" />
          {/* 翅膀 */}
          <path d="M-8,-2 q-8,4 -6,14 q6,-2 8,-8 z" fill="#1a8a38" />
          <path d="M8,0 q6,3 5,12 q-5,-2 -6,-9 z" fill="#1a8a38" />
          {/* 尾巴 */}
          <path d="M2,12 q8,6 10,16 l-6,-4 z" fill="#1a8a38" />
          <path d="M-2,12 q-4,8 -2,18 l5,-5 z" fill="#1a8a38" />
          {/* 脚 */}
          <path d="M-4,15 l-2,8 M-2,17 l0,7 M0,15 l2,8" stroke="#c41e1e" strokeWidth="1.5" strokeLinecap="round" fill="none" />
          {/* 竹枝（爪子抓的） */}
          <path d="M-14,22 q14,-2 28,4" stroke="#1a8a38" strokeWidth="2" fill="none" strokeLinecap="round" />
        </g>
      </svg>
    </TileBody>
  );
}

const TIAO_COLORS: Record<number, number[]> = {
  2: [],     // 全绿
  3: [],     // 全绿
  4: [],     // 全绿
  5: [2],    // 中间那条红
  6: [],     // 全绿
  7: [0],    // 第一条红（上面那根）
  9: [],     // 全绿
};

const TIAO_LAYOUT: Record<number, [number, number][]> = {
  2: [[0, 0], [1, 0]],
  3: [[0, 0], [1, 1], [2, 0]],
  4: [[0, 0], [0, 1], [1, 0], [1, 1]],
  5: [[0, 0], [0, 1], [1, 0.5], [2, 0], [2, 1]],
  6: [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1]],
  7: [[0, 0.5], [1, 0], [1, 1], [2, 0], [2, 1], [3, 0], [3, 1]],
  9: [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]],
};

/** 八条特殊图案：两个对顶的 M 形（人形） */
function BaTiaoFace() {
  const color = '#1a8a38';
  // 每个人形图案（M/W 形）
  const PersonShape = ({ cx, cy, w, h, flip = false }: { cx: number; cy: number; w: number; h: number; flip?: boolean }) => {
    const hw = w / 2;
    const hh = h / 2;
    const dir = flip ? -1 : 1;
    // 画一个 M 形：中间高，两边低，带波浪花边
    // 用 path 画外轮廓，中间有白色缝隙
    const bulge = hw * 0.25;
    return (
      <g transform={`translate(${cx}, ${cy})`}>
        {/* 左边一竖 */}
        <path
          d={`
            M ${-hw} ${-hh * dir}
            Q ${-hw - bulge} ${-hh * 0.5 * dir} ${-hw} ${0}
            Q ${-hw - bulge} ${hh * 0.5 * dir} ${-hw} ${hh * dir}
          `}
          stroke={color}
          strokeWidth={hw * 0.65}
          fill="none"
          strokeLinecap="round"
        />
        {/* 右边一竖 */}
        <path
          d={`
            M ${hw} ${-hh * dir}
            Q ${hw + bulge} ${-hh * 0.5 * dir} ${hw} ${0}
            Q ${hw + bulge} ${hh * 0.5 * dir} ${hw} ${hh * dir}
          `}
          stroke={color}
          strokeWidth={hw * 0.65}
          fill="none"
          strokeLinecap="round"
        />
        {/* 中间的 V 形（连接左右） */}
        <path
          d={`
            M ${-hw * 0.3} ${-hh * 0.3 * dir}
            Q 0 ${-hh * 0.7 * dir} ${hw * 0.3} ${-hh * 0.3 * dir}
            Q 0 ${hh * 0.1 * dir} ${-hw * 0.3} ${-hh * 0.3 * dir}
          `}
          fill={color}
        />
        {/* 中间白缝 */}
        <path
          d={`
            M ${-hw * 0.15} ${-hh * 0.4 * dir}
            Q 0 ${-hh * 0.55 * dir} ${hw * 0.15} ${-hh * 0.4 * dir}
          `}
          stroke="#fff"
          strokeWidth={hw * 0.15}
          fill="none"
          strokeLinecap="round"
        />
      </g>
    );
  };

  return (
    <TileBody>
      <svg x="0" y="0" width="56" height="72" viewBox="0 0 56 72">
        {/* 上面那个人（倒过来） */}
        <PersonShape cx={28} cy={20} w={36} h={22} flip={true} />
        {/* 下面那个人 */}
        <PersonShape cx={28} cy={52} w={36} h={22} flip={false} />
      </svg>
    </TileBody>
  );
}

function TiaoFace({ n }: { n: number }) {
  if (n === 1) return <YaoJiFace />;
  if (n === 8) return <BaTiaoFace />;

  const redIdx = new Set(TIAO_COLORS[n] ?? []);
  const layout = TIAO_LAYOUT[n] ?? [];

  const rows = Math.max(...layout.map(([r]) => r)) + 1;
  const cols = Math.max(...layout.map(([, c]) => c)) + 1;
  const cellW = 50 / Math.max(cols, 1);
  const cellH = 64 / Math.max(rows, 1);
  const stickW = Math.min(cellW * 0.4, 10);
  const stickH = cellH * 0.82;
  const offsetX = (56 - (cols - 1) * cellW - stickW) / 2 + stickW / 2;
  const offsetY = (72 - (rows - 1) * cellH - stickH) / 2 + stickH / 2;

  return (
    <TileBody>
      <svg x="0" y="0" width="56" height="72" viewBox="0 0 56 72">
        {layout.map(([row, col], i) => (
          <TiaoStick key={i}
            cx={offsetX + col * cellW}
            cy={offsetY + row * cellH}
            w={stickW}
            h={stickH}
            color={redIdx.has(i) ? '#c41e1e' : '#1a8a38'} />
        ))}
      </svg>
    </TileBody>
  );
}

/* ============================================================
   牌面组件：根据牌型选对应的 SVG 绘制
   ============================================================ */

export function MjFace({ tile }: { tile: Tile }) {
  const suit = mjSuit(tile);
  if (suit === 'hong') return <HongFace />;
  if (suit === 'wan') return <WanFace n={mjRank(tile)} />;
  if (suit === 'tong') return <TongFace n={mjRank(tile)} />;
  return <TiaoFace n={mjRank(tile)} />;
}

/* ============================================================
   牌组件：带尺寸的外层容器
   ============================================================ */

export function MjTile({ tile, size = 'md', back, className, onClick, onPointerDown, selected, dim, style }: {
  tile?: Tile; size?: 'xxs' | 'xs' | 'sm' | 'md' | 'lg'; back?: boolean;
  className?: string; onClick?: () => void; onPointerDown?: (e: React.PointerEvent) => void; selected?: boolean; dim?: boolean;
  style?: React.CSSProperties;
}) {
  const baseCls = `mj-tile mj-${size}${selected ? ' mj-sel' : ''}${dim ? ' mj-dim' : ''}${back ? ' mj-back' : ''}${className ? ' ' + className : ''}`;
  const title = back || tile === undefined ? undefined : mjName(tile);

  // 背面：纯 CSS 渐变
  if (back || tile === undefined) {
    return (
      <div className={baseCls} style={style} onClick={onClick} onPointerDown={onPointerDown} title={title}>
        <div className="mj-tile-back-face" />
      </div>
    );
  }

  return (
    <div className={baseCls} style={style} onClick={onClick} onPointerDown={onPointerDown} title={title}>
      <div className="mj-tile-svg" style={{ width: '100%', height: '100%' }}>
        <MjFace tile={tile} />
      </div>
    </div>
  );
}
