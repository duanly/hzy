/** 昵称相关的小工具：不依赖别的模块，方便单测 */

/** 昵称按"一个字一个字"拆：emoji 是两个码元，用 slice 会把它劈成乱码，必须按码点拆 */
export const chars = (s: string) => Array.from(s ?? '');

const EMOJI = /\p{Extended_Pictographic}/u;
export const isEmoji = (s: string) => EMOJI.test(s);

/**
 * 头像框里写什么：
 * - 名字放得下（不超过 max 个字）就整个写上去（四个字的名字也排得下）；
 * - 放不下、而名字里带表情包，就单摆那个表情 —— 比截半个名字好认；
 * - 都不是，就取前 max 个字。
 */
export function avatarText(nick: string, max: number): string {
  const cs = chars(nick);
  if (cs.length <= max) return cs.join('');
  const emo = cs.find(isEmoji);
  return emo ?? cs.slice(0, max).join('');
}

/** 按"字"截断昵称：表情包算一个字，绝不会截成半个 */
export const clampNick = (s: string, max: number) => chars(String(s ?? '').trim()).slice(0, max).join('');
