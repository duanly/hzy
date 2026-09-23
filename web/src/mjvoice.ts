/**
 * 红中麻将的报牌声。
 *
 * 复用 voice.ts 那套底子（录音包、TTS 兜底、解锁音频、队列节奏），
 * 这儿只管**麻将自己的词**和**牌名怎么念**。
 *
 * 录音文件名（key）跟字牌那边不冲突，统一加 mj_ 前缀：
 *   mj_peng / mj_gang / mj_angang / mj_hu / mj_liuju / mj_ma / mj_your_turn
 *   牌名：mj_w1…mj_w9（万）、mj_t1…mj_t9（条）、mj_b1…mj_b9（筒）、mj_hong（红中）
 * 后台没传录音的那几条会自动退回手机 TTS，跟字牌一个路子。
 */
import { say, sayNow, cue } from './voice.ts';

export const HONG = 27;

const RANK_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 念出来的牌名：「五筒」「红中」 */
export function tileSpeech(t: number): string {
  if (t === HONG) return '红中';
  const r = (t % 9) + 1;
  const suit = t < 9 ? '万' : t < 18 ? '条' : '筒';
  return RANK_CN[r - 1] + suit;
}

/** 牌名对应的录音文件名 */
export function tileKey(t: number): string {
  if (t === HONG) return 'mj_hong';
  const r = (t % 9) + 1;
  return 'mj_' + (t < 9 ? 'w' : t < 18 ? 't' : 'b') + r;
}

/** 动作对应的那一句。少一个词会让播报队列卡住，所以每种都要有 —— 哪怕是空字符串 */
export const MJ_WORDS: Record<string, string> = {
  peng: '碰！',
  gang: '杠！',
  angang: '暗杠！',
  bugang: '杠！',
  hu: '自摸，胡了！',
  liuju: '荒庄',
  pass: '过',
  discard: '',
  draw: '',
};

/** 动作对应的录音文件名 */
const MJ_KEY: Record<string, string> = {
  peng: 'mj_peng', gang: 'mj_gang', angang: 'mj_angang', bugang: 'mj_gang',
  hu: 'mj_hu', liuju: 'mj_liuju', pass: 'mj_pass',
};

/** 后台语音页要列的条目：key → 中文标签 */
export const MJ_VOICE_KEYS: { key: string; label: string }[] = [
  { key: 'mj_peng', label: '碰' },
  { key: 'mj_gang', label: '杠' },
  { key: 'mj_angang', label: '暗杠' },
  { key: 'mj_hu', label: '自摸，胡了' },
  { key: 'mj_liuju', label: '荒庄' },
  { key: 'mj_pass', label: '过' },
  { key: 'mj_your_turn', label: '该你出牌' },
  { key: 'mj_ma', label: '翻马' },
  { key: 'mj_hong', label: '红中' },
  ...(['w', 't', 'b'] as const).flatMap(s => RANK_CN.map((cn, i) => ({
    key: `mj_${s}${i + 1}`,
    label: cn + (s === 'w' ? '万' : s === 't' ? '条' : '筒'),
  }))),
];

/**
 * 报一个动作。
 *
 * 碰 / 杠要带牌名（「碰！五筒」），胡和荒庄不带 —— 这跟字牌那边「提龙不报牌字」
 * 是同一个道理：一局里碰杠可能连着来好几次，不报牌名听着就不知道碰的是哪张；
 * 而胡牌一局只有一次，后面紧跟着还要报马，再塞一个牌名就太密了。
 */
export function sayAction(kind: keyof typeof MJ_WORDS | string, tile?: number) {
  const word = MJ_WORDS[kind];
  if (word === undefined) return;          // 不认识的动作：宁可不出声，也别让队列卡住
  const key = MJ_KEY[kind];
  if (!word) return;
  const withTile = (kind === 'peng' || kind === 'gang' || kind === 'bugang' || kind === 'angang') && tile !== undefined;
  // 胡了是这一局最响的一声，插队播，别排在前面那些碰杠后面
  const fn = kind === 'hu' ? sayNow : say;
  fn(word, key);
  if (withTile) say(tileSpeech(tile!), tileKey(tile!));
}

/** 翻马：「翻马，五筒」。马是这一局最后一下，单独报，让人听清楚翻到什么 */
export function sayMa(tile: number | null) {
  if (tile === null) { say('牌摸完了，没马'); return; }
  say('翻马', 'mj_ma');
  say(tileSpeech(tile), tileKey(tile));
}

/**
 * 报打出去的那一张：**只报牌名**，不带动作词（「五筒」，不是「打五筒」）。
 * 真桌上就是这么喊的；而且一局要喊几十次，多一个字都嫌吵。
 * 所以 MJ_WORDS.discard 是空的 —— 那条路子走 sayAction 会直接静音，走这儿。
 */
export function sayTile(t: number) { say(tileSpeech(t), tileKey(t)); }

/** 轮到你了：只出个提示音 + 一句短的，别吵 */
export function sayYourTurn() { cue('mj_your_turn'); }
