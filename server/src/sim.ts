/** 机器人自对局模拟：npm run sim [局数] —— 用于检验规则引擎与机器人水平 */
import { Game, getRules, botDecide, type VariantId } from '../../packages/engine/src/index.ts';

const N = Number(process.argv[2] ?? 300);
const variants: VariantId[] = ['hy_honghei', 'hy_liuhuqiang', 'ly_tilong'];
for (const v of variants) {
  let hu = 0, liuju = 0, ziMo = 0, xiSum = 0, fanSum = 0, steps = 0;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    let now = 0;
    const g = new Game({ rules: getRules(v), baseScore: 1, dealer: i % 3, now: () => now });
    g.start();
    let guard = 0;
    while (!g.ended && guard++ < 3000) {
      let acted = false;
      for (let s = 0; s < 3; s++) { const d = botDecide(g, s); if (d) { const e = g.act(s, d.type, d); if (e) throw new Error(e); acted = true; steps++; break; } }
      if (!acted) { now += 30000; g.tick(now); }
    }
    const huEv = g.events.find(e => e.t === 'hu');
    if (huEv && huEv.t === 'hu') { hu++; if (huEv.ziMo) ziMo++; xiSum += huEv.detail.xi; fanSum += huEv.detail.dun * huEv.detail.multiplier; } else liuju++;
  }
  console.log(`${getRules(v).name}: ${N} 局 · 胡 ${hu} (自摸 ${ziMo}) · 黄庄 ${liuju} · 平均 ${(xiSum / Math.max(1, hu)).toFixed(1)} 息 / 每家付 ${(fanSum / Math.max(1, hu)).toFixed(2)} 分 · 平均 ${(steps / N).toFixed(0)} 步 · ${((performance.now() - t0) / N).toFixed(1)} ms/局`);
}
