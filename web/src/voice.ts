/** 语音：打牌用语播报（TTS）、语音聊天（录音/播放）、语音指令（可选） */
import { nameOf, isBig, rankOf, type Kind } from '../../packages/engine/src/index.ts';

export const settings = {
  tts: true,
  voiceCmd: false,
  get(): void { try { const s = JSON.parse(localStorage.getItem('phz_settings') ?? '{}'); Object.assign(this, s); } catch { /* ignore */ } },
  save(): void { try { localStorage.setItem('phz_settings', JSON.stringify({ tts: this.tts, voiceCmd: this.voiceCmd })); } catch { /* ignore */ } },
};
settings.get();

let voice: SpeechSynthesisVoice | null = null;
let voiceTries = 0;
/** 选普通话声音：严格优先 zh-CN / zh-Hans，最后才退到别的中文（港台粤语放在最后） */
function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices();
  if (!vs.length) return;
  const cn = (v: SpeechSynthesisVoice) => /zh[-_](CN|Hans)/i.test(v.lang) || /Hans/i.test(v.name);
  const yue = (v: SpeechSynthesisVoice) => /yue|zh[-_](HK|MO)/i.test(v.lang) || /粤|Cantonese|Sin[- ]?ji|Sinji/i.test(v.name);
  voice = vs.find(v => cn(v) && /female|Ting|Xiaoxiao|Huihui|Yaoyao|Tingting/i.test(v.name))
    ?? vs.find(cn)
    ?? vs.find(v => /zh[-_]TW/i.test(v.lang))
    ?? vs.find(v => /^zh/i.test(v.lang) && !yue(v))
    ?? null;                      // 宁可不指定，也不要用粤语的声音（指定了就一定是粤语腔）
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
  /* 声音列表是**异步**来的，而且 iOS 上 onvoiceschanged 不一定触发 ——
     开头几秒自己多问几遍，问到为止。挑不到中文声音就一直是 null，
     那会儿 speak 出来的很可能是英文腔，或者干脆没声。 */
  const retry = setInterval(() => {
    if (voice || ++voiceTries > 20) { clearInterval(retry); return; }
    pickVoice();
  }, 500);
}

/* ---- 自录语音包（可选）----
   服务端直接把"哪一条播哪个地址"算好给我们（`{ peng: '/voice/ly_tilong/peng.m4a', … }`）——
   格式可能是 mp3 / m4a / webm，玩法还可能各有一套，路径不该由客户端瞎猜。
   叠三层，后面盖前面：随包带的 → 后台传的通用 → 后台传的**这个玩法专属**。
   没录的那条自动退回 TTS，TTS 也发不出声就退到音效。 */
let clips: Record<string, string[]> = {};
let loading = '';               // 正在拉的是哪一套（同一套别同时拉两遍）

/** 玩家挑的那一套报牌声：'' = 跟这个玩法的默认，'off' = 只用系统声音（不放录音） */
export function voicePack(): string {
  try { return localStorage.getItem('phz_voicepack') ?? ''; } catch { return ''; }
}
export function setVoicePack(id: string) {
  try { localStorage.setItem('phz_voicepack', id); } catch { /* ignore */ }
  loadVoicePack(lastVariant);   // 换了一套：立刻重拉
}
/** 有哪些套可以挑（后台传了录音的才算） */
export function voicePacks(): Promise<{ id: string; name: string; count: number }[]> {
  return fetch('/api/voice?packs=1').then(r => r.json()).then((d: any) => d.packs ?? []).catch(() => []);
}

/**
 * 这一条挑一个录法来放（后台可以给同一条录 / 生成两三种说法）。
 *
 * 不是每次纯随机 —— 纯随机是会漏的：三条里连着好几把都抽不到第三条很正常，
 * 玩家的感觉就是"第三种从来没听见过"。
 * 改成**洗牌轮流**：把这一条的几个录法洗一遍，一个一个用完，用完再洗一次。
 * 每一轮里每条都恰好出现一次，顺序还是乱的。
 */
const bag: Record<string, string[]> = {};
function pickClip(key: string) {
  const a = clips[key];
  if (!a || !a.length) return '';
  if (a.length === 1) return a[0];
  let b = bag[key];
  if (!b || !b.length) {
    b = a.slice();
    for (let i = b.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [b[i], b[j]] = [b[j], b[i]]; }
    bag[key] = b;
  }
  return b.pop()!;
}
/** 报牌用得上的那些都有录音了吗 —— 都有的话这一局根本不会去碰系统 TTS */
const COVER = ['peng', 'chi', 'pao', 'ti', 'long', 'wei', 'hu', 'zimo', 'pass', 'your_turn', 'can_hu'];
function clipsCover() { return COVER.every(k => !!clips[k]); }

/* ---- 录音走 WebAudio ----
   下载一次、解码一次，之后每次播都是现成的 buffer。
   AudioContext 在第一次手势时就解锁了（滴答声一直响就是证明），所以这条路不会被
   自动播放策略拦下，也没有 <audio> 元素个数的限制。 */
const decoded: Record<string, AudioBuffer | null> = {};
const grabbing: Record<string, Promise<AudioBuffer | null>> = {};
function grab(url: string): Promise<AudioBuffer | null> {
  if (url in decoded) return Promise.resolve(decoded[url]);
  return grabbing[url] ??= fetch(url)
    .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(b => new Promise<AudioBuffer>((ok, no) => {
      const ac = audioCtx(true);          // 只是解码，不算"出声"，别把音频线程叫醒
      if (!ac) return no(new Error('没有 AudioContext'));
      // 老 Safari 只认回调式的 decodeAudioData，所以两种写法都照顾到
      const r = ac.decodeAudioData(b, ok, no) as unknown as Promise<AudioBuffer> | undefined;
      if (r && typeof r.then === 'function') r.then(ok, no);
    }))
    .then(buf => (decoded[url] = buf))
    .catch(() => (decoded[url] = null));      // 这一段解不开：记下来，以后别再试
}
/** 把几段接连播完，播完了调 done。任何一段出岔子就返回 false，交给调用方退回 TTS。 */
function playBuffers(urls: string[], done: () => void): boolean {
  const ac = audioCtx();
  if (!ac) return false;
  const bufs = urls.map(u => decoded[u]);
  if (bufs.some(b => !b)) return false;       // 还没下好 / 解不开：这次先不走这条路
  try {
    let t = Math.max(ac.currentTime, ac.currentTime + 0.02);
    let last: AudioBufferSourceNode | null = null;
    for (const b of bufs as AudioBuffer[]) {
      const src = ac.createBufferSource();
      src.buffer = b; src.connect(ac.destination); src.start(t);
      t += b.duration; last = src;
    }
    if (last) last.onended = done; else return false;
    return true;
  } catch { return false; }
}

/**
 * 这一条要放哪几段录音。
 *
 * 有几处的 key 是**拼出来的**，语音包里根本没有同名文件，以前一律落空、退回系统 TTS ——
 * 后台明明整套都生成好了，桌上偏偏这几句还是机器音，就是这么来的：
 *   - 提龙带牌名：`ti:5` / `long:5`（"提龙，大玖！"）
 *   - 阳张：`yangb3`（"阳张 大叁"）
 * 拆成几段连着放就对上了：`ti` + `b9`、`yang` + `b3`。
 * 但凡缺一段就整条退回 TTS —— 宁可整句都是机器音，也别放出半截人声接半截机器音。
 */
function clipSeq(key?: string): string[] | null {
  if (!key) return null;
  if (clips[key]) return [pickClip(key)];
  let parts: string[] | null = null;
  if (key.includes(':')) {
    const [head, card] = key.split(':');
    const k = Number(card);
    if (Number.isFinite(k)) parts = [head, cardKey(k as Kind)];
  } else if (/^yang[sb]\d+$/.test(key)) {
    parts = ['yang', key.slice(4)];
  }
  if (!parts) return null;
  const urls = parts.map(p => pickClip(p));
  return urls.every(Boolean) ? urls : null;
}
let lastVariant = '';
/**
 * 进牌桌时拉一次清单。
 *
 * **每次都真去拉**（不再"这一套拉过就跳过"）：后台重新生成之后不重拉，
 * 就永远还是旧的那几条 —— 表现就是"后台明明改了，牌桌上还是老声音"。
 * 清单很小（几 KB），而每条地址后面挂着 `?v=<改动时间>`：没变的那些地址一模一样，
 * 解码缓存直接命中，不会重下也不会重解；变过的地址变了，自然就换上新的。
 */
export function loadVoicePack(variant = '') {
  lastVariant = variant;
  const p = voicePack();
  const sig = `${variant}|${p}`;
  if (loading === sig) return;                    // 同一套别同时拉两遍
  loading = sig;
  if (p === 'off') { clips = {}; loading = ''; return; }     // 只要系统声音：录音一概不放
  fetch(`/api/voice?v=${encodeURIComponent(variant)}&p=${encodeURIComponent(p)}`).then(r => r.json()).then((d: { clips?: Record<string, string>; takes?: Record<string, string[]> }) => {
    clips = d.takes ?? Object.fromEntries(Object.entries(d.clips ?? {}).map(([k, v]) => [k, [v]]));
    for (const k of Object.keys(bag)) delete bag[k];      // 清单换了，轮流的那一摞也倒掉重来
    /* 预热：把每一段**下下来解好码**存进内存（见 grab）。
       以前只是 `new Audio(u).load()` —— 真播的时候还是每句现 new 一个 <audio>，
       而手机上这一步很不牢靠：iOS 同时能用的 <audio> 元素个数有限、微信 / 安卓 WebView
       又会拿自动播放策略拦一道，`play()` 一被拒就退回系统 TTS。
       "小二没声""该你出牌一会儿是人声一会儿是机器音"都是这么来的 —— 文件一直都在。
       解码一次之后走 AudioContext 播（跟倒计时的滴答同一条路，早就解锁了），就再没有这一层。 */
    for (const a of Object.values(clips)) for (const u of a) grab(u);
    loading = '';
  }).catch(() => { loading = ''; /* 没有语音包就算了 */ });
}
loadVoicePack('');

interface Item { text: string; key?: string }
const queue: Item[] = [];
let speaking = false;
let stuckTimer: ReturnType<typeof setTimeout> | null = null;
function finish() {
  if (stuckTimer) { clearTimeout(stuckTimer); stuckTimer = null; }
  speaking = false;
  pump();
}
/* ---- TTS 到底出没出声 ----
   `speak()` 在不少机型上是**静默失败**的：不报错、也不回调，声音就是没有
   （手机上没装中文引擎、微信一类的内置浏览器、系统 TTS 被关掉……）。
   唯一能看出来的信号是 `onstart` 有没有来 —— 连着几次都没来，就认定这台机器发不出人声，
   往后直接走音效（见 cue）。真人声一旦响过一次，这个判断就永久解除。 */
let ttsMisses = 0;
let ttsOk = false;
/** 这台机器的人声还能不能指望（连吃 3 次哑火就不指望了） */
export function ttsUsable() { return ttsOk || ttsMisses < 3; }

function speakTTS(text: string, key?: string) {
  if (!('speechSynthesis' in window)) { cue(key); finish(); return; }
  if (!ttsUsable()) { cue(key); finish(); return; }     // 这台机器发不出人声：直接给音效
  if (!voice) pickVoice();      // iOS 的声音列表常常晚到，每次都再挑一次，挑到为止
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN'; if (voice) u.voice = voice; u.rate = 1.1; u.pitch = 1;   // 一律按普通话读
  let started = false;
  u.onstart = () => { started = true; ttsOk = true; ttsMisses = 0; };
  u.onend = u.onerror = finish;
  // iOS Safari 有时不触发 onend，队列会卡死：按字数给一个兜底超时
  stuckTimer = setTimeout(() => {
    /* 到点了还没 onstart：这一句根本没出声。记一笔，并且**补一个音效** ——
       宁可听见"叮"，也别让人以为游戏卡了。 */
    if (!started) { ttsMisses++; cue(key); }
    finish();
  }, 900 + text.length * 220);
  keepAwake();                                   // speak 之前先把 paused 的状态捞回来
  try { speechSynthesis.speak(u); } catch { ttsMisses++; cue(key); finish(); }
}
function pump() {
  if (speaking || !queue.length) return;
  const it = queue.shift()!;
  speaking = true;
  // 有录音 → 放录音（拼出来的 key 就分几段连着放）；一段都没有 → 交给系统 TTS
  const seq = clipSeq(it.key);
  if (seq) {
    // 先走 WebAudio（稳）；没解好码就照旧用 <audio>，同时在后台把它解出来，下次就走上面那条
    if (stuckTimer) { clearTimeout(stuckTimer); stuckTimer = null; }
    const total = seq.length * 3000;
    stuckTimer = setTimeout(finish, total);
    if (playBuffers(seq, finish)) return;
    for (const u of seq) grab(u);
    let i = 0;
    const step = () => {
      if (i >= seq.length) { finish(); return; }
      const a = new Audio(seq[i++]);
      a.onended = step;
      a.onerror = () => finish();
      // 整条的兜底：几段加起来也不该超过这个数，超了就当放完，别把队列堵死
      if (stuckTimer) clearTimeout(stuckTimer);
      stuckTimer = setTimeout(finish, 3000 * (seq.length - i + 1));
      a.play().catch(() => {
        if (stuckTimer) { clearTimeout(stuckTimer); stuckTimer = null; }
        speakTTS(it.text, it.key);          // 浏览器不让放（没解锁过）：整条退回 TTS
      });
    };
    step();
    return;
  }
  speakTTS(it.text, it.key);
}

/* ---- 让语音别"睡过去" ----
   iOS / Chrome 上 `speechSynthesis` 会莫名其妙停在 paused：切个后台回来、接个电话、
   锁屏一会儿、甚至只是闲置久了，就再也不出声了 —— 而滴答声走的是 WebAudio，
   压根不受这一套影响，所以听起来就是"倒计时有声、报牌没声"。
   解法只有一个：**不停地把它捞回来**。 */
export function keepAwake() {
  try {
    const ss = window.speechSynthesis;
    if (!ss) return;
    if (ss.paused) ss.resume();
    /* Chrome 还有个老毛病：闲置一阵之后 speak 就没反应了，
       pause→resume 走一遭能把它盘活（不影响正在念的那一句）。 */
    else if (!ss.speaking && !ss.pending) { ss.resume(); }
  } catch { /* ignore */ }
  // 这儿**不叫醒** AudioContext：心跳是给 TTS 续命的，把音频线程一直吊着只会让手机发烫。
  // 真要出声的时候（tone / 放录音）自然会 resume。
}

// iOS Safari：必须先在用户手势里 speak 过一次，之后的播报才有声音
let unlocked = false;
export function unlockAudio() {
  keepAwake();                 // 每一次手势都捞一把（不只第一次）
  audioCtx();                  // 手势里叫醒音频最保险（iOS 只在手势里才肯 resume）
  /* 那句"无声的话"以前只在第一次手势说一次。可 iOS 的朗读器**息屏、切后台、
     接个电话回来之后会整个僵住** —— 队列还在、就是不出声，而且只有在一次真实手势里
     重新喂它一句才能盘活。所以现在每次手势都补一句（音量 0，听不见），
     代价几乎为零，换回来的是"暂停回来还有语音"。 */
  try {
    if ('speechSynthesis' in window) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance('\u00a0');
      u.volume = 0; u.lang = 'zh-CN';
      speechSynthesis.speak(u);
      if (!unlocked) pickVoice();
    }
  } catch { /* ignore */ }
  unlocked = true;
  /* 朗读器也会被打断卡住：cancel + resume 是 iOS 上唯一能盘活它的组合拳 */
  try { if ('speechSynthesis' in window) { speechSynthesis.cancel(); speechSynthesis.resume(); } } catch { /* ignore */ }
  const ac = audioCtx();
  try { ac?.resume().catch(() => { /* ignore */ }); } catch { /* ignore */ }
  /* resume 之后还不是 running，就别再指望它了 —— 直接推倒重建（见 resetAudio 的说明）。
     这一步必须在**用户手势里**做，所以只放在这儿，心跳里不做。 */
  if (audioStuck()) resetAudio();
}
let ctx: AudioContext | null = null;
let lastSound = 0;                         // 上一次真出声是什么时候
/**
 * 共用的 AudioContext：滴答声、语音回放都走它，iOS 上首次手势时解锁。
 *
 * **闲下来要让它睡**：一个 running 的 AudioContext 会把手机的音频线程一直开着，
 * 哪怕一声不响也在烧电 —— 这是"打一会儿牌手机就发烫"的一个实打实的来源。
 * 所以每次真出声记一下时间，超过一分钟没动静就 suspend；下次要出声时这儿自动 resume。
 */
export function audioCtx(quiet = false): AudioContext | null {
  try { ctx ??= new (window.AudioContext || (window as any).webkitAudioContext)(); } catch { return null; }
  if (!quiet) lastSound = Date.now();
  if (ctx && ctx.state === 'suspended' && !quiet) ctx.resume().catch(() => { /* ignore */ });
  return ctx;
}

/**
 * 把整套音频**推倒重建**。
 *
 * 为什么非得重建、光 resume 不行：iOS 的 WebAudio 被别的声音打断过之后
 * （来电、锁屏、别的 app 抢了音频、甚至只是息屏久了），AudioContext 会掉进一个
 * **`interrupted`** 的状态。这个状态 `resume()` 是拉不回来的 —— 你调了它也说成功，
 * 可就是一声不响。用户那边的体感正是："在 app 里怎么点都没用，按一下手机的音量键就好了"
 * （按音量键等于让系统重新接管一次音频会话，把它踢出 interrupted）。
 * 我们没法从网页里碰系统的音频会话，能做的就是：**把旧的 context 关掉、建一个新的**。
 *
 * 代价是解码好的那些语音片段是绑在旧 context 上的，新 context 用不了，
 * 所以缓存要一起清掉、重新解一遍（几十 KB 的 mp3，重解很快）。
 */
export function resetAudio() {
  const old = ctx;
  ctx = null;
  try { old?.close(); } catch { /* 关不掉就算了，反正不再用它 */ }
  for (const k of Object.keys(decoded)) delete decoded[k];
  for (const k of Object.keys(grabbing)) delete grabbing[k];
  const ac = audioCtx();
  if (!ac) return null;
  /* 新 context 建好之后，**在这一次手势里**播一段极短的无声 —— 
     iOS 要"真的出过声"才认这个 context 是活的，光建出来不算。 */
  try {
    const b = ac.createBuffer(1, 1, ac.sampleRate);
    const src = ac.createBufferSource();
    src.buffer = b; src.connect(ac.destination); src.start(0);
  } catch { /* ignore */ }
  try { ac.resume().catch(() => { /* ignore */ }); } catch { /* ignore */ }
  return ac;
}

/** 音频是不是"看着活着、其实已经死了" */
export function audioStuck() {
  const st = ctx ? (ctx.state as string) : '';
  return !!ctx && st !== 'running' && st !== 'suspended';   // interrupted / closed 都算
}
/**
 * 让音频睡下 —— **只在页面切到后台的时候**。
 *
 * 本来是"闲一分钟就睡"，那样更省电，可有个要命的副作用：
 * iOS 上 `resume()` 往往**要有用户手势才给**。前台闲了一分钟被我们自己睡掉，
 * 等下一句该报牌了想叫醒，人手指没碰屏幕 —— 叫不醒，于是一声不吭。
 * （表现就是"打着打着突然不报牌了"。滴答声也一样。）
 * 切到后台就没这个问题：回到前台一定伴着一次触碰，而且系统本来也会把音频挂起。
 */
function napAudio() {
  if (!ctx || ctx.state !== 'running') return;
  if (document.visibilityState === 'visible') return;
  try { ctx.suspend().catch(() => { /* ignore */ }); } catch { /* ignore */ }
}
if (typeof window !== 'undefined') {
  /* 手势监听**不能只挂一次**：第一次解锁之后，语音还是会被切后台、来电、锁屏弄睡着。
     每次碰屏幕都顺手捞一把（unlockAudio 里的真正解锁只跑一遍，其余就是 keepAwake）。 */
  for (const ev of ['touchend', 'pointerup', 'click', 'keydown']) window.addEventListener(ev, unlockAudio, { passive: true } as any);
  /* 心跳：看一眼 TTS 有没有睡过去。
     原来是**雷打不动每 2 秒一次**，切到后台也照跑，而且顺手把 AudioContext 也叫醒 ——
     手机就一直有个音频线程醒着，什么都不干也在耗电（发烫的一份）。
     现在：页面不在前台不跑；**整套录音都在的时候不跑**（那会儿压根不用 TTS）；
     间隔 2 秒放宽到 6 秒。顺带每一拍看看音频要不要睡。 */
  setInterval(() => {
    if (document.visibilityState !== 'visible') { napAudio(); return; }   // 后台：把音频挂起就行
    if (settings.tts && !clipsCover()) keepAwake();
  }, 6000);
  // 从后台切回来：多半已经 paused 了，立刻捞，并且把声音列表重挑一次
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') { napAudio(); return; }
    audioCtx();                 // 回到前台：把音频叫醒（后台那会儿我们把它挂起了）
    keepAwake(); pickVoice();
  });
  window.addEventListener('pageshow', () => { keepAwake(); pickVoice(); });
}

/* ---- 发不出人声时的兜底音效 ----
   每个动作一个有辨识度的短音，走 WebAudio 现合成（跟倒计时的滴答一条路，没有任何依赖）。
   宁可听见"叮"，也别让人以为游戏卡住了 —— 牌桌上"别人碰了"这件事必须听得见。 */
function tone(freq: number, ms: number, vol = 0.1, type: OscillatorType = 'triangle', delay = 0) {
  try {
    const ac = audioCtx(); if (!ac) return;
    const t0 = ac.currentTime + delay;
    const o = ac.createOscillator(); const g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
    o.connect(g).connect(ac.destination); o.start(t0); o.stop(t0 + ms / 1000 + 0.02);
  } catch { /* 无音频 */ }
}
/** 一个动作对应的提示音（key 就是语音包那套文件名） */
export function cue(key?: string) {
  if (!settings.tts || !key) return;
  /* 有几处的 key 是拼出来的（提龙带牌名 `long:5`、阳张 `yangb3`…）——
     取冒号前那一段，不然这些动作就一点声音都没有了。 */
  const k0 = key.split(':')[0];
  switch (k0) {
    case 'peng': tone(660, 90, .12); tone(660, 110, .12, 'triangle', .12); break;          // 碰：两下顿音
    case 'chi': tone(523, 110, .1); tone(784, 130, .1, 'triangle', .1); break;             // 吃：一路上扬
    case 'pao': tone(880, 90, .12); tone(587, 150, .12, 'triangle', .1); break;            // 跑：往下落
    case 'ti': case 'long': tone(698, 90, .12); tone(880, 90, .12, 'triangle', .1); tone(1046, 160, .12, 'triangle', .2); break;
    case 'wei': tone(587, 150, .1, 'sine'); break;                                          // 偎：柔一点
    case 'hu': tone(659, 110, .14); tone(880, 110, .14, 'triangle', .11); tone(1318, 260, .14, 'triangle', .22); break;
    case 'zimo': tone(659, 100, .14); tone(880, 100, .14, 'triangle', .1); tone(1046, 100, .14, 'triangle', .2); tone(1318, 300, .14, 'triangle', .3); break;
    case 'pass': tone(392, 90, .08, 'sine'); break;                                         // 过：低低一声
    case 'your_turn': tone(988, 80, .12); tone(988, 110, .12, 'triangle', .14); break;      // 该你了：两声清脆
    case 'foul': tone(233, 160, .13, 'square'); tone(196, 220, .13, 'square', .16); break;  // 违规：难听一点才记得住
    case 'liuju': tone(587, 120, .1); tone(494, 120, .1, 'triangle', .12); tone(392, 240, .1, 'triangle', .24); break;
    case 'start': tone(523, 90, .1); tone(784, 140, .1, 'triangle', .1); break;
    case 'can_hu': tone(1046, 90, .13); tone(1318, 160, .13, 'triangle', .11); break;   // 你可以胡了
    default: break;   // 牌名（s1…b10）不配音效：一局几十张，叮个没完反而吵
  }
}

/** 播报打牌用语：碰、吃、胡、过、牌名等；key 命中 /voice/<key>.mp3 时用录音 */
/** 插队播报：自己胡牌这种关键动作，别被前面排队的字牌名压住 */
export function sayNow(text: string, key?: string) {
  if (!settings.tts || !text) return;
  queue.length = 0;
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  if (stuckTimer) { clearTimeout(stuckTimer); stuckTimer = null; }
  speaking = false;
  queue.push({ text, key });
  pump();
}

export function say(text: string, key?: string) {
  if (!settings.tts || !text) return;
  // 节奏已经由事件队列控制，这里只留很短的待播队列，免得越积越多、听着"时有时无"
  while (queue.length > 1) queue.shift();
  queue.push({ text, key });
  pump();
}
export function stopSpeech() { queue.length = 0; speaking = false; if ('speechSynthesis' in window) speechSynthesis.cancel(); }

/** 牌名读法：大写读“大X”，小写读“小X”，接近湖南牌桌习惯 */
export function cardSpeech(k: Kind): string {
  const n = nameOf(k);
  return (isBig(k) ? '大' : '小') + n;
}
/** 牌名对应的录音文件名：小一→s1 … 大拾→b10 */
export function cardKey(k: Kind): string { return (isBig(k) ? 'b' : 's') + rankOf(k); }

export const ACTION_WORDS: Record<string, string> = {
  // 注意：牌组的每一种 type 都要有词，少一个会让播报队列卡死（long 就漏过一次）
  hu: '胡了！', ti: '提龙！', long: '提龙！', pao: '开跑！', wei: '笑起！', peng: '碰！', chi: '吃！', pass: '过', play_drawn: '', discard: '',
};

// ---------- 语音聊天 ----------
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let startAt = 0;

export async function startRecording(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(m => (window as any).MediaRecorder?.isTypeSupported?.(m)) ?? '';
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 24000 } : undefined);
    chunks = [];
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.start(250);
    startAt = Date.now();
    return true;
  } catch { return false; }
}

export function stopRecording(): Promise<{ data: string; mime: string; durationMs: number } | null> {
  return new Promise(resolve => {
    const r = recorder; recorder = null;
    if (!r) return resolve(null);
    r.onstop = async () => {
      r.stream.getTracks().forEach(t => t.stop());
      const durationMs = Date.now() - startAt;
      const blob = new Blob(chunks, { type: r.mimeType });
      if (durationMs < 400 || blob.size < 200 || blob.size > 400000) return resolve(null);
      const buf = await blob.arrayBuffer();
      let s = ''; const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      resolve({ data: btoa(s), mime: r.mimeType, durationMs });
    };
    r.stop();
  });
}

export function playVoice(data: string, mime: string): Promise<void> {
  return new Promise(resolve => {
    const bin = atob(data); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = new Audio(url);
    a.onended = a.onerror = () => { URL.revokeObjectURL(url); resolve(); };
    a.play().catch(() => resolve());
  });
}

// ---------- 语音指令（实验性：说“碰”“过”“胡”即可操作） ----------
let recog: any = null;
export function startVoiceCommands(onCmd: (cmd: 'peng' | 'chi' | 'hu' | 'pass' | 'ti' | 'pao' | 'wei') => void): boolean {
  const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  if (!SR) return false;
  stopVoiceCommands();
  recog = new SR();
  recog.lang = 'zh-CN'; recog.continuous = true; recog.interimResults = false;
  recog.onresult = (e: any) => {
    const text: string = e.results[e.results.length - 1][0].transcript;
    if (/胡/.test(text)) onCmd('hu');
    else if (/提/.test(text)) onCmd('ti');
    else if (/跑/.test(text)) onCmd('pao');
    else if (/偎|喂|围/.test(text)) onCmd('wei');
    else if (/碰|棚/.test(text)) onCmd('peng');
    else if (/吃/.test(text)) onCmd('chi');
    else if (/过|要不起|不要/.test(text)) onCmd('pass');
  };
  recog.onend = () => { if (recog) try { recog.start(); } catch { /* ignore */ } };
  try { recog.start(); return true; } catch { return false; }
}
export function stopVoiceCommands() { if (recog) { const r = recog; recog = null; try { r.stop(); } catch { /* ignore */ } } }
