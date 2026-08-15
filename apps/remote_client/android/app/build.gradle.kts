import java.io.FileInputStream
import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val keystoreProperties = Properties()
val keyPropertiesPath = providers.gradleProperty("tethoqKeyProperties")
    .orElse(providers.environmentVariable("TETHOQ_ANDROID_KEY_PROPERTIES"))
    .orNull
val keystorePropertiesFile = keyPropertiesPath?.let { file(it) }
if (keystorePropertiesFile?.isFile == true) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}
val releaseTaskRequested = gradle.startParameter.taskNames.any { it.contains("release", ignoreCase = true) }
if (releaseTaskRequested && keystorePropertiesFile?.isFile != true) {
    throw GradleException(
        "Release signing requires an external key.properties path. Set TETHOQ_ANDROID_KEY_PROPERTIES or pass -PtethoqKeyProperties=/absolute/path/key.properties."
    )
}

android {
    namespace = "com.universalagentremote.universal_agent_remote"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.universalagentremote.universal_agent_remote"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (keystorePropertiesFile?.isFile == true) {
            create("release") {
                val signingPropertiesFile = requireNotNull(keystorePropertiesFile)
                keyAlias = keystoreProperties.getProperty("keyAlias")
                    ?: throw GradleException("key.properties is missing keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
                    ?: throw GradleException("key.properties is missing keyPassword")
                val configuredStoreFile = keystoreProperties.getProperty("storeFile")
                    ?: throw GradleException("key.properties is missing storeFile")
                val configuredStorePath = File(configuredStoreFile)
                storeFile = if (configuredStorePath.isAbsolute) {
                    configuredStorePath
                } else {
                    File(signingPropertiesFile.parentFile, configuredStoreFile).canonicalFile
                }
                storePassword = keystoreProperties.getProperty("storePassword")
                    ?: throw GradleException("key.properties is missing storePassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
