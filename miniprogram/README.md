# 跑胡子 微信小程序壳（web-view）

小程序本身不实现游戏逻辑，只做：微信登录换 token → 用 `<web-view>` 加载线上 H5。

## 目录结构

```
miniprogram/
  app.js / app.json / project.config.json / sitemap.json
  config.js                 API / H5_URL 常量
  pages/index/
    index.js                wx.login -> 换 token -> 设置 web-view src
    index.wxml / index.wxss / index.json
```

## 使用前必须配置

1. **小程序 AppID**：`project.config.json` 里的 `appid` 是占位符
   `touristappid`，在微信开发者工具中打开项目后改成真实 AppID（或用「测试号」
   先跑通流程）。

2. **业务域名（web-view 专用）**：微信小程序的 `<web-view>` 组件只能打开
   已在 **小程序管理后台 → 开发管理 → 开发设置 → 业务域名** 里配置并通过校验
   的域名（需要下载校验文件放到该域名根目录）。本项目默认域名是
   `paohuzi.yytbank.cn`，若更换域名，需要：
   - 同步修改 `miniprogram/config.js` 里的 `H5_URL`；
   - 在小程序后台重新配置并校验新域名。

3. **request 合法域名**：`config.js` 里的 `API`（用于 `wx.request` 换取
   token）同样需要加入小程序后台的 **服务器域名 → request合法域名** 列表，
   且必须是 HTTPS。

## 服务端配套

服务端需要配置以下环境变量（详见 `docs/DEPLOY.md`）：

- `WX_MP_APPID`：小程序 AppID
- `WX_MP_SECRET`：小程序 AppSecret

服务端 `/api/auth/wechat` 接口需支持 `source: 'mp'`：用小程序的 `code` 调用
微信 `jscode2session` 接口换取 `openid`/`session_key`，签发本项目自己的登录
token 返回给小程序。

## 本地调试

1. 用微信开发者工具打开 `miniprogram/` 目录。
2. 开发工具里勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及
   HTTPS 证书」可跳过域名校验，方便本地联调；正式发布前必须按上面步骤完成
   真实域名校验。
3. 真机预览时，`wx.login` 需要真实小程序环境（开发者工具的模拟登录也可用于
   联调，但 `code` 是模拟值，需服务端配合 mock）。

## H5 <-> 小程序 通信

- H5 页面若需要向小程序发消息（比如返回首页、分享），使用
  `wx.miniProgram.postMessage({ data: {...} })`（H5 内需引入微信 JS-SDK 的
  `wx-open` 桥或使用小程序内置的 `web-view` 全局对象），小程序侧在
  `pages/index/index.js` 的 `onWebviewMessage` 中已经预留处理入口。
- 消息仅在特定时机（如返回、分享、`web-view` 组件销毁）才会真正发送，属于
  微信官方 `web-view` 组件的固有限制。
