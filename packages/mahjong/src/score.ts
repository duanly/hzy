/**
 * 红中麻将算分
 *
 * 只自摸，不点炮，所以每一局的输赢就两笔：
 *   · 杠分：杠的那一刻就结（明杠 1 倍底分、暗杠 2 倍），三家各付。
 *   · 胡分：胡的时候翻一张马，按下面这套算，三家各付。
 *
 * 胡分 = 底分 ×（1 + 马牌倍数）×（无中胡 ? 2 : 1）
 *   · 那个 1 是胡牌本身。
 *   · 马牌倍数：翻出来的是几点就是几倍；一条 / 一万 / 一筒算 9 倍；红中也算 9 倍。
 *   · 无中胡：胡的时候一张红中都没用上，整个分数翻倍。
 */
import { HONG, rankOf, type Tile } from './tiles.ts';

export interface MahjongRules {
  /** 底分 */
  baseScore: number;
  /** 一点算几倍（一条 / 一万 / 一筒） */
  oneMultiplier: number;
  /** 翻到红中当马牌算几倍 —— 跟翻到一点一样，最大的那档 */
  hongMaMultiplier: number;
  /** 没用红中胡的翻几倍 */
  noHongMultiplier: number;
  /** 明杠 / 碰杠：每家付几倍底分 */
  mingGang: number;
  /** 暗杠：每家付几倍底分 */
  anGang: number;
}

export const DEFAULT_RULES: MahjongRules = {
  baseScore: 1,
  oneMultiplier: 9,
  hongMaMultiplier: 9,
  noHongMultiplier: 2,
  mingGang: 1,
  anGang: 2,
};

/** 翻出来这张马值几倍 */
export function maMultiplier(ma: Tile, r: MahjongRules = DEFAULT_RULES): number {
  if (ma === HONG) return r.hongMaMultiplier;
  const n = rankOf(ma);
  return n === 1 ? r.oneMultiplier : n;
}

export interface HuScore {
  /** 每一家付给胡牌者多少 */
  perPlayer: number;
  /** 胡牌者一共收多少（三家之和） */
  total: number;
  ma: Tile;
  maMult: number;
  noHong: boolean;
  /** 摊开给玩家看的算式 */
  breakdown: string[];
}

/**
 * @param ma      翻出来的马牌（公共牌堆里的下一张）
 * @param hongUsed 胡牌那副牌里用掉了几张红中
 * @param others  除胡牌者外还有几家（四人桌就是 3）
 */
export function scoreHu(ma: Tile, hongUsed: number, others = 3, r: MahjongRules = DEFAULT_RULES): HuScore {
  const maMult = maMultiplier(ma, r);
  const noHong = hongUsed === 0;
  const mult = (1 + maMult) * (noHong ? r.noHongMultiplier : 1);
  const perPlayer = r.baseScore * mult;
  const lines = [
    `翻马 ${maMult === r.oneMultiplier && rankOf(ma) === 1 ? '一点' : ma === HONG ? '红中' : `${rankOf(ma)}点`} → ${maMult} 倍`,
    `胡牌 1 倍 + 马 ${maMult} 倍 = ${1 + maMult} 倍`,
  ];
  if (noHong) lines.push(`无中胡 → 再翻 ${r.noHongMultiplier} 倍 = ${mult} 倍`);
  lines.push(`底分 ${r.baseScore} × ${mult} = 每家 ${perPlayer} 分，共 +${perPlayer * others}`);
  return { perPlayer, total: perPlayer * others, ma, maMult, noHong, breakdown: lines };
}

/** 杠的分：当场结，三家各付 */
export function scoreGang(kind: 'ming' | 'an' | 'bu', others = 3, r: MahjongRules = DEFAULT_RULES) {
  // 碰杠（补杠）跟明杠一个价
  const mult = kind === 'an' ? r.anGang : r.mingGang;
  const perPlayer = r.baseScore * mult;
  return { perPlayer, total: perPlayer * others, mult };
}
