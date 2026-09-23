/**
 * 昵称里不许出现的字词。
 *
 * 昵称最多四个字，所以**单字**也拦（「逼」「傻」「蠢」这种放在四个字里基本没好话）；
 * 多字的那批管的是拼在一起才难听的（「你妈」「去死」）和拼音缩写（sb、nmsl）。
 * 判断之前先把常见的花样去掉：空格、符号、大小写、全角数字字母、以及拿来绕过的同音字。
 */

/** 单字就拦 */
const BAD_CHARS = [
  '逼', '屄', '傻', '蠢', '肏', '屌', '鸡巴', '卵', '婊', '娼', '妓', '贱',
  '骚', '淫', '奸', '嫖', '睾', '痴', '残', '滚', '废',
];

/** 连起来才算的 */
const BAD_WORDS = [
  '你妈', '尼玛', '泥马', '他妈', '妈的', '马的', '草泥马', '草你', '操你', '曹尼', '干你',
  '傻逼', '沙比', '煞笔', '傻b', '2b', '二b', '2逼', '傻批', '沙雕', '二逼', '脑残', '智障', '弱智', '白痴', '脑瘫', '麻痹', '狗屎',
  '王八蛋', '混蛋', '杂种', '畜生', '狗东西', '狗日', '日你', '去死', '死全家', '全家死',
  '贱人', '贱货', '婊子', '鸡婆', '小姐', '援交', '做爱', '性交', '阳具', '阴道', '射精',
  'sb', 'nmsl', 'cnm', 'tmd', 'wdnmd', 'fuck', 'shit', 'bitch', 'bastard', 'asshole', 'dick', 'cunt',
];

/** 比对之前先把花样抹平：符号、空白去掉，全角转半角，字母转小写 */
function normalize(s: string): string {
  return Array.from(String(s ?? ''))
    .map(ch => {
      const c = ch.codePointAt(0)!;
      if (c >= 0xFF01 && c <= 0xFF5E) return String.fromCodePoint(c - 0xFEE0);   // 全角 → 半角
      return ch;
    })
    .join('')
    .toLowerCase()
    .replace(/[\s._\-*·、,，。!！?？~`'"^&%$#@()（）\[\]{}<>+=|\\/]/g, '');
}

/** 昵称里有没有不合适的字；有就返回那个字词，没有返回 null */
export function badWord(nick: string): string | null {
  const n = normalize(nick);
  if (!n) return null;
  for (const w of BAD_CHARS) if (n.includes(w)) return w;
  for (const w of BAD_WORDS) if (n.includes(w)) return w;
  return null;
}

/** 给玩家看的那句话 */
export const badWordMsg = (w: string) => `昵称里不能带「${w}」，换一个吧`;
