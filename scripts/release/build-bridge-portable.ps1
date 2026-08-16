[CmdletBinding()]
param(
  [string]$OutputDirectory,
  [switch]$SkipBuild,
  [switch]$SkipSmokeTest,
  [switch]$PortableOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$companionRoot = Join-Path $repoRoot 'apps\desktop_companion'
$bridgeRoot = Join-Path $repoRoot 'apps\agent_bridge'
$releaseSource = Join-Path $bridgeRoot 'release'
$artifactsRoot = if ($OutputDirectory) {
  [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
  Join-Path $repoRoot 'artifacts\releases\bridge'
}
$stageRoot = Join-Path $artifactsRoot '.stage'
$runtimeStage = Join-Path $companionRoot 'build\bridge-runtime'
$companionOutput = Join-Path $stageRoot 'companion-release'
$electronBuilder = Join-Path $companionRoot 'node_modules\.bin\electron-builder.cmd'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Assert-ChildPath([string]$Candidate, [string]$Parent, [string]$Label) {
  $candidateFull = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\')
  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\')
  if (-not $candidateFull.StartsWith("$parentFull\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must stay inside $parentFull"
  }
}

function Reset-Directory([string]$Path, [string]$Parent) {
  Assert-ChildPath $Path $Parent 'Bridge release staging directory'
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
  New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Get-Sha256([string]$Path) {
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return ([System.BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $hasher.Dispose()
  }
}

function Get-RelativePath([string]$BasePath, [string]$TargetPath) {
  $baseFull = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\') + '\'
  $targetFull = [System.IO.Path]::GetFullPath($TargetPath)
  $baseUri = [Uri]::new($baseFull, [UriKind]::Absolute)
  $targetUri = [Uri]::new($targetFull, [UriKind]::Absolute)
  return [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()).Replace('/', '\')
}

function Write-DeterministicZip([string]$SourceDirectory, [string]$ArchivePath) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path -LiteralPath $ArchivePath) {
    Remove-Item -LiteralPath $ArchivePath -Force
  }
  $archiveStream = [System.IO.File]::Open($ArchivePath, [System.IO.FileMode]::CreateNew)
  try {
    $archive = [System.IO.Compression.ZipArchive]::new($archiveStream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
    try {
      Get-ChildItem -LiteralPath $SourceDirectory -Recurse -File |
        Sort-Object { Get-RelativePath $SourceDirectory $_.FullName } |
        ForEach-Object {
          $entryName = (Get-RelativePath $SourceDirectory $_.FullName).Replace('\', '/')
          $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
          $entry.LastWriteTime = [DateTimeOffset]::new(2026, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
          $entryStream = $entry.Open()
          $fileStream = [System.IO.File]::OpenRead($_.FullName)
          try { $fileStream.CopyTo($entryStream) } finally { $fileStream.Dispose(); $entryStream.Dispose() }
        }
    } finally { $archive.Dispose() }
  } finally { $archiveStream.Dispose() }
}

New-Item -ItemType Directory -Path $artifactsRoot -Force | Out-Null
Reset-Directory $stageRoot $artifactsRoot

& (Join-Path $repoRoot 'scripts\release\stage-bridge-runtime.ps1') `
  -OutputDirectory $runtimeStage `
  -SkipBuild:$SkipBuild `
  -SkipSmokeTest:$SkipSmokeTest
if ($LASTEXITCODE -ne 0) { throw 'Bridge runtime staging failed.' }

$companionPackage = Get-Content -LiteralPath (Join-Path $companionRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$companionPackage.version
$installerName = "Tethoq-Bridge-$version-x64.exe"

if (-not $PortableOnly) {
  Push-Location $companionRoot
  try {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Installing the pinned Bridge companion dependencies failed.' }
    if (-not (Test-Path -LiteralPath $electronBuilder -PathType Leaf)) {
      throw 'The pinned Bridge companion electron-builder executable is missing after npm ci.'
    }
    & npm.cmd run build:brand-assets
    if ($LASTEXITCODE -ne 0) { throw 'Bridge brand asset build failed.' }
    & $electronBuilder --win nsis --x64 --publish never --config.directories.output=$companionOutput
    if ($LASTEXITCODE -ne 0) { throw 'Bridge NSIS packaging failed.' }
    if (-not $SkipSmokeTest) {
      & node.exe scripts/packaged-runtime-smoke.cjs (Join-Path $companionOutput 'win-unpacked')
      if ($LASTEXITCODE -ne 0) { throw 'Packaged Bridge runtime smoke test failed.' }
    }
    & node.exe scripts/write-release-metadata.cjs $companionOutput
    if ($LASTEXITCODE -ne 0) { throw 'Bridge release metadata generation failed.' }
  } finally {
    Pop-Location
  }

  $installerPath = Join-Path $companionOutput $installerName
  Copy-Item -LiteralPath $installerPath -Destination (Join-Path $artifactsRoot $installerName)
  Copy-Item -LiteralPath (Join-Path $companionOutput 'release-manifest.json') -Destination (Join-Path $artifactsRoot 'release-manifest.json')
}

# Keep a portable engine bundle for advanced diagnostics; the public Bridge
# download and release manifest point to the compact NSIS application above.
$portableName = "Tethoq-Bridge-Engine-$version-win-x64"
$portableRoot = Join-Path $stageRoot $portableName
New-Item -ItemType Directory -Path $portableRoot -Force | Out-Null
Get-ChildItem -LiteralPath $runtimeStage -Force | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $portableRoot -Recurse
}
Copy-Item -LiteralPath (Join-Path $releaseSource 'Start Tethoq Bridge.cmd') -Destination $portableRoot
Copy-Item -LiteralPath (Join-Path $releaseSource 'Pair a phone.cmd') -Destination $portableRoot
Copy-Item -LiteralPath (Join-Path $releaseSource 'PORTABLE_README.md') -Destination (Join-Path $portableRoot 'README.md')
$portableArchive = Join-Path $artifactsRoot "$portableName.zip"
Write-DeterministicZip $portableRoot $portableArchive

$checksums = @()
if (-not $PortableOnly) {
  $installerSha256 = Get-Sha256 (Join-Path $artifactsRoot $installerName)
  $checksums += "$installerSha256  $installerName"
}
$portableFile = Get-Item -LiteralPath $portableArchive
$portableSha256 = Get-Sha256 $portableArchive
$checksums += "$portableSha256  $($portableFile.Name)"
$checksums | Set-Content -LiteralPath (Join-Path $artifactsRoot 'SHA256SUMS.txt') -Encoding ascii

if ($PortableOnly) {
  $runtimeManifest = Get-Content -LiteralPath (Join-Path $runtimeStage 'runtime-manifest.json') -Raw | ConvertFrom-Json
  $manifest = [ordered]@{
    schemaVersion = 1
    product = 'Tethoq Bridge Engine'
    version = $version
    source = $runtimeManifest.source
    channel = 'preview'
    artifact = [ordered]@{
      fileName = $portableFile.Name
      platform = 'windows'
      architecture = 'x64'
      format = 'portable-zip'
      sizeBytes = $portableFile.Length
      sha256 = $portableSha256
    }
    engine = $runtimeManifest
  }
  [System.IO.File]::WriteAllText((Join-Path $artifactsRoot 'release-manifest.json'), ($manifest | ConvertTo-Json -Depth 8) + "`n", $utf8NoBom)
}

Remove-Item -LiteralPath $stageRoot -Recurse -Force
Write-Output "Created Bridge release artifacts in $artifactsRoot"
