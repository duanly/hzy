/**
 * IP 归属地：只为了让房主看出"这几个号是不是挤在同一个地方"。
 * 查一次记一次（内存 + 库里各存一份），查不到就空着 —— 服务器不通外网也照样能跑，
 * 不会因为查不到地址就把「我的房间」卡在那儿。
 */
const cache = new Map<string, string>();
const pending = new Set<string>();

/** 内网 / 本机地址：不用查，直接说清楚 */
function localName(ip: string): string | null {
  if (!ip) return null;
  if (ip === '127.0.0.1' || ip === '::1') return '本机';
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return '局域网';
  if (/^(fe80:|fc|fd)/i.test(ip)) return '局域网';
  return null;
}

/** 已经知道的归属地（不发起查询） */
export function cachedLoc(ip: string): string {
  return localName(ip) ?? cache.get(ip) ?? '';
}

/** 查一个 IP 的归属地；查到了调用 save 存进库。同一个 IP 同时只查一次。 */
export function lookup(ip: string, save: (ip: string, loc: string) => void) {
  const local = localName(ip);
  if (local) { cache.set(ip, local); save(ip, local); return; }
  if (!ip || cache.has(ip) || pending.has(ip)) return;
  pending.add(ip);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2500);
  fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=status,country,regionName,city,isp`, { signal: ac.signal })
    .then(r => r.json() as any)
    .then(j => {
      if (j?.status !== 'success') return;
      const loc = [j.country, j.regionName, j.city].filter(Boolean).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i).join(' ')
        + (j.isp ? ` · ${j.isp}` : '');
      cache.set(ip, loc); save(ip, loc);
    })
    .catch(() => { /* 查不到就算了，下次再说 */ })
    .finally(() => { clearTimeout(timer); pending.delete(ip); });
}

/** 库里存过的归属地：进程重启之后不用重查 */
export function seed(ip: string, loc: string) { if (ip && loc && !cache.has(ip)) cache.set(ip, loc); }
