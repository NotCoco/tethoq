[CmdletBinding()]
param(
  [string]$OutputDirectory,
  [switch]$SkipBuild,
  [switch]$SkipSmokeTest
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$destination = if ($OutputDirectory) {
  [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
  Join-Path (Split-Path -Parent $PSScriptRoot) 'build\bridge-runtime'
}

& (Join-Path $repoRoot 'scripts\release\stage-bridge-runtime.ps1') `
  -OutputDirectory $destination `
  -SkipBuild:$SkipBuild `
  -SkipSmokeTest:$SkipSmokeTest
if ($LASTEXITCODE -ne 0) { throw 'Bridge runtime staging failed.' }
