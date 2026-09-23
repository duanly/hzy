import { useEffect, useState } from 'react';
import { api, setToken, PLATFORM, apiBase, setApiBase, DEFAULT_API, type AuthResult } from './net.ts';
import { toast, useUpright } from './ui.tsx';
import { deviceId } from './device.ts';
import { badWord, badWordMsg } from '../../server/src/badwords.ts';
import { AboutBrief, AboutModal } from './About.tsx';

const NICK_A = ['快乐', '悠然', '一枝', '半城', '风清', '月半', '闲云', '小小', '老', '阿'];
const NICK_B = ['春风', '青山', '归鸿', '听雨', '独秀', '烟火', '野鹤', '甜甜', '牌王', '牌友'];
export const randomNick = () => (NICK_A[Math.floor(Math.random() * NICK_A.length)] + NICK_B[Math.floor(Math.random() * NICK_B.length)]).slice(0, 4);

/**
 * 登录 / 注册页。
 * - 这台设备**已经有账号**（退出之后又回来）：只给「进入游戏」和「我有账号 ID」，
 *   不再给昵称框 —— 那等于绕过改名次数偷偷改名。
 * - 这台设备**还没有账号**：才给起昵称的框（随机先填一个）。
 */
export function Login({ onDone }: { onDone: (r: AuthResult) => void }) {
  useUpright();                       // 登录页要打字：按手机本来的方向显示
  const [nick, setNick] = useState(randomNick);
  const [busy, setBusy] = useState(false);
  const [srvOpen, setSrvOpen] = useState(false);
  const [srv, setSrv] = useState(apiBase() || DEFAULT_API);
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState('');
  const [waitUnbind, setWaitUnbind] = useState(false);   // 正等原设备点「解除绑定」
  const [about, setAbout] = useState(false);            // 「这是个什么游戏」
  // 本机已有的账号：开页时问一声（probe＝只问不建号）
  const [known, setKnown] = useState<AuthResult | null | undefined>(undefined);
  useEffect(() => {
    api<AuthResult>('/api/auth/device', { deviceId: deviceId(), probe: true })
      .then(r => setKnown(r)).catch(() => setKnown(null));
  }, []);

  async function run(path: string, body: unknown) {
    setBusy(true);
    try { const r = await api<AuthResult>(path, body); setToken(r.token); onDone(r); }
    catch (e: any) {
      const msg = String(e?.message ?? '');
      if (msg.includes('解除绑定')) setWaitUnbind(true);
      toast(msg || '进不去');
    }
    finally { setBusy(false); }
  }

  return (
    <div className="screen center">
      <div className="col" style={{ width: 'min(360px, 92vw)', alignItems: 'stretch' }}>
        <img className="login-logo" src="icon-192.png" alt="" draggable={false} />
        <div className="title center">衡之娱</div>
        <div className="muted center">衡阳红黑 · 六胡抢 · 耒阳提龙</div>
        <div className="panel col">
          {known === undefined ? <div className="muted center">正在认这台设备…</div>
            : known ? (
              <>
                <div className="center" style={{ fontSize: 16 }}>欢迎回来，<b>{known.user.nickname}</b></div>
                <button disabled={busy} onClick={() => { setToken(known.token); onDone(known); }}>进入游戏</button>
                <div className="muted center" style={{ fontSize: 12 }}>这台设备记着你的账号，直接进就行</div>
              </>
            ) : (
              <>
                <div className="row">
                  <input placeholder="起个昵称（最多四个字）" value={nick} maxLength={4}
                    onChange={e => setNick([...e.target.value].slice(0, 4).join(''))} />
                  <button className="ghost" style={{ whiteSpace: 'nowrap' }} onClick={() => setNick(randomNick())}>换一个</button>
                </div>
                <button disabled={busy} onClick={() => {
                  const bad = badWord(nick);
                  if (bad) return toast(badWordMsg(bad));
                  run('/api/auth/device', { deviceId: deviceId(), nickname: nick });
                }}>进入游戏</button>
                <div className="muted center" style={{ fontSize: 12 }}>昵称跟本机绑定，以后打开就直接是你（之后最多还能改 3 次）</div>
              </>
            )}

          <button className="ghost" disabled={busy} onClick={() => setCodeOpen(o => !o)}>我有账号 ID</button>
          {codeOpen && <div className="col" style={{ gap: 6 }}>
            <input value={code} onChange={e => { setCode(e.target.value.trim().toLowerCase()); setWaitUnbind(false); }}
              placeholder="账号 ID（7~9 位字母）" autoCapitalize="off" spellCheck={false} maxLength={12} />
            <button disabled={busy || code.length < 6}
              onClick={() => run('/api/auth/code', { code, deviceId: deviceId() })}>
              {waitUnbind ? '解除好了，再试一次' : '用这个账号进'}
            </button>
            {waitUnbind
              ? <div className="muted" style={{ fontSize: 11, color: 'var(--gold)' }}>
                  已经通知原来那台设备了：在那台机器上点「解除绑定」，再回来按上面的按钮。
                </div>
              : <div className="muted" style={{ fontSize: 11 }}>
                  换手机、或者同一台机器换个入口进来，用账号 ID 就能接着用原来的号；
                  换设备要原来那台点一下「解除绑定」才放行。
                </div>}
          </div>}

          <div className="muted center" style={{ fontSize: 12 }}>
            平台：{PLATFORM} · <a style={{ color: 'var(--gold)', cursor: 'pointer' }} onClick={() => setSrvOpen(o => !o)}>服务器</a>
          </div>
          {srvOpen && <div className="col" style={{ gap: 6 }}>
            <input value={srv} onChange={e => setSrv(e.target.value)} placeholder={DEFAULT_API} autoCapitalize="off" spellCheck={false} />
            <div className="row">
              <button className="ghost" style={{ flex: 1 }} onClick={() => { setSrv(DEFAULT_API); }}>用默认</button>
              <button style={{ flex: 1 }} onClick={() => setApiBase(srv)}>保存并重连</button>
            </div>
            <div className="muted" style={{ fontSize: 11 }}>当前：{apiBase()}</div>
          </div>}
        </div>
        {/* 这是个什么游戏：几个词扫一眼，想细看点开 */}
        <AboutBrief onMore={() => setAbout(true)} />
      </div>
      {about && <AboutModal onClose={() => setAbout(false)} />}
    </div>
  );
}
