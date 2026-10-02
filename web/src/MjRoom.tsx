/**
 * 红中麻将的一整屏：牌桌 + 行动按钮 + 翻马结算。
 *
 * 跟跑胡子那边最大的不同是：**这儿不做帧切片**。
 * 字牌那套要排队播动画（下伙的同时还可能下龙），所以服务端把一步拆成好几帧慢慢发；
 * 麻将一步就是一步 —— 摸一张、打一张、碰了杠了下地，没什么好排队的。
 * 于是服务端每次直接发一张**完整快照**：该亮哪几个按钮、读秒还剩多久，全写在快照里。
 *
 * 这么定下来之后，客户端就**不用自己攒状态**了：
 * 断线重连回来，最新那张快照一到，画面立刻是对的，不会出现"按钮没了""牌堆对不上"。
 * 事件流（game.events）只拿来做两件锦上添花的事：报牌的声音、刚打出那张的高亮。
 * 换句话说，事件丢了也不影响能不能打，只是少听一声。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PublicUser, RoomView, ServerMsg } from '../../server/src/protocol.ts';
import { socket } from './net.ts';
import { MjTable, type MjSeatView, type MjTableView } from './MjTable.tsx';
import { MjTile, mjName, type Tile } from './MjTile.tsx';
import { Modal, toast, fmt } from './ui.tsx';
import { sayAction, sayMa, sayTile, sayYourTurn } from './mjvoice.ts';
import { settings as voiceSettings, voicePack, setVoicePack, voicePacks } from './voice.ts';

/** 服务器时间的秒针。切到后台就停 —— 看不见的时候还每秒跳四次纯属费电 */
/* ---- 屋檐组件：显示红中麻将 · 第x局 · 底分x ---- */
const EAVE_THEMES: Record<string, { a: string; b: string; c: string; trim: string }> = {
  green: { a: '#1f7a58', b: '#166049', c: '#0f4530', trim: 'rgba(255,233,168,.55)' },
  qing: { a: '#2b3a33', b: '#1b2722', c: '#121a17', trim: 'rgba(242,193,78,.5)' },
  red: { a: '#6b2327', b: '#45151a', c: '#280c0f', trim: 'rgba(255,217,138,.62)' },
  blue: { a: '#24405f', b: '#172b42', c: '#0d1826', trim: 'rgba(190,220,255,.6)' },
  gold: { a: '#7a6528', b: '#54441a', c: '#2e250c', trim: 'rgba(255,233,168,.7)' },
};
const EAVE_ORDER = ['green', 'qing', 'red', 'blue', 'gold'];

function EaveBar({ children, theme, onCycle }: { children: React.ReactNode; theme: string; onCycle: () => void }) {
  const W = 480, X0 = 26, X1 = W - 26, Y = 34, CY = 46;
  const t = EAVE_THEMES[theme] ?? EAVE_THEMES.green;
  const pt = (k: number) => {
    const u = 1 - k;
    return [u * u * X0 + 2 * u * k * (W / 2) + k * k * X1, u * u * Y + 2 * u * k * CY + k * k * Y] as const;
  };
  const N = 22, R = (X1 - X0) / N / 2;
  const tiles = Array.from({ length: N }, (_, i) => {
    const [x, y] = pt((i + 0.5) / N);
    return `M ${(x - R).toFixed(1)} ${y.toFixed(1)} a ${R.toFixed(1)} ${(R * 0.9).toFixed(1)} 0 0 0 ${(R * 2).toFixed(1)} 0`;
  }).join(' ');
  return (
    <div className="mj-eave" onClick={onCycle} title="点一下换个檐色">
      <svg viewBox={`0 0 ${W} 56`} preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id={`mj-eave-fill-${theme}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={t.a} />
            <stop offset=".62" stopColor={t.b} />
            <stop offset="1" stopColor={t.c} />
          </linearGradient>
        </defs>
        <path fill={`url(#mj-eave-fill-${theme})`} stroke={t.trim} strokeWidth="1.4"
          d={`M 0 0 H ${W} V 18 C ${W - 4} 30, ${X1 + 10} 24, ${X1} ${Y} Q ${W / 2} ${CY} ${X0} ${Y} C ${X0 - 10} 24, 4 30, 0 18 Z`} />
        <path fill="none" stroke={t.trim} strokeOpacity=".7" strokeWidth="1.2" d={`M 10 14 H ${W - 10}`} />
        <path fill="none" stroke={t.trim} strokeOpacity=".85" strokeWidth="1.3" d={tiles} />
      </svg>
      <span className="mj-eave-text">{children}</span>
    </div>
  );
}

function useNow(active: boolean) {  const [now, setNow] = useState(() => socket.now());
  useEffect(() => {
    if (!active) return;
    let t: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!t) t = setInterval(() => setNow(socket.now()), 250); };
    const stop = () => { if (t) { clearInterval(t); t = null; } };
    const onVis = () => {
      if (document.visibilityState === 'visible') { setNow(socket.now()); start(); } else stop();
    };
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [active]);
  return now;
}

/**
 * 倒计时的剩余比例。
 * 起点记在 ref 里、不每帧重算 —— 否则服务端每来一张快照（deadline 原样不动）
 * 都会被当成"新窗口"重新起算，圈就一直卡在满格不走。
 */
function useRing(until: number, span: number, now: number) {
  const ref = useRef<{ until: number; t0: number; total: number }>({ until: 0, t0: 0, total: 1 });
  if (until && ref.current.until !== until) {
    const left = Math.max(800, until - now);
    ref.current = { until, t0: now, total: span > 0 ? Math.min(span, left) : left };
  }
  if (!until) return null;
  const left = Math.max(0, ref.current.t0 + ref.current.total - now);
  return { left, frac: Math.min(1, left / ref.current.total), sec: Math.ceil(left / 1000) };
}

const ACT_LABEL: Record<string, string> = { peng: '碰', gang: '杠', hu: '胡', pass: '过' };
/** 按钮从上往下的固定次序：自动胡牌，所以没有胡按钮；杠最上，过最下 */
const ACT_ORDER = ['gang', 'peng', 'pass'];

/**
 * 一枚行动按钮。倒计时不描圈，让**整个按钮自己褪色** ——
 * 跟跑胡子那边统一（那边是量过发热之后改的：stroke-dashoffset 合成器插不了值，
 * 一圈就是一条 60 帧／秒的常驻动画，几个圈叠起来手机会烫）。
 */
function ActBtn({ kind, frac, locked, chosen, onPress }: {
  kind: string; frac: number | null; locked: boolean; chosen: boolean; onPress: () => void;
}) {
  return (
    /* 这儿**故意不写 disabled**：浏览器不给 disabled 的按钮派发任何指针事件，
       于是锁住期间玩家再点就是石沉大海 —— 没动作、没提示，看着像卡死。
       照样接事件，锁没锁交给 onPress 去判断并说一句话。 */
    <button className={`mj-act mj-act-${kind} ${locked ? (chosen ? 'chosen' : 'idle') : ''}`}
      aria-disabled={locked || undefined}
      style={frac === null || locked ? undefined : {
        filter: `saturate(${(0.15 + 0.85 * frac).toFixed(2)}) brightness(${(0.55 + 0.45 * frac).toFixed(2)})`,
        opacity: (0.42 + 0.58 * frac).toFixed(2),
        transition: 'opacity .25s linear, filter .18s ease-out',
      }}
      onPointerDown={e => { e.preventDefault(); onPress(); }}>
      {ACT_LABEL[kind] ?? kind}
    </button>
  );
}

/** 结算面板：翻到的马 + 怎么算出来的 + 四家各进出多少 */
function EndPanel({ room, g, now, onClose }: { room: RoomView; g: any; now: number; onClose: () => void }) {
  const last = room.ledger[room.ledger.length - 1];
  const hu = last?.hu as any;
  const scores: number[] = g?.scores ?? [0, 0, 0, 0];
  const names: string[] = last?.seatNames ?? room.seats.map((s, i) => s.user?.nickname ?? `座位${i + 1}`);
  const gang: number[] = (last as any)?.penalty ?? [0, 0, 0, 0];
  const left = room.nextRoundAt ? Math.max(0, room.nextRoundAt - now) : 0;
  return (
    <Modal onClose={onClose} className="mj-end">
      <div className="mj-end-head">
        {g?.winner !== null && g?.winner !== undefined
          ? <><b>{names[g.winner]}</b> 自摸</>
          : <b>荒庄</b>}
      </div>

      {/* 翻马：这一局最后一下，单独拎出来放大 —— 翻到什么直接决定翻几倍 */}
      {hu && (
        <div className="mj-end-ma">
          <span className="mj-end-ma-label">翻马</span>
          {g.ma === null || g.ma === undefined
            ? <span className="mj-end-ma-none">牌摸完了，没马可翻</span>
            : <><MjTile tile={g.ma} size="md" /><span className="mj-end-ma-name">{mjName(g.ma)}</span></>}
        </div>
      )}

      {/* 算分的明细：服务端怎么算的就怎么列，别在客户端再算一遍 —— 两处算法早晚会分家 */}
      {hu?.detail?.breakdown?.length > 0 && (
        <ul className="mj-end-why">
          {hu.detail.breakdown.map((line: string, i: number) => <li key={i}>{line}</li>)}
        </ul>
      )}

      <table className="mj-end-tally">
        <tbody>
          {names.map((n, i) => (
            <tr key={i} className={i === g?.winner ? 'win' : ''}>
              <td className="n">{n}{i === g?.dealer && <i className="mj-zhuang">庄</i>}</td>
              {/* 杠分已经算进总数了，这儿再单列一份，让人看得出这几分是哪来的 */}
              <td className="gg">{gang[i] ? `杠 ${fmt(gang[i])}` : ''}</td>
              <td className={`v ${scores[i] > 0 ? 'pos' : scores[i] < 0 ? 'neg' : ''}`}>{fmt(scores[i])}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mj-end-foot">
        {left > 0 ? <span>{Math.ceil(left / 1000)} 秒后开下一局</span> : <span>等待下一局…</span>}
        <button className="btn ghost" onClick={onClose}>看牌桌</button>
      </div>
    </Modal>
  );
}

export function MjRoom({ room, me, onLeft }: { room: RoomView; me: PublicUser; onLeft: () => void }) {
  const g: any = room.game;
  const mySeat = room.mySeat;
  const now = useNow(!!g);

  /** 手里选中的那张：第一下选中抬起来，第二下才真打出去（防手滑） */
  const [picked, setPicked] = useState<number | undefined>(undefined);
  /** 能杠的不止一张时，先弹一排让人挑 */
  const [gangPick, setGangPick] = useState(false);
  /** 点过之后到下一张快照到达之前先锁住，免得连点两次发两条 */
  const [sent, setSent] = useState<{ deadline: number; act: string; tile?: Tile } | null>(null);
  /** 乐观更新的回滚定时器：5秒没收到确认就恢复原状 */
  const rollbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showEnd, setShowEnd] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  /** 拖牌出牌的拖动状态：按下那一下记起点，拖出弧线就出牌 */
  const dragRef = useRef<{ i: number; tile: Tile; y0: number; started: boolean } | null>(null);
  const [dragOut, setDragOut] = useState(false);
  /** 拖动时跟着手指的虚影 */
  const [dragGhost, setDragGhost] = useState<{ tile: Tile; x: number; y: number } | null>(null);

  /** 行动气泡 */
  const [bubbles, setBubbles] = useState<{ id: number; seat: number; text: string; ms?: number }[]>([]);
  const bubbleIdRef = useRef(0);
  const bubble = (seat: number, text: string, ms = 1150) => {
    const id = ++bubbleIdRef.current;
    setBubbles(b => [...b, { id, seat, text, ms }]);
    setTimeout(() => setBubbles(b => b.filter(x => x.id !== id)), ms);
  };

  /** 开局横幅 */
  const [banner, setBanner] = useState<{ text: string; sub?: string } | null>(null);
  const bannerTimerRef = useRef<number | null>(null);
  const showBanner = (text: string, sub?: string, ms = 1400) => {
    if (bannerTimerRef.current) { clearTimeout(bannerTimerRef.current); bannerTimerRef.current = null; }
    setBanner({ text, sub });
    bannerTimerRef.current = window.setTimeout(() => setBanner(null), ms);
  };

  /** 设置面板 */
  const [toolsOpen, setToolsOpen] = useState(false);
  const [eaveTheme, setEaveTheme] = useState(() => {
    try { return localStorage.getItem('mj_eave') || 'green'; } catch { return 'green'; }
  });
  const cycleEave = () => {
    const idx = EAVE_ORDER.indexOf(eaveTheme);
    const n = EAVE_ORDER[(idx + 1) % EAVE_ORDER.length];
    setEaveTheme(n);
    try { localStorage.setItem('mj_eave', n); } catch { /* ignore */ }
  };
  const [voicePick, setVoicePick] = useState(false);
  const [packs, setPacks] = useState<{ id: string; name: string; count: number }[]>([]);
  const [brightness, setBrightness] = useState<'dim' | 'normal' | 'bright'>(() => {
    try { return (localStorage.getItem('mj_brightness') as any) || 'normal'; } catch { return 'normal'; }
  });
  const cycleBrightness = () => {
    const next: Record<string, 'dim' | 'normal' | 'bright'> = { dim: 'normal', normal: 'bright', bright: 'dim' };
    const n = next[brightness];
    setBrightness(n);
    try { localStorage.setItem('mj_brightness', n); } catch { /* ignore */ }
  };
  const [soundOn, setSoundOn] = useState(voiceSettings.tts);
  const toggleSound = () => {
    voiceSettings.tts = !voiceSettings.tts;
    voiceSettings.save();
    setSoundOn(voiceSettings.tts);
  };

  /** 加载配音包列表 */
  useEffect(() => {
    if (voicePick) voicePacks('mj').then(setPacks);
  }, [voicePick]);

  const opts: string[] = g?.options ?? [];
  const canDiscard = opts.includes('discard');
  const btnActs = ACT_ORDER.filter(a => opts.includes(a));
  const ring = useRing(opts.length ? (g?.deadline ?? 0) : 0, g?.optionsSpan ?? 0, now);
  // 头像那圈倒计时：跟"是不是轮到我"无关，只看当前 deadline —— 谁在行动就绕谁的头像转
  const turnRing = useRing(g?.deadline ?? 0, g?.optionsSpan ?? 0, now);
  const locked = !!sent && sent.deadline === (g?.deadline ?? 0);

  /* 服务端换了新窗口（deadline 变了）＝ 上一步已经揭晓，锁可以松了，乐观更新确认成功。
     不靠"收到任何一张快照就解锁"：同一个窗口里快照会来好几张（别人碰了杠了都会广播）。 */
  useEffect(() => {
    setSent(null);
    if (rollbackRef.current) { clearTimeout(rollbackRef.current); rollbackRef.current = null; }
  }, [g?.deadline, g?.phase]);
  /* 轮次一变，手里选中的那张就作废 —— 不然上一轮抬起来的牌会一直举着 */
  useEffect(() => { setPicked(undefined); setGangPick(false); dragRef.current = null; setDragOut(false); }, [g?.turn, g?.phase]);

  /* 一局结束：先在中心播翻马动画，1.8 秒后再弹结算清单。
     用 winner/phase 作触发，不用事件 —— 事件可能因为断线丢掉，而快照一定会到。
     关掉之后不再自动弹回来（看牌桌是玩家主动要看的）。
     新一局开始时（phase 变了）自动关掉结算面板，否则旧面板挂着新数据会显示成"荒庄"。 */
  const endedKey = g?.phase === 'ended' ? `${room.roundNo}` : '';
  const prevEndedKeyRef = useRef('');
  useEffect(() => {
    if (!endedKey) {
      // 从 ended 变成非 ended（新一局开始）→ 关掉结算面板
      if (prevEndedKeyRef.current) setShowEnd(false);
      prevEndedKeyRef.current = '';
      return;
    }
    prevEndedKeyRef.current = endedKey;
    const t = setTimeout(() => setShowEnd(true), 1800);
    return () => clearTimeout(t);
  }, [endedKey]);

  /* 新一局开始：显示"开始打牌"横幅。
     用 roundNo 作触发 —— roundNo 变了且 phase 是 discard，说明新局已开。 */
  const roundStartRef = useRef(0);
  useEffect(() => {
    if (!g || g.phase !== 'discard') return;
    if (roundStartRef.current === 0) { roundStartRef.current = room.roundNo; return; }
    if (room.roundNo !== roundStartRef.current) {
      roundStartRef.current = room.roundNo;
      // 等骰子动画结束后再显示横幅
      const t = setTimeout(() => showBanner('开始打牌', "LET'S PLAY"), 1200);
      return () => clearTimeout(t);
    }
  }, [g?.phase, room.roundNo]);

  /* 报牌的声音走事件流。丢了也就少听一声，不影响能不能打 */
  useEffect(() => socket.on((m: ServerMsg) => {
    /* 服务端把这一步**驳回**了（"这张杠不了""还没轮到你"）：马上解锁，撤销乐观更新。
       不解的话就僵在这儿了 —— 锁是靠"deadline 变了"解开的，而驳回压根不换窗口，
       于是这一整个读秒里玩家再点什么都没反应，只能眼睁睁看着超时被托管。
       这条是渲染的时候试出来的：打完一张之后按钮全灰，才想到驳回也是这个下场。 */
    if (m.type === 'error') {
      setSent(null);
      if (rollbackRef.current) { clearTimeout(rollbackRef.current); rollbackRef.current = null; }
      return;
    }
    if (m.type !== 'game.events') return;
    for (const e of ((m as any).events ?? []) as any[]) {
      if (e.t === 'discard') sayTile(e.tile);
      else if (e.t === 'peng') { sayAction('peng', e.tile); bubble(e.seat, '碰'); }
      else if (e.t === 'gang') {
        sayAction(e.kind === 'an' ? 'angang' : e.kind === 'bu' ? 'bugang' : 'gang',
          e.tile >= 0 ? e.tile : undefined);
        bubble(e.seat, '杠');
      }
      else if (e.t === 'hu') { sayAction('hu'); sayMa(e.ma); bubble(e.seat, '胡', 1500); }
      else if (e.t === 'liuju') sayAction('liuju');
      else if (e.t === 'pass') { bubble(e.seat, '过'); }
    }
  }), []);

  /* 轮到我出牌：响一下。只在"从不是我到是我"那一下响，
     同一轮里快照来几张就响几次的话，会吵得没法打。 */
  const turnRef = useRef(false);
  useEffect(() => {
    const mine = canDiscard;
    if (mine && !turnRef.current) sayYourTurn();
    turnRef.current = mine;
  }, [canDiscard]);

  const send = (action: string, tile?: number) => {
    if (locked) { toast('上一步还在等服务器回话'); return; }
    socket.send({ type: 'game.act', action, ...(tile === undefined ? {} : { tile }) } as any);
    setSent({ deadline: g?.deadline ?? 0, act: action, tile });
    setPicked(undefined); setGangPick(false);
    // 5 秒兜底：服务端一直不换窗口（比如丢包了）就撤销乐观更新
    if (rollbackRef.current) clearTimeout(rollbackRef.current);
    rollbackRef.current = setTimeout(() => { setSent(null); }, 5000);
  };

  const gangTiles: Tile[] = g?.gangTiles ?? [];
  const onAct = (kind: string) => {
    if (kind !== 'gang') return send(kind, kind === 'peng' ? (g?.claimTile ?? undefined) : undefined);
    /* 抢牌阶段杠的就是桌上那一张，没得挑；轮到自己的时候手里可能有好几张能杠 */
    if (g?.phase === 'claim') return send('gang', g?.claimTile ?? undefined);
    if (gangTiles.length === 1) return send('gang', gangTiles[0]);
    setGangPick(true);
  };

  // 自动胡牌：只要可以胡就直接胡，不需要点按钮
  const huSentRef = useRef<number | null>(null);
  const canHu = opts.includes('hu');
  useEffect(() => {
    if (canHu && !locked && huSentRef.current !== g?.deadline) {
      huSentRef.current = g?.deadline ?? null;
      send('hu');
    }
  }, [canHu, locked, g?.deadline]);

  /** 拖牌出牌：手上方一条弧线，拖过去就出牌；单击选中/取消，快速双击出牌 */
  const lastTapRef = useRef<{ i: number; t: number } | null>(null);
  const DOUBLE_TAP_MS = 280;

  const onTilePointerDown = (e: React.PointerEvent, t: Tile, i: number) => {
    const wasPicked = picked === i;
    dragRef.current = { i, tile: t, y0: e.clientY, started: false };
    setDragOut(false);
    const move = (ev: PointerEvent) => {
      const d = dragRef.current; if (!d) return;
      const dy = d.y0 - ev.clientY;
      if (!d.started && Math.abs(dy) > 6) d.started = true;
      setDragOut(!!d.started && dy > 22 && canDiscard);
      if (d.started) setDragGhost({ tile: d.tile, x: ev.clientX, y: ev.clientY });
    };
    const up = (ev: PointerEvent) => {
      const d = dragRef.current; dragRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragGhost(null);
      if (!d) return;
      const dy = d.y0 - ev.clientY;
      if (d.started && dy > 22) {           // 拖出弧线 → 出牌
        setDragOut(false); setPicked(undefined);
        if (canDiscard) send('discard', d.tile);
      } else if (!d.started) {              // 没拖动 → 单击选中/取消，双击出牌
        const now = Date.now();
        const last = lastTapRef.current;
        const isDouble = last && last.i === d.i && now - last.t < DOUBLE_TAP_MS;
        if (isDouble && canDiscard) {
          // 快速双击 → 直接出牌
          setPicked(undefined);
          lastTapRef.current = null;
          send('discard', d.tile);
        } else if (wasPicked) {
          // 单击已选中的牌 → 取消选中（落下）
          setPicked(undefined);
          lastTapRef.current = { i: d.i, t: now };
        } else {
          // 单击未选中的牌 → 选中（抬高）
          setPicked(d.i);
          lastTapRef.current = { i: d.i, t: now };
        }
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const v: MjTableView | null = useMemo(() => {
    if (!g) return null;
    // 胡牌的那一张：亮牌时标在赢家手牌上
    const hu = room.ledger[room.ledger.length - 1]?.hu as any;
    const huSeat = hu?.seat, huTile = hu?.card;

    // 乐观更新：刚打出一张牌，等服务端确认
    const discarding = sent?.act === 'discard' && sent.tile !== undefined
      && sent.deadline === g.deadline;

    const players: MjSeatView[] = g.players.map((p: any, i: number) => {
      let hand = p.hand;
      let handIds = p.handIds ?? null;
      let handCount = p.handCount;
      let drawn: Tile | true | null = p.drawn ?? null;
      let drawnId: number | null = p.drawnId ?? null;
      // 自己的手牌：乐观移除刚打出的那张，drawn 清空，牌归位
      if (discarding && i === mySeat && hand) {
        const idx = hand.indexOf(sent!.tile);
        if (idx >= 0) {
          hand = hand.slice();
          hand.splice(idx, 1);
          if (handIds) {
            handIds = handIds.slice();
            handIds.splice(idx, 1);
          }
          handCount = hand.length;
          drawn = null;
          drawnId = null;
        }
      }
      return {
        seat: i,
        hand, handIds, handCount, drawn, drawnId, melds: p.melds, discards: p.discards,
        name: room.seats[i]?.user?.nickname ?? (room.seats[i]?.isBot ? '机器人' : `座位${i + 1}`),
        total: room.seats[i]?.total ?? 0,
        isDealer: i === g.dealer,
        isTurn: g.phase === 'claim' ? false : i === g.turn,
        huTile: i === huSeat ? huTile : undefined,
      };
    });
    return {
      players, mySeat: mySeat ?? 0, wallLeft: g.wallLeft, table: g.table,
      ma: g.ma, dice: g.dice ?? [1, 1], phase: g.phase,
      roundNo: room.roundNo, baseScore: room.baseScore,
      dealer: g.dealer,
      nextRoundAt: (g as any).nextRoundAt ?? null,
      serverNow: g.serverNow ?? Date.now(),
    };
  }, [g, room.seats, room.ledger, mySeat, room.roundNo, room.baseScore, sent]);

  if (!g || !v) {
    return (
      <div className="screen center">
        <div className="panel col" style={{ maxWidth: 320, gap: 12 }}>
          <b>{room.name ?? '红中麻将'}</b>
          <div className="muted">房号 {room.id}　底分 {room.baseScore}</div>
          <div className="muted">{room.status === 'waiting' ? '等人齐了就开局' : '牌局准备中…'}</div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={() => socket.send({ type: 'room.ready', ready: true })}>准备</button>
            <button className="btn ghost" onClick={() => { socket.send({ type: 'room.leave' }); onLeft(); }}>离开</button>
          </div>
        </div>
      </div>
    );
  }

  const brightnessFilter = brightness === 'dim' ? 'brightness(.75)'
    : brightness === 'bright' ? 'brightness(1.15)' : 'brightness(1)';

  const standUp = () => {
    setToolsOpen(false);
    toast(room.status !== 'playing' ? '已起立离开'
      : (room as any).isPrivate ? '已起立，位子让出去了，牌局暂停等人补位'
      : '已起立，这一局机器人替你打完，位子不再留');
    socket.send({ type: 'room.leave', stand: true } as any);
    onLeft();
  };

  return (
    <div className="screen mj-screen" style={{ filter: brightnessFilter }}>
      <div className="mj-bar">
        <button className="mj-ico-btn" title="离开"
          onClick={() => { socket.send({ type: 'room.leave' }); onLeft(); }}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
               strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 21h4a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-4" />
            <polyline points="8 17 3 12 8 7" />
            <line x1="3" y1="12" x2="15" y2="12" />
          </svg>
        </button>
        <EaveBar theme={eaveTheme} onCycle={cycleEave}>
          红中麻将 · 第 {room.roundNo} 局 · 底分 {room.baseScore}
        </EaveBar>
        <span className="grow" />
        {ring && <span className="mj-clock">{ring.sec}s</span>}
        <button className="mj-ico-btn" title="记录"
          onClick={() => setShowHistory(true)} disabled={!room.ledger.length}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
               strokeWidth="1.9" strokeLinecap="round">
            <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
            <path d="M3.5 9h17M3.5 14.5h17M9.5 9v11M15 9v11" />
          </svg>
        </button>
        <div className={`mj-tools ${toolsOpen ? 'open' : ''}`}>
          <button className="mj-ico-btn mj-tools-btn" title="设置"
            onClick={() => setToolsOpen(o => !o)}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
                 strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3.2" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
          </button>
          {toolsOpen && (
            <div className="mj-tools-pop" onMouseDown={e => e.stopPropagation()}>
              <button className="ghost mj-tt-item" title="亮度：暗 / 正常 / 亮" onClick={cycleBrightness}>
                <b>{brightness === 'dim' ? '🌙' : brightness === 'bright' ? '☀' : '🔅'}</b>
                <span>{brightness === 'dim' ? '偏暗' : brightness === 'bright' ? '偏亮' : '正常'}</span>
              </button>
              <button className={`ghost mj-tt-item ${soundOn ? 'on' : ''}`} title="声音开关" onClick={toggleSound}>
                <b>{soundOn ? '🔊' : '🔇'}</b>
                <span>{soundOn ? '有声' : '静音'}</span>
              </button>
              <button className="ghost mj-tt-item" title="配音选择" onClick={() => { setVoicePick(true); }}>
                <b>🎤</b>
                <span>配音</span>
              </button>
              <button className="ghost mj-tt-item mj-tt-stand" title="起立离开" onClick={standUp}>
                <b>🚪</b>
                <span>起立</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <MjTable v={v} picked={picked} ringFrac={turnRing?.frac} now={now}
        onTilePointerDown={onTilePointerDown}
        onHistory={() => setShowHistory(true)}
        bubbles={bubbles}
        banner={banner} />

      {/* 出牌弧线：手上方一条线，拖过去松手出牌 */}
      {canDiscard && picked !== undefined && (
        <div className={`mj-arc ${dragOut ? 'on' : ''}`}>
          <span className="mj-arc-tip">{dragOut ? '松手出牌' : '拖出弧线出牌'}</span>
        </div>
      )}
      {/* 选中的牌：给一个「打」按钮，跟拖出弧线、再点一下三种方式随便用哪个 */}
      {canDiscard && picked !== undefined && v && (() => {
        const h = (v.players[mySeat ?? 0]?.hand ?? []) as Tile[];
        const tile = h[picked];
        return (
          <button className="mj-discard" onClick={() => { if (tile !== undefined) send('discard', tile); }}>
            <span className="mj-discard-text">打</span>
            <span className="mj-discard-card">
              <MjTile tile={tile} size="xs" variant="flat" />
            </span>
          </button>
        );
      })()}

      {/* 拖牌虚影：跟着手指走 */}
      {dragGhost && (
        <div className="mj-drag-ghost" style={{ left: dragGhost.x, top: dragGhost.y }}>
          <MjTile tile={dragGhost.tile} size="lg" />
        </div>
      )}

      {/* 行动按钮：竖着一排贴右下角，拇指够得着 */}
      {btnActs.length > 0 && (
        <div className="mj-acts">
          {btnActs.map(k => (
            <ActBtn key={k} kind={k} frac={ring?.frac ?? null} locked={locked}
              chosen={sent?.act === k} onPress={() => onAct(k)} />
          ))}
        </div>
      )}

      {/* 杠哪张：手里有好几张够得上的时候才弹 */}
      {gangPick && (
        <div className="mj-gangpick">
          <span>杠哪张？</span>
          {gangTiles.map(t => (
            <button key={t} className="mj-gangpick-t" onPointerDown={e => { e.preventDefault(); send('gang', t); }}>
              <MjTile tile={t} size="sm" />
            </button>
          ))}
          <button className="btn ghost sm" onClick={() => setGangPick(false)}>算了</button>
        </div>
      )}

      {showEnd && <EndPanel room={room} g={g} now={now} onClose={() => setShowEnd(false)} />}
      {showHistory && <HistoryModal room={room} onClose={() => setShowHistory(false)} />}
      {voicePick && (
        <Modal onClose={() => setVoicePick(false)} className="mj-voice-modal">
          <div className="col" style={{ gap: 10 }}>
            <b>配音选择</b>
            <div className="muted" style={{ fontSize: 12 }}>选一套你喜欢的报牌声</div>
            <div className="mj-voice-list">
              <button className={`mj-voice-item ${voicePack() === '' ? 'on' : ''}`}
                onClick={() => { setVoicePack(''); setVoicePick(false); }}>
                <b>默认</b>
                <span>系统合成音</span>
              </button>
              {packs.map(p => (
                <button key={p.id} className={`mj-voice-item ${voicePack() === p.id ? 'on' : ''}`}
                  onClick={() => { setVoicePack(p.id); setVoicePick(false); }}>
                  <b>{p.name}</b>
                  <span>{p.count} 条录音</span>
                </button>
              ))}
            </div>
            <button className="ghost" onClick={() => setVoicePick(false)}>关闭</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ============================================================
   记录弹窗：列出每一局，点进去看每家手牌
   ============================================================ */
function HistoryModal({ room, onClose }: { room: any; onClose: () => void }) {
  const [pick, setPick] = useState<any>(null);
  if (pick !== null) {
    return <RoundDetail entry={pick} onClose={() => setPick(null)} />;
  }
  const ledger = room.ledger ?? [];
  const names = room.seats.map(s => s.user?.nickname ?? '机器人');
  // 累计总分：按顺序累计每一局的 deltas
  const totals = room.seats.map(() => 0);
  for (const e of ledger) {
    const deltas = e.deltas ?? {};
    room.seats.forEach((s: any, i: number) => {
      const uid = s.user?.id;
      if (uid != null) totals[i] += (deltas[uid] ?? 0);
    });
  }
  return (
    <Modal onClose={onClose} className="mj-hist-modal">
      <div className="col" style={{ gap: 8 }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <b>牌局记录</b>
          <span className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>共 {room.ledgerCount ?? ledger.length} 局 · 点一局看详情</span>
        </div>
        {/* 总分栏 */}
        {ledger.length > 0 && (
          <div className="mj-hist-total">
            {room.seats.map((s: any, i: number) => (
              <div key={i} className="mj-hist-total-item">
                <div className="mj-hist-total-name">{s.user?.nickname ?? '机器人'}</div>
                <div className={`mj-hist-total-val ${totals[i] > 0 ? 'pos' : totals[i] < 0 ? 'neg' : ''}`}>
                  {totals[i] > 0 ? `+${totals[i]}` : totals[i]}
                </div>
              </div>
            ))}
          </div>
        )}
        {!ledger.length ? (
          <div className="muted">还没有打完的局</div>
        ) : (
          <div className="mj-hist-scroll">
            <table className="ledger mj-hist-table">
              <thead>
                <tr>
                  <th>局</th>
                  <th>胡牌</th>
                  {names.map((n, i) => <th key={i}>{n}</th>)}
                </tr>
              </thead>
              <tbody>
                {ledger.slice().reverse().map((e: any) => {
                  const deltas = e.deltas ?? {};
                  const hu = e.hu;
                  const huName = hu && hu.card != null && hu.card >= 0 ? mjName(hu.card as Tile) : '黄庄';
                  return (
                    <tr key={e.round} className="row-pick" onClick={() => setPick(e)}>
                      <td>第 {e.round} 局</td>
                      <td>{huName}</td>
                      {room.seats.map((s: any, i: number) => {
                        const uid = s.user?.id;
                        const d = uid != null ? (deltas[uid] ?? 0) : 0;
                        return (
                          <td key={i} className={d > 0 ? 'pos' : d < 0 ? 'neg' : ''}>
                            {d > 0 ? `+${d}` : d}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <button className="ghost" onClick={onClose}>关闭</button>
      </div>
    </Modal>
  );
}

function RoundDetail({ entry, onClose }: { entry: any; onClose: () => void }) {
  const names: string[] = entry.seatNames ?? ['座位1', '座位2', '座位3', '座位4'];
  const reveal = entry.reveal;
  const hu = entry.hu;
  const gangScores = entry.penalty ?? [0, 0, 0, 0];
  return (
    <Modal onClose={onClose} className="mj-hist-modal">
      <div className="col" style={{ gap: 10 }}>
        <div className="row" style={{ alignItems: 'center', gap: 8 }}>
          <b>第 {entry.round} 局</b>
          <span className="muted" style={{ fontSize: 12 }}>
            {hu && hu.card != null && hu.card >= 0
              ? `${names[hu.seat] ?? ''} 自摸 ${mjName(hu.card as Tile)}`
              : '黄庄'}
          </span>
          {hu?.detail?.ma != null && hu.detail.ma >= 0 && (
            <span className="muted" style={{ fontSize: 12 }}>
              马：{mjName(hu.detail.ma as Tile)}
            </span>
          )}
        </div>

        {/* 每家的手牌 + 下地牌 */}
        {reveal ? (
          <div className="mj-hist-hands">
          {names.map((nm: string, i: number) => {
            const hands = reveal.hands?.[i] ?? [];
            const melds = reveal.melds?.[i] ?? [];
            const isWinner = reveal.winner === i;
            return (
              <div key={i} className="mj-hist-hand-row">
                <div className="mj-hist-name">
                  {nm}
                  {isWinner && <span className="mj-hist-win">胡</span>}
                </div>
                <div className="mj-hist-cards">
                  {/* 下地牌 */}
                  {melds.map((m: any, j: number) => {
                    const count = m.type === 'gang' ? 4 : (m.type === 'peng' ? 3 : 0);
                    if (count === 0) return null;
                    return (
                      <span key={'m' + j} className="mj-hist-meld">
                        {Array.from({ length: count }).map((_, k) => (
                          <MjTile key={k} tile={m.tile as Tile} size="xs" variant="flat" />
                        ))}
                      </span>
                    );
                  })}
                  {melds.length > 0 && hands.length > 0 && <span className="mj-hist-gap" />}
                  {/* 手牌 */}
                  {hands.map((t: Tile, j: number) => (
                    <MjTile key={'h' + j} tile={t} size="xs" variant="flat" />
                  ))}
                </div>
                <div className="mj-hist-score">
                  {gangScores[i] ? `杠 ${gangScores[i] > 0 ? '+' : ''}${gangScores[i]}` : ''}
                </div>
              </div>
            );
          })}
          </div>
        ) : (
          <div className="muted">没有亮牌记录</div>
        )}

        {/* 算分明细 */}
        {hu?.detail?.breakdown?.length > 0 && (
          <ul className="mj-hist-why">
            {hu.detail.breakdown.map((line: string, i: number) => <li key={i}>{line}</li>)}
          </ul>
        )}

        {/* 每家输赢（用 entry.names 或者 seatNames 对应的 deltas） */}
        <table className="ledger">
          <tbody>
            {names.map((n: string, i: number) => {
              // deltas 是按 userId 存的，但我们只有 seatNames，试试从 entry.deltas 里按顺序取
              const dArr = entry.scores ?? (entry.hu?.detail?.scores ?? []);
              const d = dArr[i] ?? 0;
              return (
                <tr key={i} className={reveal?.winner === i ? 'win' : ''}>
                  <td className="n">{n}</td>
                  <td className={`v ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}`}>{d > 0 ? `+${d}` : d}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <button className="ghost" onClick={onClose}>关闭</button>
      </div>
    </Modal>
  );
}
