import test from 'node:test';
import assert from 'node:assert/strict';
import { canHu, explain, waits } from '../src/hu.ts';
import { HONG, tileOf, nameOf, type Tile } from '../src/tiles.ts';

const W = (r: number) => tileOf('wan', r);
const T = (r: number) => tileOf('tiao', r);
const B = (r: number) => tileOf('tong', r);
const show = (h: Tile[]) => h.map(nameOf).join(' ');

test('最朴素的：四句加一对，一张红中都不用', () => {
  const h = [W(1),W(2),W(3), W(4),W(5),W(6), T(7),T(8),T(9), B(2),B(2),B(2), B(5),B(5)];
  assert.equal(canHu(h), true, show(h));
});

test('差一张，红中顶上', () => {
  // 万三缺一张，拿红中补
  const h = [W(1),W(2),HONG, W(4),W(5),W(6), T(7),T(8),T(9), B(2),B(2),B(2), B(5),B(5)];
  assert.equal(canHu(h), true);
});

test('红中当将', () => {
  const h = [W(1),W(2),W(3), W(4),W(5),W(6), T(7),T(8),T(9), B(2),B(2),B(2), B(5),HONG];
  assert.equal(canHu(h), true);
});

test('两张红中自己凑成对将', () => {
  const h = [W(1),W(2),W(3), W(4),W(5),W(6), T(7),T(8),T(9), B(2),B(2),B(2), HONG,HONG];
  assert.equal(canHu(h), true);
});

test('三张红中自己成一句刻', () => {
  const h = [W(1),W(2),W(3), W(4),W(5),W(6), T(7),T(8),T(9), HONG,HONG,HONG, B(5),B(5)];
  assert.equal(canHu(h), true);
});

test('顺子不能跨花色', () => {
  // 九万 一条 二条 —— 编码上连续，但不是同花色，不成顺
  const h = [W(8),W(9),T(1), W(4),W(5),W(6), T(7),T(8),T(9), B(2),B(2),B(2), B(5),B(5)];
  assert.equal(canHu(h), false, show(h));
});

test('顺子不能绕回去（八九一不算）', () => {
  const h = [W(8),W(9),W(1), T(4),T(5),T(6), T(7),T(8),T(9), B(2),B(2),B(2), B(5),B(5)];
  assert.equal(canHu(h), false, show(h));
});

test('张数不对一律不胡', () => {
  assert.equal(canHu([W(1),W(2),W(3)]), false);
  assert.equal(canHu([W(1),W(1)]), false);
  // 碰了一句就只要 11 张
  assert.equal(canHu([W(1),W(2),W(3), W(4),W(5),W(6), T(7),T(8),T(9), B(5),B(5)], 1), true);
  assert.equal(canHu([W(1),W(2),W(3), W(4),W(5),W(6), T(7),T(8),T(9), B(5),B(5)], 0), false);
});

test('碰了两句、杠了一句，手上只剩五张', () => {
  assert.equal(canHu([W(1),W(2),W(3), B(5),B(5)], 3), true);
  assert.equal(canHu([W(1),W(2),HONG, B(5),B(5)], 3), true);
  assert.equal(canHu([W(1),W(2),W(4), B(5),B(5)], 3), false);
});

test('一张牌四用：同一张既能当刻也能当顺的局面', () => {
  // 二万×3 + 一万二万三万 —— 拆法不止一种，只要有一种成立就算胡
  const h = [W(1),W(2),W(3), W(2),W(2),W(2), T(7),T(8),T(9), B(2),B(2),B(2), B(5),B(5)];
  assert.equal(canHu(h), true, show(h));
});

test('赖子要用在刀刃上：贪心拆会漏的那种', () => {
  // 一万一万 二万二万 三万三万（三对）+ 一张红中：
  // 红中不能当将（那样剩下六张拆不成两句），得去补顺 —— 一二三 / 一二三 少一张三万
  const h = [W(1),W(1), W(2),W(2), W(3),HONG, T(1),T(2),T(3), B(1),B(2),B(3), B(9),B(9)];
  assert.equal(canHu(h), true, show(h));
});

test('看得见的反例：怎么拆都差一张', () => {
  const h = [W(1),W(3),W(5), W(7),W(9),T(2), T(4),T(6),T(8), B(1),B(3),B(5), B(7),B(9)];
  assert.equal(canHu(h), false, show(h));
});

test('拆句子：拆出来的必须是四句加一对，且红中用量对得上', () => {
  const h = [W(1),W(2),HONG, W(4),W(5),W(6), T(7),T(8),T(9), B(2),B(2),B(2), B(5),HONG];
  const ms = explain(h);
  assert.ok(ms, '该拆得出来');
  assert.equal(ms!.filter(m => m.type !== 'pair').length, 4, '四句');
  assert.equal(ms!.filter(m => m.type === 'pair').length, 1, '一对将');
  assert.equal(ms!.reduce((s, m) => s + m.hong, 0), 2, '一共用了两张红中');
});

test('听牌：单吊听一张', () => {
  const h = [W(1),W(2),W(3), W(4),W(5),W(6), T(7),T(8),T(9), B(2),B(2),B(2), B(5)];
  const w = waits(h);
  // 红中能当将，五筒也能成对
  assert.ok(w.includes(B(5)), '听五筒');
  assert.ok(w.includes(HONG), '摸到红中也能胡');
});

test('听牌：两头听', () => {
  const h = [W(1),W(2),W(3), W(4),W(5),W(6), T(7),T(8),T(9), B(3),B(4), B(9),B(9)];
  const w = waits(h);
  assert.ok(w.includes(B(2)) && w.includes(B(5)), '二筒五筒都听');
  assert.ok(!w.includes(B(7)), '七筒不该听');
});

test('赖子代表的是角色不是实体牌：四张一条都在手上，红中还能再当一张一条', () => {
  /* 这条是**规则选择**，不是算法细节，所以单独钉一个用例：
     六万刻 + 一条刻 + 五六七筒 + 五六七筒 + 一条将 —— 最后那个"一条将"里
     有一张是红中变的，而一条的四张**已经全在这副牌里了**。
     牌桌上的通行打法是认的（赖子是万能牌，不占实体牌的份额）。
     要是你们那儿不认，改 hu.ts 就得同时记牌墙里每种牌还剩几张，是另一套写法。 */
  const h = [W(6),W(6),W(6), T(1),T(1),T(1),T(1), B(5),B(5), B(6),B(6), B(7), HONG, HONG];
  assert.equal(h.length, 14);
  assert.equal(canHu(h), true, show(h));
});

/* ---------- 跟一份"笨办法"互相验算 ---------- */
/** 不带赖子的朴素判定：最小那张必属某句，贪心即可 */
function plainHu(c: number[], need: number, needPair: boolean): boolean {
  let i = 0; while (i < 27 && c[i] === 0) i++;
  if (i === 27) return need === 0 && !needPair;
  if (needPair && c[i] >= 2) { c[i] -= 2; const r = plainHu(c, need, false); c[i] += 2; if (r) return true; }
  if (need > 0) {
    if (c[i] >= 3) { c[i] -= 3; const r = plainHu(c, need - 1, needPair); c[i] += 3; if (r) return true; }
    if (i % 9 <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
      c[i]--; c[i + 1]--; c[i + 2]--;
      const r = plainHu(c, need - 1, needPair);
      c[i]++; c[i + 1]++; c[i + 2]++;
      if (r) return true;
    }
  }
  return false;
}

/* mulberry32：32 位整数运算全程用 Math.imul，不碰浮点。
   原先随手写的那个 LCG（rnd * 1103515245 + 12345）在 JS 里乘法早就超出 2^53 丢了精度，
   低位几乎不动 —— rand(2) 两万次里有 19909 次返回 0，等于没随机。
   造牌的测试全靠这个随机源，它坏了整条对账就是摆设。 */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296 * n) | 0;
  };
}

/** 随机造一副**真能胡**的牌：四句 + 一对，同一张不超过四份 */
function makeWin(rand: (n: number) => number): Tile[] {
  for (let tries = 0; tries < 200; tries++) {
    const c = new Array(28).fill(0);
    const h: Tile[] = [];
    const put = (ts: Tile[]) => { for (const t of ts) { if (c[t] >= 4) return false; } for (const t of ts) { c[t]++; h.push(t); } return true; };
    let ok = true;
    for (let k = 0; k < 4 && ok; k++) {
      ok = false;
      for (let a = 0; a < 40 && !ok; a++) {
        const t = rand(27);
        ok = rand(2) ? put([t, t, t]) : (t % 9 <= 6 ? put([t, t + 1, t + 2]) : false);
      }
    }
    if (!ok) continue;
    for (let a = 0; a < 40; a++) { const t = rand(27); if (put([t, t])) return h; }
  }
  throw new Error('造不出来');
}

test('对账：没有红中的时候，跟朴素判定必须一字不差（两万副，一半是真胡牌）', () => {
  const rand = mulberry(20260923);
  let hu = 0, no = 0;
  for (let round = 0; round < 20000; round++) {
    let h = makeWin(rand);
    // 一半的牌随手改一张，制造"差一点"的局面 —— 边界都在这儿
    if (rand(2)) { h = h.slice(); h[rand(14)] = rand(27); }
    const mine = canHu(h);
    const c = new Array(28).fill(0); for (const t of h) c[t]++;
    const naive = plainHu(c, 4, true);
    assert.equal(mine, naive, `不一致：${show(h)}`);
    mine ? hu++ : no++;
  }
  assert.ok(hu > 3000 && no > 3000, `胡 ${hu} / 不胡 ${no}，两边都得有足够样本`);
});

test('对账：判了胡的带红中牌，一定能把红中换回真牌照样胡（两千副）', () => {
  const rand = mulberry(77777);
  let checked = 0;
  for (let round = 0; round < 2000; round++) {
    const h = makeWin(rand);
    // 随手把 1~2 张换成红中，再随手改一张 —— 有的还能胡，有的不能
    const n = 1 + rand(2);
    for (let k = 0; k < n; k++) h[rand(14)] = HONG;
    if (rand(2)) h[rand(14)] = rand(27);
    if (!canHu(h)) continue;
    checked++;
    const base = h.filter(t => t !== HONG);
    const need = 14 - base.length;
    let found = false;
    /* 填回去的时候**不卡"每种四张"的上限** —— 赖子代表的是一个"角色"，不是一张实体牌。
       比如手里已经有四张一条，红中照样可以再当一张一条用（见下面那条专门的用例）。
       卡上限的话这条对账会误报，而误报会把人引到错误的方向上去。 */
    const tryFill = (start: number, left: number, c: number[]): boolean => {
      if (left === 0) return plainHu(c.slice(), 4, true);
      for (let t = start; t < 27; t++) { c[t]++; if (tryFill(t, left - 1, c)) { c[t]--; return true; } c[t]--; }
      return false;
    };
    const c0 = new Array(28).fill(0); for (const t of base) c0[t]++;
    found = tryFill(0, need, c0);
    assert.ok(found, `判了胡却换不出真牌：${show(h)}`);
  }
  assert.ok(checked >= 500, `样本太少（只验到 ${checked} 副）`);
});
