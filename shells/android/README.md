# 跑胡子 Android 壳（WebView）

纯 Gradle Kotlin 项目，单 Activity + 系统 `WebView` 加载线上 H5，无第三方依赖
（不使用 AndroidX/AppCompat，只用平台自带的 `android.app.Activity`）。

## 目录结构

```
shells/android/
  settings.gradle.kts
  build.gradle.kts
  gradle.properties
  app/
    build.gradle.kts                      minSdk 24, targetSdk 34, WEB_URL 配置
    src/main/AndroidManifest.xml
    src/main/java/cn/yytbank/paohuzi/MainActivity.kt
    src/main/res/...
  gradle/wrapper/gradle-wrapper.properties
```

## 准备 Gradle Wrapper

本仓库未附带 `gradle-wrapper.jar`（二进制文件，不适合直接入库）。首次使用前，
在已安装 Gradle 的机器上执行一次：

```bash
cd shells/android
gradle wrapper --gradle-version 8.7
```

会自动补全 `gradlew` / `gradlew.bat` / `gradle-wrapper.jar`。之后即可用
`./gradlew` 构建，无需本机单独装 Gradle。

## 修改 H5 地址

`app/build.gradle.kts` 中的 `WEB_URL` 默认值：

```kotlin
val webUrl = (project.findProperty("webUrl") as String?) ?: "https://paohuzi.yytbank.cn"
```

有两种改法：

1. 直接改默认值。
2. 打包时传参覆盖：`./gradlew assembleRelease -PwebUrl=https://test.paohuzi.yytbank.cn`

代码里通过 `BuildConfig.WEB_URL` 读取。

## 构建 Debug APK

```bash
cd shells/android
./gradlew assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

Debug 包使用 Android 自带的调试签名（debug keystore），可直接安装测试。

## 构建并签名 Release APK

1. 生成签名 keystore（只需一次）：

   ```bash
   keytool -genkey -v -keystore paohuzi-release.keystore \
     -alias paohuzi -keyalg RSA -keysize 2048 -validity 10000
   ```

2. 在 `app/build.gradle.kts` 的 `android {}` 块中补充签名配置（示例）：

   ```kotlin
   signingConfigs {
       create("release") {
           storeFile = file("/path/to/paohuzi-release.keystore")
           storePassword = System.getenv("KEYSTORE_PASSWORD")
           keyAlias = "paohuzi"
           keyPassword = System.getenv("KEY_PASSWORD")
       }
   }
   buildTypes {
       getByName("release") {
           signingConfig = signingConfigs.getByName("release")
       }
   }
   ```

3. 构建：

   ```bash
   KEYSTORE_PASSWORD=xxx KEY_PASSWORD=xxx ./gradlew assembleRelease
   # 产物：app/build/outputs/apk/release/app-release.apk
   ```

## NativeBridge（JS 桥）

H5 中可直接调用（Android 的 `@JavascriptInterface` 方法都是函数调用形式）：

```js
window.NativeBridge.platform();    // 'android'
window.NativeBridge.version();     // '1.0.0'
window.NativeBridge.vibrate();     // 震动反馈
window.NativeBridge.openUrl('https://...'); // 系统浏览器打开外链
```

## 语音聊天 / 麦克风权限

- `AndroidManifest.xml` 已声明 `RECORD_AUDIO` / `MODIFY_AUDIO_SETTINGS`。
- 网页发起 `getUserMedia` 录音请求时，`WebChromeClient.onPermissionRequest`
  会先检查系统权限，未授权则弹出系统权限请求框，授权后再放行给网页。

## 其他说明

- 返回键：有网页历史记录时返回上一页，否则走系统默认行为（退出/切后台）。
- 屏幕常亮：已设置 `FLAG_KEEP_SCREEN_ON`。
- 横竖屏切换：`AndroidManifest.xml` 中 Activity 声明了
  `configChanges="orientation|screenSize|..."`，旋转屏幕不会重建 WebView /
  丢失页面状态。
- 图标：`res/mipmap-anydpi-v26/ic_launcher.xml` 是自适应图标占位（矢量),
  请替换 `drawable/ic_launcher_foreground.xml` 为正式设计。
