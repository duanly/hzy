/** 后台管理接口：/api/admin/*（全部要管理员 token） */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readdirSync, writeFileSync, unlinkSync, statSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DB } from './db.ts';
import type { Lobby } from './lobby.ts';
import { isMj } from './lobby.ts';
import type { Room } from './room.ts';
/* 微软 Edge 和谷歌那两条**暂时摘掉了**：服务器搬到国内之后，
   speech.platform.bing.com 和 translate.google.com 都出不去，选了也只会报错，
   留在单子里反而害人点。edgetts.ts / gtts.ts 两个文件照旧留着、没删 ——
   哪天服务器能出网了（或者挂上代理），把下面这两行 import 解开、
   再把 voices 那一段和 one() 里的分支接回去就行，实现本身一直是好的。
import { EDGE_VOICES, edgeTTS, isEdgeVoice } from './edgetts.ts';
import { GOOGLE_VOICES, googleTTS, isGoogleVoice, isAutoVoice } from './gtts.ts'; */
import { ALI_VOICES, ALI_LANGS, aliTTS, aliTranslate, isAliVoice, isAliLang, setAliKey, hasAliKey } from './alitts.ts';

/* 自录语音包：文件名就是播报用的 key（peng / chi / hu / s1 / b10 …）。
   只认这张白名单 —— 不然随便传个名字进来，等于让人往服务器上写任意文件。 */
const VOICE_KEYS = [
  'start', 'peng', 'chi', 'pao', 'ti', 'long', 'wei', 'hu', 'zimo', 'pass', 'foul', 'liuju', 'your_turn', 'can_hu', 'yang',
  ...Array.from({ length: 10 }, (_, i) => `s${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `b${i + 1}`),
];
/* 念什么以**牌桌上真正报的那一句**为准（见 web/src/voice.ts 的 ACTION_WORDS）——
   偎在衡阳叫「笑起」，提龙（不管是 ti 还是 long）都报「提龙」。
   有两句是**拼出来的**，各录一个词就行，客户端会连着放：
     「提龙，大玖」= ti / long + 牌名；「阳张 大叁」= yang + 牌名。
   所以 `yang` 只录「阳张」两个字，后面那张牌走 s1…b10 那二十条。 */
const VOICE_LABEL: Record<string, string> = {
  start: '开始', peng: '碰', chi: '吃', pao: '开跑', ti: '提龙', long: '提龙', wei: '笑起',
  hu: '胡了', zimo: '自摸，胡了', pass: '过', foul: '违规', liuju: '黄庄',
  your_turn: '该你出牌', can_hu: '可以胡了', yang: '阳张',
};
for (let i = 1; i <= 10; i++) { VOICE_LABEL[`s${i}`] = `小${'一二三四五六七八九十'[i - 1]}`; VOICE_LABEL[`b${i}`] = `大${'壹贰叁肆伍陆柒捌玖拾'[i - 1]}`; }

/** 语音包认的格式：mp3 最通用；m4a 是 iOS 录出来的；webm / ogg 是安卓 Chrome 录的（iOS 放不了） */
export const VOICE_EXTS = ['mp3', 'm4a', 'mp4', 'webm', 'ogg', 'wav'];
/** 可以单独指定默认声音的玩法 */
export const VOICE_VARIANTS = ['hy_honghei', 'hy_liuhuqiang', 'ly_tilong'];
const VARIANT_CN: Record<string, string> = { hy_honghei: '衡阳红黑', hy_liuhuqiang: '衡阳六胡抢', ly_tilong: '耒阳提龙' };

/* ---- 声音包 ----
   一套声音就是一个目录：data/voice/packs/<id>/，里头是 peng.mp3 / wei.m4a 这些，
   外加一个 pack.json 记着这套叫什么名字。玩家在设置里像挑字体一样挑一套；
   后台还能给每个玩法指定一个默认套（玩家没挑的时候用它）。
   根目录 data/voice/ 那一套是**内置**的（id 为空），当"默认"用。 */
const PACK_ID = /^[a-z0-9_-]{1,24}$/;
function packDir(root: string, id: string) { return id ? join(root, 'packs', id) : root; }
/** 有哪些套：内置那一套 + packs/ 下每个目录 */
function listPacks(root: string) {
  const out: { id: string; name: string; count: number }[] = [
    { id: '', name: '默认（内置）', count: voiceFiles(root).size },
  ];
  const dir = join(root, 'packs');
  if (existsSync(dir)) for (const d of readdirSync(dir)) {
    if (!PACK_ID.test(d)) continue;
    const full = join(dir, d);
    try { if (!statSync(full).isDirectory()) continue; } catch { continue; }
    let name = d;
    try { name = JSON.parse(readFileSync(join(full, 'pack.json'), 'utf8')).name || d; } catch { /* 没名字就用目录名 */ }
    out.push({ id: d, name, count: voiceFiles(full).size });
  }
  return out;
}
/** 目录里每个 key 现在是什么格式、多大 */
/* 一条报牌可以有好几个录法：peng.mp3 / peng-2.mp3 / peng-3.mp3 —— 都归到 peng 名下，
   播的时候随机挑一条。第一条（不带编号的）当代表，size 报的是它，takes 是一共几条。 */
const TAKES = 3;                 // 一条最多几个录法
function voiceFiles(dir: string) {
  const m = new Map<string, { ext: string; size: number; takes: number }>();
  if (!existsSync(dir)) return m;
  for (const f of readdirSync(dir)) {
    const i = f.lastIndexOf('.');
    if (i <= 0) continue;
    const base = f.slice(0, i), ext = f.slice(i + 1).toLowerCase();
    if (!VOICE_EXTS.includes(ext)) continue;
    const mm = base.match(/^(.+?)-(\d{1,2})$/);
    const key = mm ? mm[1] : base;
    const cur = m.get(key);
    try {
      const size = statSync(join(dir, f)).size;
      if (!mm) m.set(key, { ext, size, takes: (cur?.takes ?? 0) + 1 });
      else m.set(key, { ext: cur?.ext ?? ext, size: cur?.size ?? size, takes: (cur?.takes ?? 0) + 1 });
    } catch { /* ignore */ }
  }
  return m;
}
/** 把这一条的所有格式、所有录法都删掉（换格式 / 重新生成时用） */
function dropVoice(dir: string, key: string) {
  for (const e of VOICE_EXTS) {
    try { unlinkSync(join(dir, `${key}.${e}`)); } catch { /* 本来就没有 */ }
    for (let n = 2; n <= 9; n++) { try { unlinkSync(join(dir, `${key}-${n}.${e}`)); } catch { /* 本来就没有 */ } }
  }
}
/** 这段音频该存成什么后缀：先看浏览器给的 mime，再看原文件名，最后嗅一下头几个字节 */
function voiceExt(mime: string, name: string, buf: Buffer): string {
  const m = mime.toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('m4a') || m.includes('mp4') || m.includes('aac')) return 'm4a';
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  const byName = name.toLowerCase().split('.').pop() ?? '';
  if (VOICE_EXTS.includes(byName)) return byName === 'mp4' ? 'm4a' : byName;
  const head = buf.subarray(0, 12);
  if (head[0] === 0x1a && head[1] === 0x45) return 'webm';                       // EBML
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') return 'm4a';
  if (head.subarray(0, 4).toString('latin1') === 'OggS') return 'ogg';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF') return 'wav';
  return 'mp3';
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

export async function handleAdmin(
  db: DB, lobby: Lobby, path: string, req: IncomingMessage, res: ServerResponse,
  readBody: (r: IncomingMessage) => Promise<any>,
  voiceDir = '',
) {
  const url = new URL(req.url ?? '/', 'http://x');

  // 登录：用管理员账号的用户名密码换一个 token
  if (path === 'login') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    const b = await readBody(req);
    const u = db.getUserByName(String(b.username ?? ''));
    if (!u || !u.password_hash || !DB.verifyPassword(String(b.password ?? ''), u.password_hash)) return json(res, 401, { error: '用户名或密码错误' });
    if (!db.isAdmin(u.id)) return json(res, 403, { error: '这个账号不是管理员' });
    db.touchLogin(u.id);
    return json(res, 200, { token: db.createToken(u.id), user: { id: u.id, nickname: u.nickname } });
  }

  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const me = token ? db.userByToken(token) : undefined;
  if (!me || !db.isAdmin(me.id)) return json(res, 401, { error: 'unauthorized' });
  const body = req.method === 'POST' ? await readBody(req) : {};

  switch (path) {
    case 'overview': {
      // 后台这一版的统计和房间列表都是照跑胡子写的（fixed / variant / swingCap 这些字段）。
      // 麻将房先不在这儿露面，等后台单独做一页再说。
      const rooms = [...lobby.rooms.values()].filter((r): r is Room => !isMj(r));
      const online = new Set<number>();
      for (const r of rooms) for (const s of r.seats) if (s.client && s.userId && s.userId > 0) online.add(s.userId);
      const dayAgo = Date.now() - 86400000;
      const rounds24 = db.adminRounds({ limit: 200 }).filter(r => r.time >= dayAgo).length;
      return json(res, 200, {
        me: { id: me.id, nickname: me.nickname },
        online: online.size,
        playing: rooms.filter(r => r.status === 'playing').length,
        tables: rooms.filter(r => r.cfg.fixed).length,
        privateRooms: rooms.filter(r => r.cfg.isPrivate).length,
        rounds24,
        users: db.adminUsers({ limit: 1 }).total,
      });
    }
    case 'users':
      return json(res, 200, db.adminUsers({
        q: url.searchParams.get('q') ?? undefined,
        groupId: url.searchParams.get('group') ? Number(url.searchParams.get('group')) : null,
        limit: Number(url.searchParams.get('limit') ?? 50),
        offset: Number(url.searchParams.get('offset') ?? 0),
      }));
    case 'user': {
      if (req.method !== 'POST') return json(res, 405, { error: 'method' });
      const id = Number(body.id);
      const u = db.getUser(id);
      if (!u) return json(res, 404, { error: '玩家不存在' });
      if (body.canOpenRoom !== undefined) {
        db.setCanOpenRoom(id, !!body.canOpenRoom);
        // 给了开房权限就顺手放进「VIP」分组，好分开管；收回权限时人留在组里（看得到"停用的VIP"）
        if (body.canOpenRoom) {
          db.setGroup(id, db.agentGroupId());
          if (!db.cardUntil(id)) db.renewCard(id, 1);   // 头一回给权限，顺手送一个月卡，不用再点一次
        }
      }
      if (body.roomLimit !== undefined) db.setRoomLimit(id, Number(body.roomLimit));
      // 月卡：续一个月（renewCard: 2 就是两个月）；stopCard 直接停掉
      if (body.renewCard) db.renewCard(id, Number(body.renewCard) || 1);
      if (body.stopCard) db.clearCard(id);
      if (body.blocked !== undefined) db.setBlocked(id, !!body.blocked);
      if (body.role !== undefined) db.setRole(id, body.role === 'admin' ? 'admin' : 'player');
      if (body.groupId !== undefined) db.setGroup(id, body.groupId === null ? null : Number(body.groupId));
      // 后台改昵称：不算在玩家那 3 次里
      if (body.nickname) db.updateNickname(id, Array.from(String(body.nickname).trim()).slice(0, 4).join(''));
      if (body.nickLimit !== undefined) db.setNickLimit(id, Number(body.nickLimit));
      if (body.resetNick) db.resetNickChanges(id);
      if (body.pointsDelta) {
        const d = Math.max(-1000000, Math.min(1000000, Math.floor(Number(body.pointsDelta))));
        if (d) db.addPoints(id, d, `后台调整（${me.nickname}）`);
      }
      return json(res, 200, { ok: true, user: db.adminUsers({ q: String(id), limit: 1 }).users[0] ?? null });
    }
    case 'groups':
      return json(res, 200, { groups: db.groups() });
    /* 审计：数据不对劲的人、钱总往一个方向走的组合。只提醒，不判罚 */
    case 'audit':
      return json(res, 200, db.audit({
        minGames: Number(url.searchParams.get('minGames') ?? 30),
        scanRounds: Number(url.searchParams.get('scan') ?? 4000),
      }));
    /* VIP：单独一张表管。列出每个VIP的开房上限、现在开着几个房，
       可以改上限、一键停用（收回开房权限，可选连他手上的房间一起解散）。 */
    case 'agents': {
      const open = new Map<number, number>();
      for (const r of lobby.rooms.values()) {
        const h = r.cfg.hostId;
        if (h && r.status !== 'closed') open.set(h, (open.get(h) ?? 0) + 1);
      }
      return json(res, 200, { agents: db.agents().map(a => ({ ...a, openRooms: open.get(a.id) ?? 0 })) });
    }
    case 'agent': {
      if (req.method !== 'POST') return json(res, 405, { error: 'method' });
      const id = Number(body.id);
      const u = db.getUser(id);
      if (!u) return json(res, 404, { error: '玩家不存在' });
      if (body.roomLimit !== undefined) db.setRoomLimit(id, Number(body.roomLimit));
      if (body.renewCard) db.renewCard(id, Number(body.renewCard) || 1);   // 续卡：一次一个月
      if (body.stopCard) db.clearCard(id);
      if (body.stop) {
        db.setCanOpenRoom(id, false);
        // 连他手上还开着的房间一起解散（结算照常走）
        if (body.closeRooms) {
          for (const r of [...lobby.rooms.values()]) {
            if (r.cfg.hostId === id && r.status !== 'closed') { try { r.close(true); } catch { /* 挨个来，别一个出错全断 */ } }
          }
        }
      }
      if (body.start) {
        db.setCanOpenRoom(id, true); db.setGroup(id, db.agentGroupId());
        if (!db.cardValid(id)) db.renewCard(id, 1);   // 设成 / 恢复VIP：没卡或卡过期了，顺手给一个月
      }
      return json(res, 200, { ok: true, cardUntil: db.cardUntil(id) });
    }
    case 'group': {
      if (req.method !== 'POST') return json(res, 405, { error: 'method' });
      if (body.delete) { db.deleteGroup(Number(body.id)); return json(res, 200, { ok: true, groups: db.groups() }); }
      const name = String(body.name ?? '').trim().slice(0, 16);
      if (!name) return json(res, 400, { error: '分组名不能为空' });
      if (body.id) db.renameGroup(Number(body.id), name); else db.addGroup(name);
      return json(res, 200, { ok: true, groups: db.groups() });
    }
    case 'tables': {
      if (req.method === 'POST') return json(res, 200, { tables: lobby.saveTableConfig(body.tables ?? []) });
      return json(res, 200, { tables: lobby.tableConfig() });
    }
    case 'rooms': {
      const rooms = [...lobby.rooms.values()].filter((r): r is Room => !isMj(r)).map(r => ({
        id: r.cfg.id, name: r.cfg.name ?? r.cfg.id, isPrivate: r.cfg.isPrivate, fixed: !!r.cfg.fixed,
        variant: r.cfg.variant, baseScore: r.cfg.baseScore, status: r.status, roundNo: r.roundNo,
        hostId: r.cfg.hostId ?? null, pausedReason: r.pausedReason,
        turnSec: r.cfg.turnSec ?? 20, autoNextSec: Math.round((r.cfg.autoNextMs ?? 7000) / 1000), swingCap: r.cfg.swingCap ?? 0,
        botThink: !!r.cfg.botThink, pauseEvery: r.cfg.pauseEvery ?? 0,
        players: r.seats.filter(s => s.userId !== null && !s.isBot).length,
        bots: r.seats.filter(s => s.isBot).length,
        seats: r.seats.map(s => ({ userId: s.userId, isBot: s.isBot, name: s.userId === null ? null : (r.users.get(s.userId)?.nickname ?? null) })),
      }));
      return json(res, 200, { rooms });
    }
    case 'room': {   // 后台操作房间：解散 / 暂停 / 继续 / 读秒 / 清空这一桌的账 / 机器人节奏
      if (req.method !== 'POST') return json(res, 405, { error: 'method' });
      const r = lobby.rooms.get(String(body.id));
      if (!r) return json(res, 404, { error: '房间不存在' });
      if (body.action === 'resume') { r.pausedReason = null; r.broadcast(); }
      if (body.action === 'close') { r.close(isMj(r) ? true : !r.cfg.fixed); }
      /* 跟房主管自己私人房的那一套对齐：大厅的固定桌在后台也能调读秒、暂停 / 开始、清空这一桌的账。
         读秒是"单桌临时扳一下"，分组配置重建时会跟回「牌桌配置」里的设置。 */
      if (body.action === 'turnSec') r.setTurnSec(Number(body.value));
      if (body.action === 'pause') r.hostPause('后台暂停了牌局');
      if (body.action === 'start') r.hostStart();
      if (body.action === 'clear') r.clearData();
      // 机器人节奏：单桌临时扳一下（固定桌按分组配置重建时会跟回分组设置）
      if (body.action === 'botThink') { r.cfg.botThink = !!body.value; r.broadcast(); }
      // 几局一歇：单桌临时扳一下（固定桌按分组配置重建时会跟回分组设置）
      // 「几局一歇」是跑胡子那套的配置，麻将房还没有
      if (body.action === 'pauseEvery' && !isMj(r)) { r.cfg.pauseEvery = Math.max(0, Math.min(999, Math.floor(Number(body.value) || 0))); r.broadcast(); }
      return json(res, 200, { ok: true });
    }
    /* 语音包：后台传 mp3，传了就优先放录音（没传的那条自动退回 TTS / 音效）。
       文件落在 data/voice/，跟数据库一起活着 —— 重新部署、覆盖 web/dist 都不会丢。 */
    case 'voice': {
      if (!voiceDir) return json(res, 500, { error: '没配语音目录' });
      const packId = String(body.pack ?? url.searchParams.get('pack') ?? '');
      if (packId && !PACK_ID.test(packId)) return json(res, 400, { error: '套名不对' });
      const dir = packDir(voiceDir, packId);
      /* 念什么可以自己改：比如「跑」听着太秃，改成「开跑」合出来就是"开跑"。
         改的只是**合成时念的那句话**，文件名 / key 一概不动（还是 pao.mp3），
         所以客户端那头什么都不用管 —— 它只认 key。
         按套分开存（不同套可以有不同叫法），内置那一套的 key 是空串。 */
      const texts = db.getSetting<Record<string, Record<string, string>>>('voiceText', {});
      const mine = texts[packId] ?? {};
      const sayOf = (k: string) => mine[k] || VOICE_LABEL[k] || k;
      /* 一条可以写**几种说法**，用 / 隔开：「碰 / 碰啦 / 我碰了」。
         生成时一句一条（peng.mp3 / peng-2.mp3 / peng-3.mp3），播的时候随机挑一条。 */
      const saysOf = (k: string) => sayOf(k).split(/[\/／|]/).map(t => t.trim()).filter(Boolean).slice(0, TAKES);
      /* 每一条**当初是照哪句话合成的**：改了念法之后，「生成缺的」要认得出这一条过时了。
         只记合成出来的那些；人工录的 / 传的不在这里头，所以永远不会被自动覆盖掉。 */
      const mades = db.getSetting<Record<string, Record<string, string>>>('voiceMade', {});
      const made = mades[packId] ?? {};
      /* 这一套的念法现在是哪门语言。翻译过就记下来，没翻过就是中文。
         为什么要**记**而不是看文本猜：日语里全是汉字，按"有没有汉字"去猜，
         翻成日语之后会被当成还是中文，再翻一次就成了日译英 —— 而 source_lang
         这边一直按中文发过去，翻出来是什么样没人知道。记一笔就没这些事了。 */
      const packLangs = db.getSetting<Record<string, string>>('voiceLang', {});
      const packLang = packLangs[packId] ?? 'Chinese';
      const stale = (k: string) => made[k] !== undefined && made[k] !== sayOf(k);
      if (req.method === 'GET') {
        const have = voiceFiles(dir);
        // 选了某一套时，也把"内置那一套有没有"带上，界面里好显示「跟默认」
        const base = packId ? voiceFiles(voiceDir) : have;
        return json(res, 200, {
          pack: packId,
          packs: listPacks(voiceDir),
          // 每个玩法默认用哪一套（玩家没自己挑的时候）
          byVariant: db.getSetting<Record<string, string>>('voicePacks', {}),
          variants: VOICE_VARIANTS.map(v => ({ id: v, name: VARIANT_CN[v] ?? v })),
          /* 在线合成能选的发音人。现在只有百炼这一家（见文件头上那段注释），
             48 个，带 group 字段，界面按组折起来。次序＝下拉框里的次序。 */
          voices: ALI_VOICES,
          langs: ALI_LANGS,
          lang: packLang,             // 这一套现在是哪门语言（界面上要回显）
          aliKey: hasAliKey(),        // 前端据此提示「还没填 Key」
          items: VOICE_KEYS.map(k => ({
            key: k, label: VOICE_LABEL[k] ?? k, say: sayOf(k), custom: !!mine[k], stale: stale(k),
            takes: have.get(k)?.takes ?? 0,
            size: have.get(k)?.size ?? 0, ext: have.get(k)?.ext ?? '',
            baseExt: packId ? (base.get(k)?.ext ?? '') : '',
          })),
        });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'method' });
      // 新建一套
      if (body.newPack) {
        const name = String(body.newPack).trim().slice(0, 16);
        if (!name) return json(res, 400, { error: '起个名字' });
        const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const d = join(voiceDir, 'packs', id);
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'pack.json'), JSON.stringify({ name }));
        return json(res, 200, { ok: true, id, name });
      }
      // 改名
      if (body.rename !== undefined) {
        if (!packId) return json(res, 400, { error: '内置那一套改不了名字' });
        const name = String(body.rename).trim().slice(0, 16);
        if (!name) return json(res, 400, { error: '起个名字' });
        writeFileSync(join(dir, 'pack.json'), JSON.stringify({ name }));
        return json(res, 200, { ok: true });
      }
      // 删整套
      if (body.dropPack) {
        const id = String(body.dropPack);
        if (!id || !PACK_ID.test(id)) return json(res, 400, { error: '内置那一套删不得' });
        try { rmSync(join(voiceDir, 'packs', id), { recursive: true, force: true }); } catch { /* ignore */ }
        // 哪个玩法指着它，就把那条指向清掉
        const map = db.getSetting<Record<string, string>>('voicePacks', {});
        for (const k of Object.keys(map)) if (map[k] === id) delete map[k];
        db.setSetting('voicePacks', map);
        return json(res, 200, { ok: true });
      }
      // 某个玩法默认用哪一套
      if (body.setVariant !== undefined) {
        const v = String(body.setVariant);
        if (!VOICE_VARIANTS.includes(v)) return json(res, 400, { error: '没有这个玩法' });
        const map = db.getSetting<Record<string, string>>('voicePacks', {});
        const to = String(body.usePack ?? '');
        if (to && !PACK_ID.test(to)) return json(res, 400, { error: '套名不对' });
        if (to) map[v] = to; else delete map[v];
        db.setSetting('voicePacks', map);
        return json(res, 200, { ok: true });
      }
      /* 百炼那把钥匙：存进数据库（重启还在），顺手装进内存里当场生效。
         留空＝清掉。前端只送不取 —— Key 从来不往回发，页面上只显示「配没配」。 */
      if (body.setAliKey !== undefined) {
        const k = String(body.setAliKey ?? '').trim().slice(0, 200);
        db.setSetting('aliKey', k);
        setAliKey(k);
        return json(res, 200, { ok: true, has: !!k });
      }
      /* 在线合成：服务端连一次微软 Edge 的「大声朗读」接口，把整套报牌声合成成 mp3 存下来。
         存完就是普通的语音包 —— 客户端照常拿 /voice/... 播，跟人工录的没有区别，
         也不会再碰在线服务（所以这一步只在后台点一次，玩家那头永远不联网合成）。 */
      if (body.gen) {
        const g = body.gen as { voice?: string; lang?: string; keys?: string[]; all?: boolean };
        const voice = String(g.voice ?? 'a:Cherry');
        if (!isAliVoice(voice)) return json(res, 400, { error: '发音人名字不对' });
        /* 语速 / 音调这两个参数没了：百炼那条接口压根不收（文档上只有 text / voice /
           language_type / stream 四个）。以前能调是因为走的微软那条。
           真要调，得换 qwen3-tts-instruct-flash、用它的 instructions 字段说"慢一点"，
           那是另一个模型、另一套行为，没验证过就先不上。 */
        /* 没明说就跟着这一套自己的语言走 —— 翻成英文之后直接点「生成」，
           不用再去下拉框里挑一次 English（挑错了念出来就是一团糟）。 */
        const lang = isAliLang(String(g.lang ?? '')) ? String(g.lang) : packLang;
        const have = voiceFiles(dir);
        // 默认只补缺的那几条；勾了「整套重做」才全部覆盖
        /* 「生成缺的」＝还没有的 + **念法改过、跟当初合成时不一样的那几条**。
           以前只看"文件在不在"，结果改完词一点「生成缺的」什么也不动 ——
           非得整套重做，把录好的人声也一起冲掉。 */
        let keys = Array.isArray(g.keys) && g.keys.length
          ? g.keys.map(String).filter(k => VOICE_KEYS.includes(k))
          : VOICE_KEYS.filter(k => g.all || !have.has(k) || stale(k));
        keys = keys.slice(0, VOICE_KEYS.length);
        if (!keys.length) return json(res, 200, { ok: true, saved: [], failed: [], note: '这一套已经齐了' });
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const saved: string[] = []; const failed: { key: string; why: string }[] = [];
        const used = new Set<string>();     // 「自动」时到底用上了哪一条，生成完告诉人一声
        for (const k of keys) {
          const says = saysOf(k);
          const text = says[0] ?? k;
          try {
            /* 只剩百炼这一条路了，没有备选也就没有"先试谁"的次序问题。
               回来的可能是 mp3（机器上有 ffmpeg）也可能是 wav，后面按实际格式存。 */
            const one = async (t: string): Promise<{ buf: Buffer; ext: string }> => {
              const a = await aliTTS(t, { voice, lang });
              used.add('百炼');
              return a;
            };
            const bufs: { buf: Buffer; ext: string }[] = [];
            for (const t of says) bufs.push(await one(t));
            dropVoice(dir, k);            // 旧的那几条（含别的格式、别的录法）先清干净
            /* 后缀照**实际格式**写：百炼回的是 WAV，机器上有 ffmpeg 才转得成 mp3。
               以前一律写 .mp3，格式一变文件就成了哑的。 */
            bufs.forEach((b, i) => writeFileSync(join(dir, `${i ? `${k}-${i + 1}` : k}.${b.ext}`), b.buf));
            made[k] = sayOf(k);           // 记下这一条是照哪句（哪几句）合的
            saved.push(k);
          } catch (e) {
            failed.push({ key: k, why: (e as Error).message });
            // 头一条就连不上，后面几十条一样连不上 —— 别让人对着转圈等一分钟
            if (saved.length === 0 && failed.length >= 2) break;
          }
        }
        if (saved.length) { mades[packId] = made; db.setSetting('voiceMade', mades); }
        return json(res, 200, { ok: true, saved, failed, voice, used: [...used].join(' + ') });
      }
      /* 这一条改成人工的了（自己录 / 自己传 / 删掉）：抹掉"合成记录"，
         往后「生成缺的」就不会再动它。 */
      const forget = (k: string) => {
        if (made[k] === undefined) return;
        delete made[k];
        if (Object.keys(made).length) mades[packId] = made; else delete mades[packId];
        db.setSetting('voiceMade', mades);
      };
      /* 把整套念法翻成某门语言：{ translate: { to: 'English' } }。
         翻完是**填回「念什么」那一栏**，不直接去合成 —— 牌桌上的吆喝是行话，
         机器翻出来不一定地道（「开跑」「提龙」这种尤其），得让人过一眼再生成。

         从哪句翻：当前那句里**还有汉字**就翻当前那句（照顾自己改过念法的人，
         「碰 / 碰啦 / 我碰了」这点味道能带过去）；已经是外语了就退回内置的中文原句翻 ——
         不然翻第二遍就成了英译英，越翻越歪。 */
      if (body.translate) {
        const to = String((body.translate as { to?: string }).to ?? '');
        if (!isAliLang(to)) return json(res, 400, { error: '不认识的语言' });
        if (to === 'Chinese') return json(res, 400, { error: '本来就是中文，不用翻' });
        if (!hasAliKey()) return json(res, 400, { error: '还没填百炼的 API Key' });
        const map = db.getSetting<Record<string, Record<string, string>>>('voiceText', {});
        const one = { ...(map[packId] ?? {}) };
        const done: { key: string; text: string }[] = [];
        const failed: { key: string; why: string }[] = [];
        for (const k of VOICE_KEYS) {
          /* 还是中文就翻当前这句（自己改过的念法，那点味道能带过去）；
             已经翻成别的语言了就退回内置的中文原句 —— 拿译文再翻一遍只会越翻越歪。 */
          const src = packLang === 'Chinese' ? sayOf(k) : (VOICE_LABEL[k] ?? k);
          try {
            /* 一条里可能有好几种说法（用 / 隔开），一句一句翻再拼回去 ——
               整串丢过去翻，分隔符经常被翻译模型吃掉或者挪位置。 */
            const parts: string[] = [];
            for (const t of src.split(/[\/／|]/).map(x => x.trim()).filter(Boolean).slice(0, TAKES)) {
              parts.push(await aliTranslate(t, to));
            }
            const out = parts.join(' / ').slice(0, 60);
            if (!out) throw new Error('翻回来是空的');
            one[k] = out;
            done.push({ key: k, text: out });
          } catch (e) {
            failed.push({ key: k, why: (e as Error).message });
            // 头两条就不通，剩下三十多条一样不通 —— 别让人干等
            if (done.length === 0 && failed.length >= 2) break;
          }
        }
        if (done.length) {
          map[packId] = one;
          db.setSetting('voiceText', map);
          packLangs[packId] = to;
          db.setSetting('voiceLang', packLangs);
        }
        return json(res, 200, { ok: true, done, failed, to });
      }
      /* 改念法：{ setText: <key>, text: '<念什么>' }。text 留空＝恢复默认。 */
      if (body.setText !== undefined) {
        const k = String(body.setText);
        if (!VOICE_KEYS.includes(k)) return json(res, 400, { error: '没有这一条' });
        /* 上限从 20 放到 60：外语翻出来比中文长一大截 ——
           「该你出牌」四个字，英文是 It's your turn to play，二十二个。
           卡在 20 会把翻译结果拦腰截断，念出来半句。 */
        const t = String(body.text ?? '').trim().slice(0, 60);
        const map = db.getSetting<Record<string, Record<string, string>>>('voiceText', {});
        const one = { ...(map[packId] ?? {}) };
        if (t && t !== (VOICE_LABEL[k] ?? k)) one[k] = t; else delete one[k];
        if (Object.keys(one).length) map[packId] = one; else delete map[packId];
        db.setSetting('voiceText', map);
        /* 自定义的念法一条不剩了＝回到内置那套中文，语言标记也得跟着回去，
           不然下次翻译会以为"还是外语"，从中文原句翻 —— 结果是对的，但
           界面上会一直显示着 English，看着莫名其妙。 */
        if (!map[packId] && packLangs[packId]) { delete packLangs[packId]; db.setSetting('voiceLang', packLangs); }
        return json(res, 200, { ok: true, say: t || (VOICE_LABEL[k] ?? k) });
      }
      if (body.del) {
        const k = String(body.del);
        if (!VOICE_KEYS.includes(k)) return json(res, 400, { error: '没有这一条' });
        dropVoice(dir, k);
        forget(k);
        return json(res, 200, { ok: true });
      }
      // 一次传一批：[{ key, data: base64, mime? }]
      const files: { key: string; data: string; mime?: string; name?: string }[] = Array.isArray(body.files) ? body.files : [];
      if (!files.length) return json(res, 400, { error: '没有文件' });
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const saved: string[] = []; const skipped: string[] = [];
      for (const f of files.slice(0, 40)) {
        const k = String(f.key ?? '');
        if (!VOICE_KEYS.includes(k)) { skipped.push(k || '(无名)'); continue; }
        try {
          const buf = Buffer.from(String(f.data ?? ''), 'base64');
          // 一条报牌撑死几十 KB；给到 2MB 已经很宽了，再大多半是传错了东西
          if (!buf.length || buf.length > 2 * 1024 * 1024) { skipped.push(k); continue; }
          /* 后缀按**真实格式**来，不一律叫 .mp3：
             后台现场录出来的，iOS Safari 给的是 m4a、安卓 Chrome 给的是 webm，
             硬安个 .mp3 的名字，播的时候按 audio/mpeg 解就废了。 */
          const ext = voiceExt(String(f.mime ?? ''), String(f.name ?? ''), buf);
          dropVoice(dir, k);                        // 同一条只留一个格式，换格式时把旧的清掉
          writeFileSync(join(dir, `${k}.${ext}`), buf);
          forget(k);                                // 这一条改成人工的了，往后别再被自动重合成
          saved.push(k);
        } catch { skipped.push(k); }
      }
      return json(res, 200, { ok: true, saved, skipped });
    }
    case 'rounds':
      return json(res, 200, {
        rounds: db.adminRounds({
          roomId: url.searchParams.get('roomId') ?? undefined,
          userId: url.searchParams.get('userId') ? Number(url.searchParams.get('userId')) : undefined,
          limit: Number(url.searchParams.get('limit') ?? 50),
        }),
      });
    default: {
      const m = path.match(/^round\/(\d+)$/);
      if (m) {
        const r = db.adminRoundDetail(Number(m[1]));
        return r ? json(res, 200, r) : json(res, 404, { error: 'not found' });
      }
      return json(res, 404, { error: 'not found' });
    }
  }
}
