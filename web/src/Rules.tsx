/**
 * 玩法说明：只说这个玩法**跟别处不一样**的地方。
 * 吃、碰、跑、偎、提、怎么算一句这些跟主流打法一致，会打字牌的一看就懂，不在这儿啰嗦。
 * （逐条的完整规则在 docs/RULES.md。）
 */
import { Modal } from './ui.tsx';

type Sec = { h: string; lines: (string | string[])[] };

const LEIYANG: Sec[] = [
  {
    h: '哪儿的打法',
    lines: ['耒阳提龙，主要流行于耒阳一带。'],
  },
  {
    h: '几个特色',
    lines: [
      ['提龙算分', '提、龙当场就算分：大字其他每家付 2 倍底分，小字 1 倍；跑不付分'],
      ['无胡', '牌齐了却一点息都没有（没跑没提没偎没碰没坎、手里也没有作对的牌），按 21 胡算'],
      ['可以贪大', '不想胡就点碰 / 吃 / 过，只是放弃这一次；后面再胡，得比放弃那次每家应付的分更高'],
      ['胡息翻倍', '13 红、全黑、一点红、天胡、举手（闲家进第一张就胡）—— 可以叠乘，翻倍之后再换算敦'],
      ['自摸', '敦数 ×2'],
    ],
  },
  {
    h: '敦怎么数',
    lines: [
      '10 胡 2 敦、20 胡 4 敦（卡胡）；11–15 一敦；16–19 两敦；21 三敦；再往上每多 3 胡加一敦。',
      '每家付 = 敦 × 倍数 × 底分。',
    ],
  },
  {
    h: '其余照常',
    lines: ['吃、碰、跑、偎、提、怎么算一句、起胡 10 息，跟一般字牌打法一样。'],
  },
];

const HENGYANG: Sec[] = [
  {
    h: '哪儿的打法',
    lines: ['衡阳红黑，衡阳一带的打法（六胡抢是它的四人版，庄 15 闲 14，吃只能吃上家）。'],
  },
  {
    h: '几个特色',
    lines: [
      ['红胡 / 黑胡', '数胡牌时手里 + 下地的红字（二七十 / 贰柒拾）够不够门槛：小红 ×3、大红 ×5；一张红都没有是全黑 ×5，只有一张是一点红 ×4'],
      ['门槛', '红黑：小红 10 张 / 大红 13 张；六胡抢：8 / 10'],
      ['胡牌加敦', '胡的那个字，手里的（含胡的那张）+ 已经下地的（碰、偎、提、跑、吃里的）一共几张就加几敦，打出去的不算 —— 提龙胡 / 开跑胡那一坎四张，就加 4 敦。红字也加敦：超出小红门槛的每张 +1 敦，到了大红按超出大红门槛的每张 +1 敦'],
      ['有胡必胡', '能胡的时候只留「胡」这一个按钮，5 秒不点就自动帮你胡'],
      ['放炮三倍', '别人从手里打出的牌被胡 = 放炮，放炮的那家按三倍包赔，其他人不输赢'],
      ['自摸', '×2；天胡、地胡分数翻倍'],
    ],
  },
  {
    h: '敦怎么数',
    lines: [
      '基本敦：10 胡按 15 算，其余 (胡息 − 6) ÷ 3 取整。',
      '基本敦 + 上面那些加敦 = 总敦；每家付 = 总敦 × 番 × 底分。',
      '结算面板上写成「22胡(5敦) + 2敦（胡五2张）→ 7敦」，一眼看得出加了几敦。',
    ],
  },
  {
    h: '其余照常',
    lines: ['吃、碰、跑、偎、提、怎么算一句、起胡 10 息，跟一般字牌打法一样。'],
  },
];

const SHEETS: Record<string, { name: string; sub: string; secs: Sec[] }> = {
  hy_honghei: { name: '衡阳红黑', sub: '三人 · 红黑算番 · 胡牌加敦 · 有胡必胡', secs: HENGYANG },
  hy_liuhuqiang: { name: '衡阳六胡抢', sub: '四人 · 庄 15 闲 14 · 衡阳算法', secs: HENGYANG },
  ly_tilong: { name: '耒阳提龙', sub: '三人 · 提龙算分 · 可以贪大', secs: LEIYANG },
};

export function RulesModal({ variant, onClose }: { variant: string; onClose: () => void }) {
  const s = SHEETS[variant] ?? SHEETS.hy_honghei;
  return (
    <Modal onClose={onClose} className="rules-modal">
      <div className="col rules" style={{ gap: 10 }}>
        <div>
          <b style={{ fontSize: 18 }}>{s.name} · 玩法说明</b>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{s.sub}</div>
        </div>
        <div className="rules-body">
          {s.secs.map((sec, i) => (
            <div key={i} className="rules-sec">
              <h4>{sec.h}</h4>
              {sec.lines.map((l, j) => Array.isArray(l)
                ? <div key={j} className="rules-kv"><span className="k">{l[0]}</span><span className="v">{l[1]}</span></div>
                : <p key={j}>{l}</p>)}
            </div>
          ))}
        </div>
        <button className="ghost" onClick={onClose}>知道了</button>
      </div>
    </Modal>
  );
}
