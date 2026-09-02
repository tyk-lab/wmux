@echo off
REM Wmux-scoped Codex shim. This directory is prepended only inside wmux panes.
REM Ordinary terminals keep the user-level default (Hooks disabled).
REM Trust bypass is process-scoped, so it never changes the user's global hook trust.
where pwsh.exe >nul 2>nul
if errorlevel 1 goto windows_powershell

pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0codex.ps1" %*
exit /b %ERRORLEVEL%

:windows_powershell
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0codex.ps1" %*
exit /b %ERRORLEVEL%
