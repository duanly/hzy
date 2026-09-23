/**
 * 国内那条在线合成：阿里云百炼（DashScope）的 qwen3-tts-flash。
 *
 * 为什么要有它：微软 Edge 那条要连 speech.platform.bing.com，谷歌那条要连
 * translate.google.com —— 服务器搬到国内之后，这两个域名都出不去，报牌声就彻底哑了。
 * 百炼是国内的，而且接口**就是一次普通的 HTTPS POST**：一个 Bearer 头、一段 JSON，
 * 回来一个音频链接。没有 WebSocket、没有签名、没有时间戳校验 —— 跟这个服务端
 * 「不引第三方包」的路子最搭，整条实现也就百来行。
 *
 * 用之前要有一把 API Key（百炼控制台申请，sk- 开头）。两种给法，哪个方便用哪个：
 *   - 环境变量 DASHSCOPE_API_KEY=sk-xxx 启动
 *   - 或者在后台「语音」页那个输入框里填一次，存进数据库，重启也还在
 *
 * 它回来的是 **WAV（24kHz 单声道）**，不是 mp3 —— 接口不让挑格式。
 * 所以这里做两件事把体积压下来：
 *   1. 掐掉首尾的静音（合成出来的片子前后常带小半秒空白，白占地方）；
 *   2. 机器上要是有 ffmpeg，就顺手转成 48kbps 的 mp3（体积差不多是 WAV 的八分之一）；
 *      没有就照原样存 WAV，一样能放，只是包大一点。
 */
import { spawnSync } from 'node:child_process';

/* 接口地址。留个环境变量口子：百炼换区域（比如新加坡节点）、或者要走自家反代的时候，
   不用改代码；本地自测时也拿它指到假服务上。 */
const URL_GEN = process.env.DASHSCOPE_TTS_URL
  || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const MODEL = process.env.DASHSCOPE_TTS_MODEL || 'qwen3-tts-flash';

/** 挑得出来的音色。`a:` 前缀是为了跟微软（裸名字）、谷歌（`g:`）分开 */
export const ALI_VOICES: { id: string; name: string }[] = [
  { id: 'a:Cherry', name: '芊悦（女 · 普通话）' },
  { id: 'a:Serena', name: '苏瑶（女 · 普通话，偏稳）' },
  { id: 'a:Ethan', name: '晨煦（男 · 普通话）' },
  { id: 'a:Chelsie', name: '千雪（女 · 普通话，偏清亮）' },
  { id: 'a:Nofish', name: '不吃鱼（男 · 普通话）' },
  /* 方言这一档：**没有湖南话**，几家都没有。牌桌上真要衡阳味，
     还得自己录一套（后台「自录」那条路）。下面这几个留着给想换口味的人。 */
  { id: 'a:Sunny', name: '晴儿（女 · 四川话）' },
  { id: 'a:Eric', name: '程川（男 · 四川话）' },
  { id: 'a:Dylan', name: '晓东（男 · 北京话）' },
  { id: 'a:Marcus', name: '秦川（男 · 陕西话）' },
  { id: 'a:Peter', name: '李彼得（男 · 天津话）' },
  { id: 'a:Jada', name: '阿珍（女 · 上海话）' },
  { id: 'a:Li', name: '老李（男 · 南京话）' },
  { id: 'a:Rocky', name: '阿强（男 · 粤语）' },
  { id: 'a:Kiki', name: '阿清（女 · 粤语）' },
];
export const isAliVoice = (v: string) => v.startsWith('a:');

/** 这把钥匙从哪儿来：先看环境变量，没有再看后台存的那个 */
let stored = '';
export const setAliKey = (k: string) => { stored = k || ''; };
export const aliKey = () => process.env.DASHSCOPE_API_KEY || stored;
export const hasAliKey = () => !!aliKey();

/* ── WAV 首尾掐静音 ────────────────────────────────────────────────
   只认最常见的那一种：16 位有符号、单声道 / 双声道的 PCM。
   格式一对不上就原样退回去 —— 宁可大一点，也不能把音频弄坏。 */
export function trimWav(buf: Buffer, floor = 0.012, padMs = 40): Buffer {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return buf;
  // 走一遍块表，找 fmt 和 data（有些文件在这两块中间还夹着 LIST 之类）
  let p = 12, fmt = -1, data = -1, dataLen = 0;
  while (p + 8 <= buf.length) {
    const id = buf.toString('latin1', p, p + 4);
    const len = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = p + 8;
    if (id === 'data') { data = p + 8; dataLen = Math.min(len, buf.length - data); break; }
    p += 8 + len + (len & 1);
  }
  if (fmt < 0 || data < 0 || dataLen <= 0) return buf;
  const ch = buf.readUInt16LE(fmt + 2), rate = buf.readUInt32LE(fmt + 4), bits = buf.readUInt16LE(fmt + 14);
  if (bits !== 16 || ch < 1 || ch > 2) return buf;

  const frame = 2 * ch, n = Math.floor(dataLen / frame);
  const amp = (i: number) => {
    let m = 0;
    for (let c = 0; c < ch; c++) m = Math.max(m, Math.abs(buf.readInt16LE(data + i * frame + c * 2)));
    return m / 32768;
  };
  let a = 0, b = n - 1;
  while (a < n && amp(a) < floor) a++;
  while (b > a && amp(b) < floor) b--;
  if (a >= b) return buf;                       // 整段都是静音：别动它
  const pad = Math.round((padMs / 1000) * rate);  // 两头各留一点气口，不然听着像被切了
  a = Math.max(0, a - pad); b = Math.min(n - 1, b + pad);
  const cut = buf.subarray(data + a * frame, data + (b + 1) * frame);
  if (cut.length >= dataLen) return buf;

  const head = Buffer.from(buf.subarray(0, data));   // 原样照抄，只改两个长度字段
  head.writeUInt32LE(head.length - 8 + cut.length, 4);
  head.writeUInt32LE(cut.length, data - 4);
  return Buffer.concat([head, cut]);
}

/** 机器上有没有 ffmpeg（问一次就记着，别每条都去探） */
let ffmpegOk: boolean | null = null;
function hasFfmpeg(): boolean {
  if (ffmpegOk === null) {
    try { ffmpegOk = spawnSync('ffmpeg', ['-version'], { timeout: 4000 }).status === 0; }
    catch { ffmpegOk = false; }
  }
  return ffmpegOk;
}
/** WAV → mp3（48kbps 单声道，跟微软那条出来的规格对齐）。转不了就原样退回 */
export function toMp3(wav: Buffer): { buf: Buffer; ext: 'mp3' | 'wav' } {
  if (!hasFfmpeg()) return { buf: wav, ext: 'wav' };
  try {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-ac', '1', '-ar', '24000', '-b:a', '48k', '-f', 'mp3', 'pipe:1'],
      { input: wav, maxBuffer: 32 * 1024 * 1024, timeout: 20000 });
    const out = r.stdout;
    if (r.status === 0 && out && out.length > 200) return { buf: Buffer.from(out), ext: 'mp3' };
  } catch { /* 转不了就算了 */ }
  return { buf: wav, ext: 'wav' };
}

/** 合成一条。回来的是音频字节 + 它到底是什么格式（存文件要用对后缀） */
export async function aliTTS(text: string, opts: { voice?: string; timeoutMs?: number } = {}):
  Promise<{ buf: Buffer; ext: 'mp3' | 'wav' }> {
  const key = aliKey();
  if (!key) throw new Error('还没填百炼的 API Key（后台语音页那个输入框，或者 DASHSCOPE_API_KEY 环境变量）');
  const voice = (opts.voice ?? 'a:Cherry').replace(/^a:/, '') || 'Cherry';
  const ms = opts.timeoutMs ?? 30000;

  const r = await fetch(URL_GEN, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: { text: text.slice(0, 200), voice, language_type: 'Chinese' } }),
    signal: AbortSignal.timeout(ms),
  });
  const body = await r.text();
  if (!r.ok) {
    /* 把人家给的原因原样带出来 —— 后台那一栏会显示，比"合成失败"有用得多。
       常见的两种：Key 不对（InvalidApiKey）、这个模型没开通（Model.AccessDenied）。 */
    let why = body.slice(0, 200);
    try { const j = JSON.parse(body); why = `${j.code ?? ''} ${j.message ?? ''}`.trim() || why; } catch { /* 不是 JSON 就照原样 */ }
    throw new Error(`百炼 ${r.status}：${why}`);
  }
  let j: any;
  try { j = JSON.parse(body); } catch { throw new Error('百炼回的不是 JSON'); }
  const au = j?.output?.audio;
  if (!au) throw new Error(`百炼没给音频：${(j?.message ?? body).toString().slice(0, 160)}`);

  /* 两种取法：有 data 就是 base64 直接给了，省一趟下载；否则拿那个链接去取。 */
  let wav: Buffer;
  if (typeof au.data === 'string' && au.data.length > 100) wav = Buffer.from(au.data, 'base64');
  else if (typeof au.url === 'string' && au.url) {
    const a = await fetch(au.url, { signal: AbortSignal.timeout(ms) });
    if (!a.ok) throw new Error(`取音频失败 ${a.status}`);
    wav = Buffer.from(await a.arrayBuffer());
  } else throw new Error('百炼给的音频既没有 data 也没有 url');
  if (wav.length < 200) throw new Error('取回来的音频太小，八成是空的');

  return toMp3(trimWav(wav));
}
