# 核心程序包 / 插件包分开打：插件改动只重打 4~5 MB 的插件包，不用重新传 150 MB 的核心包。
#
# 用法（在仓库根目录跑）：
#   pwsh tools/pack-split.ps1                    # 两个都打
#   pwsh tools/pack-split.ps1 -Only plugins      # 只重打插件包（日常更新走这个）
#   pwsh tools/pack-split.ps1 -Only core         # 只打核心包（换内核/换版本时才用）
#
# 前置：核心包需要一个解包好的 QQ Agent 目录（默认取 ../release-build/QQAgent-0.5.1-win64，
# 里面应有 QQ Agent.exe、resources/、locales/ 等）；插件包直接取本仓库的 extensions/，
# 所以仓库里的插件必须是已脱敏、能直接用的那一份。
param(
  [ValidateSet('all','core','plugins')][string]$Only = 'all',
  [string]$CoreSrc = '',
  [string]$PlugSrc = '',
  [string]$OutDir  = '',
  [string]$Version = '0.5.1-dfy'
)

$RepoRoot = Split-Path $PSScriptRoot -Parent
if (-not $CoreSrc) { $CoreSrc = Join-Path $RepoRoot '..\release-build\QQAgent-0.5.1-win64' }
if (-not $PlugSrc) { $PlugSrc = Join-Path $RepoRoot 'extensions' }
if (-not $OutDir)  { $OutDir  = Join-Path $RepoRoot '..\release-split' }

$stamp = Get-Date -Format 'yyyyMMdd'
New-Item -ItemType Directory -Force $OutDir | Out-Null
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function New-ZipFromFiles([string]$zipPath, [string]$root, [string[]]$files) {
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  $fs = [IO.File]::Create($zipPath)
  try {
    $zip = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
    try {
      foreach ($f in $files) {
        $rel = $f.Substring($root.Length + 1).Replace('\', '/')
        $entry = $zip.CreateEntry($rel, [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = (Get-Item -LiteralPath $f).LastWriteTime
        $es = $entry.Open()
        try {
          $src = [IO.File]::OpenRead($f)
          try { $src.CopyTo($es) } finally { $src.Dispose() }
        } finally { $es.Dispose() }
      }
    } finally { $zip.Dispose() }
  } finally { $fs.Dispose() }
}

if ($Only -in @('all','core')) {
  if (-not (Test-Path $CoreSrc)) { throw "核心源不存在：$CoreSrc（先解包一个可运行的 QQ Agent 目录，或用 -CoreSrc 指定）" }
  # 核心包不含插件/技能，也不含运行期数据目录，换插件时完全不用动它
  $all = Get-ChildItem $CoreSrc -Recurse -File | Where-Object {
    $_.FullName -notmatch '\\extensions\\plugins\\' -and
    $_.FullName -notmatch '\\extensions\\skills\\' -and
    $_.FullName -notmatch '\\data(-v\d)?\\'
  }
  $zip = Join-Path $OutDir "QQAgent-$Version-win64-core-$stamp.zip"
  New-ZipFromFiles $zip $CoreSrc $all.FullName
  $mb = [math]::Round((Get-Item $zip).Length/1MB,1)
  $sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  "核心包 $zip  $mb MB  $($all.Count) 个文件  sha256=$sha"
}

if ($Only -in @('all','plugins')) {
  if (-not (Test-Path $PlugSrc)) { throw "插件源不存在：$PlugSrc" }
  $all = Get-ChildItem $PlugSrc -Recurse -File | Where-Object {
    $_.Name -notmatch '\.bak($|-|\.)' -and $_.Name -notmatch '\.previous$'
  }
  $zip = Join-Path $OutDir "QQAgent-$Version-extensions-$stamp.zip"
  # 以 extensions 上级为根，包内保留 extensions/plugins、extensions/skills 结构，解压即覆盖
  $root = Split-Path $PlugSrc -Parent
  New-ZipFromFiles $zip $root $all.FullName
  $mb = [math]::Round((Get-Item $zip).Length/1MB,1)
  $sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  "插件包 $zip  $mb MB  $($all.Count) 个文件  sha256=$sha"
}
