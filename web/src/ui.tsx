import { Fragment, useRef, useEffect, useState } from 'react';
import type { PublicUser, ProfileView, LedgerEntry, LedgerBatch } from '../../server/src/protocol.ts';
import { socket, api } from './net.ts';
import { chars, isEmoji, avatarText } from './nick.ts';
export { chars, avatarText } from './nick.ts';

const COLORS = ['#e74c3c', '#8e44ad', '#2980b9', '#16a085', '#d35400', '#27ae60', '#c0392b', '#7f8c8d', '#f39c12', '#2c3e50', '#1abc9c', '#9b59b6'];

/** wide：头像框加宽 50%，昵称直接写在框里（最多四个字），外面就不用再挂一行昵称了 */
export function Avatar({ user, size = 40, onClick, onHold, square, wide }: { user: PublicUser | null; size?: number; onClick?: () => void; onHold?: () => void; square?: boolean; wide?: boolean }) {
  // 加宽的框：宽度按"四个字 + 一点点边"来，别留一圈空白
  const w = wide ? Math.round(size * 1.86) : size;
  // 写几个字就按几个字缩字号：四个字也塞得下，表情就放大一点
  const txt = user ? avatarText(user.nickname, wide ? 4 : 2) : '';
  const n = chars(txt).length;
  const oneEmoji = n === 1 && isEmoji(txt);
  const fs = oneEmoji ? size * 0.56 : size * (wide ? (n >= 4 ? 0.40 : n === 3 ? 0.46 : 0.52) : (n >= 2 ? 0.34 : 0.42));
  const style = { width: w, height: size, fontSize: Math.round(fs) } as React.CSSProperties;
  const cls = `avatar ${square ? 'avatar-sq' : ''} ${wide ? 'avatar-wide' : ''}`;
  /* onHold：长按 0.6 秒才触发（请走机器人这种"一点就作数"的操作，不能让人误触） */
  const hold = useRef<{ t: ReturnType<typeof setTimeout> | null; fired: boolean }>({ t: null, fired: false });
  const h = onHold ? {
    onPointerDown: () => { hold.current.fired = false; hold.current.t = setTimeout(() => { hold.current.fired = true; onHold(); }, 600); },
    onPointerUp: () => { if (hold.current.t) clearTimeout(hold.current.t); hold.current.t = null; },
    onPointerLeave: () => { if (hold.current.t) clearTimeout(hold.current.t); hold.current.t = null; },
    onPointerCancel: () => { if (hold.current.t) clearTimeout(hold.current.t); hold.current.t = null; },
    onClick: () => { if (!hold.current.fired) onClick?.(); },
  } : { onClick };
  if (!user) return <div className={cls} style={{ ...style, background: '#333', borderStyle: 'dashed' }}>空</div>;
  if (user.avatar.startsWith('http')) return <div className={cls} style={style} {...h}><img src={user.avatar} alt="" /></div>;
  const idx = Number(user.avatar.split(':')[1] ?? 0) % COLORS.length;
  const bg = user.kind === 'bot' ? '#556' : COLORS[idx];
  return <div className={cls} style={{ ...style, background: bg }} {...h}>{txt}</div>;
}

/**
 * 弹窗。点背景关掉 —— 但**必须是"按下"也在背景上**才算。
 *
 * 为什么要这么讲究：行动按钮是 onPointerDown 就响应的（为了跟手）。
 * 手指按在「吃」上 → 弹窗当场出来、盖在手指底下 → 手指一抬，
 * 这一下的 click 落在了**刚冒出来的背景**上 → 立刻又把弹窗关了。
 * 表现就是"吃牌选择框一闪而过，必须一直按住吃按钮才看得见" —— 按住不放就没有抬手、
 * 没有 click，所以它才留得住。
 *
 * 记一下"按下"落在哪儿就解决了：开弹窗那一下的 pointerdown 在按钮上、不在背景上，
 * 随后那个 click 自然就不算数。顺带还治好了另一个毛病 ——
 * 从弹窗里往外拖再松手，以前也会误关。
 */
export function Modal({ children, onClose, top, className }: { children: React.ReactNode; onClose?: () => void; top?: boolean; className?: string }) {
  const downOnBg = useRef(false);
  return <div className={`modal-bg ${top ? 'at-top' : ''} ${className ?? ''}`}
    onPointerDown={e => { downOnBg.current = e.target === e.currentTarget; }}
    onClick={e => {
      const ok = downOnBg.current && e.target === e.currentTarget;
      downOnBg.current = false;
      if (ok) onClose?.();
    }}>
    <div className="modal" onClick={e => e.stopPropagation()}>{children}</div>
  </div>;
}

let toastFn: ((s: string) => void) | null = null;
/** 需要打字的页面：临时取消"强制横屏"的旋转，免得输入法跟页面反着来 */
/** 想要的屏幕方向：主页 / 登录竖屏，牌桌横屏。
 *  攒一下再通知壳：竖屏页之间来回切（主页 → 登录）时不会中间插一次横屏，看着就不闪了。 */
let wantOrient: 'portrait' | 'landscape' = 'portrait';
let orientTimer: ReturnType<typeof setTimeout> | null = null;
let orientSent: string | null = null;
/**
 * 网页里尽量锁真横屏（安卓 Chrome / 装成 PWA 的都支持 screen.orientation.lock）。
 * 有的浏览器要求"先全屏才让锁方向"，所以锁失败时借下一次点击（必须在用户手势里）再试一次。
 * iOS Safari 不支持这套 API —— 那边只能靠 App 壳，网页就继续用 CSS 转 90° 的老办法顶着。
 */
let lockHooked = false;
function lockOrientation(o: 'portrait' | 'landscape') {
  const so: any = (screen as any).orientation;
  if (!so?.lock) return;
  if (o === 'portrait') { try { so.unlock?.(); } catch { /* 不支持就算了 */ } return; }
  const go = () => so.lock('landscape');
  try {
    go().catch(() => {
      if (lockHooked) return;
      lockHooked = true;
      const once = async () => {
        document.removeEventListener('pointerdown', once);
        try { await (document.documentElement as any).requestFullscreen?.(); await go(); } catch { /* 锁不了就维持现状 */ }
      };
      document.addEventListener('pointerdown', once, { once: true });
    });
  } catch { /* 老浏览器没有这个 API */ }
}

export function requestOrientation(o: 'portrait' | 'landscape') {
  wantOrient = o;
  if (orientTimer) clearTimeout(orientTimer);
  orientTimer = setTimeout(() => {
    orientTimer = null;
    if (orientSent === wantOrient) return;
    orientSent = wantOrient;
    try { (window as any).NativeBridge?.setOrientation?.(wantOrient); } catch { /* 浏览器里没有壳 */ }
    lockOrientation(wantOrient);
  }, 60);
}

/** 竖屏页面（主页 / 登录 / 要打字的地方）：网页里加 upright 类不转屏，App 壳里让原生也转竖屏 */
export function useUpright(active = true) {
  useEffect(() => {
    const r = document.getElementById('root');
    if (active) r?.classList.add('upright');
    requestOrientation(active ? 'portrait' : 'landscape');
    /* 顺手催一次重排：竖屏页面不缩放、牌桌要缩放，两者切换时 #root 上那几个内联尺寸
       必须当场清干净 / 重算。光靠 class 变化的监听有时慢半拍，
       慢的那一下页面就按上一个页面的尺寸排了（大厅卡片一行挤三张就是这么来的）。 */
    window.dispatchEvent(new Event('resize'));
    return () => { if (active) { r?.classList.remove('upright'); window.dispatchEvent(new Event('resize')); } };
  }, [active]);
}

export function toast(s: string) { toastFn?.(s); }
export function ToastHost() {
  const [msgs, setMsgs] = useState<{ id: number; s: string }[]>([]);
  useEffect(() => { toastFn = s => { const id = Date.now() + Math.random(); setMsgs(m => [...m.slice(-2), { id, s }]); setTimeout(() => setMsgs(m => m.filter(x => x.id !== id)), 2500); }; return () => { toastFn = null; }; }, []);
  return <>{msgs.map((m, i) => <div key={m.id} className="toast" style={{ marginTop: i * 44 }}>{m.s}</div>)}</>;
}

/** 玩家资料弹窗：基本信息、胜率、牌品 */
export function ProfileModal({ userId, onClose, me, onRenamed }: { userId: number; onClose: () => void; me?: number; onRenamed?: (nick: string) => void }) {
  const [p, setP] = useState<ProfileView | null>(null);
  const [editing, setEditing] = useState(false);
  const [nick, setNick] = useState('');
  useEffect(() => {
    const off = socket.on(m => { if (m.type === 'profile' && m.profile.user.id === userId) setP(m.profile); });
    socket.send({ type: 'profile.get', userId });
    return off;
  }, [userId]);
  return (
    <Modal onClose={onClose}>
      {!p ? <div>加载中…</div> : (
        <div className="col">
          <div className="row"><Avatar user={p.user} size={56} />
            <div style={{ flex: 1 }}>
              {editing ? (
                <div className="row" style={{ gap: 6 }}>
                  <input value={nick} maxLength={12} onChange={e => setNick(e.target.value)} placeholder="新昵称" />
                  <button onClick={async () => {
                    const n = nick.trim();
                    if (!n) return toast('昵称不能为空');
                    try {
                      await api('/api/auth/nickname', { nickname: n });
                      setP(v => (v ? { ...v, user: { ...v.user, nickname: n } } : v));
                      onRenamed?.(n); setEditing(false); toast('昵称已改');
                    } catch (e: any) { toast(e?.message ?? '改不了'); }
                  }}>保存</button>
                </div>
              ) : (
                <div style={{ fontSize: 18, fontWeight: 700 }}>{p.user.nickname}{p.user.vip ? ' 👑' : ''}
                  {me === p.user.id && <button className="ghost" style={{ marginLeft: 8, padding: '2px 8px', fontSize: 12 }}
                    onClick={() => { setNick(p.user.nickname); setEditing(true); }}>改昵称</button>}
                </div>
              )}
              {/* 不显示账号 ID —— 那是本人登录用的，别人看了也没用处，反倒能拿去冒登 */}
              <div className="muted">{p.user.kind !== 'bot' ? `积分 ${p.user.points}` : kindName(p.user.kind)}</div>
            </div>
          </div>
          <div className="row" style={{ justifyContent: 'space-around', textAlign: 'center' }}>
            <Stat label="对局" v={p.games} /><Stat label="胜率" v={`${p.winRate}%`} /><Stat label="最高息" v={p.maxXi} /><Stat label="最高倍" v={p.maxMul ? `×${p.maxMul}` : '—'} />
          </div>
          <div className="row" style={{ justifyContent: 'space-around', textAlign: 'center' }}>
            <Stat label="胡牌" v={p.hu} /><Stat label="自摸" v={p.zimo} /><Stat label="点炮" v={p.dianpao} /><Stat label="大胡" v={p.bigHu} />
          </div>
          <button className="ghost" onClick={onClose}>关闭</button>
        </div>
      )}
    </Modal>
  );
}
function Stat({ label, v, color }: { label: string; v: string | number; color?: string }) {
  return <div><div style={{ fontSize: 20, fontWeight: 800, color }}>{v}</div><div className="muted">{label}</div></div>;
}
export function kindName(k: string) { return { guest: '游客', user: '注册用户', wechat: '微信用户', bot: '机器人' }[k] ?? k; }

/** 纪录表 */
export function LedgerTable({ ledger, users, onPick, onReplay, cols, totals: totalsIn, batches, gone, batchFrom = 0 }: {
  ledger: LedgerEntry[]; users: Map<number, PublicUser>; onPick?: (e: LedgerEntry) => void; onReplay?: (e: LedgerEntry) => void;
  /** 当下这一段的表头：现在坐在桌上的那几位 */
  cols?: number[];
  /** 合计按服务端那本**总账**算 —— 位子上一直是同一个人的，他的合计从头连着走，不跟着分段重来 */
  totals?: Record<number, number>;
  /** 之前那几段：各有各的表头和小计，一段一段往下排（由近及远） */
  batches?: LedgerBatch[];
  /** 离桌的人各自带走的账：单独一行，人回来了就从这儿提出来接着算 */
  gone?: { id: number; name: string; total: number }[];
  /** 当下这一段从第几局开始（这一局之后的都算当下这一段） */
  batchFrom?: number;
}) {
  const ids = cols && cols.length
    ? cols
    : [...new Set(ledger.flatMap(l => Object.keys(l.deltas).map(Number)))];
  /* 列头的名字：先翻这一局自己记下的名字，再看房里现在还在的人。
     机器人打完就离桌、真人也可能退出 —— 那会儿房间的在线名单里已经没有他了，
     只照名单查，列头就成了一串 userId（机器人是负数，像 -8032932）。
     两头都没有才退回编号，而且加个 # 号，免得看着像分数。 */
  const nameOf = (id: number) => {
    for (let i = ledger.length - 1; i >= 0; i--) { const n = ledger[i].names?.[id]; if (n) return n; }
    return users.get(id)?.nickname ?? `#${Math.abs(id)}`;
  };
  const totals: Record<number, number> = {};
  if (totalsIn) Object.assign(totals, totalsIn);
  else for (const l of ledger) for (const [id, d] of Object.entries(l.deltas)) totals[Number(id)] = (totals[Number(id)] ?? 0) + d;
  const sign = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  /* 兜底：纪录表里出现过、可当下既不在表头、也不在「离桌」那本里的人 ——
     换了位子、机器人被重建、批次没切干净，都会让他这几局的分**整个消失**。
     宁可多一行，也不让谁的账凭空不见了：这儿把他们按账本里的数补进「离桌」那一行。 */
  const extra = (() => {
    const known = new Set([...ids, ...(gone ?? []).map(g => g.id), ...(batches ?? []).flatMap(b => b.seats ?? [])]);
    const sum = new Map<number, number>();
    for (const l of ledger.filter(x => x.round > batchFrom))
      for (const [k, d] of Object.entries(l.deltas)) {
        const id = Number(k);
        if (!known.has(id)) sum.set(id, (sum.get(id) ?? 0) + d);
      }
    return [...sum].map(([id, total]) => ({ id, name: nameOf(id), total }));
  })();
  const goneAll = [...(gone ?? []), ...extra];
  const span = (n: number) => n + 1 + (onReplay ? 1 : 0);   // 局号 + 人头 + 最右那一格（放大镜）
  if (!ledger.length && !batches?.length) return <div className="muted">还没有对局记录</div>;

  /* 一段的那几局。表头、合计 / 小计都由外面画，这儿只出"一局一行"。 */
  const rows = (list: LedgerEntry[], cs: number[]) => list.slice().reverse().map(l => {
    const pickable = !!(l.hu || l.reveal);
    return <tr key={`r${l.round}`} className={onPick && pickable ? 'row-pick' : ''}
      title={l.hu ? '点击查看该局胡牌详情' : l.reveal ? '黄庄：点击查看那局的亮牌' : '流局'}
      onClick={() => onPick && pickable && onPick(l)}>
      {/* 复盘按钮挪到最左边 */}
      {onReplay && <td className="lg-replay">
        <button className="ghost" onClick={ev => { ev.stopPropagation(); onReplay(l); }}>复盘</button></td>}
      <td>{l.round}{l.reveal && !l.hu ? ' 黄' : ''}
        {l.subs?.length ? <span className="badge decline-badge" style={{ background: '#5a6' }} title={l.subs.map(x => `第 ${x.seat + 1} 位：${x.names.join(' → ')}`).join('，')}>替</span> : null}
        {l.declines?.length ? <span className="badge decline-badge" title={l.declines.map(d => `${l.seatNames?.[d.seat] ?? '座位' + d.seat} 弃胡贪大（每家 ${d.unit} 分）`).join('，')}>贪</span> : null}</td>
      {cs.map(id => <td key={id} className={sign(l.deltas[id] ?? 0)}>{l.deltas[id] === undefined ? '-' : fmt(l.deltas[id])}</td>)}
      {/* 放大镜挪到最右边，做大一点 */}
      <td className="lg-look">{pickable ? <span className="lg-eye" title="看这一局">🔍</span> : null}</td>
    </tr>;
  });

  /* 换过人的房间：**竖着往下长**，不再横着加列。
     最上面是当下这三位（表头 + 合计 + 这一段的每一局），
     底下一段一段是之前那几批，各带各的表头和小计 ——
     横着加列的话，没同桌过的人那几格永远是「-」，人一多表就宽得没边。 */
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="ledger">
        <thead><tr>{onReplay && <th className="lg-replay" />}<th>局</th>{ids.map(id => <th key={id}>{nameOf(id)}</th>)}<th className="lg-look" /></tr></thead>
        <tbody>
          {/* 合计单独一行，描一条金线、底色也压深一点，跟每一局分得开。
              这里是**总账**：位子上一直是同一个人的，前面几段的分也都算在里头。 */}
          <tr className="lg-total">{onReplay && <td />}<td>合计</td>
            {ids.map(id => <td key={id} className={sign(totals[id] ?? 0)}>{fmt(totals[id] ?? 0)}</td>)}
            <td /></tr>
          {rows(ledger.filter(l => l.round > batchFrom), ids)}
          {/* 离桌的人：账一直给他留着，回来就从这儿提出来接着算 */}
          {!!goneAll.length && (
            <tr className="lg-gone">{onReplay && <td />}
              <td>离桌</td>
              <td colSpan={ids.length + 1}>
                {goneAll.map(g => (
                  <span key={g.id} className="lg-batch-item">{g.name}
                    <b className={sign(g.total)}>{fmt(g.total)}</b></span>
                ))}
              </td></tr>
          )}
          {/* 之前那几段：一段一个表头，接着是这一段的小计和每一局 */}
          {(batches ?? []).map(b => {
            const cs = b.seats ?? [];
            const nm = (id: number) => b.names?.[id] ?? users.get(id)?.nickname ?? `#${Math.abs(id)}`;
            return (
              <Fragment key={`b${b.no}`}>
                <tr className="lg-sep"><td colSpan={span(cs.length)}>
                  {b.label} · 第 {b.from}–{b.until} 局</td></tr>
                <tr className="lg-head2">{onReplay && <td />}<td>局</td>
                  {cs.map(id => <td key={id}>{nm(id)}</td>)}<td /></tr>
                <tr className="lg-total lg-sub">{onReplay && <td />}<td>小计</td>
                  {cs.map(id => <td key={id} className={sign(b.subtotal?.[id] ?? 0)}>{fmt(b.subtotal?.[id] ?? 0)}</td>)}
                  <td /></tr>
                {rows(ledger.filter(l => l.round >= b.from && l.round <= b.until), cs)}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
/**
 * 桌上有几个人：中间盖一个戳。
 * - 满员：金色的「满」
 * - 一个人都没有：绿色的「空」
 * - 其余：一个表盘 —— 圆周按座位分成几段（真人绿、机器人灰、空位淡淡一条），中间写**真人**几个。
 *   这样一眼就看得出"还差几个人""里头有几个是机器人"，比一行「1 人+1 机 / 3」好认。
 */
export function SeatStamp({ humans, bots, seats }: { humans: number; bots: number; seats: number }) {
  const filled = humans + bots;
  if (filled >= seats) return <span className="tc-stamp st-full" aria-label="满员">满</span>;
  if (filled === 0) return <span className="tc-stamp st-empty" aria-label="空桌">空</span>;
  const R = 15, C = 2 * Math.PI * R, gap = 7;             // gap：段与段之间留的缝（弧长）
  const seg = C / seats;
  return (
    <span className="tc-stamp st-dial" aria-label={`${humans} 人`}>
      <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden>
        {Array.from({ length: seats }, (_, i) => {
          const kind = i < humans ? 'hu' : i < filled ? 'bot' : 'none';
          return <circle key={i} cx="20" cy="20" r={R} fill="none" strokeWidth="3.4" strokeLinecap="round"
            className={`dial-seg dial-${kind}`}
            strokeDasharray={`${Math.max(1, seg - gap)} ${C - Math.max(1, seg - gap)}`}
            strokeDashoffset={-(i * seg + gap / 2)}
            transform="rotate(-90 20 20)" />;
        })}
      </svg>
      <b>{humans}</b>
    </span>
  );
}

export function fmt(n: number) { return n > 0 ? `+${n}` : String(n); }
