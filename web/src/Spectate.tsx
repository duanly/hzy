/** 房主观战：不坐下，只看得到桌上的下地牌和弃牌，以及每一局的记录 */
import { useState } from 'react';
import type { RoomView, PublicUser } from '../../server/src/protocol.ts';
import { nameOf, type Kind, type Meld } from '../../packages/engine/src/index.ts';
import { CardStack } from './Card.tsx';
import { socket } from './net.ts';
import { fmt, useUpright } from './ui.tsx';
import { RoomHistoryModal } from './Replay.tsx';

const MELD_TAG: Record<string, string> = { peng: '碰', wei: '偎', pao: '跑', ti: '提', long: '龙', chi: '吃' };

export function Spectate({ room, me, onLeft }: { room: RoomView; me: PublicUser; onLeft: () => void }) {
  const [ledger, setLedger] = useState(false);
  useUpright(true);
  const g = room.game;
  const isHost = room.hostId === me.id;

  return (
    <div className="screen col spectate">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button className="ghost sq" onClick={() => { socket.send({ type: 'room.leave' }); onLeft(); }}>‹ 退出观战</button>
        <b>{room.name ?? `房 ${room.id}`}</b>
        <span className="muted">第 {room.roundNo} 局</span>
      </div>
      <div className="muted">
        房号 {room.id} · {room.variantName} · 底分 {room.baseScore}
        {room.config ? ` · 读秒 ${room.config.turnSec}s · 自动开局 ${room.config.autoNextSec}s${room.config.swingCap ? ` · 封顶 ${room.config.swingCap}` : ''}` : ''}
      </div>

      {room.pausedReason && (
        <div className="pause-banner">
          {room.pausedReason}
          {/* 谁能点「继续」由服务端说了算：房主，或者桌长（桌上最早坐下的那个真人）——
              大厅的桌子没有房主，就全靠桌长。别人只看得到横幅，看不到按钮。 */}
          {(room.canResume ?? isHost) && <button onClick={() => socket.send({ type: 'room.resume' })}>继续</button>}
        </div>
      )}

      <div className="col" style={{ gap: 8 }}>
        {room.seats.map(s => {
          const p = g?.players?.[s.seat];
          return (
            <div key={s.seat} className={`sp-seat ${g?.turn === s.seat && room.status === 'playing' ? 'sp-turn' : ''}`}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b>{s.user?.nickname ?? '空位'} {s.isBot && <span className="badge" style={{ background: '#556' }}>机</span>}</b>
                <span className={s.total > 0 ? 'pos' : s.total < 0 ? 'neg' : 'muted'}>{fmt(s.total)}</span>
              </div>
              <div className="sp-cards">
                {(p?.melds as Meld[] | undefined)?.map((m, i) => (
                  <span key={i} className="sp-meld" title={MELD_TAG[m.type] ?? m.type}>
                    <CardStack cards={m.cards as Kind[]} size="xxs" className="stack-xxs" heads />
                    <span className="sp-tag">{MELD_TAG[m.type] ?? m.type}</span>
                  </span>
                ))}
                {!p?.melds?.length && <span className="muted">还没下地</span>}
                <span className="sp-hand muted">手里 {p?.handCount ?? 0} 张</span>
              </div>
              {!!(p?.discards as Kind[] | undefined)?.length && (
                <div className="sp-discards">弃：{(p!.discards as Kind[]).map(k => nameOf(k)).join(' ')}</div>
              )}
            </div>
          );
        })}
      </div>

      {/* 有人中途走了、补不齐的时候：房主可以把这一局作废，或者干脆散场 */}
      {isHost && (
        <div className="row" style={{ gap: 8 }}>
          {room.status !== 'waiting' && <button className="ghost" style={{ flex: 1 }}
            onClick={() => { if (confirm('作废当前这一局？这一局不计分，人齐了重新发牌。')) socket.send({ type: 'room.abort' }); }}>作废本局</button>}
          <button className="danger" style={{ flex: 1 }}
            onClick={() => { if (confirm('解散房间并结算？')) { socket.send({ type: 'room.end' }); onLeft(); } }}>解散房间</button>
        </div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button className="ghost" style={{ flex: 1 }} onClick={() => setLedger(true)}>纪录表（每一局）</button>
      </div>
      {room.seats.some(s => !s.user) && room.status !== 'playing' && (
        <div className="muted">还差 {room.seats.filter(s => !s.user).length} 个人 —— 补位的人按退出先后接位子（谁先走空的位子先被接）。</div>
      )}

      {ledger && <RoomHistoryModal roomId={room.id} onClose={() => setLedger(false)} />}
    </div>
  );
}
