import { useEffect, useState } from 'react';
import type { TierInfo, PublicUser } from '../../server/src/protocol.ts';
import type { VariantId } from '../../packages/engine/src/index.ts';
import { HistoryModal } from './Replay.tsx';
import { socket, setToken } from './net.ts';
import { Avatar, Modal, toast, ProfileModal, useUpright } from './ui.tsx';
import { settings } from './voice.ts';

const VARIANTS: { id: VariantId; name: string; desc: string }[] = [
  { id: 'hy_honghei', name: '衡阳红黑', desc: '3 人 · 10 胡起胡按敦计分，大红×5 小红×3 全黑×5 一点红×4，自摸×2' },
  { id: 'hy_liuhuqiang', name: '衡阳六胡抢', desc: '4 人（庄 15 张、闲 14 张）· 衡阳算法，8 红小红 10 红大红' },
  { id: 'ly_tilong', name: '耒阳提龙', desc: '3 人 · 提龙即时算分（大字 2 倍/小字 1 倍），红黑/天地胡息翻倍，10/20 胡卡胡，自摸敦数×2' },
];

export function Lobby({ me, canOpenRoom, onLogout }: { me: PublicUser; canOpenRoom: boolean; onLogout: () => void }) {
  const [tiers, setTiers] = useState<TierInfo[]>([]);
  const [create, setCreate] = useState(false);
  const [join, setJoin] = useState(false);
  const [profile, setProfile] = useState<number | null>(null);
  const [variant, setVariant] = useState<VariantId>('hy_honghei');
  const [base, setBase] = useState(1);
  const [turnSec, setTurnSec] = useState(30);   // 每步行动时间（房主设置）
  useUpright(create || join);                  // 开房 / 加入房间要打字：先别转屏
  const [pwd, setPwd] = useState('');
  const [roomId, setRoomId] = useState('');
  const [, force] = useState(0);
  // 中途退出、机器人正替我打的那一桌：可以回去接着打
  const [resume, setResume] = useState<string | null>(null);
  const [history, setHistory] = useState(false);   // 战绩 / 回放

  useEffect(() => {
    const off = socket.on(m => { if (m.type === 'lobby.list') { setTiers(m.tiers); setResume(m.resume ?? null); } });
    socket.send({ type: 'lobby.list' });
    const t = setInterval(() => socket.send({ type: 'lobby.list' }), 5000);
    return () => { off(); clearInterval(t); };
  }, []);

  return (
    <div className="screen col" style={{ gap: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row"><Avatar user={me} onClick={() => setProfile(me.id)} /><div><div style={{ fontWeight: 700 }}>{me.nickname}{me.vip ? ' 👑' : ''}</div><div className="muted">积分 {me.points}</div></div></div>
        <div className="title" style={{ fontSize: 22, letterSpacing: 2, whiteSpace: 'nowrap' }}>衡之娱</div>
        <div className="row" style={{ gap: 6 }}>
          <button className="ghost" style={{ padding: '6px 10px', whiteSpace: 'nowrap' }} onClick={() => { settings.tts = !settings.tts; settings.save(); force(x => x + 1); }}>{settings.tts ? '🔊' : '🔇'}</button>
          <button className="ghost" style={{ padding: '6px 10px', whiteSpace: 'nowrap' }} onClick={() => setHistory(true)}>战绩</button>
          <button className="ghost" style={{ padding: '6px 10px', whiteSpace: 'nowrap' }} onClick={() => { setToken(null); onLogout(); }}>退出</button>
        </div>
      </div>

      {resume && (
        <div className="panel col">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>你还有一桌在打（机器人托管中）</b>
            <button onClick={() => socket.send({ type: 'room.join', roomId: resume })}>返回牌局</button>
          </div>
        </div>
      )}

      <div className="panel col">
        <div className="row" style={{ justifyContent: 'space-between' }}><b>大厅（机器人陪打，积分结算）</b><span className="muted">人不够 4 秒后机器人补位</span></div>
        <div className="tiers">
          {tiers.map(t => (
            <div className="tier" key={t.id} onClick={() => { if (me.points < t.minPoints) return toast(`需要 ${t.minPoints} 积分`); socket.send({ type: 'lobby.join', tier: t.id }); }}>
              <h4>{t.name}</h4>
              <div className="muted">底分 {t.baseScore} · 门槛 {t.minPoints}</div>
              <div className="muted">在线 {t.online}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel col">
        <b>私人房（房间内计分，不影响账号积分）</b>
        <div className="row">
          <button style={{ flex: 1 }} disabled={!canOpenRoom} onClick={() => setCreate(true)}>{canOpenRoom ? '开房' : '开房（需 VIP）'}</button>
          <button style={{ flex: 1 }} className="ghost" onClick={() => setJoin(true)}>输入房号加入</button>
        </div>
      </div>

      {history && <HistoryModal onClose={() => setHistory(false)} />}

      {create && (
        <Modal onClose={() => setCreate(false)}>
          <div className="col">
            <b>创建私人房</b>
            {VARIANTS.map(v => (
              <label key={v.id} className="row" style={{ cursor: 'pointer' }}>
                <input type="radio" style={{ width: 'auto' }} checked={variant === v.id} onChange={() => setVariant(v.id)} />
                <div><div>{v.name}</div><div className="muted">{v.desc}</div></div>
              </label>
            ))}
            <div className="row"><span style={{ whiteSpace: 'nowrap' }}>底分</span><input type="number" min={1} max={1000} value={base} onChange={e => setBase(Number(e.target.value))} /></div>
            <div className="row"><span style={{ whiteSpace: 'nowrap' }}>行动时间</span>
              <select value={turnSec} onChange={e => setTurnSec(Number(e.target.value))}>
                {[15, 20, 30, 45, 60].map(v => <option key={v} value={v}>{v} 秒</option>)}
              </select>
            </div>
            <div className="row"><span style={{ whiteSpace: 'nowrap' }}>密码</span><input inputMode="numeric" placeholder="4-6 位数字" value={pwd} onChange={e => setPwd(e.target.value.replace(/\D/g, '').slice(0, 6))} /></div>
            <div className="muted">六胡抢 4 人、其余 3 人；其他人凭房号和密码进入。中途有人退出会暂停，补位后继续。</div>
            <button onClick={() => { if (!/^\d{4,6}$/.test(pwd)) return toast('密码需 4-6 位数字'); socket.send({ type: 'room.create', variant, baseScore: base, password: pwd, turnMs: turnSec * 1000 }); setCreate(false); }}>创建</button>
          </div>
        </Modal>
      )}
      {join && (
        <Modal onClose={() => setJoin(false)}>
          <div className="col">
            <b>加入私人房</b>
            <input inputMode="numeric" placeholder="房号（6 位）" value={roomId} onChange={e => setRoomId(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            <input inputMode="numeric" placeholder="房间密码" value={pwd} onChange={e => setPwd(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            <button onClick={() => { socket.send({ type: 'room.join', roomId, password: pwd }); setJoin(false); }}>加入</button>
          </div>
        </Modal>
      )}
      {profile !== null && <ProfileModal userId={profile} onClose={() => setProfile(null)} />}
    </div>
  );
}
