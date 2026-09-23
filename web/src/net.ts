/** REST + WebSocket 客户端 */
import { deviceId } from './device.ts';
import type { ClientMsg, ServerMsg, PublicUser } from '../../server/src/protocol.ts';

const params = new URLSearchParams(location.search);
export const PLATFORM = params.get('platform') ?? ((window as any).NativeBridge?.platform ?? 'web');
/** 服务器地址：地址栏 ?api= > 壳注入 > 本机存过的 > 同源（页面从哪儿来就连哪儿） */
export const DEFAULT_API = 'http://paohuzi.yytbank.cn:1991';
function savedApi(): string { try { return localStorage.getItem('phz_api') ?? ''; } catch { return ''; } }
const API_BASE = params.get('api') ?? (window as any).__API_BASE__ ?? savedApi() ?? '';
/** 当前用的服务器地址（空 = 同源） */
export function apiBase(): string { return API_BASE || location.origin; }
/** 改服务器地址：存下来 → 壳里通知 Native 重新加载，浏览器里直接刷新 */
export function setApiBase(v: string) {
  const url = v.trim().replace(/\/$/, '');
  try { url ? localStorage.setItem('phz_api', url) : localStorage.removeItem('phz_api'); } catch { /* ignore */ }
  const nb = (window as any).NativeBridge;
  if (nb?.setServer && url) { nb.setServer(url); return; }
  location.reload();
}
const WS_URL = API_BASE
  ? API_BASE.replace(/^http/, 'ws') + '/ws'
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

export function getToken(): string | null {
  const t = params.get('token');
  if (t) { try { localStorage.setItem('phz_token', t); } catch { /* ignore */ } return t; }
  try { return localStorage.getItem('phz_token'); } catch { return null; }
}
export function setToken(t: string | null) { try { t ? localStorage.setItem('phz_token', t) : localStorage.removeItem('phz_token'); } catch { /* ignore */ } }

export async function api<T = any>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const token = getToken();
  const r = await fetch(API_BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data as T;
}

export interface AuthResult { token: string; user: PublicUser & { canOpenRoom: boolean } }

type Listener = (msg: ServerMsg) => void;

export class Socket {
  ws: WebSocket | null = null;
  listeners = new Set<Listener>();
  status: 'closed' | 'connecting' | 'open' | 'authed' = 'closed';
  onStatus?: (s: Socket['status']) => void;
  private retry = 0;
  private closedByUser = false;
  serverOffset = 0;   // serverNow - clientNow
  /** 最近量到的往返延迟（毫秒）：ping/pong 量出来的，下一次 ping 捎给服务端 */
  rtt = 0;
  /** 校时用的最好的一次样本：rtt 越小，这一次算出来的偏差越准 */
  private bestRtt = Infinity;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /* ---- 心跳看门狗 ----
     只发 ping 不看回音，等于没有心跳：网线拔了 / Wi-Fi 切 4G / 家里路由重启，
     底下的 TCP 断了但浏览器**不一定**报 onclose，readyState 还是 OPEN，
     send() 照样"成功"（其实石沉大海），于是牌桌就那么定在那儿不动了 ——
     玩家看到的是"卡住"，服务端那头早就当他掉线、让机器人接着打了。
     所以这里记下最后一次听到服务端说话的时刻，久了没动静就主动掐掉走重连。 */
  private lastHeard = 0;
  /** 确认这个服务端**会**回 pong 之后才敢启用看门狗（老版本不回 pong，不能把人家踢成重连死循环） */
  private sawPong = false;
  /** 多久没听到动静算断了：ping 15 秒一次，漏三拍 */
  static DEAD_MS = 46000;

  /* 电脑合盖睡了一觉、或者标签页被冻结之后：这条连接多半已经是"半死"的 ——
     底下的 TCP 早断了，浏览器却还没报 onclose，于是 readyState 仍然是 OPEN，
     发出去的牌石沉大海，看着就是"牌桌不动了"。
     log.ts 那边察觉到页面挂起过会广播 phz-wake，这里收到就主动把它掐掉，
     走正常的重连流程重新对表。 */
  private wakeBound = false;
  private bindWake() {
    if (this.wakeBound) return;
    this.wakeBound = true;
    const kick = () => this.hardReconnect();
    window.addEventListener('phz-wake', kick);
    /* 系统报"网回来了"：切 Wi-Fi、出电梯、飞行模式关掉。这时候旧连接八成已经是死的，
       但浏览器往往要等 TCP 自己超时才报 onclose —— 不等它，直接换一条新的。 */
    window.addEventListener('online', kick);
    /* 切回前台也查一岗：后台待久了连接多半也废了，回来第一眼就该是活的牌桌 */
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || this.closedByUser) return;
      if (this.sawPong && this.lastHeard && Date.now() - this.lastHeard > Socket.DEAD_MS) kick();
    });

  }

  connect() {
    this.bindWake();
    this.closedByUser = false;
    this.setStatus('connecting');
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.lastHeard = Date.now(); this.setStatus('open'); const t = getToken(); if (t) this.send({ type: 'auth', token: t, deviceId: deviceId() }); this.startPing(); };
    ws.onmessage = e => {
      this.lastHeard = Date.now();   // 服务端只要说了话，这条线就是活的（不限于 pong）
      let msg: ServerMsg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'auth.ok') this.setStatus('authed');
      if (msg.type === 'pong') { this.onPong(msg.t, msg.now); return; }
      /* 兜底校时：还没量到过 rtt 的时候（刚连上、或者服务端是老版本没回 pong），
         先拿牌局快照里的 serverNow 凑合用 —— 它没减传输延迟，会偏慢半个来回。 */
      if (this.bestRtt === Infinity && (msg.type === 'room.state' || msg.type === 'game.events') && msg.room.game?.serverNow) this.serverOffset = msg.room.game.serverNow - Date.now();
      for (const l of this.listeners) l(msg);
    };
    ws.onclose = () => {
      this.setStatus('closed');
      this.stopPing(); this.bestRtt = Infinity;   // 换了条线路，之前量的那些不作数了
      if (!this.closedByUser) setTimeout(() => this.connect(), Math.min(4000, 400 * 2 ** this.retry++));   // 退避最多 4 秒：静默重连要快，掉得越短玩家越察觉不到
    };
    ws.onerror = () => ws.close();
  }
  close() { this.closedByUser = true; this.stopPing(); this.ws?.close(); }

  /* 断定这条连接已经废了：**不等** onclose 自己冒出来 —— 半死的 TCP 上 close()
     还要跟对面走一遍关闭握手，对面已经不在了，可能要等到浏览器自己超时才回调，
     那段时间牌桌照样是定住的。所以把旧的回调全摘掉、关上不管它，当场另起一条。 */
  private hardReconnect() {
    if (this.closedByUser) return;
    this.retry = 0;                 // 不是退避该管的场合：这是"换一条线"，要快
    this.stopPing();
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onopen = null; old.onmessage = null; old.onerror = null; old.onclose = null;
      try { old.close(); } catch { /* 已经关了就算了 */ }
    }
    this.bestRtt = Infinity;        // 换了条线路，之前量的那些不作数了
    this.connect();
  }

  /* ---- 量延迟 + 校时 ----
     按 NTP 那套来：发出去记 t0，服务端回 pong 时把 t0 和它收到的时刻 ts 原样带回来，
     收到时记 t1。往返 rtt = t1 - t0，假设来回各走一半，那么服务端"此刻"约等于 ts + rtt/2，
     于是时钟偏差 = ts + rtt/2 - t1。
     只认**rtt 最小**的那次样本：网络一抖，那一次算出来的偏差就不准，
     而最快的那一趟最接近"来回均分"这个假设。 */
  private startPing() {
    this.stopPing();
    const beat = () => {
      /* 先查岗再发：这个服务端确认会回 pong、可这么久没听到一句话 —— 这条连接已经是半死的。
         主动 close() 走 onclose 那条正常重连路，重连上会收到 room.state 重新对表。 */
      if (this.sawPong && this.lastHeard && Date.now() - this.lastHeard > Socket.DEAD_MS) { this.hardReconnect(); return; }
      this.send({ type: 'ping', t: Date.now(), rtt: this.rtt || undefined });
    };
    beat(); setTimeout(beat, 1500); setTimeout(beat, 4000);   // 刚连上先密一点，快点校准
    this.pingTimer = setInterval(beat, 15000);
  }
  private stopPing() { if (this.pingTimer) clearInterval(this.pingTimer); this.pingTimer = null; }
  private onPong(t0?: number, ts?: number) {
    this.sawPong = true;
    if (!t0 || !ts) return;
    const t1 = Date.now();
    const rtt = t1 - t0;
    if (rtt < 0 || rtt > 10000) return;
    this.rtt = rtt;
    if (rtt <= this.bestRtt) { this.bestRtt = rtt; this.serverOffset = ts + rtt / 2 - t1; }
  }
  send(msg: ClientMsg) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }
  on(l: Listener) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  private setStatus(s: Socket['status']) { this.status = s; this.onStatus?.(s); }
  /** 服务器时钟（用于倒计时） */
  now() { return Date.now() + this.serverOffset; }
}

export const socket = new Socket();
