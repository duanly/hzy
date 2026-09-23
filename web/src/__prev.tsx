import { createRoot } from 'react-dom/client';
import { CardStack } from './Card.tsx';
import { Modal } from './ui.tsx';
const S = (r: number) => (r - 1) as any, B = (r: number) => (10 + r - 1) as any;
createRoot(document.getElementById('root')!).render(
  <div id="stage" style={{ position: 'relative', width: 852, height: 393, overflow: 'hidden', background: 'radial-gradient(ellipse at center,#1b6b4e,#0d4030 70%)' }}>
    <Modal top className="chi-modal">
      <div className="col" style={{ gap: 6 }}><b>第一步：怎么吃</b>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
          {[[S(2), S(3)], [S(3), S(5)], [S(2), S(10)], [B(4), S(4)]].map((cb, i) => (
            <div key={i} className="chi-opt">
              <CardStack cards={[S(4), cb[0], cb[1]]} size="sm" className="stack-sm" heads />
              <span className="muted" style={{ fontSize: 13 }}>{i === 0 ? '还要下伙 ›' : i === 1 ? '带下伙' : '选这组'}</span>
            </div>))}
        </div>
      </div>
    </Modal>
  </div>);
