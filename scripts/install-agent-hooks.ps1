#Requires -Version 7
<#
.SYNOPSIS
  Install wmux turn-level hooks for Claude / Kimi / Codex / Grok / OpenCode.

.DESCRIPTION
  Ensures dist/ is built, then runs `wmux install-hooks` which writes:
    - ~/.claude/settings.json          (Claude Code)
    - ~/.kimi-code/config.toml         (Kimi)
    - ~/.codex/hooks.json              (Codex — may need /hooks trust)
    - ~/.grok/hooks/wmux.json          (Grok Build)
    - ~/.config/opencode/plugin/wmux.js (OpenCode plugin)

  Safe to re-run (idempotent). Does not remove your non-wmux hooks.

.PARAMETER NoOpencode
  Skip OpenCode plugin install.

.PARAMETER SkipBuild
  Do not run `npm run build:main` even if dist is missing/stale.
#>
param(
  [switch]$NoOpencode,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root

$cli = Join-Path $Root 'dist\cli\wmux.js'
$hook = Join-Path $Root 'resources\cli\wmux-hook.js'

if (-not (Test-Path -LiteralPath $hook)) {
  Write-Error "Missing resources/cli/wmux-hook.js under $Root"
}

if (-not $SkipBuild) {
  $needBuild = -not (Test-Path -LiteralPath $cli)
  if (-not $needBuild) {
    $cliTime = (Get-Item -LiteralPath $cli).LastWriteTimeUtc
    $srcDirs = @(
      (Join-Path $Root 'src\main'),
      (Join-Path $Root 'src\cli')
    )
    foreach ($dir in $srcDirs) {
      $newer = Get-ChildItem -LiteralPath $dir -Recurse -File -Filter '*.ts' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTimeUtc -gt $cliTime } |
        Select-Object -First 1
      if ($newer) { $needBuild = $true; break }
    }
  }
  if ($needBuild) {
    Write-Host '→ npm run build:main'
    npm run build:main
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
}

if (-not (Test-Path -LiteralPath $cli)) {
  Write-Error "dist/cli/wmux.js not found. Run: npm run build:main"
}

$argv = @($cli, 'install-hooks')
if ($NoOpencode) { $argv += '--no-opencode' }

Write-Host "→ node $($argv -join ' ')"
& node @argv
exit $LASTEXITCODE
