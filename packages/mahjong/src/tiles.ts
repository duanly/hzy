/**
 * 红中麻将牌面定义
 *
 * 112 张：万 / 条 / 筒 各 1~9（每种 4 张，108 张）+ 红中 4 张。
 * 去掉了风字和发白 —— 只留红中，而且红中是**赖子**（万能牌）。
 *
 * Tile 编码（0..27）：
 *   0..8   万 1~9
 *   9..17  条 1~9
 *   18..26 筒 1~9
 *   27     红中
 * 这么排是为了判顺子方便：同花色的牌在编码上连续，`i % 9` 就是它在本花色里的位次。
 */

export type Tile = number;   // 0..27

export const SUIT_COUNT = 3;
export const RANK_COUNT = 9;
/** 红中的编码 —— 排在所有数牌后面 */
export const HONG = 27;
export const TILE_COUNT = 28;
export const DECK_SIZE = 112;

export type Suit = 'wan' | 'tiao' | 'tong' | 'hong';
const SUIT_NAMES: Record<Suit, string> = { wan: '万', tiao: '条', tong: '筒', hong: '中' };
const RANK_NAMES = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

export function isHong(t: Tile): boolean { return t === HONG; }
/** 数牌的点数 1~9；红中没有点数，返回 0 */
export function rankOf(t: Tile): number { return t === HONG ? 0 : (t % 9) + 1; }
export function suitOf(t: Tile): Suit {
  if (t === HONG) return 'hong';
  return t < 9 ? 'wan' : t < 18 ? 'tiao' : 'tong';
}
export function tileOf(suit: Exclude<Suit, 'hong'>, rank: number): Tile {
  return (suit === 'wan' ? 0 : suit === 'tiao' ? 9 : 18) + (rank - 1);
}
/** 「五筒」「红中」 */
export function nameOf(t: Tile): string {
  if (t === HONG) return '红中';
  return RANK_NAMES[rankOf(t) - 1] + SUIT_NAMES[suitOf(t)];
}

/** 同一花色、且在本花色里还排得下一张（用来判顺子） */
export function sameSuitRun(t: Tile): boolean {
  return t !== HONG && t % 9 <= 6;
}

export function fullDeck(): Tile[] {
  const d: Tile[] = [];
  for (let t = 0; t < TILE_COUNT; t++) for (let i = 0; i < 4; i++) d.push(t);
  return d;
}

export type Counts = number[];   // 长度 28
export function toCounts(tiles: Tile[]): Counts {
  const c = new Array(TILE_COUNT).fill(0);
  for (const t of tiles) c[t]++;
  return c;
}
