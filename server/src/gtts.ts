/**
 * 备用的在线合成：谷歌翻译那个朗读接口。
 *
 * 为什么要有它：微软 Edge 那条只有 WebSocket，而它的网关在有些地方 / 有些机器上
 * 就是不肯谈升级（普通 HTTPS 一路畅通、偏偏 101 换不下来，403）。
 * 这一条是**最普通不过的 HTTPS GET**，回来直接就是 mp3 —— 没有握手、没有扩展、没有校验码，
 * 能不能用一试便知。音色比 Edge 木一点，但报牌就那么两三个字，够用。
 *
 * 限制：一次最多念 200 字符（我们最长的一条是"自摸，胡了"，远远用不到）。
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** 能挑的（谷歌这边只分语言，不分发音人） */
export const GOOGLE_VOICES: { id: string; name: string }[] = [
  { id: 'auto', name: '自动（先百炼，没配 Key 才试微软 / 备用）' },
  { id: 'g:zh-CN', name: '谷歌 · 普通话（备用，不用 WebSocket）' },
  { id: 'g:zh-TW', name: '谷歌 · 国语（台湾腔）' },
  { id: 'g:yue', name: '谷歌 · 粤语' },
];
export const isGoogleVoice = (v: string) => v.startsWith('g:');
export const isAutoVoice = (v: string) => v === 'auto';

/** 慢一点 / 快一点：谷歌只认 ttsspeed，0.24~1 之间 */
const speedOf = (rate: number) => (rate <= -20 ? 0.6 : rate < 0 ? 0.8 : 1);

export async function googleTTS(text: string, opts: { voice?: string; rate?: number; timeoutMs?: number } = {}): Promise<Buffer> {
  const lang = (opts.voice ?? 'g:zh-CN').replace(/^g:/, '') || 'zh-CN';
  const speed = speedOf(opts.rate ?? 0);
  const q = encodeURIComponent(text.slice(0, 180));
  /* 两个入口是一回事，只是参数名不同。哪个通用哪个 —— 有的网络只放行其中一个。 */
  const urls = [
    `https://translate.google.com/translate_tts?ie=UTF-8&q=${q}&tl=${lang}&client=tw-ob&ttsspeed=${speed}`,
    `https://translate.googleapis.com/translate_tts?ie=UTF-8&q=${q}&tl=${lang}&client=gtx&ttsspeed=${speed}`,
  ];
  const why: string[] = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, {
        headers: { 'User-Agent': UA, Referer: 'https://translate.google.com/', 'Accept-Language': 'zh-CN,zh;q=0.9' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
      });
      if (!r.ok) { why.push(`${new URL(u).host} → HTTP ${r.status}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      // 回来得是 mp3；要是被挡了，多半是一页 html
      if (buf.length < 500 || !(buf[0] === 0xff || buf.subarray(0, 3).toString() === 'ID3')) {
        why.push(`${new URL(u).host} → 回来的不是 mp3（${buf.length} 字节）`); continue;
      }
      return buf;
    } catch (e) {
      why.push(`${new URL(u).host} → ${(e as Error).message}`);
    }
  }
  throw new Error(`谷歌那条也没成：${why.join('；')}`);
}
