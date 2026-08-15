param(
  [string]$SourcePath = (Join-Path $PSScriptRoot "..\src\assets\tethoq-bridge.png"),
  [string]$OutputRoot = (Join-Path $PSScriptRoot "..\build")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$source = [System.Drawing.Bitmap]::FromFile((Resolve-Path -LiteralPath $SourcePath))
try {
  if ($source.Width -ne 512 -or $source.Height -ne 512) {
    throw "The Tethoq Bridge connector mark must be exactly 512x512 pixels."
  }

  $installerDirectory = Join-Path $OutputRoot "installer"
  New-Item -ItemType Directory -Force -Path $installerDirectory | Out-Null

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
        $graphics.Clear([System.Drawing.Color]::FromArgb(242, 243, 242))
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

  Write-InstallerBitmap -Path (Join-Path $installerDirectory "installer-header.bmp") -Width 150 -Height 57 -MarkSize 43 -MarkX 101 -MarkY 7
  Write-InstallerBitmap -Path (Join-Path $installerDirectory "installer-sidebar.bmp") -Width 164 -Height 314 -MarkSize 112 -MarkX 26 -MarkY 101
  Write-InstallerBitmap -Path (Join-Path $installerDirectory "uninstaller-sidebar.bmp") -Width 164 -Height 314 -MarkSize 112 -MarkX 26 -MarkY 101

  Write-Output "Built lightweight Tethoq Bridge installer artwork from $SourcePath"
} finally {
  $source.Dispose()
}
