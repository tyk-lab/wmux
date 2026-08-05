#Requires -Version 7
<#
.SYNOPSIS
  Install wmux turn-level hooks for Claude / Kimi / Codex / Grok / Pi / OpenCode.

.DESCRIPTION
  Rebuilds and synchronizes the CLI / Hook helper, then runs `wmux install-hooks` which writes:
    - ~/.claude/settings.json          (Claude Code)
    - ~/.kimi-code/config.toml         (Kimi)
    - ~/.codex/hooks.json              (Codex — may need /hooks trust)
    - ~/.grok/hooks/wmux.json          (Grok Build)
    - ~/.pi/agent/extensions/wmux-agent-hooks.ts (Pi Agent extension)
    - ~/.pi/agent/settings.json        (Pi Git Bash shellPath on Windows, when available)
    - ~/.config/opencode/plugin/wmux.js (OpenCode plugin)

  Safe to re-run (idempotent). Does not remove your non-wmux hooks.

.PARAMETER NoOpencode
  Skip OpenCode plugin install.

.PARAMETER SkipBuild
  Do not run `npm run build:main`; uses the existing dist/ output instead.

.PARAMETER WmuxExe
  Optional path to the wmux.exe currently in use. Its sibling
  resources/cli/wmux-hook.js is written to agent hook settings. When omitted,
  the script checks $env:WMUX_EXE, then the standard local unpacked build.
#>
param(
  [switch]$NoOpencode,
  [switch]$SkipBuild,
  [string]$WmuxExe
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root

$cli = Join-Path $Root 'dist\cli\wmux.js'
$builtHook = Join-Path $Root 'dist\cli\wmux-hook.js'
$resourceHook = Join-Path $Root 'resources\cli\wmux-hook.js'

function Resolve-InstalledWmuxHook {
  param([string]$RequestedExe)

  $exe = $RequestedExe
  if (-not $exe) { $exe = $env:WMUX_EXE }
  $isExplicit = [bool]$exe

  if (-not $exe -and $env:LOCALAPPDATA) {
    $candidate = Join-Path $env:LOCALAPPDATA 'wmux-build\release\win-unpacked\wmux.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $exe = $candidate }
  }

  if (-not $exe) { return $null }
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    if ($isExplicit) { throw "wmux.exe not found: $exe" }
    return $null
  }

  $resolvedExe = (Resolve-Path -LiteralPath $exe).Path
  $hook = Join-Path (Split-Path -Parent $resolvedExe) 'resources\cli\wmux-hook.js'
  if (-not (Test-Path -LiteralPath $hook -PathType Leaf)) {
    throw "wmux-hook.js not found beside wmux.exe: $hook"
  }
  return (Resolve-Path -LiteralPath $hook).Path
}

if (-not (Test-Path -LiteralPath $resourceHook)) {
  Write-Error "Missing resources/cli/wmux-hook.js under $Root"
}

if (-not $SkipBuild) {
  # Always rebuild before synchronizing: a copied worktree can preserve stale
  # mtimes even while dist/ contains an older Hook helper.
  Write-Host '→ npm run build:main'
  npm run build:main
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not (Test-Path -LiteralPath $cli)) {
  Write-Error "dist/cli/wmux.js not found. Run: npm run build:main"
}
if (-not (Test-Path -LiteralPath $builtHook)) {
  Write-Error "dist/cli/wmux-hook.js not found. Run: npm run build:main"
}

$builtHash = (Get-FileHash -LiteralPath $builtHook -Algorithm SHA256).Hash
$resourceHash = (Get-FileHash -LiteralPath $resourceHook -Algorithm SHA256).Hash
if ($builtHash -ne $resourceHash) {
  Write-Host '→ Sync resources/cli/wmux-hook.js'
  Copy-Item -LiteralPath $builtHook -Destination $resourceHook -Force
}

$installedHook = Resolve-InstalledWmuxHook -RequestedExe $WmuxExe
if ($installedHook) {
  $env:WMUX_HOOK_SCRIPT = $installedHook
  Write-Host "→ Use installed wmux Hook: $installedHook"
} else {
  Remove-Item Env:WMUX_HOOK_SCRIPT -ErrorAction SilentlyContinue
  Write-Host "→ Use repository Hook: $builtHook"
}

$argv = @($cli, 'install-hooks')
if ($NoOpencode) { $argv += '--no-opencode' }

Write-Host "→ node $($argv -join ' ')"
& node @argv
exit $LASTEXITCODE
