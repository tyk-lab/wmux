#Requires -Version 7
<#
.SYNOPSIS
  Install wmux turn-level hooks for Kimi / Codex / Grok / Pi / OpenCode.

.DESCRIPTION
  Rebuilds and synchronizes the Hook helper plus its runtime dependencies, then
  runs `wmux install-hooks` which writes:
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
$hookRuntimeFiles = @('wmux-hook.js', 'wmux-hook-context.js', 'wmux-hook-payload.js')

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
  return (Join-Path (Split-Path -Parent $resolvedExe) 'resources\cli\wmux-hook.js')
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
function Sync-HookRuntime {
  param([Parameter(Mandatory)][string]$TargetDirectory)

  if (-not (Test-Path -LiteralPath $TargetDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
  }
  foreach ($file in $hookRuntimeFiles) {
    $source = Join-Path $Root "dist\cli\$file"
    $target = Join-Path $TargetDirectory $file
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "Missing $source. Run: npm run build:main"
    }
    $same = (Test-Path -LiteralPath $target -PathType Leaf) -and
      ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -eq
       (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash)
    if (-not $same) {
      Write-Host "→ Sync $target"
      Copy-Item -LiteralPath $source -Destination $target -Force
    }
  }
}

Sync-HookRuntime -TargetDirectory (Join-Path $Root 'resources\cli')

$installedHook = Resolve-InstalledWmuxHook -RequestedExe $WmuxExe
if ($installedHook) {
  Sync-HookRuntime -TargetDirectory (Split-Path -Parent $installedHook)
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
