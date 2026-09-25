import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RoomView, PublicUser, ServerMsg, LedgerEntry } from '../../server/src/protocol.ts';
import { nameOf, isBig, partition, type Kind, type ActionOption, type GameEvent, type Meld } from '../../packages/engine/src/index.ts';
import { socket, api } from './net.ts';
import { note, report } from './log.ts';
import { Card, CardStack } from './Card.tsx';
import { autoSort, orderCol, orderCols, sortCol, affinity, revealCols, minXiOf, markInMelds, dropCardAt, keepCols } from './sort.ts';
import { cardFont, setCardFontNow, fontOptions, fontOptionsSorted, usedFont, uiFontOn, setUiFont } from './cardfont.ts';
import { GLYPHS } from './glyphs.ts';
import { RulesModal } from './Rules.tsx';
import { Avatar, Modal, ProfileModal, LedgerTable, fmt, toast, useUpright } from './ui.tsx';
import { drawTally, savePng, copyPng, type ShotRow } from './shot.ts';

/** 「2026-09-23 01:58」—— 图上写个时间，隔天翻出来知道是哪一场 */
function stamp(d = new Date()) {
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}

/**
 * 账单图预览：画好就摆在这儿，长按可以存（WebView 里这条最稳），
 * 底下再给「保存到相册」和「复制」两个按钮当快捷方式 —— 哪条走不通就提示长按。
 */
function ShotModal({ data, onClose }: { data: { title: string; sub: string; segLabel: string; rows: ShotRow[] }; onClose: () => void }) {
  /* 画一次就够了：dataURL 攥在手里，保存 / 复制都用它 */
  const url = useMemo(() => { try { return drawTally(data); } catch { return ''; } }, [data]);
  // 画不出来（canvas 被禁 / 内存不够）：老老实实说一声，别在渲染里丢 toast
  if (!url) return <Modal className="shot-modal" onClose={onClose}>
    <div className="col" style={{ gap: 10 }}><b>导不出图</b>
      <div className="muted">这台机器画不出画布，截屏发出去吧。</div>
      <button className="ghost" onClick={onClose}>关闭</button></div>
  </Modal>;
  const file = `跑胡子-${data.title.replace(/[^\u4e00-\u9fa5\w]+/g, '')}-${Date.now()}.png`;
  return <Modal className="shot-modal" onClose={onClose}>
    <div className="col" style={{ gap: 10, alignItems: 'stretch' }}>
      <b style={{ textAlign: 'center' }}>这一轮的账</b>
      <img className="shot-img" src={url} alt="账单" />
      <div className="muted" style={{ fontSize: 12, textAlign: 'center' }}>长按图片可直接保存 / 转发</div>
      <div className="row" style={{ justifyContent: 'center', gap: 8 }}>
        <button onClick={() => toast(savePng(url, file) ? '已保存' : '存不下来，长按上面那张图保存吧')}>保存图片</button>
        <button className="ghost" onClick={async () => toast(await copyPng(url) ? '已复制，去粘贴吧' : '这台机器不让复制图片，长按保存吧')}>复制</button>
        <button className="ghost" onClick={onClose}>关闭</button>
      </div>
    </div>
  </Modal>;
}
import { ReplayModal } from './Replay.tsx';
import { say, sayNow, unlockAudio, resetAudio, cardSpeech, cardKey, audioCtx, ACTION_WORDS, startRecording, stopRecording, playVoice, settings, startVoiceCommands, stopVoiceCommands, loadVoicePack, voicePack, setVoicePack, voicePacks } from './voice.ts';

/** 明牌 → 弃牌堆 / 下地区 这一趟飞行的时长 */
const LAND_MS = 300;
/** 倒计时颜色：只用绿和红两段 —— 中间那段橙黄跟金色按钮撞色，看不出还剩多少 */
/* 倒计时的颜色：绿 → 橙 → 红**连着变**（以前是过了 40% 直接从绿跳成红，看着一惊一乍）。
   色相从 140（绿）走到 35（橙）再走到 2（红），越少越红也越艳。 */
function ringColor(f: number) {
  const x = Math.max(0, Math.min(1, f));
  const hue = x > 0.4 ? 35 + ((x - 0.4) / 0.6) * (140 - 35) : 2 + (x / 0.4) * (35 - 2);
  const sat = 78 + (1 - x) * 12, light = 48 + (1 - x) * 6;
  return `hsl(${hue.toFixed(0)}, ${sat.toFixed(0)}%, ${light.toFixed(0)}%)`;
}
function beep(freq = 880, ms = 60, vol = 0.08, type: OscillatorType = 'square', delay = 0) {
  try {
    const ac = audioCtx(); if (!ac) return;
    const t0 = ac.currentTime + delay;
    const o = ac.createOscillator(); const gn = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    // 收尾淡出，免得"啪"一下爆音
    gn.gain.setValueAtTime(vol, t0);
    gn.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
    o.connect(gn).connect(ac.destination); o.start(t0); o.stop(t0 + ms / 1000 + 0.02);
  } catch { /* 无音频 */ }
}
function tick() { beep(880, 60, 0.08); }
/** 开局倒计时：最后 5 秒一秒一声，越数越高、越数越响；数到 0 再来一声"当当" */
function countTick(n: number) {
  if (n <= 0) { beep(784, 140, 0.13, 'triangle'); beep(1175, 220, 0.13, 'triangle', 0.13); return; }
  const f = n >= 5 ? 523 : n >= 4 ? 587 : n >= 3 ? 659 : n >= 2 ? 784 : 988;
  beep(f, n <= 2 ? 110 : 80, n <= 2 ? 0.13 : 0.1, 'triangle');
}
/**
 * 顶栏中间的"刘海框"：一段瓦房屋檐 —— 屋脊 + 微微翘起的飞檐 + 一排瓦当，
 * 房名 / 底分 / 局数这一行就挂在檐下。宽度占屏幕的一半。
 */
const EAVE_THEMES: Record<string, { a: string; b: string; c: string; trim: string }> = {
  qing: { a: '#2b3a33', b: '#1b2722', c: '#121a17', trim: 'rgba(242,193,78,.5)' },
  red: { a: '#6b2327', b: '#45151a', c: '#280c0f', trim: 'rgba(255,217,138,.62)' },
  blue: { a: '#24405f', b: '#172b42', c: '#0d1826', trim: 'rgba(190,220,255,.6)' },
  gold: { a: '#7a6528', b: '#54441a', c: '#2e250c', trim: 'rgba(255,233,168,.7)' },
  // 绿：跟牌桌一个色，像屋檐直接长在桌面上
  green: { a: '#1f7a58', b: '#166049', c: '#0f4530', trim: 'rgba(255,233,168,.55)' },
};
const EAVE_ORDER = ['green', 'qing', 'red', 'blue', 'gold'];

function EaveBar({ children, theme, onCycle }: { children: React.ReactNode; theme: string; onCycle: () => void }) {
  const W = 480, X0 = 26, X1 = W - 26, Y = 34, CY = 46;   // 檐口两端翘起、中间略沉
  const t = EAVE_THEMES[theme] ?? EAVE_THEMES.green;
  const pt = (k: number) => {
    const u = 1 - k;
    return [u * u * X0 + 2 * u * k * (W / 2) + k * k * X1, u * u * Y + 2 * u * k * CY + k * k * Y] as const;
  };
  const N = 22, R = (X1 - X0) / N / 2;                     // 一排瓦当
  const tiles = Array.from({ length: N }, (_, i) => {
    const [x, y] = pt((i + 0.5) / N);
    return `M ${(x - R).toFixed(1)} ${y.toFixed(1)} a ${R.toFixed(1)} ${(R * 0.9).toFixed(1)} 0 0 0 ${(R * 2).toFixed(1)} 0`;
  }).join(' ');
  return (
    <div className="eave" onClick={onCycle} title="点一下换个檐色">
      <svg viewBox={`0 0 ${W} 56`} preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id={`eaveFill-${theme}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={t.a} />
            <stop offset=".62" stopColor={t.b} />
            <stop offset="1" stopColor={t.c} />
          </linearGradient>
        </defs>
        {/* 檐身：两端微微外翘 */}
        <path fill={`url(#eaveFill-${theme})`} stroke={t.trim} strokeWidth="1.4"
          d={`M 0 0 H ${W} V 18 C ${W - 4} 30, ${X1 + 10} 24, ${X1} ${Y} Q ${W / 2} ${CY} ${X0} ${Y} C ${X0 - 10} 24, 4 30, 0 18 Z`} />
        {/* 屋脊那一道 */}
        <path fill="none" stroke={t.trim} strokeOpacity=".7" strokeWidth="1.2" d={`M 10 14 H ${W - 10}`} />
        {/* 一排瓦当 */}
        <path fill="none" stroke={t.trim} strokeOpacity=".85" strokeWidth="1.3" d={tiles} />
      </svg>
      <span className="eave-text">{children}</span>
    </div>
  );
}

/**
 * 牌桌底图：玩法水印 + 一幅淡淡的手绘。
 * 衡阳红黑 —— 衡山山脉，一群大雁往南飞（"雁阵惊寒，声断衡阳之浦"）。
 * 耒阳提龙 —— 皓月当空，弯弯的耒水绕着山走，石拱桥、稻田，和「千年古县」的城门。
 * 都画得很淡，不抢牌面。
 */
export function TableArt({ variant, name, onSky }: { variant: string; name: string; onSky?: () => void }) {
  const leiyang = variant === 'ly_tilong';
  /* 日头 / 月亮上盖一块看不见的热区 —— 底图整层是 pointer-events:none 的，
     这一块单独放行，点它就换一档亮度。位置按各自玩法里那颗天体的坐标来。 */
  const sky = onSky ? (
    <circle cx={leiyang ? 556 : 272} cy={leiyang ? 82 : 108} r={leiyang ? 96 : 92}
      fill="transparent" style={{ pointerEvents: 'auto', cursor: 'pointer' }}
      onClick={onSky} onPointerDown={e => e.stopPropagation()} />
  ) : null;
  return (
    <div className="table-art" aria-hidden>
      <svg viewBox="0 0 852 393" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="artFar" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity=".16" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="artNear" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#000000" stopOpacity=".18" />
            <stop offset="1" stopColor="#000000" stopOpacity="0" />
          </linearGradient>
          {/* 朝阳的光晕：中间亮、四周化开 */}
          <radialGradient id="artSunGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#ffe3a0" stopOpacity=".34" />
            <stop offset=".4" stopColor="#ffe3a0" stopOpacity=".13" />
            <stop offset="1" stopColor="#ffe3a0" stopOpacity="0" />
          </radialGradient>
          {/* 月晕：中间亮、四周化开 */}
          <radialGradient id="artMoon" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#fffbe8" stopOpacity=".34" />
            <stop offset=".45" stopColor="#fffbe8" stopOpacity=".12" />
            <stop offset="1" stopColor="#fffbe8" stopOpacity="0" />
          </radialGradient>
        </defs>

        {leiyang ? (
          <g>
            {/* 夜色：一轮皓月悬在半空 + 零星几点星子 —— 月亮比先前大一圈，往左挪、挂得更高 */}
            <circle cx="556" cy="82" r="112" fill="url(#artMoon)" />
            <circle cx="556" cy="82" r="72" fill="url(#artMoon)" />
            <circle cx="556" cy="82" r="34" fill="#fffbe8" fillOpacity=".82" />
            {/* 月面上淡淡的阴影，别画成一个死白圆盘 */}
            <circle cx="566" cy="73" r="26" fill="#0f3d2e" fillOpacity=".1" />
            <circle cx="545" cy="92" r="8" fill="#0f3d2e" fillOpacity=".07" />
            <g fill="#ffffff">
              {[[92, 44, 1.7, .5], [148, 82, 1.2, .35], [214, 40, 1.5, .45], [286, 74, 1.1, .3],
                [352, 36, 1.8, .5], [430, 68, 1.2, .32], [498, 30, 1.4, .42], [566, 62, 1.1, .3],
                [634, 40, 1.6, .46], [806, 96, 1.3, .36], [676, 96, 1.1, .28], [122, 118, 1.2, .3]].map(([x, y, r, o], i) => (
                <circle key={i} cx={x} cy={y} r={r} fillOpacity={o} />
              ))}
              {/* 两颗大一点的，带十字光芒 */}
              <path d="M262 108 l0 -9 l0 18 M262 108 l-9 0 l18 0" stroke="#ffffff" strokeOpacity=".4" strokeWidth="1.4" />
              <path d="M604 112 l0 -7 l0 14 M604 112 l-7 0 l14 0" stroke="#ffffff" strokeOpacity=".33" strokeWidth="1.3" />
            </g>

            {/* 层峦叠嶂：三道曲线山脊，一道比一道近、一道比一道淡 */}
            <path fill="url(#artFar)" d="M0 172 C 58 122, 104 152, 162 110 C 224 66, 282 142, 348 122
              C 418 100, 468 160, 540 134 C 612 108, 662 170, 730 142 C 788 118, 820 158, 852 142 L852 393 L0 393 Z" />
            <path fill="#ffffff" fillOpacity=".055" d="M0 214 C 70 176, 128 206, 196 168 C 266 130, 320 196, 394 178
              C 470 160, 512 212, 588 190 C 664 168, 704 214, 772 192 C 812 179, 834 198, 852 190 L852 393 L0 393 Z" />
            <path fill="#ffffff" fillOpacity=".04" d="M0 252 C 86 222, 150 248, 230 216 C 312 184, 372 240, 456 224
              C 540 208, 588 248, 668 230 C 744 213, 796 238, 852 226 L852 393 L0 393 Z" />

            {/* 弯弯的耒水：一条自北向南绕山的河 */}
            <path fill="none" stroke="#ffffff" strokeOpacity=".2" strokeWidth="16" strokeLinecap="round"
              d="M120 393 C 190 300, 120 250, 210 206 C 300 162, 330 214, 420 186 C 512 158, 545 196, 640 172 C 700 157, 730 168, 790 150" />
            <path fill="none" stroke="#ffffff" strokeOpacity=".14" strokeWidth="5" strokeLinecap="round"
              d="M120 393 C 190 300, 120 250, 210 206 C 300 162, 330 214, 420 186 C 512 158, 545 196, 640 172 C 700 157, 730 168, 790 150" />
            {/* 月亮落在水里的一道光 */}
            <path fill="none" stroke="#fffbe8" strokeOpacity=".16" strokeWidth="3" strokeLinecap="round"
              d="M660 176 C 682 170, 708 164, 736 158" />

            {/* 山上的植被：沿着山脊点几丛松和灌木，远处小、近处大 */}
            <g stroke="#ffffff" fill="none" strokeLinecap="round">
              {[[70, 150, .7], [118, 128, .6], [196, 118, .75], [262, 132, .6], [330, 126, .7],
                [404, 138, .6], [478, 144, .75], [556, 136, .6], [628, 150, .7], [706, 146, .6], [800, 148, .7]]
                .map(([x, y, k], i) => (
                  <g key={'p' + i} strokeOpacity={.1 + k * 0.12} strokeWidth={1.1 + k * 0.5}>
                    {/* 松：一根杆 + 三层斜枝 */}
                    <path d={`M${x} ${y} v${9 * k + 5}`} />
                    <path d={`M${x - 6 * k} ${y + 4} l${6 * k} -4 l${6 * k} 4`} />
                    <path d={`M${x - 7 * k} ${y + 8} l${7 * k} -4 l${7 * k} 4`} />
                  </g>
                ))}
              {/* 灌木：一簇一簇的小弧线 */}
              {/* 500~800 这一段是古城的天际线，灌木让开 */}
              {[[150, 196], [232, 188], [300, 200], [372, 192], [452, 204], [820, 200]]
                .map(([x, y], i) => (
                  <g key={'b' + i} strokeOpacity=".13" strokeWidth="1.6">
                    <path d={`M${x - 8} ${y} q 4 -7 8 0 q 4 -7 8 0`} />
                  </g>
                ))}
            </g>

            {/* 两岸的水稻田：一畦一畦的田埂，顺着河势排；田里点几丛秧苗 */}
            <g stroke="#ffffff" fill="none" strokeLinecap="round">
              <g strokeOpacity=".16" strokeWidth="1.6">
                {/* 北岸（河的上侧）：四畦 */}
                {/* 右边这一截到 500 就收住 —— 再往右是古城，留着空 */}
                <path d="M236 232 C 300 214, 366 226, 430 210 C 462 202, 484 204, 500 202" />
                <path d="M244 248 C 308 230, 372 242, 436 226 C 466 218, 488 220, 504 218" />
                <path d="M252 264 C 316 246, 380 258, 444 242 C 474 234, 494 236, 508 234" />
                <path d="M260 280 C 324 262, 388 274, 452 258 C 480 250, 498 252, 512 250" />
                {/* 田埂的横档：把长条分成一块一块的田 */}
                <path d="M300 220 l10 62 M372 224 l9 58 M446 210 l9 56" strokeOpacity=".12" />
                {/* 南岸（河的下侧）：三畦，短一点 */}
                <path d="M96 336 C 150 322, 206 330, 262 318 C 316 306, 356 318, 404 308" />
                <path d="M100 350 C 154 336, 210 344, 266 332 C 320 320, 360 332, 408 322" />
                <path d="M104 364 C 158 350, 214 358, 270 346 C 324 334, 364 346, 412 336" />
                <path d="M160 328 l8 40 M230 324 l8 38 M300 314 l8 38 M368 312 l7 36" strokeOpacity=".12" />
              </g>
              {/* 秧苗：一丛三笔 */}
              <g strokeOpacity=".2" strokeWidth="1.3">
                {[[276, 240], [340, 232], [408, 240], [462, 228],
                  [286, 272], [352, 264], [420, 270],
                  [130, 344], [196, 338], [262, 330], [330, 322], [386, 330], [150, 360], [222, 352], [292, 344]]
                  .map(([x, y], i) => (
                    <path key={'r' + i} d={`M${x} ${y} l-3 -7 M${x} ${y} v-8 M${x} ${y} l3 -7`} />
                  ))}
              </g>
            </g>

            {/* 石拱桥：横跨在河面上 —— 桥墩踩在水里，桥洞底下透出水光，水里还有个倒影 */}
            <g>
              {/* 桥洞里的水（先画，好让桥压在上面） */}
              <path d="M128 288 q 30 -30 58 -6 q -28 22 -58 6 Z" fill="#fffbe8" fillOpacity=".07" />
              <g stroke="#ffffff" fill="none" strokeLinecap="round">
                {/* 桥身：两道拱线之间就是桥面 */}
                <path d="M96 292 C 122 246, 196 240, 226 284" strokeOpacity=".4" strokeWidth="3" />
                <path d="M96 300 C 124 258, 196 252, 226 292" strokeOpacity=".3" strokeWidth="2.4" />
                {/* 桥洞 */}
                <path d="M126 292 q 32 -34 62 -6" strokeOpacity=".26" strokeWidth="2" />
                {/* 栏杆：望柱一根根立在桥面上 */}
                <path d="M104 288 v-9 M124 272 v-9 M148 262 v-10 M174 262 v-10 M198 272 v-9 M218 286 v-9"
                  strokeOpacity=".32" strokeWidth="1.8" />
                <path d="M100 279 C 126 236, 196 230, 222 277" strokeOpacity=".26" strokeWidth="1.6" />
                {/* 桥墩：踩进水里 */}
                <path d="M100 292 v18 M222 288 v18" strokeOpacity=".3" strokeWidth="3" />
                <path d="M92 310 h18 M214 308 h18" strokeOpacity=".22" strokeWidth="2" />
                {/* 两头的引桥落在岸上 */}
                <path d="M78 300 l20 -8 M226 286 l20 6" strokeOpacity=".24" strokeWidth="2.4" />
                {/* 桥在水里的倒影：淡淡一道，断续的 */}
                <path d="M104 316 C 130 334, 190 336, 216 314" strokeOpacity=".12" strokeWidth="2" strokeDasharray="7 6" />
              </g>
              {/* 桥上一个挑担过桥的人 */}
              <g stroke="#ffffff" strokeOpacity=".34" strokeWidth="1.8" fill="none" strokeLinecap="round">
                <path d="M160 258 v-11 M160 258 l-5 10 M160 258 l6 10" />
                <path d="M150 247 h20" />
                <path d="M152 247 v5 a4 3 0 0 0 8 0 v-5 M162 247 v5 a4 3 0 0 0 8 0 v-5" strokeOpacity=".24" />
                <circle cx="160" cy="242" r="3" fill="#ffffff" fillOpacity=".3" stroke="none" />
                <path d="M154 239 q 6 -5 12 0" strokeOpacity=".3" />  {/* 斗笠 */}
              </g>
            </g>

            {/* 河边垂柳：干细高，枝条几乎垂直垂下来、末梢才往外飘一点（柳就得是这个样子） */}
            <g fill="none" strokeLinecap="round">
              {[[246, 318, 1], [432, 326, .85]].map(([x, y, k], i) => (
                <g key={'w' + i} stroke="#ffffff">
                  {/* 干 + 两根杈 */}
                  <path d={`M${x} ${y} c 4 ${-22 * k}, -2 ${-36 * k}, ${3 * k} ${-56 * k}`} strokeOpacity=".32" strokeWidth={3.6 * k} />
                  <path d={`M${x + 3 * k} ${y - 56 * k} c ${-8 * k} ${-5 * k}, ${-13 * k} ${-8 * k}, ${-18 * k} ${-10 * k}`} strokeOpacity=".26" strokeWidth={2 * k} />
                  <path d={`M${x + 3 * k} ${y - 56 * k} c ${8 * k} ${-5 * k}, ${13 * k} ${-7 * k}, ${18 * k} ${-9 * k}`} strokeOpacity=".26" strokeWidth={1.9 * k} />
                  {/* 树冠：一道拱，枝条就从这道拱上垂下去 */}
                  <path d={`M${x - 22 * k} ${y - 56 * k} q ${25 * k} ${-16 * k}, ${50 * k} 0`} strokeOpacity=".2" strokeWidth={1.6 * k} />
                  {/* 垂条：起点沿着树冠排开，往下几乎是直的，末梢才飘一点 */}
                  <g strokeOpacity=".24" strokeWidth={1.15 * k}>
                    {[-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map(j => {
                      const far = Math.abs(j) / 5;
                      const x0 = x + 3 * k + j * 4.6 * k;
                      const top = y - (62 - far * 8) * k;      // 中间的挂得高、两边略低
                      const len = (44 - far * 12) * k;         // 中间垂得长
                      const tip = (j < 0 ? -1 : 1) * (3 + far * 4) * k;
                      return <path key={j} d={`M${x0} ${top} c 0 ${len * .45}, ${tip * .4} ${len * .78}, ${tip} ${len}`} />;
                    })}
                  </g>
                  {/* 叶：顺着垂条点几笔 */}
                  <g stroke="none" fill="#ffffff" fillOpacity=".15">
                    {[[-4, 14], [-3, 28], [-2, 20], [-1, 34], [0, 24], [1, 36], [2, 18], [3, 30], [4, 16]].map(([j, dy], q) => {
                      const cx = x + 3 * k + j * 4.8 * k, cy = y - (58 - dy) * k;
                      return <ellipse key={q} cx={cx} cy={cy} rx={2.4 * k} ry={1 * k}
                        transform={`rotate(${j < 0 ? -70 : 70} ${cx} ${cy})`} />;
                    })}
                  </g>
                  {/* 树根那一点土坡 */}
                  <path d={`M${x - 11 * k} ${y + 2} q ${11 * k} ${-5 * k}, ${22 * k} 0`} strokeOpacity=".16" strokeWidth={1.6 * k} />
                </g>
              ))}
            </g>

            {/* 田里、岸上的人：插秧的、牵牛的、挑担赶集的 —— 都带斗笠 */}
            <g stroke="#ffffff" strokeOpacity=".34" strokeWidth="1.9" fill="none" strokeLinecap="round">
              {/* 弯腰插秧的两个：背拱着，手伸到水里 */}
              <g>
                <path d="M344 258 c 6 -10, 14 -12, 22 -6" strokeWidth="2.2" />
                <path d="M366 252 l6 8 M344 258 l-2 10 M352 262 l1 8" />
                <circle cx="341" cy="256" r="3" fill="#ffffff" fillOpacity=".32" stroke="none" />
                <path d="M334 254 q 7 -6 14 -1" strokeOpacity=".3" />
              </g>
              {/* 牵牛的那一组原先正杵在城门口，把古城挡得满满当当 —— 索性去掉，
                  这一片留着空，古城才立得出来。田里留插秧的、桥上留挑担的，够热闹了 */}
            </g>

            {/* 千年古县的城门：**斜着对着我们**（正面偏左，右边那面墙往后退）——
                城台 + 拱形门洞 + 两重檐城楼，门额一块匾，「千年古县」是照小篆的样子一笔一笔描的
                （不靠字体，手机上没装篆书也照样是这个样） */}
            {(() => {
              const DX = 44, DY = -20;                     // 侧面往后退的偏移（斜视）
              const L = 600, R = 752, TOP = 268, BOT = 346; // 正面：左右 / 上下
              const p = (x: number, y: number) => `${x} ${y}`;
              const back = (x: number, y: number) => `${x + DX} ${y + DY}`;
              // 小篆四个字：按 12 × 16 的格子描，位置再整体摆过去
              const ZHUAN: string[][] = [
                // 千
                ['M2 3.4 C4.6 1.2, 7.6 1.4, 10 3.2', 'M1.6 7.2 H10.4', 'M6.2 3 C6.4 7, 6 11, 4.9 15.4'],
                // 年
                ['M2 2.8 C4.6 1, 7.6 1.2, 10 2.8', 'M6.1 2.4 V15.2', 'M2.2 6.4 H9.9', 'M2.2 10.6 H9.9',
                 'M3.4 15.2 C4.2 13, 5 12.2, 6.1 12'],
                // 古
                ['M6 1 V6.6', 'M2 4 H10',
                 'M2.6 8 C2.6 7.4, 3.1 7.2, 3.6 7.2 H8.4 C8.9 7.2, 9.4 7.4, 9.4 8 V14.4 C9.4 15, 8.9 15.2, 8.4 15.2 H3.6 C3.1 15.2, 2.6 15, 2.6 14.4 Z'],
                // 县
                ['M3 1.8 C3 1.3, 3.4 1.2, 3.8 1.2 H8.2 C8.6 1.2, 9 1.3, 9 1.8 V7.6 C9 8.1, 8.6 8.2, 8.2 8.2 H3.8 C3.4 8.2, 3 8.1, 3 7.6 Z',
                 'M3 4.2 H9', 'M3 6 H9', 'M6 8.4 V12.6',
                 'M4 15 C4.4 12.8, 5.1 11.8, 6 11.6', 'M8 15 C7.6 12.8, 6.9 11.8, 6 11.6'],
              ];
              return (
                <g transform="translate(676 318) scale(.92) translate(-676 -318) translate(0 -40)"
                  stroke="#ffffff" fill="none" strokeLinecap="round">
                  {/* ① 侧面那堵墙（往后退的一面，压暗一点） */}
                  <g strokeOpacity=".2" strokeWidth="2">
                    <path d={`M${p(R, BOT)} L${back(R, BOT)} L${back(R, TOP)} L${p(R, TOP)}`}
                      fill="#ffffff" fillOpacity=".04" />
                    {/* 侧面的砖缝 */}
                    <path d={`M${p(R, 300)} L${back(R, 300)} M${p(R, 322)} L${back(R, 322)}`} strokeOpacity=".12" />
                    {/* 侧面的垛口 */}
                    <path d={`M${back(R, TOP)} l0 -10 l10 0 l0 8 l10 0 l0 -8 l10 0 l0 10`} strokeOpacity=".16" />
                  </g>
                  {/* ② 正面：城台 + 垛口 + 门洞 */}
                  <g strokeOpacity=".34" strokeWidth="2.4">
                    <path d={`M${p(L, BOT)} V${TOP} M${p(R, BOT)} V${TOP} M${p(L, TOP)} H${R} M${L - 10} ${BOT} H${R + 6}`} />
                    {/* 左边接出去的城墙（也往后斜一点） */}
                    <path d={`M${L} 292 H520 M520 292 L500 284 M520 292 V${BOT} M520 ${BOT} H${L}`} strokeOpacity=".18" />
                    {/* 正面垛口 */}
                    <path d={`M${p(L, TOP)} l0 -10 l10 0 l0 -8 l10 0 l0 8 l10 0 l0 -8 l10 0 l0 8 l10 0 l0 -8 l10 0 l0 8
                      l10 0 l0 -8 l10 0 l0 8 l10 0 l0 -8 l10 0 l0 8 l10 0 l0 -8 l10 0 l0 8 l10 0 l0 -8 l10 0 l0 10`}
                      strokeOpacity=".24" />
                    {/* 拱形门洞：斜看是个略扁的拱，门里透出一点光 */}
                    <path d="M646 346 v-38 a28 26 0 0 1 56 0 v38" strokeWidth="2.6" />
                    <path d="M654 346 v-36 a20 19 0 0 1 40 0 v36 Z" fill="#ffe9b0" fillOpacity=".07" strokeOpacity=".2" />
                    {/* 门洞的进深：里侧那道边 */}
                    <path d="M702 346 l10 -5 v-34 a26 24 0 0 0 -12 -19" strokeOpacity=".16" strokeWidth="1.8" />
                  </g>
                  {/* ③ 城楼：两重檐，檐角也跟着往后斜 */}
                  <g strokeOpacity=".32" strokeWidth="2.2">
                    <path d="M606 262 C 634 246, 720 246, 748 262" />
                    <path d={`M600 262 H752 M${back(748, 262)} L748 262 M${back(606, 262)} L606 262`} strokeOpacity=".2" />
                    <path d={`M${back(606, 262)} C ${606 + DX + 26} ${246 + DY}, ${748 + DX - 26} ${246 + DY}, ${back(748, 262)}`}
                      strokeOpacity=".16" />
                    <path d="M616 262 v-16 M738 262 v-16" strokeOpacity=".26" />
                    <path d="M620 246 C 646 235, 708 235, 734 246" />
                    <path d="M614 246 H740" strokeOpacity=".24" />
                    <path d="M638 246 v-12 M676 246 v-12 M714 246 v-12" strokeOpacity=".18" />
                    <path d="M676 234 v-8 M672 226 l4 -7 l4 7" strokeOpacity=".3" />
                  </g>
                  {/* ④ 门额的匾：小篆「千年古县」，一笔一笔描的 */}
                  <g transform="rotate(-2 674 286)">
                    <rect x="628" y="274" width="92" height="24" rx="3" fill="#ffffff" fillOpacity=".08"
                      stroke="#ffe9b0" strokeOpacity=".32" strokeWidth="1.4" />
                    {ZHUAN.map((glyph, i) => (
                      <g key={i} transform={`translate(${634 + i * 22} 277) scale(1.05)`}
                        stroke="#ffe9b0" strokeOpacity=".62" strokeWidth="1.15" fill="none"
                        strokeLinecap="round" strokeLinejoin="round">
                        {glyph.map((d, j) => <path key={j} d={d} />)}
                      </g>
                    ))}
                  </g>
                  {/* ⑤ 门口两盏灯笼 */}
                  <g strokeOpacity=".3" strokeWidth="1.6">
                    <ellipse cx="628" cy="312" rx="7" ry="9" fill="#ffb37a" fillOpacity=".16" />
                    <path d="M628 303 v-5 M628 321 v5" />
                    <ellipse cx="722" cy="310" rx="6.6" ry="8.6" fill="#ffb37a" fillOpacity=".14" />
                    <path d="M722 301 v-5 M722 319 v5" />
                  </g>
                </g>
              );
            })()}

            {/* 小鸟：贴着水面掠过的几笔 */}
            <g stroke="#ffffff" strokeOpacity=".32" strokeWidth="2" fill="none" strokeLinecap="round">
              {[[430, 128], [456, 140], [486, 124], [188, 158], [216, 148]].map(([x, y], i) => (
                <path key={i} d={`M${x} ${y} q 7 -7 14 0 q 7 -7 14 0`} />
              ))}
            </g>

            {/* 近景坡地 */}
            <path fill="url(#artNear)" d="M0 330 C 140 300, 220 344, 340 330 C 470 314, 560 350, 700 332 C 780 322, 820 336, 852 330 L852 393 L0 393 Z" />
          </g>
        ) : (
          <g>
            {/* 初升的太阳：从最高那座峰后面冒出来，光芒一道道扫开（照亮周围） */}
            <g>
              {/* 太阳摆在庙的右前方：从山坳里刚冒头，别把庙盖住 */}
              <circle cx="272" cy="108" r="104" fill="url(#artSunGlow)" />
              <circle cx="272" cy="108" r="28" fill="#ffe9b0" fillOpacity=".48" />
              <circle cx="272" cy="108" r="18" fill="#fff6dc" fillOpacity=".72" />
              <g stroke="#ffe9b0" strokeLinecap="round" fill="none">
                {Array.from({ length: 18 }, (_, i) => {
                  const a = -100 + i * 18, r0 = 34, r1 = i % 2 ? 52 : 70, t = (a * Math.PI) / 180;
                  return <path key={i} strokeOpacity={i % 2 ? .12 : .2} strokeWidth={i % 2 ? 1.6 : 2.4}
                    d={`M${272 + Math.cos(t) * r0} ${108 + Math.sin(t) * r0} L${272 + Math.cos(t) * r1} ${108 + Math.sin(t) * r1}`} />;
                })}
              </g>
              {/* 朝阳把庙这一侧的山脊照亮一道 */}
              <path fill="none" stroke="#ffe9b0" strokeOpacity=".22" strokeWidth="2.6" strokeLinecap="round"
                d="M176 88 C 192 92, 206 116, 224 132 C 240 146, 254 142, 268 138" />
            </g>

            {/* 衡山七十二峰：三层曲线山脊，一层比一层近、一层比一层实。最高那座在左边 */}
            <path fill="url(#artFar)" d="M0 196 C 46 176, 74 152, 104 136 C 126 124, 140 92, 158 90
              C 178 88, 192 122, 218 140 C 252 164, 286 134, 322 146 C 360 158, 386 188, 428 176
              C 470 164, 500 186, 546 180 C 596 174, 626 198, 676 190 C 728 182, 776 202, 852 192 L852 393 L0 393 Z" />
            <path fill="#ffffff" fillOpacity=".07" d="M0 240 C 60 226, 96 198, 140 186 C 176 176, 200 150, 224 154
              C 252 158, 268 196, 306 208 C 346 220, 382 192, 424 202 C 470 212, 498 234, 548 226
              C 602 218, 644 240, 700 232 C 760 224, 806 244, 852 236 L852 393 L0 393 Z" />
            <path fill="#ffffff" fillOpacity=".05" d="M0 284 C 74 272, 124 246, 186 238 C 240 231, 280 254, 336 262
              C 398 271, 448 246, 510 254 C 572 262, 612 284, 676 276 C 744 268, 800 286, 852 280 L852 393 L0 393 Z" />

            {/* 南岳庙：坐在最高那座峰顶 —— 两重檐、山门、幡旗 */}
            <g stroke="#ffffff" fill="none" strokeLinecap="round">
              <g strokeOpacity=".46" strokeWidth="2.2">
                {/* 上檐 */}
                <path d="M132 84 C 142 74, 166 74, 176 84" />
                <path d="M128 84 h52 M136 84 v10 M172 84 v10" />
                {/* 下檐（比上檐宽，翘角） */}
                <path d="M122 96 C 138 86, 170 86, 186 96" />
                <path d="M118 96 h72 M126 96 v14 M182 96 v14" />
                {/* 殿身 + 门 */}
                <path d="M126 110 h56 M140 110 v-9 h12 v9" strokeOpacity=".3" />
                {/* 台基 */}
                <path d="M118 110 h72 M114 114 h80" strokeOpacity=".28" />
                {/* 宝顶 */}
                <path d="M154 74 v-8 M150 66 l4 -6 l4 6" strokeOpacity=".44" />
              </g>
              {/* 幡旗：庙两侧各一杆 */}
              <g strokeOpacity=".3" strokeWidth="1.6">
                <path d="M110 112 v-26 M110 86 c 8 2, 10 6, 0 8" />
                <path d="M196 112 v-24 M196 88 c -8 2, -10 6, 0 8" />
              </g>
              {/* 上山的石阶：从山脚一路数上去 */}
              <g strokeOpacity=".18" strokeWidth="1.5">
                {[0, 1, 2, 3, 4, 5, 6, 7].map(i => (
                  <path key={i} d={`M${172 + i * 9} ${120 + i * 11} l${10 + i} 0`} />
                ))}
              </g>
            </g>

            {/* 山脚下连绵的树：一丛一丛的松，底下一排灌木 */}
            <g stroke="#ffffff" fill="none" strokeLinecap="round">
              {Array.from({ length: 26 }, (_, i) => {
                const x = 18 + i * 32.5;
                const k = 0.75 + ((i * 37) % 10) / 20;                 // 高矮错落
                const y = 268 + ((i * 53) % 9) - 4;
                return <g key={'t' + i} strokeOpacity={.14 + (k - .75) * .12} strokeWidth={1.3 + k * .5}>
                  <path d={`M${x} ${y} v${-7 * k}`} />
                  <path d={`M${x - 7 * k} ${y - 5 * k} l${7 * k} ${-7 * k} l${7 * k} ${7 * k}`} />
                  <path d={`M${x - 8.5 * k} ${y - 11 * k} l${8.5 * k} ${-8 * k} l${8.5 * k} ${8 * k}`} />
                  <path d={`M${x - 6.5 * k} ${y - 18 * k} l${6.5 * k} ${-7 * k} l${6.5 * k} ${7 * k}`} />
                </g>;
              })}
              {/* 树下的灌木：低低的一排小弧 */}
              {Array.from({ length: 34 }, (_, i) => {
                const x = 12 + i * 25;
                const y = 286 + ((i * 41) % 7);
                return <path key={'s' + i} strokeOpacity=".12" strokeWidth="1.6"
                  d={`M${x - 8} ${y} q 4 -7 8 0 q 4 -7 8 0`} />;
              })}
            </g>

            {/* 纪念碑：矗立在右边的坡上 —— 碑身细高，碑座三级，顶上一颗星。
                碑上不刻字：一座碑立在那儿就够了，写上年份反倒像在给牌桌配说明。 */}
            <g stroke="#ffffff" fill="none" strokeLinecap="round">
              <g strokeOpacity=".38" strokeWidth="2.4">
                <path d="M596 300 v-96 M622 300 v-96" />
                <path d="M592 204 h34 M598 204 l5 -14 h12 l5 14" strokeOpacity=".32" />
                {/* 顶上的星 */}
                <path d="M609 186 l3.4 6.6 l7.4 1 l-5.4 5 l1.3 7.2 l-6.7 -3.5 l-6.7 3.5 l1.3 -7.2 l-5.4 -5 l7.4 -1 Z"
                  strokeOpacity=".5" strokeWidth="1.6" fill="#ffffff" fillOpacity=".18" />
                {/* 碑座三级 */}
                <path d="M588 300 h42 M582 308 h54 M574 316 h70" strokeOpacity=".3" />
              </g>
              {/* 碑面留白：原来竖刻「衡阳保卫」、底下一行 1937，现在都去掉了。
                  碑身上补两道极淡的竖线，看着还是块立起来的石碑，不至于空成一根柱子。 */}
              <g strokeOpacity=".12" strokeWidth="1.2">
                <path d="M602 216 v70 M616 216 v70" />
              </g>
              {/* 碑前两级台阶和一圈松柏 */}
              <g strokeOpacity=".16" strokeWidth="1.5">
                <path d="M566 324 h86 M560 330 h98" />
                <path d="M556 316 v-9 M556 307 l-5 5 M556 307 l5 5 M664 316 v-9 M664 307 l-5 5 M664 307 l5 5" />
              </g>
            </g>

            {/* 过往工业化的旧迹：往后退一层 —— 缩到七成五、压暗一点，贴在中景山脚下 */}
            <g transform="translate(700 214) scale(.75) translate(-700 -214)">
              <g stroke="#ffffff" fill="none" strokeLinecap="round">
                <g strokeOpacity=".2" strokeWidth="2">
                  {/* 锯齿屋顶的老厂房 */}
                  <path d="M690 262 v-28 M836 262 v-28 M690 262 h146" />
                  <path d="M690 234 l18 -14 l0 14 l18 -14 l0 14 l18 -14 l0 14 l18 -14 l0 14 l18 -14 l0 14 l18 -14 l0 14 l18 -14 l0 14" />
                  <g strokeOpacity=".13" strokeWidth="1.3">
                    {[0, 1, 2, 3, 4, 5, 6].map(i => <path key={i} d={`M${700 + i * 20} 256 v-12 h12 v12 Z`} />)}
                  </g>
                  {/* 烟囱：一高一矮，顶上有箍；高的还冒着一缕淡烟 */}
                  <path d="M754 220 l4 -76 l12 0 l4 76" />
                  <path d="M756 152 h20 M757 166 h18" strokeOpacity=".16" />
                  <path d="M806 224 l3 -50 l10 0 l3 50" strokeOpacity=".17" />
                  <path d="M764 142 c -8 -10, 6 -16, -2 -26 c -6 -8, 4 -12, 0 -18" strokeOpacity=".13" strokeWidth="1.8" />
                  {/* 水塔 */}
                  <path d="M666 262 v-30 M686 262 v-30 M660 232 h32 M662 232 l4 -12 h20 l4 12" strokeOpacity=".17" />
                </g>
              </g>
            </g>

            {/* 铁路 + 火车：挪到左边、抬高一点 —— 别被近景坡地吃掉，也别压着纪念碑 */}
            <g transform="translate(-338 -44)" stroke="#ffffff" fill="none" strokeLinecap="round">
              <g strokeOpacity=".2" strokeWidth="1.7">
                <path d="M392 352 L852 322 M396 364 L852 334" />
                {Array.from({ length: 24 }, (_, i) => (
                  <path key={i} d={`M${400 + i * 19} ${363 - i * 1.25} l-4 -11`} strokeOpacity=".14" />
                ))}
              </g>
              {/* 一列蒸汽小火车：车头 + 三节车厢，正从右边开过来 */}
              <g strokeOpacity=".4" strokeWidth="2">
                {/* 车头：锅炉、驾驶室、排障器、烟囱 */}
                <path d="M470 344 h58 v-20 h-14 v-10 h-26 v10 h-18 Z" fill="#ffffff" fillOpacity=".07" />
                <path d="M484 314 v-8 h10 v8" />                        {/* 烟囱 */}
                <path d="M470 344 l-10 0 l-4 -8" strokeOpacity=".3" />   {/* 排障器 */}
                <path d="M514 324 h14" strokeOpacity=".26" />
                {/* 车轮 */}
                <g strokeOpacity=".34">
                  <circle cx="480" cy="349" r="5" /><circle cx="496" cy="349" r="5" /><circle cx="516" cy="349" r="4" />
                  <path d="M474 354 h50" strokeOpacity=".2" />
                </g>
                {/* 三节车厢：一节比一节远，跟着轨道往上抬 */}
                {[0, 1, 2].map(i => {
                  const x = 540 + i * 62, y = 340 - i * 4.4;
                  return <g key={i} strokeOpacity={.32 - i * 0.04}>
                    <path d={`M${x} ${y} h54 v-22 h-54 Z`} fill="#ffffff" fillOpacity=".05" />
                    <path d={`M${x + 8} ${y - 6} v-10 h12 v10 M${x + 30} ${y - 6} v-10 h12 v10`} strokeOpacity=".16" />
                    <circle cx={x + 12} cy={y + 5} r="4" /><circle cx={x + 42} cy={y + 5} r="4" />
                    <path d={`M${x - 6} ${y - 10} h6`} strokeOpacity=".2" />
                  </g>;
                })}
                {/* 车头喷的烟：一团一团往后飘 */}
                <g strokeOpacity=".18" strokeWidth="1.8">
                  <path d="M489 306 c -6 -8, 4 -14, -1 -20" />
                  <path d="M500 298 c 6 -7, 16 -5, 18 2 c 6 -2, 10 4, 5 7 l-22 0 c -4 0 -5 -6 -1 -9" />
                  <path d="M534 286 c 5 -6, 14 -4, 15 2 c 5 -2, 9 3, 4 6 l-19 0 c -3 0 -4 -5 0 -8" />
                </g>
              </g>
            </g>

            {/* 雁阵：一个人字，往南（画面右下）飞 */}
            <g stroke="#ffffff" strokeOpacity=".4" strokeWidth="2.6" fill="none" strokeLinecap="round">
              {[[300, 56], [340, 70], [380, 84], [420, 98], [346, 44], [388, 58], [430, 72], [472, 86]].map(([x, y], i) => (
                <path key={i} d={`M${x} ${y} q 9 -8 18 0 q 9 -8 18 0`} />
              ))}
            </g>
            {/* 近景松林剪影 */}
            <path fill="url(#artNear)" d="M0 336 C 120 316, 200 352, 320 338 C 450 322, 540 356, 660 340 C 750 328, 800 344, 852 338 L852 393 L0 393 Z" />
          </g>
        )}
        {sky}
      </svg>
      <div className="table-mark">{name}</div>
    </div>
  );
}

/**
 * 飞过去的那张牌。位移 + 缩放放在同一条 transform 里，用 Web Animations 播 ——
 * 边飞边缩，落点上刚好跟那一摞的牌一样大；播完**停在落点**（fill: 'forwards'），
 * 等那一摞真把牌画出来了外面再撤掉它。
 */
function LandCard({ land }: { land: { card: Kind; x0: number; y0: number; x1: number; y1: number; w?: number; w0?: number; snap?: boolean; fx?: 'star' | 'rain' } }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    /* 两头都**照实际量出来的宽度**算：起飞那一下跟明牌一样大，落地那一下跟那一摞里的牌一样大。
       以前两头都是写死的（起飞按 xl 的 48px、落地按 20px），牌一放大就对不上 ——
       大字版里明牌是放大过的，落点那些牌也大了一圈，飞的这张却还按老尺寸缩，
       起飞时"啪"地缩一下、落地又比旁边的牌小一圈。 */
    const k = ((land.w ?? 20) / 48);              // xl 牌 48px 宽，落点多宽就缩多少
    const k0 = ((land.w0 ?? 48) / 48);            // 起飞时多宽（明牌那张实际画出来的宽度）
    const from = `translate(-50%, -50%) translate(${land.x0}px, ${land.y0}px) scale(${k0.toFixed(3)})`;
    const to = `translate(-50%, -50%) translate(${land.x1}px, ${land.y1}px) scale(${k.toFixed(3)})`;
    el.style.transform = to;                      // 动画播完就停在这儿（不靠 fill 也不会弹回去）
    /* snap：飞完之后按真实落点校一下位置 —— 这时候牌已经停住了，
       再重播一遍动画反而会"倒回去重飞"，所以直接摆过去。 */
    if (land.snap) return;
    const anim = el.animate?.([{ transform: from }, { transform: to }],
      { duration: LAND_MS, easing: 'cubic-bezier(.35,.05,.25,1)', fill: 'both' });
    return () => { try { anim?.cancel(); } catch { /* ignore */ } };
  }, [land.x0, land.y0, land.x1, land.y1, land.w, land.w0, land.snap]);
  /* 飞的这一路上牌化成一道光（进牌是星光、弃牌是雨滴），落地那一下再显出牌来。
     光是画在同一个元素里的，跟着一起缩 —— 所以越飞越小，落地正好收成一个点。 */
  return <div className={`land-card ${land.fx ? 'as-' + land.fx : ''}`} ref={ref}>
    <Card kind={land.card} size="xl" head highlight /></div>;
}

/**
 * 行动按钮上的倒计时：**围着那个字画一圈**，剩多少走多少。
 * 画在按钮上面（不占地方），线走完这一手也就到点了。
 */
/** 一枚行动按钮：按钮本体 + 贴着内沿走的倒计时圈 */
function ActBtn({ t, frac, lastCall, locked, waitingAct, label, pulse, ghost, onPress }:
  { t: string; frac: number | null; lastCall?: boolean; locked: boolean; waitingAct: string | null; label: string; pulse: boolean; ghost?: boolean; onPress: () => void }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <span className={`act-wrap ${frac !== null ? 'timed' : ''} ${t === 'pass' ? 'act-pass' : ''} ${ghost ? 'act-ghost' : ''}`}>
      {/* 这里以前写的是 `disabled={locked}`。**浏览器不会给 disabled 的按钮派发任何指针事件** ——
          于是一旦锁住（上一步点过、还在等服务端揭晓），玩家再点就是石沉大海：
          没动作、没提示、也没日志，看着就是"按钮明明在，点了没反应"。
          现在照样接事件，锁没锁交给 pressButton 去判断并说一句话。 */}
      <button ref={ref} aria-disabled={locked || undefined}
        /* 碰 / 跑 跟胡一样是"半程"的，按钮也用同一套酒红 */
        className={`act-btn ${t === 'hu' || t === 'peng' || t === 'pao' ? 'hu' : ''} ${pulse ? 'pulse' : ''} ${lastCall && !locked ? 'last-call' : ''} avail ${locked ? (waitingAct === t ? 'chosen' : 'idle') : ''}`}
        /* 倒计时不再在按钮外面描一圈（那一圈又抢眼又跟按钮错位），
           改成**整个按钮自己褪色**：本来的颜色一点点往灰里走，走到灰就该消失了 ——
           跟"这个选择正在失效"是同一件事，眼睛不用分心去读一圈进度。
           只给 opacity 挂过渡：颜色一秒跳四档就够顺了，而 filter 挂过渡等于
           每帧都要重新算一遍滤镜，手机会烫（之前排查发热踩过这个坑）。 */
        style={frac === null || locked ? undefined : lastCall ? {
          /* 最后一秒：颜色**快速**回满，不是"啪"地跳回去。
             一跳会像另换了个按钮；用 .18 秒滑回来，既看得出"它又亮了"，又不拖泥带水。
             透明度和缩放交给下面那条闪烁的动画（动画的优先级高过行内样式）。 */
          filter: 'saturate(1) brightness(1.08)',
          transition: 'filter .18s ease-out',
        } : {
          filter: `saturate(${(0.15 + 0.85 * frac).toFixed(2)}) brightness(${(0.55 + 0.45 * frac).toFixed(2)})`,
          opacity: (0.42 + 0.58 * frac).toFixed(2),
          transition: 'opacity .25s linear, filter .18s ease-out',
        }}
        onPointerDown={e => { e.preventDefault(); onPress(); }}>
        {label}
      </button>
    </span>
  );
}

function ActRing({ frac, color, host }: { frac: number; color: string; host: React.RefObject<HTMLElement | null> }) {
  /* 圈贴着按钮**内沿**走一圈：按钮多大就画多大（量出来的），圆角跟按钮一致。
     走过的那一截不画（透出按钮本身的颜色，等于"流逝的跟按钮一样"），
     没走的那一截按剩余时间由绿转橙转红。 */
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = host.current; if (!el) return;
    const m = () => setBox({ w: el.offsetWidth, h: el.offsetHeight });
    m();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(m) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [host]);
  if (!box.w || !box.h) return null;
  const sw = 2.6, inset = sw / 2 + 1.2;
  const w = box.w - inset * 2, h = box.h - inset * 2;
  const rx = Math.min(h / 2, 12);
  const LEN = 1000;   // pathLength 归一化：不用自己算圆角矩形的周长
  return (
    /* 走过的那一截**什么都不画** —— 圈是嵌在按钮里沿的，不画就直接透出按钮本身的底色
       （吃是金黄、碰 / 胡是酒红），看着就跟按钮长在一起。
       以前这儿垫了一圈深色底，压在金黄的「吃」上格外扎眼。 */
    <svg className="act-ring" width={box.w} height={box.h} viewBox={`0 0 ${box.w} ${box.h}`} aria-hidden>
      <rect x={inset} y={inset} width={w} height={h} rx={rx} ry={rx} fill="none"
        stroke={color} strokeWidth={sw} strokeLinecap="round" pathLength={LEN}
        strokeDasharray={LEN} strokeDashoffset={LEN * (1 - frac)}
        /* 这儿以前挂着 `transition: stroke-dashoffset .25s linear`。
         看着是顺滑了，代价是：圈每 250ms 收到一个新值就补一段 250ms 的动画 —— 首尾相接，
         等于**整局游戏一直有一条 60 帧／秒的动画在跑**。而 stroke-dashoffset 合成器插不了值，
         每一帧都得重算样式、把这圈 SVG 重画一遍；屏上同时有三四个圈（三家头像 + 按钮），
         叠起来就是一份不小的持续开销。倒计时本来就是一秒跳四格，直接跳没人看得出来。 */ />
    </svg>
  );
}

/** 亮牌只标一个「胡」字：胡的那张牌落在哪一组，就标那一组打头的那张 */
/** 某一家当前的弃牌张数（事件自带的那份房间状态里的） */
function dcountOf(r: any, seat: number): number { return (r?.game?.players?.[seat]?.discards ?? []).length; }

function markIn(groups: Kind[][], card: Kind | null | undefined): number {
  if (card === null || card === undefined || card < 0) return -1;
  return groups.findIndex(g => g.includes(card));
}
const MELD_NAME: Record<string, string> = { peng: '碰', wei: '偎', pao: '开跑', ti: '提龙', long: '龙', chi: '吃' };
/** 牌组上的小标签：一个字够了（开跑→跑、提龙→提、下伙→伙） */
const MELD_TAG: Record<string, string> = { peng: '碰', wei: '偎', pao: '跑', ti: '提', long: '龙', chi: '吃' };
// 下地之后接着胡的叫法：提龙 / 开跑 / 偎起，各算各的
const BIG_HU_NAME: Record<string, string> = { ti: '提龙胡', long: '提龙胡', pao: '开跑胡', wei: '偎起胡', '': '胡牌' };
/** 胡的方式：吃胡 / 碰胡 / 提龙胡 / 开跑胡 / 偎起胡（自摸另外标） */
const HU_WAY_NAME: Record<string, string> = { chi: '吃胡', peng: '碰胡', ti: '提龙胡', long: '提龙胡', pao: '开跑胡', wei: '偎起胡' };
/* ---------- 牌桌设置菜单里的小图标：一个图标 + 一个字，尽量简洁 ---------- */
/** 平排：三张牌并排立着 */
function IconFlat() {
  return <svg className="tt-ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
    <rect x="2.5" y="5" width="5.6" height="14" rx="1.4" /><rect x="9.2" y="5" width="5.6" height="14" rx="1.4" /><rect x="15.9" y="5" width="5.6" height="14" rx="1.4" />
  </svg>;
}
/** 扇形：三张牌像扇子一样撇开 */
function IconFan() {
  return <svg className="tt-ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
    <rect x="9.2" y="5" width="5.6" height="14" rx="1.4" />
    <rect x="9.2" y="5" width="5.6" height="14" rx="1.4" transform="rotate(-24 12 19)" />
    <rect x="9.2" y="5" width="5.6" height="14" rx="1.4" transform="rotate(24 12 19)" />
  </svg>;
}
/** 机器人脑袋：自动理牌那个"智能"的意思 */
function IconBot() {
  return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M12 2.6v2.2" /><circle cx="12" cy="2" r="1.1" fill="currentColor" stroke="none" />
    <rect x="4" y="5.2" width="16" height="13.4" rx="4" />
    <circle cx="9" cy="11.4" r="1.5" fill="currentColor" stroke="none" /><circle cx="15" cy="11.4" r="1.5" fill="currentColor" stroke="none" />
    <path d="M9.4 15.4h5.2" />
  </svg>;
}
/** 声音：喇叭（关掉时打一把叉） */
function IconSound({ on }: { on: boolean }) {
  return <svg className="tt-ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 9.2h3.4L12 5.2v13.6l-4.6-4H4z" />
    {on ? <><path d="M15.6 9.4a3.6 3.6 0 0 1 0 5.2" /><path d="M18 7a7 7 0 0 1 0 10" /></>
        : <path d="m16 9.6 4.4 4.8m0-4.8L16 14.4" />}
  </svg>;
}
/** 起立离开：一个人从椅子上站起来走开 */
function IconStand() {
  return <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="4.6" r="2.1" />
    <path d="M9 7.2v6.4M9 13.6l-2.4 6M9 13.6l2.6 6M6.2 9.4h5.6" />
    <path d="M16.5 8.5v9h4" />
  </svg>;
}
/** 返回：往左的箭头 */
function IconBack() {
  return <svg className="tt-ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 5 3.5 12 10 19" /><path d="M3.9 12H20" />
  </svg>;
}

const ACTION_NAME: Record<string, string> = { hu: '胡', ti: '提', pao: '跑', wei: '偎', peng: '碰', chi: '吃', pass: '过', play_drawn: '打出', discard: '出牌' };

interface ChatItem { from: PublicUser; text?: string; voice?: { data: string; mime: string; durationMs: number }; time: number }

/* ---- 倒计时圈：起点由客户端定 ----
   服务端只说"这一手原本给多久"（span）和"到点是哪一刻"（until）。
   圈从**按钮真出现在屏幕上那一刻**开始走，走满整段 span ——
   帧在路上耽搁了多久、动画排队播了多久，一概不算进去。
   （服务端那头当然还是按自己的表判超时，只是它给的时限已经把这些都补进去了，
     再加上 800ms 宽限，客户端这圈走完的时候服务端一定还没关门。）

   为什么不接着用"到点时刻减现在"：那算出来的是**剩下**多少。
   这一帧但凡在路上多走半秒，圈就从九成开始；服务端那头要是先走掉一截，
   圈就从半格开始、还在剩下的半格时间里走完 —— 就是之前说的"先慢后嗖"。

   until 变了就重新起算（换了一轮、或者用了延时卡再给一段）。
   total 取 span 和"服务端说还剩多少"里小的那个：
   服务端**真的**把窗口压短了（比如别家已经表态、该收尾了），得认；
   但它永远不会比原本那段还长。 */
function useRing(until: number, span: number, now: number) {
  const ref = useRef<{ until: number; t0: number; total: number }>({ until: 0, t0: 0, total: 1 });
  if (until && ref.current.until !== until) {
    if (ref.current.until && until < ref.current.until) {
      /* 同一个窗口被**压短**了（别家已经表态、该收尾了）：不能重新起算 ——
         那会让圈"啪"一下跳回满格，再嗖地走完，看着像又给了一次时间。
         起点不动，只把终点提前，圈接着往下走就是了。 */
      ref.current = { until, t0: ref.current.t0, total: Math.max(200, until - ref.current.t0) };
    } else {
      // 新窗口，或者用延时卡又给了一段：从现在起算，走满整段
      const left = Math.max(1000, until - now);
      ref.current = { until, t0: now, total: span > 0 ? Math.min(span, left) : left };
    }
  }
  if (!until) return null;
  const left = Math.max(0, ref.current.t0 + ref.current.total - now);
  return { left, frac: Math.min(1, left / ref.current.total), sec: Math.ceil(left / 1000) };
}

export function Table({ room, me, onLeft }: { room: RoomView; me: PublicUser; onLeft: () => void }) {
  const g = room.game;
  const n = room.seats.length;
  const mySeat = room.mySeat ?? 0;
  const rel = (seat: number) => (seat - mySeat + n) % n; // 0=我 1=下家 2=上家
  const [selected, setSelected] = useState<{ col: number; idx: number } | null>(null);
  const [cols, setCols] = useState<Kind[][]>([]);
  const manualRef = useRef(false);
  /* 玩家自己拖出来的牌组：记下来「钉住」，之后自动理牌一律不动它们。
     只认牌面（同一组牌不管在第几列都算数），手里没有这几张了自然就失效。 */
  const pinsRef = useRef<Kind[][]>([]);
  const pinKey = (c: Kind[]) => sortCol(c).join(',');
  const pinDrop = (c: Kind[]) => { const k = pinKey(c); pinsRef.current = pinsRef.current.filter(p => pinKey(p) !== k); };
  /* 只有三张以上的才钉住 —— 那是"码好的一句"。两张的搭子还在变，自动理牌可以动它 */
  const pinAdd = (c: Kind[]) => { if (c.length >= 3) { pinDrop(c); pinsRef.current = [...pinsRef.current, c.slice()]; } };
  const dragRef = useRef<{ col: number; idx: number; x0: number; y0: number; started: boolean } | null>(null);
  /* 拖牌状态里**只放"会改变画面结构"的那几样**（哪张牌、高亮哪一列、在不在出牌区），
     **不放坐标**。坐标每帧都在变，一放进 state 就等于每帧重画整张牌桌 ——
     七列手牌、三家的牌、牌堆、倒计时圈全部重来一遍，每张牌还要重画一遍字形 SVG。
     iPhone 15 上就是这么卡的：帧掉了，高亮那一格自然跟不上手指。
     现在坐标直接写进那张跟手牌的 DOM 样式里（见 onWinMove），
     React 只在"高亮的列换了"或者"进出出牌区"的时候动一次 —— 一次拖动通常也就几次。 */
  const [drag, setDrag] = useState<{ card: Kind; overCol: number | null; zone: 'discard' | null } | null>(null);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const dragUiRef = useRef<{ overCol: number | null; zone: 'discard' | null } | null>(null);
  const lastTapRef = useRef<{ col: number; idx: number; t: number; x: number; y: number } | null>(null);
  const discardPromptRef = useRef(false);
  const settleShownRef = useRef<number | null>(null);   // 这一局的结算面板已经弹过了
  const myMeldCountRef = useRef(0);        // 我下地了几组（理牌要看：下过地就不是无胡了）
  const MAX_COL = 4;
  const MAX_COLS = 7;                      // 最多 7 组，限制住手牌的最大宽度（下地之后位置本来就够了）
  /** 超过 8 组时，把最右边的散张并到只有两张的牌组上面；cap 是每组张数上限（自动理牌用 3，手动用 4） */
  function packCols(cs: Kind[][], cap = MAX_COL): Kind[][] {
    let out = cs.filter(c => c.length).map(c => c.slice());
    const pass = (lim: number) => {
      let guard = 40;
      while (out.length > MAX_COLS && guard-- > 0) {
        let idx = -1;
        for (let i = out.length - 1; i >= 0; i--) if (out[i].length === 1) { idx = i; break; }
        if (idx < 0) idx = out.reduce((b, c, i) => (c.length < out[b].length ? i : b), 0);
        const moving = out[idx];
        // 落脚点也挑最搭的那一组（一样搭的话，挑本来就只有两张的）
        let t = -1, tAff = -1, tLen = 99;
        for (let i = 0; i < out.length; i++) {
          if (i === idx || out[i].length + moving.length > lim) continue;
          const aff = affinity(out[i], moving);
          if (aff > tAff || (aff === tAff && out[i].length < tLen)) { tAff = aff; tLen = out[i].length; t = i; }
        }
        if (t < 0) break;
        out[t] = [...moving, ...out[t]];     // 并到那一组"上面"
        out.splice(idx, 1);
      }
    };
    pass(cap);
    if (out.length > MAX_COLS && cap < MAX_COL) pass(MAX_COL);   // 实在压不到 7 组才允许出现四张
    return out;
  }
  /** 牌组是否已经够整齐：只有一张的不超过 1 组，两张及以下的不超过 2 组 */
  const tidyOk = (cs: Kind[][]) => cs.filter(c => c.length === 1).length <= 1 && cs.filter(c => c.length <= 2).length <= 2;
  /**
   * 把零碎的牌组两两并起来（每组不超过 3 张），直到够整齐。
   * 挑哪两组来并：先看"搭不搭"（同字 / 大小夹 / 连牌 / 一二三 / 二七十），再看并完是不是最小。
   * 例：三三 + 八 + 九玖 → 八 跟 九玖 并成「八九玖」，而不是把八塞进「三三」。
   */
  function tidy(cs: Kind[][]): Kind[][] {
    const out = cs.filter(c => c.length).map(c => c.slice());
    let guard = 20;
    while (!tidyOk(out) && guard-- > 0) {
      let a = -1, b = -1, bestAff = -1, bestLen = 99;
      for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
        const len = out[i].length + out[j].length;
        if (len > 3) continue;
        const aff = affinity(out[i], out[j]);
        if (aff > bestAff || (aff === bestAff && len < bestLen)) { bestAff = aff; bestLen = len; a = i; b = j; }
      }
      if (a < 0) break;                       // 并不动了就算了
      out[a] = [...out[a], ...out[b]];
      out.splice(b, 1);
    }
    return out;
  }
  /** 不是成句的牌组，按"连得紧的放下面、落单的放上面"摆 */
  const finishCols = (cs: Kind[][]) => cs.map(c => (c.length === 3 && partition(c, false).complete ? sortCol(c) : orderCol(c)));
  // 自动理牌：直接照 autoSort 的结果摆（坎在最左、成句其次、散牌按进张价值凑堆），
  // 组内顺序它也排好了，这里不再动
  // 理牌的口味：耒阳、而且我还没下过地，就要考虑"这手是不是奔着无胡去的"
  // （下地组数在渲染里往下几百行才算得出来，这里用 ref 拿，别去碰还没初始化的变量）
  const sortOpts = () => ({
    leiyang: room.variant === 'ly_tilong',
    hasMeld: myMeldCountRef.current > 0,
    // 开胡门槛是理牌的必要条件：已经下地的那几组也算数，所以把它们的息一并带上
    minXi: minXiOf(room.variant),
    meldXi: (((gs ?? g)?.players?.[mySeat]?.melds ?? []) as Meld[]).reduce((a, m) => a + (m.xi ?? 0), 0),
  });
  const autoCols = (hand: Kind[]) => autoSort(hand, sortOpts()).map(gp => gp.cards);
  /** 自动理牌（保留手码的三张一组）：自己码好的三张原样不动，只把其余的牌重新理一遍 */
  const autoColsKeep = (hand: Kind[], prev: Kind[][]) => {
    const rest = hand.slice();
    const kept: Kind[][] = [];
    /** 这一组还能从剩下的手牌里凑齐吗？能就摘出来钉住 */
    const take = (col: Kind[]) => {
      if (col.length < 3) return false;
      const tmp = rest.slice();
      if (!col.every(k => { const i = tmp.indexOf(k); if (i < 0) return false; tmp.splice(i, 1); return true; })) return false;
      kept.push(col.slice());
      for (const k of col) rest.splice(rest.indexOf(k), 1);
      return true;
    };
    // ① 玩家自己码好的三张（或四张）一律不动；手里已经没这几张的钉子顺手清掉
    pinsRef.current = pinsRef.current.filter(take);
    // ② 再把已经码成三张的列留着 —— 那也是他的思路，别给人拆了
    for (const col of prev) { if (col.length === 3) take(col); }
    /* 收尾按**左右次序**排（orderCols），不是按"哪组牌多"排。
       以前这儿是 byLen —— 只看张数：钉住的那几组只要是三张就一路排到最左边，
       哪怕它根本不成句。于是就有了"最左边冒出一组凑不成句的牌"。
       张数多≠该靠左，该靠左的是"已经成了、不用再动"的那几组。 */
    return orderCols([...kept, ...autoCols(rest)]);
  };
  const [chiPick, setChiPick] = useState<ActionOption | null>(null);
  const [chiStep, setChiStep] = useState<number | null>(null);   // 第二步：选了哪个吃法，正在确认下伙
  const [pending, setPending] = useState<string | null>(null);   // 我刚点的动作，等服务端揭晓
  const pendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const passedRef = useRef<string | null>(null);   // 我对桌上哪一张牌点过"过"（牌:出牌者:时刻）：这张还在桌上就不再给我按钮
  const [profile, setProfile] = useState<number | null>(null);
  // 手牌摆法：平排（默认）/ 扇形，本地记住
  const [fanMode, setFanMode] = useState<boolean>(() => { try { return localStorage.getItem('phz_fan') === '1'; } catch { return false; } });
  /* 大字版 / 小字版：整桌的牌和按钮一起放大两成。**默认大版**（看着舒服）。
     只存在本机（跟字体、报牌声一个路子），换台手机各挑各的。 */
  // 默认**大版**（没挑过就按大版来）；挑过小版的按挑的来
  /* 大小字版（默认大版）。
     它是在手牌那一层上套一层 CSS `zoom` —— 之前出牌线之所以在大版上跟牌分家，
     是因为线的位置靠"量这个被 zoom 过的盒子"反推，而各家浏览器对这件事的处理并不一致
     （Mac Safari 量出来的宽是没放大的那个）。现在线改成钉在手牌层里用 CSS 画，
     跟牌共用同一个 zoom，不再经过任何换算 —— 大版就不碍事了。 */
  /* 底图亮度三档：点一下日头 / 月亮就换一档（暗 → 正常 → 亮 → 暗…）。
     牌桌底图这东西众口难调 —— 有人嫌花、有人嫌暗，给一个就地能调的开关最省事。
     记在本地，下次进来还是这一档。 */
  const [sky, setSky] = useState<number>(() => {
    // 注意：没存过的时候 localStorage 给的是 null，而 Number(null) === 0 —— 正好落在合法区间里，
    // 于是所有新玩家一进来就是"最暗"那一档。必须先判有没有这个键。
    const raw = (() => { try { return localStorage.getItem('phz_sky'); } catch { return null; } })();
    const v = raw === null ? 1 : Number(raw);
    return v >= 0 && v <= 2 ? v : 1;
  });
  const cycleSky = () => setSky(v => {
    const n = (v + 1) % 3;
    try { localStorage.setItem('phz_sky', String(n)); } catch { /* ignore */ }
    toast(['底图：暗', '底图：正常', '底图：亮'][n]);
    return n;
  });
  /* 默认就是**大字版**：牌桌上的字本来就该看得清，小版留给自己去关。
     只有明确关过（存的是 '0'）才用小版 —— 没存过的一律按大版。 */
  const [bigUI, setBigUI] = useState<boolean>(() => { try { return localStorage.getItem('phz_bigui') !== '0'; } catch { return true; } });
  // 自动理牌开关：'' = 跟着摆法走（平铺关、扇形开），'1' / '0' = 玩家自己定了，优先级更高
  const [autoPref, setAutoPref] = useState<string>(() => { try { return localStorage.getItem('phz_autosort') ?? ''; } catch { return ''; } });
  /* 牌面字体：只列**这台机器真的装了**的那几款书法体（行楷 / 魏碑 / 楷 / 隶 / 翩翩 / 宋 / 圆） */
  const [cardFontId, setCardFontId] = useState<string>(() => cardFont().id);
  const [fontPick, setFontPick] = useState(false);   // 字体选单开着没
  const [soundPick, setSoundPick] = useState(false);          // 报牌声选单开着没
  const [packs, setPacks] = useState<{ id: string; name: string; count: number }[]>([]);
  const [packId, setPackId] = useState<string>(() => voicePack());
  const autoSort2 = autoPref === '' ? fanMode : autoPref === '1';
  const [kick, setKick] = useState<number | null>(null);   // 要踢走的机器人座位
  const [showLedger, setShowLedger] = useState(false);
  const [showRules, setShowRules] = useState(false);     // 玩法说明弹窗
  const [replayId, setReplayId] = useState<number | null>(null);      // 正在回放哪一局
  /** 暂停页导出的那张账单图：null = 没在导 */
  const [shot, setShot] = useState<{ title: string; sub: string; segLabel: string; rows: ShotRow[] } | null>(null);
  const [roundIds, setRoundIds] = useState<Record<number, number>>({});   // 局号 → 数据库里的 round id
  useEffect(() => {
    if (!showLedger || room.status === 'playing') return;
    api<any>('/api/rounds?limit=50', undefined, 'GET')
      .then(r => setRoundIds(Object.fromEntries((r.rounds ?? []).filter((x: any) => x.roomId === room.id && x.hasReplay).map((x: any) => [x.round, x.id]))))
      .catch(() => { /* 拿不到就不给回放按钮 */ });
  }, [showLedger, room.status, room.id]);
  // 阶段横幅：一条横向拉开的色带，1.4s 走完「展开 → 停住 → 淡出」。
  // seq 是给 React 的 key 用的 —— 同一个节点改 class 不会重播 CSS 动画，必须换节点。
  const [banner, setBanner] = useState<{ kind: 'open' | 'close'; main: string; sub: string; seq: number } | null>(null);
  const bannerSeq = useRef(0);
  const bannerTimer = useRef<any>(null);
  const BANNER_MS = 1400;
  function showBanner(kind: 'open' | 'close', main: string, sub = '') {
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    setBanner({ kind, main, sub, seq: ++bannerSeq.current });
    bannerTimer.current = setTimeout(() => { bannerTimer.current = null; setBanner(null); }, BANNER_MS);
  }
  useEffect(() => () => { if (bannerTimer.current) clearTimeout(bannerTimer.current); }, []);
  // 暂停是个**持续状态**，不是一闪而过的事件：进入的那一下弹红色横幅，之后由 .pb-hold 那条静态带子一直挂着。
  const wasPaused = useRef(false);
  useEffect(() => {
    const now = room.status === 'paused';
    if (now && !wasPaused.current) showBanner('close', '暂停游戏', 'GAME PAUSED');
    wasPaused.current = now;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.status]);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  useUpright(chatOpen);            // 聊天要打字：先按手机本来的方向显示，输入法才不会横竖反着
  // 牌面上的小红印：衡阳系印「衡」，耒阳提龙印「耒」
  useEffect(() => {
    const seal = room.variant === 'ly_tilong' ? '耒' : '衡';
    document.getElementById('root')?.style.setProperty('--seal', `"${seal}"`);
  }, [room.variant]);
  const [text, setText] = useState('');
  const [talking, setTalking] = useState(false);
  // 这个玩法自己那一套报牌声（没单独录就用通用的）
  useEffect(() => { loadVoicePack(room.variant); }, [room.variant]);
  const [bubbles, setBubbles] = useState<{ id: number; seat: number; text: string; ms?: number }[]>([]);
  const [toolsOpen, setToolsOpen] = useState(false);
  /* 退出牌桌：顶栏左边的 ‹‹ 和下拉菜单里的「返回大厅」共用一份。
     手机壳里 confirm() 弹不出来（原生没接管弹窗），所以不再问：直接退出，
     座位和分数都留着，机器人先替你打，回大厅点「返回牌局」就能接着打 */
  const leaveTable = () => {
    if (room.status === 'playing') toast('已退出，机器人先替你打着，回大厅点「返回牌局」接着打');
    socket.send({ type: 'room.leave' }); onLeft();
  };
  /* 起立离开：明说了不再回这一桌。
     正在打的那一局照样由机器人替你打完（账本来就按开局时坐这儿的人算），
     但位子打上"已起立"的印子 —— 断线重连不再把你送回来，这一局一结束位子就让出去。
     私人房更直接：位子当场空出来，牌局暂停等人补位。
     跟上面那个「返回大厅」的区别就在这儿：那个是暂时走开，位子还给你留着，桌子照转。 */
  const standUp = () => {
    toast(room.status !== 'playing' ? '已起立离开'
      : room.isPrivate ? '已起立，位子让出去了，牌局暂停等人补位'
      : '已起立，这一局机器人替你打完，位子不再留');
    socket.send({ type: 'room.leave', stand: true } as any); onLeft();
  };
  const [eave, setEave] = useState<string>(() => { try { return localStorage.getItem('phz_eave') ?? 'green'; } catch { return 'green'; } });
  const [fouls, setFouls] = useState<number[]>([]);   // 本局各家被罚了几次（服务端字段之外自己也数一份）
  const [settle, setSettle] = useState<Extract<GameEvent, { t: 'hu' }> | 'liuju' | null>(null);
  const [lastHu, setLastHu] = useState<Extract<GameEvent, { t: 'hu' }> | null>(null);  // 亮牌期间一直留着：关掉详情也还标着谁胡的
  const [huBack, setHuBack] = useState<LedgerEntry | null>(null);   // 纪录表里回看某一局的胡牌详情
  const lastMeldRef = useRef<{ sig: string; t: number } | null>(null);
  /** 这一局的起手龙已经念过「提龙」了没（记局号）：三家一起下，整桌只念一声 */
  const dealLongRef = useRef<number>(-1);
  const preMeldRef = useRef<{ seat: number; count: number; melds?: number } | null>(null);   // 进牌动画开始前那一刻的手牌张数
  // 展示用的房间快照：跟着事件一步步走，比服务端慢几百毫秒；交互（我的手牌 / 按钮 / 倒计时）仍然用实时的 room
  const [stage, setStage] = useState<RoomView>(room);
  /* 事件回调是 useEffect 里一次性注册的：闭包里的 stage 永远停在注册那一刻（一局刚开始、谁都还没下地）。
     播事件时要看"现在画面上是什么"，必须走 ref，不然像 preMeldRef 这种"记一下动画前的样子"
     全记成开局那一刻 —— 上家一进张，他早就摆在那儿的下地牌会整排闪一下。 */
  const stageRef = useRef(stage); stageRef.current = stage;
  const roomRef = useRef(room); roomRef.current = room;   // 最新的服务端状态（播报前用它再确认一次）
  const [float, setFloat] = useState<{ card: Kind; seat: number; verb: string; fromSeat?: number; meld?: boolean; dcount?: number; cid?: number; again?: boolean } | null>(null);
  const floatRef = useRef(float); floatRef.current = float;
  const evQ = useRef<{ e: GameEvent; room: RoomView; last: boolean; at: number }[]>([]);
  const evBusy = useRef(false);
  const pendingStage = useRef<RoomView | null>(null);   // 动画还没放完时收到的实时快照，先存着
  const floatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* 明牌收掉之后，牌要"飞"到它该去的地方（弃牌堆 / 下地区），别凭空消失。
     land 就是这一趟飞行：起点是明牌那一刻的位置，终点是目标那一摞的位置。 */
  const [land, setLand] = useState<
    { card: Kind; seat: number; cid?: number; meld?: boolean; meldSize?: number; dcount?: number; again?: boolean; x0: number; y0: number; x1: number; y1: number; w?: number; w0?: number; done?: boolean; snap?: boolean; fixed?: boolean; fx?: 'star' | 'rain' } | null>(null);
  const landTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [closed, setClosed] = useState<{ ledger: LedgerEntry[]; totals: { user: PublicUser; total: number }[] } | null>(null);
  const [now, setNow] = useState(socket.now());
  const [, force] = useState(0);
  const users = useMemo(() => { const m = new Map<number, PublicUser>(); for (const s of room.seats) if (s.user) m.set(s.user.id, s.user); for (const t of closed?.totals ?? []) m.set(t.user.id, t.user); return m; }, [room.seats, closed]);
  const audioQueue = useRef<Promise<void>>(Promise.resolve());

  /* 每 250ms 对一次表：倒计时圈、读秒都靠它。
     **切到后台就停**：这一跳会带着整张牌桌重画一遍，一秒四次，后台跑着纯属白烧电
     （手机发烫的另一份）。回到前台立刻补一次，画面不会停在旧秒数上。 */
  useEffect(() => {
    let t: ReturnType<typeof setInterval> | null = null;
    /* 没有任何倒计时在走的时候（没人要出牌、也没在等按钮），一秒对一次表就够了 ——
       原来不管闲忙都是一秒四次，每一次都带着整张牌桌重画一遍。老机器上这笔账不小。 */
    let skip = 0;
    const idle = () => {
      const gm: any = roomRef.current?.game;
      return !(gm?.deadline || gm?.myOptions?.deadline || roomRef.current?.nextRoundAt);
    };
    const start = () => {
      if (!t) t = setInterval(() => {
        // 闲着：4 跳才更新 1 次（=1 秒）。省电模式下连读秒也放慢一半（500ms，够看）
        const every = idle() ? 4 : (document.documentElement.classList.contains('lite') ? 2 : 1);
        if (every > 1 && ++skip % every !== 0) return;
        skip = 0; setNow(socket.now());
      }, 250);
    };
    const stop = () => { if (t) { clearInterval(t); t = null; } };
    const onVis = () => { if (document.visibilityState === 'visible') { setNow(socket.now()); start(); } else stop(); };
    onVis();
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  useEffect(() => { setChiPick(null); setChiStep(null); }, [g?.phase, g?.turn, g?.pileLeft]);
  useEffect(() => { manualRef.current = false; pinsRef.current = []; prevHandRef.current = { len: 0, melds: 0 }; }, [room.roundNo]);
  // 碰 / 吃 / 提 / 偎 / 跑 之后手上剩下的牌会变零碎，立刻重新理一次
  const myMeldCount = (g?.players?.[mySeat]?.melds as unknown[] | undefined)?.length ?? 0;
  useEffect(() => { manualRef.current = false; }, [myMeldCount]);

  // 事件处理：播报、气泡、结算
  useEffect(() => socket.on((m: ServerMsg) => {
    if (m.type === 'chat') setChat(c => [...c.slice(-50), { from: m.from, text: m.text, time: m.time }]);
    if (m.type === 'voice') {
      setChat(c => [...c.slice(-50), { from: m.from, voice: { data: m.data, mime: m.mime, durationMs: m.durationMs }, time: Date.now() }]);
      if (m.from.id !== me.id) audioQueue.current = audioQueue.current.then(() => playVoice(m.data, m.mime));
    }
    if (m.type === 'room.closed') setClosed({ ledger: m.ledger, totals: m.totals });
    if (m.type === 'error') {
      note('服务端拒绝', m.message);
      setPending(null);        // 动作被拒：把按钮放开
      // 这张牌我已经没份了（窗口关了 / 这一轮已经定了 / 服务端压根没给我选项）：
      // 按钮当场收掉，并且说一声 —— 以前这几个错误码是静音的，玩家只看到"点了没反应"
      const inClaim = (roomRef.current.game as any)?.phase === 'claim';
      if (/慢了一步|快碰慢吃/.test(m.message) || (inClaim && /already decided|no claim for you/.test(m.message))) {
        toast('这张牌来不及了');
        const tc: any = (roomRef.current.game as any)?.tableCard;
        if (tc) passedRef.current = `${tc.card}:${tc.from}:${tc.at}`;
        setChiPick(null); setChiStep(null);
      }
    }
    if (m.type === 'game.events') {
      const evs = m.events.filter(e => e.t !== 'options' && e.t !== 'need_discard');
      if (!evs.length) {
        // 没有画面的那种消息（只有按钮 / 空事件）带的是服务端的实时状态：
        // 动画还没放完就盖上去，会把"还没打出去的牌"提前画进弃牌堆，等下一帧又消失。
        if (evBusy.current || evQ.current.length) pendingStage.current = m.room; else setStage(m.room);
        return;
      }
      pendingStage.current = null;
      evs.forEach((e, i) => evQ.current.push({ e, room: m.room, last: i === evs.length - 1, at: Date.now() }));
      pumpEvents();
    }
  }), [me.id, room.mySeat]);

  // 每个动作在画面上占的时长；重放完一批就把展示快照对齐到服务端的最新状态
  const EV_MS: Record<string, number> = {
    deal: 250, draw: 650, discard: 600, play_drawn: 600, dead: 900, dealer_card: 2400,
    meld: 1000, bupai: 200, pass: 150, penalty: 700, tilong_score: 400,   // 进牌：等牌飞完了手里的牌才下地
  };
  /** ms = 0 表示一直留着，直到被下一张顶掉或牌进了牌池 */
  function showFloat(f: { card: Kind; seat: number; verb: string; fromSeat?: number; meld?: boolean; meldSize?: number; dcount?: number; cid?: number; again?: boolean }, ms: number) {
    if (floatTimer.current) clearTimeout(floatTimer.current);
    setFloat(f);
    floatTimer.current = ms > 0 ? setTimeout(() => flyToPile(f), ms) : null;
  }
  /** 重提 / 重跑加的那第四张，落在**哪一组**上：在他的下地牌里找同一张字的那四张组（新的排在最后） */
  function againIdxOf(seat: number, card: Kind, on: boolean | undefined): number | undefined {
    if (!on) return undefined;
    const ms = ((stageRef.current.game as any)?.players?.[seat]?.melds ?? []) as Meld[];
    for (let i = ms.length - 1; i >= 0; i--) if (ms[i].cards.length === 4 && ms[i].cards[0] === card) return i;
    return undefined;
  }

  /** 目标那一摞在屏幕上的位置：自己的在下面那两处，别人的在他那一格里 */
  function pileRect(seat: number, meld?: boolean): DOMRect | null {
    /* 这一摞可能还不存在（本局第一张牌打出去之前，弃牌区根本没渲染），
       所以按"最准 → 差不多"排一串候选，挑第一个量得到的。 */
    const sels = seat === mySeat
      ? (meld ? ['.my-melds', '.hand'] : ['.discard-band', '.my-discards', '.hand'])
      : (meld ? [`.seat[data-seat="${seat}"] .melds`, `.seat[data-seat="${seat}"] .seat-cards`, `.seat[data-seat="${seat}"]`]
        : [`.seat[data-seat="${seat}"] .pile-slot`, `.seat[data-seat="${seat}"] .discard-pile`,
           `.seat[data-seat="${seat}"] .seat-cards`, `.seat[data-seat="${seat}"]`]);
    for (const sel of sels) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width || r.height) return r;
    }
    return null;
  }
  /**
   * 牌飞过去的**落点**：不再去算"下一张正好落在哪一格"，改成**每一处钉死一个位置**。
   *
   * 为什么改：牌只要飞到那一摞旁边就够了，人眼看的是"这张牌归到谁那儿去了"，
   * 不是"它是不是严丝合缝地落进第七格"。而算准一格要迁就换行、镜像排列、
   * 隐形占位到没到、下地牌是新开一组还是加在原来那一组上……差一点就明显歪，
   * 排查起来又费劲。钉死的位置永远不会歪。
   *
   * 钉在哪儿：
   *  - 上家 / 下家：都以**他那摞手牌的牌背**（带张数那个）为准 ——
   *      进张落在它正下方一张牌的位置，弃牌再往下两张（也就是往下第三张）。
   *  - 自己：进张落在**第一组下地牌的左边**、跟那一组最上面一张齐平；
   *      弃牌落在**第一张弃牌的正上方**。
   */
  function nextSlot(seat: number, meld: boolean | undefined, box: DOMRect, _againIdx?: number): { x: number; y: number; w: number; local?: boolean } {
    const q = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width || r.height ? r : null;
    };
    /* 落点的宽度：**量那一摞里现成的一张牌**。写死的话，牌一放大（下地/弃牌整体放大、
       大字版再放大一档）就对不上 —— 飞过去那张会比旁边的牌小一圈。
       一张牌都还没有的时候退回按缩放算出来的估值。 */
    const cw = (sel: string) => {
      const c = document.querySelector(sel) as HTMLElement | null;
      const r = c?.getBoundingClientRect();
      return r && r.width ? r.width : 0;
    };
    /* 进牌（吃 / 碰 / 提 / 跑）一律飞到**那一家头像的右上角**，收成一个 5px 的小点。
       以前是拿手牌背当尺子往下数格子去猜下地区的落点 —— 排法一变、一放大就对不上。
       头像是全场最稳的一个锚：不会换位置、不会随牌多牌少变形。
       真牌等服务端消息到了再由下地区自己画出来（"归位"），这一趟只负责把"谁要走了"说清楚。 */
    /* 飞到最后收成多大的一个点。5px 太小了 —— 小到看不清"落在哪儿"，
       像牌直接没了；15px 还看得出是一张牌的影子，落点也指得明白。 */
    const LAND_W = 15;
    /* 弃牌的落点**写死**，不量也不换算。
       三堆弃牌本来就是按屏幕中线钉死的（见 styles.css），所以落点也该是个定数 ——
       以前靠"量第一张牌 + 把屏幕坐标换算成桌面坐标"，中间每一环都可能带出误差：
       机型不同、缩放比例不同、地址栏一伸一缩画布就变……换算完落点就飘。
       现在直接给桌面坐标（local: true，飞牌那边看到这个标记就不再换算）：
         上家 —— 左边沿往右 5，中线往上 15
         下家 —— 右边沿往左 5，中线往上 15
         我   —— 右边沿往左 5，正在中线上 */
    /* 落点：**量那一堆弃牌自己在哪**，别再凭常数推。
       之前试过写死坐标，可写死的前提是"我算的那套数跟 CSS 摆的那套数完全一致"——
       只要有一处（边距、牌宽、牌高、内层还套了个 right）对不上，落点就偏；
       而且竖着拿手机时整张牌桌是转过 90° 的，左右和上下会换轴，凭常数更容易搞反。
       那一堆现在本来就是 CSS 钉死的，位置稳定，量它一次最省心也最准。
       量出来的是屏幕坐标，这儿**当场换算成桌面坐标**（矩阵飞牌前刚刷过），
       带上 local 标记让上层别再换算第二遍。 */
    /**
     * 量一个盒子的**屏幕**方框，并且**把 CSS zoom 的账补上**。
     *
     * 坑在这儿：弃牌堆那一摞挂着 `zoom: var(--meld-zoom)`（小版 1.2、大版 1.44）。
     * Safari 对 zoom 里面的元素调 `getBoundingClientRect()`，返回的是**放大之前**的盒子；
     * Chrome 返回放大之后的。实测 iPhone 上大字版一张弃牌量出来是 22×31，
     * 而它真身是 22×1.44 = 31.7 宽、44 高 —— 22×31 正是未放大的那一份。
     * 照这个数算落点，偏差随着这摞牌越排越远而越拉越大，看着就是"雨滴落到外面去了"。
     *
     * 补法：拿**没有 zoom 的那层**（.pile-slot / .discard-band）当基准。
     * 它自己的方框是可信的，于是
     *     真实偏移 = （量到的偏移）× zoom
     * 到底补不补，靠现场比一次：一个盒子的 `offsetWidth` 永远是它自己那套未放大的单位，
     * 而外层还套着画布的 scale(k)。所以
     *     量到的宽 ÷ offsetWidth  ——  Chrome 是 k×zoom，Safari 是 k
     * 谁更近就按谁算。这样两种引擎都对，将来 Safari 改了也不会反而弄歪。
     */
    const rectOf = (el: Element): DOMRect => {
      const r = el.getBoundingClientRect();
      const he = el as HTMLElement;
      const ow = he.offsetWidth;
      if (!ow || !r.width) return r;
      // 往上找那层没有 zoom 的容器，顺手把中间累计的 zoom 乘起来
      let z = 1, node: HTMLElement | null = he, host: HTMLElement | null = null;
      for (let i = 0; node && i < 8; i++) {
        if (node.classList.contains('pile-slot') || node.classList.contains('discard-band')) { host = node; break; }
        z *= Number(getComputedStyle(node).zoom) || 1;
        node = node.parentElement;
      }
      if (!host || z <= 1.001) return r;
      const hr = host.getBoundingClientRect();
      const how = host.offsetWidth, hoh = host.offsetHeight;
      if (!how || !hr.width) return r;
      /* 比例用**对角线长度**算，不用宽度 —— 竖屏时整张牌桌转了 90°，
         rect 的"宽"对应的其实是布局里的"高"，直接拿宽比会得出个风马牛不相及的数
         （实测本该 0.854，按宽比算出来 1.248）。对角线长度跟转不转无关。 */
      const diag = (w: number, h: number) => Math.hypot(w, h);
      const k = diag(hr.width, hr.height) / diag(how, hoh);         // 画布那一道 scale，基准层量得准
      const seen = diag(r.width, r.height) / diag(ow, he.offsetHeight);   // 这个盒子实际被量成了几倍
      const on = Math.abs(seen - k) < Math.abs(seen - k * z);
      // 这一判到底判成了什么，记下来给 ?diag=1 看 —— 真机上一眼就知道补没补
      (window as any).__PHZ_ZFIX__ = { z: +z.toFixed(2), k: +k.toFixed(3), seen: +seen.toFixed(3), on };
      if (!on) return r;                                            // 引擎已经把 zoom 算进去了
      const fix = (v: number, o: number) => o + (v - o) * z;
      return new DOMRect(fix(r.left, hr.left), fix(r.top, hr.top), r.width * z, r.height * z);
    };
    /** 量一个元素在**桌面坐标**里的方框（屏幕坐标经 toLocal 换算，四角都过一遍，
     *  这样竖屏把整张桌子转了 90° 也不会把左右和上下搞反）。 */
    const boxLocal = (el: Element | null) => {
      if (!el) return null;
      const rr = rectOf(el);
      if (!rr.width && !rr.height) return null;
      const pts = [[rr.left, rr.top], [rr.right, rr.top], [rr.right, rr.bottom], [rr.left, rr.bottom]]
        .map(([x, y]) => toLocal(x, y));
      const xs = pts.map(v => v.x), ys = pts.map(v => v.y);
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    };
    /**
     * 弃牌的落点：**以头像框为锚**，配上屏幕的水平中线。
     *
     * 头像那一排是全场位置最稳的东西 —— 它是 grid 配 --edge 定死的，
     * 不随牌多牌少、换不换行、放不放大而动。比量弃牌堆本身还靠得住：
     * 堆里"第一张牌"在换行、镜像排列、隐形占位还没摆出来的当口都可能挪位置。
     *
     *   上家 —— 落点**左**沿贴上家头像**左**沿，中线**上方** 5px
     *   下家 —— 落点**右**沿贴下家头像**右**沿，中线**上方** 5px
     *   我   —— 落点**右**沿也贴**下家**头像右沿（我这堆跟下家那堆共用同一条右准线），
     *           中线**下方** 5px
     *
     * 中线取的是整张牌桌（#root）的上下正中 —— 三堆弃牌的 CSS 用的就是这条线
     * （position: fixed + top: 50%，在被 transform 的 #root 里参照的正是它）。
     */
    const discardSlot = (st: number) => {
      const mine = st === mySeat;
      const half = LAND_W / 2;
      const pick = (sel: string) => document.querySelector(sel) as HTMLElement | null;
      // 上家＝第一格，下家＝ .seat-r；我这堆跟下家共用右准线
      const isLeft = !mine && !!pick(`.table-mid > .seat[data-seat="${st}"]:first-child`);
      const isRight = mine || !!pick(`.seat[data-seat="${st}"].seat-r`);
      /* ① 最准的一手：**量正在落地的那张牌自己的占位**。
         飞牌一起飞就把占位摆进那一摞了（`.pile-ghost`，隐形但占位置），
         它待的地方就是这张牌最终待的地方 —— 换行、镜像排列、放大缩小全都算在里头了，
         比任何"照头像推算"都准。
           上家那一堆从左往右码 → 钉在它的**左上角**
           我和下家从右往左码   → 钉在它的**右上角**
         起飞那一瞬占位还没渲染出来，走下面 ② 先估一个；
         这一帧画到屏幕之前 useLayoutEffect 会拿着占位重量一遍、把终点改准，
         所以眼睛看到的自始至终是对的那条轨迹。 */
      /** 落点这一路走到哪一步、量到了什么，全记在这儿 —— ?diag=1 会把它打出来。
       *  真机上出问题时，照着这几个数就能说清是"没量到占位"、"量到了但位置不对"
       *  还是"算对了但画歪了"，不用再靠猜。 */
      const note2 = (o: any) => { (window as any).__PHZ_SLOT__ = { st, mine, isLeft, ...o }; };
      const ghost = boxLocal(pick(mine ? '.my-discards .pile-ghost'
        : `.seat[data-seat="${st}"] .pile-slot .pile-ghost`));
      if (ghost) {
        // 落在这张牌**上边线的正中**（原来是钉在左上角 / 右上角，偏在一侧看着别扭）
        const p = { x: (ghost.x0 + ghost.x1) / 2, y: ghost.y0 };
        note2({ via: '占位', ghost: [Math.round(ghost.x0), Math.round(ghost.y0), Math.round(ghost.x1), Math.round(ghost.y1)],
          pick: [Math.round(p.x), Math.round(p.y)] });
        return { ...p, w: LAND_W, local: true };
      }

      // ② 占位还没有：拿头像那条准线估一个（本局第一张牌、或者占位这一帧还没画出来）
      const canvas = boxLocal(document.getElementById('root') ?? pick('.table'));
      const anchor = canvas && (isLeft || isRight)
        ? boxLocal(isLeft ? pick(`.seat[data-seat="${st}"] .avatar`) : pick('.seat.seat-r .avatar'))
        : null;
      if (canvas && anchor) {
        /* 中线取哪一条：优先**量那几堆自己钉住的那条线** —— 弃牌堆是 `top: 50%` 钉的，
           上面两堆的底边就是"中线 − 2"，我这一条带子的顶边就是"中线 + 2"。
           这么取的好处是：不管 `position: fixed` 这会儿参照的是 #root（竖屏，整桌转过 90°，
           #root 身上有 transform）还是参照视口（横屏，#root 没有变换），
           落点跟 CSS 用的永远是同一条线。都量不到（本局第一张牌打出去之前）才退回 #root 的正中。 */
        const pinned = boxLocal(pick('.table-mid > .seat .pile-slot'));
        const band = boxLocal(pick('.discard-band'));
        const mid = pinned ? pinned.y1 + 2 : band ? band.y0 - 2 : (canvas.y0 + canvas.y1) / 2;
        /* 三家落点，全部写在**桌面坐标**里 —— 横屏竖屏是同一套数，不用分两种算法。
           （竖屏时整张牌桌转了 90°：桌面里的"上"就是手机屏上的"右"，桌面的上下中线
             就是手机的左右中线。换算这一步 toLocal 已经做完了，这儿不用再管。）

             上家 —— 钉在**上家头像框的右边线**上，中线往上一张牌高
             下家 —— 钉在**下家头像框的右边线**上，中线往上一张牌高
             我   —— 也钉在**下家头像框的右边线**上（跟下家共用这条准线），中线往下 2px

           "一张牌高"是**量出来的**，不是写死的：大字版整桌放大两成，牌也跟着高一截，
           写死的话大字版就会差出七八个像素。 */
        const cardH = (() => {
          /* 标称值：22px 宽 × --meld-zoom × 1.39 的长宽比 —— 正好是实测的 36.7 / 44。
             量得到真牌就用真的，量不到（本局第一张牌，弃牌堆还空着）就用它。 */
          /* `.card-xs` 标称 22px 宽，乘这一档的缩放，再乘 1.39 的长宽比（只露字头那种牌）。
             缩放**从 CSS 里读**（--meld-zoom），不在这儿写死 1.2 / 1.44 ——
             大小版的倍数只该有一个出处（styles.css），两边各写一份迟早对不上。 */
          const mz = Number(getComputedStyle(pick('.table') ?? document.documentElement)
            .getPropertyValue('--meld-zoom')) || 1.2;
          const nominal = Math.round(22 * mz * 1.39);
          /* **只量弃牌堆里的牌**。牌桌上「牌」有好几个尺寸档，拿错一个落点就飞了：
             手牌是最大的一档；亮牌时别家下地区那一排（.melds.open-hand）也是全尺寸，
             实测 90 —— 按它算，落点会比该在的地方高出五十多像素。
             弃牌堆正是这个点要落进去的地方，量它最名正言顺。
             再加一道闸：量出来的数离标称值太远（八成是选错了元素）就不认，退回标称值。 */
          for (const sel of ['.my-discards .card', '.seat .pile-slot .card']) {
            const b = boxLocal(pick(sel));
            const h = b ? b.y1 - b.y0 : 0;
            if (h > nominal * 0.6 && h < nominal * 1.8) return h;
          }
          return nominal;
        })();
        const p = { x: anchor.x1, y: mine ? mid + 2 : mid - cardH };
        note2({ via: '头像', anchorR: Math.round(anchor.x1), mid: Math.round(mid), cardH: Math.round(cardH),
          pick: [Math.round(p.x), Math.round(p.y)] });
        return { ...p, w: LAND_W, local: true };
      }
      /* 头像还没画出来（开局那一瞬）或者是对家那一格：退回老办法 —— 量那一堆弃牌本身。 */
      const item = mine ? pick('.my-discards .pile-item')
        : pick(`.seat[data-seat="${st}"] .pile-slot .pile-item`);
      const boxEl = item ?? (mine ? pick('.discard-band') : pick(`.seat[data-seat="${st}"] .pile-slot`));
      const bx = boxLocal(boxEl);
      if (!bx) { note2({ via: '什么都没量到' }); return { x: 0, y: 0, w: LAND_W, local: true }; }
      const p2 = item ? { x: (bx.x0 + bx.x1) / 2, y: (bx.y0 + bx.y1) / 2 }
        : { x: isRight ? bx.x1 - half : bx.x0 + half, y: (bx.y0 + bx.y1) / 2 };
      note2({ via: item ? '第一张牌' : '那一块区域', pick: [Math.round(p2.x), Math.round(p2.y)] });
      return { ...p2, w: LAND_W, local: true };
    };
    const avatarSlot = (sel: string, fb: DOMRect) => {
      const a = q(sel) ?? fb;
      return { x: a.right, y: a.top, w: LAND_W };
    };
    const mz = bigUI ? 1.44 : 1.2;                       // 见 .table.big-ui { --meld-zoom }
    const w = seat === mySeat
      ? (cw(meld ? '.my-melds .card' : '.my-discards .card') || Math.round((meld ? 25 : 25) * mz))
      : (cw(`.seat[data-seat="${seat}"] ${meld ? '.melds' : '.pile-slot'} .card`) || Math.round(22 * mz));
    if (seat !== mySeat) {
      /* 他那摞手牌的牌背：一张牌背的高度就当"一张牌"的间距用。
         牌背万一没画出来（亮牌那会儿就没有），退回这一格本身的上沿。 */
      if (!meld) return discardSlot(seat);
      return avatarSlot(`.seat[data-seat="${seat}"] .avatar`, box);
    }
    if (meld) return avatarSlot('.me-info .avatar', box);
    /* 弃牌：第一张弃牌的正上方。一张都还没打的时候，就用那条带子的左上角当位置。 */
    return discardSlot(mySeat);
  }

  /** 真牌画出来之后，它到底落在哪儿 —— 量那一摞里最后一张（下地牌就是最后一组） */
  function landedRect(seat: number, meld?: boolean, againIdx?: number): DOMRect | null {
    const root = (seat === mySeat
      ? document.querySelector(meld ? '.my-melds' : '.discard-band')
      : document.querySelector(`.seat[data-seat="${seat}"] ${meld ? '.melds' : '.pile-slot'}`)) as HTMLElement | null;
    // 重提 / 重跑：真牌就是原来那一组的第四张，别去找"最后一组"
    if (meld && againIdx !== undefined && againIdx >= 0 && root) {
      const box2 = (Array.from(root.querySelectorAll('.meld')) as HTMLElement[])[againIdx];
      const cs = box2 ? Array.from(box2.querySelectorAll('.card')) as HTMLElement[] : [];
      const r = cs.length ? cs[cs.length - 1].getBoundingClientRect() : null;
      if (r && (r.width || r.height)) return r;
    }
    const items = root ? Array.from(root.querySelectorAll(meld ? '.meld' : '.pile-item')) as HTMLElement[] : [];
    const last = items.filter(e => !e.classList.contains('pile-ghost') && !e.classList.contains('meld-ghost')).pop();
    if (!last) return null;
    const r = last.getBoundingClientRect();
    return r.width || r.height ? r : null;
  }

  /** nextSlot 量出来的是屏幕坐标，牌飞的那一层用的是桌面内坐标 —— 这儿换算一道 */
  const toLocal2 = (s0: { x: number; y: number; w: number }) => { const p = toLocal(s0.x, s0.y); return { x: p.x, y: p.y, w: s0.w }; };

  /** 明牌收掉：让这张牌从明牌位置飞到弃牌堆 / 下地区，落到了才交给那一摞去画 */
  function flyToPile(f: { card: Kind; seat: number; meld?: boolean; meldSize?: number; dcount?: number; cid?: number; again?: boolean }) {
    const el = document.querySelector('.float-card .float-inner') as HTMLElement | null;
    const dst = pileRect(f.seat, f.meld);
    if (!el || !dst) { setFloat(null); setLand(null); return; }   // 量不到就照老样子直接收掉
    /* 起飞前把「屏幕坐标 → 桌面坐标」那张矩阵**重新取一遍**。
       它是缓存着的（拖牌时一秒要换算上百个点，每次都读样式会把手机拖烫），
       只在拖牌按下、转屏、改画布这几处刷新。可飞牌这条路不经过其中任何一处 ——
       要是从上回刷新到现在画布变过（地址栏一伸一缩就会变），拿的就是旧矩阵，
       换算出来的落点整个偏掉。
       两台机器表现不一样正是这么来的：缩放比例大的那台（17 Pro 是 1.16）
       平时更容易触发一次重算，比例几乎是 1 的那台（15 只有 1.004）反而一直用着旧的。
       这里一趟只刷一次，不心疼。 */
    invRef.current = { key: '', m: null }; rootInverse();
    const src = el.getBoundingClientRect();
    const a = toLocal((src.left + src.right) / 2, (src.top + src.bottom) / 2);
    const slot = nextSlot(f.seat, f.meld, dst, againIdxOf(f.seat, f.card, f.again && f.meld));
    const b = (slot as any).local ? { x: slot.x, y: slot.y } : toLocal(slot.x, slot.y);

    (window as any).__PHZ_FLY__ = { seat: f.seat, meld: !!f.meld, slot: [Math.round(slot.x), Math.round(slot.y), Math.round(slot.w)],
      b: [Math.round(b.x), Math.round(b.y)], a: [Math.round(a.x), Math.round(a.y)] };
    setFloat(null);
    setLand({ card: f.card, seat: f.seat, cid: f.cid, meld: f.meld, meldSize: f.meldSize, dcount: f.dcount, again: f.again,
      x0: a.x, y0: a.y, x1: b.x, y1: b.y, w: slot.w, w0: src.width, fx: f.meld ? 'star' : 'rain' });
    /* 这一趟由 Web Animations 亲自放：**位移和缩放写在同一个 transform 里**，
       一定是边飞边缩，不会出现"先飞过去、到地方才缩"。
       以前靠 CSS 过渡 left/top + 另一条 transform，主线程一卡（或者 WebKit 把带 var() 的
       transform 直接跳到终值）就会在弃牌区闪一张原尺寸的大牌。 */
    if (landTimer.current) clearTimeout(landTimer.current);
    /* 飞到了**先停在落点上**（done），一直等到那一摞真的把这张牌画出来了才撤 ——
       不然服务端那一帧还没到，牌就"飞过去然后不见了"。最多等 4 秒，兜底撤掉。 */
    landTimer.current = setTimeout(() => {
      /* 飞到了再量一次真实落点：起飞那会儿服务端那一帧可能还没到，
         隐形占位还没摆出来，只能照着现有的牌推算，难免差一点。
         现在占位八成已经在了 —— 量准了直接把牌摆过去（不重播动画）。 */
      // 落点是钉死的，不用再量一遍往那儿挪 —— 挪反而会在落地那一下跳一格
      setLand(l => (l ? { ...l, done: true } : l));
      /* 撤掉的时机分两种：
         - **弃牌**：停在落点上等，一直等到那一摞真的把这张牌画出来了（服务端那一帧到了）才撤 ——
           不然会出现"牌飞过去、然后凭空消失、过一会儿才冒出来"的断档。最多等 4 秒兜底。
         - **进牌**（吃碰提跑）：下地区那一组是客户端自己连着画完的，不用等谁，
           落地就可以撤，多停反而挡着下面那一组。 */
      if (f.meld) { landTimer.current = setTimeout(() => setLand(null), 120); return; }
      /* 弃牌那个圆点停 **4 秒**，到点了才撤。
         这四秒里屏幕上是两样东西同时在：圆点（刚打出去的是这张）和它底下
         那张已经落位的真牌。撤的时候圆点没了、牌还在原地 —— 没有任何跳动。
         （以前是"服务端那一帧一到就撤"，撤得早、又正好赶上重绘，看着就是弃牌旁边闪一下。） */
      landTimer.current = setTimeout(() => setLand(null), 4000);
    }, LAND_MS + 30);
  }
  const lastSaidCardRef = useRef<Kind | null>(null);   // 刚报过牌名的那张牌
  const goneAt = useRef(0);
  const evGo = useRef<(() => void) | null>(null);
  function pumpEvents() {
    if (evBusy.current) return;
    const it = evQ.current.shift();
    if (!it) return;
    evBusy.current = true;
    note('播', `${it.e.t}${(it.e as any).seat !== undefined ? ':' + (it.e as any).seat : ''}${(it.e as any).card !== undefined ? ':' + (it.e as any).card : ''}`);
    try { handleEvent(it.e, it.room); }
    catch (err) { console.error('播放事件出错', it.e.t, err); }   // 一个事件画砸了，不能把后面的全卡死
    // 吃牌带的下伙牌组跟"吃"是同一个动作：不再单独占一段动画时间，跟着吃牌一起落地
    const part = it.e.t === 'meld' && !!(it.e.meld as any).part;
    /* 起手龙：三家一起下、不分先后 —— 后面还跟着龙的就不等，整批一齐落地，
       只有最后那一条占一段动画时间。一条条等的话，龙多时开局要干等好几秒。 */
    const nx = evQ.current[0]?.e as any;
    const dealRun = it.e.t === 'meld' && !!(it.e as any).deal && nx?.t === 'meld' && !!nx?.deal;
    const wait = part || dealRun ? 0 : (EV_MS[it.e.t] ?? 0);
    const go = () => {
      if (it.last) { pendingStage.current = null; setStage(it.room); }   // 这一步的动画放完，画面才追上服务端
      evBusy.current = false;
      // 动画期间攒下的实时状态，等这一批放完了再补上
      if (!evQ.current.length && pendingStage.current) { setStage(pendingStage.current); pendingStage.current = null; }
      pumpEvents();
    };
    let fired = false;
    const once = () => { if (fired) return; fired = true; goneAt.current = 0; go(); };
    goneAt.current = wait ? Date.now() + wait : 0;
    evGo.current = once;
    if (wait) setTimeout(once, wait); else once();
  }
  // 守门狗：这一步该播完了却还卡着（定时器被系统挂起、或者上一步出错），过 3 秒强行往下走，
  // 别让整桌牌停在那儿等一个永远不来的回调（黄庄那种连着好几步的收尾最容易撞上）
  useEffect(() => {
    const id = setInterval(() => {
      if (evBusy.current && goneAt.current && Date.now() > goneAt.current + 3000) evGo.current?.();
    }, 1000);
    return () => clearInterval(id);
  }, []);
  /* 兜底：动画都放完了、画面却还停在旧局面（帧丢了、回调被打断、定时器被系统挂起…）——
     隔一会儿对一次，发现画面比服务端旧就直接追上去。宁可跳一下，也别让人对着一张死牌干等。
     **签名里一定要带上自己的手牌**：出过一次这样的事 —— 打出去的那张牌还留在手上，
     而阶段、轮到谁、牌池张数全都对得上，光看那几项根本发现不了，手牌就一直是错的。 */
  useEffect(() => {
    const sig = (r: RoomView | null) => {
      const gm: any = r?.game;
      const hand = (gm?.players?.[r?.mySeat ?? -1]?.hand ?? []) as number[];
      const melds = (gm?.players?.[r?.mySeat ?? -1]?.melds ?? []).length;
      return `${r?.status}|${r?.roundNo}|${gm?.phase}|${gm?.turn}|${gm?.pileLeft}|${gm?.ended}|${gm?.tableCard?.cid ?? ''}`
        + `|${hand.length}:${hand.join(',')}|${melds}`;
    };
    const id = setInterval(() => {
      /* 这一批事件在队列里堵太久了（10 秒还没轮到）：多半是某一步的动画回调丢了，
         或者手机把定时器挂起过。别再一步步慢慢补 —— 整批扔掉，直接跳到最新的局面。 */
      const oldest = evQ.current[0];
      if (oldest && Date.now() - oldest.at > 4000) {
        evQ.current.length = 0; evBusy.current = false; goneAt.current = 0;
        setFloat(null); setLand(null);
        pendingStage.current = null; setStage(roomRef.current);
        return;
      }
      /* 这一步"在放"却放了太久：多半是那一帧的回调丢了（量不到落点、动画被打断、
         系统把定时器挂起过）。别再等下去 —— 整批扔掉直接对表。
         真实症状就是你说的那种：小五明明打出去了，手里还留着、弃牌区空着，
         可后面的动作照走不误。宁可跳一下，也不能让画面在骗人。 */
      if (evBusy.current && goneAt.current && Date.now() > goneAt.current + 2500) {
        evQ.current.length = 0; evBusy.current = false; goneAt.current = 0;
        setFloat(null); setLand(null);
        pendingStage.current = null; setStage(roomRef.current);
        note('对表', '这一步卡住了，直接跳到最新局面');
        return;
      }
      if (evBusy.current || evQ.current.length) return;
      if (pendingStage.current) { setStage(pendingStage.current); pendingStage.current = null; return; }
      /* 队列空了就一定对一次表 —— 不再只在"签名不一样"时才对。
         签名只带了几项关键字段，别家的弃牌、下地这些不在里面，
         那些对不上的时候以前是**看不出来也不会修**的。 */
      if (stageRef.current !== roomRef.current) {
        if (sig(stageRef.current) !== sig(roomRef.current)) note('对表', '画面比服务端旧，追上去');
        setStage(roomRef.current);
      }
    }, 700);
    return () => clearInterval(id);
  }, []);
  // 没有事件在重放时（进房、重连、房间状态变化）直接跟上
  useEffect(() => {
    if (!evBusy.current && !evQ.current.length) setStage(room);
    else pendingStage.current = room;   // 动画还在放：先存着，放完再追上
  }, [room]);

  /* 桌上摆着牌（大家正在抢）就一定要看得见：动画放完之后浮牌万一被清掉了（用延时卡续时间、
     重连、动画被打断…），按实时状态原地补一张回来，不然按钮还在、牌却没了，看着莫名其妙 */
  useEffect(() => {
    const st: any = stage.game;
    const tc: any = st?.tableCard;
    // 只在"大家正在抢这张牌"的时候补：别在牌已经进牌池 / 已经被人拿走之后又把它画回来
    if (revealingRef.current || !tc || float || st?.phase !== 'claim' || st?.ended) return;
    if (evBusy.current || evQ.current.length) return;
    setFloat({ card: tc.card, seat: tc.from, verb: tc.source === 'draw' ? '摸' : '打', cid: tc.cid });
  }, [(stage.game as any)?.tableCard?.cid, (stage.game as any)?.tableCard?.card, float]);

  /* 冒泡活多久，气球就吹多久（`--bub-d`）：太短会在"炸开"之前就被撤掉，
     太长又会在那儿干挂着。报牌那种字多的给 1.8 秒，平常 1.15 秒。 */
  function bubble(seat: number, t: string, ms = 1150) {
    const id = Date.now() + Math.random();
    setBubbles(b => [...b, { id, seat, text: t, ms }]);
    setTimeout(() => setBubbles(b => b.filter(x => x.id !== id)), ms);
  }
  function handleEvent(e: GameEvent, r: RoomView) {
    switch (e.t) {
      case 'deal':
        setFouls([]); setCols([]);
        setSettle(null); setLastHu(null); setFloat(null); say('开始', 'start');
        showBanner('open', '开始打牌', "LET'S PLAY"); break;
      // dcount：这张牌"落进弃牌堆之前"这家有几张弃牌 —— 牌还在飞的时候只藏多出来的那一张，
      // 不能按牌面去比，不然后面又摸到同一个字时，早就落地的那张会突然消失
      case 'draw': lastSaidCardRef.current = e.card; say(cardSpeech(e.card), cardKey(e.card));
        showFloat({ card: e.card, seat: e.seat, verb: '摸', dcount: dcountOf(r, e.seat), cid: (e as any).cid }, 0); break;
      case 'discard':                                     // 进张之后从手里打出来的：报打牌
        lastSaidCardRef.current = e.card;
        say(cardSpeech(e.card), cardKey(e.card));
        showFloat({ card: e.card, seat: e.seat, verb: '打', dcount: Math.max(0, dcountOf(r, e.seat) - 1), cid: (e as any).cid }, 0); break;
      case 'play_drawn':                                   // 摸上来没人要的牌：不算"打出"，摸的时候已经亮过报过了
        break;
      case 'dead': {                                       // 牌进牌池：原地停一下，再飞进弃牌堆
        if (floatTimer.current) clearTimeout(floatTimer.current);
        const f0 = floatRef.current;
        floatTimer.current = setTimeout(() => { if (f0) flyToPile(f0); else setFloat(null); }, EV_MS.dead - 120);
        break;
      }
      case 'meld': {
        // 一次吃带下伙、起手两条龙会连出好几个 meld 事件，同一个人同一种动作只报一次
        const sig = `${e.seat}:${e.meld.type}`;
        /* 起手龙：三家同时下地，**整桌只念一声「提龙」**，不报是什么龙 ——
           一人一条、甚至一人两条的时候，「提龙，大玖」一句句报下来太吵，
           而且这几条牌桌上明摆着，用不着念。气泡照旧一家一个，谁下了看得见。 */
        if ((e as any).deal) {
          if (dealLongRef.current !== r.roundNo) { dealLongRef.current = r.roundNo; say('提龙', 'long'); }
          bubble(e.seat, MELD_TAG[e.meld.type] ?? '龙', 1500);
        }
        // 吃牌下伙会连着下好几组牌，只有第一组是"这次动作"，后面的不再报第二遍
        else if (!(e.meld as Meld).part && (lastMeldRef.current?.sig !== sig || Date.now() - lastMeldRef.current.t > 2000)) {
          /* 一律只喊动作那两个字（「提龙！」「碰！」「开跑！」…），**不报是什么牌**。
             提龙以前要跟一句「提龙，大玖」—— 可四张牌就明摆在他面前，谁都看得见，
             念出来只是多一句话；一局里提得多、或者起手几条龙，听着就吵。 */
          const word = ACTION_WORDS[e.meld.type] ?? MELD_NAME[e.meld.type] ?? '';
          say(word, e.meld.type);
          /* 冒泡一律**一个字**（碰 / 吃 / 偎 / 提 / 跑 / 龙）——
             字数一定，气泡的大小和位置就是固定的，不会一会儿宽一会儿窄地跳。
             提的是什么龙由语音报（「提龙，大玖！」），气泡上不写。 */
          bubble(e.seat, MELD_TAG[e.meld.type] ?? MELD_NAME[e.meld.type] ?? e.meld.type, 1500);
        }
        lastMeldRef.current = { sig, t: Date.now() };
        if (e.seat === r.mySeat && !(e.meld as any).again) myMeldAtRef.current = Date.now();
        // 进张：牌从它现在的位置飞到进牌者面前（下伙那几组是跟着吃一起下地的，不单独飞）
        // 飞的这一路上手牌张数先按"进牌之前"显示，别提前露出"他要偎/提了"
        if (!(e.meld as Meld).part) preMeldRef.current = { seat: e.seat, count: (stageRef.current.game as any)?.players?.[e.seat]?.handCount ?? 0,
          melds: ((stageRef.current.game as any)?.players?.[e.seat]?.melds ?? []).length };
        if (!(e.meld as Meld).part)
          // 带上这一组有几张（碰 3 张、偎 / 提 4 张…）：占位就按真实宽度摆，落点分毫不差
          /* again = 重提 / 重跑：在**原来那一组**（碰 / 偎）上加第四张，不是新开一组。
             引擎那头是"拆掉旧的三张组、换上新的四张组"，所以组数一点没变 ——
             下地区早就把那一组画成四张了。这时候再摆一个"新一组"的隐形占位，
             落点就落到那一组**外面一格**去了（你看到的"明牌飞过去靠外一格"就是这个）。
             带上这个标记：占位不摆，落点直接量那一组的第四张。 */
          showFloat({ card: e.meld.cards[0], seat: e.seat, verb: MELD_NAME[e.meld.type] ?? '', fromSeat: e.fromSeat,
            meld: true, meldSize: (e.meld.cards as Kind[]).length, again: !!(e.meld as any).again }, EV_MS.meld);
        break;
      }
      case 'pass': if (e.seat === r.mySeat) { say('过', 'pass'); bubble(e.seat, '过'); } break;
      case 'hu':
        sayNow(e.ziMo ? '自摸，胡了！' : '胡了！', e.ziMo ? 'zimo' : 'hu');
        bubble(e.seat, '胡'); setFloat(null); setLand(null); setSettle(e); setLastHu(e); break;
      case 'liuju': sayNow('黄庄', 'liuju'); setFloat(null); setSettle('liuju'); break;
      // 发牌：庄家多的那一张亮给所有人看（衡阳里别家能拿它胡＝地胡）
      case 'dealer_card':
        lastSaidCardRef.current = e.card;
        // 跟平常的明牌区分开：庄家那一张读「阳张 大贰」
        say(`阳张 ${cardSpeech(e.card)}`, 'yang' + cardKey(e.card));
        showFloat({ card: e.card, seat: e.seat, verb: '阳张' }, 2800);
        break;
      case 'penalty': setFouls(f => { const n = f.slice(); n[e.seat] = (n[e.seat] ?? 0) + 1; return n; });
        // 罚分说总数就行：每家赔 3 倍底分，总共就是 3×底分×(人数-1)
        say('违规', 'foul'); bubble(e.seat, '罚');
        toast(`${r.seats[e.seat].user?.nickname ?? ''} ${e.reason}，罚 ${Math.abs(e.delta[e.seat] ?? 0)} 分`); break;
      case 'delay_grant': toast('每人获得一张延时卡'); break;
      case 'delay_use':
        bubble(e.seat, '延');
        toast(`${r.seats[e.seat].user?.nickname ?? ''} 用掉一张延时卡，行动时间延长（还剩 ${e.left} 张）`);
        break;
      // 起手龙也好、打到一半提的龙也好，统一说成「XX 提龙 X，每人 N 分」
      case 'tilong_score': {
        const kind = (r.game as any)?.players?.[e.seat]?.melds?.slice().reverse()
          .find((m: Meld) => m.type === 'ti' || m.type === 'long')?.cards?.[0];
        const per = Math.abs(e.delta.find((_, i) => i !== e.seat) ?? 0);
        toast(`${r.seats[e.seat].user?.nickname ?? ''} 提龙${kind !== undefined && kind >= 0 ? ` ${nameOf(kind)}` : ''}，每人 ${per} 分`);
        break;
      }
    }
  }

  /**
   * 行动按钮读**画面上那一份**（stage），不是服务端实时那一份（g）。
   *
   * 这是"动画还在飘、胡牌按钮就冒出来了"和"能碰的牌根本没给提示"的同一个根。
   * 服务端本来就是按帧发的：每一帧都带着**那一刻**各家该看到的选项，
   * 而且切片播放期间还会把倒计时按最新的补过去（见 room.ts 里 gv.myOptions 那一段）——
   * 整套机制就是为了让按钮跟画面同步。可按钮一直读的是 `room.game`（实时那份），
   * 把这套机制整个绕过去了：
   *   · 服务端跑在前面 → 按钮先于它的起因出现（牌还没摸出来，胡的按钮已经在了）；
   *   · 窗口在客户端还在补动画的时候开了又关 → 实时那份里早没了这个选项，
   *     按钮要么一闪而过、要么等玩家看到那张牌时已经超时（"碰牌直接没提示"）。
   * 改成读 stage，按钮就跟着画面走；而服务端开窗口时按 `lag` 把时限往后推过，
   * 玩家真正看到按钮时剩下的时间才是完整的那一档。
   *
   * stage 还没有牌局（刚进房、还没收到过帧）就退回实时那份，别让人对着空桌子没按钮。
   */
  const gAct: any = stage.game ?? g;
  const opts = gAct?.myOptions?.options as ActionOption[] | undefined;
  // 我对桌上这张牌已经表过"过"了：换了一张牌就重新给按钮。
  // 注意要按"这一次摆上桌的那张"算（牌 + 谁摆的 + 什么时候），光比牌面会误伤 ——
  // 比如上家打的小七我过了，接着自己又摸到一张小七，那是新的一张，按钮该给还得给。
  const tc = gAct?.tableCard as { card: Kind; from: number; at: number } | null | undefined;
  const leftSeatNo = (mySeat - 1 + n) % n;      // 上家：排在我前面的那一家
  const badChiRef = useRef<string | null>(null);
  const committedRef = useRef<{ key: string; act: string } | null>(null);
  const tableCardNow = tc ? `${tc.card}:${tc.from}:${tc.at}` : null;
  if (passedRef.current !== null && passedRef.current !== tableCardNow) passedRef.current = null;
  const iPassedThis = g?.phase === 'claim' && passedRef.current !== null && passedRef.current === tableCardNow;
  const optSig = `${g?.phase}|${g?.turn}|${(opts ?? []).map(o => o.type).join(',')}|${(g as any)?.tableCard?.card ?? ''}`;
  const optSigRef = useRef('');
  /* 桌上的牌一换，上一手的"已点"就作废 —— 只盯 optSig 不够：
     选项列表可能一模一样（比如连着两张都能碰），签名不变，锁就一直留着。 */
  useEffect(() => { setPending(null); }, [tableCardNow]);
  useEffect(() => {
    if (optSigRef.current && optSigRef.current !== optSig) {
      setPending(null);
      setChiPick(null); setChiStep(null);   // 选项刷新了：旧的吃法弹窗作废，重新点
    }
    optSigRef.current = optSig;
  }, [optSig]);
  const myDecided = gAct?.myDecided as string | null | undefined;
  const myWaiting = !!gAct?.myWaiting;      // 服务端说：我表过态了，正在等别家
  // 我摸上来的牌正摆在桌上等别家表态，而我自己没有任何可选动作 —— 也给个"排队中"，
  // 免得看着像卡死了（不管别家要不要得起，等待时间都一样，不泄漏信息）
  /* 「吃」的双保险：只有**上家打出来的那张**（或者我自己刚摸上来的那张）才吃得到。
     服务端那边本来就是这么判的（`seat === next(打牌的人)`），但有人反馈过
     "下家打的牌，我这边吃亮了" —— 多半是上一轮的选项面板没刷干净留在那儿。
     与其猜，不如在最后一道关口按"这张牌是谁打的"再验一遍：
     不该亮的一律不亮，同时把现场往回报一条，好顺着日志找出到底是哪一步没刷。 */
  const chiFromOK = !tc || tc.from === mySeat || tc.from === leftSeatNo;
  if (!chiFromOK && (opts ?? []).some(o => o.type === 'chi')) {
    if (badChiRef.current !== tableCardNow) {
      badChiRef.current = tableCardNow;
      report('badchi', `吃亮错了：牌 ${tc?.card} 来自座位 ${tc?.from}，我 ${mySeat}，上家 ${leftSeatNo}，阶段 ${g?.phase}`);
    }
  }
  const optTypes = new Set((opts ?? []).filter(o => o.type !== 'chi' || chiFromOK).map(o => o.type));
  const deadline = gAct?.myOptions?.deadline ?? 0;
  const remainRing = useRing(deadline, (gAct?.myOptions as any)?.span ?? 0, now);
  const remain = remainRing ? remainRing.sec : null;
  // 牌桌中央倒计时圆环：谁在行动就显示谁的；最后 5 秒弹数字并滴答
  const revealing = !!(stage.game as any)?.ended;          // 本局已结束、正在亮牌
  const revealingRef = useRef(false);
  revealingRef.current = revealing;
  // 只算"我自己摸上来的那张"：我打出去的牌在等别家表态时不显示（那是正常节奏，不用提示）
  const drawWaiting = !!g && (g as any).phase === 'claim' && !(g as any).ended && !revealing
    && (g as any).tableCard?.from === mySeat && (g as any).tableCard?.source === 'draw'
    && !g.myOptions?.options?.length && !pending && !chiPick;
  // 真的轮到我出牌、而且牌还没打出去
  // 真的轮到我出牌（含"弃胡之后自己点一张打出去"那种：阶段还是 drawer_decide）
  /* 提 / 跑 / 偎 之后引擎回头问"胡不胡"（drawer_decide）时，选项里也带着 discard，
     但这一刻该做的是"胡还是不胡"，不该再催一句"请点选一张牌" —— 等他放弃了胡再催。 */
  /* 按**画面上的**局面判，不按服务端的实时局面 —— 服务端算得快，动画还在播，
     它那边早就轮到我了；照实时的来，就会出现"前面的牌还在飞，这儿已经催我出牌"。
     （能不能真的出牌由服务端说了算，那是点下去之后的事；时限里已经把动画这段补进去了。） */
  const gShow: any = stage.game ?? g;
  const myTurnToDiscard = !!gShow && !revealing && gShow.turn === mySeat
    && (gShow.phase === 'discard' || gShow.phase === 'drawer_decide')
    && !!gShow.myOptions?.options?.some((o: ActionOption) => o.type === 'discard')
    && !(gShow.phase === 'drawer_decide' && (gShow.myOptions?.options as ActionOption[] | undefined)?.some(o => o.type === 'hu'));
  useEffect(() => { if (revealing) { setFloat(null); setLand(null); if (floatTimer.current) clearTimeout(floatTimer.current); if (landTimer.current) clearTimeout(landTimer.current); } }, [revealing]);
  // 实时状态里这一局已经结束了（正在亮牌 / 结算）就别切回等待面板 ——
  // 否则服务端刚把房间状态改回 waiting、而画面还在放最后几帧时，会闪一下"已准备"
  const liveEnded = !!(room.game as any)?.ended;
  /* 画面上这一局还在打（展示快照里有一局没结束的牌），就绝不切回"等待玩家加入"那一版 ——
     那一版里有「请机器人 / 请走机器人」按钮，打到一半突然盖上来，看着就像凭空弹了个框。
     服务端状态刚回到 waiting、而画面还在播最后几帧时最容易撞上。 */
  const waiting = (room.status !== 'playing' || !g) && !revealing && !liveEnded
    && !((stage.game as any) && !(stage.game as any).ended && stage.roundNo === room.roundNo);
  // 亮牌时在胡牌那家头上标一行：怎么胡的 + 多少胡息
  const huEvent = lastHu;
  const huTagFor = (seat: number): string | undefined => {
    if (!revealing || !huEvent || huEvent.seat !== seat) return undefined;
    const d: any = huEvent.detail;
    const how = d.tianHu ? '天胡' : d.diHu ? '地胡' : d.raiseHand ? '举手胡' : huEvent.card < 0 ? (BIG_HU_NAME[d.bigMeldType ?? ''] ?? '胡牌') : huEvent.ziMo ? '自摸' : '接炮';
    const way = huEvent.card >= 0 ? (HU_WAY_NAME[d.huWay ?? ''] ?? '') : '';
    return `${how}${way ? ' · ' + way : ''} · ${d.xi + (d.extraXi ?? 0)}息 · ${d.dun}敦${d.redName ? ' · ' + d.redName : ''}`;
  };
  // 手牌整体比原来大 30%（看不清的反馈）：牌面用 .card-xl，下面这几个数也跟着放大
  const AIM_LEN = 3;               // 理牌时每一列按"至少三张"看：不足的在上面补虚位，瞄准和判定都按它算
  /* 放大靠 CSS 的 zoom（见 .big-ui）：zoom 连布局一起放大，量出来的坐标自动跟着走。
     只有"摆在手牌外面、却要跟手牌对齐"的那几个数得自己乘一下 —— 它们算在 zoom 之外。 */
  const STEP = 53;                 // 同一列内每张牌错开的距离：留够字与字之间的空隙，上下两个字不互相压住
  const CARD_H = 169;              // .card-xl 高度
  const CARD_TAIL = 78;            // 每列最下面那张：小红印紧跟在牌字下面，红印下面再留一点，其余全剪掉
  const TRIM = CARD_H - CARD_TAIL; // 剪掉的那一截
  const maxColLen = Math.max(1, ...cols.map(c => c.length));
  const FAN_LIFT = 19;             // 固定值：剪裁之后的手牌下沿离屏幕底边的距离（手机四角是圆的，别贴太死）
  // 平排摆法：每列的牌上下错开只露字头，最下面那张剪到小红印下面；所有列的底边落在同一条线上
  const CARD_W = 48;               // .card-xl 宽度
  const COL_GAP = 3;
  const colH = (len: number) => CARD_H + STEP * (len - 1);          // 整列没剪之前的高度
  const colBox = (len: number) => CARD_TAIL + STEP * (len - 1);     // 剪完之后看得见的高度
  const FAN_SPREAD = Math.min(120, 15 * Math.max(1, cols.length - 1));   // 扇形张角（切到扇形摆法时用）；牌宽了，张角也要跟着拉开
  const MAX_COLS_UI = 7;       // 手牌摆得下几组：不满就在最后补一个虚拟组（见下面 ghostCol）
  const FAN_H = fanMode ? CARD_TAIL + STEP * (maxColLen - 1) + FAN_LIFT : colBox(maxColLen) + FAN_LIFT;
  // 手牌整片的横向半宽：下地牌 / 打出的牌 / 行动按钮贴着它的左右两侧摆。
  // 平排按"最多 8 组"算固定宽度 —— 打着打着牌变少，右边那摞弃牌也不会跟着左右乱跳
  const FAN_HALF = fanMode
    ? Math.round(colH(maxColLen) * Math.sin(FAN_SPREAD / 2 * Math.PI / 180)) + 24
    : Math.round((MAX_COLS * (CARD_W + COL_GAP)) / 2) + 8;
  // 手牌实际占的半宽（打掉牌就变窄）：下地牌贴着这条边，跟着手牌一起动
  const HAND_HALF = fanMode ? FAN_HALF : Math.round((cols.length * (CARD_W + COL_GAP)) / 2) + 4;
  /* 牌桌这一层的实际尺寸（页面是转过 90° 的，不能直接用 window 的宽高）。
     这里必须是 **state** 不能只留 ref：画布是 main.tsx 的 fitScreen 直接改 style 改出来的，
     React 完全不知道它变了 —— 只塞进 ref 的话，转屏之后整棵树不重画，
     出牌线的画板（下面那个 <svg>）还是旧尺寸、手牌缩放也还是旧值，
     线就"对不上手牌"了。fitScreen 改完会广播一声 phz-fit，收到就把新尺寸写进 state。 */
  const [rootSize, setRootSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const rootSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  /* 出牌线的两个尺寸，都按**没放大**的 CSS 像素写 —— 它画在手牌层里面，放大由 zoom 代劳。
     扇形：半径 = 扇柄到最长那列的牌头，再留 22 的余量。
     平排：线画在最高那列的牌头上面（14 是 .hand.fan.flat 的下内边距，STEP/2 是选中的牌抬起的高度）。 */
  const ARC_R = colH(maxColLen) + 2 + 22;
  const LINE_UP = 14 + colBox(maxColLen) + Math.round(STEP / 2) + 14;
  rootSizeRef.current = rootSize.w ? rootSize : rootSizeRef.current;
  useEffect(() => {
    const sync = () => {
      const r = document.getElementById('root');
      if (!r) return;
      const w = r.clientWidth, h = r.clientHeight;
      setRootSize(p => (p.w === w && p.h === h ? p : { w, h }));
    };
    sync();
    window.addEventListener('phz-fit', sync);
    return () => window.removeEventListener('phz-fit', sync);
  }, []);
  /* 大版放大手牌之前先看一眼放不放得下：手牌本来就快顶到两边了，
     再乘 1.2 很容易被屏幕切掉一列。放不下就少放大一点 —— 宁可小一号，也不能少半张牌。
     （下地、弃牌、按钮不受这一条限制，它们各占一角，放大了也不会顶边。） */
  const scrW = rootSize.w || (typeof window !== 'undefined' ? window.innerWidth : 852);
  const HAND_ZOOM = bigUI ? Math.min(1.2, Math.max(1, (scrW - 24) / Math.max(1, FAN_HALF * 2))) : 1;
  // 行动按钮：只在轮到自己表态时出现，且只显示当前真能用的那几个
  const actBtns0 = ['hu', 'peng', 'chi', 'pass'].filter(t => optTypes.has(t) || (t === 'pass' && optTypes.has('play_drawn')));
  // 摸上来一张自己也用不上的牌：只剩一个"打出"没意义 —— 谁也要不起的话服务端会自动替你打出去，
  // 所以这种情况干脆不给按钮（有吃 / 碰 / 胡可选时才留着"过"）
  const actBtns1 = actBtns0.length === 1 && actBtns0[0] === 'pass' && !optTypes.has('pass') ? [] : actBtns0;
  /* 已经点了某个动作、正在等服务端揭晓：**只留下点中的那一个**。
     以前别的按钮还灰着留在那儿 —— 点了吃，旁边还杵着一个碰，看着像"还能改主意"，
     其实这一手早就定了（服务端那边一表态就不再收别的动作）。留一个"已吃"最干净。 */
  /* 「这一张牌我已经表过态了」得钉在**这张牌**上，不能只靠 pending。
     pending 有个 4 秒的兜底解锁（防止服务端没回话把按钮锁死），一到点就清空 ——
     可服务端这时候往往还没揭晓，选项里吃还在，于是按钮"唰"地又冒出来一个：
     等待中的那个已经挪到了过牌的位置，上面又多出一个吃，看着莫名其妙。
     改成记在 committedRef 里，跟着桌上这张牌走：这张牌没换，就一直只剩点中的那一个。 */
  const decidedNow = (committedRef.current?.key === tableCardNow ? committedRef.current.act : null)
    ?? pending ?? (myDecided === 'pass' ? 'pass' : myDecided ?? null);
  const actBtns = decidedNow ? actBtns1.filter(t => t === decidedNow) : actBtns1;
  // 衡阳有胡必胡：能胡的时候服务端不给"过"，界面上也只留"胡"
  const mustHuNow = optTypes.has('hu') && !optTypes.has('pass');
  /* 行动按钮的**槽位骨架**：这一手一开始给了哪几个按钮，这一路就一直留着那几格，
     中途收掉的（「过」在点了碰 / 吃之后、碰在半程到点之后）只是不显形，位子还占着 ——
     按钮不会往下掉一格，手指记得住位置。
     **只留该留的那几格**，不是把七个动作全画上：这排按钮是竖着排、从下往上长的
     （见 styles.css 里 .actions 的 flex-direction: column），
     多画一格下面的，上面的「胡」就被顶高一截，够不着。 */
  const skelRef = useRef<{ key: unknown; list: string[] }>({ key: null, list: [] });
  const ACT_W = 90;            // 行动按钮改成竖排：只占一列的宽度，打出的牌堆按这个宽度避让
  const ringDeadline: number = g?.deadline ?? 0;
  const ring = useRing(ringDeadline, (g as any)?.deadlineSpan ?? 0, now);
  const ringLeft = ring?.left ?? 0;
  const ringFrac = ring?.frac ?? 0;
  const ringSec = ring?.sec ?? 0;
  // 该谁行动：抢牌阶段 —— 摸出来的牌归摸牌者，打出来的牌归下家；其余按 turn
  const actingSeat: number | null = !g || waiting ? null
    : g.phase === 'claim' && g.tableCard
      ? (g.tableCard.source === 'draw' ? g.tableCard.from : (g.tableCard.from + 1) % n)
      : g.turn;
  const ringWho = g && !waiting && actingSeat !== null ? (room.seats[actingSeat]?.user?.nickname ?? '') : '';
  const lastTickRef = useRef(0);
  const myMeldAtRef = useRef(0);     // 我最近一次进牌（重提 / 重跑不算）的时间
  useEffect(() => {
    if (!g?.myOptions || !ringDeadline || ringSec > 5 || ringSec <= 0 || lastTickRef.current === ringSec) return;
    lastTickRef.current = ringSec; tick();
  }, [ringSec, ringDeadline]);

  // 偎 / 提 / 跑 之后正好成胡：这一步很容易被当成"卡住了"，喊一嗓子并且让按钮闪起来
  const selfHuRef = useRef(false);
  const selfHu = !!(opts?.some(o => o.type === 'hu' && (o.card ?? 0) < 0));
  useEffect(() => {
    if (!selfHu) { selfHuRef.current = false; return; }
    if (selfHuRef.current) return;
    selfHuRef.current = true;
    say('可以胡了', 'can_hu'); toast('可以胡了 —— 点「胡」');
  }, [selfHu]);

  // 兜底：本局已经结束（亮牌中）却没弹结算面板时，按纪录表最后一条把它补出来 ——
  // 开跑胡这类少见路径万一漏了事件，也不会"什么都没有就下一局"
  useEffect(() => {
    if (!revealing) { settleShownRef.current = null; return; }
    const last0 = room.ledger[room.ledger.length - 1];
    // 面板已经开着（事件正常送到了）：记一笔，玩家点"确定"关掉之后别又自动弹回来
    if (settle) { settleShownRef.current = last0?.round ?? -1; return; }
    // 同一局只兜底一次
    if (!last0 || settleShownRef.current === last0.round) return;
    const last = last0;
    settleShownRef.current = last.round;
    if (last.hu) {
      const ev = { seat: last.hu.seat, card: last.hu.card, ziMo: last.hu.ziMo, fromSeat: last.hu.fromSeat, detail: last.hu.detail } as any;
      setSettle(ev); setLastHu(ev);   // 亮牌时要用它标出"胡的是哪张"
    }
    else setSettle('liuju');
  }, [revealing, room.ledgerCount ?? room.ledger.length, settle]);   // 纪录表只发最近 20 条，局数看 ledgerCount

  // 轮到我出牌：提示一次。要等画面上的动作（碰 / 偎 / 提 / 吃 / 跑 的报牌和冒泡）都放完再报，
  // 否则"该你出牌"会抢在「开跑！」前面，还会把排队的报牌挤掉
  useEffect(() => {
    // 必须真的轮到我出牌（阶段 + 座位都对得上）；只看选项里有没有 discard 会误报 ——
    // 比如下家开跑之后该他出牌，旧的一帧里我的选项还留着 discard
    /* 同样看**画面上的**局面：以前看的是服务端实时局面，
       它比画面早一整轮，于是"该你出牌"抢在前面的动画之前就喊了；
       等真轮到（比如我这一轮先开跑），又喊了第二遍。 */
    const gv: any = stage.game;
    const mine = gv?.phase === 'discard' && gv?.turn === mySeat
      && !!gv?.myOptions?.options?.some((o: ActionOption) => o.type === 'discard');
    if (!mine) { discardPromptRef.current = false; return; }
    if (discardPromptRef.current) return;
    discardPromptRef.current = true;
    let tries = 0;
    // 帧是"当时的快照"，等动画放完的这几秒里局面早就可能换人了（别家开跑、被人抢走），
    // 所以真要开口之前，拿最新的房间状态再确认一次确实还轮到我
    const go = () => {
      const now = roomRef.current.game as any;
      if (!now || now.phase !== 'discard' || now.turn !== mySeat) return;
      say('该你出牌', 'your_turn'); toast('轮到你出牌');
    };
    const waitIdle = () => {
      // 事件还在重放（动画 / 报牌没放完）就再等等，最多等 6 秒
      if ((evBusy.current || evQ.current.length) && tries++ < 30) { setTimeout(waitIdle, 200); return; }
      const since = Date.now() - myMeldAtRef.current;
      setTimeout(go, since < 4000 ? 500 + Math.round(Math.random() * 500) : 0);
    };
    waitIdle();
  }, [stage.game?.myOptions, (stage.game as any)?.phase, (stage.game as any)?.turn]);

  function act(type: string, extra?: { card?: Kind; combo?: Kind[]; lay?: number }) {
    note('点', `${type}${extra?.card !== undefined ? ':' + extra.card : ''}`);
    // 记下"这张牌我选了什么"——按钮要一直只剩这一个，直到桌上换牌
    if (['hu', 'peng', 'chi', 'pao', 'wei', 'ti', 'pass'].includes(type) && tableCardNow)
      committedRef.current = { key: tableCardNow, act: type };
    // 服务端要捂 3 秒才揭晓，这期间先把按钮锁上、显示"已XX"，免得看着像卡住了
    if (type === 'pass') passedRef.current = tableCardNow;
    if (['hu', 'peng', 'chi', 'pao', 'wei', 'ti', 'pass', 'play_drawn'].includes(type)) {
      setPending(type);
      if (pendTimer.current) clearTimeout(pendTimer.current);
      pendTimer.current = setTimeout(() => setPending(null), 4000);   // 兜底：万一没等到回应，别一直锁着（9 秒太久，锁着的这一手会整个错过）
    }
    socket.send({ type: 'game.act', action: type as any, ...extra });
  }
  const selectedCard = selected ? cols[selected.col]?.[selected.idx] ?? null : null;
  function moveCard(from: { col: number; idx: number }, toCol: number | null, toIdx?: number) {
    let next = cols.map(c => c.slice());
    const [card] = next[from.col].splice(from.idx, 1);
    // 手牌末尾那个虚拟组：列号正好越界，跟"拖到空地"是一回事 —— 单独成一组
    if (toCol !== null && toCol >= next.length) toCol = null;
    if (toCol === null) {
      // 拖到空地 → 单独成一组。手动摆牌允许比自动理牌多两组，再多就不给了
      next = next.filter(c => c.length);
      if (next.length >= MAX_COLS + 2) { toast(`手牌最多 ${MAX_COLS + 2} 组，理一下牌吧`); return; }
      next.push([card]);
    } else {
      if (toCol !== from.col && next[toCol].length >= MAX_COL) { toast(`一组最多 ${MAX_COL} 张，先拖出一张再放进去`); return; }
      next[toCol].splice(toIdx ?? 0, 0, card);   // 放到牌组顶端
    }
    manualRef.current = true;
    socket.send({ type: 'seat.wake' } as any);   // 动手理牌 = 人回来了，机器人退下
    // 拖走的那一组变了样，原来的钉子作废；落脚的那一组就是玩家亲手码的，钉住
    pinDrop(cols[from.col]);
    pinAdd(toCol === null ? next[next.length - 1] : next[toCol]);
    setCols(next.filter(c => c.length)); setSelected(null);
  }
  /** 出牌。拆坎不再事先弹窗：打出去之后由服务端罚分并把牌收回来（只罚分，不禁胡）
   *
   *  `at` = 玩家点的**那一张**在手牌里的位置。同一个字手里常有两张（一张码在组里、
   *  一张刚摸进来单摆着），只报牌面的话，重排手牌时按牌面从左往右配对，
   *  走的永远是最右边那张 —— 玩家点了左边那张，画面上左边那张又冒回来、右边那张不见了，
   *  接着整手牌重理一遍。所以这儿**当场按位置**把它从摆法里拿掉，服务端认不认都不影响画面。
   *  （服务端那边同字的几张本来就通用，打哪一张对它来说都一样。） */
  function tryDiscard(card: Kind, at?: { col: number; idx: number }) {
    if (!optTypes.has('discard')) { toast('现在不是你出牌'); return; }
    act('discard', { card }); setSelected(null);
    // 先斩后奏：牌当场离手、上明牌位置。服务端那一帧到了会用同一张牌把这个明牌再刷一次（带上牌号），
    // 接着照常飞进弃牌堆 —— 玩家看到的是一段连贯动作，不是"点完没反应，过一会儿牌才飞"
    if (at) { const next = dropCardAt(cols, at.col, at.idx, card); if (next) setCols(next); }
    setPendDiscard({ card, n0: countOf(myHand0, card), at: Date.now() });
    showFloat({ card, seat: mySeat, verb: '打' }, 0);
  }
  const handRef = useRef<HTMLDivElement | null>(null);
  const pvBaseRef = useRef<HTMLElement | null>(null);   // 扇柄（所有列绕它转开）
  const pvTipRef = useRef<HTMLElement | null>(null);    // 扇尖（最长那一列的牌头）
  /* 出牌线。扇形摆法是一段圆弧（圆心就是扇柄），平排摆法是一条**直线**（手牌上沿往上一点）。
     以前平排也拿圆弧凑合：圆心钉在底边正中、半径只算了"一列有多高" ——
     手里列数一多，这个圆就从两头切进牌里去了，中间那列要拖老远才出得去，
     边上那列一碰就出。看着就像"半圆往左挪了一组牌"。平排本来就是个方方正正的区域，
     该用直线就用直线。 */
  const pivotRef = useRef<{ x: number; y: number; r: number; line: number | null }>({ x: 0, y: 0, r: 0, line: null });
  /** 视口坐标 → #root 局部坐标（竖屏时 #root 整体旋转 90°，fixed 元素按它定位） */
  /* 页面坐标换算用的矩阵：拖牌时每动一下要换算十几个点，
     每次都 getComputedStyle 会逼浏览器重算一遍样式 —— 手机上就是这么发烫的。
     矩阵只有转屏 / 改尺寸时才变，缓存起来，拖动开始时刷新一次就够。 */
  const invRef = useRef<{ key: string; m: DOMMatrix | null }>({ key: '', m: null });
  function rootInverse() {
    const r = document.getElementById('root');
    if (!r) return null;
    const t = getComputedStyle(r).transform;
    if (!t || t === 'none') { invRef.current = { key: 'none', m: null }; return null; }
    if (invRef.current.key === t) return invRef.current.m;
    try { const m = new DOMMatrix(t).inverse(); invRef.current = { key: t, m }; return m; }
    catch { invRef.current = { key: t, m: null }; return null; }
  }
  function toLocal(x: number, y: number) {
    const m = invRef.current.key ? invRef.current.m : rootInverse();
    if (!m) return { x, y };
    const p = m.transformPoint(new DOMPoint(x, y));
    return { x: p.x, y: p.y };
  }
  /** 出牌弧线：以扇柄为圆心，半径 = 手牌长度 + 一段余量；拖出弧线即出牌（全部用 root 局部坐标） */
  // 我这边的明牌位置：让浮牌的中点正好落在出牌弧线的顶点上（靠近手牌，一眼看得见）
  const deckRef = useRef<HTMLDivElement | null>(null);
  /* 明牌那张卡片在 .float-card 里并不居中 —— 上面还顶着一行"谁 打"。
     量得到就量，量不到先按 9 估。 */
  const labelOffRef = useRef(9);
  const [myFloatAt, setMyFloatAt] = useState<{ dx: number; dy: number } | null>(null);
  const tbRef = useRef<HTMLDivElement | null>(null);
  /* 底区里那两块"要跟别的东西对齐"的位置，只能量出来：
     - 我的弃牌堆：紧贴下家那一堆的下沿（差 2px）
     - 我的下地牌：底边离自己头像那一条 5px
     写死数字是不行的 —— 头像那一条会随状态标多一行少一行，下家那一堆会随打出的牌变高。 */
  const [anchors, setAnchors] = useState<{ bandTop: number | null; bandRight: number | null; meldsBottom: number | null }>(
    { bandTop: null, bandRight: null, meldsBottom: null });
  function absPos(el: HTMLElement) {
    let x = 0, y = 0;
    for (let e: HTMLElement | null = el; e; e = e.offsetParent as HTMLElement | null) { x += e.offsetLeft; y += e.offsetTop; }
    return { x, y, w: el.offsetWidth, h: el.offsetHeight };
  }
  useEffect(() => {
    const measure = () => {
      const deck = deckRef.current, hand = handRef.current;
      if (!deck || !hand) return;
      calcPivot();
      /* 明牌（亮给大家看的那张）摆哪儿 —— **以公共牌堆为锚**。
         以前是钉在出牌弧线的顶点上（也就是跟着手牌走）：手牌一放大 / 一换摆法，
         它就跟着飘到一边去，最明显的就是切大字版之后整个偏到左边。
         现在只认两件事：横向跟公共牌堆对齐（正下方），纵向落在牌堆下边沿往下 20px。
         唯一的让步是别压住自己的手牌：真顶上了就往上收，收到贴着手牌上沿为止
         （宁可压住牌堆——明牌画在牌堆上层，也不挡自己的牌）。
         两个框都换算到"桌面坐标"里比，免得又掉进"量被 zoom 过的盒子"那个坑。 */
      const box = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        const q = [[r.left, r.top], [r.right, r.top], [r.right, r.bottom], [r.left, r.bottom]].map(([x, y]) => toLocal(x, y));
        const xs = q.map(v => v.x), ys = q.map(v => v.y);
        return { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2,
                 top: Math.min(...ys), bottom: Math.max(...ys),
                 left: Math.min(...xs), right: Math.max(...xs) };
      };
      const dk = box(deck), hd = box(hand);
      const FLOAT_HALF = 33 * (bigUI ? 1.2 : 1); // 明牌那张（只露字头 + 上面那行小字）的一半高度
      let cy = dk.bottom + 10 + FLOAT_HALF;                 // 牌堆下边沿往下 10px
      const limit = hd.top - 2 - FLOAT_HALF;                // 再往下就压到手牌了
      if (cy > limit) cy = limit;
      /* `.float-card` 是 `left:50%; top:50%` + `translate(-50%,-50%)` 再加上 --fx1/--fy1，
         所以这两个偏移量的**基准是它那个定位父元素的中心**，不是牌堆中心 ——
         以前按牌堆中心算，等于凭空多了一段固定误差，难怪改 5 改 10 都看不出区别。 */
      const par = (deck.offsetParent as HTMLElement | null) ?? deck;
      const pb = box(par);
      const fc = document.querySelector('.float-card') as HTMLElement | null;
      const fi = fc?.querySelector('.float-inner') as HTMLElement | null;
      if (fc && fi) labelOffRef.current = box(fi).cy - box(fc).cy;
      setMyFloatAt({ dx: Math.round(dk.cx - pb.cx), dy: Math.round(cy - labelOffRef.current - pb.cy) });
      const tb = tbRef.current;
      if (tb) {
        const tbb = box(tb);
        const bar = document.querySelector('.me-bar') as HTMLElement | null;
        const rp = document.querySelector('.seat.seat-r .pile-slot') as HTMLElement | null;
        // 我这一堆跟下家那一堆连成一块：他占上面一行、我占下面一行，右边沿对齐，中间隔 5px
        const rpb = rp ? box(rp) : null;
        const next = {
          bandTop: rpb ? Math.round(rpb.bottom + 5 - tbb.top) : null,
          bandRight: rpb ? Math.round(tbb.right - rpb.right) : null,
          meldsBottom: bar ? Math.round(tbb.bottom - box(bar).top + 5) : null,
        };
        setAnchors(a => (a.bandTop === next.bandTop && a.bandRight === next.bandRight
          && a.meldsBottom === next.meldsBottom ? a : next));
      }
    };
    measure();
    /* 什么时候要重量一遍：
       ① 手牌自己变了大小（换大小版、换摆法、打掉一张少一列）—— 用 ResizeObserver 盯着，
          这一条最要紧：切大小版是 CSS 缩放，**不触发 resize 事件**，光靠下面那几个监听是量不到的；
       ② 屏幕转了向（orientationchange 比 resize 晚，而且 iOS 上尺寸要过几帧才稳）；
       ③ 地址栏伸缩之类（visualViewport）。
       转屏之后再补几次：iOS 报完事件，布局还要抖上两三帧才定下来，只量一次十有八九量到半路的尺寸 ——
       出牌线就是这么飞到屏幕外面去的。 */
    const later = () => { for (const ms of [0, 120, 320, 700, 1200, 2000]) setTimeout(measure, ms); };
    window.addEventListener('resize', later);
    window.addEventListener('orientationchange', later);
    // 画布真正定下来的那一刻（fitScreen 写完 style 广播的），这才是最准的一次重量时机
    window.addEventListener('phz-fit', later);
    (window as any).visualViewport?.addEventListener('resize', later);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (handRef.current) ro?.observe(handRef.current);
    /* 下家那一堆也得盯着：他多打一张、排到第二行，那一块就变高了，
       我这一堆的位置是按他的下沿算的 —— 不跟着重量，两堆就叠一块儿去了。
       （这一条最容易漏：开局那会儿他那块还是空的最小高度，一打牌就长个儿。） */
    const rp0 = document.querySelector('.seat.seat-r .pile-slot');
    if (rp0) ro?.observe(rp0);
    const rootEl = document.getElementById('root');
    if (rootEl) ro?.observe(rootEl);
    const t = setTimeout(measure, 300);
    return () => {
      window.removeEventListener('resize', later);
      window.removeEventListener('orientationchange', later);
      window.removeEventListener('phz-fit', later);
      (window as any).visualViewport?.removeEventListener('resize', later);
      ro?.disconnect(); clearTimeout(t);
    };
  }, [waiting, cols.length, maxColLen, bigUI, fanMode]);

  function calcPivot() {
    const el = handRef.current; if (!el) return;
    /* 先把"屏幕坐标 → 桌面坐标"的那张矩阵重新取一遍。
       浏览器的地址栏一伸一缩，整个 #root 的缩放就跟着变（见 main.tsx 的 fitScreen），
       而这张矩阵是缓存着的 —— 不刷新就还按旧的缩放去换算，
       出牌线的圆心半径当场就歪了（最容易看见的就是"一动线就乱"）。 */
    invRef.current = { key: '', m: null }; rootInverse();
    /* 圆心**钉在手牌底边的中点**上（也就是扇柄），永远跟着手牌走；变大变小只改半径。
       所以这儿要的就是两件事：底边中点在哪、手牌有多高 —— 都用**桌面坐标**（#root 的局部坐标）。

       关键在换算：竖屏时整个 #root 是**转了 90°** 的，屏幕上的"下边"到了桌面坐标里根本不是下边。
       所以不能拿 `rect.bottom` 直接换算 —— 那样量出来的是个角上的点，
       圆心就飞到不知哪儿去了（出牌线整条歪出屏幕，正是这么来的）。
       正确做法：把矩形**四个角**各换算一遍，再取桌面坐标里的最小 / 最大值 ——
       旋转 90° 之后方框还是方框，min/max 出来的就是它在桌面坐标里的真实范围。
       （rect 本身已经含着手牌那层 zoom，所以量出来的高度是放大后的；
       半径里那几个按未缩放算的常量再乘一道 HAND_ZOOM。） */
    const rc = el.getBoundingClientRect();
    const pts = [[rc.left, rc.top], [rc.right, rc.top], [rc.right, rc.bottom], [rc.left, rc.bottom]]
      .map(([x, y]) => toLocal(x, y));
    const xs = pts.map(q => q.x), ys = pts.map(q => q.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const by = Math.max(...ys);
    const ty = Math.min(...ys);
    /* 扇形：直接量那两个准星。量得到就用量的（最准），量不到再退回按倍数折算的老路。 */
    const markAt = (el: HTMLElement | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return toLocal((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    };
    const base = fanMode ? markAt(pvBaseRef.current) : null;
    const tip = fanMode ? markAt(pvTipRef.current) : null;
    /* 放大倍数别用算出来的 HAND_ZOOM，**照量出来的算**。
       手牌那一层的高度是写死的（inline height: FAN_H），外面再套一层 CSS zoom；
       所以"量到的高 ÷ FAN_H"就是浏览器真正用的倍数。
       Safari 跟 Chrome 对 zoom 的处理本来就有出入，再加上 HAND_ZOOM 是上一次渲染算的、
       转屏之后可能还是旧值 —— 拿它去乘半径，大字版就会偏出一截（小字版 z=1 看不出来，
       这正是"只有大字版才歪"的由来）。量出来的这个数不会骗人。 */
    const zm = (by - ty) / Math.max(1, FAN_H);
    const z = zm > 0.5 && zm < 3 ? zm : HAND_ZOOM;
    pivotRef.current = fanMode
      ? (base && tip
          // 量到了：圆心就是扇柄，半径就是扇柄到扇尖的实距，再留一点余量（按同一个实距折算，不看倍数）
          ? { x: base.x, y: base.y, r: Math.hypot(tip.x - base.x, tip.y - base.y) * (ARC_R / Math.max(1, colH(maxColLen) + 2)), line: null }
          // 量不到（比如刚渲染出来还没挂上）：退回老办法
          : { x: cx, y: by - (FAN_LIFT - TRIM) * z + 2 * z, r: (colH(maxColLen) + 22) * z, line: null })
      // 平排：线画在手牌上沿再往上一点（留够选中的牌抬起来的那半个头）
      : { x: cx, y: by, r: 0, line: by - (LINE_UP - 14) * z };
    (window as any).__PHZ_DIAG__ = { cx, by, pv: pivotRef.current, z, zc: HAND_ZOOM, fan: fanMode,
      mark: base ? [Math.round(base.x), Math.round(base.y)] : null,
      rc: [Math.round(rc.left), Math.round(rc.top), Math.round(rc.width), Math.round(rc.height)] };
    const r = document.getElementById('root');
    if (r) {
      const w = r.clientWidth, h = r.clientHeight;
      rootSizeRef.current = { w, h };
      setRootSize(p => (p.w === w && p.h === h ? p : { w, h }));
    }
  }
  /** 越过出牌线多远（正数＝已经在线外面这么多） */
  function overLine(x: number, y: number) {
    const pv = pivotRef.current;
    return pv.line != null ? pv.line - y : Math.hypot(x - pv.x, y - pv.y) - pv.r;
  }
  function isDiscardZone(x: number, y: number) {
    const pv = pivotRef.current;
    return pv.line != null ? y < pv.line : Math.hypot(x - pv.x, y - pv.y) > pv.r;
  }
  // 拖动理牌 / 拖出出牌
  // 拖牌期间把 touchmove 一并吃掉：pointermove 拦不住 Safari / 微信的"橡皮筋"回弹，
  // 手一动整页就跟着飘（这一条必须 passive: false 才生效）
  const eatTouch = (e: TouchEvent) => { if (dragRef.current) e.preventDefault(); };
  /**
   * 拖牌期间挂在 window 上的那几个监听器。
   * 必须把"当时挂上去的那几个函数"记下来（boundRef），摘的时候摘同一批 ——
   * 组件每渲染一次，onWinMove / eatTouch 都是**新函数**，
   * 拿新函数去 removeEventListener 根本摘不掉旧的那个：
   * 每拖一次就漏一套监听器，漏下来的 eatTouch 还会一直 preventDefault（整页点不动、
   * Safari 的手势识别器就卡在那儿），漏下来的 pointermove 还带着过期闭包不停 setDrag —— 
   * 拖几次之后主线程就被刷爆，整个页面卡死。iOS 上报的
   * "WKDeferringGestureRecognizer is blocking its subgraph for 290 seconds" 就是这么来的。
   */
  const midsRef = useRef<{ col: number; x: number; y: number }[]>([]);
  const boundRef = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void;
    cancel: () => void; eat: (e: TouchEvent) => void } | null>(null);
  function bindWin() {
    unbindWin();                       // 上一次万一没摘干净，先摘掉
    const h = { move: onWinMove, up: onWinUp, cancel: onWinCancel, eat: eatTouch };
    boundRef.current = h;
    window.addEventListener('pointermove', h.move, { passive: false });
    window.addEventListener('touchmove', h.eat, { passive: false });
    window.addEventListener('pointerup', h.up);
    window.addEventListener('pointercancel', h.cancel);
  }
  function onCardPointerDown(e: React.PointerEvent, col: number, idx: number) {
    e.preventDefault();
    // 这一趟拖动的体检表。**得在量列间距之前建好** —— 建晚了会把刚写进去的数抹掉
    (window as any).__PHZ_DRAG__ = { moves: 0, draws: 0, gap: 0, last: 0 };
    invRef.current = { key: '', m: null }; rootInverse();   // 矩阵刷新一次（可能刚转过屏）
    calcPivot();
    /* ── 先把「手牌那层的 zoom」这笔账算清楚 ──────────────────────────
       手牌挂着 `zoom: var(--hand-zoom)`（大字版最多 1.2）。真机上坐实过：
       iPhone 上大字版和小字版量到的列距**都是 62**，本该差一个 1.2 倍 ——
       Safari 对 zoom 里面的元素，getBoundingClientRect() 返回的是**放大之前**的盒子。
       于是各列准星整体朝手牌层的左上角缩了 1/1.2，越靠扇形两头缩得越多，
       而手指的坐标不受影响 —— 这就是"拖到右边第三组、橙框却在第一组"。

       补法：在**桌面坐标**里、以手牌层自己的左上角为支点，把偏移乘回 zoom。
       为什么一定要在桌面坐标里：竖屏时整张牌桌转了 90°，屏幕坐标下包围盒的最小角
       根本不是这一层的布局原点，拿它当支点会整体平移出去几十像素（上一版补弃牌堆
       就是这么补歪的）。换到桌面坐标，这一层是正着的，最小角就是它的左上角。
       为什么支点取左上角是对的：zoom 不挪动元素自身的流内位置，只放大它的内容 ——
       所以 真实位置 = 左上角 + （量到的偏移 × zoom），两种引擎下这个式子都成立。

       补不补是现场判的：量到的尺寸 ÷ 它自己的 offset 尺寸，接近 zoom 就是引擎算过了
       （Chrome），接近 1 就是没算（Safari）。用对角线长度比，转屏也不影响。 */
    const handEl = handRef.current;
    const hz = handEl ? (Number(getComputedStyle(handEl).zoom) || 1) : 1;
    let pivotFix: { x: number; y: number } | null = null;
    if (handEl && hz > 1.001) {
      const hr = handEl.getBoundingClientRect();
      const hp = [[hr.left, hr.top], [hr.right, hr.top], [hr.right, hr.bottom], [hr.left, hr.bottom]]
        .map(([x, y]) => toLocal(x, y));
      const hx = hp.map(v => v.x), hy = hp.map(v => v.y);
      const w = Math.max(...hx) - Math.min(...hx), h = Math.max(...hy) - Math.min(...hy);
      const seen = Math.hypot(w, h) / Math.max(1, Math.hypot(handEl.offsetWidth, handEl.offsetHeight));
      if (Math.abs(seen - 1) < Math.abs(seen - hz)) pivotFix = { x: Math.min(...hx), y: Math.min(...hy) };
    }
    const unzoom = (p: { x: number; y: number }) => (pivotFix
      ? { x: pivotFix.x + (p.x - pivotFix.x) * hz, y: pivotFix.y + (p.y - pivotFix.y) * hz } : p);

    // 每一列的中线量一次存着：拖动过程中列不会动，没必要每动一下就 getBoundingClientRect 一圈
    midsRef.current = Array.from(handRef.current?.querySelectorAll('.hand-col') ?? [])
      .map(el => {
        const c = (el as HTMLElement).dataset.col;
        /* 取牌的**中心**（方框中心）：牌转过角度时，方框中心仍然是牌的中心，四个角却不是。
           不足三张的列拿最上面那个虚位当准星 —— 所有列的准星这才在同一排上。
           以前一律量实际的第一张牌：扇形是绕底边转开的，列越矮那张牌就越靠下、
           横向偏得越少，于是单张的那一列总是挤在中间，拖过去老是落到隔壁。 */
        const el2 = el as HTMLElement;
        /* 只认 `.col-aim`（每一列都有、大小位置一致）。退路照旧，只是正常情况下轮不到它。 */
        const r = (el2.querySelector('.col-aim') ?? el2.querySelector('.col-slot')
          ?? el2.querySelector('.card') ?? el2).getBoundingClientRect();
        const m = unzoom(toLocal((r.left + r.right) / 2, (r.top + r.bottom) / 2));
        return { col: Number(c), x: m.x, y: m.y };
      }).filter(m => Number.isFinite(m.col));
    /* 相邻两列准星之间的**实际间距**（取中位数）→ 判定半径。
       按列号排、算两点直线距离；以前是把 x 排序之后算 x 差，扇形两头那几列
       x 挨得近、实际隔得远，算出来的间距偏小，判定半径跟着偏小。 */
    const byCol = midsRef.current.slice().sort((a, b) => a.col - b.col);
    const gaps: number[] = [];
    for (let i = 1; i < byCol.length; i++) gaps.push(Math.hypot(byCol[i].x - byCol[i - 1].x, byCol[i].y - byCol[i - 1].y));
    gaps.sort((a, b) => a - b);
    const pitch = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    pickRRef.current = Math.max(30, (pitch || 50) * 1.3);
    /* 量出来的列间距记到体检表上。手牌那一层挂着 `zoom: var(--hand-zoom)`，
       而 Safari 对 zoom 里的元素返回的是**放大之前**的盒子（弃牌落点就栽在这上面）。
       真要是这样，这儿量到的间距会比真身小一整个 --hand-zoom 倍，
       各列准星整体往手牌原点方向缩，越靠两头错得越多 —— 正是"拖到右边第三组、
       却锁定右边第一组"的形状。屏幕上把这个数亮出来，对一下就知道。 */
    const st0 = (window as any).__PHZ_DRAG__;
    if (st0) { st0.pitch = Math.round(pitch); st0.cols = midsRef.current.length; st0.hz = hz; st0.fix = !!pivotFix; }
    const l0 = toLocal(e.clientX, e.clientY);
    lastMoveRef.current = l0;
    dragUiRef.current = null;

    dragRef.current = { col, idx, x0: l0.x, y0: l0.y, started: false };
    bindWin();
  }
  /**
   * 拖着的这张牌该落到哪一列：按**牌的中线**离哪一列最近算，不看手指在哪儿
   * （手指通常按在牌的中上部，按手指判定老是差一列）。
   * 每一列的位置取它**实际画出来的那张牌**的中线（按下那一刻量一次存着，见 midsRef）——
   * 扇形摆法下每列各自转了个角度、offsetLeft 全一样，只有按实际渲染位置量才准。
   */
  /* 判定半径：以前写死 70（桌面坐标）。小版一列间距约 50，70 等于一列半，松紧正好；
     一切大版，牌和间距都放大两成（间距约 60），70 就只剩一列多一点点 ——
     稍微拖偏一格就判成"落在空地上"，于是那张牌自己单独成了一列。
     这就是"大版挪牌容易弄错"的由来。现在改成**按量出来的列间距算**：
     间距是按下去那一刻连同 zoom 一起量的，大版小版、扇形平排都自动跟着走。 */
  const pickRRef = useRef(70);
  function dropColAt(x: number, _y: number): number | null {
    let best: number | null = null, bestD = Infinity;
    /* **只比 x，不比 y**。试过按两点直线距离算，结果更差：手指往下偏一点
       （离那条弧远了）就谁也匹配不上，当场变成"新开一列"。
       各列的准星本来就排在同一条弧上，横向谁近就是谁 —— y 不该参与。 */
    for (const m of midsRef.current) { const d = Math.abs(m.x - x); if (d < bestD) { bestD = d; best = m.col; } }
    return bestD <= pickRRef.current ? best : null;
  }
  /* 每动一下手指就重画一遍整张牌桌，手机会烫。用 rAF 压到"一帧最多一次"，
     手指动得再快，一秒也就重画 60 次以内（Safari 在后台还会自动降频）。 */
  const rafRef = useRef(0);
  const lastMoveRef = useRef<{ x: number; y: number } | null>(null);
  function onWinMove(e: PointerEvent) {
    const d = dragRef.current; if (!d) return;
    e.preventDefault();
    const l = toLocal(e.clientX, e.clientY);
    /* 起拖的门槛：原来 8px 太松 —— 手机上"点一下"本来就会晃出好几像素，
       一旦被当成拖动，松手那一刻只要落点在出牌线外面就直接把牌打出去了，
       看着就是"我明明只点了一下，牌却飞了"。抬到 16px，点是点、拖是拖。 */
    if (!d.started) { if (Math.hypot(l.x - d.x0, l.y - d.y0) < 16) return; d.started = true; }
    lastMoveRef.current = l;
    const st = (window as any).__PHZ_DRAG__;
    if (st) { st.moves++; const now = performance.now(); if (st.last) st.gap = Math.max(st.gap, now - st.last); st.last = now; }
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const pt = lastMoveRef.current; const dd = dragRef.current;
      if (!pt || !dd) return;
      // 跟着手指走的那张牌：直接改它的样式，不惊动 React
      const g = dragGhostRef.current;
      if (g) { g.style.left = `${pt.x}px`; g.style.top = `${pt.y}px`; }
      const overCol = dropColAt(pt.x, pt.y);
      const zone: 'discard' | null = isDiscardZone(pt.x, pt.y) ? 'discard' : null;
      const cur = dragUiRef.current;
      if (cur && cur.overCol === overCol && cur.zone === zone) return;   // 画面没变化，不重画
      dragUiRef.current = { overCol, zone };
      const st2 = (window as any).__PHZ_DRAG__; if (st2) st2.draws++;
      setDrag({ card: cols[dd.col][dd.idx], overCol, zone });
    });
  }
  function unbindWin() {
    const h = boundRef.current;
    if (!h) return;
    boundRef.current = null;
    window.removeEventListener('pointermove', h.move);
    window.removeEventListener('touchmove', h.eat);
    window.removeEventListener('pointerup', h.up);
    window.removeEventListener('pointercancel', h.cancel);
  }
  function onWinCancel() { dragRef.current = null; dragUiRef.current = null; setDrag(null); unbindWin(); }
  function onWinUp(e: PointerEvent) { unbindWin(); onCardPointerUp(e as unknown as React.PointerEvent); }
  function onCardPointerUp(e: { clientX: number; clientY: number }) {
    const d = dragRef.current; dragRef.current = null;
    dragUiRef.current = null;
    if (!d) return;
    const card = cols[d.col]?.[d.idx];
    if (d.started) {
      setDrag(null);
      if (card === undefined) return;
      const lu = toLocal(e.clientX, e.clientY);
      /* 出牌要"确实拖出去了"：光是松手时落在线外还不够 —— 最外沿那几张牌本来就贴着线，
         手指稍微往上一抖就已经在线外了。这儿再要求两条：
         从按下的地方**真的走了一段**（60px），而且**越过线还有一截**（18px）。 */
      const moved = Math.hypot(lu.x - d.x0, lu.y - d.y0);
      if (moved > 60 && isDiscardZone(lu.x, lu.y) && overLine(lu.x, lu.y) > 18) { tryDiscard(card, { col: d.col, idx: d.idx }); return; }
      const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (hit?.closest('.new-col-zone')) { moveCard(d, null); return; }   // 拖到最右边 → 单独成一列
      // 落到哪一列：按牌的下半截盖住谁最多算（松手那一下跟拖动时高亮的是同一列）
      const toCol = dropColAt(lu.x, lu.y);
      if (toCol !== null) { if (toCol !== d.col) moveCard(d, toCol); return; }
      // 落在没有牌组的空地上 → 自己单独成一组
      if (cols[d.col].length > 1) moveCard(d, null);
      return;
    }
    /* 连点两下＝出牌。必须是**又快又在同一处**的两下：
       - 两下间隔 260ms 以内（原来 350ms，手一慢就误判成"连点"）；
       - 两下按在屏幕上的位置相差不到 28px（同一张牌上的两下，手指不会跑那么远）。
       打出去的牌收不回来，这道门宁可紧一点：宁可让人多点一下，也别让人白丢一张。 */
    const now = Date.now(); const last = lastTapRef.current;
    const near = last && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 28;
    if (last && last.col === d.col && last.idx === d.idx && near && now - last.t < 260) {
      lastTapRef.current = null; if (card !== undefined) tryDiscard(card, { col: d.col, idx: d.idx }); return;
    }
    lastTapRef.current = { col: d.col, idx: d.idx, t: now, x: e.clientX, y: e.clientY };
    // 轮到自己出牌时：点一张就是"改选这一张"，不搬牌（搬牌请用拖动）
    if (optTypes.has('discard')) {
      if (selected && selected.col === d.col && selected.idx === d.idx) { setSelected(null); return; }
      selectAtTop(d.col, d.idx);
      return;
    }
    // 平时：已选中别的牌 → 点这一组就把它移过来；点自己 → 取消选中
    if (selected) {
      if (selected.col === d.col && selected.idx === d.idx) { setSelected(null); return; }
      moveCard(selected, d.col);
      return;
    }
    /* 不轮到我出牌的时候：点一张只是"看一眼"（高亮 + 抬起），**不换位置**。
       以前会把它挪到本组最上面 —— 手还没打牌，牌自己先跳了一下，
       想再点回原来那张还得找，反而添乱。轮到出牌时才换到最上面（那儿看得最清）。 */
    setSelected({ col: d.col, idx: d.idx });
  }
  // 组件卸载、页面切到后台、窗口失焦：拖动一律收摊，别把监听器和 dragRef 留在那儿
  const unbindRef = useRef<() => void>(() => { /* noop */ });
  unbindRef.current = () => {
    dragRef.current = null; setDrag(null); unbindWin();
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
  };
  useEffect(() => {
    const off = () => unbindRef.current();
    window.addEventListener('blur', off);
    document.addEventListener('visibilitychange', off);
    return () => { off(); window.removeEventListener('blur', off); document.removeEventListener('visibilitychange', off); };
  }, []);

  /** 选中一张牌：把它换到本组最上面（那儿看得最清楚），并记下新的位置 */
  function selectAtTop(col: number, idx: number) {
    setCols(cs => cs.map((c, i) => (i !== col || idx === 0 ? c : [c[idx], ...c.filter((_, j) => j !== idx)])));
    setSelected({ col, idx: 0 });
  }
  function discardSelected() { if (selectedCard !== null && selected) tryDiscard(selectedCard, selected); }
  /**
   * 出牌超时：不喊「过」—— 直接把选中的那张打出去；没选就打最右边那一张（从右往左、从下往上找，
   * 跳过坎里的牌，拆坎要罚分）。自己先打，服务端就不用替我挑了，报个牌名就完事。
   */
  const autoOutRef = useRef(0);
  useEffect(() => {
    if (!myTurnToDiscard || !deadline || pending) return;
    const left = deadline - now;
    if (left > 800 || left < -4000) return;
    if (autoOutRef.current === deadline) return;
    autoOutRef.current = deadline;
    const cnt = (k: Kind) => myHand.filter(x => x === k).length;
    let pick: Kind | null = selectedCard !== null && cnt(selectedCard) < 3 ? selectedCard : null;
    let at: { col: number; idx: number } | undefined = pick !== null && selected ? selected : undefined;
    if (pick === null) {
      outer: for (let i = cols.length - 1; i >= 0; i--)
        for (let j = cols[i].length - 1; j >= 0; j--) if (cnt(cols[i][j]) < 3) { pick = cols[i][j]; at = { col: i, idx: j }; break outer; }
    }
    // 摆法里一张都挑不出来（全是坎）才退回按牌面找：这时候没有位置，只能交给重排去配
    if (pick === null) { at = undefined; pick = [...myHand].reverse().find(k => cnt(k) < 3) ?? myHand[myHand.length - 1] ?? null; }
    if (pick !== null && pick !== undefined) tryDiscard(pick, at);
  }, [now, myTurnToDiscard, deadline, selectedCard, pending]);

  function onAction(o: ActionOption) {
    if (o.type === 'chi') {
      // 看"最后摆到桌上的牌"是不是都一样：一二三 吃小二下伙二七十，跟 二七十 吃小二下伙一二三，
      // 下地的结果完全相同，这种不用问玩家，直接吃 + 自动下伙
      const sig = (combo: Kind[], lay: Kind[][]) =>
        [o.card, ...combo, ...lay.flat()].slice().sort((a, b) => a - b).join(',');
      const all: { ci: number; li: number; sig: string }[] = [];
      (o.combos ?? []).forEach((cb, ci) => {
        const lays = o.comboLays?.[ci] ?? [];
        if (!lays.length) all.push({ ci, li: 0, sig: sig(cb, []) });
        else lays.forEach((lay, li) => all.push({ ci, li, sig: sig(cb, lay) }));
      });
      if (all.length && all.every(x => x.sig === all[0].sig)) return act('chi', { combo: o.combos![all[0].ci], lay: all[0].li });
      return setChiPick(o);
    }
    if (o.type === 'discard') return toast('请点选一张牌，再点一次打出');
    act(o.type);
  }
  /** 常驻按钮：系统不预判，玩家点了再由服务端裁定 */
  function pressButton(type: string, lockedBy?: string | null) {
    try { (window as any).NativeBridge?.vibrate?.(); } catch { /* ignore */ }
    const NAME: Record<string, string> = { ti: '提', wei: '偎', hu: '胡', pao: '跑', peng: '碰', chi: '吃', pass: '过' };
    /* 每一次按都记一笔 —— 包括按了没用的那些。
       以前只有真发出去的动作才进黑匣子（act() 里那句「点」），
       所以"点了没反应"这种事在日志里是**一片空白**，根本查不了是没收到、还是收到了没往下走。 */
    note('按', `${type}${lockedBy ? `(锁着:${lockedBy})` : ''}`);
    if (lockedBy) { toast(`已经点了「${NAME[lockedBy] ?? lockedBy}」，正在等别家表态`); return; }
    const o = opts?.find(x => x.type === type);
    if (o) return onAction(o);
    if (!g || waiting) return;
    // 按钮还在、服务端却已经不认这个动作了：多半是慢了半拍，说一声，别让人对着按钮发愣
    report('deadbtn', `按了「${NAME[type] ?? type}」却没有这个选项：阶段 ${g.phase} 轮到 ${g.turn} 桌上 ${(g as any)?.tableCard?.card ?? '-'} 现有选项 ${(opts ?? []).map(x => x.type).join(',') || '无'}`);
    // “过”与“打出”同义：手里拿着摸到的牌时按过 = 把它打出去
    if (type === 'pass') { if (optTypes.has('play_drawn')) return act('play_drawn'); if (g.phase === 'claim') return act('pass'); }
    toast(`现在不能${NAME[type] ?? type}`);
  }

  // 语音指令
  useEffect(() => {
    if (!settings.voiceCmd) { stopVoiceCommands(); return; }
    startVoiceCommands(cmd => { const o = (g?.myOptions?.options as ActionOption[] | undefined)?.find(x => x.type === cmd); if (o) onAction(o); });
    return stopVoiceCommands;
  }, [settings.voiceCmd, g?.myOptions]);

  async function talkStart() { if (await startRecording()) setTalking(true); else toast('无法使用麦克风'); }
  async function talkEnd() {
    if (!talking) return; setTalking(false);
    const v = await stopRecording();
    if (v) socket.send({ type: 'voice', ...v }); else toast('说话时间太短');
  }

  const gs = stage.game;                     // 展示用（牌桌上看到的），落后服务端几百毫秒
  myMeldCountRef.current = ((gs as any)?.players?.[mySeat]?.melds ?? []).length;
  // 放跑（自己打出去的牌被别家开跑）：本局不能再吃 / 碰，出现的时候明确说一声
  const iNoTake = !!(gs ?? g)?.players?.[mySeat]?.noTake;
  const noTakeRef = useRef(false);
  useEffect(() => {
    if (iNoTake && !noTakeRef.current) toast('你打出的牌被开跑了：本局不能再吃、碰（偎 / 提 / 跑 / 胡照旧）');
    noTakeRef.current = iNoTake;
  }, [iNoTake]);
  // 手牌也跟着画面走：不然摸到的牌还在飞，手里那一对已经先下地了（偎 / 提 / 碰 都一样）
  const myHand0: Kind[] = (gs?.players?.[mySeat]?.hand ?? g?.players?.[mySeat]?.hand ?? []) as Kind[];
  /* 打出去的牌**当场**就从手里拿走，不等服务端那一帧回来。
     以前是等回包才动：点完之后牌还在手上杵着大半秒，看着就像"没打出去"，
     很容易再点一下（或者以为卡了）。现在手一松牌就上明牌位置，
     服务端那一帧到了再接着飞进弃牌堆 —— 两段动作连得上，中间没有空当。
     服务端认了（手里真没这张了）或者过了 5 秒还没动静（被驳回），这一笔就撤掉。 */
  /* n0 = 点"打出"那一刻，这个字在我手里有**几张**。
     兑现与否只能按张数比，不能按"还在不在手里" —— 手里有两张小六、打掉一张，
     服务端认了之后剩的那张照样是小六，"还在"就成了永远兑现不了：
     这一笔一直挂着，等于把剩下那张也从手里抹掉了。（这就是"另一张小六也不见了、
     过几秒才回来"的病根 —— 回来是因为下面那 5 秒的兜底到点了。） */
  const [pendDiscard, setPendDiscard] = useState<{ card: Kind; n0: number; at: number } | null>(null);
  const countOf = (hand: Kind[], k: Kind) => hand.reduce((a, x) => a + (x === k ? 1 : 0), 0);
  const myHand: Kind[] = useMemo(() => {
    if (!pendDiscard) return myHand0;
    if (countOf(myHand0, pendDiscard.card) < pendDiscard.n0) return myHand0;   // 服务端已经拿走了
    const i = myHand0.indexOf(pendDiscard.card);
    return i < 0 ? myHand0 : [...myHand0.slice(0, i), ...myHand0.slice(i + 1)];
  }, [myHand0.join(','), pendDiscard?.card, pendDiscard?.n0, pendDiscard?.at]);
  useEffect(() => {
    if (!pendDiscard) return;
    // 这个字少了一张 = 服务端认了这一手，先斩后奏的那一笔兑现，撤掉
    if (countOf(myHand0, pendDiscard.card) < pendDiscard.n0) { setPendDiscard(null); return; }
    const id = setTimeout(() => setPendDiscard(null), 5000);   // 兜底：驳回 / 丢包，把牌还回手里
    return () => clearTimeout(id);
  }, [pendDiscard, myHand0.join(',')]);
  /** 依据当前可用动作，算出该高亮哪些手牌、在哪张上标注什么 */
  const hints = useMemo(() => {
    const mark = new Map<string, string>();       // "col-idx" → 标注文字（空串=只高亮）
    if (!opts?.length || !cols.length) return mark;
    const taken = new Set<string>();
    const put = (kinds: Kind[], label: string) => {
      const pos: string[] = [];
      for (const k of kinds) {
        let found = '';
        for (let c = 0; c < cols.length && !found; c++)
          for (let i = 0; i < cols[c].length; i++) {
            const key = `${c}-${i}`;
            if (cols[c][i] === k && !taken.has(key)) { found = key; break; }
          }
        if (!found) return;                        // 手牌里找不齐就不提示
        pos.push(found); taken.add(found);
      }
      pos.forEach((key, i) => mark.set(key, i === 0 ? label : ''));
    };
    for (const o of opts) {
      if (o.type === 'peng' || o.type === 'pao') put([o.card, o.card], ACTION_NAME[o.type]);
      else if (o.type === 'wei') put([o.card, o.card], '偎');
      else if (o.type === 'ti') put([o.card, o.card, o.card], '提');
      else if (o.type === 'chi' && o.combos?.length) {
        put(o.combos[0], '吃');
      }
    }
    return mark;
  }, [opts, cols]);
  const autoSortRef = useRef(autoSort2); autoSortRef.current = autoSort2;
  /** 上一次手牌是什么样（张数 + 下地了几组）：用来分辨"刚进张"还是"刚打出一张" */
  const prevHandRef = useRef<{ len: number; melds: number }>({ len: 0, melds: 0 });
  // 手牌分列：开了自动理牌就整手重理；关了只动散牌，码好的三张以上不碰
  useEffect(() => {
    setSelected(null);
    // 先把"上一手是什么样"记下来（早返回的分支也得记，不然下一次判断就错了）
    const pv = prevHandRef.current;
    prevHandRef.current = { len: myHand.length, melds: myMeldCount };
    // 亮牌阶段：保持打牌时的排法，胡进来的那张单独摆一列，不重新理牌
    if (revealingRef.current) {
      const kc = keepCols(cols, myHand);
      setCols([...kc.cols, ...kc.rest.map(k => [k])]);
      return;
    }
    // 起手牌（这一局还没排过）不管开关开没开，都先智能理一遍 —— 总不能让人对着一堆散牌开局
    // 起手牌（这一局还没排过）整手重理；打牌当中重理时，玩家自己码好的三张一组原样保留 ——
    // 那是他的思路，别给人拆了
    if (!cols.length) { setCols(autoCols(myHand)); return; }
    // 先拿现在的摆法去对手牌：还在手上的原样留着，新进来的另算
    const { cols: next, rest: remaining } = keepCols(cols, myHand);
    /* **进张的那一下不理牌**：摸上来、吃 / 碰 / 偎 / 提 / 跑 完了正要出牌的时候，
       牌一动位置就全变了，本来想打哪张都找不着，手忙脚乱。
       所以这时候原来的摆法一张不动，新进来的牌单独摆到最右边（一眼看得见），
       等**打出一张之后**再帮着理。
       "刚打出一张"＝手牌少了正好一张、而且下地牌没变（吃/碰那种是下地牌变了）。 */
    const justDiscarded = myHand.length === pv.len - 1 && myMeldCount === pv.melds;
    if (!justDiscarded) {
      for (const k of remaining) next.push([k]);       // 新来的牌摆最右边，单独一列
      /* 进张这一下**不重新理牌**（牌一动就全找不着了），但**换一下列的先后**：
         成了的、快成了的往左靠，双张和单张往右靠。组里的牌一张不动，只是整列平移 ——
         这样正要打的那几张（散牌）全聚在右手边，顺手就打，不用满屏找。
         真正的理牌等打出一张之后再做。 */
      setCols(orderCols(next));
      return;
    }
    if (autoSortRef.current && !manualRef.current) { setCols(autoColsKeep(myHand, next)); return; }
    // 不自动理牌：码好的三张以上原封不动，只把剩下的散牌（连同新进的牌）重新归集一下，摆到右边
    if (!autoSortRef.current) {
      const big = next.filter(c => c.length >= 3);
      const loose = [...next.filter(c => c.length < 3).flat(), ...remaining];
      setCols([...big, ...packCols(tidy(loose.map(k => [k])), 3)]);
      return;
    }
    for (const k of remaining) next.push([k]);
    // 牌组零碎了就重新智能理一次
    if (!tidyOk(next)) { manualRef.current = false; setCols(autoColsKeep(myHand, next)); return; }
    setCols(packCols(next));
  }, [myHand.join(',')]);
  // 胡牌那家的真实牌型组合（句子 + 那一对），亮牌时照这个分组
  const huGroupsOf = (seat: number): Kind[][] | null => {
    const d: any = gs?.ended && lastHu && lastHu.seat === seat ? (lastHu as any).detail : null;
    if (!d?.handGroups) return null;
    const gps: Kind[][] = d.handGroups.map((gr: any) => (gr.cards as Kind[]).slice());
    if (d.pair) gps.push((d.pair as Kind[]).slice());
    return gps.length ? gps : null;
  };
  /** 胡的那一张落在哪一组：引擎按这一手真正的拆法给了组号（huGroupIdx），按它来。
      光看牌面找永远有认错的时候 —— 二七十胡小二，一二三里也有个小二。 */
  const huGroupIdxOf = (seat: number): number => {
    const d: any = gs?.ended && lastHu && lastHu.seat === seat ? (lastHu as any).detail : null;
    return typeof d?.huGroupIdx === 'number' ? d.huGroupIdx : -1;
  };
  // 亮牌时我手里的「胡」字：只标一个 —— 胡的那张在哪一组，就标那一组打头的那张
  const myMarkCol = gs?.ended && lastHu && lastHu.seat === mySeat && lastHu.card >= 0
    ? cols.findIndex(c => c.includes(lastHu.card as Kind)) : -1;
  // 我胡牌时：把"含胡牌的那一句"摆到下地区，手牌列里就不再重复显示
  const myHuCol = useMemo(() => {
    const gps = huGroupsOf(mySeat);
    const card = lastHu?.card ?? -1;
    if (!gps || card < 0) return null;
    const gi = huGroupIdxOf(mySeat);
    if (gi >= 0 && gi < gps.length) return gps[gi];       // 引擎说的那一组
    return gps.find(gp => gp.includes(card as Kind)) ?? null;
  }, [gs?.ended, lastHu, mySeat]);
  const colsShown = useMemo(() => {
    if (!myHuCol) return cols;
    const rest = myHuCol.slice();
    const out = cols.map(c => c.filter(k => { const i = rest.indexOf(k); if (i >= 0) { rest.splice(i, 1); return false; } return true; })).filter(c => c.length);
    return out;
  }, [cols, myHuCol]);
  /* 手牌不满 7 组时，最后再挂一个**虚拟组**：一个空位。
     拖一张牌过去、或者选中一张牌之后点它，这张牌就单独成一组 ——
     不用再把牌拖到屏幕最右边那个「新一列」小框里去找地方。
     它跟真列一样有准星（.col-aim）和 data-col，所以拖动判定天然把它算进去。 */
  /* 只在**手动理牌**的时候才把它亮出来：正拖着一张牌，或者选中了一张准备搬家
     （轮到自己出牌时的"选牌"是在挑打哪一张，不算理牌，那会儿不出现）。
     平时手牌就是原来那个样子，不多一个空框在旁边晃。 */
  const sorting = !!drag || (!!selected && !myTurnToDiscard);
  const ghostCol = sorting && !revealing && !myHuCol && colsShown.length > 0 && colsShown.length < MAX_COLS_UI;
  const colKind = (c: Kind[]) => { if (c.length === 3 && partition(c, false).complete) return 'group'; if (c.length === 2 && c[0] === c[1]) return 'pair'; if (c.length === 2 && partition(c, true).pairs.length === 1) return 'pair'; return ''; };
  const seatsByRel = Array.from({ length: n }, (_, r) => room.seats[(mySeat + r) % n]);
  const leftSeat = seatsByRel[n - 1], rightSeat = seatsByRel[1], topSeat = n === 4 ? seatsByRel[2] : null;

  // 碰 / 跑 / 胡 的"快"窗口还剩多少（读秒的一半）；null = 这一手没有快窗口
  const fastUntil = (gAct?.myOptions as any)?.fastUntil ?? 0;
  // 这半程原本给了多久由服务端告诉我们 —— 衡阳"有胡必胡"是固定 5 秒，跟"读秒的一半"并不一样，
  // 客户端自己按读秒去除会把环画得不对（看着还剩不少，其实早就到点了）
  const fastSpan = Math.max(1, (gAct?.myOptions as any)?.fastSpan || Math.round((room.config?.turnSec ?? 20) * 1000 / 2));
  const fastFrac = useRing(fastUntil, fastSpan, now)?.frac ?? null;
  /* 衡阳「有胡必胡」：胡那个按钮单独一个更短的窗口（5 秒，到点自动胡）——
     以前胡跟碰共用一个窗口，碰也跟着被砍成 5 秒。现在各画各的圈。 */
  const huUntil = (gAct?.myOptions as any)?.huUntil ?? 0;
  const huSpan = Math.max(1, (gAct?.myOptions as any)?.huSpan || 1);
  const huFrac = useRing(huUntil, huSpan, now)?.frac ?? null;
  /* 吃那一路是整轮读秒：按这一手原本给的时长画圈 */
  const claimDl = gAct?.myOptions?.deadline ?? 0;
  const claimFrac = useRing(claimDl, (g?.myOptions as any)?.span ?? 0, now)?.frac ?? null;
  /* 快窗口（碰 / 跑 / 胡）的圈一走完，按钮就自己收掉 —— 不等服务端下一帧再收。
     以前那半秒里按钮还看得见、点下去却已经过期了，看着就是"明明还有碰的按钮，却碰不到牌"。 */
  const fastOver = fastFrac !== null && fastFrac <= 0;
  const huOver = huFrac !== null && huFrac <= 0;
  // 还留着「吃」的时候，「过」也得留着（这一路是整轮读秒，还没到点）
  const actBtnsLive = actBtns.filter(t => {
    if (t === 'hu' && huOver) return false;
    if (fastOver && t !== 'chi') return t === 'pass' && actBtns.includes('chi');
    return true;
  });
  /* 我点了吃 / 碰，可前面还有人（能碰、能胡）没吭声 —— 这一手得排队等他们表态。
     服务端这会儿已经不再给我选项了（myOptions 是空的），按钮要是跟着一起撤掉，
     看着就是"点了一下什么也没发生"。留下我点的那一个，绿框闪着等结果：
     别家放行了就直接吃进来，被他们碰走 / 胡走就是没吃成，牌该谁的谁的。
     「过」不用留 —— 点过就是不要了，没什么可等的。 */
  const waitHold = myWaiting && !!myDecided && myDecided !== 'pass' && !revealing;
  /* 大厅的桌子打完一局、有人走了：空位上直接点一下就能请个机器人来，
     不用再去翻「请机器人」那个按钮（私人房不来这套，房主自己招呼人） */
  /* 空位上点一下就能请个机器人来。
     以前多带了个 `!revealing` —— 一局打完之后 game 一直挂着 `ended`（要亮牌、要看结算），
     直到下一局发牌才清掉，所以那一整段等待里按钮根本不出现：
     "三个人打，一个人打完走了，想叫机器人顶上"正是这个时候，却怎么也点不着。
     牌局真在进行时 `status === 'playing'` 已经挡住了，这一条是多余的。 */
  const canInvite = !room.isPrivate && room.status !== 'playing' && mySeat >= 0;
  const isHost = room.hostId === me.id;
  const mySeatInfo = room.seats[mySeat];
  // 明牌还在飞的时候，别让它同时出现在弃牌区：牌先在明牌位置亮着，落下去了才进弃牌堆
  /* 按「牌号」藏，不再靠数张数比牌面 —— 同一个字有四张，比牌面永远有认错的时候，
     以前那个"打出去的牌闪一下又没了"就是这么来的。老服务端没有牌号时退回原来的数法。 */
  /* 明牌在飞（land）的时候也照样藏着 —— 不然牌会一边在半空、一边已经落在堆里，成了两张。
     **但只藏到落地为止**（`!land.done`）。落地之后就交还给真牌自己去画 ——
     这是"弃牌右边闪一张"的病根：`fx` 是 `float ?? land`，**float 优先**，
     所以下一张牌一摸出来，fx 就换成了新牌，旧那张当场不再被藏；
     可它的占位（我们自己画的那张）还在显 —— 同一张牌一下子有了两份，并排闪一下。 */
  const fx = float ?? (land && !land.done ? land : null);
  /** 服务端那一帧到了没有：这张刚打出去的牌，是不是已经在他的弃牌里了 */
  const landArrived = (seat: number): boolean => {
    if (!land || land.seat !== seat || land.meld) return false;
    const p: any = (gs as any)?.players?.[seat];
    if (!p) return false;
    return land.cid !== undefined
      ? (p.discardCids ?? []).includes(land.cid)
      : (p.discards?.length ?? 0) > (land.dcount ?? -1);
  };
  /**
   * 这一家的弃牌堆里要不要**我们自己画一张**：
   *   - 还在飞（!done）：要，但是隐形的 —— 纯粹占个位子，好让落点量得准；真牌这会儿被藏着。
   *   - 落地了、服务端那一帧还没到：要，而且显出来 —— 这就是"不等服务端，落地即成型"。
   *   - 落地了、真牌也到了：**不要**，交给真牌画。两者位置一样，换过去看不出来。
   * 这么一分，任何时刻那张牌都只有一份，不会并排出现两张。
   */
  const ghostOf = (seat: number): Kind | undefined =>
    (land && land.seat === seat && !land.meld && !(land.done && landArrived(seat))) ? land.card : undefined;
  const holdBack = (seat: number, cards: Kind[], cids?: number[]) => {
    if (fx && fx.seat === seat && fx.cid && cids?.length) {
      const i = cids.lastIndexOf(fx.cid);
      return i >= 0 ? cards.filter((_, j) => j !== i) : cards;
    }
    return fx && fx.seat === seat && fx.dcount !== undefined && cards.length > fx.dcount
      && cards[cards.length - 1] === fx.card ? cards.slice(0, -1) : cards;
  };
  // 同理：牌还在往下地区飞的路上，那一组牌先别摆出来（飞到了才落地）
  /* 按"进牌之前有几组"来藏新下地的那几组（吃牌带下伙会一次多出好几组，全都要等飞到了再摆）。
     以前是拿最后一组的头一张跟飞着的牌比牌面：吃六七八的时候，早就摆在那儿的「六六陆 / 六五七」
     头一张也是六，结果把旧的那组藏掉了 —— 看着就是老牌组闪了一下。 */
  const holdMelds = (seat: number, ms: Meld[]) => {
    const pm = preMeldRef.current;
    if (fx?.meld && fx.seat === seat && pm?.seat === seat && pm.melds !== undefined && ms.length > pm.melds)
      return ms.slice(0, pm.melds);
    return ms;
  };
  /* 起飞那一刻隐形占位还没渲染出来，落点只能先照着现有的牌推算一个。
     这一帧渲染完（占位已经在了）立刻量准、把终点改掉 —— useLayoutEffect 在画到屏幕之前跑，
     动画会用新终点重来一遍，眼睛看到的从头到尾就是对的那一条轨迹。 */
  useLayoutEffect(() => {
    if (!land || land.done || land.fixed) return;
    const box = pileRect(land.seat, land.meld);
    if (!box) { setLand(l => (l ? { ...l, fixed: true } : l)); return; }
    /* nextSlot 回来的可能**已经是桌面坐标**（弃牌那一路带 local 标记，它自己当场换算过了），
       也可能是屏幕坐标（进牌那一路量头像）。起飞那条路一直认这个标记，
       校准这条路却漏了 —— 于是弃牌的终点被**换算了第二遍**，直接飞到画布外面去
       （实测该落在 852,190 的点被改成了 189,-389）。这就是"雨滴落点总算不准"的根。 */
    const s2 = nextSlot(land.seat, land.meld, box, againIdxOf(land.seat, land.card, land.again && land.meld));
    const p2 = (s2 as any).local ? { x: s2.x, y: s2.y, w: s2.w } : toLocal2(s2);
    const moved = Math.abs(p2.x - land.x1) > 0.5 || Math.abs(p2.y - land.y1) > 0.5;
    // 校准之后的真终点也记到诊断对象上（?diag=1 和自动化测量都靠它对数）
    const d = (window as any).__PHZ_FLY__;
    if (d) { d.b2 = [Math.round(p2.x), Math.round(p2.y)]; d.moved = moved; }
    setLand(l => (l ? (moved ? { ...l, fixed: true, x1: p2.x, y1: p2.y, w: p2.w } : { ...l, fixed: true }) : l));
  }, [land?.card, land?.seat, land?.done, land?.fixed]);

  /* 落点那一摞把牌画出来了没有：画出来了才把"飞过去的那张"撤掉，中间不留空档。
     **只管进牌（吃碰提跑）这一路**。弃牌不再走这儿 —— 现在弃牌一落地就当场显出真牌了
     （不等服务端），所以"等服务端那一帧到了再撤"既没必要、还坏事：
     那一帧到得早，圆点刚停稳就被撤走，而撤的同时那一摞又重绘一次，
     看着就是弃牌旁边闪一下。弃牌改成老老实实停满 4 秒（见 flyToPile 里那个定时器）。 */
  useEffect(() => {
    if (!land?.done || !gs || !land.meld) return;
    const p: any = (gs as any).players?.[land.seat];
    if (!p) return;
    /* 重提 / 重跑那一下组数**不变**（拆掉三张的、换上四张的），
       照"组数变多了没有"去判，永远等不到，飞着的那张牌就只能靠兜底超时收走 ——
       看着是牌在半空停了一下。改成看那一组是不是已经四张了。 */
    const againAt = land.again && land.meld ? againIdxOf(land.seat, land.card, true) : undefined;
    const arrived = land.meld
      ? (land.again
        ? againAt !== undefined
        : (p.melds?.length ?? 0) > (preMeldRef.current?.seat === land.seat ? (preMeldRef.current?.melds ?? -1) : -1))
      : land.cid !== undefined
        ? (p.discardCids ?? []).includes(land.cid)
        : (p.discards?.length ?? 0) > (land.dcount ?? -1);
    if (!arrived) return;
    if (landTimer.current) clearTimeout(landTimer.current);
    /* 真牌已经画出来了，飞着的那张直接撤。
       以前这儿还会先"按真牌的位置摆正"再撤（两张重合，撤的时候看不出挪动）——
       那是配合"算准落点"用的。现在落点是钉死在那一摞旁边的，再摆正反而是明晃晃跳一格，
       不如就地消失：真牌同时出现在旁边，看着就是"飞过去、归位了"。 */
    setLand(null);
  }, [land?.done, gs, land?.seat, land?.cid]);

  const nextAt = g?.nextRoundAt ?? room.nextRoundAt ?? null;   // 第一局之前 game 还是空的，倒计时从房间状态上取
  // 开局倒计时按服务器给的"还剩多少毫秒"换算成本机的终点时间。
  // 以前是拿服务器的绝对时刻去减本机的钟：第一局之前还没有 game，也就没校过时差，
  // 手机的钟要是慢了几分钟，屏幕上就数出几千秒来，其实 3 秒就开局了。
  const nextRef = useRef<{ at: number; dl: number } | null>(null);
  if (nextAt === null) nextRef.current = null;
  else if (!nextRef.current || nextRef.current.at !== nextAt) {
    const left = (room as any).nextRoundIn;
    nextRef.current = { at: nextAt, dl: Date.now() + (typeof left === 'number' ? left : Math.max(0, Math.min(60000, nextAt - now))) };
  }
  const nextRoundIn = nextRef.current ? Math.max(0, Math.ceil((nextRef.current.dl - Date.now()) / 1000)) : null;
  // 开局倒计时最后 5 秒：一秒一声，越数越高；数到 0 再"当当"两声，提醒该回来看牌了
  const lastNextTickRef = useRef(-1);
  useEffect(() => {
    if (nextRoundIn === null) { lastNextTickRef.current = -1; return; }
    if (nextRoundIn > 5) { lastNextTickRef.current = nextRoundIn; return; }
    if (lastNextTickRef.current === nextRoundIn) return;
    const first = lastNextTickRef.current < 0;
    lastNextTickRef.current = nextRoundIn;
    if (!first || nextRoundIn > 0) countTick(nextRoundIn);   // 刚进来就正好 0 秒的那一下不响
  }, [nextRoundIn]);
  // 倒计时环：指针指向正在行动的那一家；环从指针处逆时针走（svg 先镜像再转，起点就落在指针上）
  const ringRel = actingSeat !== null && actingSeat >= 0 ? (actingSeat - mySeat + n) % n : -1;
  const ringDir = ringRel === 0 ? 'down' : ringRel === 1 ? 'right' : ringRel === 2 ? 'left' : null;
  // 指针换人：不瞬移，沿着出牌顺序（逆时针）转过去 —— 角度一直累加，只往负方向走
  const ringAngle = ringDir === 'down' ? 180 : ringDir === 'right' ? 90 : ringDir === 'left' ? 270 : null;
  const spinRef = useRef(180);
  const [spin, setSpin] = useState(180);
  useEffect(() => {
    if (ringAngle === null) return;
    const cur = ((spinRef.current % 360) + 360) % 360;
    let d = ((ringAngle - cur) % 360 + 360) % 360;   // 顺时针要转的角度
    if (d === 0) return;
    d -= 360;                                        // 一律走逆时针那一边
    spinRef.current += d; setSpin(spinRef.current);
  }, [ringAngle]);
  const ringSpin = spin - 90;

  return (
    /* 底图三档：暗 / 正常 / 亮。
       `--art-dim` 以前只当 svg 的 opacity 使 —— 而 opacity 封顶就是 1，
       写 1.12 跟写 1 没区别，所以「亮」那一档根本亮不上去。
       现在超过 1 的部分换成 brightness 接着提，再叠一层柔光（--art-glow）把整块桌面托亮。 */
    <div className={`table ${bigUI ? 'big-ui' : ''}`}
      style={{ ['--art-dim' as any]: [0.36, 0.72, 1.55][sky], ['--art-glow' as any]: [0, 0, 0.16][sky] }}>
      {/* 暂停（封顶 / 几局一歇）：红色横幅，房主或桌长点继续才接着打 */}
      {room.pausedReason && (
        <div className="pause-banner">
          <div className="pb-col">
            <div>{room.pausedReason}</div>
            {/* 歇下来这会儿正好是看账的时候：这一轮几局各赢了多少、房间总账多少，一并摆出来 */}
            {(() => {
              const every = room.config?.pauseEvery ?? 0;
              const from = every > 0 ? room.roundNo - every : 0;
              const seg: Record<number, number> = {};
              let cnt = 0;
              for (const l of room.ledger) if (l.round > from) {
                cnt++;
                for (const [id, d] of Object.entries(l.deltas)) seg[Number(id)] = (seg[Number(id)] ?? 0) + d;
              }
              const rows = room.seats.filter(st => st.user);
              if (!rows.length || !cnt) return null;
              const cls = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
              return <>
                <table className="ledger pause-sum">
                  <thead><tr><th />{rows.map(st => <th key={st.seat}>{st.user!.nickname}</th>)}</tr></thead>
                  <tbody>
                    {/* 纪录表只发最近 20 条，所以这儿写**实际数到的局数**，不写"应该是几局" */}
                    <tr><td>这 {cnt} 局</td>
                      {rows.map(st => <td key={st.seat} className={cls(seg[st.user!.id] ?? 0)}>{fmt(seg[st.user!.id] ?? 0)}</td>)}</tr>
                    <tr className="lg-total"><td>总输赢</td>
                      {rows.map(st => <td key={st.seat} className={cls(st.total)}>{fmt(st.total)}</td>)}</tr>
                  </tbody>
                </table>
                {/* 歇下来这会儿正是发群里对账的时候：画成一张图，长按就能存 */}
                <button className="ghost pause-shot" onClick={() => setShot({
                  title: `${room.isPrivate ? `房号 ${room.id}` : room.name ?? '大厅'} · 底分 ${room.baseScore}`,
                  sub: `${room.variantName} · 第 ${room.roundNo} 局 · ${stamp()}`,
                  segLabel: `这 ${cnt} 局`,
                  rows: rows.map(st => ({ name: st.user!.nickname, seg: seg[st.user!.id] ?? 0, total: st.total })),
                })}>导出截图</button>
              </>;
            })()}
          </div>
          {/* 谁能点「继续」由服务端说了算：房主，或者桌长（桌上最早坐下的那个真人）——
              大厅的桌子没有房主，就全靠桌长。别人只看得到横幅，看不到按钮。 */}
          {(room.canResume ?? isHost) && <button onClick={() => socket.send({ type: 'room.resume' })}>继续</button>}
        </div>
      )}
      {/* 牌桌背景：玩法水印 + 手绘底图（衡阳：衡山与南飞的雁；耒阳：神农造纸与弯弯的耒水） */}
      <TableArt variant={room.variant} name={room.variantName} onSky={cycleSky} />
      {/* 顶栏 */}
      <div className="table-top">
        <div className="tt-left">
          <button className="ghost sq-exit" onClick={leaveTable}>‹‹</button>
        </div>
        {/* 双击这一行：弹出视口尺寸，排查"屏幕边上留白"这类问题。玩法名不写了 —— 桌面水印上有 */}
        <span className="tt-title" onDoubleClick={() => {
            const vv = window.visualViewport, r = document.getElementById('root')!.getBoundingClientRect();
            toast(`win ${window.innerWidth}×${window.innerHeight} · vv ${Math.round(vv?.width ?? 0)}×${Math.round(vv?.height ?? 0)}`
              + ` · scr ${screen.width}×${screen.height} · root ${Math.round(r.width)}×${Math.round(r.height)}`
              + ` · dpr ${devicePixelRatio} · ${(navigator as any).standalone ? '主屏幕' : '浏览器'}`);
        }}>
          <EaveBar theme={eave} onCycle={() => {
            const next = EAVE_ORDER[(EAVE_ORDER.indexOf(eave) + 1) % EAVE_ORDER.length];
            setEave(next); try { localStorage.setItem('phz_eave', next); } catch { /* ignore */ }
          }}>{room.isPrivate ? `房号 ${room.id}` : room.name ?? '大厅'} · 底分 {room.baseScore} · 第 {room.roundNo} 局</EaveBar>
        </span>
        <div className="tt-right">
          {/* 摆牌方式 / 自动理牌平时收起来，点 ▾ 才展开；选完自动收回去 */}
          <div className={`tt-tools ${toolsOpen ? 'open' : ''}`}>
            {/* 这里原来是个「▾」—— 看着像"还有更多"，其实点开就是全部设置。
                换成齿轮，一眼就知道是设置的入口，不用点进去才明白。 */}
            <button className="ghost tt-more" title="牌桌设置" onClick={() => setToolsOpen(o => !o)}>
              <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor"
                   strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="3.2" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
              </svg>
            </button>
            {toolsOpen && <div className="tt-pop">
              {/* 手牌摆法：扑克（平排）⇄ 扇形。换摆法的时候自动理牌跟着走：扇形＝开，平排＝关 */}
              <button className="ghost tt-item" title="手牌摆法：平排 / 扇形"
                onClick={() => {
                  const v = !fanMode; setFanMode(v);
                  try { localStorage.setItem('phz_fan', v ? '1' : '0'); } catch { /* ignore */ }
                  const a = v ? '1' : '0'; setAutoPref(a);
                  try { localStorage.setItem('phz_autosort', a); } catch { /* ignore */ }
                  if (a === '1') { manualRef.current = false; setCols(autoColsKeep(myHand, cols)); }
                  toast(v ? '手牌：扇形 · 理牌开' : '手牌：平排 · 理牌关'); setToolsOpen(false);
                }}>
                {fanMode ? <IconFan /> : <IconFlat />}<b>{fanMode ? '扇' : '排'}</b></button>
              {/* 自动理牌：机器人脑袋当滑块，左右拨 */}
              <button className={`ghost tt-item ${autoSort2 ? 'on' : ''}`} title="自动理牌"
                onClick={() => {
                  const v = autoSort2 ? '0' : '1'; setAutoPref(v);
                  try { localStorage.setItem('phz_autosort', v); } catch { /* ignore */ }
                  if (v === '1') { manualRef.current = false; setCols(autoColsKeep(myHand, cols)); }
                  toast(v === '1' ? '自动理牌：开' : '自动理牌：关'); setToolsOpen(false);
                }}>
                <span className="sw"><i className="sw-knob"><IconBot /></i></span><b>{autoSort2 ? '开' : '关'}</b></button>
              {/* 牌面字体：点一下换下一套（隶 → 楷 → 宋 → 圆 → 碑刻 → 圆篆 → 隶）。
                  后两套是我们自己把二十个字一笔一笔描出来的，不吃手机装没装某款字体 */}
              <button className="ghost tt-item" title="牌面字体"
                onClick={() => { setFontPick(true); setToolsOpen(false); }}>
                <span className="tt-font">字</span><b>{cardFont().short}</b></button>
              {/* 大字版 / 小字版：牌和按钮一起放大两成，眼睛不好使的时候好认 */}
              <button className={`ghost tt-item ${bigUI ? 'on' : ''}`} title="字号：小版 / 大版（牌和按钮一起放大）"
                onClick={() => {
                  const v = !bigUI; setBigUI(v);
                  try { localStorage.setItem('phz_bigui', v ? '1' : '0'); } catch { /* ignore */ }
                  toast(v ? '大字版：牌和按钮都放大了' : '小字版'); setToolsOpen(false);
                }}>
                <span className="tt-font">大</span><b>{bigUI ? '大版' : '小版'}</b></button>
              {/* 底图亮度：点日头 / 月亮也能换，这里再给一个入口 —— 那颗天体有时会被别的东西盖住点不到 */}
              <button className="ghost tt-item" title="牌桌底图：暗 / 正常 / 亮"
                onClick={() => { cycleSky(); setToolsOpen(false); }}>
                <span className="tt-font">图</span><b>{['暗', '正常', '亮'][sky]}</b></button>
              <button className={`ghost tt-item ${settings.tts ? 'on' : ''}`} title="声音开关"
                onClick={() => {
                  settings.tts = !settings.tts; settings.save(); force(x => x + 1);
                  /* iOS 只允许在**用户手势里**唤醒音频。息屏、切后台、接个电话回来，
                     那个音频环境就睡过去了，光靠心跳唤不醒 —— 这时候玩家往往就是来点这个开关的，
                     正好借这一下手势把它叫醒。开和关都叫一次：关了再开也能立刻出声。 */
                  /* 点这个开关的人，十有八九就是"怎么没声音了"来的。
                     所以不光叫醒 —— **直接推倒重建一次**，把 iOS 那个 resume 拉不回来的
                     interrupted 状态甩掉。这是在手势里，正是唯一能这么干的时机。 */
                  if (settings.tts) { unlockAudio(); resetAudio(); }
                  toast(settings.tts ? '声音：开' : '声音：关'); setToolsOpen(false);
                }}>
                <IconSound on={settings.tts} /><b>{settings.tts ? '开' : '关'}</b></button>
              {/* 报牌声：跟挑字体一个路子 —— 后台录了几套就能挑几套 */}
              <button className="ghost tt-item" title="报牌声：挑一套自己喜欢的"
                onClick={() => { setToolsOpen(false); voicePacks().then(setPacks); setSoundPick(true); }}>
                <span className="tt-font">声</span><b>{packId === 'off' ? '系统' : packId ? '自选' : '默认'}</b></button>
              {/* 左上角那个 ‹‹ 万一被状态栏挡着点不动，从这里也能退 */}
              {/* 「大厅」那一项去掉了：左上角那个 ‹‹ 就是它，同一件事不用摆两个入口。
                  真想让出位子的走下面的「起立」。 */}
              {/* 起立离开：位子不再留着，重连也不会把你拽回来 */}
              <button className="ghost tt-item tt-stand" title="起立离开：不再回这一桌，位子让出去"
                onClick={() => { setToolsOpen(false); standUp(); }}><IconStand /><b>起立</b></button>
            </div>}
          </div>
          {/* 纪录表：用一个"表格"图标，不占字 */}
          <button className="ghost sq-icon" title="纪录表" onClick={() => setShowLedger(true)}>
            <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
              <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
              <path d="M3.5 9h17M3.5 14.5h17M9.5 9v11M15 9v11" />
            </svg>
          </button>
          {/* 玩法说明：摆在最右边（行动按钮就跟它右对齐），牌局中想不起规则随时点开 */}
          <button className="ghost sq-icon" title="玩法说明" onClick={() => setShowRules(true)}>
            <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M9.3 9.2a2.8 2.8 0 0 1 5.4.9c0 1.9-2.7 2.1-2.7 4" />
              <circle cx="12" cy="17.4" r="1.05" fill="currentColor" stroke="none" />
            </svg>
          </button>
        </div>
      </div>
      {chatOpen && <div className="chatpanel">
        <div className="chatlog">{chat.slice(-8).map((c, i) => <div key={i}><b>{c.from.nickname}：</b>{c.text ?? <span onClick={() => c.voice && playVoice(c.voice.data, c.voice.mime)} style={{ cursor: 'pointer' }}>🔈 语音 {Math.round((c.voice?.durationMs ?? 0) / 1000)}″</span>}</div>)}</div>
        <div className="row"><input value={text} placeholder="说点什么…" onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && text.trim()) { socket.send({ type: 'chat', text }); setText(''); } }} />
          <button onClick={() => { if (text.trim()) { socket.send({ type: 'chat', text }); setText(''); } }}>发送</button></div>
      </div>}

      {/* 中区：上家 | 中央 | 下家 */}
      <div className="table-mid">
        <SeatBox seat={leftSeat} mySeat={mySeat} huTag={huTagFor(leftSeat.seat)} holdCard={fx && fx.seat === leftSeat.seat ? fx.card : null} holdCid={fx && fx.seat === leftSeat.seat ? fx.cid : undefined} landDone={!!land?.done} landCard={ghostOf(leftSeat.seat) ?? null} holdMeldCard={fx?.meld && fx.seat === leftSeat.seat ? fx.card : null} landMeldCard={land?.meld && land.seat === leftSeat.seat ? land.card : null} landMeldSize={land?.meldSize} landMeldAgain={land?.again} holdMeldsFrom={fx?.meld && fx.seat === leftSeat.seat && preMeldRef.current?.seat === leftSeat.seat ? preMeldRef.current.melds : undefined} holdCount={fx?.meld && fx.seat === leftSeat.seat && preMeldRef.current?.seat === leftSeat.seat ? preMeldRef.current.count : undefined} label="上家" side="left" ringFrac={ringFrac} g={gs} rel={n - 1} isTurn={actingSeat === leftSeat.seat} dealer={g?.dealer === leftSeat.seat} onAvatar={id => setProfile(id)} onKick={s => setKick(s)} onInvite={canInvite ? (st => socket.send({ type: 'room.bots', add: true, seat: st })) : undefined} bubbles={bubbles} huMark={gs?.ended && lastHu && lastHu.card >= 0 && lastHu.seat === leftSeat.seat ? (lastHu.card as Kind) : null} huCid={gs?.ended && lastHu ? (lastHu as any).cid : undefined} huGroups={huGroupsOf(leftSeat.seat)} huGroupIdx={huGroupIdxOf(leftSeat.seat)} fouls={fouls} />
        <div className="center-area">
          {topSeat && <SeatBox seat={topSeat} mySeat={mySeat} huTag={huTagFor(topSeat.seat)} holdCard={fx && fx.seat === topSeat.seat ? fx.card : null} holdCid={fx && fx.seat === topSeat.seat ? fx.cid : undefined} landDone={!!land?.done} landCard={ghostOf(topSeat.seat) ?? null} holdMeldCard={fx?.meld && fx.seat === topSeat.seat ? fx.card : null} landMeldCard={land?.meld && land.seat === topSeat.seat ? land.card : null} landMeldSize={land?.meldSize} landMeldAgain={land?.again} holdMeldsFrom={fx?.meld && fx.seat === topSeat.seat && preMeldRef.current?.seat === topSeat.seat ? preMeldRef.current.melds : undefined} holdCount={fx?.meld && fx.seat === topSeat.seat && preMeldRef.current?.seat === topSeat.seat ? preMeldRef.current.count : undefined} label="对家" ringFrac={ringFrac} g={gs} rel={2} isTurn={actingSeat === topSeat.seat} dealer={g?.dealer === topSeat.seat} onAvatar={id => setProfile(id)} onKick={s => setKick(s)} onInvite={canInvite ? (st => socket.send({ type: 'room.bots', add: true, seat: st })) : undefined} bubbles={bubbles} huMark={gs?.ended && lastHu && lastHu.card >= 0 && topSeat && lastHu.seat === topSeat.seat ? (lastHu.card as Kind) : null} huCid={gs?.ended && lastHu ? (lastHu as any).cid : undefined} huGroups={huGroupsOf(topSeat.seat)} huGroupIdx={huGroupIdxOf(topSeat.seat)} fouls={fouls} horizontal />}
          {waiting ? <WaitingPanel room={room} me={me} isHost={isHost} nextRoundIn={nextRoundIn} /> : (
            <>
              <div className="deck-wrap" ref={deckRef}>
                {/* 轮到谁：指针指向那一家（我在下、下家在右、上家在左），绿环从指针那儿开始逆时针走 */}
                {ringDeadline > 0 && !gs?.ended && ringDir && <TurnPointer angle={spin} color={ringColor(ringFrac)} />}
                {/* 倒计时圆环：贴着公共牌边缘走，线也细一半 */}
                {ringDeadline > 0 && !gs?.ended && <svg className="deck-ring" viewBox="0 0 100 100" width="100" height="100"
                  style={{ transform: `rotate(${ringSpin}deg)` }}>
                  <circle cx="50" cy="50" r="33" fill="none" stroke="rgba(255,255,255,.13)" strokeWidth="3" />
                  <circle cx="50" cy="50" r="33" fill="none" stroke={ringColor(ringFrac)} strokeWidth="3" strokeLinecap="round"
                    strokeDasharray={`${2 * Math.PI * 33}`} strokeDashoffset={`${2 * Math.PI * 33 * (1 - ringFrac)}`}
                    /* 这儿以前挂着 `transition: stroke-dashoffset .25s linear`。
         看着是顺滑了，代价是：圈每 250ms 收到一个新值就补一段 250ms 的动画 —— 首尾相接，
         等于**整局游戏一直有一条 60 帧／秒的动画在跑**。而 stroke-dashoffset 合成器插不了值，
         每一帧都得重算样式、把这圈 SVG 重画一遍；屏上同时有三四个圈（三家头像 + 按钮），
         叠起来就是一份不小的持续开销。倒计时本来就是一秒跳四格，直接跳没人看得出来。 */ />
                </svg>}
                {!gs?.ended && <div className="deck-head" title="公共牌堆"><span>{gs?.pileLeft ?? g.pileLeft}</span></div>}
                {/* 亮牌时：下一局的倒计时就摆在公共牌堆这儿，大小跟倒计时环一样 */}
                {gs?.ended && nextRoundIn !== null && <div className="next-count deck-count">
                  <span key={nextRoundIn} className={nextRoundIn <= 5 ? 'tick' : ''}>{nextRoundIn}s</span>
                </div>}
                {!gs?.ended && ringSec <= 5 && ringSec > 0 && <span key={ringSec} className="deck-num">{ringSec}</span>}
                {/* 亮牌：胡的那张牌 + 没翻出来的公共牌，一条摆在我手牌的底端（正好盖住那一排小红印） */}
                {((gs?.ended && lastHu && lastHu.card >= 0) || (gs?.pileRest && (gs.pileRest as Kind[]).length > 0)) && (
                  <div className="reveal-strip">
                    {gs?.ended && lastHu && lastHu.card >= 0 && (
                      <span className="deck-hu" title="胡的这张牌">
                        <Card kind={lastHu.card as Kind} size="sm" head className="card-mark" />
                      </span>
                    )}
                    {gs?.pileRest && (gs.pileRest as Kind[]).length > 0 && (
                      <div className="pile-rest" title="没翻出来的公共牌">
                        {(gs.pileRest as Kind[]).map((k, i) => (
                          <span key={i} className="pile-rest-item">
                            <Card kind={k} size="xs" head />
                          </span>
                        ))}
                        <span className="pile-rest-item end" title="底牌到此为止">
                          <Card kind={-1} size="xs" head />
                        </span>
                      </div>
                    )}
                  </div>
                )}
                {/* 胡了的那一家：大印就盖在**他自己的明牌位**上 —— 摸牌打牌时那张牌冒出来的就是这儿，
                    每家一个固定的点，谁胡了一眼就对上人，也不会压着亮出来的牌。 */}
                {revealing && lastHu && lastHu.seat >= 0 &&
                  <HuStamp rel={(lastHu.seat - mySeat + n) % n} n={n} mineAt={myFloatAt} />}
                {float && <FloatCard card={float.card} rel={(float.seat - mySeat + n) % n} n={n} who={room.seats[float.seat]?.user?.nickname} verb={float.verb}
                  fromRel={float.fromSeat !== undefined ? (float.fromSeat - mySeat + n) % n : undefined} mineAt={myFloatAt} />}
              </div>
            </>
          )}
          {room.status === 'paused' && <div className="big-msg">暂停中 · 等待玩家补位</div>}
        </div>
        <SeatBox seat={rightSeat} mySeat={mySeat} huTag={huTagFor(rightSeat.seat)} holdCard={fx && fx.seat === rightSeat.seat ? fx.card : null} holdCid={fx && fx.seat === rightSeat.seat ? fx.cid : undefined} landDone={!!land?.done} landCard={ghostOf(rightSeat.seat) ?? null} holdMeldCard={fx?.meld && fx.seat === rightSeat.seat ? fx.card : null} landMeldCard={land?.meld && land.seat === rightSeat.seat ? land.card : null} landMeldSize={land?.meldSize} landMeldAgain={land?.again} holdMeldsFrom={fx?.meld && fx.seat === rightSeat.seat && preMeldRef.current?.seat === rightSeat.seat ? preMeldRef.current.melds : undefined} holdCount={fx?.meld && fx.seat === rightSeat.seat && preMeldRef.current?.seat === rightSeat.seat ? preMeldRef.current.count : undefined} label="下家" side="right" ringFrac={ringFrac} g={gs} rel={1} isTurn={actingSeat === rightSeat.seat} dealer={g?.dealer === rightSeat.seat} onAvatar={id => setProfile(id)} onKick={s => setKick(s)} onInvite={canInvite ? (st => socket.send({ type: 'room.bots', add: true, seat: st })) : undefined} bubbles={bubbles} huMark={gs?.ended && lastHu && lastHu.card >= 0 && lastHu.seat === rightSeat.seat ? (lastHu.card as Kind) : null} huCid={gs?.ended && lastHu ? (lastHu as any).cid : undefined} huGroups={huGroupsOf(rightSeat.seat)} huGroupIdx={huGroupIdxOf(rightSeat.seat)} fouls={fouls} />
      </div>

      {/* 我的头像：贴左下角（方头像，昵称在头像上面，分数在下面） */}
        <div className="me-bar">
          <div data-seat={mySeat} className={`seat me-info ${actingSeat === mySeat ? 'turn' : ''}`}>
            <StatusTags p={(gs ?? g)?.players?.[mySeat]} delay={(gs ?? g)?.delayCards?.[mySeat] ?? 0}
              melds={(gs ?? g)?.players?.[mySeat]?.melds as Meld[]} fouls={fouls[mySeat] ?? 0} />
            <span className="ava-wrap">
              <Avatar user={mySeatInfo.user} size={36} square wide onClick={() => { socket.send({ type: 'seat.wake' } as any); setProfile(me.id); }} />
              {(mySeatInfo as any).auto && <span className="ava-tag tag-bl badge bot-tag" title="超时了，机器人正替你打；你点一下就接手"><IconBot /></span>}
              {actingSeat === mySeat && ringDeadline > 0 && !pending && <TurnRing frac={ringFrac} size={36} square wide />}
              {g?.dealer === mySeat && <span className="ava-tag tag-tr badge dealer">庄</span>}
            </span>

          </div>
          {bubbles.filter(b => b.seat === mySeat).map(b => <div key={b.id} className="bubble me-bubble"
            style={{ ['--bub-d' as any]: `${(b as any).ms ?? 1150}ms` }}>{b.text}</div>)}
        </div>

      {/* 底区：我 —— 下地牌在扇形左上，打出的牌在扇形右上，行动按钮在右下；双击空白处自动理牌 */}
      <div className="table-bottom" ref={tbRef} onDoubleClick={e => {
        if ((e.target as HTMLElement).closest('.hand-col, button, .meld, .discard-pile, .seat')) return;
        // 自己码好的三张一组先不动，只理其余的牌
        const keepCols = autoColsKeep(myHand, cols);
        socket.send({ type: 'seat.wake' } as any);
        manualRef.current = keepCols.some(c => c.length === 3);
        setCols(keepCols); setSelected(null); toast('已自动理牌');
      }}>
        {/* 我的下地牌：扇形左上角；亮牌时胡的那一句也摆到这儿 */}
        {!waiting && (holdMelds(mySeat, (gs?.players?.[mySeat]?.melds ?? []) as Meld[]).length > 0 || myHuCol) &&
          <div className="my-melds" style={{
            /* 上沿别越过手牌的顶 —— 再往上就压到「吃 / 碰 / 胡」那几个按钮了。
               下地牌是从下往上码的（wrap-reverse），所以限高就等于限住上沿。 */
            maxHeight: Math.max(40, Math.round(FAN_H * HAND_ZOOM) - 10),
            // 贴着左边沿（跟上家的弃牌区一条线），底边离自己头像那一条 5px
            left: 0, right: 'auto',
            ...(anchors.meldsBottom != null ? { bottom: anchors.meldsBottom } : null),
          }}>
            {holdMelds(mySeat, (gs?.players?.[mySeat]?.melds ?? []) as Meld[]).map((m, i) =>
              <MeldBox key={(m as any).cids?.join('-') ?? i} m={m} size="sm" bare />)}
            {/* 正往我这边下地区飞的那一组：先占位（三张宽），落点量得到，不会糊到旁边那组上。
                重提 / 重跑不摆这个占位 —— 那张牌是加到原来那一组上的，那一组自己就在，
                再摆一个"新一组"只会把落点顶到外面一格去。 */}
            {land?.meld && !land.again && land.seat === mySeat && <div className="meld meld-bare meld-ghost" aria-hidden>
              <CardStack cards={new Array(Math.max(1, land.meldSize ?? 3)).fill(land.card)} size="sm" className="stack-sm" heads /></div>}
            {myHuCol && <div className="meld meld-bare hu-meld" title="胡的那一句">
              <CardStack cards={myHuCol} size="sm" className="stack-sm" heads mark={(lastHu?.card ?? -1) as Kind} /></div>}
          </div>}

        {/* 我打出无人要的牌：扇形右上角。
            这一条**一直在**（哪怕一张牌都还没打），不然本局第一张牌飞的时候找不到落点，
            只能退回手牌区 —— 看着就是"牌飞到自己面前就停下了"。 */}
        {/* 位置全部交给 CSS 钉死（见 styles.css 里"三家弃牌区"那一段）：
            三堆都以**屏幕中线**为基准 —— 上家在线上方靠左、下家在线上方靠右、我在线下方靠右。
            不再量任何东西，所以飞牌的落点是个定数，不会因为机型、缩放、地址栏伸缩而飘。 */}
        {!waiting &&
          <div className="discard-band">
            {/* 一张都还没打的时候不画那个红框，只留这条壳当落点 */}
            {gs?.players?.[mySeat] && (holdBack(mySeat, (gs.players[mySeat].discards ?? []) as Kind[]).length > 0 || ghostOf(mySeat) !== undefined) &&
              <DiscardPile ghostLanded={!!land?.done} cards={holdBack(mySeat, gs.players[mySeat].discards as Kind[], (gs.players[mySeat] as any).discardCids)} src={(gs.players[mySeat] as any).discardSrc} size="xs" mine className="my-discards"
                           ghost={ghostOf(mySeat)} />}
          </div>}

        {/* 出牌按钮：跟手牌上沿齐平，比行动按钮宽一倍 */}
        {!waiting && myTurnToDiscard && (
          <div className="discard-slot">
            {selectedCard !== null
              ? <button className="discard-big" onPointerDown={e => { e.preventDefault(); discardSelected(); }}>
                  打出
                  {/* 牌名画成一个"牌头"：一眼看清自己选的是哪一张 */}
                  <Card kind={selectedCard} size="sm" head className="btn-card" />
                </button>
              : <span className="muted" style={{ fontSize: 12 }}>请点选一张牌</span>}
          </div>
        )}

        {/* 行动按钮：右下角。提 / 偎 / 跑 由系统自动执行，不再需要按钮 */}
        {/* 点了「过」＝当场放弃这张牌的行动权：按钮立刻消失，这张牌还在桌上就不再给我按钮 */}
        {!waiting && (actBtnsLive.length > 0 || waitHold) && !iPassedThis && <div className={`actions ${mustHuNow ? 'at-discard' : ''}`}>
          {(() => {
            const show = new Set<string>();
            /* 我已经表过态、还在等别家（比如我点了吃，前面还有人能碰没吭声）：
               服务端这时候就不再给我选项了（myOptions 是空的），按钮要是跟着一起撤掉，
               看着就是"点了吃一点反应都没有"。留下点的那一个，绿框闪着等结果。 */
            if (!actBtnsLive.length && waitHold) show.add(myDecided as string);
            else {
              // 点完之后只留下点的那一个（灰掉等服务端揭晓），别的收走 ——
              // 以前是全留着灰掉，"胡"的倒计时圈还在那儿转，看着像还能点、也像没点上
              // 吃法还在弹窗里挑（chiPick）也算"已经选了吃"，别把胡 / 碰 留在后面继续倒计时
              const chosen = pending ?? (chiPick ? 'chi' : (myDecided === 'pass' ? 'pass' : myDecided ?? null));
              const all = mustHuNow ? ['hu'] : actBtnsLive;
              if (!chosen || !all.includes(chosen)) for (const t of all) show.add(t);
              /* 点了「胡」就整排收掉：牌局马上就结算了，留一个按钮在那儿只会闪一下。 */
              else if (chosen !== 'hu') show.add(chosen);
            }
            /* 骨架按"这张牌一开始给了我哪几个按钮"来定，钉在这张牌上（换了牌就重记）。
               服务端一表态就不再给选项了，所以只记**见过的最全的那一次**。
               用不上的那几格不显形（visibility: hidden），位子照占 ——
               「过」一收，碰 / 吃 / 胡一动都不动。 */
            if (skelRef.current.key !== tableCardNow) skelRef.current = { key: tableCardNow, list: [] };
            if (actBtns1.length > skelRef.current.list.length) skelRef.current.list = actBtns1;
            const skel = mustHuNow ? ['hu'] : (skelRef.current.list.length ? skelRef.current.list : [...show]);
            return skel.map(t => ({ t, ghost: !show.has(t) }));
          })().map(({ t, ghost }) => {
            const waitingAct = pending ?? (myDecided === 'pass' ? 'pass' : myDecided ?? null);
            const locked = !!waitingAct;
            // 碰 / 跑 / 胡 只给读秒的一半：按钮外圈走一圈倒计时，走完服务端就把这个按钮收掉了。
            // 已经点过动作了就别再转圈（这一手已经定了，转圈只会让人以为还能改）
            const fast = t !== 'chi' && t !== 'pass' && fastFrac !== null && !locked && !chiPick;
            // 胡有自己的窗口时（衡阳有胡必胡的 5 秒），胡那个按钮按它画
            const huRing = t === 'hu' && huFrac !== null && !locked && !chiPick;
            /* 吃：给的是**整轮读秒**，也该有圈 —— 用这一手的总期限来画（跟胡 / 碰那半程的圈同一个样子） */
            const slow = t === 'chi' && claimFrac !== null && !locked && !chiPick;
            const frac = huRing ? huFrac! : fast ? fastFrac! : slow ? claimFrac! : null;
            /* 最后一秒**回到原色并闪烁**。
               光靠"越来越淡"提示时间不够：淡到后来玩家会以为按钮已经没了、干脆不看了，
               结果白白错过。所以临门这一秒反过来 —— 颜色一下子回满、再一明一暗地跳，
               是全程最扎眼的一下。 */
            const until = huRing ? huUntil : fast ? fastUntil : slow ? claimDl : 0;
            const lastCall = until > 0 && until - now <= 1000;
            /* 倒计时改成**围着那个字转的一个圆圈**：以前是贴着按钮圆角的一圈 conic-gradient，
               碰 / 胡 按钮上还叠着"呼吸"的光晕，两下一凑就看不清还剩多少了。
               现在圈画在字上面（SVG，描边走一圈），呼吸让给圈 —— 有圈的时候不呼吸。 */
            return <ActBtn key={t} t={t} ghost={ghost} frac={ghost ? null : frac} lastCall={!ghost && lastCall} locked={locked} waitingAct={waitingAct}
              label={t === 'pass' && !optTypes.has('pass') && optTypes.has('play_drawn') ? '打出' : ACTION_NAME[t]}
              pulse={t === 'hu' && selfHu && !locked && frac === null}
              onPress={() => pressButton(t, locked ? (waitingAct ?? '') : null)} />;
          })}
        </div>}

        <div className={`hand fan ${fanMode && !revealing ? '' : 'flat'} ${drag ? 'dragging' : ''}`} ref={handRef}
          /* --card-lift：选中的牌抬多高 —— 半个头（同列里一张牌露出来的那一截的一半） */
          style={{ height: FAN_H, ['--fan-trim' as any]: `${TRIM}px`, ['--card-lift' as any]: `${Math.round(STEP / 2)}px`,
                   ['--hand-zoom' as any]: HAND_ZOOM }}>
          {/* 出牌线的两个准星（看不见，也不占地方）。
              以前是拿 `.hand` 的 getBoundingClientRect 去反推扇柄在哪 ——
              可这一层套着 CSS zoom，各家浏览器对"量一个被 zoom 过的盒子"的处理并不一致
              （Mac 上量出来的宽是没放大的那个），于是"盒子中点"根本不是扇柄，
              圆心就被拉到一边去了；偏偏诊断里的"偏"也是拿同一个盒子算的，自己跟自己比，
              当然永远是 0 —— 这个洞就是这么一直没露出来的。
              现在改成埋两个实实在在的点：扇柄一个、扇尖一个，直接量它俩。
              它们跟牌在同一层、同一个 zoom 底下，浏览器怎么放大都一视同仁，
              圆心 = 扇柄，半径 = 两点之间的距离 —— 不再出现任何"按倍数折算"。 */}
          {fanMode && !revealing && <>
            <i ref={pvBaseRef} aria-hidden style={{ position: 'absolute', left: '50%', bottom: FAN_LIFT - TRIM - 2, width: 0, height: 0 }} />
            <i ref={pvTipRef} aria-hidden style={{ position: 'absolute', left: '50%', bottom: FAN_LIFT - TRIM + colH(maxColLen), width: 0, height: 0 }} />
          </>}
          {/* 出牌线就画在这儿 —— 手牌自己这一层里面。
              它跟牌共用同一个 `left: 50%`（扇形的对称轴）、同一个 CSS zoom，
              所以牌怎么放大、屏幕怎么转、浏览器怎么处理 zoom，线都自动跟着走，
              **一个坐标都不用我算**。以前是画在外面、再拿"屏幕坐标→桌面坐标"的矩阵去摆位置：
              只要那套换算跟浏览器实际的排版差一点（大字版套了 zoom，各家处理还不一样），
              圆心就跟扇柄分了家 —— 小字版 zoom=1 正好看不出来，一切大字版就露馅。 */}
          {drag && (fanMode && !revealing
            ? <div className="arc-anchor" style={{ bottom: FAN_LIFT - TRIM - 2 }}>
                <svg className={`discard-arc ${drag.zone ? 'on' : ''}`} width={ARC_R * 2} height={ARC_R * 2}
                  style={{ left: -ARC_R, top: -ARC_R }}>
                  <circle cx={ARC_R} cy={ARC_R} r={ARC_R - 2} />
                </svg>
                <div className={`arc-tip ${drag.zone ? 'on' : ''}`} style={{ top: -ARC_R - 16 }}>{drag.zone ? '松手出牌' : '拖出弧线出牌'}</div>
              </div>
            : <div className="arc-anchor" style={{ bottom: LINE_UP }}>
                <svg className={`discard-arc ${drag.zone ? 'on' : ''}`} width={4000} height={4} style={{ left: -2000, top: -2 }}>
                  <line x1={0} y1={2} x2={4000} y2={2} />
                </svg>
                <div className={`arc-tip ${drag.zone ? 'on' : ''}`} style={{ top: -18 }}>{drag.zone ? '松手出牌' : '拖过线出牌'}</div>
              </div>)}
          {colsShown.map((col, i) => {
            const h = colH(col.length);
            // 扇形：所有列最下一张的右下角叠在同一个支点上，绕支点旋转展开；平排：一列一列挨着放，底边齐平
            const angle = fanMode && !revealing && colsShown.length > 1 ? -FAN_SPREAD / 2 + (FAN_SPREAD / (colsShown.length - 1)) * i : 0;
            const fanStyle: React.CSSProperties = fanMode && !revealing
              ? { position: 'absolute', left: '50%', bottom: FAN_LIFT - TRIM, height: h, transformOrigin: '50% calc(100% + 2px)', transform: `translateX(-50%) rotate(${angle}deg)`, zIndex: 100 - i }
              : { width: CARD_W, height: colBox(col.length) };
            return (
              <div key={i} data-col={i} className={`hand-col ${colKind(col)} ${drag && drag.overCol === i ? 'drop-target' : ''}`}
                onClick={() => { if (selected && selected.col !== i) moveCard(selected, i); }}
                style={fanStyle}>
                <div className="stack" style={{ height: h, ['--slot-up' as any]: `${Math.max(0, AIM_LEN - col.length) * STEP}px` }}>
                  {/* 不足三张的那一列，上面补几个虚位 —— 只在理牌（拖动）的时候显形。
                      两个作用：眼睛看着每一列都是三张那么高，好瞄准；
                      判定落到哪一列时也拿最上面那个虚位当准星，跟别的列站在同一排比。
                      （扇形是绕底边支点转开的：列越矮，它最上面那张牌的位置就越靠下、横向偏得越少 ——
                      拿实际那张牌去比，单张的那一列总是挤在中间，怎么拖都落不进去。）
                      虚位一直在 DOM 里（只是透明），不然按下去那一刻量不到它。 */}
                  {Array.from({ length: Math.max(0, AIM_LEN - col.length) }, (_, k) =>
                    <div key={`slot${k}`} className="col-slot" aria-hidden
                      style={{ top: -(Math.max(0, AIM_LEN - col.length) - k) * STEP, height: CARD_TAIL }} />)}
                  {/* **准星**：每一列都有、永远不显形，判定"拖到哪一列"只量它。
                      位置和大小对所有列完全一致（都在"第三张牌"那一行、都是 CARD_TAIL 高），
                      所以各列的准星严丝合缝地排在同一条弧线上。
                      以前是"有虚位就量虚位、没有就量第一张牌" —— 虚位高 78、整张牌高 169，
                      两者的**中心**差了 45px（再乘手牌那道 zoom 约 55px），而列间距才 48~60px：
                      短的那几列准星被整整拉进来一格，拖过去就落到隔壁，短列一多还会连着错好几格。 */}
                  <div className="col-aim" aria-hidden
                    /* 注意这儿**不能**夹成非负：满四张的那一列（龙）比别人高出一格，
                       夹了的话准星就贴在它自己的顶上、比别的列高一整格（实测 289 对 236），
                       拖到扇形两头正好差出一个列距。
                       len < 3 往上补、len > 3 往下让，准星才真的都在"第三张牌"那一行。 */
                    style={{ top: (col.length - AIM_LEN) * STEP, height: CARD_TAIL }} />
                  {col.map((k, idx) => <Card key={idx} kind={k} size="xl"
                    /* 正被拖着的那一张：原位留一张变暗的，并且跟"选中"一样呼吸 —— 手指上那张不变 */
                    className={`card-fan ${i === myMarkCol && idx === col.indexOf(lastHu!.card as Kind) ? 'card-mark' : ''}`
                      + (drag !== null && dragRef.current?.col === i && dragRef.current?.idx === idx ? ' card-dragsrc' : '')}
                    selected={selected?.col === i && selected.idx === idx}
                    hint={hints.has(`${i}-${idx}`)}
                    dim={drag !== null && dragRef.current?.col === i && dragRef.current?.idx === idx}
                    style={{
                      position: 'absolute', top: idx * STEP, left: 0, zIndex: idx,
                      // 每一张都剪成同样高（只留到小红印下面）：上面那些牌的下半截不会从别的牌底下露出来
                      clipPath: `inset(0 0 ${TRIM}px 0 round 5px)`,
                    }}
                    onPointerDown={e => onCardPointerDown(e, i, idx)} />)}
                </div>
              </div>
            );
          })}
          {ghostCol && (() => {
            const i = colsShown.length;
            /* 扇形的中轴线、张角**一概按真列算**（见上面那行 angle）——
               虚拟组只是照同样的列距往外再接一格。以前是把它算进总列数一起摊，
               它一出现整手牌就重新铺开、跟着歪一下，很难受。 */
            const pitch = colsShown.length > 1 ? FAN_SPREAD / (colsShown.length - 1) : 15;
            const angle = fanMode && !revealing ? (colsShown.length > 1 ? -FAN_SPREAD / 2 + pitch * i : pitch) : 0;
            /* 高度按**三张牌**算：摆满三张的那种列有多高，这个空组就有多高。
               以前只画最底下一个「＋」—— 一个巴掌大的小方块杵在一排牌旁边，
               既不好找，拖过去也容易擦边落回隔壁组。现在三张牌的位置上各摆一个「＋」，
               整整一列的靶子，一眼看得见、随便哪一格松手都算。
               三个虚位都摆在 0 / STEP / 2·STEP（stack 自己就有三张高），
               所以不会像早先那样飘到牌顶上面去。 */
            const h = colH(AIM_LEN);
            const st: React.CSSProperties = fanMode && !revealing
              ? { position: 'absolute', left: '50%', bottom: FAN_LIFT - TRIM, height: h, transformOrigin: '50% calc(100% + 2px)', transform: `translateX(-50%) rotate(${angle}deg)`, zIndex: 100 - i }
              : { width: CARD_W, height: colBox(AIM_LEN) };
            return (
              <div key="ghost" data-col={i} className={`hand-col ghost-col ${drag && drag.overCol === i ? 'drop-target' : ''}`}
                onClick={() => { if (selected) moveCard(selected, null); }} style={{ ...st, ['--slot-up' as any]: '0px' }}>
                <div className="stack" style={{ height: h, ['--slot-up' as any]: '0px' }}>
                  {/* 平时只露三个「＋」；牌拖到这儿才把虚线框亮出来（跟拖到别的牌组上高亮是一回事） */}
                  {Array.from({ length: AIM_LEN }, (_, k) =>
                    <div key={`gs${k}`} className="col-slot" aria-hidden style={{ top: k * STEP, height: CARD_TAIL }} />)}
                  {/* 准星：位置、大小跟别的列一致（都在"第三张牌"那一行），拖动判定才排得在同一条弧上 */}
                  <div className="col-aim" aria-hidden style={{ top: 0, height: CARD_TAIL }} />
                  {Array.from({ length: AIM_LEN }, (_, k) =>
                    <span key={`gp${k}`} className="ghost-plus" style={{ top: k * STEP + Math.round(CARD_TAIL / 2) - 12 }}>＋</span>)}
                </div>
              </div>
            );
          })()}
          {!myHand.length && !waiting && <div className="muted">（无手牌）</div>}
        </div>
        {drag && <div className="new-col-zone"><span>新<br />一<br />列</span></div>}
        {/* 位置不写在 style 里（那样每次重画都会把手写进去的值盖掉），
            改成挂载 / 重画之后由 ref 回调按最近一次手指位置补上。 */}
        {drag && <div className="drag-ghost" ref={el => {
          dragGhostRef.current = el;
          const pt = lastMoveRef.current;
          if (el && pt) { el.style.left = `${pt.x}px`; el.style.top = `${pt.y}px`; }
        }}><Card kind={drag.card} size="xl" highlight /></div>}

      </div>

      {/* 飞过去的那一张：**必须挂在牌桌这一层**，不能塞在中间那块里。
          中间那块（.center-area）自己带 z-index:7，是一个独立的层叠上下文 ——
          塞在里面的话，不管这张牌的 z-index 写多大，整块也只是"第 7 层"，
          而我的弃牌区是第 8 层，于是牌一落地就被已经在那儿的牌压住了。
          上下家没这个毛病，因为他们那两摞在座位里，层数比中间这块低。 */}
      {land && <LandCard land={land} />}

      {chiPick && chiStep === null && (
        <Modal onClose={() => setChiPick(null)} top className="chi-modal">
          <div className="col" style={{ gap: 6 }}><b>第一步：怎么吃</b>
            <div className="row" style={{ flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
              {chiPick.combos!.map((cb, i) => {
                const lays = chiPick.comboLays?.[i] ?? [];
                // 下伙只有一种凑法就不用再问第二遍了，直接跟着一起下地
                const needLay = lays.length > 1;
                const autoLay = lays.length === 1 && (lays[0]?.length ?? 0) > 0;
                return (
                  <div key={i} className="chi-opt" onClick={() => {
                    if (needLay) setChiStep(i);                       // 有好几种下伙凑法 → 第二步
                    else { act('chi', { combo: cb, lay: 0 }); setChiPick(null); if (autoLay) toast('手里其余同字已一并下伙'); }
                  }}>
                    {/* 吃进来的是哪一张：右上角一个绿圈「吃」（跟亮牌时的「胡」一个样式） */}
                    <CardStack cards={sortCol([chiPick.card, cb[0], cb[1]])} size="sm" className="stack-sm" heads
                               mark={chiPick.card} markKind="chi" />
                    <span className="muted" style={{ fontSize: 13 }}>{needLay ? '还要下伙 ›' : autoLay ? '带下伙' : '选这组'}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </Modal>
      )}
      {chiPick && chiStep !== null && (
        <Modal onClose={() => setChiStep(null)} top className="chi-modal">
          <div className="col" style={{ gap: 6 }}><b>第二步：下伙</b>
            <div className="muted" style={{ fontSize: 12 }}>手里其余同字要跟着一起下地，选一种凑法</div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
              {(chiPick.comboLays?.[chiStep] ?? []).map((groups, li) => (
                <div key={li} className="chi-opt" onClick={() => { act('chi', { combo: chiPick.combos![chiStep], lay: li }); setChiStep(null); setChiPick(null); }}>
                  <div className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
                    {groups.map((gp, j) => <CardStack key={j} cards={sortCol(gp)} size="sm" className="stack-sm" heads
                                                       mark={gp.includes(chiPick.card) ? chiPick.card : null} markKind="chi" />)}
                  </div>
                  <span className="muted" style={{ fontSize: 13 }}>选这种</span>
                </div>
              ))}
            </div>
            <button className="ghost" onClick={() => setChiStep(null)}>返回</button>
          </div>
        </Modal>
      )}
      {settle && (
        <Modal onClose={() => setSettle(null)}>
          {settle === 'liuju' ? <div className="col">
            <div style={{ fontSize: 20, fontWeight: 900, color: 'var(--gold)' }}>
              <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>第 {room.roundNo} 局 · </span>黄庄（流局）
            </div>
            <div className="muted">底牌摸完无人胡牌，本局不算胡牌分</div>
            {(() => {
              // 跟胡牌结算一个样：本局各家的输赢摆出来（黄庄照样有提龙即时分 / 违规罚分）
              const lg = room.ledger[room.ledger.length - 1];
              const names = lg?.seatNames ?? room.seats.map(s => s.user?.nickname ?? '');
              const ti = lg?.tilong ?? [], pe = lg?.penalty ?? [];
              const both = ti.some(v => v) && pe.some(v => v);
              return <table className="ledger"><tbody>
                {both && <tr><td /><td>提龙</td><td>罚分</td><td>合计</td></tr>}
                {names.map((nm, i) => {
                  const sum = (ti[i] ?? 0) + (pe[i] ?? 0);
                  return <tr key={i}>
                    <td>{nm}{!both && (ti[i] ? <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>提龙</span> : pe[i] ? <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>罚分</span> : null)}</td>
                    {both && <td className={(ti[i] ?? 0) > 0 ? 'pos' : (ti[i] ?? 0) < 0 ? 'neg' : ''}>{fmt(ti[i] ?? 0)}</td>}
                    {both && <td className={(pe[i] ?? 0) > 0 ? 'pos' : (pe[i] ?? 0) < 0 ? 'neg' : ''}>{fmt(pe[i] ?? 0)}</td>}
                    <td className={sum > 0 ? 'pos' : sum < 0 ? 'neg' : ''}>{fmt(sum)}</td>
                  </tr>;
                })}
              </tbody></table>;
            })()}
            {(() => { const lg = room.ledger[room.ledger.length - 1];
              return lg?.reveal ? <RevealPanel rv={lg.reveal} names={lg.seatNames ?? room.seats.map(s => s.user?.nickname ?? '')} hu={lg.hu} /> : null; })()}
            <button onClick={() => setSettle(null)}>确定</button>
          </div> : (
            <div className="col">
              {/* 名字先看**这一局记下的**，再看座位上现在是谁 ——
                  机器人打完就离桌（真人退出也一样），座位当场就空了，
                  照座位取名字，结算详情里那一行就成了"空位 +32 分"。 */}
              <HuPanel hu={settle} names={room.seats.map((s, i) =>
                room.ledger[room.ledger.length - 1]?.seatNames?.[i] ?? s.user?.nickname ?? '空位')} />
              <button onClick={() => setSettle(null)}>确定</button>
            </div>
          )}
        </Modal>
      )}
      {/* 开局横幅、下一局倒计时：整屏居中；局数摆左下角 */}
      {banner && (
        // key 带 seq：换节点才会重播动画（同一元素改 class 是不重播的）
        <div className={`phase-banner ${banner.kind}`} key={`pb${banner.seq}`}>
          <div className="pb-main">{banner.main}</div>
          {banner.sub && <div className="pb-sub">{banner.sub}</div>}
        </div>
      )}
      {/* 暂停：横幅播完之后留一条同样语言的静态带子，停在屏幕中间不走 —— 隔着半间屋子也看得见 */}
      {room.status === 'paused' && !banner && (
        <div className="phase-banner close pb-hold">
          <div className="pb-main">暂 停</div>
          <div className="pb-sub">GAME PAUSED</div>
        </div>
      )}


      {replayId !== null && <ReplayModal roundId={replayId} onClose={() => setReplayId(null)} />}
      {shot && <ShotModal data={shot} onClose={() => setShot(null)} />}
      {/* 牌面字体：点开一张单子照着样子挑，不用一遍遍切 */}
      {soundPick && <Modal className="font-modal" onClose={() => setSoundPick(false)}>
        <div className="col" style={{ gap: 8, minWidth: 260 }}>
          <b>报牌声</b>
          <div className="muted" style={{ fontSize: 12 }}>
            报牌声是**服务端**的录音（后台传的自录音 / 合成好的音包），不是手机自己念的。
            「默认」＝这个玩法在后台配好的那一套；换成别的就是整桌都按你挑的这套念。
            没录到的那几句才退回手机自带的朗读（手机也念不出来就给个提示音）。
          </div>
          <div className="col font-list">
            {[{ id: '', name: '默认（推荐）', count: -1 }, ...packs, { id: 'off', name: '不用录音，只让手机自己念', count: -1 }].map(pk => (
              <button key={pk.id} className={`font-row ${pk.id === packId ? 'on' : ''}`}
                /* 换套报牌声也顺手重建一次音频 —— 来这儿的人往往也是"怎么没声音了"，
                   而且旧 context 上解码好的片段本来就要作废重下 */
                onClick={() => { resetAudio(); setVoicePack(pk.id); setPackId(pk.id); loadVoicePack(room.variant); setSoundPick(false); toast(`报牌声：${pk.name}`); }}>
                <span className="font-name">{pk.name}</span>
                {pk.count > 0 && <span className="font-used">{pk.count} 条</span>}
                {pk.id === packId && <span className="font-tick">✓</span>}
              </button>
            ))}
          </div>
          <button className="ghost" onClick={() => setSoundPick(false)}>关闭</button>
        </div>
      </Modal>}
      {fontPick && <Modal className="font-modal" onClose={() => setFontPick(false)}>
        <div className="col" style={{ gap: 8, minWidth: 260 }}>
          <b>牌面字体</b>
          <div className="muted" style={{ fontSize: 12 }}>
            照着样子挑（{fontOptions().length} 款）—— 用过的排在最上面；这台手机没装的那款，样张会跟"系统"长得一样
          </div>
          <div className="col font-list">
            {/* 挑过的排前面：当前这款第一个，然后是最近用过的，剩下的按原顺序 */}
            {fontOptionsSorted().map(f => (
              <button key={f.id} className={`font-row ${f.id === cardFontId ? 'on' : ''}`}
                onClick={() => { setCardFontNow(f.id); setCardFontId(f.id); setFontPick(false); toast(`牌面字体：${f.name}`); }}>
                <span className="font-sample" style={{ ['--sample-font' as any]: f.stack, fontFamily: f.stack, fontWeight: f.weight ?? 700 }}>
                  {/* 雁字体是描出来的矢量字，样张也得画 SVG，不然这一行显示的还是系统字 */}
                  {f.id === 'shot'
                    ? [10, 16, 19].map(k => (
                        <svg key={k} viewBox="0 0 100 100" style={{ width: '1em', height: '1em' }}>
                          <path d={GLYPHS[k]} fill="currentColor" fillRule="evenodd" />
                        </svg>))
                    : '壹柒拾'}
                </span>
                <span className="font-name">{f.name}</span>
                {f.id !== cardFontId && usedFont(f.id) && <span className="font-used">用过</span>}
                {f.id === cardFontId && <span className="font-tick">✓</span>}
              </button>
            ))}
          </div>
          {/* 整个界面（标题、按钮、昵称…）要不要也跟着换 */}
          <button className={`font-row font-ui ${uiFontOn() ? 'on' : ''}`}
            onClick={() => { setUiFont(!uiFontOn()); force(x => x + 1); }}>
            <span className="sw"><i className="sw-knob">字</i></span>
            <span className="font-name">整个界面也用这款<i>标题、按钮、昵称都跟着变；小字会保留系统字体</i></span>
            <span className="font-tick">{uiFontOn() ? '开' : '关'}</span>
          </button>
          <button className="ghost" onClick={() => setFontPick(false)}>关闭</button>
        </div>
      </Modal>}
      {showRules && <RulesModal variant={room.variant} onClose={() => setShowRules(false)} />}
      {showLedger && <Modal onClose={() => setShowLedger(false)}><div className="col"><b>纪录表</b>
        <div className="muted" style={{ fontSize: 12 }}>点某一局可以看那局的胡牌详情 / 亮牌（黄庄也有）{room.status !== 'playing' ? '；牌局没在进行时还能回放' : ''}</div>
        {/* 换过人的房间：纪录表**竖着往下长** —— 最上面是当下这三位（表头 + 合计 + 这一段的每一局），
            往下一段一段是之前那几批，各带各的表头和小计；离桌的人单独一行，
            回来了就把他那笔提出来接着算。合计按服务端那本总账走，位子上没换人的从头连着。 */}
        <LedgerTable ledger={room.ledger} users={users}
          cols={room.seats.map(st => st.user?.id).filter((x): x is number => x !== undefined && x !== null)}
          totals={Object.fromEntries(room.seats.filter(st => st.user).map(st => [st.user!.id, st.total]))}
          batches={room.batches} gone={room.gone} batchFrom={room.batchFrom ?? 0}
          onPick={e => (e.hu || e.reveal) && setHuBack(e)}
          onReplay={room.status !== 'playing' ? (e => { const id = roundIds[e.round]; id ? setReplayId(id) : toast('这一局还没入库，稍后再看'); }) : undefined} />
        {room.isPrivate && isHost && room.status !== 'playing' && <button className="danger" onClick={() => { if (confirm('结束房间并结算？')) socket.send({ type: 'room.end' }); }}>结束房间并结算</button>}
        <button className="ghost" onClick={() => setShowLedger(false)}>关闭</button></div></Modal>}
      {closed && <Modal><div className="col"><b>房间已结束 · 总输赢</b>
        <table className="ledger"><tbody>{closed.totals.sort((a, b) => b.total - a.total).map(t => <tr key={t.user.id}><td>{t.user.nickname}</td><td className={t.total > 0 ? 'pos' : t.total < 0 ? 'neg' : ''}>{fmt(t.total)}</td></tr>)}</tbody></table>
        <LedgerTable ledger={closed.ledger} users={users} onPick={e => (e.hu || e.reveal) && setHuBack(e)} />
        <button onClick={() => { setClosed(null); onLeft(); }}>返回大厅</button></div></Modal>}
      {huBack && <Modal onClose={() => setHuBack(null)}><div className="col">
        {huBack.hu
          ? <HuPanel hu={huBack.hu} names={huBack.seatNames ?? room.seats.map(s => s.user?.nickname ?? '')} round={huBack.round} />
          : <div style={{ fontSize: 20, fontWeight: 900, color: 'var(--gold)' }}>
              <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>第 {huBack.round} 局 · </span>黄庄（流局）
            </div>}
        {huBack.reveal && <RevealPanel rv={huBack.reveal} names={huBack.seatNames ?? room.seats.map(s => s.user?.nickname ?? '')} hu={huBack.hu} huCard={huBack.hu ? (huBack.hu.card >= 0 ? huBack.hu.card : (huBack.hu.detail as any)?.huKind ?? null) : null} />}
        {/* 耒阳可以弃胡：谁弃了哪张、当时值多少分，跟实际胡了多少分摆一块看 */}
        {!!huBack.declines?.length && (() => {
          const names = huBack.seatNames ?? room.seats.map(s => s.user?.nickname ?? '');
          const real = huBack.hu?.detail?.unit ?? 0;
          return <div className="decline-list">
            {huBack.declines.map((d, i) => (
              <div key={i} className="decline-row">
                <b>{names[d.seat] ?? `座位${d.seat}`}</b> 弃胡 <b>{nameOf(d.card as Kind)}</b>
                <span className="muted">（每家 {d.unit} 分）</span>
                {huBack.hu && huBack.hu.seat === d.seat
                  ? <span className="muted"> → 实际胡 {real} 分</span>
                  : <span className="muted"> → 本局没胡</span>}
              </div>
            ))}
          </div>;
        })()}
        <button onClick={() => setHuBack(null)}>关闭</button></div></Modal>}
      {profile !== null && <ProfileModal userId={profile} onClose={() => setProfile(null)} />}
      {kick !== null && (
        <Modal onClose={() => setKick(null)}>
          <div className="col" style={{ minWidth: 240 }}>
            <b>请走 {room.seats[kick]?.user?.nickname ?? '机器人'}？</b>
            <div className="muted">{room.status === 'playing' || room.status === 'paused'
              ? '牌局进行中：本局作废、不计分，15 秒后重开一局。'
              : '位置空出来，牌友就能坐进来。'}</div>
            <button className="danger" onClick={() => { socket.send({ type: 'room.kick', seat: kick }); setKick(null); }}>请走</button>
            <button className="ghost" onClick={() => setKick(null)}>再想想</button>
          </div>
        </Modal>
      )}
    </div>
  );
}


/** 头像旁边的状态标识：罚（红，按次数）· 放跑 · 贪（弃胡）· 延时（绿，按张数）· 提龙的那张牌 */
function StatusTags({ p, delay, melds, fouls = 0 }: { p: any; delay: number; melds?: Meld[]; fouls?: number }) {
  const items: React.ReactNode[] = [];
  // 一个就只写字，两个及以上在右上角带个小数字（贴一排同样的字太占地方）
  const tag = (key: string, cls: string, text: string, n: number) => {
    if (n <= 0) return;
    items.push(<b key={key} className={`st ${cls} ${n > 1 ? 'has-n' : ''}`}>{text}{n > 1 && <i className="st-n">{n}</i>}</b>);
  };
  tag('f', 'st-foul', '罚', Math.max(p?.violations ?? 0, fouls));
  if (p?.noTake) items.push(<b key="nt" className="st st-notake">放跑</b>);
  tag('d', 'st-greedy', '贪', p?.declined ?? 0);
  tag('t', 'st-delay', '延', delay);
  for (const m of (melds ?? []).filter(m => m.type === 'ti' || m.type === 'long'))
    items.push(<b key={'l' + m.cards[0]} className="st st-long">{nameOf(m.cards[0] as Kind)}</b>);
  if (!items.length) return null;
  return <div className="st-row">{items.map((it, i) => <React.Fragment key={i}>{i > 0 && <i className="st-dot">·</i>}{it}</React.Fragment>)}</div>;
}

function SeatBox({ seat, mySeat, rel, label, g, isTurn, dealer, onAvatar, onKick, onInvite, bubbles, horizontal, ringFrac, side, huTag, holdCard, holdCid, landCard, landDone, landMeldCard, landMeldSize, landMeldAgain, holdMeldCard, holdMeldsFrom, holdCount, huMark, huCid, huGroups, huGroupIdx, fouls }: { seat: RoomView['seats'][number]; mySeat?: number; landCard?: Kind | null; landDone?: boolean; landMeldCard?: Kind | null; landMeldSize?: number; landMeldAgain?: boolean; huGroupIdx?: number; label: string; g: any; fouls?: number[]; rel: number; isTurn: boolean; dealer: boolean; onAvatar: (id: number) => void; onKick?: (seat: number) => void; onInvite?: (seat: number) => void; huMark?: Kind | null; huCid?: number; huGroups?: Kind[][] | null; bubbles: { id: number; seat: number; text: string; ms?: number }[]; horizontal?: boolean; ringFrac?: number; side?: 'left' | 'right'; huTag?: string; holdCard?: Kind | null; holdCid?: number; holdMeldCard?: Kind | null; holdMeldsFrom?: number; holdCount?: number }) {
  const p = g?.players?.[seat.seat];
  // 明牌还在飞：那张牌先别出现在他的弃牌堆 / 下地区里，飞到了才落下
  const holdCards = (cs: Kind[], cids?: number[]) => {
    if (holdCid && cids?.length) { const i = cids.lastIndexOf(holdCid); return i >= 0 ? cs.filter((_, j) => j !== i) : cs; }
    return holdCard != null && cs.length && cs[cs.length - 1] === holdCard ? cs.slice(0, -1) : cs;
  };
  /* 隐形占位：只要有牌正往这一摞飞，就先把位子占上 —— 不等服务端那一帧。
     （等那一帧的话，牌往往已经落地了，占位白摆；先占上，落点从起飞那一刻就是量得到的。） */
  const ghostCard = (): Kind | undefined => (landCard != null ? landCard : undefined);
  const holdMeldsIn = (ms: Meld[]) => (holdMeldsFrom !== undefined && ms.length > holdMeldsFrom ? ms.slice(0, holdMeldsFrom) : ms);
  return (
    <div data-seat={seat.seat} className={`seat ${isTurn ? 'turn' : ''} ${horizontal ? 'seat-h' : ''} ${side === 'right' ? 'seat-r' : ''}`} style={{ position: 'relative' }}>
      {/* 一行摆开：头像（方形）+ 手里那摞牌 | 下地牌（上）+ 打出的牌（下）。上家往右排，下家往左排 */}
      <div className="seat-row">
        <div className="seat-id">
          <div className="seat-head">
            <span className="ava-wrap">
              {/* 点头像＝看资料；要请走机器人得**长按 0.6 秒**，免得打牌时误触弹出"请走…？" */}
              <Avatar user={seat.user} size={36} square wide
                onHold={seat.kickable && onKick ? () => onKick(seat.seat) : undefined}
                onClick={() => { if (seat.user) onAvatar(seat.user.id); }} />
              {isTurn && ringFrac !== undefined && ringFrac > 0 && <TurnRing frac={ringFrac} size={36} square wide />}
              {/* 庄 / 延时卡：贴在头像里面的下沿 */}
              {dealer && <span className="ava-tag tag-tr badge dealer">庄</span>}
              {/* 超时了、机器人正替他打：头像左下角挂个机器人（他自己一动手就没了） */}
              {(seat as any).auto && <span className="ava-tag tag-bl badge bot-tag" title="超时了，机器人正替他打"><IconBot /></span>}
            </span>
            {/* 手里还剩几张：数字直接写在牌背上，跟公共牌堆一个样式 */}
            {p && !p.hand && <span className="mini-back"><span className="hand-count">{holdCount ?? p.handCount}</span></span>}
          </div>
          <div className="seat-meta">
            {/* 机器人不再标「机」；只有空位和掉线要说明一下 */}
            {((!seat.online && seat.user) || !seat.user) && <div className="name">
              {/* 空位点一下就请个机器人来（大厅里打完一局有人走了，不用再去翻按钮） */}
              {!seat.user && (onInvite
                ? <button className="ghost seat-invite" onClick={() => onInvite(seat.seat)}>＋ 请机器人</button>
                : '等待加入')}
              {!seat.online && seat.user && <span className="badge">离线</span>}</div>}
            <StatusTags p={p} delay={g?.delayCards?.[seat.seat] ?? 0} melds={p?.melds as Meld[]} fouls={fouls?.[seat.seat] ?? 0} />
          </div>
        </div>
        {p && <div className={`seat-body ${side === 'right' ? 'rev' : ''}`}>
          <div className="seat-cards">
            {/* 下地牌靠着玩家那一头，一局结束亮出来的手牌接在后面往外摆（同一行） */}
            {(() => {
              // 胡牌那家：按真正的胡牌组合分组（不是随手理的），并把"含胡的那一组"也摆到下地那一头，
              // 让所有人一眼看见胡的是哪一句
              let openCols = p.hand ? (huGroups?.length ? huGroups : revealCols(p.hand as Kind[])) : [];
              let huCol: Kind[] | null = null;
              if (p.hand && huGroups?.length && huMark != null && huMark >= 0) {
                // 引擎给了组号就按组号，别再按牌面找（同一个字可能落在好几组里）
                const k = huGroupIdx !== undefined && huGroupIdx >= 0 && huGroupIdx < openCols.length
                  ? huGroupIdx : openCols.findIndex(gp => gp.includes(huMark));
                if (k >= 0) { huCol = openCols[k]; openCols = openCols.filter((_, i) => i !== k); }
              }
              const shown = holdMeldsIn(p.melds as Meld[]);
              // 「胡」字只标一个：先看在不在下地牌里，不在就标手牌里的那一组
              // 胡的那张是"进到手里凑成最后一句"的，早就下地的牌组里那张同字的不该被标 ——
              // 二七十胡小二，可不能把一二三里的小二也画个「胡」
              const inHand = huCol ? -1 : markIn(openCols, huMark);
              const inMeld = inHand >= 0 || huCol ? -1 : markInMelds(shown as any, huCid, huMark);
              return <div className="meld-row">
                <div className="melds">
                  {shown.map((m, i) => <MeldBox key={(m as any).cids?.join('-') ?? i} m={m} size="xs" bare mark={i === inMeld ? huMark ?? null : null}
                                               fromMe={mySeat !== undefined && mySeat >= 0 && m.from === mySeat
                                                 && (!(m as any).fromDrawn || m.type === 'chi')} />)}
                  {/* 正往下地区飞的那一组：先占个位子（三张宽），飞过去的落点就是量得到的，
                      不会再糊到旁边那一组头上 */}
                  {landMeldCard != null && !landMeldAgain && <div className="meld meld-bare meld-ghost" aria-hidden>
                    <CardStack cards={new Array(Math.max(1, landMeldSize ?? 3)).fill(landMeldCard)} size="xs" className="stack-xs" heads /></div>}
                  {huCol && <div className="meld meld-bare hu-meld" title="胡的那一句">
                    <CardStack cards={huCol} size="xs" className="stack-xs" heads mark={huMark ?? null} /></div>}
                </div>
                {p.hand && openCols.length > 0 && <div className="melds open-hand">{openCols.map((gp, i) => (
                  <div key={i} className="meld meld-bare hand-meld"><CardStack cards={gp} size="xs" className="stack-xs" heads mark={i === inHand ? huMark ?? null : null} /></div>
                ))}</div>}
              </div>;
            })()}
            {/* 弃牌堆外面这层壳一直在（空着也占一点地方），给飞过来的牌一个准落点 */}
            <div className="pile-slot">
              {(holdCards(p.discards as Kind[], (p as any).discardCids).length > 0 || ghostCard() !== undefined)
                && <DiscardPile ghostLanded={landDone} cards={holdCards(p.discards as Kind[], (p as any).discardCids)} src={(p as any).discardSrc} size="xs"
                                ghost={ghostCard()} />}
            </div>
          </div>
        </div>}
      </div>
      {bubbles.filter(b => b.seat === seat.seat).map(b => <div key={b.id} className="bubble"
        style={{ top: 10, ['--bub-d' as any]: `${(b as any).ms ?? 1150}ms` }}>{b.text}</div>)}
    </div>
  );
}

/** 下地的牌：偎 亮一张盖两张、提 亮一张盖三张（服务端已按可见性把盖住的牌置为 -1）；自己的暗牌全亮但加暗标 */
/** 公共牌堆旁的"刚出现的牌"：偏向出牌者方向，只显示字头，放大高亮 */
/** 头像外圈倒计时 */
/** 轮到谁：一根"手表指针" —— 贴着倒计时环的一个小圆点做底座，花瓣座上伸出一根尖针指向那一家 */
function TurnPointer({ angle, color }: { angle: number; color: string }) {
  const petals = [0, 72, 144, 216, 288];
  return (
    <svg className="deck-pointer" width="26" height="40" viewBox="0 0 22 34"
      style={{ filter: `drop-shadow(0 0 5px ${color})`, transform: `translate(-50%, -50%) rotate(${angle}deg) translateY(-42px)` }}>
      {/* 针：短一点，头是圆的 */}
      <path d="M 11 11 L 13.2 26 L 8.8 26 Z" fill={color} />
      <circle cx="11" cy="11" r="2.4" fill={color} />
      {/* 花座：底座那个点周围一圈小花瓣 */}
      {petals.map(a => (
        <circle key={a} r="2.6" fill={color} opacity="0.92"
          cx={11 + Math.sin(a * Math.PI / 180) * 4.2} cy={28 - Math.cos(a * Math.PI / 180) * 4.2} />
      ))}
      {/* 底座：正好落在圆环上的那个点 */}
      <circle cx="11" cy="28" r="3.4" fill="#fff" stroke={color} strokeWidth="1.6" />
    </svg>
  );
}

function TurnRing({ frac, size, square, wide }: { frac: number; size: number; square?: boolean; wide?: boolean }) {
  if (square) {
    // 方（或加宽的）头像：外面套一圈圆角框，沿着周长走
    const GAP = 5;                                   // 框离头像留这么宽
    const box = (wide ? Math.round(size * 1.86) : size) + GAP * 2, h = size + GAP * 2;
    const pad = 2, bw = box - pad * 2, bh = h - pad * 2, r = Math.min(12, Math.round(bh / 3));
    const len = 2 * (bw - 2 * r) + 2 * (bh - 2 * r) + 2 * Math.PI * r;
    return <svg className={`turn-ring ${wide ? 'turn-ring-wide' : ''}`} width={box} height={h} viewBox={`0 0 ${box} ${h}`}>
      <rect x={pad} y={pad} width={bw} height={bh} rx={r} fill="none" stroke="rgba(0,0,0,.35)" strokeWidth="3" />
      <rect x={pad} y={pad} width={bw} height={bh} rx={r} fill="none" stroke={ringColor(frac)} strokeWidth="3" strokeLinecap="round"
        strokeDasharray={`${len}`} strokeDashoffset={`${len * (1 - frac)}`}
        /* 这儿以前挂着 `transition: stroke-dashoffset .25s linear`。
         看着是顺滑了，代价是：圈每 250ms 收到一个新值就补一段 250ms 的动画 —— 首尾相接，
         等于**整局游戏一直有一条 60 帧／秒的动画在跑**。而 stroke-dashoffset 合成器插不了值，
         每一帧都得重算样式、把这圈 SVG 重画一遍；屏上同时有三四个圈（三家头像 + 按钮），
         叠起来就是一份不小的持续开销。倒计时本来就是一秒跳四格，直接跳没人看得出来。 */ />
    </svg>;
  }
  const r = size / 2 - 2;
  return <svg className="turn-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
    <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(0,0,0,.35)" strokeWidth="3" />
    <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={ringColor(frac)} strokeWidth="3" strokeLinecap="round"
      strokeDasharray={`${2 * Math.PI * r}`} strokeDashoffset={`${2 * Math.PI * r * (1 - frac)}`}
      /* 这儿以前挂着 `transition: stroke-dashoffset .25s linear`。
         看着是顺滑了，代价是：圈每 250ms 收到一个新值就补一段 250ms 的动画 —— 首尾相接，
         等于**整局游戏一直有一条 60 帧／秒的动画在跑**。而 stroke-dashoffset 合成器插不了值，
         每一帧都得重算样式、把这圈 SVG 重画一遍；屏上同时有三四个圈（三家头像 + 按钮），
         叠起来就是一份不小的持续开销。倒计时本来就是一秒跳四格，直接跳没人看得出来。 */ />
  </svg>;
}

/** 打出无人要的牌：叠成一摞，只露字头；先打的在下，后打的在上 */
/**
 * ghost = 正在往这儿飞的那张牌：先摆一个**隐形的占位**（visibility: hidden）。
 * 这一摞是 flex 换行排的，占位一摆，这张牌最终落在哪儿就是量得到的事实，
 * 不用再照着"最后一张的右边 + 间距"去推 —— 推出来的位置遇上换行、边距就会差一点，
 * 看着就是"飞过去之后又挪了一下"。占位不占视觉，落地之后自然被真牌替掉。
 */
function DiscardPile({ cards, src, className, size = 'sm', style, ghost, ghostLanded, mine }: { cards: Kind[]; src?: ('hand' | 'draw')[]; className?: string; size?: 'xs' | 'sm'; style?: React.CSSProperties; ghost?: Kind; ghostLanded?: boolean; mine?: boolean }) {
  const n = Math.min(16, cards.length);
  const show = cards.slice(-n);
  const ss = (src ?? []).slice(-n);
  return <div className={`discard-pile pile-${size} ${className ?? ''}`} style={style} title={`打出 ${cards.length} 张`}>
    {show.map((k, i) => (
      // 摸上来直接打出去的牌加一个蓝点，和从手里打出的区分开
      <div key={i} className={`pile-item ${ss[i] === 'draw' ? 'from-draw' : 'from-hand'}`} title={ss[i] === 'draw' ? '摸上来直接打出' : '从手里打出'}>
        {/* 红点只点「从手里打出去的」。摸上来直接打出的那几张不点 ——
            这一摞要一眼看清的是"我从手上丢出去的牌谁吃了"，摸啥打啥的不算数。
            （别家下地的组合里那个红点不受这条影响：不管我是手里打的还是摸的，被要走了就点。） */}
        <Card kind={k} size={size} head className={mine && ss[i] !== 'draw' ? 'card-src' : undefined} />
      </div>
    ))}
    {/* 飞到了就**当场显出来**，不等服务端那一帧 —— 落点和牌面这会儿都已经是定数了。
        （没落地之前还是隐形的：牌这时候正在半空飞，堆里不能同时有第二张。） */}
    {ghost !== undefined && <div className={`pile-item ${ghostLanded ? 'from-hand' : 'pile-ghost'}`} aria-hidden={ghostLanded ? undefined : true}><Card kind={ghost} size={size} head /></div>}
    {/* 整块区域的记号：一个「弃」钉在右下角。空着的时候不挂 —— 空框比这个标还小 */}
    {cards.length > 0 && <i className="pile-tag" aria-hidden>弃</i>}
  </div>;
}

/** 胡牌大印：摆在那一家的"明牌位"上（跟 FloatCard 用同一套方位） */
function HuStamp({ rel, n, mineAt }: { rel: number; n: number; mineAt?: { dx: number; dy: number } | null }) {
  const dir = rel === 0 && mineAt ? [mineAt.dx, mineAt.dy]
    : (n === 4 ? [[0, 52], [104, 2], [0, -56], [-104, 2]] : [[0, 52], [102, 16], [-102, 16]])[rel] ?? [0, 52];
  return <div className="hu-stamp" aria-hidden
    style={{ ['--fx1' as any]: `${dir[0]}px`, ['--fy1' as any]: `${dir[1]}px` }}><span>胡</span></div>;
}

function FloatCard({ card, rel, n, who, verb, fromRel, mineAt }: { card: Kind; rel: number; n: number; who?: string; verb: string; fromRel?: number; mineAt?: { dx: number; dy: number } | null }) {
  // 我自己那一份摆到出牌弧线的顶点上（量出来的），其他家还是按固定方位
  const dirOf = (r: number) => (r === 0 && mineAt ? [mineAt.dx, mineAt.dy]
    : (n === 4 ? [[0, 52], [104, 2], [0, -56], [-104, 2]] : [[0, 52], [102, 16], [-102, 16]])[r] ?? [0, 52]);
  const dir = dirOf(rel);
  // 摸牌：从公共牌堆飞向摸牌者；打牌：从他手上飞到出牌区；吃/碰：从这张牌现在的位置飞到进牌者面前
  const draw = verb === '摸';
  const from = fromRel !== undefined ? dirOf(fromRel) : draw ? [0, 0] : [dir[0] * 1.9, dir[1] * 1.9];
  const vars = { '--fx0': `${from[0]}px`, '--fy0': `${from[1]}px`, '--fx1': `${dir[0]}px`, '--fy1': `${dir[1]}px` } as React.CSSProperties;
  return (
    <div key={`${card}-${verb}-${rel}`} className={`float-card ${draw ? 'fly-draw' : 'fly-play'}`} style={vars}>
      <div className="label">{who} {verb}</div>
      <div className="float-inner">
        <Card kind={card} size="xl" head highlight />
        {draw && <span className="face-veil" />}
      </div>
    </div>
  );
}

/** 胡牌结算详情：结算弹窗与纪录表回看共用 */
export function HuPanel({ hu, names, round }: { hu: { seat: number; card: number; ziMo: boolean; fromSeat: number; detail: any }; names: string[]; round?: number }) {
  const d = hu.detail;
  return <>
    <div style={{ fontSize: 20, fontWeight: 900, color: 'var(--gold)' }}>
      {round !== undefined && <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>第 {round} 局 · </span>}
      {names[hu.seat]} {d.tianHu ? '天胡' : d.diHu ? '地胡' : d.raiseHand ? '举手胡' : hu.card < 0 ? BIG_HU_NAME[d.bigMeldType ?? ''] : `${hu.ziMo ? '自摸' : ''}${HU_WAY_NAME[d.huWay ?? ''] ?? '胡牌'}`}
      {d.redName && ` · ${d.redName}`}{d.dianPao && ` · ${names[hu.fromSeat]} 放炮`}
    </div>
    {(() => {
      // 胡的那张牌手里可能有好几张：整张面板只标一个「胡」——
      // 先看下地牌，再看手里的句子，最后看那一对
      const want: Kind | null = hu.card >= 0 ? (hu.card as Kind) : null;
      const hMark = markIn(d.handGroups.map((gr: any) => gr.cards as Kind[]), want);
      const mMark = hMark >= 0 ? -1 : markInMelds(d.melds as any, (hu as any).cid, want);
      const pMark = mMark < 0 && hMark < 0 && d.pair && want !== null && (d.pair as Kind[]).includes(want);
      return <div className="row hu-cards" style={{ flexWrap: 'wrap', gap: 6 }}>
        {d.melds.map((m: Meld, i: number) => <MeldBox key={'m' + i} m={{ ...m, hidden: false }} size="sm" heads mark={i === mMark ? want : null} />)}
        {d.handGroups.map((gr: any, i: number) => {
          // 手里原有的三张同字是「坎」（胡的那张凑成的按"碰"算息，引擎已标 asPeng）
          const kan = !gr.asPeng && gr.cards.length === 3 && gr.cards.every((c: Kind) => c === gr.cards[0]);
          return <div key={'h' + i} className="meld" style={{ background: 'rgba(76,217,123,.2)' }}>
            <CardStack cards={gr.cards} size="sm" className="stack-sm" heads mark={i === hMark ? want : null} />
            {(gr.xi > 0 || kan) && <span className={`tag ${kan ? 'tag-kan' : ''}`}>{kan ? '坎' : gr.asPeng ? '碰' : ''}{gr.xi ? `${kan || gr.asPeng ? '·' : ''}${gr.xi}` : ''}</span>}
          </div>;
        })}
        {d.pair && <div className="meld" style={{ background: 'rgba(255,179,71,.25)' }}><CardStack cards={d.pair} size="sm" className="stack-sm" heads mark={pMark ? want : null} /><span className="tag">对</span></div>}
      </div>;
    })()}
    {/* 算分就三行：① 胡的哪个字 ② 胡息 → 敦数 ③ 翻倍 → 总分（谁出、出几家） */}
    <div className="hu-calc">
      {(() => {
        const k = hu.card >= 0 ? (hu.card as Kind) : ((d.huKind ?? -1) as Kind);
        if (k < 0) return null;
        // 牌名本身就是一个字（八 / 捌），直接圈起来；大写的（捌＝大八）在圈外标一个"大"
        const nm = nameOf(k);
        return <div className="hu-line"><span>胡牌</span>
          <span className="hu-kind">{isBig(k) ? <em>大</em> : null}<i className="hu-ring">{nm}</i></span></div>;
      })()}
      {d.breakdown.map((b: string, i: number) => <div key={i} className="hu-line">{b}</div>)}
      {/* 放炮：红字点名，这一胡他一个人包赔 */}
      {d.dianPao && <div className="hu-line hu-baopei"><b>{names[hu.fromSeat]}</b> 放炮包赔</div>}
    </div>
    {/* 本局总账：胡牌的分 + 提龙即时分 + 违规罚分，统一列到一处 */}
    <div className="hu-total">本局总账</div>
    <table className="ledger"><tbody>{names.map((nm, i) => {
      const parts: string[] = [];
      if (d.huDelta?.[i]) parts.push(`胡 ${fmt(d.huDelta[i])}`);
      if (d.tilong?.[i]) parts.push(`提龙 ${fmt(d.tilong[i])}`);
      if (d.penalty?.[i]) parts.push(`罚分 ${fmt(d.penalty[i])}`);
      return <tr key={i}>
        <td>{nm}{parts.length > 0 && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{parts.join(' · ')}</span>}</td>
        <td className={d.scores[i] > 0 ? 'pos' : d.scores[i] < 0 ? 'neg' : ''}>{fmt(d.scores[i])}</td>
      </tr>;
    })}</tbody></table>
  </>;
}

/** 一局结束时的亮牌：各家下地牌 + 手里剩的牌 + 没翻出来的公共牌，纪录表里回看用 */
function RevealPanel({ rv, names, huCard, hu }: { rv: NonNullable<LedgerEntry['reveal']>; names: string[]; huCard?: Kind | null; hu?: LedgerEntry['hu'] }) {
  /** 胡牌那家「胡的那一句」：算下地牌，跟吃碰的牌摆一排，别混在手牌里 */
  const huGroup = (() => {
    if (!hu?.detail) return null;
    const d: any = hu.detail;
    const gps: Kind[][] = (d.handGroups ?? []).map((g: any) => (g.cards as Kind[]).slice());
    if (d.pair) gps.push((d.pair as Kind[]).slice());
    const card: Kind = (hu.card >= 0 ? hu.card : d.huKind ?? -1) as Kind;
    if (card < 0) return null;
    return gps.find(gp => gp.includes(card)) ?? null;
  })();
  return <div className="col" style={{ gap: 6 }}>
    <b style={{ fontSize: 14 }}>本局亮牌{huCard != null && huCard >= 0 && <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>（胡 {nameOf(huCard)}，已标出）</span>}</b>
    {names.map((nm, i) => (
      <div key={i} className="reveal-row">
        <div className="reveal-name">{nm}{rv.winner === i && <span className="badge dealer" style={{ marginLeft: 4 }}>胡</span>}</div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          {/* 胡牌那家：把胡的那个字标出来 */}
          {(() => {
            const ms = (rv.melds[i] ?? []) as any[];
            // 胡的那一句从手牌里挑出来，摆到下地那一排（手牌里就不再重复显示）
            const mine = rv.winner === i ? huGroup : null;
            let hand = ((rv.hands[i] ?? []) as Kind[]).slice();
            if (mine) {
              const want2 = mine.slice();
              hand = hand.filter(k => { const q = want2.indexOf(k); if (q >= 0) { want2.splice(q, 1); return false; } return true; });
            }
            const hs = revealCols(hand);
            const want = rv.winner === i ? huCard ?? null : null;
            const inHu = mine && want !== null && mine.includes(want) ? want : null;
            const inHand = inHu ? -1 : markIn(hs, want);
            const inMeld = inHu || inHand >= 0 ? -1 : markInMelds(ms as any, (hu as any)?.cid, want);
            /* 左边挨着名字的是手里的牌，下地的牌（含胡的那一句）摆到右边 —— 一眼就分得清 */
            return <>
              {hs.map((gp, j) => (
                <div key={'h' + j} className="meld meld-bare hand-meld"><CardStack cards={gp} size="xs" className="stack-xs" heads mark={j === inHand ? want : null} /></div>
              ))}
              {(ms.length > 0 || mine) && hs.length > 0 && <span className="reveal-gap" />}
              {ms.map((m: any, j: number) => <MeldBox key={'m' + j} m={m} size="xs" bare mark={j === inMeld ? want : null} />)}
              {mine && <div className="meld meld-bare hu-meld" title="胡的那一句">
                <CardStack cards={mine} size="xs" className="stack-xs" heads mark={inHu} /></div>}
            </>;
          })()}
        </div>
      </div>
    ))}
    {rv.pileRest.length > 0 && <div className="reveal-row">
      <div className="reveal-name">底牌</div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 1 }}>
        {(rv.pileRest as Kind[]).map((k, i) => <Card key={i} kind={k} size="xs" head />)}
        <span className="pile-rest-item end"><Card kind={-1} size="xs" head /></span>
      </div>
    </div>}
  </div>;
}

function MeldBox({ m, size, bare, heads, mark, fromMe }: { m: Meld; size: 'xs' | 'sm'; bare?: boolean; heads?: boolean; mark?: Kind | null; fromMe?: boolean }) {
  /* fromMe：这一组里那张牌是从我这儿去的。标不标看它当初是怎么出去的：
       - **从我手里打出去的**：不管谁要走、不管是吃是碰是跑，一律标 —— 我喂出去的牌，
         我自己得看得见去向（回头牌就是照这个数的）。
       - **我摸上来亮在桌上的**：只有被下家**吃**走才标。那张牌我本来就没打算出，
         被人碰了跑了不算我喂的，标了反而乱。
     引擎在 `fromCid` 里记着到底是哪一张，照着牌号找出位置，在那张牌头点一个红点 ——
     光看牌面找不行：碰的三张同字，分不出哪张是我的。 */
  const dot = fromMe && (m as any).fromCid !== undefined
    ? (m.cids ?? []).indexOf((m as any).fromCid) : -1;
  // 吃 / 碰 等：被吃的那张牌排在最上面（cards[0] 即来牌）
  // 偎 / 提 / 龙：桌面上只亮第一张，其余是盖着的（自己把鼠标放上去能看到是什么）
  return <div className={`meld ${m.hidden ? 'meld-dark' : ''} ${bare ? 'meld-bare' : ''}`} title={((m as any).part ? '下伙' : MELD_NAME[m.type]) + (m.xi ? ` ${m.xi}息` : '') + (m.hidden ? `（${nameOf(m.cards[0])} × ${m.cards.length}，只亮一张）` : '') + (dot >= 0 ? '（红点那张是你的牌）' : '')}>
    <CardStack cards={m.cards} size={size} className={`stack-${size}`} hiddenFrom={m.hidden ? 1 : undefined} heads={bare || heads} mark={mark ?? null} dotAt={dot >= 0 ? dot : undefined} />
    {!bare && <span className="tag">{(m as any).part ? '伙' : MELD_TAG[m.type] ?? m.type}{m.xi ? `·${m.xi}` : ''}</span>}
  </div>;
}

function WaitingPanel({ room, me, isHost, nextRoundIn }: { room: RoomView; me: PublicUser; isHost: boolean; nextRoundIn: number | null }) {
  const mine = room.seats.find(s => s.user?.id === me.id);
  const filled = room.seats.filter(s => s.user).length;
  return (
    <div className="panel col" style={{ alignItems: 'center', minWidth: 220 }}>
      {room.status === 'paused' ? <b>牌局暂停，等待补位（{filled}/{room.seats.length}）</b>
        : nextRoundIn !== null ? <>
            {room.roundNo === 0 && <b>人齐了，马上开局</b>}
            <b className="next-count">{nextRoundIn}s</b>
          </>
          : room.roundNo === 0 ? <b>{room.isPrivate || room.name ? `${room.name ? room.name + ' · ' : ''}等待玩家加入（${filled}/${room.seats.length}）` : '正在匹配…'}</b>
            : <b className="next-count" />}
      {room.isPrivate && <div className="muted">房号 {room.id}，把房号和密码发给牌友</div>}
      <div className="row">{room.seats.map(s => <div key={s.seat} className="col" style={{ alignItems: 'center', gap: 2 }}><Avatar user={s.user} size={36} /><span className="muted" style={{ fontSize: 11 }}>{s.user ? (s.isBot ? '机器人' : '已就座') : '空位'}</span></div>)}</div>
      {!room.isPrivate && mine && room.status !== 'playing' && (
        <div className="row" style={{ gap: 8 }}>
          {room.seats.some(s => !s.user) && <button onClick={() => socket.send({ type: 'room.bots', add: true })}>请机器人</button>}
          {room.seats.some(s => s.kickable) && <button className="ghost" onClick={() => socket.send({ type: 'room.bots', add: false })}>请走机器人</button>}
        </div>
      )}
      {room.isPrivate && isHost && filled === room.seats.length && room.seats.every(s => s.ready) && room.status === 'waiting' && <button onClick={() => socket.send({ type: 'room.start' })}>开始</button>}
    </div>
  );
}
