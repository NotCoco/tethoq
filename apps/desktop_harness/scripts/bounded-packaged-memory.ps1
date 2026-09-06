param(
  [Parameter(Mandatory = $true)]
  [string]$Executable,
  [int]$DurationMilliseconds = 3000,
  [int]$MainLimitMegabytes = 700,
  [int]$TreeLimitMegabytes = 1200,
  [string]$ProfileDirectory = "",
  [string]$ProviderSessionId = "",
  [int]$DebugPort = 9237
)

$ErrorActionPreference = "Stop"
$resolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")).Path
if (-not $resolvedExecutable.StartsWith($workspaceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "The packaged-memory gate only runs a Tethoq executable inside this workspace."
}

$existing = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -ieq "Tethoq.exe" -and $_.ExecutablePath -ieq $resolvedExecutable
}
if ($existing) {
  throw "The workspace Tethoq package is already running."
}

if ($ProfileDirectory) {
  $resolvedProfileDirectory = (Resolve-Path -LiteralPath $ProfileDirectory).Path
  $env:TETHOQ_STARTUP_PROFILE_PATH = Join-Path $resolvedProfileDirectory "bounded-codex-electron-startup.jsonl"
  $env:TETHOQ_ACTIVITY_PROFILE_PATH = Join-Path $resolvedProfileDirectory "bounded-codex-electron-activity.jsonl"
  $env:TETHOQ_OPENCODE_DB_PATH = Join-Path $resolvedProfileDirectory "intentionally-missing-opencode.db"
  $missingProvider = Join-Path $resolvedProfileDirectory "intentionally-missing-provider.exe"
  foreach ($name in @(
    "TETHOQ_GROK_COMMAND",
    "TETHOQ_QWEN_COMMAND",
    "TETHOQ_GOOSE_COMMAND",
    "TETHOQ_KIMI_COMMAND",
    "TETHOQ_HERMES_COMMAND",
    "TETHOQ_CLINE_COMMAND",
    "TETHOQ_COPILOT_COMMAND",
    "TETHOQ_PI_COMMAND",
    "TETHOQ_OMP_COMMAND"
  )) {
    Set-Item -Path "Env:$name" -Value $missingProvider
  }
}
$env:TETHOQ_OPENCODE_URL = "http://127.0.0.1:9/"

$launchArguments = @("--hidden")
if ($ProviderSessionId) {
  if ($ProviderSessionId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
    throw "ProviderSessionId must be a Codex UUID."
  }
  if ($DebugPort -lt 1024 -or $DebugPort -gt 65535) {
    throw "DebugPort must be between 1024 and 65535."
  }
  $launchArguments += "--remote-debugging-port=$DebugPort"
}

$root = Start-Process -FilePath $resolvedExecutable -ArgumentList $launchArguments -WindowStyle Hidden -PassThru
$ownedPids = [System.Collections.Generic.HashSet[int]]::new()
[void]$ownedPids.Add($root.Id)
$historyHelper = $null
$historyHelperOutput = $null
$historyHelperError = $null
if ($ProviderSessionId) {
  $historyHelperScript = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "debug-history-pages.cjs"))
  if (-not $historyHelperScript.StartsWith($workspaceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The history helper must stay inside the workspace."
  }
  $historyHelperOutput = Join-Path ([System.IO.Path]::GetTempPath()) "tethoq-bounded-history-$($root.Id).json"
  $historyHelperError = Join-Path ([System.IO.Path]::GetTempPath()) "tethoq-bounded-history-$($root.Id).err"
  $historyHelper = Start-Process -FilePath "node.exe" `
    -ArgumentList @($historyHelperScript, $ProviderSessionId, [string]$DebugPort, "1") `
    -WorkingDirectory $workspaceRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $historyHelperOutput `
    -RedirectStandardError $historyHelperError `
    -PassThru
}

function Update-OwnedProcessTree {
  $processes = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -ieq "Tethoq.exe" -and $_.ExecutablePath -ieq $resolvedExecutable
  })
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($process in $processes) {
      if ($ownedPids.Contains([int]$process.ParentProcessId) -and $ownedPids.Add([int]$process.ProcessId)) {
        $changed = $true
      }
    }
  }
}

$peakMainBytes = 0L
$peakTreeBytes = 0L
$tripped = $false
$samples = @()
$deadline = [DateTime]::UtcNow.AddMilliseconds($DurationMilliseconds)

try {
  while ([DateTime]::UtcNow -lt $deadline -and -not $root.HasExited) {
    Update-OwnedProcessTree
    $processes = @(Get-CimInstance Win32_Process | Where-Object {
      $ownedPids.Contains([int]$_.ProcessId)
    })
    $main = Get-Process -Id $root.Id -ErrorAction SilentlyContinue
    $mainBytes = if ($main) { [long]$main.WorkingSet64 } else { 0L }
    $treeBytes = 0L
    foreach ($process in $processes) {
      $child = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
      if ($child) { $treeBytes += [long]$child.WorkingSet64 }
    }
    $peakMainBytes = [Math]::Max($peakMainBytes, $mainBytes)
    $peakTreeBytes = [Math]::Max($peakTreeBytes, $treeBytes)
    $samples += [pscustomobject]@{
      mainMB = [Math]::Round($mainBytes / 1MB, 1)
      treeMB = [Math]::Round($treeBytes / 1MB, 1)
    }
    if ($mainBytes -gt ($MainLimitMegabytes * 1MB) -or $treeBytes -gt ($TreeLimitMegabytes * 1MB)) {
      $tripped = $true
      break
    }
    Start-Sleep -Milliseconds 250
  }
} finally {
  $quit = Start-Process -FilePath $resolvedExecutable -ArgumentList "--quit-other" -WindowStyle Hidden -PassThru
  [void]$quit.WaitForExit(5000)
  [void]$root.WaitForExit(5000)
  if ($historyHelper -and -not $historyHelper.HasExited) {
    [void]$historyHelper.WaitForExit(2000)
  }
  if ($historyHelper -and -not $historyHelper.HasExited) {
    Stop-Process -Id $historyHelper.Id -Force -ErrorAction SilentlyContinue
  }
  Update-OwnedProcessTree
  foreach ($ownedPid in @($ownedPids)) {
    Stop-Process -Id $ownedPid -Force -ErrorAction SilentlyContinue
  }
}

$historyHelperExitCode = if ($historyHelper -and $historyHelper.HasExited) { $historyHelper.ExitCode } else { $null }
foreach ($temporaryPath in @($historyHelperOutput, $historyHelperError)) {
  if ($temporaryPath -and (Test-Path -LiteralPath $temporaryPath -PathType Leaf)) {
    Remove-Item -LiteralPath $temporaryPath -Force
  }
}

[pscustomobject]@{
  rootPid = $root.Id
  targetedHistory = [bool]$ProviderSessionId
  historyHelperExitCode = $historyHelperExitCode
  tripped = $tripped
  peakMainMB = [Math]::Round($peakMainBytes / 1MB, 1)
  peakTreeMB = [Math]::Round($peakTreeBytes / 1MB, 1)
  sampleCount = $samples.Count
  exited = $root.HasExited
  lastSamples = @($samples | Select-Object -Last 6)
} | ConvertTo-Json -Depth 4 -Compress
