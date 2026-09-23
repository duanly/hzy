import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication,
                      didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // 允许后台音频继续播放（语音聊天场景），不强制中断其他 App 的音频。
        try? AVAudioSessionCompat.configure()
        return true
    }

    // MARK: UISceneSession Lifecycle（iOS 13+ 使用 Scene 生命周期，这里保留空实现即可）

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                      options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        return UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }

    func application(_ application: UIApplication, didDiscardSceneSessions sceneSessions: Set<UISceneSession>) {
    }
}

// 避免在 AppDelegate 顶部直接 import AVFoundation 造成不必要耦合，这里用一个极薄的封装。
import AVFoundation
enum AVAudioSessionCompat {
    static func configure() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, options: [.defaultToSpeaker, .allowBluetooth, .mixWithOthers])
        try session.setActive(true)
    }
}
