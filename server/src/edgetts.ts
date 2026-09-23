/**
 * 在线合成报牌声（微软 Edge 浏览器「大声朗读」用的那个接口）。
 *
 * 为什么要有这东西：报牌声本来只有两条路 —— 手机自带的 TTS（各机型时灵时不灵），
 * 或者人工一条条录。这里给第三条：**服务端一次性把整套合成成 mp3 存下来**，
 * 存完就是普通的语音包，客户端照常拿 `/voice/...` 播，再也不碰在线服务。
 *
 * 实现上的两件事：
 * 1. 这个接口只有 WebSocket，没有普通 HTTP，所以这里手写了一个**极简 WS 客户端**
 *    （跟 ws.ts 那个服务端是一对，同样不引第三方包）。
 *    Node 自带的 WebSocket 不让设 Origin / User-Agent 这类请求头，人家要看，所以用不了。
 * 2. 接口带一道时间戳校验（Sec-MS-GEC）：把 Windows 文件时间取整到 5 分钟，
 *    接上那个公开的客户端令牌做 SHA-256。服务器时间差太多会被拒，所以机器的时间要是准的。
 *
 * 合成出来的是 24kHz 48kbps 单声道 mp3 —— 全平台都放得了，正好是语音包最稳的那个格式。
 */
import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect, type Socket } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const HOST = 'speech.platform.bing.com';
const PATH = '/consumer/speech/synthesize/readaloud/edge/v1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/* 对方会看这个「浏览器版本」。它偶尔会嫌旧版不认（表现就是一直 403），
   到那会儿不用改代码：EDGE_TTS_VERSION=1-<某个新版本号> 启动就行。 */
const GEC_VERSION = process.env.EDGE_TTS_VERSION || '1-131.0.2903.63';

/** 挑得出来的中文发音人。名字是人听得懂的说法，右边是接口要的 id */
export const EDGE_VOICES: { id: string; name: string }[] = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓（女 · 普通话，最自然）' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊（女 · 普通话，偏活泼）' },
  { id: 'zh-CN-YunxiNeural', name: '云希（男 · 普通话，偏年轻）' },
  { id: 'zh-CN-YunjianNeural', name: '云健（男 · 普通话，偏浑厚）' },
  { id: 'zh-CN-YunyangNeural', name: '云扬（男 · 播音腔）' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北（女 · 东北话）' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮（女 · 陕西话）' },
  { id: 'zh-CN-henan-YundengNeural', name: '云登（男 · 河南话）' },
  { id: 'zh-CN-sichuan-YunxiNeural', name: '云希（男 · 四川话）' },
  { id: 'zh-HK-HiuMaanNeural', name: '曉曼（女 · 粤语）' },
  { id: 'zh-TW-HsiaoChenNeural', name: '曉臻（女 · 台湾腔）' },
];
export const isEdgeVoice = (v: string) => /^[a-zA-Z-]{2,40}$/.test(v);

/* 本机时间跟对方差多少（毫秒）。校验码是按时间算的，差上几分钟对方就回 403；
   碰上 403 就照对方响应头里的 Date 把这个差值记下来，下一次直接用对的时间算。 */
let skewMs = 0;
export const clockSkewMs = () => skewMs;

/** Windows 文件时间（100 纳秒为一格），取整到 5 分钟，再跟令牌一起哈希 */
export function secMsGec(now = Date.now() + skewMs) {
  let ticks = BigInt(Math.floor(now / 1000) + 11644473600) * 10000000n;
  ticks -= ticks % 3000000000n;
  return createHash('sha256').update(`${ticks}${TOKEN}`).digest('hex').toUpperCase();
}

/** 这些字符在 SSML 里有特殊含义，得转义，否则整段合成会失败 */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** 语速 / 音调写成接口要的 `+10%` / `-2Hz` 这种样子 */
const pct = (n: number) => `${n >= 0 ? '+' : ''}${Math.round(n)}%`;
const hz = (n: number) => `${n >= 0 ? '+' : ''}${Math.round(n)}Hz`;

interface Frame { op: number; payload: Buffer }

/** 一条连接：连上、发几帧、把二进制帧里的音频拼起来。用完即弃。 */
class MiniWs {
  private sock: Socket;
  private buf: Buffer = Buffer.alloc(0);
  private up = false;                 // 握手成功了没
  private dead = false;               // 握手已经失败，后面收到的只是响应正文
  private frags: Buffer[] = [];
  private fragOp = 0;
  private fragZip = false;
  private onFrame: (f: Frame) => void = () => {};
  private onFail: (e: Error) => void = () => {};
  private onOpen: () => void = () => {};

  private deflate: boolean;
  constructor(url: string, headers: Record<string, string>, wantDeflate = false) {
    this.deflate = false;
    const u = new URL(url);
    const key = Buffer.from(randomUUID().replace(/-/g, ''), 'hex').toString('base64');
    const tls = u.protocol === 'wss:';
    this.sock = tls
      /* ALPN 要明说 http/1.1：不说的话对方的网关有可能压根不按 HTTP/1 来对待这条连接，
         而 WebSocket 升级只有在 HTTP/1.1 上才谈得成。fetch 走的 undici 一直带着它，
         我们这条手写的连接原来没带 —— 这大概率就是「curl 能通、升级却 403」的由来。 */
      ? tlsConnect({ host: u.hostname, port: Number(u.port) || 443, servername: u.hostname,
                     ALPNProtocols: ['http/1.1'] })
      : netConnect({ host: u.hostname, port: Number(u.port) || 80 });   // 只有本地假服务（测试）才走这条
    this.sock.setNoDelay(true);
    this.sock.on('error', e => this.onFail(e as Error));
    this.sock.on('close', () => this.onFail(new Error('连接被对方断开了')));
    this.sock.on('data', (d: Buffer) => this.feed(d));
    this.sock.on(tls ? 'secureConnect' : 'connect', () => {
      const lines = [`GET ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`,
        'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13'];
      /* 浏览器一定会带这一条。带了对方就可能把帧压缩着发回来，所以只在"要压缩"的那一种写法里带，
         并且明说两头都别保留压缩上下文（no_context_takeover）—— 那样每条消息都能单独解开。 */
      if (wantDeflate) lines.push('Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits');
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      this.sock.write(lines.join('\r\n') + '\r\n\r\n');
    });
    this.expect = createHash('sha1').update(key + GUID).digest('base64');
  }
  private expect: string;

  on(open: () => void, frame: (f: Frame) => void, fail: (e: Error) => void) {
    this.onOpen = open; this.onFrame = frame; this.onFail = fail;
  }

  private feed(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.dead) return;              // 只是在等正文收完，别当帧解
    if (!this.up) {
      const i = this.buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const head = this.buf.subarray(0, i).toString('latin1');
      this.buf = this.buf.subarray(i + 4);
      const status = Number(head.split(' ')[1]);
      if (status !== 101) {
        /* 403 多半是「校验码算错了」，而校验码是按时间算的 —— 所以把对方响应头里的
           Date 一起带出去，外面好按对方的时间重算一遍再试。
           顺带把响应正文也捎上一小段：对方有时候会把拒绝的理由写在里头，
           比拿着一个光秃秃的 403 瞎猜强得多。等 300ms 收正文，收不到就算了。 */
        const date = (head.match(/^date:\s*(.+)$/im) ?? [])[1]?.trim();
        const bail = () => {
          const e = new Error(`对方没接受升级（HTTP ${status || '?'}）`) as Error & { status?: number; date?: string; body?: string; headers?: string };
          e.status = status; e.date = date;
          e.headers = head.replace(/\r/g, '').split('\n').slice(1).join(' | ').slice(0, 400);
          const b = this.buf.toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          if (b) e.body = b.slice(0, 300);
          this.onFail(e);
        };
        this.dead = true;
        setTimeout(bail, 600);
        return;
      }
      if (!new RegExp(`sec-websocket-accept:\\s*${this.expect.replace(/[+/=]/g, c => '\\' + c)}`, 'i').test(head)) {
        this.onFail(new Error('握手校验没通过')); return;
      }
      this.up = true;
      this.deflate = /sec-websocket-extensions:.*permessage-deflate/i.test(head);
      this.onOpen();
    }
    // 服务端发来的帧不加掩码
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = !!(b0 & 0x80), op = b0 & 0x0f, rsv1 = !!(b0 & 0x40);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const masked = !!(b1 & 0x80), mLen = masked ? 4 : 0;
      if (this.buf.length < off + mLen + len) return;
      let payload = this.buf.subarray(off + mLen, off + mLen + len);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      this.buf = this.buf.subarray(off + mLen + len);
      if (op === 0x9) { this.send(0xA, payload); continue; }        // ping → pong
      if (op === 0xA) continue;
      if (op === 0x8) { this.onFail(new Error('对方要求关闭连接')); return; }
      if (op === 0x0) { this.frags.push(payload); if (fin) { const all = Buffer.concat(this.frags); const o = this.fragOp; this.frags = []; this.onFrame({ op: o, payload: this.unzip(all, this.fragZip) }); } continue; }
      if (fin) this.onFrame({ op, payload: this.unzip(payload, rsv1) }); else { this.fragOp = op; this.fragZip = rsv1; this.frags = [payload]; }
    }
  }

  /** 压缩过的消息（RSV1 置位）：补上那四个字节的收尾标记再 inflate */
  private unzip(b: Buffer, zip: boolean) {
    if (!zip || !this.deflate) return b;
    try { return inflateRawSync(Buffer.concat([b, Buffer.from([0x00, 0x00, 0xff, 0xff])])); }
    catch { return b; }
  }

  /** 客户端发出去的帧**必须**加掩码，这是协议规定的，少了对方直接断 */
  send(op: number, payload: Buffer) {
    const len = payload.length;
    const mask = Buffer.allocUnsafe(4);
    for (let i = 0; i < 4; i++) mask[i] = (Math.random() * 256) | 0;
    let head: Buffer;
    if (len < 126) { head = Buffer.from([0x80 | op, 0x80 | len]); }
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    const body = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
    try { this.sock.write(Buffer.concat([head, mask, body])); } catch { /* 断了自然会有 error */ }
  }
  text(s: string) { this.send(0x1, Buffer.from(s, 'utf8')); }
  destroy() { try { this.sock.destroy(); } catch { /* ignore */ } }
}

/**
 * 问对方要一份发音人清单。这一条是**普通 HTTPS**，不是 WebSocket ——
 * 拿它当"通不通"的体检最合适：能回一串 json，说明网络、校验码、版本串三样都对，
 * 接下来要是合成还失败，那就只剩 WebSocket 那一段的事了。
 *
 * 注意：这个地址**也要带校验码**（2024 年之后就这样了）。
 * 光 `curl .../voices/list?trustedclienttoken=…` 会被网关挡回一张
 * 「Our services aren't available right now」的页面 —— 那不是微软挂了，是请求不合格。
 */
export async function listVoices(gec = true): Promise<{ status: number; voices: { id: string; name: string }[]; body: string }> {
  const u = `https://${HOST}/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TOKEN}`
    + (gec ? `&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${GEC_VERSION}` : '');
  const r = await fetch(u, { headers: { 'User-Agent': UA, Origin: ORIGIN, 'Accept-Language': 'en-US,en;q=0.9' } });
  const body = await r.text();
  let voices: { id: string; name: string }[] = [];
  try {
    voices = (JSON.parse(body) as any[]).map(v => ({ id: v.ShortName as string, name: (v.FriendlyName ?? v.ShortName) as string }));
  } catch { /* 不是 json 就把原文留着给人看 */ }
  return { status: r.status, voices, body: body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) };
}

export interface EdgeOpts { voice?: string; rate?: number; pitch?: number; volume?: number; timeoutMs?: number }

/* 对方这几年改过好几回门槛：一会儿要校验码、一会儿嫌版本串旧、一会儿又什么都不要。
   哪一种写法能过，光看 403 是猜不出来的 —— 干脆把几种都列出来，挨个试，
   谁过了就记住谁，后面三十几条直接用它，不再挨个试一遍。 */
export interface Variant { id: string; why: string; gec: boolean; ver: string; zip?: boolean }
export const VARIANTS: Variant[] = [
  { id: 'browser', why: '照浏览器那一套来（带校验码 + 压缩扩展）', gec: true, ver: GEC_VERSION, zip: true },
  { id: 'gec', why: '带校验码，不要压缩扩展', gec: true, ver: GEC_VERSION },
  { id: 'gec-new', why: '带校验码（换个新版本串）', gec: true, ver: '1-140.0.3485.14', zip: true },
  { id: 'plain', why: '不带校验码（早些年的写法）', gec: false, ver: '' },
  { id: 'gec-old', why: '带校验码（换个老版本串）', gec: true, ver: '1-130.0.2849.68' },
];
let good: Variant | null = null;
export const goodVariant = () => good;
/* 五种写法全被拒过一次之后，十分钟内不再白试 —— 「自动」模式一条条生成时，
   不能每条都先耗五次握手。十分钟后再给它一次机会（对方哪天松口了也能自己恢复）。 */
let deadUntil = 0;
export const edgeLikelyDead = () => Date.now() < deadUntil;

/** 合成一句话，拿到 mp3。
 *  第一次会把几种写法挨个试一遍（带不带校验码、版本串新旧），谁过了就记住谁；
 *  403 还会照对方响应头里的 Date 把时间差修正一次 —— 校验码是按时间算的。 */
export async function edgeTTS(text: string, opts: EdgeOpts = {}): Promise<Buffer> {
  if (edgeLikelyDead()) throw new Error('微软那条刚刚整套试过都不通，先歇十分钟再说');
  const order = good ? [good, ...VARIANTS.filter(v => v !== good)] : VARIANTS;
  const tried: string[] = [];
  let last: Error & { status?: number; date?: string; body?: string; headers?: string } | null = null;
  for (const v of order) {
    try {
      const out = await once(text, opts, v);
      good = v; deadUntil = 0;
      return out;
    } catch (e) {
      const err = e as Error & { status?: number; date?: string; body?: string; headers?: string };
      last = err;
      tried.push(`${v.why} → HTTP ${err.status ?? '?'}`);
      if (err.status !== 403) throw err;              // 不是"被拒"，换写法也没用
      // 头一次被拒：照对方的时间把差值修正过来，这一种再试一把
      const theirs = err.date ? Date.parse(err.date) : NaN;
      if (Number.isFinite(theirs) && v.gec) {
        const before = skewMs;
        const prev = secMsGec(Date.now() + before);
        skewMs = theirs - Date.now();
        if (secMsGec(Date.now() + skewMs) !== prev) {
          try { const out = await once(text, opts, v); good = v; return out; } catch { /* 还是不行，换下一种 */ }
        }
      }
    }
  }
  deadUntil = Date.now() + 10 * 60 * 1000;
  const skewS = Math.round(skewMs / 1000);
  throw new Error(`几种写法都被拒了（最后一次 HTTP ${last?.status ?? '?'}）。`
    + `这台机器的时间跟对方差 ${skewS} 秒`
    + `${Math.abs(skewMs) > 150000 ? '（差太多了，先把时间校准）' : '（时间是准的，不是这儿的问题）'}。`
    + (last?.body ? `对方给的理由：${last.body}` : '对方没给理由。')
    + ` 试过的写法：${tried.join('；')}。`
    + (last?.headers ? ` 对方最后一次的响应头：${last.headers}` : '')
    + ' 退一步的办法：在能出网的机器上生成好，把 server/data/voice/packs/ 整个目录拷过来 —— 语音包就是一堆 mp3。');
}

function once(text: string, opts: EdgeOpts = {}, v: Variant = VARIANTS[0]): Promise<Buffer> {
  const voice = opts.voice && isEdgeVoice(opts.voice) ? opts.voice : 'zh-CN-XiaoxiaoNeural';
  const rate = opts.rate ?? 0, pitch = opts.pitch ?? 0, volume = opts.volume ?? 0;
  // 测试时把地址指到本地假服务上，就不必真连微软（见 server/test）
  const base = process.env.EDGE_TTS_URL || `wss://${HOST}${PATH}`;
  const url = `${base}?TrustedClientToken=${TOKEN}`
    + (v.gec ? `&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${v.ver}` : '')
    + `&ConnectionId=${randomUUID().replace(/-/g, '')}`;
  const reqId = randomUUID().replace(/-/g, '');

  return new Promise<Buffer>((resolve, reject) => {
    const ws = new MiniWs(url, {
      Pragma: 'no-cache', 'Cache-Control': 'no-cache', 'User-Agent': UA,
      Origin: ORIGIN, 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en-US,en;q=0.9',
    }, !!v.zip);
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (err: Error | null, out?: Buffer) => {
      if (done) return;
      done = true; clearTimeout(timer); ws.destroy();
      err ? reject(err) : resolve(out!);
    };
    const timer = setTimeout(() => finish(new Error('等太久了，没等到音频（网络不通或者被挡住了）')), opts.timeoutMs ?? 20000);

    ws.on(() => {
      const ts = new Date().toString();
      ws.text(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},'
        + '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}');
      ws.text(`X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n`
        + `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>`
        + `<voice name='${voice}'><prosody pitch='${hz(pitch)}' rate='${pct(rate)}' volume='${pct(volume)}'>${esc(text)}</prosody></voice></speak>`);
    }, f => {
      if (f.op === 0x2) {
        // 二进制帧：开头两个字节是头部长度，后面才是音频
        if (f.payload.length < 2) return;
        const hl = f.payload.readUInt16BE(0);
        const head = f.payload.subarray(2, 2 + hl).toString('utf8');
        if (/Path:\s*audio/i.test(head)) chunks.push(f.payload.subarray(2 + hl));
        return;
      }
      const s = f.payload.toString('utf8');
      if (/Path:\s*turn\.end/i.test(s)) {
        const out = Buffer.concat(chunks);
        finish(out.length > 300 ? null : new Error('合成回来是空的（发音人名字可能不对）'), out);
      }
    }, e => finish(e));
  });
}
