/**
 * 大厅玩法卡上的点缀画：淡淡一层，压在渐变底色上面、文字下面。
 * 衡阳红黑 —— 弯弯的湘水、南飞的雁、水里的鱼，还有保卫战的城墙与纪念塔（衡阳是"抗战纪念城"）。
 * 耒阳提龙 —— 一条龙盘着华表，云纹绕在中间。
 * 一律画在 viewBox 0 0 200 140 里，卡片多大都铺满。
 */
export function TileArt({ kind }: { kind: 'hh' | 'tl' | 'lh' | 'pw' }) {
  if (kind === 'hh') return (
    <svg className="tile-svg" viewBox="0 0 200 140" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <defs>
        <linearGradient id="hhWater" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffd9a0" stopOpacity=".5" />
          <stop offset="1" stopColor="#ffffff" stopOpacity=".18" />
        </linearGradient>
      </defs>
      {/* 远山：衡山一线 */}
      <path fill="#ffffff" fillOpacity=".12"
        d="M0 56 L18 40 L32 52 L48 30 L66 50 L82 38 L98 54 L118 36 L136 56 L152 42 L172 60 L188 48 L200 58 L200 140 L0 140 Z" />
      {/* 衡阳保卫战：城墙 + 城楼 + 纪念塔（右边那座） */}
      <g fill="none" stroke="#ffffff" strokeOpacity=".42" strokeWidth="2" strokeLinecap="round">
        {/* 城墙 + 垛口 */}
        <path d="M104 88 h92" />
        <path d="M104 88 v-8 h6 v-5 h6 v5 h6 v-5 h6 v5 h6 v-5 h6 v5 h6 v-5 h6 v5 h6 v-5 h6 v5 h6 v-5 h6 v5 h6 v-8" strokeOpacity=".32" />
        {/* 城楼 */}
        <path d="M120 75 v-11 M146 75 v-11 M114 64 l19 -12 l19 12" />
        <path d="M122 64 v-7 h22 v7" strokeOpacity=".3" />
        {/* 抗战纪念塔：三层塔身 + 塔尖 */}
        <path d="M172 88 v-26 M186 88 v-26 M168 62 h22 M172 62 v-11 M186 62 v-11 M168 51 h22 M175 51 v-9 M183 51 v-9 M171 42 h16 M179 42 v-9" />
        <path d="M175 33 l4 -8 l4 8" strokeOpacity=".46" />
      </g>
      {/* 弯弯的湘水：一宽一窄两道 */}
      <path fill="none" stroke="url(#hhWater)" strokeWidth="14" strokeLinecap="round"
        d="M-6 128 C 30 118, 40 104, 76 100 C 116 96, 140 112, 176 104 C 190 101, 198 98, 206 96" />
      <path fill="none" stroke="#ffffff" strokeOpacity=".2" strokeWidth="3" strokeLinecap="round"
        d="M-6 128 C 30 118, 40 104, 76 100 C 116 96, 140 112, 176 104 C 190 101, 198 98, 206 96" />
      {/* 水里的鱼：两条，尾巴摆开 */}
      <g fill="#ffffff" fillOpacity=".4" stroke="none">
        <g transform="translate(96 104) rotate(-8)">
          <path d="M0 0 c 6 -7, 20 -7, 26 0 c -6 7, -20 7, -26 0 Z" />
          <path d="M-2 0 l-9 -6 l0 12 Z" />
          <circle cx="17" cy="-2" r="1.5" fill="#1c1c1c" fillOpacity=".55" />
        </g>
        <g transform="translate(140 118) rotate(6) scale(.78)">
          <path d="M0 0 c 6 -7, 20 -7, 26 0 c -6 7, -20 7, -26 0 Z" />
          <path d="M-2 0 l-9 -6 l0 12 Z" />
          <circle cx="17" cy="-2" r="1.6" fill="#1c1c1c" fillOpacity=".5" />
        </g>
      </g>
      {/* 南飞的雁：一个人字，往画面右下走（雁阵惊寒，声断衡阳之浦） */}
      <g fill="none" stroke="#ffffff" strokeOpacity=".55" strokeWidth="2.2" strokeLinecap="round">
        {[[16, 18], [32, 25], [48, 32], [64, 39], [34, 12], [50, 19], [66, 26], [82, 33]].map(([x, y], i) => (
          <path key={i} d={`M${x} ${y} q 5 -5 10 0 q 5 -5 10 0`} />
        ))}
      </g>
    </svg>
  );

  if (kind === 'tl') return (
    <svg className="tile-svg" viewBox="0 0 200 140" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <defs>
        <radialGradient id="tlGlow" cx="50%" cy="46%" r="52%">
          <stop offset="0" stopColor="#d9ffe9" stopOpacity=".3" />
          <stop offset="1" stopColor="#d9ffe9" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="124" cy="60" rx="72" ry="54" fill="url(#tlGlow)" />
      {/* 龙身分成"绕到柱子后面"和"绕到前面"两截：后面那截先画，柱子压在上面，前面那截最后画 —— 这样才真像盘上去 */}
      {(() => {
        const BACK = ['M152 98 C 160 84, 128 80, 112 90', 'M160 52 C 164 38, 138 32, 126 38'];
        const FRONT = ['M74 112 C 92 122, 140 116, 152 98', 'M112 90 C 94 100, 92 80, 108 70 C 126 60, 156 66, 160 52'];
        const body = (d: string, back: boolean, i: number) => (
          <g key={(back ? 'b' : 'f') + i}>
            <path d={d} fill="none" stroke="#ffffff" strokeLinecap="round"
              strokeOpacity={back ? .12 : .2} strokeWidth="9" />
            <path d={d} fill="none" stroke="#ffffff" strokeLinecap="round"
              strokeOpacity={back ? .34 : .58} strokeWidth="5" />
          </g>
        );
        return <>
          {/* ① 绕到柱子后面的那两截 */}
          <g>{BACK.map((d, i) => body(d, true, i))}</g>
          {/* ② 华表：云板 + 柱身 + 承露盘上的蹲兽 */}
          <g stroke="#ffffff" fill="none" strokeLinecap="round">
            <g strokeOpacity=".6" strokeWidth="2.4">
              <path d="M118 112 v-70 M130 112 v-70" />
              <path d="M112 112 h24 M110 116 h28" strokeOpacity=".44" />
              <path d="M114 42 h20 M116 38 h16" />
              <path d="M120 38 c 0 -6, 8 -6, 8 0" />
              <path d="M121 32 l-2 -4 M127 32 l2 -4" strokeOpacity=".45" />
            </g>
            <g strokeOpacity=".45" strokeWidth="2">
              <path d="M118 58 c -10 -6, -20 -2, -26 4 c 8 2, 12 6, 12 10 c 6 -6, 10 -10, 14 -10" />
              <path d="M130 54 c 10 -6, 20 -2, 26 4 c -8 2, -12 6, -12 10 c -6 -6, -10 -10, -14 -10" />
            </g>
            <path d="M124 108 v-62" strokeOpacity=".22" strokeWidth="1.2" />
          </g>
          {/* ③ 绕到前面的那两截 + 背鳍 / 爪 / 头 / 尾 */}
          <g>{FRONT.map((d, i) => body(d, false, i))}</g>
        </>;
      })()}
      <g fill="none" stroke="#ffffff" strokeLinecap="round">
        {/* 背鳍：一路的小尖 */}
        <g strokeOpacity=".42" strokeWidth="1.6">
          {[[90, 118], [110, 120], [132, 114], [150, 102], [100, 78], [116, 64], [138, 64], [156, 58]]
            .map(([x, y], i) => <path key={i} d={`M${x} ${y} l-3 -6 l6 0 Z`} />)}
        </g>
        {/* 龙爪：一只搭在柱子上，一只伸在外面 */}
        <g strokeOpacity=".5" strokeWidth="1.8">
          <path d="M114 94 l-7 7 M107 101 l-4 -1 M107 101 l-1 4 M107 101 l4 3" />
          <path d="M142 68 l8 -6 M150 62 l4 2 M150 62 l0 -4 M150 62 l-3 -4" />
        </g>
        {/* 龙头：吻、角、须、眼 */}
        <g strokeOpacity=".62" strokeWidth="2.2">
          <path d="M126 38 c -8 -4, -10 -14, -2 -18 c 8 -4, 18 0, 20 6 l 6 -2 l -5 6 l 5 3 l -7 1" />
          <path d="M122 22 c -2 -7, 2 -12, 8 -12" />
          <path d="M128 20 c 1 -6, 6 -9, 11 -8" strokeOpacity=".5" />
          <path d="M138 34 c 6 3, 10 8, 10 14" strokeOpacity=".45" />
          <path d="M134 38 c 5 5, 6 10, 4 15" strokeOpacity=".36" />
        </g>
        <circle cx="134" cy="25" r="2" fill="#ffffff" fillOpacity=".7" stroke="none" />
        {/* 尾巴：末梢分叉 */}
        <g strokeOpacity=".45" strokeWidth="2">
          <path d="M74 112 l-10 8 M74 112 l-12 -1 M68 118 l-8 5" />
        </g>
      </g>
      {/* 云纹：两朵，托在龙身下面 */}
      <g fill="none" stroke="#ffffff" strokeOpacity=".22" strokeWidth="1.8" strokeLinecap="round">
        <path d="M28 54 c -6 -6, 2 -13, 8 -8 c 2 -7, 12 -6, 13 1 c 7 -1, 8 8, 1 9 l-20 0 c -4 0 -5 -2 -2 -2" />
        <path d="M60 30 c -5 -5, 2 -11, 7 -7 c 2 -6, 10 -5, 11 1 c 6 -1, 7 7, 1 8 l-17 0 c -3 0 -4 -2 -2 -2" />
      </g>
    </svg>
  );

  if (kind === 'lh') return (
    <svg className="tile-svg" viewBox="0 0 200 140" preserveAspectRatio="xMidYMid slice" aria-hidden>
      {/* 六胡抢：六张牌一字排开，抢的那一张飞出来 */}
      <g stroke="#ffffff" strokeOpacity=".3" fill="#ffffff" fillOpacity=".08" strokeWidth="1.6">
        {[0, 1, 2, 3, 4, 5].map(i => <rect key={i} x={22 + i * 24} y={72} width="18" height="30" rx="3" />)}
        <rect x="120" y="34" width="20" height="32" rx="3" transform="rotate(14 130 50)" fillOpacity=".14" />
      </g>
      <g fill="none" stroke="#ffffff" strokeOpacity=".28" strokeWidth="1.8" strokeLinecap="round">
        <path d="M118 62 C 112 52, 116 42, 124 38" />
        <path d="M118 62 l-1 -6 M118 62 l6 -2" />
      </g>
    </svg>
  );

  return (
    <svg className="tile-svg" viewBox="0 0 200 140" preserveAspectRatio="xMidYMid slice" aria-hidden>
      {/* 密码房：一把老锁 */}
      <g fill="none" stroke="#ffffff" strokeOpacity=".3" strokeWidth="2.4" strokeLinecap="round">
        <rect x="74" y="66" width="52" height="38" rx="6" fill="#ffffff" fillOpacity=".08" />
        <path d="M86 66 v-10 a14 14 0 0 1 28 0 v10" />
        <circle cx="100" cy="82" r="5" />
        <path d="M100 87 v9" />
      </g>
    </svg>
  );
}
