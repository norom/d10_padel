plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.norom.d10padel"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.norom.d10padel"
        minSdk = 24
        targetSdk = 34
        versionCode = 14
        versionName = "1.13"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // The web app is not copied into the source tree; it is staged into the
    // build directory so there is exactly one copy of it in the repository.
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("webapp"))
}

/**
 * Stage the scoreboard into the APK.
 *
 * The wrapper deliberately has no INTERNET permission, so every file the page
 * loads has to be inside the APK. sw.js is left out: the wrapper serves these
 * files locally already, and a second cache layer could only go stale.
 */
val stageWebApp by tasks.registering(Copy::class) {
    val webRoot = rootProject.projectDir.parentFile

    from(webRoot) {
        include(
            "index.html",
            "styles.css",
            "manifest.webmanifest",
            "src/**/*.js",
            "icons/**",
        )
        exclude("src/**/*.test.js")
    }
    into(layout.buildDirectory.dir("webapp"))
}

tasks.named("preBuild") { dependsOn(stageWebApp) }

dependencies {
    // WebViewAssetLoader: serves the assets over an https origin so ES modules
    // load, which they do not over file://.
    implementation("androidx.webkit:webkit:1.8.0")
}
