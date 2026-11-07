# Generate Windows ICO from graphite Q/waveform icon traced from the user's supplied PNG.
# The SVG retains the supplied Q silhouette and five waveform bars.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root "assets\quickcue-graphite.png"
$target = Join-Path $root "assets\quickcue-graphite.ico"
if (-not (Test-Path -LiteralPath $source)) { throw "Missing rendered QuickCue graphite PNG" }

$image = [System.Drawing.Image]::FromFile($source)
try {
    if ($image.Width -ne 1024 -or $image.Height -ne 1024) {
        throw "Expected 1024x1024 graphite PNG"
    }
    [int[]]$sizes = @(16, 24, 32, 48, 64, 128, 256)
    $buffers = @()
    foreach ($size in $sizes) {
        $bitmap = [System.Drawing.Bitmap]::new($size, $size)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $stream = [System.IO.MemoryStream]::new()
        try {
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.DrawImage($image, 0, 0, $size, $size)
            $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
            $buffers += ,($stream.ToArray())
        } finally {
            $graphics.Dispose()
            $bitmap.Dispose()
            $stream.Dispose()
        }
    }
    $file = [System.IO.File]::Open($target, [System.IO.FileMode]::Create)
    $writer = [System.IO.BinaryWriter]::new($file)
    try {
        $writer.Write([UInt16]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]$sizes.Length)
        $offset = 6 + 16 * $sizes.Length
        for ($i=0; $i -lt $sizes.Length; $i++) {
            $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
            $writer.Write([byte]$dimension)
            $writer.Write([byte]$dimension)
            $writer.Write([byte]0)
            $writer.Write([byte]0)
            $writer.Write([UInt16]1)
            $writer.Write([UInt16]32)
            $writer.Write([UInt32]$buffers[$i].Length)
            $writer.Write([UInt32]$offset)
            $offset += $buffers[$i].Length
        }
        foreach ($png in $buffers) { $writer.Write([byte[]]$png) }
    } finally {
        $writer.Dispose()
        $file.Dispose()
    }
    $bytes = [System.IO.File]::ReadAllBytes($target)
    if ($bytes.Length -lt 10000) { throw "Generated ICO unexpectedly small" }
    Write-Host "QuickCue Windows ICO: $($sizes -join ', ') px; $($bytes.Length) bytes"
} finally {
    $image.Dispose()
}
