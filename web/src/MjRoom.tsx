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

/** 服务器时间的秒针。切到后台就停 —— 看不见的时候还每秒跳四次纯属费电 */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => socket.now());
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
/** 按钮从上往下的固定次序：胡最上（手指够得着的那头），过最下 */
const ACT_ORDER = ['hu', 'gang', 'peng', 'pass'];

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
  const [sent, setSent] = useState<{ deadline: number; act: string } | null>(null);
  const [showEnd, setShowEnd] = useState(false);

  const opts: string[] = g?.options ?? [];
  const canDiscard = opts.includes('discard');
  const btnActs = ACT_ORDER.filter(a => opts.includes(a));
  const ring = useRing(opts.length ? (g?.deadline ?? 0) : 0, g?.optionsSpan ?? 0, now);
  const locked = !!sent && sent.deadline === (g?.deadline ?? 0);

  /* 服务端换了新窗口（deadline 变了）＝ 上一步已经揭晓，锁可以松了。
     不靠"收到任何一张快照就解锁"：同一个窗口里快照会来好几张（别人碰了杠了都会广播）。 */
  useEffect(() => { setSent(null); }, [g?.deadline, g?.phase]);
  /* 轮次一变，手里选中的那张就作废 —— 不然上一轮抬起来的牌会一直举着 */
  useEffect(() => { setPicked(undefined); setGangPick(false); }, [g?.turn, g?.phase]);

  /* 一局结束：弹结算。用 winner/phase 作触发，不用事件 —— 事件可能因为断线丢掉，
     而快照一定会到。关掉之后不再自动弹回来（看牌桌是玩家主动要看的）。 */
  const endedKey = g?.phase === 'ended' ? `${room.roundNo}` : '';
  useEffect(() => { if (endedKey) setShowEnd(true); }, [endedKey]);

  /* 报牌的声音走事件流。丢了也就少听一声，不影响能不能打 */
  useEffect(() => socket.on((m: ServerMsg) => {
    /* 服务端把这一步**驳回**了（"这张杠不了""还没轮到你"）：马上解锁。
       不解的话就僵在这儿了 —— 锁是靠"deadline 变了"解开的，而驳回压根不换窗口，
       于是这一整个读秒里玩家再点什么都没反应，只能眼睁睁看着超时被托管。
       这条是渲染的时候试出来的：打完一张之后按钮全灰，才想到驳回也是这个下场。 */
    if (m.type === 'error') { setSent(null); return; }
    if (m.type !== 'game.events') return;
    for (const e of ((m as any).events ?? []) as any[]) {
      if (e.t === 'discard') sayTile(e.tile);
      else if (e.t === 'peng') sayAction('peng', e.tile);
      else if (e.t === 'gang') sayAction(e.kind === 'an' ? 'angang' : e.kind === 'bu' ? 'bugang' : 'gang',
        e.tile >= 0 ? e.tile : undefined);
      else if (e.t === 'hu') { sayAction('hu'); sayMa(e.ma); }
      else if (e.t === 'liuju') sayAction('liuju');
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
    setSent({ deadline: g?.deadline ?? 0, act: action });
    setPicked(undefined); setGangPick(false);
  };

  const gangTiles: Tile[] = g?.gangTiles ?? [];
  const onAct = (kind: string) => {
    if (kind !== 'gang') return send(kind, kind === 'peng' ? (g?.claimTile ?? undefined) : undefined);
    /* 抢牌阶段杠的就是桌上那一张，没得挑；轮到自己的时候手里可能有好几张能杠 */
    if (g?.phase === 'claim') return send('gang', g?.claimTile ?? undefined);
    if (gangTiles.length === 1) return send('gang', gangTiles[0]);
    setGangPick(true);
  };

  const onDiscard = (t: Tile, i: number) => {
    if (!canDiscard) { toast('还没轮到你出牌'); return; }
    if (picked !== i) { setPicked(i); return; }   // 第一下：抬起来
    send('discard', t);                            // 第二下：打出去
  };

  const v: MjTableView | null = useMemo(() => {
    if (!g) return null;
    const players: MjSeatView[] = g.players.map((p: any, i: number) => ({
      seat: i,
      hand: p.hand, handCount: p.handCount, melds: p.melds, discards: p.discards,
      name: room.seats[i]?.user?.nickname ?? (room.seats[i]?.isBot ? '机器人' : `座位${i + 1}`),
      total: room.seats[i]?.total ?? 0,
      isDealer: i === g.dealer,
      isTurn: g.phase === 'claim' ? false : i === g.turn,
    }));
    return {
      players, mySeat: mySeat ?? 0, wallLeft: g.wallLeft, table: g.table,
      ma: g.ma, roundNo: room.roundNo, baseScore: room.baseScore,
    };
  }, [g, room.seats, mySeat, room.roundNo, room.baseScore]);

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

  return (
    <div className="screen mj-screen">
      <div className="mj-bar">
        <span>第 {room.roundNo} 局</span>
        <span className="muted">底分 {room.baseScore}</span>
        <span className="grow" />
        {ring && <span className="mj-clock">{ring.sec}s</span>}
        <button className="btn ghost sm" onClick={() => setShowEnd(true)} disabled={!room.ledger.length}>上一局</button>
        <button className="btn ghost sm" onClick={() => { socket.send({ type: 'room.leave' }); onLeft(); }}>离开</button>
      </div>

      <MjTable v={v} onDiscard={onDiscard} picked={picked} />

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
    </div>
  );
}
