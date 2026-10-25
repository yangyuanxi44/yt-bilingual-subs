# 打包可安装的扩展 zip（只含运行所需文件）
# 注意：必须使用标准 zip 路径分隔符 "/"，否则部分解压/安装工具会把 "src\content\bridge.js"
# 当成一个文件名（字符被替换），导致 Edge/Chrome 报「无法为脚本加载 JavaScript」。
# 用法：powershell -ExecutionPolicy Bypass -File scripts/pack.ps1 [-Out dist/yt-bilingual-subs.zip]
param(
  [string]$Out = "dist/yt-bilingual-subs.zip"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$outPath = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $root $Out }

$required = @(
  "manifest.json", "src/background.js", "src/lib/core.js", "src/lib/translate.js",
  "src/content/bridge.js", "src/content/main.js", "src/content/ui.js",
  "src/content/styles.css", "src/content/page.css",
  "src/popup/popup.html", "src/options/options.html",
  "src/assets/icons/icon16.png", "src/assets/icons/icon32.png",
  "src/assets/icons/icon48.png", "src/assets/icons/icon128.png"
)
foreach ($rel in $required) {
  if (-not (Test-Path (Join-Path $root $rel))) { throw "缺少打包所需文件: $rel" }
}

# 收集文件：源码所有文件 + manifest + README + LICENSE + NOTICE
$files = @(
  @{ Abs = Join-Path $root "manifest.json"; Entry = "manifest.json" },
  @{ Abs = Join-Path $root "README.md"; Entry = "README.md" },
  @{ Abs = Join-Path $root "LICENSE"; Entry = "LICENSE" },
  @{ Abs = Join-Path $root "NOTICE.md"; Entry = "NOTICE.md" }
)
Get-ChildItem (Join-Path $root "src") -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($root.Length + 1).Replace("\", "/")
  $files += @{ Abs = $_.FullName; Entry = $rel }
}

$outDir = Split-Path -Parent $outPath
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
if (Test-Path $outPath) { Remove-Item $outPath -Force }

$zip = [System.IO.Compression.ZipFile]::Open($outPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($f in $files) {
    $entry = $zip.CreateEntry($f.Entry, [System.IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = (Get-Item -LiteralPath $f.Abs).LastWriteTime
    $entryStream = $entry.Open()
    try {
      $fileStream = [System.IO.File]::OpenRead($f.Abs)
      try { $fileStream.CopyTo($entryStream) } finally { $fileStream.Dispose() }
    } finally {
      $entryStream.Dispose()
    }
  }
} finally {
  $zip.Dispose()
}

# 校验：条目必须使用 "/"，且必需文件齐全
$check = [System.IO.Compression.ZipFile]::OpenRead($outPath)
try {
  $names = @($check.Entries | ForEach-Object { $_.FullName })
  $bad = @($names | Where-Object { $_ -like "*\*" })
  if ($bad.Count -gt 0) { throw "zip 条目包含反斜杠（非标准）: $($bad[0])" }
  foreach ($rel in $required) {
    if ($names -notcontains $rel) { throw "zip 缺少必需文件: $rel" }
  }
} finally {
  $check.Dispose()
}

$size = [math]::Round((Get-Item $outPath).Length / 1KB, 1)
Write-Output "OK 已打包: $outPath ($size KB, $($files.Count) 个文件)"
