param(
    [string]$IconSource = "$PSScriptRoot\..\assets\icon.png",
    [string]$LinkPath = "$PSScriptRoot\..\ModelDock.lnk"
)
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$batPath = Join-Path $PSScriptRoot "dashboard.bat"
$icoPath = Join-Path $root "assets\icon.ico"

Add-Type -AssemblyName System.Drawing

function New-MultiSizeIco {
    param(
        [string]$PngPath,
        [string]$IcoPath,
        [int[]]$Sizes = @(256, 48, 32, 16)
    )

    $src = [System.Drawing.Bitmap]::new($PngPath)
    $images = @()
    try {
        foreach ($s in $Sizes) {
            $bmp = [System.Drawing.Bitmap]::new($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.SmoothingMode = "HighSpeed"
            $g.DrawImage($src, 0, 0, $s, $s)
            $g.Dispose()
            $images += $bmp
        }

        $mem = [System.IO.MemoryStream]::new()
        $bw = [System.IO.BinaryWriter]::new($mem)

        $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$images.Count)

        $offset = 6 + 16 * $images.Count
        foreach ($im in $images) {
            $d = [byte]($im.Width -band 0xFF)
            if ($im.Width -ge 256) { $d = 0 }
            $bw.Write($d); $bw.Write($d)
            $bw.Write([byte]0); $bw.Write([byte]0)
            $bw.Write([uint16]1)
            $bw.Write([uint16]32)
            $bw.Write([uint32](40 + 4 * $im.Width * $im.Height))
            $bw.Write([uint32]$offset)
            $offset += 40 + 4 * $im.Width * $im.Height
        }

        foreach ($im in $images) {
            $size = $im.Width; $stride = 4 * $size
            $bw.Write([uint32]40)
            $bw.Write([int32]$size); $bw.Write([int32]$size)
            $bw.Write([uint16]1); $bw.Write([uint16]32)
            $bw.Write([uint32]0)
            $bw.Write([uint32]$stride * $size)
            $bw.Write([int32]0); $bw.Write([int32]0)
            $bw.Write([uint32]0); $bw.Write([uint32]0)
            for ($y = $size - 1; $y -ge 0; $y--) {
                for ($x = 0; $x -lt $size; $x++) {
                    $c = $im.GetPixel($x, $y)
                    $bw.Write([byte]$c.B); $bw.Write([byte]$c.G); $bw.Write([byte]$c.R); $bw.Write([byte]$c.A)
                }
            }
        }

        $bw.Flush(); $bw.Dispose()
        [System.IO.File]::WriteAllBytes($IcoPath, $mem.ToArray())
        $mem.Dispose()
    }
    finally {
        $src.Dispose()
        foreach ($im in $images) { $im.Dispose() }
    }
}

New-MultiSizeIco -PngPath $IconSource -IcoPath $icoPath
Write-Host "Icon written to $icoPath"

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($LinkPath)
$lnk.TargetPath = $batPath
$lnk.WorkingDirectory = $root
$lnk.IconLocation = "$icoPath, 0"
$lnk.WindowStyle = 7
$lnk.Description = "ModelDock API Bridge dashboard"
$lnk.Save()
Write-Host "Shortcut written to $LinkPath"