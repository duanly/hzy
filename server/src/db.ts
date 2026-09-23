import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export interface UserRow {
  id: number;
  username: string | null;
  nickname: string;
  avatar: string;
  kind: 'guest' | 'user' | 'wechat' | 'device';
  wx_openid: string | null;
  points: number;
  vip: number;          // 0/1
  can_open_room: number;
  role?: string;
  group_id?: number | null;
  blocked?: number;
  created_at: number;
  last_login: number;
}

export interface StatsRow {
  user_id: number;
  games: number; wins: number; hu: number; zimo: number; dianpao: number;
  ti: number; pao: number; escapes: number; timeouts: number; violations: number;
  points_won: number; points_lost: number;
  bighu: number; max_xi: number; max_mul: number;
}

export class DB {
  /** 回放最多留这么多局（按房间算）：一局的记录 ~3.5KB，200 局 ≈ 0.7MB，
   *  一张大厅固定桌打满也就这么大；再早的局删掉，免得数据库一天天胀下去。 */
  static KEEP_ROUNDS = 200;
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      /* WAL 之外再补两条：结算写盘不等硬盘刷完（掉电最多丢最后一两局，换来的是几千桌同时结算不卡），
         另外给并发写一个 5 秒的等锁窗口，别一撞上就报 SQLITE_BUSY。 */
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password_hash TEXT,
        nickname TEXT NOT NULL,
        avatar TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        wx_openid TEXT UNIQUE,
        points INTEGER NOT NULL DEFAULT 1000,
        vip INTEGER NOT NULL DEFAULT 0,
        can_open_room INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_login INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stats (
        user_id INTEGER PRIMARY KEY,
        games INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
        hu INTEGER NOT NULL DEFAULT 0, zimo INTEGER NOT NULL DEFAULT 0, dianpao INTEGER NOT NULL DEFAULT 0,
        ti INTEGER NOT NULL DEFAULT 0, pao INTEGER NOT NULL DEFAULT 0,
        escapes INTEGER NOT NULL DEFAULT 0, timeouts INTEGER NOT NULL DEFAULT 0, violations INTEGER NOT NULL DEFAULT 0,
        points_won INTEGER NOT NULL DEFAULT 0, points_lost INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL, variant TEXT NOT NULL, private INTEGER NOT NULL,
        winner_user INTEGER, detail TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS point_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, delta INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );
    `);
    // 旧库升级：补 violations 列
    try { this.db.exec('ALTER TABLE stats ADD COLUMN violations INTEGER NOT NULL DEFAULT 0'); } catch { /* 已存在 */ }
    // 设备登录：一台设备绑一个账号
    try { this.db.exec('ALTER TABLE users ADD COLUMN device_id TEXT'); } catch { /* 已存在 */ }
    try { this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_device ON users(device_id)'); } catch { /* 忽略 */ }
    // 战绩回放：记下这一局都有谁（',id,id,' 这种形式，按人查用 LIKE）
    try { this.db.exec("ALTER TABLE rounds ADD COLUMN players TEXT NOT NULL DEFAULT ''"); } catch { /* 已存在 */ }
    // 私人房：记下房主是谁，房主可以回看自己房间里的每一局
    try { this.db.exec('ALTER TABLE rounds ADD COLUMN host_id INTEGER'); } catch { /* 已存在 */ }
    // 账号码（7~9 位字母）：给玩家看的 ID，比自增数字体面，也不暴露注册顺序
    try { this.db.exec('ALTER TABLE users ADD COLUMN code TEXT'); } catch { /* 已存在 */ }
    try { this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_code ON users(code)'); } catch { /* 忽略 */ }
    // 改昵称：改过几次 / 最多几次（后台可以放开）
    try { this.db.exec('ALTER TABLE users ADD COLUMN nick_changes INTEGER NOT NULL DEFAULT 0'); } catch { /* 已存在 */ }
    try { this.db.exec('ALTER TABLE users ADD COLUMN nick_limit INTEGER NOT NULL DEFAULT 3'); } catch { /* 已存在 */ }
    // VIP：同时能开几个房（0 = 不限）
    try { this.db.exec('ALTER TABLE users ADD COLUMN room_limit INTEGER NOT NULL DEFAULT 2'); } catch { /* 已存在 */ }
    // 复盘记录：玩家自己清空过一次之后，只看得到这个时间点以后的局
    try { this.db.exec('ALTER TABLE users ADD COLUMN history_cut INTEGER NOT NULL DEFAULT 0'); } catch { /* 已存在 */ }
    // 「代理」这个叫法换成「VIP」：老库里那一组直接改名，组里的人一个不动
    try { this.db.exec("UPDATE groups SET name = 'VIP' WHERE name = '代理'"); } catch { /* 忽略 */ }
    /* 房主清空房间数据：不删局，只记一条"从这个时刻起往前的别给我看了"的线。
       删了的话玩家自己的战绩和复盘也跟着没了 —— 那是人家的牌，不该被房主一键抹掉。 */
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS room_cuts (
        room_id TEXT NOT NULL, host_id INTEGER NOT NULL, cut_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, host_id))`);
    } catch { /* 忽略 */ }
    // 开房月卡：开房权限是永久的，但要卡没过期才开得了房（到期时间戳；0 / NULL = 没卡）
    try { this.db.exec('ALTER TABLE users ADD COLUMN card_until INTEGER NOT NULL DEFAULT 0'); } catch { /* 已存在 */ }
    /* 最近一次进来用的设备指纹：跟 device_id（绑定的那台，唯一）分开记 ——
       一台手机换几个号登录时，device_id 只认得住一个，last_device 才看得出"还是这台机器"。 */
    try { this.db.exec('ALTER TABLE users ADD COLUMN last_device TEXT'); } catch { /* 已存在 */ }
    // 登录来源：最近一次的 IP 和查出来的归属地（房主在「我的房间」里看得到，防的是几个号坐一屋伙牌）
    try { this.db.exec('ALTER TABLE users ADD COLUMN last_ip TEXT'); } catch { /* 已存在 */ }
    try { this.db.exec('ALTER TABLE users ADD COLUMN ip_loc TEXT'); } catch { /* 已存在 */ }
    try { this.db.exec('ALTER TABLE users ADD COLUMN ip_at INTEGER'); } catch { /* 已存在 */ }
    // 换设备：新设备想用这个账号登录，得原设备点「解除绑定」才放行
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS bind_requests (
        user_id INTEGER PRIMARY KEY, device_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        approved INTEGER NOT NULL DEFAULT 0)`);
    } catch { /* 忽略 */ }
    // 老账号补一个账号码
    try {
      const rows = this.db.prepare("SELECT id FROM users WHERE code IS NULL OR code = ''").all() as { id: number }[];
      for (const r of rows) this.db.prepare('UPDATE users SET code = ? WHERE id = ?').run(this.newCode(), r.id);
    } catch { /* 忽略 */ }
    // 按房间查 / 按房间裁剪都要用到 room_id
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_rounds_room ON rounds(room_id, id)'); } catch { /* 忽略 */ }
    // 统计：大胡（有翻倍的那种）、最高胡息、最高倍率
    for (const c of ['bighu', 'max_xi', 'max_mul']) {
      try { this.db.exec(`ALTER TABLE stats ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`); } catch { /* 已存在 */ }
    }
    // 后台：管理员、分组、全局设置
    try { this.db.exec('ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT \'player\''); } catch { /* 已存在 */ }
    try { this.db.exec('ALTER TABLE users ADD COLUMN group_id INTEGER'); } catch { /* 已存在 */ }
    try { this.db.exec('ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0'); } catch { /* 已存在 */ }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
  }

  // ---- users ----
  static hashPassword(pw: string): string {
    const salt = randomBytes(16).toString('hex');
    return salt + ':' + scryptSync(pw, salt, 32).toString('hex');
  }
  static verifyPassword(pw: string, stored: string): boolean {
    const [salt, hash] = stored.split(':');
    const h = scryptSync(pw, salt, 32);
    return timingSafeEqual(h, Buffer.from(hash, 'hex'));
  }

  getUser(id: number): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }
  getUserByName(username: string): (UserRow & { password_hash: string }) | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
  }
  getUserByDevice(deviceId: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE device_id = ?').get(deviceId) as UserRow | undefined;
  }
  getUserByOpenid(openid: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE wx_openid = ?').get(openid) as UserRow | undefined;
  }
  /** 账号码：7~9 位小写字母，中间嵌一个吉利词（love / happy / lucky…），重了就再抽 */
  newCode(): string {
    const WORDS = ['love', 'happy', 'lucky', 'win', 'ace', 'joy', 'star', 'king', 'rich', 'good',
      'hu', 'pao', 'niu', 'fu', 'jin', 'long', 'feng', 'yun', 'shun', 'wang'];
    const L = 'abcdefghijkmnpqrstuvwxyz';                 // 去掉容易看混的 l / o
    const pick = (n: number) => Array.from({ length: n }, () => L[Math.floor(Math.random() * L.length)]).join('');
    for (let i = 0; i < 60; i++) {
      const w = WORDS[Math.floor(Math.random() * WORDS.length)];
      const total = 7 + Math.floor(Math.random() * 3);     // 7~9 位
      const rest = Math.max(1, total - w.length);
      const head = pick(Math.floor(rest / 2));
      const tail = pick(rest - head.length);
      const code = (head + w + tail).slice(0, 9);
      if (code.length < 7) continue;
      const hit = this.db.prepare('SELECT id FROM users WHERE code = ?').get(code);
      if (!hit) return code;
    }
    return 'phz' + Date.now().toString(36).slice(-6);      // 兜底
  }
  getUserByCode(code: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE code = ?').get(String(code).toLowerCase()) as UserRow | undefined;
  }
  /** 复盘：把"从现在起才看得到"的线往前推一下（只影响他自己看到的列表，别人的记录照旧） */
  clearHistory(id: number) { this.db.prepare('UPDATE users SET history_cut = ? WHERE id = ?').run(Date.now(), id); }
  historyCut(id: number): number { return Number((this.db.prepare('SELECT history_cut FROM users WHERE id = ?').get(id) as any)?.history_cut ?? 0); }

  /** 换设备：新设备提的申请（一个账号同时只留一条） */
  putBindRequest(userId: number, deviceId: string) {
    this.db.prepare(`INSERT INTO bind_requests (user_id, device_id, created_at, approved) VALUES (?, ?, ?, 0)
      ON CONFLICT(user_id) DO UPDATE SET device_id = excluded.device_id, created_at = excluded.created_at,
        approved = CASE WHEN bind_requests.device_id = excluded.device_id THEN bind_requests.approved ELSE 0 END`)
      .run(userId, deviceId, Date.now());
  }
  getBindRequest(userId: number): { device_id: string; created_at: number; approved: number } | undefined {
    return this.db.prepare('SELECT device_id, created_at, approved FROM bind_requests WHERE user_id = ?').get(userId) as any;
  }
  approveBindRequest(userId: number) { this.db.prepare('UPDATE bind_requests SET approved = 1 WHERE user_id = ?').run(userId); }
  clearBindRequest(userId: number) { this.db.prepare('DELETE FROM bind_requests WHERE user_id = ?').run(userId); }
  /** 账号换到新设备上：改绑 + 把老设备的登录票作废 */
  moveDevice(userId: number, deviceId: string) {
    this.db.prepare('UPDATE users SET device_id = NULL WHERE device_id = ? AND id <> ?').run(deviceId, userId);
    this.db.prepare('UPDATE users SET device_id = ? WHERE id = ?').run(deviceId, userId);
    this.db.prepare('DELETE FROM tokens WHERE user_id = ?').run(userId);
    this.clearBindRequest(userId);
  }

  /** 改昵称：算一次改名次数（后台直接改的不算） */
  bumpNickChange(id: number) { this.db.prepare('UPDATE users SET nick_changes = nick_changes + 1 WHERE id = ?').run(id); }
  setNickLimit(id: number, limit: number) { this.db.prepare('UPDATE users SET nick_limit = ? WHERE id = ?').run(Math.max(0, Math.floor(limit)), id); }
  resetNickChanges(id: number) { this.db.prepare('UPDATE users SET nick_changes = 0 WHERE id = ?').run(id); }

  createUser(u: { username?: string; password?: string; nickname: string; avatar?: string; kind: UserRow['kind']; wx_openid?: string; device_id?: string }): UserRow {
    const now = Date.now();
    // 开房权限默认关闭，要后台给
    const r = this.db.prepare(`INSERT INTO users (username, password_hash, nickname, avatar, kind, wx_openid, device_id, created_at, last_login, can_open_room)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
      u.username ?? null, u.password ? DB.hashPassword(u.password) : null, u.nickname, u.avatar ?? '', u.kind, u.wx_openid ?? null, u.device_id ?? null, now, now);
    const id = Number(r.lastInsertRowid);
    this.db.prepare('INSERT INTO stats (user_id) VALUES (?)').run(id);
    this.db.prepare('UPDATE users SET code = ? WHERE id = ?').run(this.newCode(), id);
    return this.getUser(id)!;
  }
  touchLogin(id: number) { this.db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), id); }
  /** 记下这个号最近是从哪个 IP 进来的（换了 IP 就把旧的归属地清掉，等着重新查） */
  touchIp(id: number, ip: string) {
    if (!ip) return;
    const cur = this.db.prepare('SELECT last_ip FROM users WHERE id = ?').get(id) as any;
    if (cur?.last_ip === ip) { this.db.prepare('UPDATE users SET ip_at = ? WHERE id = ?').run(Date.now(), id); return; }
    this.db.prepare('UPDATE users SET last_ip = ?, ip_loc = NULL, ip_at = ? WHERE id = ?').run(ip, Date.now(), id);
  }
  /** 记下这个号最近一次是从哪台设备进来的（不改绑定关系，只是留个印子） */
  touchDevice(id: number, dev: string) {
    if (!dev) return;
    this.db.prepare('UPDATE users SET last_device = ? WHERE id = ?').run(String(dev).slice(0, 64), id);
  }
  setIpLoc(ip: string, loc: string) { this.db.prepare('UPDATE users SET ip_loc = ? WHERE last_ip = ?').run(loc, ip); }
  ipOf(id: number): { ip: string; loc: string; dev: string } {
    const r = this.db.prepare('SELECT last_ip, ip_loc, last_device, device_id FROM users WHERE id = ?').get(id) as any;
    return { ip: r?.last_ip ?? '', loc: r?.ip_loc ?? '', dev: r?.last_device ?? r?.device_id ?? '' };
  }
  updateNickname(id: number, nickname: string, avatar?: string) {
    this.db.prepare('UPDATE users SET nickname = ?, avatar = COALESCE(?, avatar) WHERE id = ?').run(nickname, avatar ?? null, id);
  }
  addPoints(id: number, delta: number, reason: string) {
    this.db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(delta, id);
    this.db.prepare('INSERT INTO point_logs (user_id, delta, reason, created_at) VALUES (?, ?, ?, ?)').run(id, delta, reason, Date.now());
  }

  // ---- 后台：管理员 / 分组 / 设置 ----
  /** 启动时保证有一个管理员账号（用户名 admin，密码取环境变量 ADMIN_PASSWORD，默认 admin8888） */
  ensureAdmin(username = 'admin', password = 'admin8888'): { created: boolean; username: string } {
    const u = this.getUserByName(username);
    if (u) { this.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(u.id); return { created: false, username }; }
    const nu = this.createUser({ username, password, nickname: '管理员', kind: 'user' });
    this.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(nu.id);
    return { created: true, username };
  }
  isAdmin(userId: number): boolean {
    const r = this.db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role?: string } | undefined;
    return r?.role === 'admin';
  }
  setRole(userId: number, role: 'admin' | 'player') { this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId); }
  setCanOpenRoom(userId: number, can: boolean) { this.db.prepare('UPDATE users SET can_open_room = ? WHERE id = ?').run(can ? 1 : 0, userId); }
  /* ---------- 开房月卡 ----------
     开房权限（can_open_room）是永久的，月卡（card_until）是会到期的那一半：
     权限在、卡没过期，才开得了房。续卡一次加一个月 —— 没过期的从原到期日接着算，
     过期了的从今天重新算，不让"忘了续"白吃亏，也不让过期的卡凭空多出几个月。 */
  /** 下个月 1 号 0 点（按服务器本地时间算） */
  static monthStart(t: number, add = 0): number {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth() + add, 1, 0, 0, 0, 0).getTime();
  }
  cardUntil(userId: number): number { return Number((this.db.prepare('SELECT card_until FROM users WHERE id = ?').get(userId) as any)?.card_until ?? 0); }
  cardValid(userId: number): boolean { return this.cardUntil(userId) > Date.now(); }
  /* 续卡按**自然月**算，到期日一律落在某月 1 号 0 点：
     - 卡还在（到期日已经是某月 1 号）：从那天起再加 months 个月；
     - 没卡 / 过期了：从**下个月 1 号**开始算，算到再往后 months 个月的 1 号 ——
       也就是这个月剩下的天数白送，省得月中续卡还要掰扯半个月怎么算。 */
  renewCard(userId: number, months = 1): number {
    const now = Date.now();
    const cur = this.cardUntil(userId);
    const m = Math.max(1, Math.round(months));
    const until = cur > now ? DB.monthStart(cur, m) : DB.monthStart(now, 1 + m);
    this.db.prepare('UPDATE users SET card_until = ? WHERE id = ?').run(until, userId);
    return until;
  }
  /** 直接把卡停掉（到期时间清零） */
  clearCard(userId: number) { this.db.prepare('UPDATE users SET card_until = 0 WHERE id = ?').run(userId); }
  /** VIP 的开房上限：同时开着的房间最多几个（0 = 不限） */
  setRoomLimit(userId: number, n: number) { this.db.prepare('UPDATE users SET room_limit = ? WHERE id = ?').run(Math.max(0, Math.min(99, Math.floor(n))), userId); }
  roomLimit(userId: number): number { return Number((this.db.prepare('SELECT room_limit FROM users WHERE id = ?').get(userId) as any)?.room_limit ?? 0); }
  /** 「VIP」这个分组：没有就建一个（后台给谁开房权限，就把谁放进来） */
  agentGroupId(): number {
    const g = this.db.prepare("SELECT id FROM groups WHERE name = 'VIP'").get() as { id: number } | undefined;
    return g ? g.id : this.addGroup('VIP');
  }
  /** 所有 VIP：有开房权限的，加上"曾经是 VIP、现在被停了"的（还留在 VIP 组里） */
  agents() {
    const gid = this.agentGroupId();
    const rows = this.db.prepare(`SELECT u.id, u.code, u.nickname, u.points, u.can_open_room, u.room_limit, u.blocked,
        u.card_until, u.created_at, u.last_login, u.group_id
      FROM users u WHERE u.can_open_room = 1 OR u.group_id = ? ORDER BY u.can_open_room DESC, u.id`).all(gid) as any[];
    return rows.map(r => ({
      id: r.id, code: r.code ?? '', nickname: r.nickname, points: r.points,
      canOpenRoom: !!r.can_open_room, roomLimit: r.room_limit ?? 0, blocked: !!r.blocked,
      cardUntil: r.card_until ?? 0, cardLeft: Math.max(0, Math.ceil(((r.card_until ?? 0) - Date.now()) / 86400_000)),
      inGroup: r.group_id === gid, createdAt: r.created_at, lastLogin: r.last_login,
    }));
  }
  setBlocked(userId: number, blocked: boolean) { this.db.prepare('UPDATE users SET blocked = ? WHERE id = ?').run(blocked ? 1 : 0, userId); }
  setGroup(userId: number, groupId: number | null) { this.db.prepare('UPDATE users SET group_id = ? WHERE id = ?').run(groupId, userId); }

  groups(): { id: number; name: string; members: number }[] {
    return this.db.prepare(`SELECT g.id, g.name, (SELECT COUNT(*) FROM users u WHERE u.group_id = g.id) AS members
      FROM groups g ORDER BY g.id`).all() as any[];
  }
  addGroup(name: string): number {
    const r = this.db.prepare('INSERT INTO groups (name, created_at) VALUES (?, ?)').run(name, Date.now());
    return Number(r.lastInsertRowid);
  }
  renameGroup(id: number, name: string) { this.db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, id); }
  deleteGroup(id: number) {
    this.db.prepare('UPDATE users SET group_id = NULL WHERE group_id = ?').run(id);
    this.db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  }

  getSetting<T = any>(key: string, def: T): T {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!r) return def;
    try { return JSON.parse(r.value) as T; } catch { return def; }
  }
  setSetting(key: string, value: unknown) {
    this.db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value), Date.now());
  }

  /** 后台玩家列表：积分、胜率、牌品、分组、开房权限 */
  adminUsers(opt: { q?: string; groupId?: number | null; limit?: number; offset?: number } = {}) {
    const where: string[] = ["u.kind != 'bot'"];
    const args: any[] = [];
    if (opt.q) { where.push('(u.nickname LIKE ? OR u.username LIKE ? OR u.code LIKE ? OR CAST(u.id AS TEXT) = ?)'); args.push(`%${opt.q}%`, `%${opt.q}%`, `%${String(opt.q).toLowerCase()}%`, opt.q); }
    if (opt.groupId != null) { where.push('u.group_id = ?'); args.push(opt.groupId); }
    const limit = Math.max(1, Math.min(200, opt.limit ?? 50)), offset = Math.max(0, opt.offset ?? 0);
    const rows = this.db.prepare(`SELECT u.id, u.code, u.nickname, u.nick_changes, u.nick_limit, u.username, u.kind, u.points, u.vip, u.can_open_room, u.room_limit, u.role, u.blocked,
        u.group_id, u.created_at, u.last_login, g.name AS group_name,
        s.games, s.wins, s.hu, s.zimo, s.dianpao, s.bighu, s.max_xi, s.max_mul, s.escapes, s.timeouts, s.violations
      FROM users u LEFT JOIN stats s ON s.user_id = u.id LEFT JOIN groups g ON g.id = u.group_id
      WHERE ${where.join(' AND ')} ORDER BY u.last_login DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as any[];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM users u WHERE ${where.join(' AND ')}`).get(...args) as any).n as number;
    return {
      total,
      users: rows.map(r => ({
        id: r.id, code: r.code ?? '', username: r.username, nickname: r.nickname, kind: r.kind, points: r.points,
        nickChanges: r.nick_changes ?? 0, nickLimit: r.nick_limit ?? 3,
        vip: !!r.vip, canOpenRoom: !!r.can_open_room, roomLimit: r.room_limit ?? 0, role: r.role ?? 'player', blocked: !!r.blocked,
        groupId: r.group_id ?? null, groupName: r.group_name ?? null,
        createdAt: r.created_at, lastLogin: r.last_login,
        games: r.games ?? 0, wins: r.wins ?? 0, hu: r.hu ?? 0, zimo: r.zimo ?? 0, dianpao: r.dianpao ?? 0,
        bigHu: r.bighu ?? 0, maxXi: r.max_xi ?? 0, maxMul: r.max_mul ?? 0,
        escapes: r.escapes ?? 0, timeouts: r.timeouts ?? 0, violations: r.violations ?? 0,
        winRate: r.games ? Math.round((r.wins / r.games) * 100) : 0,
      })),
    };
  }

  /** 后台对局列表 */
  adminRounds(opt: { roomId?: string; userId?: number; limit?: number } = {}) {
    const where: string[] = []; const args: any[] = [];
    if (opt.roomId) { where.push('room_id = ?'); args.push(opt.roomId); }
    if (opt.userId) { where.push('players LIKE ?'); args.push(`%,${opt.userId},%`); }
    const limit = Math.max(1, Math.min(200, opt.limit ?? 50));
    const rows = this.db.prepare(`SELECT id, room_id, variant, private, winner_user, created_at, detail, players
      FROM rounds ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit) as any[];
    return rows.map(r => {
      let d: any = {}; try { d = JSON.parse(r.detail); } catch { /* ignore */ }
      return { id: r.id, roomId: r.room_id, variant: r.variant, isPrivate: !!r.private, time: r.created_at,
        round: d.round ?? 0, winner: r.winner_user, seatNames: d.seatNames ?? [], deltas: d.deltas ?? {}, hasReplay: !!d.replay };
    });
  }

  /** 后台看任意一局（含回放） */
  adminRoundDetail(id: number) {
    const r = this.db.prepare('SELECT id, room_id, variant, created_at, detail FROM rounds WHERE id = ?').get(id) as any;
    if (!r) return null;
    let d: any = {}; try { d = JSON.parse(r.detail); } catch { /* ignore */ }
    return { id: r.id, roomId: r.room_id, variant: r.variant, time: r.created_at, entry: d };
  }

  // ---- tokens ----
  createToken(userId: number): string {
    const t = randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO tokens (token, user_id, created_at) VALUES (?, ?, ?)').run(t, userId, Date.now());
    return t;
  }
  userByToken(token: string): UserRow | undefined {
    const row = this.db.prepare('SELECT user_id FROM tokens WHERE token = ? AND revoked = 0').get(token) as { user_id: number } | undefined;
    return row ? this.getUser(row.user_id) : undefined;
  }
  revokeToken(token: string) { this.db.prepare('UPDATE tokens SET revoked = 1 WHERE token = ?').run(token); }

  // ---- stats ----
  getStats(userId: number): StatsRow {
    return this.db.prepare('SELECT * FROM stats WHERE user_id = ?').get(userId) as unknown as StatsRow;
  }
  bumpStats(userId: number, d: Partial<Omit<StatsRow, 'user_id'>>) {
    const keys = Object.keys(d) as (keyof typeof d)[];
    if (!keys.length) return;
    // max_xi / max_mul 记"历史最高"，其余都是累加
    const set = keys.map(k => (k === 'max_xi' || k === 'max_mul') ? `${k} = MAX(${k}, ?)` : `${k} = ${k} + ?`).join(', ');
    this.db.prepare(`UPDATE stats SET ${set} WHERE user_id = ?`).run(...keys.map(k => d[k] as number), userId);
  }
  /**
   * 审计：把**值得回看几局**的人和组合挑出来。
   *
   * 说明白一点：这里**不判断谁有问题**。胜率高本身不是问题 —— 打得好就是赢得多；
   * 这张表只是按数据挑出"跟大多数人不太一样"的几条，方便去复盘里看**牌打得合不合理**。
   *
   * 两条线：
   *  ① 个人：局数够多（默认 ≥ 30）的人里，胜率、点炮率、自摸占比、逃跑超时明显偏离常见区间的。
   *  ② 组合：扫最近几千局，数两人同桌多少次、A 在 B 胡牌的局里输了多少分。
   *     输赢过分集中在某一对人之间，同桌又够多的，列出来回看几局。
   */
  audit(opt: { minGames?: number; scanRounds?: number } = {}) {
    const minGames = opt.minGames ?? 30;
    const scan = opt.scanRounds ?? 4000;

    // ① 个人数据
    const rows = this.db.prepare(`SELECT u.id, u.code, u.nickname, u.points, s.games, s.wins, s.hu, s.zimo, s.dianpao,
        s.escapes, s.timeouts, s.points_won, s.points_lost
      FROM users u JOIN stats s ON s.user_id = u.id
      WHERE s.games >= ? AND u.kind <> 'bot' ORDER BY s.games DESC`).all(minGames) as any[];
    const players: any[] = [];
    for (const r of rows) {
      const g = r.games || 1;
      const winRate = r.wins / g, dianRate = r.dianpao / g, zimoShare = r.hu ? r.zimo / r.hu : 0;
      const flags: string[] = [];
      if (winRate >= 0.55) flags.push(`胜率 ${(winRate * 100).toFixed(0)}%`);
      if (dianRate >= 0.35) flags.push(`点炮率 ${(dianRate * 100).toFixed(0)}%`);
      if (winRate <= 0.08 && dianRate >= 0.25 && g >= minGames) flags.push('赢得少、放炮多');
      if (r.hu >= 10 && zimoShare >= 0.75) flags.push(`自摸占胡牌 ${(zimoShare * 100).toFixed(0)}%`);
      if (r.escapes + r.timeouts >= g * 0.3) flags.push('逃跑 / 超时偏多');
      if (flags.length) players.push({
        id: r.id, code: r.code ?? '', nickname: r.nickname, games: g, wins: r.wins, hu: r.hu, zimo: r.zimo,
        dianpao: r.dianpao, winRate: Math.round(winRate * 100), dianRate: Math.round(dianRate * 100),
        net: (r.points_won ?? 0) - (r.points_lost ?? 0), flags,
      });
    }

    // ② 组合
    const rs = this.db.prepare('SELECT winner_user, detail, players FROM rounds ORDER BY id DESC LIMIT ?').all(scan) as any[];
    const co = new Map<string, number>();          // 同桌次数
    const paid = new Map<string, number>();        // A 在 B 胡牌的局里输的分
    const lost = new Map<number, number>();        // A 总共输了多少
    for (const r of rs) {
      let d: any = {}; try { d = JSON.parse(r.detail); } catch { continue; }
      const deltas: Record<string, number> = d.deltas ?? {};
      const ids = Object.keys(deltas).map(Number).filter(n => n > 0);
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const k = `${Math.min(ids[i], ids[j])}-${Math.max(ids[i], ids[j])}`;
        co.set(k, (co.get(k) ?? 0) + 1);
      }
      const w = Number(r.winner_user ?? 0);
      for (const a of ids) {
        const v = deltas[a] ?? 0;
        if (v < 0) {
          lost.set(a, (lost.get(a) ?? 0) + -v);
          if (w > 0 && w !== a) paid.set(`${a}>${w}`, (paid.get(`${a}>${w}`) ?? 0) + -v);
        }
      }
    }
    const name = new Map<number, string>();
    for (const u of this.db.prepare('SELECT id, nickname FROM users').all() as any[]) name.set(u.id, u.nickname);
    const pairs: any[] = [];
    for (const [k, amount] of paid) {
      const [a, b] = k.split('>').map(Number);
      const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
      const n = co.get(key) ?? 0;
      const total = lost.get(a) ?? 0;
      if (n < 15 || total <= 0 || amount < 200) continue;
      const share = amount / total;
      if (share >= 0.7) pairs.push({
        from: a, fromName: name.get(a) ?? String(a), to: b, toName: name.get(b) ?? String(b),
        together: n, amount: Math.round(amount), share: Math.round(share * 100),
        note: `同桌 ${n} 局，输赢比较集中（占他输分的 ${Math.round(share * 100)}%），可以回看几局`,
      });
    }
    pairs.sort((x, y) => y.amount - x.amount);
    return { players, pairs: pairs.slice(0, 50), minGames, scanned: rs.length };
  }

  recordRound(roomId: string, variant: string, isPrivate: boolean, winnerUser: number | null, detail: unknown, players: number[] = [], hostId: number | null = null) {
    this.db.prepare('INSERT INTO rounds (room_id, variant, private, winner_user, detail, created_at, players, host_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(roomId, variant, isPrivate ? 1 : 0, winnerUser, JSON.stringify(detail), Date.now(), players.length ? `,${players.join(',')},` : '', hostId);
    // 每个房间只留最近 KEEP_ROUNDS 局，再早的连回放一起删掉
    try {
      this.db.prepare(
        'DELETE FROM rounds WHERE room_id = ? AND id NOT IN (SELECT id FROM rounds WHERE room_id = ? ORDER BY id DESC LIMIT ?)',
      ).run(roomId, roomId, DB.KEEP_ROUNDS);
    } catch { /* 裁剪失败不影响记分 */ }
  }

  /** 某个房间的对局（房主回看用） */
  roomRounds(roomId: string, hostId: number, limit = 50) {
    // 房主清过一次的话，只看得到那之后的局（局没删，玩家那头照旧）
    const cut = this.roomCut(roomId, hostId);
    const rows = this.db.prepare(
      'SELECT id, room_id, variant, winner_user, created_at, detail FROM rounds WHERE room_id = ? AND host_id = ? AND created_at > ? ORDER BY id DESC LIMIT ?',
    ).all(roomId, hostId, cut, limit) as any[];
    return rows.map(r => {
      let d: any = {}; try { d = JSON.parse(r.detail); } catch { /* ignore */ }
      return { id: r.id, roomId: r.room_id, variant: r.variant, time: r.created_at, round: d.round ?? 0,
        winner: r.winner_user, seatNames: d.seatNames ?? [], deltas: d.deltas ?? {}, hasReplay: !!d.replay };
    });
  }

  /** 房主清空这个房间的记录表：只挪自己这条"从这儿往后看"的线，局本身一条不删 ——
      玩家自己的战绩和复盘照旧看得到（那是人家打的牌，不该被房主一键抹掉）。 */
  clearRoomRounds(roomId: string, hostId: number) {
    this.db.prepare('INSERT INTO room_cuts (room_id, host_id, cut_at) VALUES (?, ?, ?) '
      + 'ON CONFLICT(room_id, host_id) DO UPDATE SET cut_at = excluded.cut_at').run(roomId, hostId, Date.now());
  }
  roomCut(roomId: string, hostId: number): number {
    return Number((this.db.prepare('SELECT cut_at FROM room_cuts WHERE room_id = ? AND host_id = ?').get(roomId, hostId) as any)?.cut_at ?? 0);
  }

  /** 我打过的最近几局（退出房间之后也能回看 / 回放） */
  myRounds(userId: number, limit = DB.KEEP_ROUNDS) {
    const cut = this.historyCut(userId);          // 自己清空过复盘：只看这条线之后的局
    const rows = this.db.prepare(
      'SELECT id, room_id, variant, private, winner_user, created_at, detail FROM rounds WHERE players LIKE ? AND created_at > ? ORDER BY id DESC LIMIT ?',
    ).all(`%,${userId},%`, cut, limit) as any[];
    return rows.map(r => {
      let d: any = {}; try { d = JSON.parse(r.detail); } catch { /* 坏数据就当空的 */ }
      return {
        id: r.id, roomId: r.room_id, variant: r.variant, isPrivate: !!r.private,
        time: r.created_at, round: d.round ?? 0, winner: r.winner_user,
        roomName: d.roomName ?? null,
        delta: d.deltas?.[userId] ?? 0, seatNames: d.seatNames ?? [], hasReplay: !!d.replay,
      };
    });
  }

  /** 某一局的完整记录（含回放序列） */
  roundDetail(id: number, userId: number) {
    const r = this.db.prepare('SELECT id, room_id, variant, private, winner_user, created_at, detail, players, host_id FROM rounds WHERE id = ?').get(id) as any;
    if (!r) return null;
    // 自己打过的局，或者自己是这个房间的房主，才看得到
    if (!String(r.players ?? '').includes(`,${userId},`) && r.host_id !== userId) return null;
    let d: any = {}; try { d = JSON.parse(r.detail); } catch { /* ignore */ }
    return { id: r.id, roomId: r.room_id, variant: r.variant, time: r.created_at, entry: d };
  }

  /** 牌品分：100 起，逃跑 -5，违规 -2，超时 -1，下限 0 */
  static conduct(s: StatsRow): number {
    return Math.max(0, Math.min(100, 100 - s.escapes * 5 - (s.violations ?? 0) * 2 - s.timeouts));
  }
}
