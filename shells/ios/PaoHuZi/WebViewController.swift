import UIKit
import WebKit

/// 全屏 WKWebView 容器，负责加载 H5、注入 NativeBridge、处理加载失败重试等。
final class WebViewController: UIViewController, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate {

    private var webView: WKWebView!
    private let reloadButton = UIButton(type: .system)

    // MARK: - NativeBridge 注入脚本
    // window.NativeBridge 暴露给 H5 调用，实际动作通过 postMessage 转发到 Native 的 "native" handler。
    private static let bridgeScriptSource = """
    (function () {
      if (window.NativeBridge) { return; }
      window.NativeBridge = {
        platform: 'ios',
        version: '\(Config.nativeVersion)',
        vibrate: function () {
          window.webkit.messageHandlers.native.postMessage({ action: 'vibrate' });
        },
        openUrl: function (u) {
          window.webkit.messageHandlers.native.postMessage({ action: 'openUrl', url: u });
        },
        setOrientation: function (o) {
          window.webkit.messageHandlers.native.postMessage({ action: 'setOrientation', orientation: o });
        },
        // H5 登录页填了新的服务器地址：存起来并重新加载
        setServer: function (u) {
          window.webkit.messageHandlers.native.postMessage({ action: 'setServer', url: u });
        },
        server: '\(Config.webURL.absoluteString)'
      };
    })();
    """

    override func viewDidLoad() {
        super.viewDidLoad()
        setupWebView()
        setupReloadButton()
        loadHome()
    }

    private func setupWebView() {
        let config = WKWebViewConfiguration()
        // 允许内联播放媒体（语音/视频），不强制全屏播放。
        config.allowsInlineMediaPlayback = true
        // 不需要用户手势即可播放媒体，便于游戏内音效/语音自动播放。
        config.mediaTypesRequiringUserActionForPlayback = []

        let userContent = WKUserContentController()
        let script = WKUserScript(source: Self.bridgeScriptSource,
                                   injectionTime: .atDocumentStart,
                                   forMainFrameOnly: false)
        userContent.addUserScript(script)
        userContent.add(self, name: "native")
        config.userContentController = userContent

        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.scrollView.bounces = false
        // 别让系统按安全区去缩 WebView 的内容：页面自己用 env(safe-area-inset-*) 处理，
        // 系统再缩一次的话，横过来之后屏幕边上会空出一条（而且露出 WebView 的白底）
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.contentInset = .zero
        webView.scrollView.scrollIndicatorInsets = .zero
        // 万一还有没画到的边，也是牌桌的墨绿，而不是刺眼的白
        let felt = UIColor(red: 15 / 255, green: 61 / 255, blue: 46 / 255, alpha: 1)
        view.backgroundColor = felt
        webView.isOpaque = false
        webView.backgroundColor = felt
        webView.scrollView.backgroundColor = felt
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }

    private func setupReloadButton() {
        reloadButton.setTitle("加载失败，点击重试", for: .normal)
        reloadButton.backgroundColor = .black
        reloadButton.setTitleColor(.white, for: .normal)
        reloadButton.layer.cornerRadius = 8
        reloadButton.isHidden = true
        reloadButton.addTarget(self, action: #selector(reloadTapped), for: .touchUpInside)
        reloadButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(reloadButton)
        NSLayoutConstraint.activate([
            reloadButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            reloadButton.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            reloadButton.widthAnchor.constraint(equalToConstant: 200),
            reloadButton.heightAnchor.constraint(equalToConstant: 44),
        ])
    }

    private func loadHome() {
        reloadButton.isHidden = true
        webView.load(URLRequest(url: Config.webURL))
        // 保持屏幕常亮，避免游戏过程中自动锁屏。
        UIApplication.shared.isIdleTimerDisabled = true
    }

    @objc private func reloadTapped() {
        loadHome()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        UIApplication.shared.isIdleTimerDisabled = false
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        reloadButton.isHidden = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        reloadButton.isHidden = false
    }

    // MARK: - WKUIDelegate（原生接管 JS 弹窗；不接管的话 alert/confirm 在 WKWebView 里根本不弹）

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let ac = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        ac.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
        present(ac, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let ac = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        ac.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
        ac.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
        present(ac, animated: true)
    }

    // MARK: - WKUIDelegate（处理 window.open / target=_blank）

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                  for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // target=_blank 或 window.open 时，直接在当前 WebView 内打开，不新开窗口。
        if let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
        }
        return nil
    }

    // MARK: - WKScriptMessageHandler（处理 NativeBridge 消息）

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "native", let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }

        switch action {
        case "vibrate":
            let generator = UIImpactFeedbackGenerator(style: .medium)
            generator.impactOccurred()
        case "openUrl":
            if let urlString = body["url"] as? String, let url = URL(string: urlString) {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
            }
        case "setServer":
            if let urlString = body["url"] as? String, URL(string: urlString) != nil {
                UserDefaults.standard.set(urlString, forKey: "phz_server")
                loadHome()
            }
        case "setOrientation":
            // 主页 / 登录竖屏，进牌局转横屏
            applyOrientation((body["orientation"] as? String) ?? "landscape")
        default:
            break
        }
    }

    // MARK: - 方向支持

    /// 当前允许的方向：默认竖屏（登录 / 主页就是竖的，先横后竖会闪一下），
    /// H5 进牌局时会调 setOrientation('landscape') 转横屏
    private var orientationMask: UIInterfaceOrientationMask = .portrait

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        return orientationMask
    }

    override var shouldAutorotate: Bool { true }

    private func applyOrientation(_ o: String) {
        let mask: UIInterfaceOrientationMask = (o == "portrait") ? .portrait : .landscape
        guard mask != orientationMask else { return }
        orientationMask = mask
        if #available(iOS 16.0, *) {
            setNeedsUpdateOfSupportedInterfaceOrientations()
            if let scene = view.window?.windowScene {
                scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { _ in }
            }
        } else {
            let v = (mask == .portrait) ? UIInterfaceOrientation.portrait.rawValue
                                        : UIInterfaceOrientation.landscapeRight.rawValue
            UIDevice.current.setValue(v, forKey: "orientation")
            UIViewController.attemptRotationToDeviceOrientation()
        }
    }
}
