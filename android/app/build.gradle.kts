import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// Release signing comes from the environment so no key material ever lives in the repo.
// Without SCREENS_KEYSTORE the release build falls back to the debug keystore so that
// `./gradlew assembleRelease` always produces an installable APK.
val releaseKeystore: String? = providers.environmentVariable("SCREENS_KEYSTORE").orNull?.takeIf { it.isNotBlank() }

android {
    namespace = "au.supercluster.screens.launcher"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "au.supercluster.screens.launcher"
        minSdk = 26
        targetSdk = 36
        versionCode = 20000
        versionName = "2.0.0"
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = providers.environmentVariable("SCREENS_KEYSTORE_PASSWORD").orNull
                keyAlias = providers.environmentVariable("SCREENS_KEY_ALIAS").orNull
                keyPassword = providers.environmentVariable("SCREENS_KEY_PASSWORD").orNull
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (releaseKeystore != null) {
                signingConfigs.getByName("release")
            } else {
                logger.warn("SCREENS_KEYSTORE not set: signing the release APK with the debug keystore.")
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    lint {
        // Versions are pinned on purpose: Compose 1.12+, core 1.18+ and activity 1.13 need
        // compileSdk 37 / AGP 9.1, and targetSdk stays at 36 for now.
        disable += setOf("GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion")
    }

    packaging {
        resources {
            excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/*.version", "DebugProbesKt.bin")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.tv.material)
    implementation(libs.zxing.core)

    testImplementation(libs.junit)
}
