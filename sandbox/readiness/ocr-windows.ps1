# Read one image with the Windows OCR engine. Prints one JSON object. No network.
param([Parameter(Mandatory = $true)][string]$ImagePath)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ImagePath)) {
  Write-Output '{"ok":false,"error":"file missing"}'
  exit 2
}
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await-WinRt($op, $type) {
  $method = $asTaskGeneric.MakeGenericMethod($type)
  $task = $method.Invoke($null, @($op))
  $task.Wait() | Out-Null
  if ($task.IsFaulted) { throw $task.Exception.InnerException }
  return $task.Result
}
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
try {
  $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path -LiteralPath $ImagePath).Path)) ([Windows.Storage.StorageFile])
  $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en'))
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) {
    Write-Output '{"ok":false,"error":"no Windows OCR language"}'
    exit 3
  }
  $result = Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $payload = @{ ok = $true; engine = 'windows-media-ocr'; text = [string]$result.Text }
  Write-Output ($payload | ConvertTo-Json -Compress)
} catch {
  $msg = ($_.Exception.Message -replace '[\r\n"]', ' ').Trim()
  Write-Output ('{"ok":false,"error":"' + $msg + '"}')
  exit 4
}
