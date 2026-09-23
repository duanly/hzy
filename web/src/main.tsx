import { Component, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MJ_VARIANT_ID, type PublicUser, type RoomView } from '../../server/src/protocol.ts';
import { socket, getToken, setToken, api, type AuthResult } from './net.ts';
import { Login } from './Login.tsx';
import { deviceId } from './device.ts';
import { initPerf } from './perf.ts';
import { Home } from './Home.tsx';
import { Table } from './Table.tsx';
import { MjRoom } from './MjRoom.tsx';
import { Spectate } from './Spectate.tsx';
import { ToastHost, toast } from './ui.tsx';
import { installClientLog, note } from './log.ts';

/** 这些"来晚了"的提示不用弹给玩家看 */
// 「快碰慢吃」也不用再弹了：按钮到点自己就收掉，看不见自然点不着；
// 万一慢半拍点上了（画面比服务端晚一点），服务端照样挡住，静静吞掉就行
// 「快碰慢吃」不再静音：按钮还在、点了却没反应，不给个说法玩家会以为卡了
const QUIET_ERRORS = ['not your turn', 'already decided', 'no claim for you', 'bad phase', 'invalid action', 'ended', 'must discard'];

installClientLog();

function App() {
  const [me, setMe] = useState<(PublicUser & { canOpenRoom?: boolean }) | null>(null);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [status, setStatus] = useState(socket.status);
  const [checked, setChecked] = useState(false);

  // 启动：有 token 先校验；没有就拿设备号问服务端这台机器有账号吗，有就直接进
  useEffect(() => {
    (async () => {
      try {
        if (getToken()) {
          const r = await api<{ user: PublicUser }>('/api/me', undefined, 'GET');
          setMe(r.user);
        } else {
          // 没有 token：先拿本机设备号去问一声「这台机器有账号吗」。
          // probe=true 的意思是"只问不建号"——有就直接登录进主界面，没有才走注册页。
          const r = await api<AuthResult>('/api/auth/device', { deviceId: deviceId(), probe: true });
          setToken(r.token); setMe(r.user);
        }
      } catch { setToken(null); }
      setChecked(true);
    })();
  }, []);

  /* 断线提示别急着弹。
     长连接本来就会被路由器、运营商、系统休眠这类东西随手掐一下，
     绝大多数几百毫秒内就自己接回来了 —— 每掐一次就糊一条"连接断开"，
     看着像天天在掉线，其实牌局一点没受影响。
     现在改成**先默默重连**：连续接不上超过 5 秒才提示，一接上立刻收掉。 */
  const [noisyOffline, setNoisy] = useState(false);
  useEffect(() => {
    if (status === 'authed') { setNoisy(false); return; }
    const t = setTimeout(() => setNoisy(true), 5000);
    return () => clearTimeout(t);
  }, [status]);

  useEffect(() => {
    if (!me) return;
    socket.onStatus = setStatus;
    const off = socket.on(m => {
      if (m.type === 'room.state' || m.type === 'game.events') setRoom(m.room);
      if (m.type === 'room.left') setRoom(null);
      if (m.type === 'room.closed') { /* Table 弹窗处理后回大厅 */ }
      if (m.type === 'auth.fail') { setToken(null); setMe(null); toast(m.reason); }
      if (m.type === 'auth.ok') setMe(u => u ? { ...u, ...m.user } : m.user);
      // 慢半拍点到的动作（别人先抢走了、局面已经往前走了）静静吞掉，不打扰玩家
      if (m.type === 'error' && !QUIET_ERRORS.some(k => m.message.includes(k))) toast(m.message);
    });
    socket.connect();
    return () => { off(); socket.close(); };
  }, [me?.id]);

  /* 扫房间二维码进来的：地址上带着 ?room=123456，连上就直接进那一间。
     只认一次 —— 进去之后把这个参数从地址栏抹掉，不然刷新 / 退出大厅又被拽回去。 */
  const joinedRef = useRef(false);
  useEffect(() => {
    if (!me || status !== 'authed' || joinedRef.current) return;
    const id = new URLSearchParams(location.search).get('room');
    if (!id || !/^\d{4,8}$/.test(id)) return;
    joinedRef.current = true;
    socket.send({ type: 'room.join', roomId: id });
    const u = new URL(location.href); u.searchParams.delete('room');
    history.replaceState(null, '', u.pathname + u.search + u.hash);
  }, [me?.id, status]);

  if (!checked) return <div className="screen center muted">加载中…</div>;
  if (!me) return <Login onDone={r => setMe(r.user)} />;
  return (
    <>
      {noisyOffline && <div className="toast" style={{ animation: 'none' }}>连接断开，重连中…</div>}
      {room && room.status !== 'closed'
        ? <Guard onReset={() => setRoom(null)}>
            {/* 两种玩法两个组件：麻将走 MjRoom，字牌走 Table。
                按 variant 分流而不是塞进一个组件里 —— 规则、摆法、按钮全不一样，
                合在一起改哪边都要担心碰坏另一边。 */}
            {room.spectating
              ? <Spectate room={room} me={me} onLeft={() => setRoom(null)} />
              : room.variant === MJ_VARIANT_ID
                ? <MjRoom room={room} me={me} onLeft={() => setRoom(null)} />
                : <Table room={room} me={me} onLeft={() => setRoom(null)} />}
          </Guard>
        : <Home me={me} canOpenRoom={!!(me.vip || me.canOpenRoom !== false)} onLogout={() => { socket.close(); setMe(null); setRoom(null); }}
            onMe={u => setMe(m => (m ? { ...m, ...u } : m))} />}
    </>
  );
}

/** 出错兜底：界面哪怕渲染炸了，也别整个卡死不动 */
class Guard extends Component<{ children: React.ReactNode; onReset: () => void }, { err: string }> {
  state = { err: '' };
  static getDerivedStateFromError(e: any) { return { err: String(e?.message ?? e) }; }
  componentDidCatch(e: any) { console.error('界面出错', e); }
  render() {
    if (!this.state.err) return this.props.children;
    return <div className="screen center"><div className="panel col" style={{ maxWidth: 320 }}>
      <b>界面出了点问题</b>
      <div className="muted" style={{ fontSize: 12, wordBreak: 'break-all' }}>{this.state.err}</div>
      <button onClick={() => { this.setState({ err: '' }); }}>重试</button>
      <button className="ghost" onClick={() => { this.setState({ err: '' }); this.props.onReset(); }}>回大厅</button>
    </div></div>;
  }
}

/**
 * 按屏幕大小缩放整个牌桌：
 * 竖屏手机上页面本来就要转 90°，这里再按"设计尺寸 852×393"算一个缩放系数 ——
 * 屏幕比设计尺寸小就整体缩小（逻辑画布相应变大，内容不会被裁掉），大屏幕保持 1:1。
 * 同时用 visualViewport 的尺寸，避开 iOS 浏览器上下工具栏盖住页面的问题。
 */
/**
 * 版本同步：页面里带着这次构建号（服务端注入），每分钟跟 /api/version 比一次；
 * 服务端更新过就自己刷新，省得手机上留着旧代码打牌。
 */
// App 壳里：先按竖屏起（登录 / 主页都是竖的），进了牌局 Table 再要求转横屏 —— 否则会先闪一下横屏
try { (window as any).NativeBridge?.setOrientation?.('portrait'); } catch { /* 浏览器里没有壳 */ }

function watchVersion() {
  const mine = (window as any).__BUILD__ as string | undefined;
  if (!mine) return;
  let reloading = false;
  const check = async () => {
    if (reloading || document.hidden) return;
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      const d = await r.json() as { build?: string };
      if (d.build && d.build !== mine) {
        reloading = true;
        toast('有新版本，正在更新…');
        setTimeout(() => location.reload(), 800);
      }
    } catch { /* 网络不好就下次再说 */ }
  };
  setInterval(check, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.addEventListener('focus', check);
}
watchVersion();

/* 设计稿的"屏幕窄边"。这个数越小，同一块屏幕上牌就越大（画布格子少了，每格占的地方就大）。
   调它一个数，整桌跟着一起变 —— 底图是 `slice` 铺的（`.table-art`），画布多大它就铺多大，
   永远不留白边，所以改这个数不会在边上露底。
   `?dh=320` 这种参数可以当场试别的值，试舒服了再定下来。 */
const DESIGN_H = (() => {
  const q = Number(new URLSearchParams(location.search).get('dh'));
  return q >= 200 && q <= 600 ? q : 460;
})();
/* 只在"拿在手里的那类屏幕"上放大，电脑那种大窗口照旧 1:1 ——
   在 27 寸屏上把牌放成两倍大反而怪。

   以前这儿写死了"窄边 520 以内才算手机"。这个数订得太小：
   现在的手机 CSS 视口能到 536（实测 536x952 的机器），比 520 大，
   于是被当成"电脑大窗口"排除在放大之外，k 永远是 1 —— 画布 952x536，
   牌照 330 的设计稿画，摆到 536 的屏上就只占了 330/536，大字版也显小。
   改成看"手指还是鼠标"：触摸屏一律算手里拿的；鼠标的机器留一道 760 的窄边兜底。 */
const TOUCH = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
const HAND_HELD = TOUCH ? 4096 : 760;
/**
 * 把牌桌摆进屏幕。
 *
 * 一条规矩管到底：**屏幕的窄边永远等于设计稿的 393**。
 * 于是牌该多大就多大，长边多出来的那点地方让底图去占 —— 不留白边、也不会被切。
 *
 * 以前这儿卡着 `min(1, …)`：只肯缩小、不肯放大。后果是现在的手机（窄边 430）
 * 拿到的是 430 的设计高度，而牌是照 393 画的 —— 整桌东西只占满 393/430，
 * 看着就是"屏幕变大了、牌反而变小了"，连大字版都显小。
 * 放开之后 430×932 的手机正好落在 852×393 这张设计稿上，一格不多一格不少。
 *
 * 竖屏（手机竖着拿）多一步：整个 #root 转 90°，窄边就是屏幕的宽；
 * 横着看（手机横过来、平板、电脑）不转，窄边是**可视高度** ——
 * 注意是"可视"：浏览器上下那几条工具栏会把它压到三百出头，按它算才不会把最底下那排手牌切掉。
 */
function fitScreen() {
  const root = document.getElementById('root');
  if (!root) return;
  const clear = () => { root.style.width = ''; root.style.height = ''; root.style.transform = ''; };
  if (root.classList.contains('upright')) { clear(); announce(); return; }   // 主页 / 登录那种竖着用的页面
  const vv = window.visualViewport;
  const vw = Math.round(vv?.width ?? window.innerWidth);
  const vh = Math.round(vv?.height ?? window.innerHeight);
  if (!vw || !vh) return;
  const rotate = vh > vw && vw <= 900;        // 竖着拿的手机：转 90° 当横屏用
  const narrow = rotate ? vw : vh;            // 屏幕的窄边
  const k = narrow > DESIGN_H && narrow > HAND_HELD ? 1 : narrow / DESIGN_H;
  if (Math.abs(k - 1) < 0.005 && !rotate) { clear(); announce(); return; }   // 正好 1:1，什么都不用做
  root.style.width = `${(rotate ? vh : vw) / k}px`;
  root.style.height = `${(rotate ? vw : vh) / k}px`;
  root.style.transform = rotate ? `rotate(90deg) translateY(-${vw}px) scale(${k})` : `scale(${k})`;
  root.style.transformOrigin = 'top left';
  announce();
}
/* 画布一改，牌桌里所有"按屏幕坐标算出来的东西"都作废了 —— 最要紧的是出牌线的圆心半径。
   以前只靠 resize / orientationchange 去补量：这两个事件在 iOS 上比布局早，
   量到的是**半路**的尺寸；而真正定下来的那一刻（fitScreen 写完 style）反倒没人通知。
   现在改成 fitScreen 自己广播一声，牌桌听见了重新量一遍，谁都不用猜时机。 */
let lastFit = '';
function announce() {
  const root = document.getElementById('root');
  if (!root) return;
  const sig = `${root.style.width}|${root.style.height}|${root.style.transform}`;
  if (sig === lastFit) return;
  lastFit = sig;
  window.dispatchEvent(new Event('phz-fit'));
}
fitScreen();
initPerf();   // 老机器自动进省电模式（砍掉一直在跑的呼吸光晕，发烫的大头就在那儿）
/* 排版对不上的时候开个小牌子看数：地址后面加 `?diag=1`，右下角会贴一行实时的尺寸。
   （屏幕多大、画布多大、缩放多少、是不是竖屏页面、大厅一行几张）——
   照着这几个数说话，比隔着截图猜快得多。 */
if (new URLSearchParams(location.search).has('diag')) {
  const tag = document.createElement('div');
  /* 左右都钉住 + 自动换行：之前只钉了右边，文字一长左半边就被推出屏幕外，
     偏偏「走哪条路」这个最要紧的字眼就在行首，拍照拍不到。 */
  tag.style.cssText = 'position:fixed;left:4px;right:4px;bottom:4px;z-index:99999;background:rgba(0,0,0,.8);color:#8f8;'
    + 'font:10px/1.3 ui-monospace,Menlo,monospace;padding:4px 6px;border-radius:6px;'
    + 'white-space:pre-wrap;word-break:break-all;pointer-events:none';
  document.body.appendChild(tag);
  setInterval(() => {
    const r = document.getElementById('root');
    const vv = window.visualViewport;
    const grid = document.querySelector('.tables');
    const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
    tag.textContent = `屏 ${window.innerWidth}x${window.innerHeight} 可视 ${Math.round(vv?.width ?? 0)}x${Math.round(vv?.height ?? 0)} dpr${window.devicePixelRatio}\n`
      + `画布 ${r?.style.width || '-'} x ${r?.style.height || '-'}  ${r?.style.transform || '无变换'}\n`
      + `竖屏页 ${r?.classList.contains('upright')}  大厅一行 ${cols} 张  dh=${DESIGN_H}\n`
      + `版本 ${(window as any).__BUILD__ ?? '(旧服务端没给)'}\n`
      + (() => {
          /* 刘海：env() 给的原始值（机身四条边）、转了一圈之后的变量值、牌桌实际让出来多少。
             三者一对，就知道是 iOS 没给数、还是我们的规则没生效。 */
          const probe = (k: string) => {
            const d = document.createElement('div');
            d.style.cssText = `position:fixed;top:0;left:0;height:0;visibility:hidden;width:env(safe-area-inset-${k},0px)`;
            document.body.appendChild(d);
            const w = Math.round(d.getBoundingClientRect().width); d.remove(); return w;
          };
          const cs = r ? getComputedStyle(r) : null;
          const v = (k: string) => (cs?.getPropertyValue(k).trim() || '0');
          const t = document.querySelector('.table') as HTMLElement | null;
          const ts = t ? getComputedStyle(t) : null;
          const tr = t?.getBoundingClientRect();
          return `安全区 机身 上${probe('top')} 右${probe('right')} 下${probe('bottom')} 左${probe('left')}`
            + ` → 变量 ${v('--sat')}/${v('--sar')}/${v('--sab')}/${v('--sal')}\n`
            + `牌桌 left=${ts?.left ?? '-'} right=${ts?.right ?? '-'}`
            + ` 实际 ${tr ? Math.round(tr.left) + ',' + Math.round(tr.top) + ' ' + Math.round(tr.width) + 'x' + Math.round(tr.height) : '-'}`
            + ` 省电${(window as any).__PHZ_LITE__ ? '开' : '关'}`
            + `${(window as any).__PHZ_LITE_WHY__ ? '(' + (window as any).__PHZ_LITE_WHY__ + ')' : ''}`
            + `${(window as any).__PHZ_FPS__ ? ' ' + (window as any).__PHZ_FPS__ + 'fps' : ''}\n`;
        })()
      + (() => {
          /* 最后一次弃牌飞过去的全过程：按哪条路算的、量到的占位方框、
             起飞时定的终点、画到屏幕之前校准后的终点。三组数一对就知道断在哪一步。 */
          const s2 = (window as any).__PHZ_SLOT__, f = (window as any).__PHZ_FLY__;
          const zf = (window as any).__PHZ_ZFIX__;
          if (!s2 && !f) return '';
          const L: string[] = [];
          if (zf) L.push(`zoom账 放大${zf.z} 画布${zf.k} 量到${zf.seen} → ${zf.on ? '补了(Safari那套)' : '不用补'}`);
          if (s2) L.push(`落点 座${s2.st}${s2.mine ? '(我)' : s2.isLeft ? '(上家)' : '(下家)'} 走「${s2.via}」`
            + (s2.ghost ? ` 占位${s2.ghost.join(',')}` : '')
            + (s2.mid !== undefined ? ` 中线${s2.mid} 牌高${s2.cardH} 头像右${s2.anchorR}` : '')
            + (s2.pick ? ` → ${s2.pick.join(',')}` : ''));
          if (f) L.push(`飞 座${f.seat}${f.meld ? '进牌' : '弃牌'} 起飞${(f.a ?? []).join(',')}`
            + ` 定点${(f.slot ?? []).slice(0, 2).join(',')} 换算后${(f.b ?? []).join(',')}`
            + `${f.b2 ? ` 校准${f.b2.join(',')}${f.moved ? '(改过)' : ''}` : ''}`);
          return L.join('\n') + '\n';
        })()
      + (() => {
          const g = (window as any).__PHZ_DRAG__;
          return g ? `拖牌 手指${g.moves}次 重画${g.draws}次 最长一帧${Math.round(g.gap)}ms`
            + `${g.cols ? ` 列${g.cols} 列距${g.pitch} zoom${g.hz}${g.fix ? '(补了)' : ''}` : ''}\n` : '';
        })()
      + (() => {
          const d = (window as any).__PHZ_DIAG__;
          if (!d) return '出牌线 （还没量过）';
          const off = Math.round(d.pv.x - d.cx);
          return `出牌线 圆心${Math.round(d.pv.x)},${Math.round(d.pv.y)} 半径${Math.round(d.pv.r)} 线${d.pv.line == null ? '-' : Math.round(d.pv.line)} zoom量${d.z.toFixed(3)}/算${d.zc.toFixed(2)} ${d.fan ? '扇' : '排'}\n`
            + `手牌 盒中${Math.round(d.cx)} 底${Math.round(d.by)} 框${d.rc.join(',')}\n`
            + `准星 ${d.mark ? d.mark.join(',') : '(没量到)'} 盒中-准星差${d.mark ? Math.round(d.cx - d.mark[0]) : '-'}`;
        })();
  }, 500);
}
window.addEventListener('resize', fitScreen);
window.addEventListener('orientationchange', () => setTimeout(fitScreen, 120));
window.visualViewport?.addEventListener('resize', fitScreen);
// 登录页那种"不转屏"的状态切换时也要重算
new MutationObserver(fitScreen).observe(document.getElementById('root')!, { attributes: true, attributeFilter: ['class'] });

createRoot(document.getElementById('root')!).render(<><App /><ToastHost /></>);
