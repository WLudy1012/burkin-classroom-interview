$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$releaseRoot = Join-Path $projectRoot 'release'
$target = Join-Path $releaseRoot "布尔金课堂访谈 WebUI $version"
$archive = Join-Path $releaseRoot "布尔金课堂访谈 WebUI $version.zip"
$nodePath = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = & $nodePath --version
if ($nodeVersion -notmatch '^v\d+\.\d+\.\d+$') { throw '无法识别打包机的 Node.js 版本。' }
if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\ws\package.json'))) { throw '请先执行 npm ci。' }

New-Item -ItemType Directory -Path $target, (Join-Path $target 'web'), (Join-Path $target 'desktop\runtime'), (Join-Path $target 'desktop\renderer'), (Join-Path $target 'desktop\assets'), (Join-Path $target 'node_modules\ws') -Force | Out-Null
Copy-Item -LiteralPath $nodePath -Destination (Join-Path $target 'node.exe') -Force
$nodeLicense = Join-Path $target 'LICENSE-node.txt'
if ($nodeVersion -eq 'v24.13.0') {
  Copy-Item -LiteralPath (Join-Path $projectRoot 'web\LICENSE-node.txt') -Destination $nodeLicense -Force
} else {
  Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE" -OutFile $nodeLicense
}
Copy-Item -LiteralPath (Join-Path $projectRoot '启动WebUI.cmd') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'WEBUI-README.txt') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json') -Destination $target -Force
Copy-Item -Path (Join-Path $projectRoot 'node_modules\ws\*') -Destination (Join-Path $target 'node_modules\ws') -Recurse -Force

foreach ($name in @('server.cjs', 'start.cjs', 'web-bridge.js')) {
  Copy-Item -LiteralPath (Join-Path $projectRoot "web\$name") -Destination (Join-Path $target 'web') -Force
}
foreach ($name in @('endpoint.cjs', 'facts.cjs', 'index.cjs', 'persona.txt', 'qwen.cjs', 'voice-clone.cjs')) {
  Copy-Item -LiteralPath (Join-Path $projectRoot "desktop\runtime\$name") -Destination (Join-Path $target 'desktop\runtime') -Force
}
foreach ($name in @('index.html', 'app.js', 'styles.css')) {
  Copy-Item -LiteralPath (Join-Path $projectRoot "desktop\renderer\$name") -Destination (Join-Path $target 'desktop\renderer') -Force
}
Get-ChildItem -LiteralPath (Join-Path $projectRoot 'desktop\assets') -Filter '*.webp' | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $target 'desktop\assets') -Force
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'desktop\assets\icon.ico') -Destination (Join-Path $target 'desktop\assets') -Force
Compress-Archive -Path (Join-Path $target '*') -DestinationPath $archive -CompressionLevel Optimal -Force
Write-Output $archive
