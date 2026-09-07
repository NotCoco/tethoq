[CmdletBinding()]
param(
  [string]$OutputDirectory,
  [string]$FlutterExecutable = 'flutter',
  [string]$KeyPropertiesPath = $env:TETHOQ_ANDROID_KEY_PROPERTIES
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$clientRoot = Join-Path $repoRoot 'apps\remote_client'
$outputRoot = if ($OutputDirectory) { [System.IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $repoRoot 'artifacts\releases\android' }
if (-not $KeyPropertiesPath -or -not (Test-Path -LiteralPath $KeyPropertiesPath -PathType Leaf)) {
  throw 'Set TETHOQ_ANDROID_KEY_PROPERTIES to the external release-signing key.properties file.'
}
$KeyPropertiesPath = [System.IO.Path]::GetFullPath($KeyPropertiesPath)
$pubspec = Get-Content -LiteralPath (Join-Path $clientRoot 'pubspec.yaml') -Raw
if ($pubspec -notmatch '(?m)^version:\s*([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)\+([0-9]+)\s*$') {
  throw 'pubspec.yaml must declare a release version and an increasing Android build number.'
}
$version = $Matches[1]
$buildNumber = [int]$Matches[2]
$previousKeyProperties = $env:TETHOQ_ANDROID_KEY_PROPERTIES
Push-Location $clientRoot
try {
  $env:TETHOQ_ANDROID_KEY_PROPERTIES = $KeyPropertiesPath
  & $FlutterExecutable build apk --release
  if ($LASTEXITCODE -ne 0) { throw 'Signed Android release build failed.' }
} finally {
  $env:TETHOQ_ANDROID_KEY_PROPERTIES = $previousKeyProperties
  Pop-Location
}

$localProperties = Get-Content -LiteralPath (Join-Path $clientRoot 'android\local.properties') -Raw
if ($localProperties -notmatch '(?m)^sdk\.dir=(.+)\r?$') { throw 'Flutter did not resolve the Android SDK.' }
$sdkRoot = $Matches[1].Trim().Replace('\\', '\').Replace('\:', ':')
$buildTools = Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'build-tools') -Directory |
  Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $buildTools) { throw 'Android SDK build-tools are missing.' }
$apk = Join-Path $clientRoot 'build\app\outputs\flutter-apk\app-release.apk'
$signature = & (Join-Path $buildTools.FullName 'apksigner.bat') verify --verbose --print-certs $apk
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
$signatureText = $signature -join "`n"
if ($signatureText -notmatch 'Signer #1 certificate SHA-256 digest:\s*([A-Fa-f0-9]{64})') { throw 'APK signing certificate fingerprint is missing.' }
$certificateSha256 = $Matches[1].ToLowerInvariant()
$badging = & (Join-Path $buildTools.FullName 'aapt.exe') dump badging $apk
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the release APK.' }
$badgingText = $badging -join "`n"
if ($badgingText -notmatch "package: name='com\.universalagentremote\.universal_agent_remote' versionCode='$buildNumber' versionName='$([regex]::Escape($version))'") {
  throw 'APK identity or version does not match the release source.'
}
if ($badgingText -match '(?m)^application-debuggable') { throw 'A debuggable APK cannot be published as the release build.' }
if ($badgingText -notmatch "(?m)^sdkVersion:'(\d+)'") { throw 'APK minimum Android SDK is missing.' }
$minimumSdk = [int]$Matches[1]
$sourceJson = & node.exe (Join-Path $PSScriptRoot 'source-metadata.cjs') $repoRoot
if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve release source metadata.' }
$source = $sourceJson | ConvertFrom-Json
if ($source.dirty -ne $false -or $source.revision -eq 'unknown') { throw 'Commit the release source before packaging it for publication.' }

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$artifactName = "Tethoq-Mobile-$version-android.apk"
$artifactPath = Join-Path $outputRoot $artifactName
Copy-Item -LiteralPath $apk -Destination $artifactPath -Force
$stream = [System.IO.File]::OpenRead($artifactPath)
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $digest = [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
} finally {
  $sha256.Dispose()
  $stream.Dispose()
}
$manifest = [ordered]@{
  schemaVersion = 1
  product = 'Tethoq Mobile'
  version = $version
  buildNumber = $buildNumber
  source = $source
  channel = 'preview'
  artifact = [ordered]@{ fileName = $artifactName; platform = 'android'; architecture = 'universal'; format = 'apk'; sizeBytes = (Get-Item -LiteralPath $artifactPath).Length; sha256 = $digest }
  android = [ordered]@{ applicationId = 'com.universalagentremote.universal_agent_remote'; minimumSdk = $minimumSdk; debuggable = $false; signingCertificateSha256 = $certificateSha256 }
}
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $outputRoot 'android-release-manifest.json'), ($manifest | ConvertTo-Json -Depth 6) + "`n", $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $outputRoot 'SHA256SUMS-Android.txt'), "$digest  $artifactName`n", $utf8NoBom)
Write-Output "Verified signed Android $version+$buildNumber release: $artifactPath"
