# 跑胡子 iOS 壳（WKWebView）

无 CocoaPods / SPM 依赖，纯手写 `.xcodeproj`，用 WKWebView 加载线上 H5。

## 目录结构

```
shells/ios/
  PaoHuZi.xcodeproj/      Xcode 项目文件
  PaoHuZi/
    AppDelegate.swift
    SceneDelegate.swift
    WebViewController.swift   全屏 WKWebView + NativeBridge
    Config.swift               H5 地址配置
    Info.plist
    Assets.xcassets/           仅占位 AppIcon，需替换为正式图标
    Base.lproj/LaunchScreen.storyboard
```

## 打开项目

1. 用 Xcode 15+ 打开 `PaoHuZi.xcodeproj`（双击，或 `open PaoHuZi.xcodeproj`）。
2. 选中 `PaoHuZi` target → `Signing & Capabilities`：
   - 勾选 `Automatically manage signing`。
   - 在 `Team` 下拉框中选择你的 Apple Developer 团队。
   - Bundle Identifier 默认是 `cn.yytbank.paohuzi`，如与已在开发者后台登记的 App ID 不一致，请同步修改。

## 修改 H5 地址

编辑 `PaoHuZi/Config.swift`：

```swift
static let webURL: URL = URL(string: "https://paohuzi.yytbank.cn")!
```

改成测试环境域名即可，无需改动其他代码。

## NativeBridge（JS 桥）

页面加载后，H5 中可直接使用：

```js
window.NativeBridge.platform   // 'ios'
window.NativeBridge.version    // 原生壳版本号
window.NativeBridge.vibrate()  // 触发震动反馈
window.NativeBridge.openUrl('https://...')  // 用系统浏览器打开外链
```

原理：`WKUserScript` 在文档开始时注入 `window.NativeBridge`，其方法内部通过
`window.webkit.messageHandlers.native.postMessage(...)` 把消息转发给
`WebViewController` 的 `WKScriptMessageHandler` 实现（handler 名为 `native`）。

## 语音聊天所需权限

`Info.plist` 中已配置 `NSMicrophoneUsageDescription`，WKWebView 会遵循网页内
`getUserMedia` 的权限请求并弹出系统授权弹窗，无需额外原生代码。

## 打包 / 导出 IPA（企业签 / Ad-hoc / TestFlight）

1. 顶部菜单选择真机或 `Any iOS Device (arm64)` 作为编译目标。
2. `Product → Archive`，等待生成归档（Organizer 会自动弹出）。
3. 在 Organizer 中点击 `Distribute App`：
   - **TestFlight / App Store**：选择 `App Store Connect` → `Upload`。
   - **Ad-hoc**（给指定设备 UDID 安装）：选择 `Ad Hoc Distribution`，需要提前
     在开发者后台注册好设备 UDID，并生成对应的 Ad-hoc Provisioning Profile。
   - **企业签**（Enterprise，免越狱安装到任意设备）：选择
     `Enterprise Distribution`，需要使用企业开发者账号（In-House）签名，导出后
     得到 `.ipa`，配合自建的 `.plist` + HTTPS 服务器即可实现网页直装
     （`itms-services://?action=download-manifest&url=...`）。
4. 导出完成后会得到 `PaoHuZi.ipa`，按上述分发方式分发给用户。

## 常见问题

- **加载失败**：WebViewController 内置了失败重试按钮，网络恢复后点击即可重新加载。
- **横竖屏**：`Info.plist` 已同时声明 portrait / landscape 支持，游戏页面可按需
  自行锁定方向（可扩展 `setOrientation` 桥接消息处理）。
- **App 图标**：`Assets.xcassets/AppIcon.appiconset` 目前只有一个 1024×1024
  占位位，请替换为正式设计图后在 Xcode 中拖入。
