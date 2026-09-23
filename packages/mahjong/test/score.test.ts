import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreHu, scoreGang, maMultiplier } from '../src/score.ts';
import { HONG, tileOf } from '../src/tiles.ts';
const W = (r: number) => tileOf('wan', r);
const B = (r: number) => tileOf('tong', r);
const T = (r: number) => tileOf('tiao', r);

test('马牌倍数：点数即倍数，1 点算 9 倍', () => {
  assert.equal(maMultiplier(B(5)), 5);
  assert.equal(maMultiplier(W(9)), 9);
  assert.equal(maMultiplier(T(2)), 2);
  for (const one of [W(1), T(1), B(1)]) assert.equal(maMultiplier(one), 9, '一条一万一筒都算 9 倍');
  assert.equal(maMultiplier(HONG), 9, '红中跟一点一样，算 9 倍');
});

test('底分 1、翻到五筒、用了红中：每家 6 分', () => {
  const s = scoreHu(B(5), 2);
  assert.equal(s.maMult, 5);
  assert.equal(s.perPlayer, 6, '胡 1 倍 + 马 5 倍');
  assert.equal(s.total, 18, '三家各付');
  assert.equal(s.noHong, false);
});

test('无中胡再翻倍', () => {
  const s = scoreHu(B(5), 0);
  assert.equal(s.perPlayer, 12, '(1+5) × 2');
  assert.equal(s.total, 36);
  assert.ok(s.breakdown.some(l => l.includes('无中胡')));
});

test('翻到一点 + 无中胡：这一局最大', () => {
  const s = scoreHu(T(1), 0);
  assert.equal(s.perPlayer, 20, '(1+9) × 2');
  assert.equal(s.total, 60);
});

test('翻到红中当马：跟翻到一点一个价', () => {
  assert.equal(scoreHu(HONG, 1).perPlayer, 10, '(1+9)');
  assert.equal(scoreHu(HONG, 0).perPlayer, 20, '(1+9) × 2 —— 跟一点无中胡并列最大');
  assert.equal(scoreHu(HONG, 0).perPlayer, scoreHu(tileOf('tiao',1), 0).perPlayer);
});

test('杠分：明杠一倍、暗杠两倍，三家各付', () => {
  assert.equal(scoreGang('ming').perPlayer, 1);
  assert.equal(scoreGang('ming').total, 3);
  assert.equal(scoreGang('an').perPlayer, 2);
  assert.equal(scoreGang('an').total, 6);
  assert.equal(scoreGang('bu').perPlayer, 1, '碰杠（补杠）跟明杠一个价');
});

test('底分不是 1 的时候按比例走', () => {
  const s = scoreHu(B(5), 1, 3, { baseScore: 5, oneMultiplier: 9, hongMaMultiplier: 9, noHongMultiplier: 2, mingGang: 1, anGang: 2 });
  assert.equal(s.perPlayer, 30);
  assert.equal(s.total, 90);
});

test('分要守恒：胡牌者收的 = 三家付的', () => {
  for (const ma of [W(1), B(5), T(9), HONG]) for (const hong of [0, 1]) {
    const s = scoreHu(ma, hong);
    assert.equal(s.total, s.perPlayer * 3);
  }
});
