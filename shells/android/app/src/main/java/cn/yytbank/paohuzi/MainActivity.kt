package cn.yytbank.paohuzi

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Vibrator
import android.os.VibratorManager
import android.view.KeyEvent
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView

/**
 * 单 Activity WebView 容器：加载线上 H5，注入 NativeBridge，处理麦克风权限 / 返回键 / 常亮等。
 * 不依赖 AndroidX（无网络环境下也能离线构建），直接继承系统 Activity。
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private val recordAudioRequestCode = 1001

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 沉浸式全屏。
        window.decorView.systemUiVisibility =
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY

        // 保持屏幕常亮，避免游戏过程中息屏。
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
            allowFileAccess = false
            allowContentAccess = false
        }

        webView.addJavascriptInterface(NativeBridge(this), "NativeBridge")

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                // 网页请求麦克风等权限时，若系统权限已授予则直接放行，否则先申请系统权限。
                val needsAudio = request.resources.any { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                if (needsAudio && checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                    != PackageManager.PERMISSION_GRANTED
                ) {
                    requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), recordAudioRequestCode)
                }
                runOnUiThread { request.grant(request.resources) }
            }
        }

        webView.loadUrl(BuildConfig.WEB_URL)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // 结果无需特殊处理：WebView 的 onPermissionRequest 已经同步 grant 给网页，
        // 实际录音时系统仍会按真实的系统权限状态生效。
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    /** 暴露给 H5 调用的原生桥：window.NativeBridge.xxx() */
    class NativeBridge(private val activity: MainActivity) {

        @JavascriptInterface
        fun vibrate() {
            activity.runOnUiThread {
                val vibrator: Vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    val manager = activity.getSystemService(VibratorManager::class.java)
                    manager.defaultVibrator
                } else {
                    @Suppress("DEPRECATION")
                    activity.getSystemService(Vibrator::class.java)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(android.os.VibrationEffect.createOneShot(40, android.os.VibrationEffect.DEFAULT_AMPLITUDE))
                } else {
                    @Suppress("DEPRECATION")
                    vibrator.vibrate(40)
                }
            }
        }

        @JavascriptInterface
        fun openUrl(url: String) {
            activity.runOnUiThread {
                try {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    activity.startActivity(intent)
                } catch (_: Exception) {
                    // 忽略无法处理的 URL
                }
            }
        }

        @JavascriptInterface
        fun platform(): String = "android"

        @JavascriptInterface
        fun version(): String = "1.0.0"
    }
}
