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

/**
 * 挑得出来的音色 —— 照百炼文档上 qwen3-tts-flash 那张表抄全（48 个）。
 * `a:` 前缀是历史包袱：当初要跟微软（裸名字）、谷歌（`g:`）分开，现在只剩这一家了，
 * 但存量的语音包设置里存着带前缀的值，去掉前缀老数据就对不上，所以留着。
 *
 * **有几个 id 里带空格**（`Eldric Sage`、`Ono Anna`、`Radio Gol`）—— 不是抄错了，
 * 百炼文档就是这么写的（中文版和繁体版两处对过，一模一样）。别顺手把空格去掉。
 *
 * 分三组，界面里按组折起来 —— 48 个平铺成一个下拉框没法看：
 *   · 普通话 28 个
 *   · 方言 10 个（8 种：上海 / 北京 / 南京 / 陕西 / 闽南 / 天津 / 四川 / 粤语）
 *   · 外语 10 个（这些也能说普通话，只是本行是那门外语，口音更地道）
 *
 * **还是没有湖南话**。查了一圈，百炼这边八种方言里就是没有 —— 牌桌上真要衡阳味，
 * 还得自己录一套（后台「自录」那条路）。这句话从第一版留到现在，改动前先确认它还成立。
 */
export type AliGroup = '普通话' | '方言' | '外语';
export interface AliVoice { id: string; name: string; group: AliGroup }

const mand = (id: string, cn: string, sex: '男' | '女'): AliVoice =>
  ({ id: `a:${id}`, name: `${cn}（${sex} · 普通话）`, group: '普通话' });
const dial = (id: string, cn: string, sex: '男' | '女', d: string): AliVoice =>
  ({ id: `a:${id}`, name: `${cn}（${sex} · ${d}）`, group: '方言' });
const forn = (id: string, cn: string, sex: '男' | '女', l: string): AliVoice =>
  ({ id: `a:${id}`, name: `${cn}（${sex} · ${l}）`, group: '外语' });

export const ALI_VOICES: AliVoice[] = [
  // ── 普通话 ──（前四个是原来就在用的，位置别动，老设置里存的就是它们）
  mand('Cherry', '芊悦', '女'),
  mand('Serena', '苏瑶', '女'),
  mand('Ethan', '晨煦', '男'),
  mand('Chelsie', '千雪', '女'),
  mand('Nofish', '不吃鱼', '男'),
  mand('Momo', '茉兔', '女'),
  mand('Vivian', '十三', '女'),
  mand('Moon', '月白', '男'),
  mand('Maia', '四月', '女'),
  mand('Kai', '凯', '男'),
  mand('Bella', '萌宝', '女'),
  mand('Jennifer', '詹妮弗', '女'),
  mand('Ryan', '甜茶', '男'),
  mand('Katerina', '卡捷琳娜', '女'),
  mand('Aiden', '艾登', '男'),
  mand('Eldric Sage', '沧明子', '男'),
  mand('Mia', '乖小妹', '女'),
  mand('Mochi', '沙小弥', '男'),
  mand('Bellona', '燕铮莺', '女'),
  mand('Vincent', '田叔', '男'),
  mand('Bunny', '萌小姬', '女'),
  mand('Neil', '阿闻', '男'),
  mand('Elias', '墨讲师', '女'),
  mand('Arthur', '徐大爷', '男'),
  mand('Nini', '邻家妹妹', '女'),
  mand('Seren', '小婉', '女'),
  mand('Pip', '顽屁小孩', '男'),
  mand('Stella', '少女阿月', '女'),
  // ── 方言 ──
  dial('Sunny', '晴儿', '女', '四川话'),
  dial('Eric', '程川', '男', '四川话'),
  dial('Dylan', '晓东', '男', '北京话'),
  dial('Marcus', '秦川', '男', '陕西话'),
  dial('Peter', '李彼得', '男', '天津话'),
  dial('Jada', '阿珍', '女', '上海话'),
  dial('Li', '老李', '男', '南京话'),
  dial('Roy', '阿杰', '男', '闽南话'),
  dial('Rocky', '阿强', '男', '粤语'),
  dial('Kiki', '阿清', '女', '粤语'),
  // ── 外语 ──（本行是那门语言；配合下面的 language_type 用）
  forn('Bodega', '博德加', '男', '西班牙语'),
  forn('Sonrisa', '索尼莎', '女', '西班牙语'),
  forn('Alek', '阿列克', '男', '俄语'),
  forn('Dolce', '多尔切', '男', '意大利语'),
  forn('Sohee', '素熙', '女', '韩语'),
  forn('Ono Anna', '小野杏', '女', '日语'),
  forn('Lenn', '莱恩', '男', '德语'),
  forn('Emilien', '埃米尔安', '男', '法语'),
  forn('Andre', '安德雷', '男', '葡萄牙语'),
  forn('Radio Gol', '拉迪奥·戈尔', '男', '葡萄牙语'),
];

/**
 * 能合成 / 能翻译的语言。左边是界面上显示的，右边是百炼认的那个词
 * （TTS 的 language_type 和 qwen-mt 的 target_lang 用的是同一套英文名，正好共用一份）。
 *
 * 要紧的一点：**TTS 不会翻译**。给它中文它就念中文，把 language_type 设成 English
 * 只会让它用英文的发音规则去念中文字，出来是一团糟。
 * 想要英文报牌声，得先把「念什么」翻成英文（后台那个「翻成这门语言」按钮），再合成。
 */
export const ALI_LANGS: { id: string; name: string }[] = [
  { id: 'Chinese', name: '中文（普通话 / 方言）' },
  { id: 'English', name: 'English 英语' },
  { id: 'Japanese', name: '日本語 日语' },
  { id: 'Korean', name: '한국어 韩语' },
  { id: 'French', name: 'Français 法语' },
  { id: 'German', name: 'Deutsch 德语' },
  { id: 'Spanish', name: 'Español 西班牙语' },
  { id: 'Italian', name: 'Italiano 意大利语' },
  { id: 'Portuguese', name: 'Português 葡萄牙语' },
  { id: 'Russian', name: 'Русский 俄语' },
];
export const isAliLang = (l: string) => ALI_LANGS.some(x => x.id === l);

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
export async function aliTTS(text: string, opts: { voice?: string; lang?: string; timeoutMs?: number } = {}):
  Promise<{ buf: Buffer; ext: 'mp3' | 'wav' }> {
  const key = aliKey();
  if (!key) throw new Error('还没填百炼的 API Key（后台语音页那个输入框，或者 DASHSCOPE_API_KEY 环境变量）');
  const voice = (opts.voice ?? 'a:Cherry').replace(/^a:/, '') || 'Cherry';
  const lang = opts.lang && isAliLang(opts.lang) ? opts.lang : 'Chinese';
  const ms = opts.timeoutMs ?? 30000;

  const r = await fetch(URL_GEN, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    /* language_type 不是"翻译成这门语言"，是"按这门语言的发音规则去念"。
       文档里那句「单一语种指明语言能明显提高合成质量」就是这个意思。
       所以给英文文本要配 English，给中文配 Chinese —— 配反了念出来是一团糟。 */
    body: JSON.stringify({ model: MODEL, input: { text: text.slice(0, 200), voice, language_type: lang } }),
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


/* ── 翻译：qwen-mt，跟 TTS 同一把 Key ──────────────────────────────
   为什么要有它：TTS 只会**念**，不会翻。想要一套英文报牌声，
   得先把「碰」「该你出牌」这些念法翻成英文，再拿英文文本去合成。
   qwen-mt 是百炼自家的翻译模型，参数简单（一个 translation_options 就完事），
   跟这个服务端"不引第三方包"的路子一样 —— 还是一次普通的 HTTPS POST。 */
const URL_MT = process.env.DASHSCOPE_MT_URL
  || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';
const MODEL_MT = process.env.DASHSCOPE_MT_MODEL || 'qwen-mt-turbo';

/**
 * 把一句话翻成 `to` 那门语言。`to` 用百炼认的英文名（见 ALI_LANGS）。
 *
 * 翻的是牌桌上的吆喝（「碰」「开跑」「该你出牌」），又短又是行话，
 * 机器翻出来不一定地道 —— 所以后台那边翻完是**填回「念什么」那一栏**让人过目，
 * 不是翻完直接合成。改一改再点生成，出来的才能听。
 */
export async function aliTranslate(text: string, to: string, timeoutMs = 20000): Promise<string> {
  const key = aliKey();
  if (!key) throw new Error('还没填百炼的 API Key');
  if (!isAliLang(to)) throw new Error(`不认识的语言：${to}`);
  if (to === 'Chinese') return text;          // 翻成中文＝原样，白跑一趟接口

  const r = await fetch(URL_MT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_MT,
      input: { messages: [{ role: 'user', content: text.slice(0, 200) }] },
      parameters: { translation_options: { source_lang: 'Chinese', target_lang: to } },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await r.text();
  if (!r.ok) {
    let why = body.slice(0, 200);
    try { const j = JSON.parse(body); why = `${j.code ?? ''} ${j.message ?? ''}`.trim() || why; } catch { /* 不是 JSON 就照原样 */ }
    throw new Error(`百炼翻译 ${r.status}：${why}`);
  }
  let j: any;
  try { j = JSON.parse(body); } catch { throw new Error('百炼翻译回的不是 JSON'); }
  const out = j?.output?.choices?.[0]?.message?.content ?? j?.output?.text;
  if (typeof out !== 'string' || !out.trim()) throw new Error('百炼翻译没给结果');
  return out.trim();
}
