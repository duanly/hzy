import { Game } from './packages/engine/src/game.ts';

const g = new Game({ n: 4, variant: 'hy_honghei', baseScore: 1, seed: 42 });

const p0 = g.players[0];
console.log("hand length:", p0.hand.length);
console.log("ids length:", p0.ids.length);

// 验证 hand[i] 和 ids[i] 是否对应
let mismatch = 0;
for (let i = 0; i < p0.hand.length; i++) {
  const kindFromHand = p0.hand[i];
  const kindFromIds = g.deck[p0.ids[i]];
  if (kindFromHand !== kindFromIds) {
    mismatch++;
    if (mismatch <= 5) {
      console.log(`  MISMATCH at i=${i}: hand=${kindFromHand}, ids->deck=${kindFromIds}`);
    }
  }
}
console.log(`Positional mismatches: ${mismatch} / ${p0.hand.length}`);
console.log(`(hand is sorted, ids is deal order — so positional mismatch is expected)`);

// 但按字统计，数量应该一致
const handCounts: Record<number, number> = {};
const idsCounts: Record<number, number> = {};
for (const k of p0.hand) handCounts[k] = (handCounts[k] || 0) + 1;
for (const id of p0.ids) {
  const k = g.deck[id];
  idsCounts[k] = (idsCounts[k] || 0) + 1;
}

let countMismatch = 0;
const allKinds = [...new Set([...Object.keys(handCounts), ...Object.keys(idsCounts)])].map(Number);
for (const k of allKinds) {
  const hc = handCounts[k] || 0;
  const ic = idsCounts[k] || 0;
  if (hc !== ic) {
    console.log(`  Kind ${k}: hand=${hc}, ids=${ic} MISMATCH!`);
    countMismatch++;
  }
}
console.log(`Kind count mismatches (before peng): ${countMismatch}`);

// 找对子
const pair = Object.entries(handCounts).find(([k, v]) => v >= 2);
console.log("\n=== Testing removeFromHand (simulated peng) ===");
console.log("Pair kind:", pair ? pair[0] : 'none');

if (pair) {
  const card = parseInt(pair[0]);
  console.log(`Before: hand.len=${p0.hand.length}, ids.len=${p0.ids.length}`);
  
  g.takenIds = [];
  (g as any).removeFromHand(p0, card, 2);
  
  console.log(`After: hand.len=${p0.hand.length}, ids.len=${p0.ids.length}`);
  console.log(`takenIds: ${g.takenIds.length} cards`);
  
  // 再检查按字统计
  const handCounts2: Record<number, number> = {};
  const idsCounts2: Record<number, number> = {};
  for (const k of p0.hand) handCounts2[k] = (handCounts2[k] || 0) + 1;
  for (const id of p0.ids) {
    const k = g.deck[id];
    idsCounts2[k] = (idsCounts2[k] || 0) + 1;
  }
  
  let countMismatch2 = 0;
  const allKinds2 = [...new Set([...Object.keys(handCounts2), ...Object.keys(idsCounts2)])].map(Number);
  for (const k of allKinds2) {
    const hc = handCounts2[k] || 0;
    const ic = idsCounts2[k] || 0;
    if (hc !== ic) {
      console.log(`  Kind ${k}: hand=${hc}, ids=${ic} MISMATCH!`);
      countMismatch2++;
    }
  }
  console.log(`Kind count mismatches (after peng): ${countMismatch2}`);
  
  // takenIds 里的牌面值检查
  const takenKinds = g.takenIds.map(id => g.deck[id]);
  console.log(`takenIds kinds: ${takenKinds.join(',')}`);
  console.log(`All taken are kind ${card}? ${takenKinds.every(k => k === card)}`);
}
