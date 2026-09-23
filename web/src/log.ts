/**
 * 客户端"黑匣子"：把最近发生的事记在内存里，出事的时候连同报错一起送回服务端，
 * 写进服务端日志（本地 server/data/paohuzi.log，外服 /var/log/paohuzi.log）。
 * H5 装在手机上没法开控制台，这是唯一能拿到现场的办法。
 */
const RING: string[] = [];
const MAX = 60;
let lastSent = 0;

export function note(tag: string, detail?: unknown) {
  const t = new Date().toISOString().slice(11, 23);
  let d = '';
  try { d = detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 200); }
  catch { d = '(无法序列化)'; }
  RING.push(`${t} ${tag}${d ? ' ' + d : ''}`);
  if (RING.length > MAX) RING.shift();
}

export function report(kind: string, msg: string) {
  const now = Date.now();
  if (now - lastSent < 5000) return;      // 别刷屏：5 秒最多报一次
  lastSent = now;
  const body = {
    kind, msg: String(msg).slice(0, 500),
    ua: navigator.userAgent.slice(0, 160),
    standalone: (() => { try { return matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true; } catch { return false; } })(),
    tail: RING.slice(-40),
  };
  try {
    const s = JSON.stringify(body);
    if (navigator.sendBeacon) navigator.sendBeacon('/api/clientlog', new Blob([s], { type: 'application/json' }));
    else fetch('/api/clientlog', { method: 'POST', body: s, keepalive: true }).catch(() => { /* 报不上去就算了 */ });
  } catch { /* ignore */ }
}

/* ── 泄漏探针 ───────────────────────────────────────────────────────
   "越玩越卡、刷新就好"是典型的泄漏：有东西只增不减。
   光靠猜很难猜中，所以这儿把几样最容易漏的东西数起来，每分钟记一笔；
   哪一项翻着番地涨，一看日志就知道漏在哪，不用再一处处翻代码。
   代价极小：包一层计数，只在真的涨起来了才往回报一次。 */
const LIVE = { timer: 0, interval: 0, listener: 0, raf: 0 };
function installCounters() {
  const w = window as any;
  const st = w.setTimeout, ct = w.clearTimeout, si = w.setInterval, ci = w.clearInterval;
  w.setTimeout = (fn: any, ms?: any, ...a: any[]) => {
    LIVE.timer++;
    return st(function (this: any, ...b: any[]) { LIVE.timer--; return typeof fn === 'function' ? fn.apply(this, b) : undefined; }, ms, ...a);
  };
  w.clearTimeout = (id: any) => { if (id !== undefined) LIVE.timer--; return ct(id); };
  w.setInterval = (...a: any[]) => { LIVE.interval++; return si(...a); };
  w.clearInterval = (id: any) => { if (id !== undefined) LIVE.interval--; return ci(id); };
  for (const t of [w.EventTarget.prototype]) {
    const ael = t.addEventListener, rel = t.removeEventListener;
    t.addEventListener = function (this: any, ...a: any[]) { if (this === window || this === document) LIVE.listener++; return ael.apply(this, a); };
    t.removeEventListener = function (this: any, ...a: any[]) { if (this === window || this === document) LIVE.listener--; return rel.apply(this, a); };
  }
}
function watchLeaks() {
  let base: Record<string, number> | null = null;
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    const now: Record<string, number> = {
      节点: document.getElementsByTagName('*').length,
      动画: (document as any).getAnimations ? document.getAnimations().length : -1,
      定时器: LIVE.timer, 循环: LIVE.interval, 监听: LIVE.listener,
    };
    note('体检', Object.entries(now).map(([k, v]) => `${k}${v}`).join(' '));
    if (!base) { base = { ...now }; return; }
    // 任何一项涨到基线的三倍还多出 200，就报一次（之后以新值为基线，不刷屏）
    for (const k of Object.keys(now)) {
      if (now[k] > base[k] * 3 + 200) {
        report('leak', `${k} 从 ${base[k]} 涨到 ${now[k]}（` + Object.entries(now).map(([a, b]) => `${a}${b}`).join(' ') + '）');
        base = { ...now }; return;
      }
    }
  }, 60000);
}

/** 装在最外层：脚本报错、Promise 没接住、主线程卡住，全都往回报 */
export function installClientLog() {
  installCounters();
  watchLeaks();
  window.addEventListener('error', e => {
    note('！脚本出错', `${e.message} @${(e.filename ?? '').split('/').pop()}:${e.lineno}`);
    report('error', `${e.message} @${(e.filename ?? '').split('/').pop()}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener('unhandledrejection', e => {
    const m = (e as PromiseRejectionEvent).reason;
    note('！Promise 没接住', String(m?.message ?? m));
    report('reject', String(m?.stack ?? m?.message ?? m));
  });
  /* 主线程卡住：每 500ms 打一拍，迟到太久就说明这段时间页面是死的。
     ——— 但"打拍迟到"有两种完全不同的原因，以前混成了一种，报出来的数没法看：
       ① 真卡：JS 在主线程上死循环 / 同步干重活，页面点不动；
       ② 整个页面被**挂起**：电脑合盖睡了、系统休眠、标签页被浏览器冻结。
     ②的时候定时器根本没跑，醒来一看"迟到了 205 秒" —— 可页面一点毛病没有。
     （真要卡 205 秒，那页面基本等于死了，不可能还接着打牌。）
     分辨办法：另开一个 worker 也打自己的拍。主线程真卡的时候 worker 照跑，两边对不上；
     整台机器睡过去的时候 worker 也跟着停，两边一样迟到 —— 那就不是卡，是挂起。 */
  let wLast = 0;                       // worker 那边最后一次打拍的时刻（它自己的表）
  let worker: Worker | null = null;
  try {
    const src = 'let t=Date.now();setInterval(()=>{t=Date.now();postMessage(t)},1000)';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = e => { wLast = e.data as number; };
  } catch { /* 开不出 worker 就退回老办法，只是分不清两种情况 */ }

  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const late = now - last - 1000;
    last = now;
    if (late <= 3000 || document.visibilityState !== 'visible') return;
    // worker 的拍也一起迟到 → 是整个页面被挂起，不是主线程卡
    const wLate = worker && wLast ? now - wLast - 1000 : 0;
    const suspended = !worker || !wLast || wLate > late * 0.5;
    if (suspended) {
      note('页面挂起过', `${(late / 1000).toFixed(1)}s（睡眠 / 切后台，不是卡）`);
      // 挂起之后连接多半已经断了，让上层自己去重连对表
      window.dispatchEvent(new Event('phz-wake'));
      return;
    }
    note('！主线程卡住', `${(late / 1000).toFixed(1)}s`);
    report('stall', `主线程卡了 ${(late / 1000).toFixed(1)} 秒（worker 只迟到 ${(wLate / 1000).toFixed(1)} 秒）`);
  }, 1000);   // 一秒一拍就够了：拍子越密，手机醒得越频繁
}
