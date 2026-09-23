/** 玩法规则配置：衡阳红黑、衡阳六胡抢（4 人）、耒阳提龙 */
export type VariantId = 'hy_honghei' | 'hy_liuhuqiang' | 'ly_tilong';
export type ScoringStyle = 'hengyang' | 'leiyang';

export interface RuleSet {
  id: VariantId;
  name: string;
  players: number;          // 3 或 4
  handSize: number;         // 闲家手牌数（庄家 +1）
  huThreshold: number;      // 起胡息（基本胡息，不含红字额外胡）
  scoring: ScoringStyle;
  ziMoMultiplier: number;   // 自摸倍数
  dianPaoMultiplier: number; // 放炮者付的倍数（其他家不输赢）：衡阳 3、耒阳 2
  mustHu: boolean;          // 有胡必胡（衡阳）；耒阳可放弃，但下次胡必须比放弃的分高
  /** 衡阳红黑倍数 */
  red: {
    bigRedMin: number; bigRedMultiplier: number;     // 大红：13 红（六胡抢 10 红）×5
    smallRedMin: number; smallRedMultiplier: number; // 小红：≥10 红（六胡抢 8 红）×3
    allBlackMultiplier: number;                      // 全黑 ×5
    oneRedMultiplier: number;                        // 一点红 ×4
    extraDunPerRed: number;                          // 超出小红 / 大红门槛的每张红字加敦
  };
  /** 耒阳：13 红 / 全黑 / 一点红 / 天胡 / 地胡 各胡息翻倍（翻倍后再算敦）；自摸敦数翻倍 */
  leiyang: {
    bigRedMin: number; doubleMultiplier: number;
    tiScoreBig: number;    // 大字提：其他每家付的底分倍数
    tiScoreSmall: number;  // 小字提
  };
  /** 无胡（一点胡息都没有）按多少胡算；0 = 这一桌不许无息胡 */
  noXiHu: number;
  /* ───── 开房时可调的几个开关（大厅一律按下面的默认值，全开） ───── */
  /** 耒阳：闲家一张没进就胡（举手胡）翻倍；关了就当普通胡算 */
  raiseHand: boolean;
  /** 衡阳：算不算红黑（大红 / 小红 / 全黑 / 一点红，以及红字超门槛加敦） */
  redBlack: boolean;
  /** 衡阳：胡的那个字在手里 / 下地的有几张就加几敦 */
  huCardDun: boolean;
  /**
   * 发牌方式：
   *  - 'fresh'：每局一副**全新的牌**、完全洗匀，再**轮流**一人三张转着圈发（大厅固定用这个）
   *  - 'big'（大牌玩法）：把上一局打完的牌收拢、切两半对插搓几把，然后**一人切一整段**
   *    （庄先拿 21 张，其余各拿 20）。上一局的坎、句子会成片地留下来，大牌多、打着过瘾
   */
  deal: 'fresh' | 'big';
  /** 时限（毫秒） */
  timers: {
    drawerDecide: number; // 摸牌后决定
    claimPeng: number;    // 碰/跑/胡 响应时限（超时视为放弃）
    claimChi: number;     // 吃 响应时限
    discard: number;      // 出牌时限
    /* 有胡必胡（衡阳）：胡牌按钮给这么久，到点自动胡。**固定 5 秒**，不跟读秒走 ——
       反正是"必胡"，没什么好想的，桌上三家都等着；读秒 60 秒的桌子要是也给一半，
       一张必胡的牌能卡住半分钟。（读秒最短 10 秒，那时候碰也是 5 秒，两个刚好一样。） */
    huForced: number;
    /* 摸出来的牌没人要得起时，服务端仍然等摸牌者**下家**一个"虚拟过牌"的超时信号。
       等于每次摸牌都给下家一个按钮：要得起就是真按钮，要不起就是这个**不显示**的虚拟按钮。
       有了它，"这张牌真没人要"和"有人放弃了"在别人看来花的时间一样长，
       从节奏上就漏不出牌。 */
    ghostPass: number;
  };
  chouPai: boolean;      // 臭牌：放弃碰之后不能再碰该牌
  /** 延时卡：到点没表态自动用掉一张，行动时间按原时长再续一次 */
  delay: {
    atStart: number;     // 开局每人发几张
    atMid: number;       // 公共牌派出 midAfter 张之后再发几张
    midAfter: number;
  };
}

const baseDelay = { atStart: 1, atMid: 1, midAfter: 10 };
const baseTimers = { drawerDecide: 30000, claimPeng: 15000, claimChi: 30000, discard: 30000, huForced: 5000, ghostPass: 3000 };
const hyRed = { bigRedMin: 13, bigRedMultiplier: 5, smallRedMin: 10, smallRedMultiplier: 3, allBlackMultiplier: 5, oneRedMultiplier: 4, extraDunPerRed: 1 };
const lhRed = { ...hyRed, bigRedMin: 10, smallRedMin: 8 };
const lyRed = { bigRedMin: 13, doubleMultiplier: 2, tiScoreBig: 2, tiScoreSmall: 1 };

export const RULES: Record<VariantId, RuleSet> = {
  hy_honghei: {
    id: 'hy_honghei', name: '衡阳红黑', players: 3, handSize: 20,
    huThreshold: 10, scoring: 'hengyang', ziMoMultiplier: 2, dianPaoMultiplier: 3, mustHu: true,
    red: hyRed, leiyang: { ...lyRed, tiScoreBig: 0, tiScoreSmall: 0 },
    timers: baseTimers, chouPai: true, delay: baseDelay, noXiHu: 0,
    raiseHand: true, redBlack: true, huCardDun: true, deal: 'fresh',
  },
  hy_liuhuqiang: {
    id: 'hy_liuhuqiang', name: '衡阳六胡抢', players: 4, handSize: 14,
    huThreshold: 10, scoring: 'hengyang', ziMoMultiplier: 2, dianPaoMultiplier: 3, mustHu: true,
    red: lhRed, leiyang: { ...lyRed, tiScoreBig: 0, tiScoreSmall: 0 },
    timers: baseTimers, chouPai: true, delay: baseDelay, noXiHu: 0,
    raiseHand: true, redBlack: true, huCardDun: true, deal: 'fresh',
  },
  ly_tilong: {
    id: 'ly_tilong', name: '耒阳提龙', players: 3, handSize: 20,
    huThreshold: 10, scoring: 'leiyang', ziMoMultiplier: 2, dianPaoMultiplier: 2, mustHu: false,
    red: hyRed, leiyang: lyRed,
    // 耒阳特有：一点胡息都没有（无胡）按 21 胡算
    timers: baseTimers, chouPai: true, delay: baseDelay, noXiHu: 21,
    raiseHand: true, redBlack: true, huCardDun: true, deal: 'fresh',
  },
};

export function getRules(id: VariantId, override?: Partial<RuleSet>): RuleSet {
  return { ...RULES[id], ...(override ?? {}) };
}

/** 衡阳计敦：10 胡按 15 算；其余 (胡−6)/3 取整 */
export function hengyangDun(xi: number): number {
  if (xi === 10) xi = 15;
  return Math.floor((xi - 6) / 3);
}

/** 耒阳计敦：10 胡 2 敦、20 胡 4 敦（卡胡）；11–15 一敦；16–19 两敦；21 三敦；21 以上每多 3 胡加一敦 */
export function leiyangDun(xi: number): number {
  if (xi === 10) return 2;
  if (xi === 20) return 4;
  if (xi <= 15) return 1;
  if (xi <= 19) return 2;
  return 3 + Math.floor((xi - 21) / 3);
}
