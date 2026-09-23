import type { IncomingMessage, ServerResponse } from 'node:http';
import { DB, type UserRow } from './db.ts';
import { json } from './util.ts';
import { badWord, badWordMsg } from './badwords.ts';

/** 按"字"截昵称：emoji 是两个码元，用 slice 会截成半个乱码，所以按码点数 */
const clampNick = (s: unknown, max: number) => Array.from(String(s ?? '').trim()).slice(0, max).join('');

/** 昵称里带脏字就挡回去（取昵称、改昵称都走这儿）；干净就返回 null */
function nickReject(nick: string): string | null {
  const bad = badWord(nick);
  return bad ? badWordMsg(bad) : null;
}


/**
 * 登录注册：
 *  POST /api/auth/register {username,password,nickname}
 *  POST /api/auth/login    {username,password}
 *  POST /api/auth/guest    {nickname}
 *  POST /api/auth/wechat   {code}  —— 微信 OAuth（网页授权 / 小程序 code2Session），需配置 WX_APPID / WX_SECRET
 *  POST /api/auth/logout   {token}
 */
const WX_APPID = process.env.WX_APPID || '';
const WX_SECRET = process.env.WX_SECRET || '';
// 同样用 || ：env_file 里那行空的 WX_MP_APPID= 传进来是空串，?? 就不会回落到公众号那套了
const WX_MP_APPID = process.env.WX_MP_APPID || WX_APPID;      // 小程序
const WX_MP_SECRET = process.env.WX_MP_SECRET || WX_SECRET;
const DEV_MOCK_WECHAT = process.env.DEV_MOCK_WECHAT === '1' || (!WX_APPID && process.env.NODE_ENV !== 'production');

const attempts = new Map<string, { n: number; until: number }>();
function rateLimited(key: string): boolean {
  const a = attempts.get(key);
  return !!a && a.until > Date.now();
}
function failAttempt(key: string) {
  const a = attempts.get(key) ?? { n: 0, until: 0 };
  a.n++;
  if (a.n >= 8) { a.until = Date.now() + 10 * 60 * 1000; a.n = 0; }
  attempts.set(key, a);
}

function out(db: DB, res: ServerResponse, u: UserRow) {
  if ((u as any).blocked) return json(res, 403, { error: '账号已被封禁，请联系管理员' });
  const token = db.createToken(u.id);
  json(res, 200, { token, user: {
    id: u.id, code: (u as any).code ?? '', nickname: u.nickname, avatar: u.avatar, kind: u.kind,
    vip: !!u.vip, points: u.points, canOpenRoom: !!(u.vip || u.can_open_room),
    nickLeft: Math.max(0, ((u as any).nick_limit ?? 3) - ((u as any).nick_changes ?? 0)),
  } });
}

export async function handleAuth(db: DB, action: string, req: IncomingMessage, res: ServerResponse, readBody: (r: IncomingMessage) => Promise<any>) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method' });
  const body = await readBody(req);
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0] ?? req.socket.remoteAddress ?? '';
  switch (action) {
    case 'register': {
      const { username, password, nickname } = body;
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username ?? '')) return json(res, 400, { error: '用户名需 3-20 位字母数字下划线' });
      if (typeof password !== 'string' || password.length < 6) return json(res, 400, { error: '密码至少 6 位' });
      const nick = clampNick(nickname ?? username, 12) || username;
      { const bad0 = nickReject(nick); if (bad0) return json(res, 400, { error: bad0 }); }
      if (db.getUserByName(username)) return json(res, 409, { error: '用户名已存在' });
      const u = db.createUser({ username, password, nickname: nick, kind: 'user', avatar: `avatar:${u32(username) % 12}` });
      return out(db, res, u);
    }
    case 'login': {
      const { username, password } = body;
      const key = `login:${ip}:${username}`;
      if (rateLimited(key)) return json(res, 429, { error: '尝试过多，请 10 分钟后再试' });
      const u = db.getUserByName(String(username ?? ''));
      if (!u || !u.password_hash || !DB.verifyPassword(String(password ?? ''), u.password_hash)) { failAttempt(key); return json(res, 401, { error: '用户名或密码错误' }); }
      db.touchLogin(u.id);
      return out(db, res, u);
    }
    case 'guest': {
      // 没填昵称就随机起一个像样的名字（跟设备登录一路），别再叫「游客3721」
      const nick = clampNick(body.nickname, 12) || randomNick();
      { const bad0 = nickReject(nick); if (bad0) return json(res, 400, { error: bad0 }); }
      const u = db.createUser({ nickname: nick, kind: 'guest', avatar: `avatar:${Math.floor(Math.random() * 12)}` });
      return out(db, res, u);
    }
    // 设备登录：第一次给个昵称，之后这台设备再来就是同一个账号
    case 'device': {
      const deviceId = String(body.deviceId ?? '').trim().slice(0, 64);
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) return json(res, 400, { error: '设备标识无效' });
      let u = db.getUserByDevice(deviceId);
      // probe：开机时先问一声"这台设备有没有账号" —— 有就直接进，没有再去注册页，别在这儿偷偷建号
      if (!u && body.probe) return json(res, 404, { error: '这台设备还没有账号' });
      if (!u) {
        const nick = clampNick(body.nickname, 4) || randomNick();
        const bad0 = nickReject(nick); if (bad0) return json(res, 400, { error: bad0 });
        u = db.createUser({ nickname: nick, kind: 'device', avatar: `avatar:${u32(deviceId) % 12}`, device_id: deviceId });
      } else if (body.nickname) {
        const nick = clampNick(body.nickname, 4);
        const bad0 = nick ? nickReject(nick) : null; if (bad0) return json(res, 400, { error: bad0 });
        if (nick && nick !== u.nickname) { db.updateNickname(u.id, nick); u = db.getUser(u.id)!; }
      }
      db.touchLogin(u.id);
      return out(db, res, u);
    }
    case 'wechat': {
      const { code, source } = body; // source: 'h5' | 'mp'
      if (!code) return json(res, 400, { error: '缺少 code' });
      let openid: string; let nickname = '微信用户'; let avatar = '';
      if (DEV_MOCK_WECHAT) {
        openid = 'mock_' + String(code).slice(0, 16);
        nickname = '微信用户' + openid.slice(-4);
      } else {
        const mp = source === 'mp';
        const url = mp
          ? `https://api.weixin.qq.com/sns/jscode2session?appid=${WX_MP_APPID}&secret=${WX_MP_SECRET}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`
          : `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${WX_APPID}&secret=${WX_SECRET}&code=${encodeURIComponent(code)}&grant_type=authorization_code`;
        const r: any = await (await fetch(url)).json();
        if (!r.openid) return json(res, 401, { error: '微信登录失败：' + (r.errmsg ?? 'unknown') });
        openid = r.openid;
        if (!mp && r.access_token && r.scope?.includes('snsapi_userinfo')) {
          const info: any = await (await fetch(`https://api.weixin.qq.com/sns/userinfo?access_token=${r.access_token}&openid=${openid}&lang=zh_CN`)).json();
          if (info.nickname) { nickname = info.nickname; avatar = info.headimgurl ?? ''; }
        }
      }
      let u = db.getUserByOpenid(openid);
      if (!u) u = db.createUser({ nickname, avatar: avatar || `avatar:${u32(openid) % 12}`, kind: 'wechat', wx_openid: openid });
      db.touchLogin(u.id);
      return out(db, res, u);
    }
    /* 用账号码登录。光有账号码不够 —— 牌桌上谁都看得见的东西不能当钥匙：
       换了一台设备来登录，得**原来那台设备点过「解除绑定」**才放行。
       原设备自己（设备号对得上）登录不受影响：同一台手机换个入口也走这条路。 */
    case 'code': {
      const code = String(body.code ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
      if (code.length < 5) return json(res, 400, { error: '账号 ID 不对' });
      const dev = String(body.deviceId ?? '').trim().slice(0, 64);
      const key = `code:${ip}`;
      if (rateLimited(key)) return json(res, 429, { error: '试得太频繁，请 10 分钟后再来' });
      const u = db.getUserByCode(code);
      if (!u) { failAttempt(key); return json(res, 404, { error: '没找到这个账号 ID' }); }
      if (!dev) return json(res, 400, { error: '缺少设备标识' });
      const bound = (u as any).device_id as string | null;
      // 这台设备本来就是它绑的：直接进
      if (!bound || bound === dev) {
        if (!bound) db.moveDevice(u.id, dev);
        db.clearBindRequest(u.id);
        db.touchLogin(u.id);
        return out(db, res, u);
      }
      // 原设备已经点过「解除绑定」：把账号换到这台新设备上（老设备的登录票同时作废）
      const req0 = db.getBindRequest(u.id);
      if (req0 && req0.device_id === dev && req0.approved) {
        db.moveDevice(u.id, dev);
        db.touchLogin(u.id);
        return out(db, res, db.getUser(u.id)!);
      }
      // 还没解绑：记一条申请，让原设备上弹「解除绑定」
      db.putBindRequest(u.id, dev);
      failAttempt(key);
      return json(res, 403, { error: '这个账号绑在另一台设备上：请在原来那台设备上点「解除绑定」，再回来登录一次', pending: true });
    }
    /* 解除绑定：**只有原设备（拿着有效登录票的那台）**能点。点完新设备才登得上 */
    case 'unbind': {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const u = db.userByToken(token); if (!u) return json(res, 401, { error: 'unauthorized' });
      const r0 = db.getBindRequest(u.id);
      if (!r0) return json(res, 404, { error: '现在没有别的设备要登录这个账号' });
      if (body.deny) { db.clearBindRequest(u.id); return json(res, 200, { ok: true, denied: true }); }
      db.approveBindRequest(u.id);
      return json(res, 200, { ok: true });
    }
    case 'logout': { if (body.token) db.revokeToken(String(body.token)); return json(res, 200, { ok: true }); }
    case 'nickname': {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const u = db.userByToken(token); if (!u) return json(res, 401, { error: 'unauthorized' });
      const nick = clampNick(body.nickname, 4); if (!nick) return json(res, 400, { error: '昵称不能为空' });
      const bad = nickReject(nick); if (bad) return json(res, 400, { error: bad });
      const cur = db.getUser(u.id)!;
      const limit = (cur as any).nick_limit ?? 3, used = (cur as any).nick_changes ?? 0;
      const onlyAvatar = nick === cur.nickname;
      if (!onlyAvatar && used >= limit) {
        return json(res, 403, { error: `昵称最多改 ${limit} 次，已经用完了；要再改请找管理员` });
      }
      db.updateNickname(u.id, nick, body.avatar ? String(body.avatar).slice(0, 64) : undefined);
      if (!onlyAvatar) db.bumpNickChange(u.id);
      const after = db.getUser(u.id)!;
      return json(res, 200, { ok: true, nickLeft: Math.max(0, ((after as any).nick_limit ?? 3) - ((after as any).nick_changes ?? 0)) });
    }
    default: return json(res, 404, { error: 'unknown action' });
  }
}

/**
 * 随机昵称：姓 + 名，主要出 2～3 个字（头像框里最多显示三个字，太长就看不全了）。
 * 姓取自百家姓，另外带一批复姓；名是一两个字。
 */
const XING = ('赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜'
  + '戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐'
  + '费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄'
  + '和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁').split('');
const FU_XING = ['欧阳', '司马', '上官', '诸葛', '东方', '皇甫', '尉迟', '公孙', '慕容', '澹台',
  '南宫', '夏侯', '独孤', '令狐', '宇文', '长孙', '轩辕', '西门', '端木', '百里'];
const MING1 = ('伟强军磊洋勇涛明超刚平辉健世广义兴良海山仁波宁贵福生龙元全国胜学祥'
  + '才发武新利清飞彬富顺信子杰楠榕风航弘旭江河湖松柏竹梅兰菊荷莲霞秀娟英华慧巧美娜静淑惠珠翠雅芝玉萍红娥玲芬芳燕彩春菊勤珍贞莉桂娣叶璧璐娅琦晶妍茜秋珊莎锦黛青倩婷姣婉娴瑾颖露瑶怡婵雁蓓纨仪荷丹蓉眉君琴蕊薇菁梦岚苑婕馨瑗琰韵融园艺咏卿聪澜纯毓悦昭冰爽琬茗羽希宁欣飘育滢馥筠柔竹霭凝晓欢霄枫芸菲寒伊亚宜可姬舒影荔枝思丽').split('');
const MING2 = ['文轩', '一鸣', '小雨', '明月', '青山', '春风', '听雨', '归鸿', '子墨', '思远',
  '云飞', '若曦', '梓涵', '浩然', '嘉木', '晚晴', '南风', '知秋', '澜心', '半山'];
// 复姓只配单字名（三个字正好），挑些单独站得住的字
const MING_SOLO = ('云风雪峰山川玉轩宇晨阳月星泽磊敏洁娜静婷萱琳翔杰俊朗清明源海林森岳丞奕').split('');
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
export function randomNick(): string {
  const r = Math.random();
  // 一成出复姓（欧阳 + 名），其余单姓
  const xing = r < 0.12 ? pick(FU_XING) : pick(XING);
  // 复姓配一个字的名（三个字），单姓多数配两个字的名（三个字），少数配一个字（两个字）
  const ming = xing.length === 2 ? pick(MING_SOLO) : (Math.random() < 0.3 ? pick(MING1) : pick(MING2));
  return (xing + ming).slice(0, 3);
}

function u32(s: string): number { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
