# 跑胡子 H5

湖南跑胡子（字牌）线上对战：浏览器 / iOS / Android / 微信小程序 一套代码。
支持 **衡阳红黑、衡阳六胡抢、耒阳提龙** 三种玩法，大厅机器人陪打 + 私人密码房。

```
paohuzi/
├─ packages/engine/   规则引擎（纯 TS，前后端共用）：牌、发牌、胡牌判定、胡息/番、三种玩法算分、动作优先级仲裁、机器人 AI
├─ server/            Node ≥ 22 服务端，零 npm 依赖（node:http + 自带 WebSocket 实现 + node:sqlite）
├─ web/               React H5（bun 打包；web/dist 已预构建，可直接部署）
├─ shells/ios         Xcode 工程（WKWebView 壳）
├─ shells/android     Gradle 工程（WebView 壳）
├─ miniprogram/       微信小程序（web-view 载 H5）
└─ docs/              规则说明 RULES.md、部署 DEPLOY.md
```

## 快速运行

```bash
# 服务端（Node 22.5+，不需要 npm install）
node --experimental-strip-types server/src/index.ts
# 浏览器打开 http://localhost:8787
```

- 测试：`npm test`（引擎单测 + 服务端集成测试，无需 npm install）
- 机器人自对局：`npm run sim -w server 500`
- 重新打包前端（需要 bun）：`npm run build -w web`。react/react-dom 已 vendor 在 `web/vendor/`。

## 功能清单

| 需求 | 实现位置 |
|---|---|
| 大厅（分场次、底分门槛、机器人 4 秒补位、账号积分结算） | `server/src/lobby.ts`、`room.ts` |
| 私人房（VIP/有开房权限者开房、4-6 位数字密码、3 人满员、不限局数、退出暂停 / 补位续打、房主结束出输赢表） | `server/src/room.ts`、`web/src/Table.tsx` |
| 三种玩法算分（可在 `packages/engine/src/rules.ts` 调参） | `rules.ts`、`game.ts` |
| 动作优先级：胡 > 跑 > 碰 > 吃；提 / 偎 / 跑 自动执行，只留 胡 / 碰 / 吃 / 过 四个按钮；吃需等碰方决定；臭牌 | `game.ts` `resolveClaims/tick` |
| 理牌：自动分列（成组 / 搭子 / 散牌），可拖动归组；手牌呈扇形（各列下角叠在同一支点）；牌面 / 牌背仿实物（细长白牌、上下同字、玫红框黄底团花牌背），下地的牌纵向错落叠放 | `web/src/sort.ts`、`Card.tsx`、`styles.css` |
| 语音：出牌 / 碰 / 吃 / 胡 / 过 播报（TTS）、按住说话语音聊天、实验性语音指令（说"碰""过"即可操作） | `web/src/voice.ts` |
| 登录：注册 / 登录 / 游客昵称 / 微信（H5 网页授权 + 小程序 code2Session，未配置时 mock） | `server/src/auth.ts` |
| 分数与输赢统计、点头像看资料（胜率、牌品、胡/自摸/点炮/提/跑） | `db.ts`、`web/src/ui.tsx` |
| 机器人（手牌分解评估 + 息潜力 + 安全牌启发式） | `packages/engine/src/bot.ts` |
| iOS / Android 壳、小程序 web-view | `shells/`、`miniprogram/` |

## 规则

按你确认的规则实现（详见 `docs/RULES.md`，参数在 `packages/engine/src/rules.ts`）：大小夹为同字两大一小 / 两小一大；一二三、二七十必须纯大或纯小；第一次提 / 跑要出牌、重提 / 重跑免出牌且不能胡；有提 / 跑 / 龙时胡牌需恰好一个对子；衡阳按敦计分（10 胡按 15 算、(胡−6)/3、胡牌张数加敦、大红 ×5 小红 ×3 全黑 ×5 一点红 ×4 自摸 ×2）；耒阳提龙即时算分（大字 2 倍 / 小字 1 倍）、10/20 胡卡胡、13 红 / 全黑 / 一点红 / 天胡 / 地胡 / 自摸翻倍。

六胡抢：4 人，庄 15 张闲 14 张，8 红小红 10 红大红。摸到第四张成龙必须亮出；两张在手摸到第三张必须偎（除非正好胡）；耒阳红黑 / 天地胡为胡息翻倍，自摸为敦数翻倍。
