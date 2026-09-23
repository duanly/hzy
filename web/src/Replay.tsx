/** 一局回放：拿"开局那副牌 + 每一步生效的决定"在本地把引擎重跑一遍，一步一步看 */
import { useEffect, useMemo, useState } from 'react';
import { Game, getRules, nameOf, type Kind, type GameEvent, type Meld, type VariantId } from '../../packages/engine/src/index.ts';
import { Card } from './Card.tsx';
import { revealCols } from './sort.ts';
import { Modal, toast } from './ui.tsx';
import { note } from './log.ts';
import { api } from './net.ts';

const MELD_NAME: Record<string, string> = { peng: '碰', wei: '偎', pao: '开跑', ti: '提龙', long: '龙', chi: '吃' };

interface SeatSnap { hand: Kind[]; melds: Meld[]; discards: Kind[] }
interface Frame { text: string; seat: number; players: SeatSnap[]; table: Kind | null; pileLeft: number; scores: number[] }

export interface ReplayData {
  variant: VariantId; baseScore: number; dealer: number; deck: Kind[];
  steps: { s: number; t: string; c?: Kind; g?: Kind[]; l?: number }[];
  seatNames: string[];
}

/** 把事件说成人话；返回 null 表示这一步没有画面，不单独占一帧 */
function describe(e: GameEvent, names: string[]): { text: string; seat: number } | null {
  const nm = (s: number) => names[s] ?? `座位${s + 1}`;
  switch (e.t) {
    case 'deal': return { text: '发牌', seat: e.dealer };
    case 'draw': return { text: `${nm(e.seat)} 摸 ${nameOf(e.card)}`, seat: e.seat };
    case 'discard': return { text: `${nm(e.seat)} 打 ${nameOf(e.card)}`, seat: e.seat };
    case 'play_drawn': return { text: `${nm(e.seat)} 打出摸到的 ${nameOf(e.card)}`, seat: e.seat };
    case 'dead': return { text: `${nameOf(e.card)} 没人要，进牌池`, seat: -1 };
    case 'meld': return { text: `${nm(e.seat)} ${(e.meld as any).part ? '下伙' : MELD_NAME[e.meld.type] ?? e.meld.type} ${nameOf(e.meld.cards[0])}`, seat: e.seat };
    case 'penalty': return { text: `${nm(e.seat)} ${e.reason}：罚分`, seat: e.seat };
    case 'tilong_score': return { text: `${nm(e.seat)} 提龙，每人 ${Math.abs(e.delta.find((_, i) => i !== e.seat) ?? 0)} 分`, seat: e.seat };
    case 'hu': return { text: `${nm(e.seat)} 胡 ${e.card >= 0 ? nameOf(e.card) : ''}${e.ziMo ? '（自摸）' : ''}`, seat: e.seat };
    case 'liuju': return { text: '黄庄（流局）', seat: -1 };
    default: return null;   // options / pass / bupai / 延时卡这些不单独占一帧
  }
}

function build(d: ReplayData): { frames: Frame[]; pile: Kind[] } {
  const out: Frame[] = [];
  const g = new Game({
    rules: getRules(d.variant), baseScore: d.baseScore, dealer: d.dealer, now: () => 0, replay: true,
    onEvent: (e: GameEvent) => {
      const t = describe(e, d.seatNames);
      if (!t) return;
      out.push({
        text: t.text, seat: t.seat,
        players: g.players.map(p => ({ hand: [...p.hand], melds: p.melds.map(m => ({ ...m })), discards: [...p.discards] })),
        table: (g as any).tableCard?.card ?? null,
        pileLeft: (g as any).pile.length,
        scores: [...g.scores],
      });
    },
  });
  g.start(d.deck);
  // 发完牌之后剩下的这一摞就是"底牌"，按摸牌顺序排；摸一张就从前面少一张
  const pile: Kind[] = [...(g as any).pile];
  for (const st of d.steps) {
    if (g.ended) break;
    g.act(st.s, st.t as any, { card: st.c, combo: st.g, lay: st.l });
  }
  // 最后一帧：把手牌全亮出来
  if (out.length) out[out.length - 1].players = g.players.map(p => ({ hand: [...p.hand], melds: p.melds.map(m => ({ ...m })), discards: [...p.discards] }));
  return { frames: out, pile };
}

/** 把这一局的原始回放 JSON 交出去：优先复制到剪贴板，不行就存成文件 */
async function exportRound(roundId: number, raw: unknown) {
  const text = JSON.stringify(raw);
  try { await navigator.clipboard.writeText(text); toast(`第 ${roundId} 局已复制（${(text.length / 1024).toFixed(1)}KB），粘贴发出去就行`); return; }
  catch { /* 壳里没有剪贴板权限就走下载 */ }
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = `round${roundId}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`已导出 round${roundId}.json`);
  } catch { toast('导不出来：剪贴板和下载都被挡住了'); }
}

export function ReplayModal({ roundId, onClose }: { roundId: number; onClose: () => void }) {
  const [data, setData] = useState<ReplayData | null>(null);
  const [raw, setRaw] = useState<unknown>(null);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    let alive = true;
    api<any>(`/api/round/${roundId}`, undefined, 'GET').then(r => {
      if (!alive) return;
      const e = r.entry ?? {};
      if (!e.replay) { toast('这一局没有复盘记录'); onClose(); return; }
      setRaw(r);
      setData({
        variant: r.variant, baseScore: e.baseScore ?? 1, dealer: e.replay.dealer ?? 0,
        deck: e.replay.deck, steps: e.replay.steps, seatNames: e.seatNames ?? [],
      });
    }).catch(() => { toast('取不到这一局的回放'); onClose(); });
    return () => { alive = false; };
  }, [roundId]);
  const built = useMemo(() => {
    if (!data) return { frames: [] as Frame[], pile: [] as Kind[] };
    note('回放：开始还原', `${data.steps.length} 步`);
    const f = build(data);
    note('回放：还原完成', `${f.frames.length} 帧`);
    return f;
  }, [data]);
  const frames = built.frames;
  useEffect(() => {
    if (!playing || !frames.length) return;
    const t = setTimeout(() => setI(v => (v + 1 >= frames.length ? (setPlaying(false), v) : v + 1)), 900);
    return () => clearTimeout(t);
  }, [playing, i, frames.length]);

  const f = frames[Math.min(i, Math.max(0, frames.length - 1))];
  return <Modal onClose={onClose}>
    <div className="col replay-box" style={{ gap: 8, minWidth: 300 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>复盘回放</b>
        <span className="muted">{frames.length ? `${i + 1} / ${frames.length}` : '正在还原…'}</span>
      </div>
      {f && <>
        <div className="replay-step">{f.text}{f.table !== null && <span className="muted" style={{ marginLeft: 8 }}>桌上：{nameOf(f.table)}</span>}<span className="muted" style={{ marginLeft: 8 }}>底牌 {f.pileLeft}</span></div>
        <div className="col replay-seats">
          {f.players.map((p, s) => (
            <div key={s} className={`replay-seat ${f.seat === s ? 'replay-active' : ''}`}>
              <div className="replay-name">{data?.seatNames[s] ?? `座位${s + 1}`}<span className="muted" style={{ marginLeft: 6 }}>{f.scores[s] > 0 ? `+${f.scores[s]}` : f.scores[s]}</span></div>
              {/* 固定三行：手牌 / 下地 / 弃牌 —— 一步一步看的时候位置不跳 */}
              <div className="replay-line">
                <i className="replay-tag">手</i>
                <span className="replay-row">{revealCols(p.hand).map((gp, j) => (
                  <span key={'h' + j} className="replay-group">{gp.map((k, q) => <Card key={q} kind={k} size="xxs" head />)}</span>
                ))}</span>
              </div>
              <div className="replay-line">
                <i className="replay-tag">地</i>
                <span className="replay-row">{p.melds.length
                  ? p.melds.map((m, j) => <span key={'m' + j} className="replay-meld">{m.cards.map((k, q) => <Card key={q} kind={k} size="xxs" head />)}</span>)
                  : <span className="muted replay-none">—</span>}</span>
              </div>
              <div className="replay-line">
                <i className="replay-tag">弃</i>
                <span className={`replay-row replay-discards ${p.discards.length ? '' : 'replay-empty'}`}>{p.discards.length
                  ? p.discards.map((k, q) => <Card key={q} kind={k} size="xxs" head />)
                  : <span className="muted replay-none">—</span>}</span>
              </div>
            </div>
          ))}
          {/* 公共牌（底牌）：按摸牌顺序摆一排 —— 已经摸走的在左边（红虚线框住，跟弃牌一个样），
              一条竖线隔开，右边是还没摸的。看到第几步，这条线就走到第几张 */}
          {built.pile.length > 0 && (() => {
            const gone = Math.max(0, built.pile.length - f.pileLeft);
            const drawn = built.pile.slice(0, gone), rest = built.pile.slice(gone);
            return <div className="replay-seat replay-pile">
              <div className="replay-name">底牌
                <span className="muted" style={{ marginLeft: 6 }}>摸走 {gone} · 还剩 {rest.length}</span>
              </div>
              <div className="replay-line">
                <i className="replay-tag">底</i>
                <span className="replay-row">
                  <span className={`replay-drawn ${drawn.length ? '' : 'replay-empty'}`}>
                    {drawn.map((k, q) => <Card key={'d' + q} kind={k} size="xxs" head />)}
                  </span>
                  <i className="replay-split" />
                  {rest.map((k, q) => <Card key={'r' + q} kind={k} size="xxs" head />)}
                </span>
              </div>
            </div>;
          })()}
        </div>
        <input type="range" min={0} max={Math.max(0, frames.length - 1)} value={i} onChange={e => { setPlaying(false); setI(Number(e.target.value)); }} />
        <div className="row" style={{ justifyContent: 'center', gap: 8 }}>
          <button className="ghost" onClick={() => { setPlaying(false); setI(v => Math.max(0, v - 1)); }}>上一步</button>
          <button onClick={() => setPlaying(p => !p)}>{playing ? '暂停' : '播放'}</button>
          <button className="ghost" onClick={() => { setPlaying(false); setI(v => Math.min(frames.length - 1, v + 1)); }}>下一步</button>
        </div>
      </>}
      <div className="row" style={{ justifyContent: 'center', gap: 8 }}>
        {/* 卡住 / 算分不对的时候，把这一局原样导出来发给开发，照着它能把这一局一步不差地重跑一遍 */}
        <button className="ghost" disabled={!raw} onClick={() => exportRound(roundId, raw)}>导出这一局</button>
        <button className="ghost" onClick={onClose}>关闭</button>
      </div>
    </div>
  </Modal>;
}

/** 一"场"＝同一个房间连着打的一串局：中间隔了半小时以上，或者局数重新从头数，就算新的一场 */
const SESSION_GAP = 30 * 60 * 1000;
interface Sess { key: string; roomId: string; roomName: string | null; isPrivate: boolean; variant: string; t0: number; t1: number; rows: any[]; delta: number }
function groupSessions(rows: any[]): Sess[] {
  const out: Sess[] = [];
  // rows 是按时间倒序来的，这里顺着时间走一遍好判断"接不接得上"
  for (const r of [...rows].reverse()) {
    const last = out[out.length - 1];
    const follows = last && last.roomId === r.roomId
      && r.time - last.t1 < SESSION_GAP
      && (r.round ?? 0) >= (last.rows[last.rows.length - 1].round ?? 0);
    if (follows) { last.rows.push(r); last.t1 = r.time; last.delta += r.delta ?? 0; continue; }
    out.push({ key: `${r.roomId}-${r.time}`, roomId: r.roomId, roomName: r.roomName ?? null, isPrivate: !!r.isPrivate,
      variant: r.variant, t0: r.time, t1: r.time, rows: [r], delta: r.delta ?? 0 });
  }
  // 每一场里面的局从新到旧；场次本身也从新到旧
  for (const s of out) s.rows.reverse();
  return out.reverse();
}
const VARIANT_CN: Record<string, string> = { hy_honghei: '衡阳红黑', hy_liuhuqiang: '六胡抢', ly_tilong: '耒阳提龙' };
const fmtDay = (t: number) => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtClock = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

/** 战绩列表：退出房间之后也能回看 / 复盘自己打过的局，按"场次"归类 */
export function HistoryModal({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);   // 展开哪一场；null = 场次一览
  useEffect(() => { api<any>('/api/rounds?limit=200', undefined, 'GET').then(r => setRows(r.rounds)).catch(() => setRows([])); }, []);
  const sessions = useMemo(() => groupSessions(rows ?? []), [rows]);
  const cur = open ? sessions.find(s => s.key === open) ?? null : null;
  const where = (ss: Sess) => (ss.isPrivate ? `房 ${ss.roomId}` : (ss.roomName ?? ss.roomId));
  if (pick !== null) return <ReplayModal roundId={pick} onClose={() => setPick(null)} />;

  /* 展开一场：其余场次全收起来，这一场单独占满 —— 局数少也是这么高，
     局数多就在这块里上下滚（列表自己是滚动区，不跟外面抢） */
  if (cur) return <Modal onClose={onClose} className="hist-modal">
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <button className="ghost" onClick={() => setOpen(null)}>‹ 全部场次</button>
        <b style={{ flex: 1, minWidth: 0 }}>{where(cur)} <span className="muted" style={{ fontWeight: 400 }}>{VARIANT_CN[cur.variant] ?? cur.variant}</span></b>
        <span className={cur.delta > 0 ? 'pos' : cur.delta < 0 ? 'neg' : 'muted'}>{cur.delta > 0 ? `+${cur.delta}` : cur.delta}</span>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        {fmtDay(cur.t0)}{cur.t1 > cur.t0 ? ` – ${fmtClock(cur.t1)}` : ''} · 共 {cur.rows.length} 局 · 点一局看复盘
      </div>
      <div className="hist-scroll">
        <table className="ledger"><tbody>
          {cur.rows.map(r => (
            <tr key={r.id} className="row-pick" onClick={() => r.hasReplay ? setPick(r.id) : toast('这一局没有复盘记录')}>
              <td>第 {r.round} 局</td>
              <td className="muted">{fmtClock(r.time)}</td>
              <td className={r.delta > 0 ? 'pos' : r.delta < 0 ? 'neg' : ''}>{r.delta > 0 ? `+${r.delta}` : r.delta}</td>
              <td>{r.hasReplay ? '▶ 复盘' : ''}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <button className="ghost" onClick={onClose}>关闭</button>
    </div>
  </Modal>;

  // 场次一览：有记录的场次全列出来，点一场进去
  return <Modal onClose={onClose} className="hist-modal">
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ alignItems: 'center', gap: 8 }}>
        <b style={{ flex: 1 }}>战绩 · 复盘回放</b>
        {/* 清空：只清自己这边看到的记录，不动别人的 */}
        {!!sessions.length && <button className="ghost" style={{ padding: '3px 10px', fontSize: 12 }}
          onClick={async () => {
            if (!confirm('清空复盘记录？清完你这边就看不到这些对局了（别人的记录不受影响，也不影响积分）。')) return;
            try { await api('/api/rounds/clear', {}); setRows([]); setOpen(null); toast('复盘记录已清空'); }
            catch (e: any) { toast(e?.message ?? '清不掉'); }
          }}>清空</button>}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>按场次归类，点一场看当场所有对局；最近 200 局可复盘</div>
      {!rows ? <div className="muted">加载中…</div> : !sessions.length ? <div className="muted">还没有打完的对局</div> : (
        <div className="hist-scroll">
          {sessions.map(ss => (
            <div key={ss.key} className="sess">
              <div className="sess-head" onClick={() => setOpen(ss.key)}>
                <span className="sess-arrow">▸</span>
                <div className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                  <b>{where(ss)} <span className="muted" style={{ fontWeight: 400 }}>{VARIANT_CN[ss.variant] ?? ss.variant}</span></b>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {fmtDay(ss.t0)}{ss.t1 > ss.t0 ? ` – ${fmtClock(ss.t1)}` : ''} · {ss.rows.length} 局
                  </span>
                </div>
                <span className={ss.delta > 0 ? 'pos' : ss.delta < 0 ? 'neg' : 'muted'}>{ss.delta > 0 ? `+${ss.delta}` : ss.delta}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <button className="ghost" onClick={onClose}>关闭</button>
    </div>
  </Modal>;
}

/** 房主：这个房间打过的每一局（可回放） */
export function RoomHistoryModal({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  useEffect(() => { api<any>(`/api/room/${roomId}/rounds`, undefined, 'GET').then(r => setRows(r.rounds)).catch(() => setRows([])); }, [roomId]);
  if (pick !== null) return <ReplayModal roundId={pick} onClose={() => setPick(null)} />;
  return <Modal onClose={onClose}>
    <div className="col" style={{ gap: 8, minWidth: 280 }}>
      <b>房间纪录 · 每一局（复盘）</b>
      {!rows ? <div className="muted">加载中…</div> : !rows.length ? <div className="muted">这个房间还没有打完的局</div> : (
        <div style={{ maxHeight: '55vh', overflowY: 'auto' }}>
          <table className="ledger"><tbody>
            {rows.map(r => (
              <tr key={r.id} className="row-pick" onClick={() => r.hasReplay ? setPick(r.id) : toast('这一局没有复盘记录')}>
                <td>第 {r.round} 局</td>
                <td>{new Date(r.time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                <td>{(r.seatNames ?? []).join(' / ')}</td>
                <td>{r.hasReplay ? '▶ 复盘' : ''}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
      <button className="ghost" onClick={onClose}>关闭</button>
    </div>
  </Modal>;
}

export { Card };
