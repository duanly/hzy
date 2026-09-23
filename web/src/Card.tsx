import { nameOf, isBig, isRed, type Kind } from '../../packages/engine/src/index.ts';
import { GLYPHS } from './glyphs.ts';
import { glyphFontOn } from './cardfont.ts';

/** 牌面那个字：选了"描出来的"字体就画 SVG，否则照常写字（用当前牌面字体） */
function Ch({ kind, big, color, cls }: { kind: Kind; big: boolean; color: string; cls: string }) {
  const d = glyphFontOn() ? GLYPHS[kind] : undefined;
  return <span className={`card-ch ${cls} ${big ? 'big' : 'small'} ${d ? 'card-ch-svg' : ''}`} style={{ color }}>
    {d ? <svg viewBox="0 0 100 100" aria-label={nameOf(kind)}><path d={d} fill="currentColor" fillRule="evenodd" /></svg>
       : nameOf(kind)}
  </span>;
}

export interface CardProps {
  kind: Kind;                // -1 = 牌背
  size?: 'xl' | 'lg' | 'md' | 'sm' | 'xs' | 'xxs';
  selected?: boolean;
  dim?: boolean;
  onClick?: () => void;
  highlight?: boolean;
  style?: React.CSSProperties;
  onPointerDown?: (e: React.PointerEvent) => void;
  onPointerMove?: (e: React.PointerEvent) => void;
  onPointerUp?: (e: React.PointerEvent) => void;
  onPointerCancel?: (e: React.PointerEvent) => void;
  head?: boolean;            // 只显示牌的"字头"（圆头部分），空间不够时用
  hint?: boolean;            // 可碰 / 可吃的提示高亮
  hintLabel?: string;        // 在第一张牌上标注"碰"/"吃"等
  className?: string;
}

/**
 * 字牌牌面（仿实物）：细长白牌，上端一个粗体大字、下端倒置同字，中部小红印。
 * 红字（二七十 / 贰柒拾）为红色。牌背：白边 + 玫红双线框 + 黄底团花纹。
 */
export function Card({ kind, size = 'md', selected, dim, onClick, highlight, style, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, head, hint, hintLabel, className }: CardProps) {
  const back = kind < 0;
  const cls = ['card', `card-${size}`, head ? 'card-headonly' : '', back ? 'card-back' : '', selected ? 'card-selected' : '', dim ? 'card-dim' : '', highlight ? 'card-hl' : '', hint ? 'card-hint' : '', (onClick || onPointerDown) ? 'card-click' : '', className ?? ''].filter(Boolean).join(' ');
  const h = { onClick, onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
  if (back) return <div className={cls} style={style} {...h}><div className="card-back-inner" /></div>;
  const color = isRed(kind) ? 'var(--red)' : 'var(--ink)';
  const big = isBig(kind);
  return (
    <div className={cls} style={style} {...h}>
      <Ch kind={kind} big={big} color={color} cls="top" />
      {hintLabel && <span className="card-hint-tag">{hintLabel}</span>}
      {!head && <><span className="card-seal" />
      <Ch kind={kind} big={big} color={color} cls="bottom" /></>}
    </div>
  );
}

/**
 * 一组牌（下地的组合 / 手牌中的一列）：像实物一样纵向错落叠放，
 * 每张只露出上端的字，最后一张完整露出。
 */
export function CardStack({ cards, size = 'md', selected, onCardClick, dim, hiddenFrom, heads, mark, markKind = 'hu', dotAt, className, style }: {
  cards: Kind[]; size?: CardProps['size']; selected?: Kind | null; onCardClick?: (k: Kind, idx: number) => void; dim?: boolean;
  hiddenFrom?: number; heads?: boolean; mark?: Kind | null;
  /** 角标写什么字：'hu' 红圈「胡」（亮牌、纪录表），'chi' 绿圈「吃」（挑吃法的时候标出吃进的那一张） */
  markKind?: 'hu' | 'chi';
  dotAt?: number; className?: string; style?: React.CSSProperties;
}) {
  const step = { xl: 47, lg: 40, md: 30, sm: 22, xs: 20, xxs: 15 }[size!];
  const h = { xl: 169, lg: 144, md: 108, sm: 80, xs: 70, xxs: 52 }[size!];
  // heads：最面上那张也只露字头，整组高度压到 张数 × 错位距离（下地牌用）
  const boxH = heads ? step * cards.length + 6 : h + step * (cards.length - 1);
  /* 牌背不调暗：别人偎 / 提的那几张，服务端发过来就是 -1。以前按"看不见的牌"一律调暗，
     结果同样一张牌背，别人的灰扑扑、自己的亮堂堂，看着像两种牌。 */
  return (
    <div className={`stack ${heads ? 'stack-heads' : ''} ${className ?? ''}`} style={{ height: boxH, ...style }}>
      {cards.map((k, i) => (
        <Card key={i} kind={hiddenFrom !== undefined && i >= hiddenFrom ? -1 : k} size={size} dim={dim}
          /* dotAt：这一张是「我这边出去的牌」，牌头点一个红点（见 .card-src） */
          className={[mark !== undefined && mark !== null && mark === k && i === cards.indexOf(k) ? `card-mark${markKind === 'chi' ? ' card-mark-chi' : ''}` : '',
                      dotAt === i ? 'card-src' : ''].filter(Boolean).join(' ') || undefined}
          selected={selected !== undefined && selected !== null && selected === k && i === cards.indexOf(k)}
          onClick={onCardClick ? () => onCardClick(k, i) : undefined} style={{ position: 'absolute', top: i * step, left: 0, zIndex: i }} />
      ))}
    </div>
  );
}
