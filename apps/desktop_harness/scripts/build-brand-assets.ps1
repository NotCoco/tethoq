param(
  [string]$SourcePath = (Join-Path $PSScriptRoot "..\assets\tethoq-icon.png"),
  [string]$OutputRoot = (Join-Path $PSScriptRoot "..\build")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$source = [System.Drawing.Bitmap]::FromFile((Resolve-Path -LiteralPath $SourcePath))
try {
  if ($source.Width -ne 512 -or $source.Height -ne 512) {
    throw "The canonical Tethoq desktop mark must be exactly 512x512 pixels."
  }

  $iconDirectory = Join-Path $OutputRoot "icons"
  $installerDirectory = Join-Path $OutputRoot "installer"
  # Keep the notification-area mark clearer than the app icon without letting
  # its white glyph crowd the black tile at Windows' 16 px tray size.
  $trayContentScale = 1.25
  New-Item -ItemType Directory -Force -Path $iconDirectory, $installerDirectory | Out-Null

  function New-RoundedTethoqIcon {
    param(
      [Parameter(Mandatory = $true)][int]$Size,
      [double]$ContentScale = 1.0
    )
    $bitmap = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

      $inset = [Math]::Max(1, [int][Math]::Round($Size * 0.035))
      $diameter = $Size - ($inset * 2)
      $radius = [Math]::Max(2, [int][Math]::Round($Size * 0.21))
      $path = New-Object System.Drawing.Drawing2D.GraphicsPath
      try {
        $arc = $radius * 2
        $path.AddArc($inset, $inset, $arc, $arc, 180, 90)
        $path.AddArc($inset + $diameter - $arc, $inset, $arc, $arc, 270, 90)
        $path.AddArc($inset + $diameter - $arc, $inset + $diameter - $arc, $arc, $arc, 0, 90)
        $path.AddArc($inset, $inset + $diameter - $arc, $arc, $arc, 90, 90)
        $path.CloseFigure()
        $graphics.FillPath([System.Drawing.Brushes]::Black, $path)
        $graphics.SetClip($path)
        $contentSize = [int][Math]::Round($diameter * $ContentScale)
        $contentInset = [int][Math]::Round(($diameter - $contentSize) / 2)
        $graphics.DrawImage($source, $inset + $contentInset, $inset + $contentInset, $contentSize, $contentSize)
        $graphics.ResetClip()
      } finally {
        $path.Dispose()
      }
    } finally {
      $graphics.Dispose()
    }
    return $bitmap
  }

  $runtimeIcon = New-RoundedTethoqIcon -Size 512
  try {
    $runtimeIcon.Save((Join-Path $iconDirectory "tethoq.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $runtimeIcon.Dispose()
  }

  $trayIcon = New-RoundedTethoqIcon -Size 512 -ContentScale $trayContentScale
  try {
    $trayIcon.Save((Join-Path $iconDirectory "tethoq-tray.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $trayIcon.Dispose()
  }

  $sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
  $iconFrames = foreach ($size in $sizes) {
    $frame = New-RoundedTethoqIcon -Size $size
    try {
      $stream = New-Object System.IO.MemoryStream
      $frame.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      [pscustomobject]@{ Width = $size; Height = $size; Bytes = $stream.ToArray() }
      $stream.Dispose()
    } finally {
      $frame.Dispose()
    }
  }

  $trayIconFrames = foreach ($size in $sizes) {
    $frame = New-RoundedTethoqIcon -Size $size -ContentScale $trayContentScale
    try {
      $stream = New-Object System.IO.MemoryStream
      $frame.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      [pscustomobject]@{ Width = $size; Height = $size; Bytes = $stream.ToArray() }
      $stream.Dispose()
    } finally {
      $frame.Dispose()
    }
  }

  function Write-IconFile {
    param(
      [Parameter(Mandatory = $true)][string]$Path,
      [Parameter(Mandatory = $true)][object[]]$Frames
    )
    $file = [System.IO.File]::Create($Path)
    $writer = New-Object System.IO.BinaryWriter $file
    try {
      $writer.Write([uint16]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]$Frames.Count)
      $offset = 6 + (16 * $Frames.Count)
      foreach ($frame in $Frames) {
        $writer.Write([byte]($(if ($frame.Width -eq 256) { 0 } else { $frame.Width })))
        $writer.Write([byte]($(if ($frame.Height -eq 256) { 0 } else { $frame.Height })))
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$frame.Bytes.Length)
        $writer.Write([uint32]$offset)
        $offset += $frame.Bytes.Length
      }
      foreach ($frame in $Frames) { $writer.Write($frame.Bytes) }
    } finally {
      $writer.Dispose()
      $file.Dispose()
    }
  }

  Write-IconFile -Path (Join-Path $iconDirectory "tethoq.ico") -Frames $iconFrames
  Write-IconFile -Path (Join-Path $iconDirectory "tethoq-tray.ico") -Frames $trayIconFrames

  # Keep the development/runtime icon copies byte-identical to the resources
  # embedded by electron-builder so Windows never falls back to Electron's
  # executable icon while running an unpackaged window.
  $runtimeAssetsDirectory = Join-Path $PSScriptRoot "..\assets"
  Copy-Item -LiteralPath (Join-Path $iconDirectory "tethoq.ico") -Destination (Join-Path $runtimeAssetsDirectory "tethoq-icon.ico") -Force
  Copy-Item -LiteralPath (Join-Path $iconDirectory "tethoq-tray.ico") -Destination (Join-Path $runtimeAssetsDirectory "tethoq-tray.ico") -Force

  function Write-InstallerBitmap {
    param(
      [Parameter(Mandatory = $true)][string]$Path,
      [Parameter(Mandatory = $true)][int]$Width,
      [Parameter(Mandatory = $true)][int]$Height,
      [Parameter(Mandatory = $true)][int]$MarkSize,
      [Parameter(Mandatory = $true)][int]$MarkX,
      [Parameter(Mandatory = $true)][int]$MarkY
    )
    $bitmap = New-Object System.Drawing.Bitmap $Width, $Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::FromArgb(11, 11, 10))
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.DrawImage($source, $MarkX, $MarkY, $MarkSize, $MarkSize)
      } finally {
        $graphics.Dispose()
      }
      $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Bmp)
    } finally {
      $bitmap.Dispose()
    }
  }

  Write-InstallerBitmap -Path (Join-Path $installerDirectory "installer-header.bmp") -Width 150 -Height 57 -MarkSize 49 -MarkX 96 -MarkY 4
  Write-InstallerBitmap -Path (Join-Path $installerDirectory "installer-sidebar.bmp") -Width 164 -Height 314 -MarkSize 132 -MarkX 16 -MarkY 91
  Write-InstallerBitmap -Path (Join-Path $installerDirectory "uninstaller-sidebar.bmp") -Width 164 -Height 314 -MarkSize 132 -MarkX 16 -MarkY 91

  Write-Output "Built Tethoq Windows icon and installer artwork from $SourcePath"
} finally {
  $source.Dispose()
}
