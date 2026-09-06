<#
.SYNOPSIS
Renders optional promotional captures using Python, FFmpeg with NVIDIA NVENC,
and a caller-supplied fractional_affine_zoom.py helper. These media tools are
not required to build or run Tethoq.
#>
param(
  [string]$CaptureDirectory = (Join-Path $PSScriptRoot '..\qa-artifacts\promo-media-v9'),
  [Parameter(Mandatory = $true)]
  [string]$ZoomScript
)

$ErrorActionPreference = 'Stop'

$capture = (Resolve-Path -LiteralPath $CaptureDirectory).Path
$frameDirectory = Join-Path $capture 'mesh-frames'
$intermediateDirectory = Join-Path $capture 'render-intermediates'
$finalDirectory = Join-Path $capture 'final'
$qaDirectory = Join-Path $capture 'qa'
$zoomScript = (Resolve-Path -LiteralPath $ZoomScript).Path
$ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source
$python = (Get-Command python -ErrorAction Stop).Source

foreach ($directory in @($intermediateDirectory, $finalDirectory, $qaDirectory)) {
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

function Invoke-Checked {
  param(
    [string]$Program,
    [string[]]$Arguments,
    [string]$Label
  )
  Write-Host $Label
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE"
  }
}

function New-LosslessSegment {
  param(
    [int]$StartFrame,
    [int]$EndFrame,
    [string]$Output
  )
  $filter = "trim=start_frame=$StartFrame`:end_frame=$EndFrame,setpts=PTS-STARTPTS,fps=30,setsar=1"
  Invoke-Checked $ffmpeg @(
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', $script:meshRaw,
    '-vf', $filter,
    '-an', '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'yuv444p',
    $Output
  ) "Extract Mesh frames $StartFrame-$($EndFrame - 1)"
}

function New-FractionalZoom {
  param(
    [string]$InputPath,
    [string]$OutputPath,
    [string]$Duration,
    [string]$StartZoom,
    [string]$EndZoom,
    [string]$StartFocusX,
    [string]$StartFocusY,
    [string]$EndFocusX,
    [string]$EndFocusY
  )
  $curve = [IO.Path]::ChangeExtension($OutputPath, '.zoom.csv')
  Invoke-Checked $python @(
    $zoomScript, $InputPath, $OutputPath,
    '--duration', $Duration,
    '--fps', '30', '--width', '1920', '--height', '1080',
    '--start-zoom', $StartZoom, '--end-zoom', $EndZoom,
    '--focus-x', $StartFocusX, '--focus-y', $StartFocusY,
    '--end-focus-x', $EndFocusX, '--end-focus-y', $EndFocusY,
    '--encoder', 'h264_nvenc', '--preset', 'p6', '--cq', '17',
    '--curve-csv', $curve
  ) "Render fractional camera move: $([IO.Path]::GetFileName($OutputPath))"
}

$meshRaw = Join-Path $intermediateDirectory 'mesh-raw-lossless.mp4'
Invoke-Checked $ffmpeg @(
  '-hide_banner', '-loglevel', 'error', '-y',
  '-framerate', '30', '-start_number', '0',
  '-i', (Join-Path $frameDirectory 'frame-%06d.png'),
  '-frames:v', '259', '-an',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0', '-pix_fmt', 'yuv444p',
  '-movflags', '+faststart', $meshRaw
) 'Build lossless 30 fps Mesh source'

$meshSources = 1..5 | ForEach-Object { Join-Path $intermediateDirectory ("mesh-source-{0:d2}.mkv" -f $_) }
$meshMoves = 1..5 | ForEach-Object { Join-Path $intermediateDirectory ("mesh-camera-{0:d2}.mp4" -f $_) }

New-LosslessSegment 0 15 $meshSources[0]
New-LosslessSegment 15 60 $meshSources[1]
New-LosslessSegment 60 126 $meshSources[2]
New-LosslessSegment 126 202 $meshSources[3]
New-LosslessSegment 202 259 $meshSources[4]

New-FractionalZoom $meshSources[0] $meshMoves[0] '0.5' '1.0' '1.0' '0.5' '0.5' '0.5' '0.5'
New-FractionalZoom $meshSources[1] $meshMoves[1] '1.5' '1.0' '1.18' '0.5' '0.5' '0.72' '0.88'
New-FractionalZoom $meshSources[2] $meshMoves[2] '2.2' '1.18' '1.18' '0.72' '0.88' '0.72' '0.88'
New-FractionalZoom $meshSources[3] $meshMoves[3] '2.533333333333' '1.18' '1.08' '0.72' '0.88' '0.66' '0.44'
New-FractionalZoom $meshSources[4] $meshMoves[4] '1.9' '1.08' '1.0' '0.66' '0.44' '0.5' '0.5'

$meshEdited = Join-Path $intermediateDirectory 'mesh-edited.mp4'
$meshConcat = '[0:v]fps=30,settb=AVTB,setpts=PTS-STARTPTS[v0];[1:v]fps=30,settb=AVTB,setpts=PTS-STARTPTS[v1];[2:v]fps=30,settb=AVTB,setpts=PTS-STARTPTS[v2];[3:v]fps=30,settb=AVTB,setpts=PTS-STARTPTS[v3];[4:v]fps=30,settb=AVTB,setpts=PTS-STARTPTS[v4];[v0][v1][v2][v3][v4]concat=n=5:v=1:a=0[v]'
Invoke-Checked $ffmpeg @(
  '-hide_banner', '-loglevel', 'error', '-y',
  '-i', $meshMoves[0], '-i', $meshMoves[1], '-i', $meshMoves[2], '-i', $meshMoves[3], '-i', $meshMoves[4],
  '-filter_complex', $meshConcat, '-map', '[v]', '-frames:v', '259', '-an',
  '-c:v', 'h264_nvenc', '-preset', 'p6', '-cq', '17', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', $meshEdited
) 'Assemble the edited Mesh journey'

$dashboardMove = Join-Path $intermediateDirectory 'dashboard-camera.mp4'
$liveMove = Join-Path $intermediateDirectory 'live-camera.mp4'
$eyesMove = Join-Path $intermediateDirectory 'eyes-camera.mp4'
New-FractionalZoom (Join-Path $capture '01-dashboard.png') $dashboardMove '3.0' '1.0' '1.035' '0.62' '0.48' '0.62' '0.48'
New-FractionalZoom (Join-Path $capture '02-live-workspace.png') $liveMove '2.7' '1.0' '1.035' '0.66' '0.52' '0.66' '0.52'
New-FractionalZoom (Join-Path $capture '04-eyes-confirmed.png') $eyesMove '3.8' '1.0' '1.04' '0.66' '0.36' '0.66' '0.36'

$twitter = Join-Path $finalDirectory 'Tethoq-Twitter-promo-silent.mp4'
$twitterFilter = '[0:v]fps=30,settb=AVTB,setpts=PTS-STARTPTS[v0];[1:v]fps=30,settb=AVTB,setpts=PTS-STARTPTS[v1];[2:v]fps=30,settb=AVTB,setpts=PTS-STARTPTS[v2];[3:v]fps=30,settb=AVTB,setpts=PTS-STARTPTS[v3];[v0][v1]xfade=transition=fade:duration=0.2:offset=2.8[x1];[x1][v2]xfade=transition=fade:duration=0.2:offset=5.3[x2];[x2][v3]xfade=transition=fade:duration=0.2:offset=13.733333333333[v]'
Invoke-Checked $ffmpeg @(
  '-hide_banner', '-loglevel', 'error', '-y',
  '-i', $dashboardMove, '-i', $liveMove, '-i', $meshEdited, '-i', $eyesMove,
  '-filter_complex', $twitterFilter, '-map', '[v]', '-frames:v', '526', '-an',
  '-c:v', 'h264_nvenc', '-preset', 'p6', '-cq', '18', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', $twitter
) 'Render silent Twitter promo'

$palette = Join-Path $intermediateDirectory 'github-mesh-palette.png'
$github = Join-Path $finalDirectory 'Tethoq-GitHub-mesh-demo.gif'
Invoke-Checked $ffmpeg @(
  '-hide_banner', '-loglevel', 'error', '-y', '-i', $meshEdited,
  '-vf', 'fps=15,scale=960:540:flags=lanczos,palettegen=max_colors=128:stats_mode=diff',
  '-frames:v', '1', '-update', '1', $palette
) 'Generate the GitHub GIF palette'
Invoke-Checked $ffmpeg @(
  '-hide_banner', '-loglevel', 'error', '-y', '-i', $meshEdited, '-i', $palette,
  '-filter_complex', '[0:v]fps=15,scale=960:540:flags=lanczos[v];[v][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
  '-loop', '0', $github
) 'Render the GitHub GIF'

Invoke-Checked $ffmpeg @(
  '-hide_banner', '-loglevel', 'error', '-y', '-i', $twitter,
  '-vf', 'fps=0.666666666667,scale=480:270:flags=lanczos,tile=4x3:padding=4:margin=4:color=black',
  '-frames:v', '1', '-update', '1', (Join-Path $qaDirectory 'twitter-contact-sheet.png')
) 'Build the Twitter contact sheet'
Invoke-Checked $ffmpeg @(
  '-hide_banner', '-loglevel', 'error', '-y', '-i', $github,
  '-vf', 'fps=1,scale=480:270:flags=lanczos,tile=3x3:padding=4:margin=4:color=black',
  '-frames:v', '1', '-update', '1', (Join-Path $qaDirectory 'github-contact-sheet.png')
) 'Build the GitHub GIF contact sheet'
Invoke-Checked $ffmpeg @(
  '-hide_banner', '-loglevel', 'error', '-y', '-i', $meshEdited,
  '-vf', 'trim=start_frame=31:end_frame=43,setpts=PTS-STARTPTS,scale=480:270:flags=lanczos,tile=4x3:padding=4:margin=4:color=black',
  '-frames:v', '1', '-update', '1', (Join-Path $qaDirectory 'fastest-zoom-12-consecutive-frames.png')
) 'Build the consecutive-frame zoom sheet'

[pscustomobject]@{
  Twitter = $twitter
  GitHub = $github
  Mesh = $meshEdited
  Screenshots = 4
} | Format-List
