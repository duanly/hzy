/**
 * 「这个 app 是做什么的」：登录页摆一份精简的，主页「关于」里摆完整的一份。
 * 末尾那句**仅限内部娱乐测试**两处都要有，别省。
 */
import { Modal } from './ui.tsx';

export const FEATURES: [string, string][] = [
  ['地道玩法', '精细化贴合衡阳、耒阳各地的打法，哪条规矩有出入随时改、马上生效'],
  ['节奏可控', '读秒可调，舒缓适宜，又不会从快慢里泄漏牌桌信息；手上有优先权就赶紧行使，别让三家干等着'],
  ['牌局溯源', '胡牌详情、明牌记录、战局复盘 —— 每一次进张、每一次决策都追得到根，看得明明白白'],
  ['复盘涨技', '哪一手打错了不靠回忆：回放一步步把你带回当时的牌面，从中学习、领略，牌技自然见涨'],
  ['延时卡', '参考牌类竞技的做法，关键时候给你续一次思考时间，从容面对复杂局面'],
  ['罚错免纠纷', '有错当场罚、当场纠，这一点甚至强过面对面 —— 系统不会记错账，谁也糊弄不了你，事后也没得扯皮'],
  ['公平公正', '牌桌上做了信息混淆：吃碰的快慢、按钮亮多久都看不出谁手里有什么 —— 别人从你的反应里读不到牌，也没有盘外招可使'],
  ['指纹便捷', '设备指纹免于注册，便捷又安全：账号跟你的设备绑在一起，谁也拿不走 —— 你天生就有一个账号，不用注册、不用申请'],
];

export const NOTICE = '仅限内部娱乐测试使用，不涉及任何真实财物。';

/** 登录页上那一小块（不占地方，扫一眼就行） */
export function AboutBrief({ onMore }: { onMore?: () => void }) {
  return (
    <div className="about-brief">
      {FEATURES.map(([k], i) => <span key={i} className="ab-tag">{k}</span>)}
      <div className="ab-notice">{NOTICE}</div>
      {onMore && <a className="ab-more" onClick={onMore}>看看这是个什么游戏 ›</a>}
    </div>
  );
}

/** 主页「关于」里那一份 */
export function AboutModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose} className="rules-modal">
      <div className="col rules" style={{ gap: 10 }}>
        <div>
          <b style={{ fontSize: 18 }}>关于衡之娱</b>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>衡阳红黑 · 六胡抢 · 耒阳提龙</div>
        </div>
        <div className="rules-body">
          <div className="rules-sec">
            {FEATURES.map(([k, v], i) => (
              <div key={i} className="rules-kv"><span className="k">{k}</span><span className="v">{v}</span></div>
            ))}
          </div>
          <div className="about-notice">{NOTICE}</div>
        </div>
        <button className="ghost" onClick={onClose}>知道了</button>
      </div>
    </Modal>
  );
}
