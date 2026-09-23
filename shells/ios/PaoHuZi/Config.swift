import Foundation

/// 运行时配置：H5 地址等。
/// 如需切换测试/生产环境，直接修改 webURL 或在打包前替换本文件。
struct Config {
    /// H5 页面地址。默认走局域网测试服务器；
    /// 用户在登录页填过服务器地址的话，以保存下来的为准（见 WebViewController）。
    static let defaultURL = "http://paohuzi.yytbank.cn:1991"
    static var webURL: URL {
        let saved = UserDefaults.standard.string(forKey: "phz_server") ?? ""
        return URL(string: saved.isEmpty ? defaultURL : saved) ?? URL(string: defaultURL)!
    }

    /// Native 层版本号，通过 NativeBridge.version 暴露给 H5。
    static let nativeVersion = "1.0.0"
}
