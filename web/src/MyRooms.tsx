/**
 * 「我的房间」单独一页（不再是主页上那一小条列表）：
 * 像大厅的桌子一样一张张卡片摆开，一眼看得出哪间要人、哪间打到封顶停在那儿。
 * 点开一张是房间详情：谁坐哪儿、赢输多少、胡几把放几炮、从哪儿上的网，
 * 顺带把读秒、暂停 / 开始、清空数据、解散都摆在手边。
 */
import { useEffect, useState } from 'react';
import { RoomQr } from './Home.tsx';
import { api } from './net.ts';
import { Modal, toast, SeatStamp } from './ui.tsx';
import { RoomHistoryModal } from './Replay.tsx';
import { TileArt } from './TileArt.tsx';

type Seat = {
  seat: number; name: string | null; isBot: boolean; online: boolean; auto?: boolean;
  total: number; games: number; hu: number; dianpao: number; ip: string; ipLoc: string; dev?: string;
};
type MyRoom = {
  id: string; name: string; variant: string; variantName: string; baseScore: number;
  status: string; paused: string | null; roundNo: number;
  turnSec: number; autoNextSec: number; swingCap: number; pauseEvery?: number;
  players: number; bots: number; seats: Seat[]; rounds: number;
};
type Card = { cardUntil: number; cardLeft: number; cardValid: boolean };

const SECS = [10, 15, 20, 30, 45, 60];
/** 卡片底色和右上角那个缩略图，跟大厅的桌子用同一套素材（玩法各有各的颜色） */
const VCLS: Record<string, string> = { hy_honghei: 'tile-hh', ly_tilong: 'tile-tl', hy_liuhuqiang: 'tile-lh' };
const VART = (v: string) => ((VCLS[v] ?? 'tile-hh').replace('tile-', '') as 'hh' | 'tl' | 'lh');
/** 同网段：IPv4 比前三段（113.246.28.x），IPv6 比前四组 —— 同一个小区 / 同一个出口 */
function netKey(ip: string) {
  if (!ip) return '';
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':');
  const p = ip.split('.');
  return p.length === 4 ? p.slice(0, 3).join('.') : '';
}

/** 这间房现在是个什么情况：要不要房主搭把手 */
function flagOf(r: MyRoom) {
  const seats = r.seats.length;
  const taken = r.players + r.bots;
  // 分打满了（总输赢到封顶自动停的）—— 不是房主自己按的暂停
  if (r.paused && !/房主/.test(r.paused)) return { rank: 0, cls: 'cap', text: '分打满了 · 等你处理' };
  if (taken < seats) return { rank: 1, cls: 'short', text: `还差 ${seats - taken} 人` };
  if (r.paused) return { rank: 2, cls: 'off', text: '你按了暂停' };
  if (r.status === 'playing') return { rank: 3, cls: 'on', text: '牌局中' };
  return { rank: 3, cls: '', text: '等待中' };
}

export function MyRoomsPage({ onBack, onEnter, onCreate }: { onBack: () => void; onEnter: (id: string) => void; onCreate: () => void }) {
  const [rooms, setRooms] = useState<MyRoom[] | null>(null);
  const [limit, setLimit] = useState(0);
  const [card, setCard] = useState<Card | null>(null);
  const [busy, setBusy] = useState('');
  const [pick, setPick] = useState<string | null>(null);      // 展开哪一间
  const [hist, setHist] = useState<string | null>(null);
  const [wipe, setWipe] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);   // 展开着二维码的那一间
  const [kill, setKill] = useState<string | null>(null);
  const [openNet, setOpenNet] = useState<number | null>(null);   // 哪一行的 IP / 归属地正摊开着
  const [naming, setNaming] = useState<string | null>(null);     // 正在改名的房名（null = 没在改）

  const load = () => api<any>('/api/myrooms', undefined, 'GET')
    .then(r => {
      setRooms(r.rooms ?? []); setLimit(r.roomLimit ?? 0);
      setCard({ cardUntil: r.cardUntil ?? 0, cardLeft: r.cardLeft ?? 0, cardValid: !!r.cardValid });
    })
    .catch(() => setRooms([]));
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  const rename = async (id: string, name: string) => {
    try { await api('/api/myroom', { id, action: 'rename', name }); setNaming(null); toast(name ? '房名改好了' : '房名清掉了，回到房号'); await load(); }
    catch (e: any) { toast(e?.message ?? '改不了'); }
  };

  const act = async (id: string, action: string, value?: number, okMsg?: string) => {
    setBusy(id + action);
    try { await api('/api/myroom', { id, action, value }); if (okMsg) toast(okMsg); await load(); }
    catch (e: any) { toast(e?.message ?? '操作没成功'); await load(); }
    finally { setBusy(''); }
  };

  // 要房主搭把手的排前头（分打满 → 缺人 → 其余）
  const list = [...(rooms ?? [])].sort((a, b) => flagOf(a).rank - flagOf(b).rank || a.id.localeCompare(b.id));
  const cur = list.find(r => r.id === pick) ?? null;
  useEffect(() => { setOpenNet(null); setNaming(null); }, [pick]);

  if (hist) return <RoomHistoryModal roomId={hist} onClose={() => setHist(null)} />;

  const cardBar = () => {
    if (!card) return null;
    const day = card.cardUntil ? new Date(card.cardUntil).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '';
    if (!card.cardUntil) return <div className="mr-card off">还没有开房月卡 —— 找管理员开一张才能开房。</div>;
    if (!card.cardValid) return <div className="mr-card off">开房月卡已到期（{day}）—— 找管理员续卡，续上才能开新房；已经开着的房间不受影响。</div>;
    if (card.cardLeft <= 7) return <div className="mr-card warn">开房月卡还剩 {card.cardLeft} 天（{day} 到期），记得找管理员续卡。</div>;
    return <div className="mr-card">开房月卡有效期到 {day}（还剩 {card.cardLeft} 天）</div>;
  };

  return (
    <div className="screen col home">
      <div className="home-top">
        <button className="ghost hm-btn" title="返回" onClick={onBack}>‹</button>
        <div className="hm-title">我的房间</div>
        <span className="hm-right">
          <button className="ghost hm-btn" title="开一间新房" onClick={onCreate}>＋</button>
        </span>
      </div>

      <div className="col mr-body">
        {cardBar()}
        <div className="muted" style={{ fontSize: 12 }}>
          {rooms === null ? '加载中…' : `开着 ${rooms.length} 个${limit > 0 ? ` / 上限 ${limit}` : ''} · 点一间看详情`}
        </div>

        {rooms !== null && !rooms.length && (
          <div className="muted">还没有开着的房间。点右上角「＋」开一间，房号发给牌友就能进。</div>
        )}

        <div className="tables">
          {list.map(r => {
            const f = flagOf(r);
            return (
              <button key={r.id} className={`tile table-card mr-card-room ${VCLS[r.variant] ?? ''} ${f.cls}`} onClick={() => setPick(r.id)}>
                {/* 右上角那个四分之一圆的缩略图，跟大厅的桌子一个样 */}
                <span className="tc-art"><TileArt kind={VART(r.variant)} /></span>
                <span className="table-name">
                  <b className="tc-name">{r.name === r.id ? `房 ${r.id}` : r.name}</b><i className="tc-sec">· {r.turnSec}s</i>
                </span>
                <span className="table-sub mr-line">房号 {r.id} · {r.variantName}</span>
                <span className="table-sub mr-line">底分 {r.baseScore} · 第 {r.roundNo} 局</span>
                {/* 人数跟大厅的桌子一个样：满 / 空 / 表盘那个戳，别一处文字一处图标 */}
                <SeatStamp humans={r.players} bots={r.bots} seats={r.seats.length} />
                <span className={`mr-flag ${f.cls}`}>{f.text}</span>
              </button>
            );
          })}
        </div>
      </div>

      {cur && (
        <Modal onClose={() => setPick(null)} className="myrooms-modal">
          <div className="col" style={{ gap: 10 }}>
            <div className="mr-head">
              {naming === null ? (
                <>
                  <b className="mr-name">{cur.name}</b>
                  {/* 开了好几间时，靠名字认比靠房号快 —— 点这支笔就地改 */}
                  <button className="ghost mr-pen" title="改房名"
                          onClick={() => setNaming(cur.name === cur.id ? '' : cur.name)}>✎</button>
                </>
              ) : (
                <>
                  <input className="mr-name-in" value={naming} autoFocus maxLength={12} placeholder="留空就用房号"
                         onChange={e => setNaming(e.target.value.slice(0, 12))}
                         onKeyDown={e => { if (e.key === 'Enter') rename(cur.id, naming); if (e.key === 'Escape') setNaming(null); }} />
                  <button className="mr-ok" onClick={() => rename(cur.id, naming)}>存</button>
                  <button className="ghost mr-ok" onClick={() => setNaming(null)}>取消</button>
                </>
              )}
              <span className={`mr-pill ${flagOf(cur).cls}`}>{flagOf(cur).text}</span>
            </div>
            <div className="muted mr-sub">
              房号 {cur.id} · {cur.variantName} · 底分 {cur.baseScore} · 第 {cur.roundNo} 局
              {cur.swingCap ? ` · 封顶 ${cur.swingCap} 分` : ''}
              {cur.pauseEvery ? ` · 每 ${cur.pauseEvery} 局一歇` : ''}
            </div>
            {cur.paused && <div className="mr-card warn">{cur.paused}</div>}

            {/* 房间详情：谁坐哪个位子、赢输多少、胡了几把、点了几炮，从哪儿上的网 */}
            <div className="mr-players">
              {/* 两个号从同一个 IP 进来：桌上标一下。不下结论，看见了心里有数就行 */}
              {cur.seats.map((s, i) => {
                const real = cur.seats.filter(x => x.name && !x.isBot);
                const same = !!s.ip && real.filter(x => x.ip === s.ip).length > 1;
                // 同网段：不是同一个 IP，但前三段一样 —— 同一个小区 / 同一个营业厅出口
                const sameNet = !same && !!netKey(s.ip) && real.filter(x => netKey(x.ip) === netKey(s.ip)).length > 1;
                // 同设备：一台手机换号登录，这个比 IP 靠谱
                const sameDev = !!s.dev && real.filter(x => x.dev === s.dev).length > 1;
                return (
                  <div key={i} className={`mr-p ${s.name ? '' : 'empty'}`}>
                    <span className="mr-p-seat">{'东南西北'[i] ?? i + 1}</span>
                    <span className="mr-p-main">
                      <b className="mr-p-name">
                        {s.name ?? '空位'}
                        {s.isBot && <i className="mr-tag">机器人</i>}
                        {s.auto && <i className="mr-tag">托管</i>}
                        {s.name && !s.isBot && !s.online && <i className="mr-tag off">离线</i>}
                        {/* 这三个标记挂在名字后面 —— 地址那一行会截断，挂那儿就看不见了 */}
                        {same && <i className="mr-tag same">同 IP</i>}
                        {sameNet && <i className="mr-tag same">同网段</i>}
                        {sameDev && <i className="mr-tag dev">同设备</i>}
                      </b>
                      {s.name && !s.isBot && (
                        /* 地址一行放不下就截断了 —— 点一下摊开看全的（手机上没有鼠标悬停这回事），
                           再点一下收回去；电脑上鼠标悬停也照样有完整的一份。 */
                        <span className={`mr-p-net ${openNet === i ? 'open' : ''}`}
                              title={`${s.ip || '还没记到 IP'}${s.ipLoc ? ' · ' + s.ipLoc : ''}`}
                              onClick={e => { e.stopPropagation(); setOpenNet(openNet === i ? null : i); }}>
                          {s.ip || '—'}{s.ipLoc ? ` · ${s.ipLoc}` : ''}
                        </span>
                      )}
                    </span>
                    <span className="mr-p-num">
                      <b className={s.total > 0 ? 'pos' : s.total < 0 ? 'neg' : ''}>{s.total > 0 ? `+${s.total}` : s.total}</b>
                      <i>{s.games} 局 · 胡 {s.hu} · 放炮 {s.dianpao}</i>
                    </span>
                  </div>
                );
              })}
            </div>

            {/* 读秒：正在打的那一局保持原样，下一局按新的来 */}
            <div className="mr-secs">
              <span className="muted">读秒</span>
              {SECS.map(v => (
                <button key={v} className={`ghost mr-sec ${cur.turnSec === v ? 'cur' : ''}`}
                        disabled={!!busy} onClick={() => act(cur.id, 'turnSec', v, `读秒改成 ${v} 秒`)}>{v}s</button>
              ))}
            </div>

            <div className="mr-acts">
              {cur.paused || cur.status === 'paused'
                ? <button className="ghost" disabled={!!busy} onClick={() => act(cur.id, 'start', undefined, '牌局继续')}>▶ 开始</button>
                : <button className="ghost" disabled={!!busy} onClick={() => act(cur.id, 'pause', undefined, '牌局已暂停')}>‖ 暂停</button>}
              <button className="ghost" onClick={() => setHist(cur.id)}>记录表</button>
              <button className="ghost" disabled={cur.players + cur.bots >= cur.seats.length}
                      title={cur.players + cur.bots >= cur.seats.length ? '人满了，进不去' : '坐下来打一局'}
                      onClick={() => onEnter(cur.id)}>进去打</button>
              <button className="ghost warn" onClick={() => setWipe(cur.id)}>清空数据</button>
              <button className="ghost warn" onClick={() => setKill(cur.id)}>解散</button>
              <button className="ghost" onClick={() => setQr(q => (q === cur.id ? null : cur.id))}>{qr === cur.id ? '收起码' : '二维码'}</button>
            </div>
            {/* 扫这张码直接进这一间（地址里挂着 ?room=房号，main.tsx 认它） */}
            {qr === cur.id && <RoomQr roomId={cur.id} />}
            <button className="ghost" onClick={() => setPick(null)}>关闭</button>
          </div>
        </Modal>
      )}

      {wipe && <Modal onClose={() => setWipe(null)}>
        <div className="col" style={{ gap: 10, maxWidth: 300 }}>
          <b>清空这个房间的数据？</b>
          <div className="muted">这间房的<b>积分牌</b>（各家累计输赢）和<b>记录表</b>清空，等于从现在开始重新记。座位上的人不动，牌接着打。<br />
            牌局本身不会被删：玩家在自己的战绩里照样看得到那些局和复盘。</div>
          <div className="row" style={{ gap: 8 }}>
            <button className="ghost" onClick={() => setWipe(null)}>算了</button>
            <button className="warn" onClick={() => { const id = wipe; setWipe(null); act(id, 'clear', undefined, '数据已清空'); }}>清空</button>
          </div>
        </div>
      </Modal>}

      {kill && <Modal onClose={() => setKill(null)}>
        <div className="col" style={{ gap: 10, maxWidth: 300 }}>
          <b>解散这个房间？</b>
          <div className="muted">桌上的人会被请出去，这一局算作废。已经打完的局还留在记录表里。</div>
          <div className="row" style={{ gap: 8 }}>
            <button className="ghost" onClick={() => setKill(null)}>算了</button>
            <button className="warn" onClick={() => { const id = kill; setKill(null); setPick(null); act(id, 'close', undefined, '房间已解散'); }}>解散</button>
          </div>
        </div>
      </Modal>}
    </div>
  );
}
