/** 主页（竖屏）：衡之娱标题 + 玩法入口 + 密码房；点进玩法是固定的桌子列表 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PublicUser, LobbyVariant, HostedRoom } from '../../server/src/protocol.ts';
import type { VariantId } from '../../packages/engine/src/index.ts';
import { HistoryModal } from './Replay.tsx';
import { TileArt } from './TileArt.tsx';
import { RulesModal } from './Rules.tsx';
import { AboutModal } from './About.tsx';
import { MyRoomsPage } from './MyRooms.tsx';
import { qrSvg } from './qr.ts';
import { clampNick } from './nick.ts';
import { badWord, badWordMsg } from '../../server/src/badwords.ts';
import { socket, setToken, api } from './net.ts';
import { Avatar, Modal, toast, ProfileModal, useUpright, SeatStamp } from './ui.tsx';

const VARIANTS: { id: VariantId; name: string; sub: string; desc: string; art: string; cls: string }[] = [
  { id: 'hy_honghei', name: '衡阳红黑', sub: '红与黑', art: '红黑', cls: 'tile-hh', desc: '3 人 · 10 胡起胡按敦计分，大红×5 小红×3 全黑×5 一点红×4，自摸×2' },
  { id: 'ly_tilong', name: '耒阳提龙', sub: '提龙即时分', art: '耒龍', cls: 'tile-tl', desc: '3 人 · 提龙即时算分（大字 2 倍/小字 1 倍），红黑/天地胡息翻倍，10/20 胡卡胡，自摸敦数×2' },
  { id: 'hy_liuhuqiang', name: '衡阳六胡抢', sub: '快打快胡', art: '快', cls: 'tile-lh', desc: '4 人（庄 15 张、闲 14 张）· 衡阳算法，8 红小红 10 红大红' },
];

/** iOS 的「分享」图标：一个开口向上的方框 + 往上冒的箭头 */
function ShareIcon() {
  return (
    <svg className="ico-inline" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-label="分享">
      <path d="M12 15.5V3.2" />
      <path d="M8.3 6.7 12 3l3.7 3.7" />
      <path d="M7.6 9.6H6a2 2 0 0 0-2 2v7.8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V11.6a2 2 0 0 0-2-2h-1.6" />
    </svg>
  );
}
/** 浏览器菜单图标：竖着三个点 */
function MenuIcon() {
  return (
    <svg className="ico-inline" viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-label="菜单">
      <circle cx="12" cy="5.2" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="18.8" r="1.7" />
    </svg>
  );
}
/** iOS 的「添加到主屏幕」图标：圆角方框里一个加号 */
function AddHomeIcon() {
  return (
    <svg className="ico-inline" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-label="添加到主屏幕">
      <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="4.6" />
      <path d="M12 8.2v7.6M8.2 12h7.6" />
    </svg>
  );
}

/**
 * 「装到桌面」按钮。
 * 安卓 / 桌面 Chrome：浏览器会先抛一个 beforeinstallprompt，接住它就能一键安装。
 * iOS Safari：没有这个 API，系统不允许网页自己触发"添加到主屏幕"，只能弹一张步骤说明。
 * 已经是从桌面图标打开的（standalone）：按钮直接不显示。
 */
function InstallButton() {
  const deferred = useRef<any>(null);
  const [canInstall, setCanInstall] = useState(false);
  const [guide, setGuide] = useState(false);
  // 是不是"已经从桌面图标打开的"。只有这一种情况才把按钮收起来 ——
  // 点过一次、看过说明、甚至安装框点了取消，按钮都得一直在（装没装成只有系统知道）
  const isApp = () => {
    try { return matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || (navigator as any).standalone === true; }
    catch { return false; }
  };
  const [standalone, setStandalone] = useState(isApp);
  useEffect(() => {
    const onPrompt = (e: any) => { e.preventDefault(); deferred.current = e; setCanInstall(true); };
    // 浏览器确认真装上了才收按钮（这个事件只有安卓 / 桌面 Chrome 有）
    const onInstalled = () => { deferred.current = null; setCanInstall(false); setStandalone(true); toast('已经装到桌面了'); };
    const recheck = () => setStandalone(isApp());
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    document.addEventListener('visibilitychange', recheck);
    let mq: MediaQueryList | null = null;
    try { mq = matchMedia('(display-mode: standalone)'); mq.addEventListener?.('change', recheck); } catch { /* ignore */ }
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      document.removeEventListener('visibilitychange', recheck);
      try { mq?.removeEventListener?.('change', recheck); } catch { /* ignore */ }
    };
  }, []);
  if (standalone) return null;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1);
  const go = async () => {
    const d = deferred.current;
    if (d) {   // 安卓 / Chrome：一键装
      // 点了"安装"也先别收按钮：真装上了浏览器会抛 appinstalled，那时候再收
      try { d.prompt(); const r = await d.userChoice; if (r?.outcome === 'accepted') deferred.current = null; return; }
      catch { /* 装不了就退回说明 */ }
    }
    setGuide(true);
  };
  return (
    <>
      <button className="ghost hm-install" onClick={go} title="装到桌面">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v11m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
        <span>装到桌面</span>
      </button>
      {guide && (
        <Modal onClose={() => setGuide(false)}>
          <div className="col install-guide">
            <b style={{ fontSize: 16 }}>装到桌面，像 App 一样打开</b>
            {ios ? (
              <>
                <div className="muted">iOS 不让网页自己添加，照下面三步点一下就好（要用 Safari 打开这个网址）：</div>
                <ol>
                  <li>点屏幕底部中间的这个图标 <ShareIcon /> <b>「分享」</b></li>
                  <li>往下翻，找到 <AddHomeIcon /> <b>「添加到主屏幕」</b></li>
                  <li>打开方式选 <b>「作为网页 App 打开」</b>，再点右上角<b>「添加」</b></li>
                </ol>
                <div className="muted">装好之后从桌面图标进来就没有地址栏了。iOS 不认网页的横屏设置：如果开了<b>屏幕方向锁定</b>，进来还是竖屏（顶上那条时间信号会盖着牌桌左边）—— 把方向锁关掉，手机横过来就跟 App 一个样。</div>
              </>
            ) : (
              <>
                <div className="muted">在浏览器菜单里找这一项（不同浏览器叫法不一样）：</div>
                <ol>
                  <li>点右上角 / 右下角的 <MenuIcon /> <b>菜单</b></li>
                  <li>选 <AddHomeIcon /> <b>「安装应用」</b>或<b>「添加到主屏幕」</b></li>
                </ol>
                <div className="muted">用 Chrome 的「安装应用」装出来的才会自动横屏；有些浏览器的「发送到桌面」只是个书签，打开还是带地址栏。</div>
              </>
            )}
            <button onClick={() => setGuide(false)}>知道了</button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** 主页上的数据统计：去掉了"提 / 跑"（看不出什么名堂） */
function MyStats({ me }: { me: PublicUser }) {
  const [p, setP] = useState<any>(null);
  useEffect(() => {
    let got = false;
    const off = socket.on(m => {
      if (m.type === 'profile' && m.profile.user.id === me.id) { got = true; setP(m.profile); }
      if (m.type === 'auth.ok') socket.send({ type: 'profile.get', userId: me.id });   // 刚连上就再要一次
    });
    socket.send({ type: 'profile.get', userId: me.id });
    // 进主页那一下连接可能还没认证完，过一会儿没收到就再要一次
    const t = setInterval(() => { if (!got) socket.send({ type: 'profile.get', userId: me.id }); }, 1200);
    return () => { off(); clearInterval(t); };
  }, [me.id]);
  const [open, setOpen] = useState(false);
  const box = (label: string, v: string | number) => (
    <div key={label} className="hm-stat"><b>{v}</b><span>{label}</span></div>
  );
  if (!open) return (
    <button className="ghost hm-more" onClick={() => setOpen(true)}>
      数据统计 <span className="muted">对局 {p?.games ?? '—'} · 胜率 {p ? `${p.winRate}%` : '—'}</span> ▾
    </button>
  );
  return (
    <>
    <button className="ghost hm-more" onClick={() => setOpen(false)}>数据统计 ▴</button>
    <div className="hm-stats">
      {box('对局', p?.games ?? '—')}
      {box('胜率', p ? `${p.winRate}%` : '—')}
      {box('胡牌', p?.hu ?? '—')}
      {box('自摸', p?.zimo ?? '—')}
      {box('点炮', p?.dianpao ?? '—')}
      {box('大胡', p?.bigHu ?? '—')}
      {box('最高息', p?.maxXi ?? '—')}
      {box('最高倍', p?.maxMul ? `×${p.maxMul}` : '—')}
    </div>
    </>
  );
}



/** 扫码进房的地址：把房号挂在当前页面的地址后面（main.tsx 里认 ?room=） */
export function roomUrl(roomId: string) {
  const u = new URL(location.href);
  u.search = ''; u.hash = '';
  u.searchParams.set('room', roomId);
  return u.toString();
}
/** 房间二维码：自己算的点阵（web/src/qr.ts），不依赖任何外部库 / 联网 */
export function RoomQr({ roomId, size = 168 }: { roomId: string; size?: number }) {
  const url = roomUrl(roomId);
  const svg = useMemo(() => {
    try { return qrSvg(url, { size, ec: 'M' }); } catch { return ''; }
  }, [url, size]);
  if (!svg) return null;
  return (
    <div className="room-qr">
      <div className="qr-box" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>{url}</div>
      <button className="ghost" onClick={async () => {
        try { await navigator.clipboard.writeText(url); toast('进房链接已复制'); }
        catch { toast('复制不了，长按上面那行地址自己拷'); }
      }}>复制链接</button>
    </div>
  );
}

export function Home({ me, canOpenRoom, onLogout, onMe }: { me: PublicUser; canOpenRoom: boolean; onLogout: () => void; onMe?: (u: Partial<PublicUser>) => void }) {
  const [vs, setVs] = useState<LobbyVariant[]>([]);
  const [pickVariant, setPickVariant] = useState<VariantId | null>(null);   // 打开了哪种玩法的桌子列表
  const [create, setCreate] = useState(false);
  const [join, setJoin] = useState(false);
  const [profile, setProfile] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [showCode, setShowCode] = useState(false);          // 账号 ID 是不是已经点开了
  const [rules, setRules] = useState<string | null>(null);     // 正开着哪一份玩法说明
  const [about, setAbout] = useState(false);                   // 「关于本游戏」
  const [myRooms, setMyRooms] = useState(false);               // 「我的房间」：VIP自己管房
  const [made, setMade] = useState<{ roomId: string; name: string } | null>(null);   // 刚开好的那一间
  const [bindReq, setBindReq] = useState<{ deviceId: string; at: number } | null>(null);
  const [nick, setNick] = useState('');
  const [history, setHistory] = useState(false);
  const [variant, setVariant] = useState<VariantId>('hy_honghei');
  const [base, setBase] = useState(1);
  const [turnSec, setTurnSec] = useState(30);
  const [roomId, setRoomId] = useState('');
  const [resume, setResume] = useState<string | null>(null);
  const [resumeName, setResumeName] = useState<string | null>(null);   // 那一桌叫什么（私人房报房号）
  const [hosted, setHosted] = useState<HostedRoom[]>([]);
  const [autoNext, setAutoNext] = useState(5);   // 私人房默认 5 秒接着下一局：真人房都在等，别干坐着
  const [capX, setCapX] = useState(100);   // 封顶 = 底分 × 倍数（0 = 不限）
  const [pauseEvery, setPauseEvery] = useState(0);   // 几局一歇（0 = 一直打下去）
  /* 玩法开关：只有开房才能挑，大厅一律全开 + 新牌轮流发。
     默认跟大厅一样全开，房主想关哪条关哪条。 */
  const [noXiHu, setNoXiHu] = useState(true);       // 耒阳：能不能无息胡
  const [raiseHand, setRaiseHand] = useState(true); // 耒阳：举手胡翻倍
  const [redBlack, setRedBlack] = useState(true);   // 衡阳：算红黑
  const [huCardDun, setHuCardDun] = useState(true); // 衡阳：胡的那个字有几张加几敦
  const [dealMode, setDealMode] = useState<'fresh' | 'big'>('fresh');
  useUpright(true);   // 主页 / 桌子列表一律竖屏，进了牌局才转横屏

  useEffect(() => {
    const off = socket.on(m => {
      if (m.type === 'lobby.tables') { setVs(m.variants); setResume(m.resume ?? null); setResumeName((m as any).resumeName ?? null); setHosted(m.hosted ?? []); }
      if (m.type === 'auth.ok') socket.send({ type: 'lobby.tables' });   // 刚连上就要一次，别等轮询
      /* 点「进去看」时那间房刚好散了：列表是 4 秒一轮的，手上这份已经过期 ——
         马上再要一份，把那条已经没了的房间抹掉，别让人对着一个点不动的按钮猜。 */
      if (m.type === 'error' && /房间不存在|房间已解散/.test(m.message ?? '')) socket.send({ type: 'lobby.tables' });
      /* 房开好了：人不进去，先问一句下一步 —— 接着开下一间，还是去「我的房间」看一眼 */
      if (m.type === 'room.created') { setMade({ roomId: m.roomId, name: m.name }); socket.send({ type: 'lobby.tables' }); }
    });
    socket.send({ type: 'lobby.tables' });
    const t = setInterval(() => socket.send({ type: 'lobby.tables' }), 4000);
    return () => { off(); clearInterval(t); };
  }, []);

  // 点开"加入房间"时，剪贴板里要是刚好有 6 位数字（牌友发过来的房号），就先填上
  const pasteRoomId = async () => {
    try {
      const t = await navigator.clipboard?.readText?.();
      const m = t && t.match(/\d{6}/);
      if (m) setRoomId(m[0]);
    } catch { /* 没授权就算了，手输 */ }
  };

  /* 账号 ID 亮出来之后**自己会盖回去**（10 秒），复制完也立刻盖上 ——
     不然点过一次就一直明着摆在那儿，旁边坐个人就看了去。 */
  const codeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideCode = () => { if (codeTimer.current) clearTimeout(codeTimer.current); codeTimer.current = null; setShowCode(false); };
  const revealCode = () => {
    setShowCode(true);
    if (codeTimer.current) clearTimeout(codeTimer.current);
    codeTimer.current = setTimeout(() => { codeTimer.current = null; setShowCode(false); }, 10000);
  };
  useEffect(() => () => { if (codeTimer.current) clearTimeout(codeTimer.current); }, []);

  /* 别的设备想用我的账号登录：这边弹一张确认，点了「解除绑定」那台才进得去。
     隔 15 秒问一次就够了（换设备不是急事） */
  useEffect(() => {
    let live = true;
    const ask = () => api<any>('/api/me', undefined, 'GET')
      .then(r => { if (live) setBindReq(r.bindReq ?? null); })
      .catch(() => { /* 网络不好下次再说 */ });
    ask();
    const t = setInterval(ask, 15000);
    return () => { live = false; clearInterval(t); };
  }, []);

  // 笔按钮就地改昵称，不用再进详情页
  const saveNick = async () => {
    const n = nick.trim();
    if (!n) return toast('昵称不能为空');
    // 脏字当场就拦（服务端也拦一道，这里只是别让人白等一个来回）
    const bad = badWord(n); if (bad) return toast(badWordMsg(bad));
    if (n === me.nickname) return setRenaming(false);
    try {
      const r = await api<{ nickLeft?: number }>('/api/auth/nickname', { nickname: n });
      onMe?.({ nickname: n, ...(r.nickLeft !== undefined ? { nickLeft: r.nickLeft } : {}) });
      setRenaming(false);
      toast(r.nickLeft !== undefined ? `昵称已改，还能改 ${r.nickLeft} 次` : '昵称已改');
    } catch (e: any) { toast(e?.message ?? '改不了'); }
  };

  const cur = vs.find(v => v.variant === pickVariant);

  /* 「我的房间」单独一页 —— 桌子卡片摆开看得清楚，不再挤在主页上当一小条列表 */
  if (myRooms) return (
    <MyRoomsPage
      onBack={() => setMyRooms(false)}
      onEnter={id => { setMyRooms(false); socket.send({ type: 'room.join', roomId: id }); }}
      onCreate={() => { setMyRooms(false); setCreate(true); }} />
  );

  return (
    <div className="screen col home">
      {/* 顶栏：左边退出 / 返回，中间标题，右边战绩 */}
      <div className="home-top">
        <button className="ghost hm-btn" title={cur ? '返回' : '退出'}
          onClick={() => { if (cur) setPickVariant(null); else { setToken(null); onLogout(); } }}>‹‹</button>
        <div className="hm-title">
          {cur ? <>{cur.name}<span className="tile-help inline" title="玩法说明" onClick={() => setRules(cur.variant)}>?</span></>
               : <><img className="hm-logo" src="icon-192.png" alt="" draggable={false} />衡之娱</>}
        </div>
        <span className="hm-right">
          {/* 关于本游戏：说说这个 app 是做什么的 */}
          <button className="ghost hm-btn hm-about" title="关于本游戏" onClick={() => setAbout(true)}>i</button>
          <button className="ghost hm-btn" title="战绩" onClick={() => setHistory(true)}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 20V12M10 20V5M16 20v-6M22 20H2" />
            </svg>
          </button>
        </span>
      </div>

      {!cur ? (
        <>
          {/* 我的名片：头像 + 昵称（旁边一支笔可以改）+ 数据统计 */}
          <div className="home-card">
            <div className="row" style={{ gap: 10 }}>
              <Avatar user={me} size={54} onClick={() => setProfile(me.id)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="hm-nick">
                  {renaming ? (
                    <>
                      <input className="hm-nick-in" value={nick} maxLength={8} autoFocus
                        onChange={e => setNick(clampNick(e.target.value, 4))}
                        onKeyDown={e => { if (e.key === 'Enter') saveNick(); if (e.key === 'Escape') setRenaming(false); }} />
                      <button className="hm-ok" onClick={saveNick}>存</button>
                      <button className="ghost hm-ok" onClick={() => setRenaming(false)}>取消</button>
                    </>
                  ) : (
                    <>
                      <b>{me.nickname}{me.vip ? ' 👑' : ''}</b>
                      <button className="ghost hm-pen" title={me.nickLeft !== undefined ? `改昵称（还能改 ${me.nickLeft} 次）` : '改昵称'}
                        onClick={() => {
                          if (me.nickLeft === 0) return toast('昵称改的次数用完了，要再改请找管理员');
                          setNick(me.nickname); setRenaming(true);
                        }}>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z" /></svg>
                      </button>
                    </>
                  )}
                </div>
                {/* 账号 ID 默认打码：它是换设备时的钥匙，别让人一眼看了去。点一下才显示，再点一下复制 */}
                <div className="muted" title={showCode ? '再点一下复制' : '点一下显示账号 ID'}
                  onClick={() => {
                    const c = me.code ?? String(me.id);
                    if (!showCode) { revealCode(); return; }
                    navigator.clipboard?.writeText?.(c).then(() => toast('账号 ID 已复制：' + c), () => toast('账号 ID：' + c)) ?? toast('账号 ID：' + c);
                    hideCode();                       // 复制完就盖回去
                  }}>
                  账号 {showCode ? (me.code ?? me.id) : '••••••'} · 积分 {me.points}
                </div>
              </div>
              <InstallButton />
            </div>
            <MyStats me={me} />
          </div>

          {resume && (
            <button className="resume-bar" onClick={() => socket.send({ type: 'room.join', roomId: resume })}>
              {resumeName ?? '你还有一桌'}还在打（机器人托管中）· 点这儿返回牌局
            </button>
          )}


          <div className="tiles">
            {VARIANTS.map(v => {
              const info = vs.find(x => x.variant === v.id);
              const open = info?.open ?? false;
              const online = (info?.tables ?? []).reduce((a, t) => a + t.humans, 0);
              return (
                <button key={v.id} className={`tile ${v.cls} ${open ? '' : 'tile-off'}`} disabled={!open}
                  onClick={() => setPickVariant(v.id)}>
                  <TileArt kind={v.cls.replace('tile-', '') as any} />
                  {/* 玩法说明：卡片右上角一个「?」，点它不进玩法 */}
                  <span className="tile-help" title="玩法说明"
                    onClick={e => { e.stopPropagation(); setRules(v.id); }}>?</span>
                  {/* 红黑 / 提龙 有正经的画了，不再叠那个大字，免得糊成一团 */}
                  {v.cls === 'tile-lh' && <span className="tile-art">{v.art}</span>}
                  <span className="tile-name">{v.name}</span>
                  <span className="tile-sub">{open ? `${v.sub} · 在线 ${online}` : '暂不开放'}</span>
                </button>
              );
            })}
            {canOpenRoom && (
              <button className="tile tile-my" onClick={() => setMyRooms(true)}>
                <span className="tile-art">管</span>
                <span className="tile-name">我的房间</span>
                <span className="tile-sub">{hosted.length ? `开着 ${hosted.length} 个 · 读秒 / 数据 / 暂停` : '开好的房间在这儿管'}</span>
              </button>
            )}
            <button className="tile tile-pw" onClick={() => { setJoin(true); pasteRoomId(); }}>
              <TileArt kind="pw" />
              <span className="tile-art">房</span>
              <span className="tile-name">密码房</span>
              <span className="tile-sub">{canOpenRoom ? '输房号加入 / 开房' : '输房号加入'}</span>
            </button>
          </div>

        </>
      ) : (
        <>
          {/* 按底分分栏：一档一栏，栏头写清楚底分和这一档有几桌 */}
          {[...new Set(cur.tables.map(t => t.baseScore))].sort((a, b) => a - b).map(bs => (
            <div key={bs} className="tier-sec">
              <div className="tier-head"><b>底分 {bs}</b>
                <span className="muted">{cur.tables.filter(t => t.baseScore === bs).length} 桌 · 在线 {cur.tables.filter(t => t.baseScore === bs).reduce((a, t) => a + t.humans, 0)} 人</span></div>
              <div className="tables">
                {cur.tables.filter(t => t.baseScore === bs).map(t => (
              <button key={t.id} className={`tile table-card ${VARIANTS.find(v => v.id === cur.variant)?.cls ?? ''} ${t.humans + t.bots >= t.seats ? 'full' : 'open'} ${t.mine ? 'mine' : ''}`}
                disabled={!t.mine && t.humans + t.bots >= t.seats}
                onClick={() => socket.send({ type: 'room.join', roomId: t.id })}>
                {/* 那幅画只在右上角露一个小角（四分之一圆），当个缩略图 ——
                    整张铺满的话，一屏十几张桌子看着又乱又挤；放左边又跟桌名撞 */}
                <span className="tc-art">
                  <TileArt kind={(VARIANTS.find(v => v.id === cur.variant)?.cls ?? 'tile-hh').replace('tile-', '') as any} />
                </span>
                {/* 读秒是挑桌子时最要紧的一项，直接跟在桌名后面：「红黑 01 · 30s」 */}
                <span className="table-name"><b className="tc-name">{t.name}</b><i className="tc-sec">· {t.turnSec ?? 20}s</i></span>
                {/* 中间盖一个"戳"：满员＝金色的「满」，空桌＝绿色的「空」，
                    其余是个表盘 —— 一圈按座位分段（真人绿、机器人灰、空位淡），中间写真人数 */}
                <SeatStamp humans={t.humans} bots={t.bots} seats={t.seats} />
                <span className={`table-state ${t.mine ? 'mine' : t.status}`}>{t.mine ? '回到这桌' : t.humans + t.bots >= t.seats ? '满' : t.status === 'playing' ? '牌局中' : '可进'}</span>
              </button>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {history && <HistoryModal onClose={() => setHistory(false)} />}

      {/* 刚开好一间房：房号给他看清楚，下一步自己挑 */}
      {made && (
        <Modal onClose={() => setMade(null)}>
          <div className="col" style={{ gap: 10, minWidth: 280 }}>
            <b>房间开好了</b>
            <div className="mr-made">{made.name}<span>房号 {made.roomId}</span></div>
            <div className="muted">把房号、或者下面这张码发给牌友，扫一扫直接进这一间。你自己要打的话，在「我的房间」里点「进去打」。</div>
            <RoomQr roomId={made.roomId} />
            {/* 「进去打」「我的房间」一左一右各占三分之一、中间空着；
                开房才是这一页的正事 —— 「再开一间」在底下占满整行，实心主按钮。 */}
            <div className="made-ops">
              <button className="ghost" onClick={() => { const id = made.roomId; setMade(null); socket.send({ type: 'room.join', roomId: id }); }}>进去打</button>
              <button className="ghost" onClick={() => { setMade(null); setMyRooms(true); }}>我的房间</button>
            </div>
            <button onClick={() => { setMade(null); setCreate(true); }}>再开一间</button>
          </div>
        </Modal>
      )}



      {create && (
        <Modal onClose={() => setCreate(false)}>
          <div className="col create-room">
            <b>创建密码房</b>
            <div className="row variant-pick">
              {VARIANTS.filter(v => v.id !== 'hy_liuhuqiang').map(v => (
                <button key={v.id} className={`vbtn ${variant === v.id ? '' : 'ghost'}`} onClick={() => setVariant(v.id)}>{v.name}</button>
              ))}
            </div>
            <div className="form2">
              <label>底分
                <select value={base} onChange={e => setBase(Number(e.target.value))}>
                  {[1, 2, 5, 10, 20, 50, 100, 200, 500].map(v => <option key={v} value={v}>{v} 分</option>)}
                </select>
              </label>
              <label>读秒时间
                <select value={turnSec} onChange={e => setTurnSec(Number(e.target.value))}>
                  {[10, 15, 20, 30, 45, 60].map(v => <option key={v} value={v}>{v} 秒</option>)}
                </select>
              </label>
              <label>自动开局
                <select value={autoNext} onChange={e => setAutoNext(Number(e.target.value))}>
                  {[5, 10, 15, 20, 30, 60].map(v => <option key={v} value={v}>{v} 秒</option>)}
                </select>
              </label>
              <label>封顶
                <select value={capX} onChange={e => setCapX(Number(e.target.value))}>
                  {[100, 200, 500, 1000, 2000, 5000].map(v => <option key={v} value={v}>{v} 倍（{base * v} 分）</option>)}
                  <option value={0}>不限</option>
                </select>
              </label>
              {/* 几局一歇：打满这么多局就停一停，看看账、歇口气，由房主或桌上第一位玩家点「继续」 */}
              <label>几局一歇
                <select value={pauseEvery} onChange={e => setPauseEvery(Number(e.target.value))}>
                  <option value={0}>不暂停</option>
                  {[8, 16, 24, 32].map(v => <option key={v} value={v}>{v} 局</option>)}
                </select>
              </label>
            </div>
            {/* 玩法开关：耒阳、衡阳各管各的，只列跟当前玩法有关的那几条 */}
            <div className="form2">
              <label>发牌
                <select value={dealMode} onChange={e => setDealMode(e.target.value as 'fresh' | 'big')}>
                  <option value="fresh">新牌 · 轮流派牌</option>
                  <option value="big">上局的牌 · 切牌（大牌玩法）</option>
                </select>
              </label>
              {variant === 'ly_tilong' ? <>
                <label>无息胡
                  <select value={noXiHu ? 1 : 0} onChange={e => setNoXiHu(!!Number(e.target.value))}>
                    <option value={1}>可以（按 21 胡算）</option><option value={0}>不许</option>
                  </select>
                </label>
                <label>举手胡
                  <select value={raiseHand ? 1 : 0} onChange={e => setRaiseHand(!!Number(e.target.value))}>
                    <option value={1}>算（翻倍）</option><option value={0}>不算</option>
                  </select>
                </label>
              </> : <>
                <label>红黑
                  <select value={redBlack ? 1 : 0} onChange={e => setRedBlack(!!Number(e.target.value))}>
                    <option value={1}>算</option><option value={0}>不算</option>
                  </select>
                </label>
                <label>胡牌加敦
                  <select value={huCardDun ? 1 : 0} onChange={e => setHuCardDun(!!Number(e.target.value))}>
                    <option value={1}>算（几张加几敦）</option><option value={0}>不算</option>
                  </select>
                </label>
              </>}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {dealMode === 'big'
                ? '大牌玩法：上一局打完的牌收拢、搓几把就发，一人切一整段 —— 坎和句子成片地留下来，牌大、打着过瘾。'
                : '每局一副全新的牌、洗匀，再轮流一人几张转着圈发（大厅就是这一路）。'}
            </div>
            <div className="muted">开好之后房间就在那儿等着，房主想打自己点「进去打」（跟别人一样入座）；人满锁房；房间总输赢到封顶自动暂停。
              {pauseEvery ? `每打满 ${pauseEvery} 局歇一次，房主或桌上第一位玩家点「继续」接着打。` : ''}</div>
            <button onClick={() => { socket.send({ type: 'room.create', variant, baseScore: base, turnMs: turnSec * 1000, autoNextSec: autoNext, swingCap: capX ? base * capX : 0, pauseEvery,
                play: { deal: dealMode, noXiHu, raiseHand, redBlack, huCardDun } }); setCreate(false); }}>创建</button>
            <button className="ghost" onClick={() => { setCreate(false); setJoin(true); pasteRoomId(); }}>我有房号，直接加入</button>
          </div>
        </Modal>
      )}
      {join && (
        <Modal onClose={() => setJoin(false)}>
          <div className="col" style={{ minWidth: 280 }}>
            <b>加入房间</b>
            <input inputMode="numeric" placeholder="房号（6 位）" value={roomId} autoFocus
              onChange={e => setRoomId(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            <div className="muted">房号是唯一的，输房号就能进（房主会把房号发给你）。</div>
            <button onClick={() => { if (!/^\d{6}$/.test(roomId)) return toast('请输入 6 位房号'); socket.send({ type: 'room.join', roomId }); setJoin(false); }}>加入</button>
            {canOpenRoom && <button className="ghost" onClick={() => { setJoin(false); setCreate(true); }}>我要开房</button>}
          </div>
        </Modal>
      )}
      {/* 有别的设备要用我的账号登录：解不解绑由这台（原设备）说了算 */}
      {bindReq && (
        <Modal onClose={() => setBindReq(null)}>
          <div className="col" style={{ minWidth: 280, gap: 8 }}>
            <b>有一台新设备要登录你的账号</b>
            <div className="muted" style={{ fontSize: 13 }}>
              时间：{new Date(bindReq.at).toLocaleString('zh-CN', { hour12: false })}<br />
              是你自己在新手机上登录，就点「解除绑定」，那边再登一次就进去了 ——
              <b>解除之后这台会退出登录</b>。不是你本人操作的话，点「不是我」，那边就进不来。
            </div>
            <button onClick={async () => {
              try {
                await api('/api/auth/unbind', {});
                setBindReq(null);
                toast('已解除绑定：去新设备上再登录一次');
              } catch (e: any) { toast(e?.message ?? '解不了'); }
            }}>解除绑定</button>
            <button className="ghost" onClick={async () => {
              try { await api('/api/auth/unbind', { deny: true }); setBindReq(null); toast('已拒绝，那台设备进不来'); }
              catch (e: any) { toast(e?.message ?? '操作失败'); }
            }}>不是我，拒绝</button>
          </div>
        </Modal>
      )}
      {rules && <RulesModal variant={rules} onClose={() => setRules(null)} />}
      {about && <AboutModal onClose={() => setAbout(false)} />}
      {profile !== null && <ProfileModal userId={profile} me={me.id} onClose={() => setProfile(null)}
        onRenamed={n => onMe?.({ nickname: n })} />}
    </div>
  );
}
