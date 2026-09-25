import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB } from './db.ts';
import { type AnyRoom, isMj, Lobby } from './lobby.ts';
import { acceptUpgrade, WebSocketConn } from './ws.ts';
import { handleAdmin } from './admin.ts';
import { setAliKey, hasAliKey } from './alitts.ts';
import { handleAuth } from './auth.ts';
import { badWord, badWordMsg } from './badwords.ts';
import { json } from './util.ts';
import type { HostedRoom, ClientMsg, ServerMsg, ProfileView, PublicUser } from './protocol.ts';
import type { Room } from './room.ts';
import { MJ_VARIANT_ID } from './protocol.ts';

import { lookup as ipLookup, cachedLoc, seed as ipSeed } from './iploc.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.DB_PATH || resolve(__dirname, '../data/paohuzi.db');
const WEB_DIST = process.env.WEB_DIST || resolve(__dirname, '../../web/dist');
/* 自录语音包放**数据目录**，不放 web/dist —— 那儿是每次构建都会被覆盖的产物，
   录音属于数据，得跟数据库一起活着（升级、重新部署都不该丢）。 */
export const VOICE_DIR = process.env.VOICE_DIR || resolve(__dirname, '../data/voice');

/** 这些错是正常的人机对话（房间没了、积分不够……），日志里记一行就够，不用堆栈 */
const EXPECTED_ERRORS = ['房间不存在', '月卡', '最多同时开', '房间已满', '已经在座位上', '房间已解散', '房间已满', '密码不对', '积分不足', '没有开房权限', '不在房间', '牌局未进行', '场次不存在'];

const db = new DB(DB_PATH);
const lobby = new Lobby(db);

/** 构建号：web 产物的最后修改时间 */
function buildId(): string {
  let t = 0;
  for (const asset of ['main.js', 'styles.css', 'index.html']) {
    const ap = join(WEB_DIST, asset);
    if (existsSync(ap)) t = Math.max(t, Math.floor(statSync(ap).mtimeMs));
  }
  return String(t);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon',
  // 清单必须是这个类型：发成 octet-stream 的话 Safari 不当它是 Web App 清单，
  // "添加到主屏幕"就可能退回成普通书签（带地址栏那种）
  '.webmanifest': 'application/manifest+json', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  // 后台现场录的：安卓 Chrome 给 webm、火狐给 ogg（iOS 放不了这两种，所以只适合试听）
  '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.mp4': 'audio/mp4',
};

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

function publicUser(id: number): PublicUser | null {
  const u = db.getUser(id);
  /* 账号码只给本人（/api/me），别往公共视图里塞 —— 牌桌上别人一眼就看见了 */
  return u ? { id: u.id, nickname: u.nickname, avatar: u.avatar, kind: u.kind, vip: !!u.vip, points: u.points } : null;
}

function profile(id: number): ProfileView | null {
  const u = publicUser(id); if (!u) return null;
  const s = db.getStats(id);
  return {
    user: u, games: s.games, wins: s.wins, winRate: s.games ? Math.round(s.wins / s.games * 1000) / 10 : 0,
    hu: s.hu, zimo: s.zimo, dianpao: s.dianpao, ti: s.ti, pao: s.pao, violations: s.violations ?? 0,
    bigHu: s.bighu ?? 0, maxXi: s.max_xi ?? 0, maxMul: s.max_mul ?? 0,
    conduct: DB.conduct(s),
  };
}

const clientLogAt = new Map<string, number>();   // 客户端日志限流：来源 → 上次收到的时刻
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST' });
      return res.end();
    }
    if (url.pathname.startsWith('/api/auth/')) return handleAuth(db, url.pathname.slice('/api/auth/'.length), req, res, readBody);
    if (url.pathname.startsWith('/api/admin/')) return handleAdmin(db, lobby, url.pathname.slice('/api/admin/'.length), req, res, readBody, VOICE_DIR);
    if (url.pathname === '/api/me') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const u = token ? db.userByToken(token) : undefined;
      if (!u) return json(res, 401, { error: 'unauthorized' });
      const cur = db.getUser(u.id)!;
      const bind = db.getBindRequest(u.id);
      return json(res, 200, {
        // 账号码、改名次数、"有别的设备要登录"这几样只给本人
        user: {
          ...publicUser(u.id)!, code: (cur as any).code ?? '',
          nickLeft: Math.max(0, ((cur as any).nick_limit ?? 3) - ((cur as any).nick_changes ?? 0)),
        },
        profile: profile(u.id),
        bindReq: bind && !bind.approved ? { deviceId: bind.device_id, at: bind.created_at } : null,
      });
    }
    const m = url.pathname.match(/^\/api\/profile\/(-?\d+)$/);
    if (m) { const p = profile(Number(m[1])); return p ? json(res, 200, p) : json(res, 404, { error: 'not found' }); }
    // 战绩 / 回放：退出房间之后也能回看自己打过的局
    // 房主回看自己房间里的每一局
    if (url.pathname.startsWith('/api/room/') && url.pathname.endsWith('/rounds')) {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const u = token ? db.userByToken(token) : undefined;
      if (!u) return json(res, 401, { error: 'unauthorized' });
      const roomId = url.pathname.slice('/api/room/'.length, -'/rounds'.length);
      return json(res, 200, { rounds: db.roomRounds(roomId, u.id, 50) });
    }
    if (url.pathname === '/api/rounds' || url.pathname.startsWith('/api/round/')) {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const u = token ? db.userByToken(token) : undefined;
      if (!u) return json(res, 401, { error: 'unauthorized' });
      if (url.pathname === '/api/rounds') {
        const limit = Math.max(1, Math.min(DB.KEEP_ROUNDS, Number(url.searchParams.get('limit') ?? 200)));
        return json(res, 200, { rounds: db.myRounds(u.id, limit) });
      }
      const id = Number(url.pathname.slice('/api/round/'.length));
      const r = Number.isFinite(id) ? db.roundDetail(id, u.id) : null;
      return r ? json(res, 200, r) : json(res, 404, { error: 'not found' });
    }
    // 清空自己的复盘记录：只挪自己那条"从这儿往后看"的线，别人的记录不动
    if (url.pathname === '/api/rounds/clear' && req.method === 'POST') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const u = token ? db.userByToken(token) : undefined;
      if (!u) return json(res, 401, { error: 'unauthorized' });
      db.clearHistory(u.id);
      return json(res, 200, { ok: true });
    }
    /* 「我的房间」：有开房权限的人（VIP）在主页上管自己开的房间 ——
       看人头和积分牌、单独调读秒、清空数据、暂停 / 开始、解散。只认房主本人。 */
    if (url.pathname === '/api/myrooms' || url.pathname === '/api/myroom') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const u = token ? db.userByToken(token) : undefined;
      if (!u) return json(res, 401, { error: 'unauthorized' });
      const mine = () => [...lobby.rooms.values()].filter(r => r.cfg.hostId === u.id && r.status !== 'closed');
      const viewOf = (r: Room) => ({
        id: r.cfg.id, name: r.cfg.name ?? r.cfg.id, variant: r.cfg.variant, variantName: r.rules.name,
        baseScore: r.cfg.baseScore, status: r.status, paused: r.pausedReason, roundNo: r.roundNo,
        turnSec: r.cfg.turnSec ?? 20, autoNextSec: Math.round((r.cfg.autoNextMs ?? 7000) / 1000),
        swingCap: r.cfg.swingCap ?? 0, pauseEvery: r.cfg.pauseEvery ?? 0,
        players: r.seats.filter(s => s.userId !== null && !s.isBot).length,
        bots: r.seats.filter(s => s.isBot).length,
        seats: r.seats.map((s, i) => {
          const uid = s.userId;
          const st = uid === null ? undefined : r.roomStats.get(uid);
          // IP 只给真人看真人（机器人和空位没有）；归属地查过就有，没查着就空着
          const net = uid !== null && uid > 0 ? db.ipOf(uid) : { ip: '', loc: '', dev: '' };
          if (net.ip) { ipSeed(net.ip, net.loc); ipLookup(net.ip, (a, b) => db.setIpLoc(a, b)); }
          return {
            seat: i, name: uid === null ? null : (r.users.get(uid)?.nickname ?? null),
            isBot: s.isBot, online: s.isBot || !!s.client, auto: !!s.autoBot,
            total: uid === null ? 0 : (r.totals.get(uid) ?? 0),
            games: st?.games ?? 0, hu: st?.hu ?? 0, dianpao: st?.dianpao ?? 0,
            ip: net.ip, ipLoc: net.loc || cachedLoc(net.ip),
            // 设备指纹不给全的，只给前 8 位够比对就行（房主看的是"是不是同一台"，不是指纹本身）
            dev: net.dev ? String(net.dev).slice(0, 8) : '',
          };
        }),
        rounds: r.ledger.length,
      });
      if (url.pathname === '/api/myrooms') {
        const until = db.cardUntil(u.id);
        return json(res, 200, {
          canOpen: !!u.vip || !!(u as any).can_open_room,
          roomLimit: db.roomLimit(u.id),
          // 月卡：到期时间 + 还剩几天（快到期了页面上提前提醒续卡）
          cardUntil: until, cardLeft: Math.max(0, Math.ceil((until - Date.now()) / 86400000)),
          cardValid: !!u.vip || until > Date.now(),
          // 麻将房的后台详情还没做（roomStats 这些是跑胡子专属的），先只列跑胡子的
          rooms: mine().filter((r): r is Room => !isMj(r)).map(viewOf),
        });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'method' });
      const body = await readBody(req);
      const r = lobby.rooms.get(String(body.id));
      if (!r || r.status === 'closed') return json(res, 404, { error: '房间不存在' });
      if (r.cfg.hostId !== u.id) return json(res, 403, { error: '这不是你开的房间' });
      switch (String(body.action)) {
        case 'turnSec': r.setTurnSec(Number(body.value)); break;
        case 'rename': {
          const n = String(body.name ?? '').trim().slice(0, 12);
          // 房名桌上所有人都看得见，脏字照样拦（跟昵称一个规矩）
          const bad = n ? badWord(n) : null;
          if (bad) return json(res, 400, { error: badWordMsg(bad) });
          r.setName(n);
          break;
        }
        case 'pause': r.hostPause(); break;
        case 'start': r.hostStart(); break;
        case 'clear': r.clearData(); break;
        case 'close': r.close(true); break;
        default: return json(res, 400, { error: '不认识的操作' });
      }
      // 麻将房没有跑胡子那套后台详情，回个精简的就行
      if (isMj(r)) return json(res, 200, { ok: true, room: r.status === 'closed' ? null : { id: r.cfg.id, name: r.cfg.name ?? r.cfg.id, status: r.status, rounds: r.ledger.length } });
      return json(res, 200, { ok: true, room: (r.status as string) === 'closed' ? null : viewOf(r) });
    }
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, rooms: lobby.rooms.size });
    // 自录方言语音包清单：客户端一次问清楚有哪些录音，不用逐个探测
    if (url.pathname === '/api/voice') {
      /* 直接把"哪一条播哪个地址"算好给客户端，省得它自己拼路径（格式、玩法都可能不一样）。
         叠三层，后面的盖前面的：随包带的 → 后台传的通用 → 后台传的**这个玩法专属**。 */
      /* 直接把"哪一条播哪个地址"算好给客户端，省得它自己拼路径（格式各异）。
         叠三层，后面盖前面：随包带的 → 内置那一套 → 玩家挑的那一套。
         `p` = 玩家挑的套（空 = 跟这个玩法的默认）；`v` = 玩法，用来查默认套。 */
      try {
        const EXTS = ['mp3', 'm4a', 'mp4', 'webm', 'ogg', 'wav'];
        const listPacks = () => {
          const out: { id: string; name: string; count: number }[] = [];
          const dir = join(VOICE_DIR, 'packs');
          if (existsSync(dir)) for (const d of readdirSync(dir)) {
            if (!/^[a-z0-9_-]{1,24}$/.test(d)) continue;
            const full = join(dir, d);
            try { if (!statSync(full).isDirectory()) continue; } catch { continue; }
            let name = d, count = 0;
            try { name = JSON.parse(readFileSync(join(full, 'pack.json'), 'utf8')).name || d; } catch { /* ignore */ }
            try { count = readdirSync(full).filter(f => EXTS.includes(f.split('.').pop()?.toLowerCase() ?? '')).length; } catch { /* ignore */ }
            if (count) out.push({ id: d, name, count });   // 一条都没录的套不用给玩家看
          }
          return out;
        };
        if (url.searchParams.get('packs') !== null) {
          return json(res, 200, { packs: listPacks(), byVariant: db.getSetting<Record<string, string>>('voicePacks', {}) });
        }
        const v = String(url.searchParams.get('v') ?? '');
        let pack = String(url.searchParams.get('p') ?? '');
        if (!pack && v) pack = db.getSetting<Record<string, string>>('voicePacks', {})[v] ?? '';
        /* 玩家选的是「跟这一桌」，后台又没给这个玩法指定默认套 —— 以前到这儿就两手空空，
           客户端拿不到任何录音，只能退回系统 TTS。表现就是"后台明明有一整套，桌上还是机器音"。
           现在这种情况自动用**录得最全的那一套**：装好一套就能听见，不必再去后台配一次。
           （后台真配了的话，配的说了算；玩家自己挑了的话，玩家说了算。） */
        let auto = false;
        if (!pack) {
          const ps = listPacks().sort((a, b) => b.count - a.count);
          if (ps.length) { pack = ps[0].id; auto = true; }
        }
        if (pack && !/^[a-z0-9_-]{1,24}$/.test(pack)) pack = '';
        /* 一条报牌可以有**好几个录法**：peng.mp3 / peng-2.mp3 / peng-3.mp3，
           播的时候随机挑一条，听着不那么机械。
           地址后面挂一个 `?v=<改动时间>`：后台重新生成之后地址就变了，
           客户端那边的缓存自然miss、会去拿新的 —— 不然文件换了、地址没变，
           浏览器和我们自己的解码缓存都还抱着旧的那一条不放。 */
        const takes: Record<string, string[]> = {};
        const scan = (dir: string, urlBase: string) => {
          if (!existsSync(dir)) return;
          const found: Record<string, { n: number; url: string }[]> = {};
          for (const f of readdirSync(dir)) {
            const i = f.lastIndexOf('.');
            if (i <= 0) continue;
            const ext = f.slice(i + 1).toLowerCase();
            if (!EXTS.includes(ext)) continue;
            const base = f.slice(0, i);
            const mm = base.match(/^(.+?)-(\d{1,2})$/);
            const key = mm ? mm[1] : base, n = mm ? Number(mm[2]) : 1;
            let v = 0;
            try { v = Math.round(statSync(join(dir, f)).mtimeMs); } catch { /* ignore */ }
            (found[key] ??= []).push({ n, url: `${urlBase}/${f}?v=${v}` });
          }
          // 这一层有这个 key，就把下面那一层的整组盖掉（别把两层的录法混着放）
          for (const k of Object.keys(found)) takes[k] = found[k].sort((a, b) => a.n - b.n).map(x => x.url);
        };
        scan(join(WEB_DIST, 'voice'), '/voice');
        scan(VOICE_DIR, '/voice');
        if (pack) scan(join(VOICE_DIR, 'packs', pack), `/voice/packs/${pack}`);
        const name = pack ? (listPacks().find(x => x.id === pack)?.name ?? pack) : '';
        // clips 只留第一条，给老版本的客户端垫底；新的走 takes
        const clips: Record<string, string> = {};
        for (const k of Object.keys(takes)) clips[k] = takes[k][0];
        return json(res, 200, { pack, packName: name, auto, clips, takes, keys: Object.keys(takes) });
      } catch { return json(res, 200, { clips: {}, keys: [] }); }
    }
    // 版本号：main.js / styles.css 的最后修改时间，客户端拿它判断要不要刷新
    if (url.pathname === '/api/version') return json(res, 200, { build: buildId() });
    /* 客户端"黑匣子"：手机上没法开控制台，出事时把报错和最近几十条动作送回来，
       直接打进服务端日志（本地 server/data/paohuzi.log，外服 /var/log/paohuzi.log）。
       搜 `[客户端]` 就能看到。限流：每个来源 10 秒最多一条。 */
    if (url.pathname === '/api/clientlog' && req.method === 'POST') {
      try {
        const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '?').split(',')[0].trim();
        const now = Date.now();
        if ((clientLogAt.get(ip) ?? 0) + 10000 > now) return json(res, 200, { ok: true });
        clientLogAt.set(ip, now);
        if (clientLogAt.size > 500) clientLogAt.clear();
        const b = await readBody(req) ?? {};
        console.error(`[客户端] ${b.kind ?? '?'} ${String(b.msg ?? '').slice(0, 400)}`
          + `\n         来源 ${ip} ${b.standalone ? '桌面App' : '浏览器'} ${String(b.ua ?? '').slice(0, 120)}`
          + `\n         最近动作：\n           ${(Array.isArray(b.tail) ? b.tail : []).slice(-40).join('\n           ')}`);
      } catch { /* 日志而已，坏了就算了 */ }
      return json(res, 200, { ok: true });
    }
    // 静态文件（H5）
    // 后台管理页（跟游戏本体分开的一个静态页面）
    // /admin = 电脑上的完整后台；/m = 手机竖屏用的简版（同一套接口、同一个登录）
    const pathname = (url.pathname === '/admin' || url.pathname === '/admin/') ? '/admin.html'
      : (url.pathname === '/m' || url.pathname === '/m/' || url.pathname === '/admin/m') ? '/m.html'
      : url.pathname;
    /* 只许在 web/dist 里面找文件。
       以前是直接 join(WEB_DIST, 解码后的路径) —— `/voice/..%2F..%2Fpackage.json` 这种
       解出来是 `../../package.json`，join 完就跑到项目根上去了，
       package.json、连 server/data 里的库都能被读走。规范化之后核一遍在不在根目录里。 */
    const want = decodeURIComponent(pathname);
    const inside = (root: string, p: string) => {
      const f = resolve(root, '.' + (p.startsWith('/') ? p : `/${p}`));
      return f === root || f.startsWith(root + sep) ? f : null;
    };
    let file = inside(WEB_DIST, want);
    if (!file) { res.writeHead(404); return res.end('not found'); }
    /* 自录语音先看数据目录：后台传的那一份盖过随包带的。
       只认 /voice/<名字>.mp3 这一种形状，名字里不许有斜杠和点，免得被人拿去翻别的文件。 */
    const vm = want.match(/^\/voice\/(?:packs\/([a-z0-9_-]{1,24})\/)?([A-Za-z0-9_-]{1,40})\.(mp3|m4a|mp4|webm|ogg|wav)$/);
    if (vm) {
      const f = vm[1] ? join(VOICE_DIR, 'packs', vm[1], `${vm[2]}.${vm[3]}`) : join(VOICE_DIR, `${vm[2]}.${vm[3]}`);
      if (existsSync(f)) file = f;
    }
    const looksLikeAsset = /\.[a-z0-9]{2,5}$/i.test(pathname);
    if (!existsSync(file) || statSync(file).isDirectory()) {
      // 带扩展名的资源不存在就老实回 404；只有页面路由才回落到 index.html
      // （以前一律回 index.html，导致 /voice/xx.mp3 探测时"看起来存在"，白等一轮加载失败）
      if (looksLikeAsset) { res.writeHead(404); return res.end('not found'); }
      file = join(WEB_DIST, 'index.html');
    }
    if (!existsSync(file)) { res.writeHead(404); return res.end('web not built'); }
    // index.html 不缓存，并给 main.js / styles.css 加上按文件修改时间生成的版本号，更新后浏览器不用手动清缓存
    if (file.endsWith('index.html')) {
      let html = readFileSync(file, 'utf8');
      for (const asset of ['main.js', 'styles.css']) {
        const ap = join(WEB_DIST, asset);
        if (existsSync(ap)) html = html.replace(`"${asset}"`, `"${asset}?v=${Math.floor(statSync(ap).mtimeMs)}"`);
      }
      // 把本次构建号塞进页面：客户端拿它跟 /api/version 比，服务端更新了就自己刷新
      html = html.replace('<div id="root">', `<script>window.__BUILD__=${JSON.stringify(buildId())}</script><div id="root">`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      return res.end(html);
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(readFileSync(file));
  } catch (e: any) {
    console.error(e);
    json(res, 500, { error: e?.message ?? 'error' });
  }
});

// ---------- WebSocket ----------
interface Session { conn: WebSocketConn; userId: number | null; room: AnyRoom | null; superseded?: boolean; ip?: string }
const sessions = new Set<Session>();

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const conn = acceptUpgrade(req, socket as any);
  if (!conn) return;
  /* 来源 IP：过了 nginx 的话真实地址在 X-Forwarded-For 的第一段 */
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  const ip = (fwd || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const sess: Session = { conn, userId: null, room: null, superseded: false, ip };
  sessions.add(sess);
  const send = (msg: ServerMsg) => conn.sendJSON(msg);
  /* rtt：客户端每次 ping 都把上一轮量到的往返延迟捎上来（见下面的 'ping'）。
     服务端拿它给倒计时补"这条消息在路上走的那一截" —— 以前一概当 0 算。 */
  const client = { send, get userId() { return sess.userId ?? 0; }, rtt: 0 };

  conn.on('message', (data: string | Buffer, isBinary: boolean) => {
    if (isBinary) return;
    let msg: ClientMsg;
    try { msg = JSON.parse(data as string); } catch { return send({ type: 'error', message: 'bad json' }); }
    try { handle(msg); } catch (e: any) {
      const m = String(e?.message ?? 'error');
      /* 这几种是"说给玩家听的话"，不是程序出错：房间刚解散 / 已经散场，
         点进去看自然就没了。照样回给客户端，但别往日志里丢一串堆栈当事故看。 */
      if (EXPECTED_ERRORS.some(x => m.includes(x))) console.log(`[提示] user=${sess.userId ?? '?'} ${msg.type}: ${m}`);
      // 把是谁、在干什么一起打出来：journalctl -u paohuzi 里一眼能看出哪一步炸的
      else console.error(`[出错] user=${sess.userId ?? '?'} msg=${JSON.stringify(msg).slice(0, 300)}`, e);
      send({ type: 'error', message: m });
    }
  });
  conn.on('close', () => {
    sessions.delete(sess);
    // 同一账号换了新连接（重连）：这条旧连接不再代表玩家，不要把他踢出房间
    if (sess.superseded) return;
    if (sess.room && sess.userId !== null) {
      const room = sess.room;
      room.unspectate(sess.userId);
      /* 断线一律先给一段重连宽限，别当场把位子交出去。
         以前大厅是 `else room.leave(..., 'disconnect')` —— **socket 一断，立刻 isBot = true**。
         手机上锁个屏、切个后台、WiFi 跟 4G 一换手，WebSocket 就断一次，
         于是"人就离开了一小会，回来发现机器人在替我打"。
         宽限期内牌局照常往前走：没人应答就走超时那条路自动出牌，
         真不回来的话，一局里超时两次照样会转成托管（见 room.ts 的 misses）——
         所以这段宽限不会把桌子卡住，只是不再把"网络抖一下"当成"人跑了"。
         大厅给的比私人房短：大厅的位子还等着别人来坐。 */
      const grace = room.cfg.isPrivate ? 60000 : 25000;
      const seat = room.seats[room.seatOf(sess.userId)];
      if (seat) seat.client = null;
      room.broadcast();
      const uid = sess.userId;
      setTimeout(() => {
        const i = room.seatOf(uid);
        if (i < 0 || room.status === 'closed') return;
        const s = room.seats[i];
        if (s && !s.client) room.leave(uid, 'disconnect');   // 还没回来才真交出去
      }, grace);
    }
  });

  function requireUser() {
    if (sess.userId === null) throw new Error('未登录');
    const u = db.getUser(sess.userId);
    if (!u) throw new Error('用户不存在');
    return u;
  }

  function handle(msg: ClientMsg) {
    switch (msg.type) {
      /* ping / pong 量往返延迟，顺便给客户端校时：
         回 pong 时把**收到 ping 的那一刻**和客户端发出的时刻原样带回去，
         客户端就能按 NTP 那套算出 rtt 和时钟偏差（详见 web/src/net.ts）。
         客户端下一次 ping 会把量到的 rtt 捎上来，服务端存在这条连接上。 */
      case 'ping': {
        if (typeof msg.rtt === 'number' && msg.rtt >= 0 && msg.rtt < 10000) client.rtt = Math.round(msg.rtt);
        return send({ type: 'pong', t: msg.t, now: Date.now() });
      }
      case 'auth': {
        const u = db.userByToken(msg.token);
        if (!u) return send({ type: 'auth.fail', reason: '登录已失效' });
        if ((u as any).blocked) return send({ type: 'auth.fail', reason: '账号已被封禁，请联系管理员' });
        // 同一账号的旧连接下线
        for (const s of sessions) if (s !== sess && s.userId === u.id) { s.superseded = true; s.conn.close(); sessions.delete(s); }
        sess.userId = u.id;
        db.touchLogin(u.id);
        // 记下这个号是从哪儿进来的（房主在「我的房间」里看得到；查归属地是后台慢慢查的事）
        if (sess.ip) { db.touchIp(u.id, sess.ip); ipLookup(sess.ip, (a, b) => db.setIpLoc(a, b)); }
        // 这次是从哪台机器进来的：一台手机换号登录，这个比 IP 靠谱
        if ((msg as any).deviceId) db.touchDevice(u.id, String((msg as any).deviceId));
        send({ type: 'auth.ok', user: publicUser(u.id)! });
        /* 恢复房间：只把他送回**正在打的那一局**（断线重连接着打就是这个）。
           空着等人的桌子不算 —— 开好房坐下、切出去一下就被锁在自己那一桌上，
           点大厅别的桌子都回不去，就是这么来的。这种座位顺手让出去，别占着。 */
        for (const r of lobby.rooms.values()) {
          if (r.status === 'closed' || r.seatOf(u.id) < 0) continue;
          if (r.resumable(u.id)) { sess.room = r; r.join(u, client); break; }
          r.leave(u.id, 'disconnect');   // 没在打的那一桌：位子还给桌上
        }
        if (sess.room) send({ type: 'room.state', room: sess.room.view(u.id) });
        else send({ type: 'room.left' });
        return;
      }
      case 'lobby.tables': {
        const uid = sess.userId;
        const back = uid === null ? undefined : [...lobby.rooms.values()].find(r => r.resumable(uid));
        const mine = uid === null ? [] : [...lobby.rooms.values()].filter(r => r.cfg.isPrivate && r.cfg.hostId === uid && r.status !== 'closed')
          .map((r): HostedRoom => ({ id: r.cfg.id, name: r.cfg.name ?? `房 ${r.cfg.id}`,
            variant: isMj(r) ? MJ_VARIANT_ID : r.cfg.variant, status: r.status,
            players: r.seats.filter(x => x.userId !== null).length, seats: r.seats.length, seated: r.seatOf(uid) >= 0 }));
        return send({ type: 'lobby.tables', variants: lobby.tables(uid), resume: back?.cfg.id, hosted: mine });
      }
      case 'room.bots': {
        const u = requireUser();
        if (!sess.room || sess.room.seatOf(u.id) < 0) throw new Error('先坐到桌上');
        const err = sess.room.bots(msg.add, (msg as any).seat); if (err) throw new Error(err);
        return;
      }
      case 'room.kick': {
        const u = requireUser();
        if (!sess.room) throw new Error('不在房间');
        const err = sess.room.kick(u.id, msg.seat); if (err) throw new Error(err);
        return;
      }
      case 'lobby.list': {
        // resume：他中途退出、正由机器人托管的那一桌，前端可以给个"返回牌局"
        const uid = sess.userId;
        const back = uid === null ? undefined : [...lobby.rooms.values()].find(r => r.resumable(uid));
        return send({ type: 'lobby.list', tiers: lobby.tiers(), resume: back?.cfg.id });
      }
      case 'lobby.join': {
        const u = requireUser();
        if (sess.room) { sess.room.leave(u.id); sess.room = null; }
        const tier = lobby.tiers().find(t => t.id === msg.tier);
        if (!tier) throw new Error('场次不存在');
        if (u.points < tier.minPoints) throw new Error(`积分不足，需 ${tier.minPoints} 分`);
        if (u.points < tier.baseScore * 10) throw new Error('积分不足以进入该场次');
        // 中途退出、机器人还在替他打的那一桌，优先回去接着打
        // 只有正在打的那一局才把他拽回去；空着等人的桌子不算（见 Room.resumable）
        const back = [...lobby.rooms.values()].find(r => r.resumable(u.id));
        const room = back ?? lobby.quickJoin(msg.tier)!;
        const err = room.join(u, client); if (err) throw new Error(err);
        sess.room = room; return;
      }
      case 'room.create': {
        const u = requireUser();
        if (!u.vip && !u.can_open_room) throw new Error('没有开房权限');
        /* 开房权限是永久的，月卡是会到期的那一半：卡过期了就开不了新房
           （已经开着的房不受影响，让人把这一场打完）。vip 不看卡。 */
        if (!u.vip && !db.cardValid(u.id)) throw new Error('开房月卡已到期，续卡之后才能开房');
        /* VIP的开房上限：同时开着的房间不能超过这个数（0 = 不限）。
           已经解散 / 关掉的不算 —— 只数现在还挂着的。 */
        const lim = db.roomLimit(u.id);
        if (lim > 0) {
          const mine = [...lobby.rooms.values()].filter(r => r.cfg.hostId === u.id && r.status !== 'closed').length;
          if (mine >= lim) throw new Error(`你最多同时开 ${lim} 个房间，先把旧的结算掉`);
        }
        // 房号本来就是唯一的 6 位数，进房只认房号，密码可有可无（留着兼容）
        const pass = msg.password ? String(msg.password) : '';
        if (sess.room) { sess.room.leave(u.id); sess.room = null; }
        const turnMs = msg.turnMs ? Math.max(10000, Math.min(120000, Math.floor(msg.turnMs))) : undefined;
        const autoNextMs = msg.autoNextSec ? Math.max(3000, Math.min(120000, Math.floor(msg.autoNextSec * 1000))) : undefined;
        const swingCap = msg.swingCap ? Math.max(0, Math.min(1000000, Math.floor(msg.swingCap))) : 0;
        const pauseEvery = msg.pauseEvery ? Math.max(0, Math.min(999, Math.floor(msg.pauseEvery))) : 0;
        const name = (msg.name ?? '').trim().slice(0, 16) || undefined;
        /* 玩法开关：只认这几个字段，值只认真假 / 两种发牌。客户端乱传的一概丢掉 */
        const pm = (msg as any).play ?? {};
        const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
        const play = {
          noXiHu: bool(pm.noXiHu), raiseHand: bool(pm.raiseHand),
          redBlack: bool(pm.redBlack), huCardDun: bool(pm.huCardDun),
          deal: pm.deal === 'big' ? 'big' as const : pm.deal === 'fresh' ? 'fresh' as const : undefined,
        };
        const base = Math.max(1, Math.min(1000, Math.floor(msg.baseScore || 1)));
        const room = msg.game === 'mahjong'
          ? lobby.createMahjong(u.id, base, pass, {
              name, autoNextMs,
              turnSec: turnMs ? Math.round(turnMs / 1000) : undefined,
              // 抢牌（碰 / 杠）给出牌读秒的一半，跟跑胡子"快碰慢吃"一个思路
              claimSec: turnMs ? Math.max(5, Math.round(turnMs / 2000)) : undefined,
            })
          : lobby.createPrivate(u.id, msg.variant, base, pass,
              { turnMs, name, autoNextMs, swingCap, pauseEvery, play });
        /* 开好就完事，不自动把房主拽进牌桌 —— 他多半还要接着开下一间，
           或者回「我的房间」看一眼。想打就自己点「进去打」，跟别的玩家一样入座。 */
        send({ type: 'room.created', roomId: room.cfg.id, name: room.cfg.name ?? room.cfg.id });
        return;
      }
      case 'room.join': {
        const u = requireUser();
        const room = lobby.rooms.get(msg.roomId);
        if (!room) throw new Error('房间不存在');
        if (sess.room && sess.room !== room) { sess.room.leave(u.id); sess.room = null; }
        const err = room.join(u, client, msg.password); if (err) throw new Error(err);
        sess.room = room; return;
      }
      case 'room.spectate': {
        const u = requireUser();
        const room = lobby.rooms.get(msg.roomId);
        if (!room) throw new Error('房间不存在');
        if (sess.room && sess.room !== room) { sess.room.leave(u.id); sess.room.unspectate(u.id); sess.room = null; }
        const err = room.spectate(u, client); if (err) throw new Error(err);
        sess.room = room; return;
      }
      case 'room.resume': {
        const u = requireUser();
        if (!sess.room) throw new Error('不在房间');
        const err = sess.room.hostResume(u.id); if (err) throw new Error(err);
        return;
      }
      case 'room.abort': {
        const u = requireUser();
        if (!sess.room) throw new Error('不在房间');
        const err = sess.room.abortRound(u.id); if (err) throw new Error(err);
        return;
      }
      case 'room.leave': {
        if (sess.room && sess.userId !== null) {
          sess.room.unspectate(sess.userId);
          sess.room.leave(sess.userId, msg.stand ? 'stand' : 'leave');
          sess.room = null;
        }
        return send({ type: 'room.left' });
      }
      case 'room.ready': { if (sess.room && sess.userId !== null) sess.room.setReady(sess.userId, msg.ready); return; }
      case 'room.start': {
        if (!sess.room) throw new Error('不在房间');
        const err = sess.room.start(sess.userId!); if (err) throw new Error(err); return;
      }
      case 'room.end': {
        if (!sess.room) throw new Error('不在房间');
        if (sess.room.cfg.hostId !== sess.userId) throw new Error('只有房主可以结束');
        sess.room.close(true); sess.room = null; return;
      }
      case 'room.state': { if (sess.room && sess.userId !== null) send({ type: 'room.state', room: sess.room.view(sess.userId) }); return; }
      case 'game.act': {
        if (!sess.room || sess.userId === null) { send({ type: 'room.left' }); return send({ type: 'error', message: '已不在房间，已返回大厅' }); }
        /* 两种玩法的动作参数不一样：跑胡子是 card/combo/lay，麻将是 tile。
           客户端那边发的字段名也各发各的，这儿按房间类型分流就行。 */
        const err = isMj(sess.room)
          ? sess.room.act(sess.userId, msg.action as any, { tile: (msg as any).tile ?? msg.card })
          : sess.room.act(sess.userId, msg.action, { card: msg.card, combo: msg.combo, lay: msg.lay });
        if (err) send({ type: 'error', message: err });
        return;
      }
      case 'seat.wake': {
        if (sess.room && sess.userId !== null) sess.room.wake(sess.userId);
        return;
      }
      case 'chat': {
        const u = requireUser(); if (!sess.room) return;
        const text = String(msg.text ?? '').slice(0, 200);
        if (isMj(sess.room)) return;   // 麻将房的聊天还没做
        sess.room.chat(publicUser(u.id)!, { type: 'chat', from: publicUser(u.id)!, text, time: Date.now() }); return;
      }
      case 'voice': {
        const u = requireUser(); if (!sess.room) return;
        if (typeof msg.data !== 'string' || msg.data.length > 600000) throw new Error('语音过长');
        if (isMj(sess.room)) return;   // 同上
        sess.room.chat(publicUser(u.id)!, { type: 'voice', from: publicUser(u.id)!, data: msg.data, mime: msg.mime, durationMs: msg.durationMs }); return;
      }
      case 'profile.get': {
        const p = msg.userId < 0 ? botProfile(msg.userId, sess.room && !isMj(sess.room) ? sess.room : null) : profile(msg.userId);
        if (p) send({ type: 'profile', profile: p }); else send({ type: 'error', message: '用户不存在' });
        return;
      }
    }
  }
});

function botProfile(id: number, room: Room | null): ProfileView | null {
  const u = room?.users.get(id); if (!u) return null;
  const games = 300 + Math.abs(id) % 500; const wins = Math.round(games * (0.3 + (Math.abs(id) % 13) / 100));
  return { user: u, games, wins, winRate: Math.round(wins / games * 1000) / 10, hu: wins, zimo: Math.round(wins * 0.4), dianpao: Math.round(games * 0.2), ti: Math.round(games * 0.1), pao: Math.round(games * 0.15), violations: 0, bigHu: Math.round(wins * 0.2), maxXi: 20 + Math.abs(id) % 40, maxMul: 1 + Math.abs(id) % 5, conduct: 100 };
}

setInterval(() => lobby.tick(), 50);   // 50ms：帧播放的粒度
setInterval(() => { for (const s of sessions) s.conn.ping(); }, 30000);

// 后台管理员账号：用户名 admin，密码取 ADMIN_PASSWORD（默认 admin8888，第一次启动时建）
// 没接住的异常 / Promise 拒绝：记下来就好，服务不退出（systemd 重启会把所有房间都断掉）
process.on('uncaughtException', e => console.error('[未捕获异常]', e));
process.on('unhandledRejection', e => console.error('[未处理的 Promise 拒绝]', e));

/* 用 || 不用 ?? —— docker 的 env_file 里写一行 `ADMIN_PASSWORD=` 传进来的是**空串**，
   ?? 不会兜底，后台密码就成了空的（比 admin8888 还糟）。环境变量空＝没设。 */
const adminInfo = db.ensureAdmin('admin', process.env.ADMIN_PASSWORD || 'admin8888');

/* 百炼（阿里云）的 API Key：后台填过就存在数据库里，开机装回内存。
   环境变量 DASHSCOPE_API_KEY 优先级更高（alitts.ts 里先看它）。
   报牌声就靠这一条 —— 服务器在国内，微软和谷歌那两个域名都出不去。 */
setAliKey(db.getSetting<string>('aliKey', ''));

server.listen(PORT, () => {
  console.log(`衡之娱服务端 http://localhost:${PORT}  (web: ${WEB_DIST})`);
  console.log(`后台管理 http://localhost:${PORT}/admin  账号 ${adminInfo.username}`
    + (adminInfo.created ? `，初始密码 ${process.env.ADMIN_PASSWORD || 'admin8888'}（请尽快改）` : ''));
  console.log(`报牌声在线合成：${hasAliKey() ? '百炼已配好' : '百炼还没配 Key（后台语音页填，或 DASHSCOPE_API_KEY 环境变量）'}`);
});
