# Simple PowerShell HTTP Server for NEURODRIVE
# Usage: .\serve.ps1

$port = 5173
$root = $PSScriptRoot

$mimeTypes = @{
  '.html' = 'text/html'
  '.css'  = 'text/css'
  '.js'   = 'application/javascript'
  '.json' = 'application/json'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.woff' = 'font/woff'
  '.woff2'= 'font/woff2'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()

Write-Host ""
Write-Host "  NEURODRIVE Dev Server" -ForegroundColor Magenta
Write-Host "  http://localhost:$port/" -ForegroundColor Cyan
Write-Host "  Press Ctrl+C to stop" -ForegroundColor Magenta
Write-Host ""

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response

    $urlPath = $request.Url.LocalPath
    if ($urlPath -eq '/') { $urlPath = '/index.html' }

    $filePath = Join-Path $root ($urlPath -replace '/', '\')

    if (Test-Path $filePath -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
      $contentType = $mimeTypes[$ext]
      if (-not $contentType) { $contentType = 'application/octet-stream' }

      if ($contentType -match '^text/' -or $contentType -eq 'application/javascript' -or $contentType -eq 'application/json') {
        $contentType += '; charset=utf-8'
      }

      $bytes = [System.IO.File]::ReadAllBytes($filePath)
      $response.ContentType = $contentType
      $response.ContentLength64 = $bytes.Length
      $response.StatusCode = 200
      $response.OutputStream.Write($bytes, 0, $bytes.Length)

      Write-Host "  200 $urlPath" -ForegroundColor Green
    } else {
      $response.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $urlPath")
      $response.ContentLength64 = $msg.Length
      $response.OutputStream.Write($msg, 0, $msg.Length)

      Write-Host "  404 $urlPath" -ForegroundColor Red
    }

    $response.OutputStream.Close()
  }
} finally {
  $listener.Stop()
}
