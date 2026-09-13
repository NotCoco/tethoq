[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory,
  [switch]$SkipBuild,
  [switch]$SkipSmokeTest
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$nodeVersion = '24.8.0'
$nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
$nodeArchiveSha256 = '970ecc121a16f546174b6a870215ca4cc0de33f8a616b42c16c8c02e66b07d05'
$cloudflaredVersion = '2025.8.1'
$cloudflaredName = 'cloudflared-windows-amd64.exe'
$cloudflaredSha256 = 'b5d598b00cc3a28cabc5812d9f762819334614bae452db4e7f23eefe7b081556'
$cloudflaredLicenseName = "cloudflared-LICENSE-$cloudflaredVersion.txt"
$cloudflaredLicenseSha256 = '58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$bridgeRoot = Join-Path $repoRoot 'apps\agent_bridge'
$releaseSource = Join-Path $bridgeRoot 'release'
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
$cacheRoot = Join-Path $repoRoot 'artifacts\release-cache'
$nodeArchivePath = Join-Path $cacheRoot $nodeArchiveName
$cloudflaredPath = Join-Path $cacheRoot $cloudflaredName
$cloudflaredLicensePath = Join-Path $cacheRoot $cloudflaredLicenseName
$appRoot = Join-Path $outputRoot 'app'
$runtimeRoot = Join-Path $outputRoot 'runtime'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Assert-ChildPath([string]$Candidate, [string]$Parent, [string]$Label) {
  $candidateFull = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\')
  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\')
  if (-not $candidateFull.StartsWith("$parentFull\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must stay inside $parentFull"
  }
}

function Reset-Directory([string]$Path) {
  Assert-ChildPath $Path $repoRoot 'Bridge runtime staging directory'
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

function Copy-JavaScriptTree([string]$Source, [string]$Destination) {
  Get-ChildItem -LiteralPath $Source -Recurse -File -Filter '*.js' |
    Where-Object { $_.Name -notlike '*.test.js' } |
    Sort-Object FullName |
    ForEach-Object {
      $relative = Get-RelativePath $Source $_.FullName
      $target = Join-Path $Destination $relative
      New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
      Copy-Item -LiteralPath $_.FullName -Destination $target
    }
}

function Get-VerifiedDownload(
  [string]$Uri,
  [string]$Destination,
  [string]$Sha256,
  [string]$Label
) {
  if (-not (Test-Path -LiteralPath $Destination)) {
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
  }
  $actualHash = Get-Sha256 $Destination
  if ($actualHash -ne $Sha256) {
    throw "$Label checksum mismatch: expected $Sha256, got $actualHash"
  }
}

if (-not $SkipBuild) {
  Push-Location $repoRoot
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Bridge TypeScript build failed.' }
  } finally {
    Pop-Location
  }
}

Assert-ChildPath $outputRoot $repoRoot 'Bridge runtime output directory'
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
Reset-Directory $outputRoot
New-Item -ItemType Directory -Path $appRoot, $runtimeRoot -Force | Out-Null

Get-VerifiedDownload `
  "https://nodejs.org/dist/v$nodeVersion/$nodeArchiveName" `
  $nodeArchivePath `
  $nodeArchiveSha256 `
  'Pinned Node.js archive'
Get-VerifiedDownload `
  "https://github.com/cloudflare/cloudflared/releases/download/$cloudflaredVersion/$cloudflaredName" `
  $cloudflaredPath `
  $cloudflaredSha256 `
  'Pinned cloudflared executable'
Get-VerifiedDownload `
  "https://raw.githubusercontent.com/cloudflare/cloudflared/$cloudflaredVersion/LICENSE" `
  $cloudflaredLicensePath `
  $cloudflaredLicenseSha256 `
  'Pinned cloudflared license'

$nodeExtractRoot = Join-Path (Split-Path -Parent $outputRoot) ".node-$([Guid]::NewGuid().ToString('N'))"
Assert-ChildPath $nodeExtractRoot $repoRoot 'Temporary Node extraction directory'
try {
  Expand-Archive -LiteralPath $nodeArchivePath -DestinationPath $nodeExtractRoot -Force
  $nodeExtracted = Join-Path $nodeExtractRoot "node-v$nodeVersion-win-x64"
  Copy-Item -LiteralPath (Join-Path $nodeExtracted 'node.exe') -Destination (Join-Path $runtimeRoot 'node.exe')
  Copy-Item -LiteralPath (Join-Path $nodeExtracted 'LICENSE') -Destination (Join-Path $runtimeRoot 'NODE-LICENSE.txt')
} finally {
  if (Test-Path -LiteralPath $nodeExtractRoot) {
    Remove-Item -LiteralPath $nodeExtractRoot -Recurse -Force
  }
}
Copy-Item -LiteralPath $cloudflaredPath -Destination (Join-Path $runtimeRoot 'cloudflared.exe')
Copy-Item -LiteralPath $cloudflaredLicensePath -Destination (Join-Path $runtimeRoot 'CLOUDFLARED-LICENSE.txt')

$distRoot = Join-Path $repoRoot 'dist'
Copy-JavaScriptTree (Join-Path $distRoot 'apps\agent_bridge\src') (Join-Path $appRoot 'apps\agent_bridge\src')
$runtimePackages = @(
  'protocol',
  'provider_contract',
  'provider_codex',
  'provider_direct',
  'provider_fake',
  'provider_grok',
  'provider_opencode',
  'provider_pi',
  'transport_ws'
)
foreach ($runtimePackage in $runtimePackages) {
  Copy-JavaScriptTree `
    (Join-Path $distRoot "packages\$runtimePackage\src") `
    (Join-Path $appRoot "packages\$runtimePackage\src")
}

$opencodeAssetTarget = Join-Path $appRoot 'apps\agent_bridge\assets\opencode'
New-Item -ItemType Directory -Path $opencodeAssetTarget -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $bridgeRoot 'assets\opencode\uar_mesh.txt') -Destination $opencodeAssetTarget
Copy-Item -LiteralPath (Join-Path $bridgeRoot 'assets\opencode\tethoq_images.txt') -Destination $opencodeAssetTarget
$piAssetTarget = Join-Path $appRoot 'apps\agent_bridge\assets\pi'
New-Item -ItemType Directory -Path $piAssetTarget -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $bridgeRoot 'assets\pi\tethoq_tools.txt') -Destination $piAssetTarget
Copy-Item -LiteralPath (Join-Path $releaseSource 'package.json') -Destination (Join-Path $appRoot 'package.json')
Copy-Item -LiteralPath (Join-Path $releaseSource 'package-lock.json') -Destination (Join-Path $appRoot 'package-lock.json')

Push-Location $appRoot
try {
  & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Installing the pinned Bridge runtime dependencies failed.' }
} finally {
  Pop-Location
}

Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination (Join-Path $outputRoot 'TETHOQ-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $repoRoot 'THIRD_PARTY_NOTICES.md') -Destination (Join-Path $outputRoot 'THIRD_PARTY_NOTICES.md')
$bridgePackage = Get-Content -LiteralPath (Join-Path $bridgeRoot 'package.json') -Raw | ConvertFrom-Json
$sourceJson = & node.exe (Join-Path $repoRoot 'scripts\release\source-metadata.cjs') $repoRoot
if ($LASTEXITCODE -ne 0) { throw 'Reading Bridge source metadata failed.' }
$source = $sourceJson | ConvertFrom-Json
$runtimeInfo = [ordered]@{
  schemaVersion = 1
  product = 'Tethoq Bridge Engine'
  version = [string]$bridgePackage.version
  source = $source
  platform = 'windows'
  architecture = 'x64'
  entrypoint = 'app/apps/agent_bridge/src/main.js'
  includes = @('codex', 'opencode', 'grok', 'pi', 'omp', 'qwen', 'goose', 'kimi', 'hermes', 'cline', 'copilot', 'direct')
  excludes = @('claude')
  runtimes = [ordered]@{
    node = [ordered]@{
      version = $nodeVersion
      fileName = 'runtime/node.exe'
      distribution = $nodeArchiveName
      distributionSha256 = $nodeArchiveSha256
    }
    cloudflared = [ordered]@{
      version = $cloudflaredVersion
      fileName = 'runtime/cloudflared.exe'
      sha256 = $cloudflaredSha256
      licenseFileName = 'runtime/CLOUDFLARED-LICENSE.txt'
      licenseSha256 = $cloudflaredLicenseSha256
    }
  }
}
[System.IO.File]::WriteAllText(
  (Join-Path $outputRoot 'runtime-manifest.json'),
  ($runtimeInfo | ConvertTo-Json -Depth 6) + "`n",
  $utf8NoBom
)

if (-not $SkipSmokeTest) {
  $node = Join-Path $runtimeRoot 'node.exe'
  $entrypoint = Join-Path $appRoot 'apps\agent_bridge\src\main.js'
  $helpOutput = & $node $entrypoint --help 2>&1
  if ($LASTEXITCODE -ne 0 -or ($helpOutput -join "`n") -notmatch 'Usage: agent-bridge') {
    throw "Staged Bridge engine help smoke test failed:`n$($helpOutput -join "`n")"
  }
  $tunnelVersion = & (Join-Path $runtimeRoot 'cloudflared.exe') --version 2>&1
  if ($LASTEXITCODE -ne 0 -or ($tunnelVersion -join "`n") -notmatch [regex]::Escape($cloudflaredVersion)) {
    throw "Staged cloudflared version smoke test failed:`n$($tunnelVersion -join "`n")"
  }
}

Write-Output "Staged Bridge runtime at $outputRoot"
