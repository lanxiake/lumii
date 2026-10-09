param([string]$Path, [string]$Out = "$env:TEMP\wechat-ocr.txt", [int]$Scale = 0)
# Scale: upsample factor before OCR (0 = auto). Windows OCR reads small CJK badly at
# native size: in the WeChat session list at 1x it silently DROPS whole names
# (measured 2026-10-09: row "Yang Dong" came back as only its preview "who?", same for
# "Han Yu" and "Service account"). Not garbled - absent. find_session then thinks the
# peer is not in the visible list and falls back to the search overlay, which is what
# wrecks the UI. At 2x the names appear, at 3x "File Transfer Helper" comes out exact.
# Reported rects are divided back by Scale, so callers keep native coordinates.
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $t) { $m = $asTaskGeneric.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(-1)|Out-Null; $task.Result }
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()

# --- optional upsample. Never fatal: any failure here falls back to OCR at native size. ---
$src = $Path
$factor = 1
if ($Scale -ne 1) {
  try {
    Add-Type -AssemblyName System.Drawing
    $img = [System.Drawing.Image]::FromFile($Path)
    if ($Scale -le 0) {
      # Bounded on both sides: the engine rejects anything past MaxImageDimension,
      # and a huge bitmap costs wall-clock that the 30s MCP timeout budget cannot pay.
      $s = 3
      $lim = 10000
      try { $lim = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension } catch {}
      $byDim = [Math]::Floor($lim / [Math]::Max($img.Width, $img.Height))
      $byPx = [Math]::Floor([Math]::Sqrt(12000000.0 / ($img.Width * $img.Height)))
      $s = [Math]::Min(3, [Math]::Min($byDim, $byPx))
      if ($s -lt 1) { $s = 1 }
    } else {
      $s = $Scale
    }
    if ($s -gt 1) {
      $w = [int]($img.Width * $s); $h = [int]($img.Height * $s)
      $bmp = New-Object System.Drawing.Bitmap $w, $h
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.DrawImage($img, 0, 0, $w, $h)
      $src = Join-Path $env:TEMP "wechat-ocr-x$s.png"
      $bmp.Save($src, [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose(); $bmp.Dispose(); $factor = $s
    }
    $img.Dispose()
  } catch { $src = $Path; $factor = 1 }
}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($src)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = @()
foreach ($ln in $result.Lines) {
  $x0=99999;$y0=99999;$x1=-1;$y1=-1
  foreach ($w in $ln.Words) { $r=$w.BoundingRect
    if($r.X -lt $x0){$x0=$r.X}; if($r.Y -lt $y0){$y0=$r.Y}
    if(($r.X+$r.Width) -gt $x1){$x1=$r.X+$r.Width}; if(($r.Y+$r.Height) -gt $y1){$y1=$r.Y+$r.Height} }
  $lines += ("{0}`t{1}`t{2}`t{3}`t{4}" -f [int]($x0/$factor), [int]($y0/$factor), [int]($x1/$factor), [int]($y1/$factor), $ln.Text)
}
[System.IO.File]::WriteAllLines($Out, $lines, [System.Text.UTF8Encoding]::new($false))
if ($factor -gt 1) { Remove-Item -Force $src -ErrorAction SilentlyContinue }
Write-Output ("lines=" + $lines.Count + " scale=" + $factor)
