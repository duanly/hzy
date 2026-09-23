import { Game, getRules, nameOf } from '../packages/engine/src/index.ts';
const S = (r:number)=>r-1, B=(r:number)=>10+r-1;
const g:any = new Game({ rules: getRules('ly_tilong'), baseScore: 1, dealer: 0, now: () => 0 });
g.start();
const me = g.players[1];
// 手牌：四四四 六七八 柒捌玖 二八九 壹壹
me.hand = [S(4),S(4),S(4), S(6),S(7),S(8), B(7),B(8),B(9), S(2),S(8),S(9), B(1),B(1)];
me.melds = [
  { type:'chi', cards:[S(10),S(2),S(7)], xi:3, hidden:false, from:0 },
  { type:'wei', cards:[S(5),S(5),S(5)], xi:3, hidden:true, from:1 },
];
const tc = { card: S(10), from: 0, source: 'discard', at: 0 };
for (const noTake of [false, true]) {
  me.noTake = noTake;
  const opts = g.claimOptions(1, tc);
  console.log('noTake=', noTake, JSON.stringify(opts.map((o:any)=>({t:o.type, combos:(o.combos??[]).map((c:any[])=>c.map(nameOf).join(''))}))));
}
