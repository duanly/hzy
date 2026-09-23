import { Game, getRules, botDecide, chiXi, nameOf, type VariantId } from '../packages/engine/src/index.ts';

const stats: Record<string, number> = {};
const bump = (k: string) => stats[k] = (stats[k] ?? 0) + 1;
const samples: string[] = [];

for (const v of ['ly_tilong', 'hy_honghei'] as VariantId[]) {
  for (let i = 0; i < 400; i++) {
    let now = 0;
    const g: any = new Game({ rules: getRules(v), baseScore: 1, dealer: i % 3, now: () => now });
    g.start();
    let guard = 0;
    while (!g.ended && guard++ < 3000) {
      if (g.phase === 'claim' && g.tableCard) {
        const tc = g.tableCard;
        const s = (tc.from + 1) % g.n;            // 上家的下家
        if (s !== tc.from) {
          const p = g.players[s];
          const counts: Record<number, number> = {};
          for (const k of p.hand) counts[k] = (counts[k] ?? 0) + 1;
          const free = p.hand.filter((k: number) => counts[k] < 3);
          let naive = false;
          for (let a = 0; a < free.length && !naive; a++) for (let b = a + 1; b < free.length; b++)
            if (chiXi(tc.card, free[a], free[b]) >= 0) { naive = true; break; }
          const claim = g.claims.find((c: any) => c.seat === s);
          const offered = !!claim?.options.some((o: any) => o.type === 'chi');
          if (naive && !offered) {
            const reason = p.noTake ? 'noTake' : g.huXiOf(p, tc.card) !== null && g.rules.mustHu ? 'mustHu' : '下伙/其它';
            bump(`${v}:漏吃:${reason}`);
            if (reason === '下伙/其它' && samples.length < 6)
              samples.push(`${v} 来牌 ${nameOf(tc.card)} 手牌 [${p.hand.map(nameOf).join(' ')}] 下地 ${p.melds.length} 组`);
          } else if (naive) bump(`${v}:给吃`);
        }
      }
      let acted = false;
      for (let s = 0; s < g.n; s++) { const d = botDecide(g, s); if (d) { const e = g.act(s, d.type, d); if (e) throw new Error(e); acted = true; break; } }
      if (!acted) { now += 30000; g.tick(now); }
    }
  }
}
console.log(stats);
console.log(samples.join('\n'));
