@echo off
REM wmux CLI shim. wmux prepends this dir (cli-bin) to PATH in every shell it
REM spawns, so bare `wmux` resolves in cmd/PowerShell children too. Runs the
REM Node pipe client via the $WMUX_CLI path wmux injects; falls back to the copy
REM next to this shim. No wmux.exe in this dir, so no PATHEXT collision.
setlocal
set "CLI=%WMUX_CLI%"
REM Also fall back when %WMUX_CLI% is stale — a pane that outlived a wmux
REM update/move, where node would otherwise crash with MODULE_NOT_FOUND.
if not defined CLI set "CLI=%~dp0..\cli\wmux.js"
if not exist "%CLI%" set "CLI=%~dp0..\cli\wmux.js"
if not exist "%CLI%" (
  echo wmux: CLI not found at "%CLI%" - wmux was updated or moved; restart this shell. 1>&2
  exit /b 1
)
node "%CLI%" %*
