/**
 * 在线合成能不能用 —— 在服务器上单独试一把，不用开后台、不用重启服务。
 *
 *   node --experimental-strip-types server/tools/tts-test.ts
 *   node --experimental-strip-types server/tools/tts-test.ts 该你出牌 zh-CN-YunxiNeural
 *
 * 成了：在当前目录写一个 tts-test.mp3，自己放来听听。
 * 不成：把卡在哪一步原样打出来（连不上 / 被拒 / 等超时），照着提示查。
 */
import { writeFileSync } from 'node:fs';
import { EDGE_VOICES, edgeTTS, secMsGec, clockSkewMs, listVoices, goodVariant } from '../src/edgetts.ts';
import { GOOGLE_VOICES, googleTTS, isGoogleVoice } from '../src/gtts.ts';

const text = process.argv[2] || '碰';
const voice = process.argv[3] || 'zh-CN-XiaoxiaoNeural';

console.log(`要合成的是：「${text}」  发音人：${voice}`);
console.log(`本机时间：${new Date().toString()}`);
console.log(`校验码（Sec-MS-GEC）：${secMsGec().slice(0, 16)}…  —— 机器时间不准的话这一串就是错的，对方会拒`);
if (process.argv[3] === '?') { console.log('\n能挑的发音人：'); for (const v of [...EDGE_VOICES, ...GOOGLE_VOICES]) console.log(`  ${v.id}  ${v.name}`); process.exit(0); }

/* 先做个体检：问对方要发音人清单（这一条走普通 HTTPS，不是 WebSocket）。
   带校验码、不带校验码各试一次 —— 对方这几年改过好几回门槛，
   哪一种能过，直接试出来比猜快。 */
for (const [gec, how] of [[true, '带校验码'], [false, '不带校验码']] as [boolean, string][]) {
  try {
    const c = await listVoices(gec);
    if (c.status === 200 && c.voices.length) {
      console.log(`体检（${how}）：通 —— ${c.voices.length} 个发音人，中文 ${c.voices.filter(v => v.id.startsWith('zh-')).length} 个`);
    } else {
      console.log(`体检（${how}）：HTTP ${c.status} —— ${c.body}`);
    }
  } catch (e) {
    console.log(`体检（${how}）：连不上 —— ${(e as Error).message}`);
  }
}
console.log('');

try {
  const t0 = Date.now();
  const mp3 = isGoogleVoice(voice) ? await googleTTS(text, { voice }) : await edgeTTS(text, { voice, timeoutMs: 25000 });
  writeFileSync('tts-test.mp3', mp3);
  console.log(`\n成了：${mp3.length} 字节，用时 ${Date.now() - t0}ms，写到了 ./tts-test.mp3`);
  console.log(`用的是这一种写法：${goodVariant()?.why ?? '默认'}`);
  if (Math.abs(clockSkewMs()) > 2000) console.log(`（顺带：这台机器的时间比对方差 ${Math.round(clockSkewMs() / 1000)} 秒，最好校一下）`);
  console.log('放来听听：  afplay tts-test.mp3   （Linux 上：mpg123 tts-test.mp3）');
} catch (e) {
  console.error(`\n没成：${(e as Error).message}`);
  if (!isGoogleVoice(voice)) {
    // 微软那条谈不成，顺手替你把备用那条试一把 —— 通了就直接用它生成，不用再折腾握手
    try {
      const b = await googleTTS(text);
      writeFileSync('tts-test.mp3', b);
      console.error(`\n不过**备用那条通了**：谷歌翻译的朗读接口（普通 HTTPS，没有 WebSocket），`
        + `${b.length} 字节，也写到了 ./tts-test.mp3。`);
      console.error('后台「在线生成」的发音人里挑「谷歌 · 普通话（备用…）」就能整套生成，音色木一点但够用。');
      process.exit(0);
    } catch (e2) { console.error(`备用那条也不成：${(e2 as Error).message}`); }
  }
  console.error(`
照这个顺序查：
  1. 上面那个「体检」通没通 —— 通了就说明网络没问题，卡的是 WebSocket 那一段。
     （「Our services aren't available right now」是对方网关挡回来的一张页面，
       不是微软挂了，是这个请求它不认。）
  2. 机器时间准不准     date -u        —— 跟真实 UTC 差几分钟以上，校验码就不对，对方直接拒。
     （403 的时候程序会自己照对方的时间重算一遍再试，所以还报 403 就不是时间的事了。）
  3. 要走代理的话       HTTPS_PROXY 这类环境变量这里用不上（走的是 WebSocket，不是 http 客户端），
     只能让这台机器能直连，或者在能出网的机器上生成好，把 data/voice/packs/ 整个目录拷过去。`);
  process.exit(1);
}
