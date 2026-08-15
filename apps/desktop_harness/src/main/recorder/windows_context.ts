import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ForegroundContext, Point, RecorderContextProvider } from "./types.js";

const execFileAsync = promisify(execFile);
const WINDOWS_CONTEXT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class TethoqForegroundWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int length);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@
$handle = [TethoqForegroundWindow]::GetForegroundWindow()
$pidValue = [uint32]0
[void][TethoqForegroundWindow]::GetWindowThreadProcessId($handle, [ref]$pidValue)
$length = [TethoqForegroundWindow]::GetWindowTextLength($handle)
$title = New-Object System.Text.StringBuilder ($length + 1)
[void][TethoqForegroundWindow]::GetWindowText($handle, $title, $length + 1)
$rect = New-Object TethoqForegroundWindow+RECT
[void][TethoqForegroundWindow]::GetWindowRect($handle, [ref]$rect)
$process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
$focusedIsPassword = $false
if ($null -ne $focused) { try { $focusedIsPassword = [bool]$focused.Current.IsPassword } catch {} }
$cursorElement = $null
if ($env:TETHOQ_CURSOR_X -and $env:TETHOQ_CURSOR_Y) {
  try {
    $point = New-Object System.Windows.Point([double]$env:TETHOQ_CURSOR_X, [double]$env:TETHOQ_CURSOR_Y)
    $element = [System.Windows.Automation.AutomationElement]::FromPoint($point)
    if ($null -ne $element) {
      $current = $element.Current
      $elementRect = $current.BoundingRectangle
      $cursorElement = [ordered]@{
        name = $current.Name
        automationId = $current.AutomationId
        controlType = $current.ControlType.ProgrammaticName
        isEnabled = $current.IsEnabled
        isPassword = $current.IsPassword
        bounds = [ordered]@{ x = [int]$elementRect.X; y = [int]$elementRect.Y; width = [int]$elementRect.Width; height = [int]$elementRect.Height }
      }
    }
  } catch {}
}
$result = [ordered]@{
  appName = if ($null -ne $process) { $process.ProcessName } else { $null }
  processId = [int]$pidValue
  processPath = if ($null -ne $process) { try { $process.Path } catch { $null } } else { $null }
  windowTitle = $title.ToString()
  windowId = ('0x{0:X}' -f $handle.ToInt64())
  bounds = [ordered]@{ x = $rect.Left; y = $rect.Top; width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top) }
  focusedIsPassword = $focusedIsPassword
  cursorElement = $cursorElement
  source = 'windows'
}
$result | ConvertTo-Json -Depth 6 -Compress
`;

export interface WindowsContextOptions {
  readonly timeoutMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly exec?: typeof execFileAsync;
  readonly cacheMs?: number;
}

/**
 * Queries foreground/window/UI Automation metadata only for meaningful input
 * events. No helper process remains alive while the recorder is idle.
 */
export function createWindowsContextProvider(cursor: () => Point | undefined, options: WindowsContextOptions = {}): RecorderContextProvider {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 1_500;
  const execute = options.exec ?? execFileAsync;
  const cacheMs = options.cacheMs ?? 120;
  let cached: { readonly at: number; readonly cursor: Point | undefined; readonly value: ForegroundContext | undefined } | undefined;
  let inFlight: Promise<ForegroundContext | undefined> | undefined;
  return async (): Promise<ForegroundContext | undefined> => {
    if (platform !== "win32") return undefined;
    const point = cursor();
    const now = Date.now();
    if (cached !== undefined && now - cached.at <= cacheMs && samePoint(cached.cursor, point)) return cached.value;
    if (inFlight !== undefined) return await inFlight;
    inFlight = query(point).finally(() => { inFlight = undefined; });
    return await inFlight;
  };

  async function query(point: Point | undefined): Promise<ForegroundContext | undefined> {
    const env = {
      ...process.env,
      ...(point === undefined ? {} : { TETHOQ_CURSOR_X: String(point.x), TETHOQ_CURSOR_Y: String(point.y) }),
    };
    const { stdout } = await execute("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_CONTEXT_SCRIPT,
    ], { timeout: timeoutMs, windowsHide: true, env, maxBuffer: 64 * 1_024 });
    const parsed = JSON.parse(stdout.trim()) as ForegroundContext;
    cached = { at: Date.now(), cursor: point, value: parsed };
    return parsed;
  }
}

function samePoint(left: Point | undefined, right: Point | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined && left.x === right.x && left.y === right.y);
}

export function mergeForegroundContext(nativeContext: ForegroundContext | undefined, provided: ForegroundContext | undefined, timestamp: { wallTime: string; wallTimeMs: number }): ForegroundContext | undefined {
  if (nativeContext === undefined && provided === undefined) return undefined;
  return {
    ...nativeContext,
    ...provided,
    ...(provided?.browser === undefined ? {} : { browser: provided.browser }),
    observedAt: timestamp.wallTime,
    observedWallTimeMs: timestamp.wallTimeMs,
    source: nativeContext !== undefined && provided !== undefined ? "merged" : (provided?.source ?? nativeContext?.source ?? "provider"),
  };
}
