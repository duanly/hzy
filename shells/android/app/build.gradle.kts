plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "cn.yytbank.paohuzi"
    compileSdk = 34

    defaultConfig {
        applicationId = "cn.yytbank.paohuzi"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        // H5 地址，可在打包前修改，或通过 -PwebUrl=... 覆盖。
        val webUrl = (project.findProperty("webUrl") as String?) ?: "http://paohuzi.yytbank.cn:1991"
        buildConfigField("String", "WEB_URL", "\"$webUrl\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            // 调试包默认和 release 用同一个 WEB_URL，可用 -PwebUrl 覆盖成测试环境地址
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // 无第三方依赖：全部使用 Android SDK 自带的 WebView / AndroidX 核心库（随 AGP 自带，无需联网下载额外 artifact）。
}
