#!/usr/bin/env pwsh
# Wmux-scoped Codex shim. This directory is prepended only inside wmux panes.
# Ordinary terminals keep the user-level default (Hooks disabled).
# Trust bypass is process-scoped, so it never changes the user's global hook trust.

$shimDir = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$realCodex = Get-Command codex -All -ErrorAction SilentlyContinue | Where-Object {
  if (-not $_.Source) { return $false }
  $sourceDir = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($_.Source))
  -not $sourceDir.Equals($shimDir, [StringComparison]::OrdinalIgnoreCase)
} | Select-Object -First 1

if (-not $realCodex) {
  Write-Error 'codex: real Codex launcher not found outside the wmux shim directory.'
  exit 1
}

$hooksEnabled = $false
$hooksDisabled = $false
$trustConfigured = $false
$previousArg = ''

foreach ($arg in $args) {
  if ($arg -eq '--') { break }
  if ($arg -eq '--dangerously-bypass-hook-trust') { $trustConfigured = $true }
  if ($arg -in @('--disable=hooks', 'features.hooks=false', '--config=features.hooks=false', '-c=features.hooks=false')) {
    $hooksDisabled = $true
  }
  if ($arg -in @('--enable=hooks', 'features.hooks=true', '--config=features.hooks=true', '-c=features.hooks=true')) {
    $hooksEnabled = $true
  }
  if ($arg -eq 'hooks' -and $previousArg -eq '--disable') { $hooksDisabled = $true }
  if ($arg -eq 'hooks' -and $previousArg -eq '--enable') { $hooksEnabled = $true }
  $previousArg = $arg
}

$launchArgs = @()
if (-not $hooksDisabled) {
  if (-not $trustConfigured) { $launchArgs += '--dangerously-bypass-hook-trust' }
  if (-not $hooksEnabled) { $launchArgs += @('--enable', 'hooks') }
}
$launchArgs += $args

if ($MyInvocation.ExpectingInput) {
  $input | & $realCodex.Source @launchArgs
} else {
  & $realCodex.Source @launchArgs
}
exit $LASTEXITCODE
