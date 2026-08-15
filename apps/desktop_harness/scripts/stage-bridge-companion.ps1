[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$desktopRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$companionRoot = [System.IO.Path]::GetFullPath((Join-Path $desktopRoot '..\desktop_companion'))
$buildRoot = Join-Path $desktopRoot 'build'
$outputRoot = Join-Path $buildRoot 'bridge-companion'
$stageRoot = Join-Path $buildRoot '.bridge-companion-package'
$runtimeManifest = Join-Path $companionRoot 'build\bridge-runtime\runtime-manifest.json'
$electronBuilder = Join-Path $companionRoot 'node_modules\.bin\electron-builder.cmd'

function Assert-BuildChild([string]$Candidate, [string]$Label) {
  $candidateFull = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\')
  $buildFull = [System.IO.Path]::GetFullPath($buildRoot).TrimEnd('\')
  if (-not $candidateFull.StartsWith("$buildFull\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must stay inside $buildFull"
  }
}

foreach ($candidate in @($outputRoot, $stageRoot)) {
  Assert-BuildChild $candidate 'Bridge companion staging path'
  if (Test-Path -LiteralPath $candidate) {
    Remove-Item -LiteralPath $candidate -Recurse -Force
  }
}

if (-not (Test-Path -LiteralPath $runtimeManifest -PathType Leaf)) {
  throw 'The staged Bridge runtime is missing. Run npm run package:bridge before staging the Desktop companion.'
}
if (-not (Test-Path -LiteralPath $electronBuilder -PathType Leaf)) {
  throw 'The pinned Bridge companion dependencies are missing. Run npm ci in apps\desktop_companion before staging it.'
}

New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
Push-Location $companionRoot
try {
  & $electronBuilder --dir --win --x64 --publish never "--config.directories.output=$stageRoot"
  if ($LASTEXITCODE -ne 0) { throw 'Bridge companion directory packaging failed.' }
} finally {
  Pop-Location
}

$unpackedRoot = Join-Path $stageRoot 'win-unpacked'
$companionExecutable = Join-Path $unpackedRoot 'Tethoq Bridge.exe'
$companionAsar = Join-Path $unpackedRoot 'resources\app.asar'
$packagedRuntime = Join-Path $unpackedRoot 'resources\bridge\runtime-manifest.json'
foreach ($required in @($companionExecutable, $companionAsar, $packagedRuntime)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Packaged Bridge companion is missing $required"
  }
}

& node.exe (Join-Path $companionRoot 'scripts\packaged-runtime-smoke.cjs') $unpackedRoot
if ($LASTEXITCODE -ne 0) { throw 'Packaged Bridge companion runtime smoke test failed.' }

Move-Item -LiteralPath $unpackedRoot -Destination $outputRoot
Remove-Item -LiteralPath $stageRoot -Recurse -Force
Write-Output "Staged the independently launchable Bridge companion at $outputRoot"
