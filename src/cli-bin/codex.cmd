@echo off
REM Wmux-scoped Codex shim. This directory is prepended only inside wmux panes.
REM Ordinary terminals keep the user-level default (Hooks disabled).
setlocal EnableExtensions DisableDelayedExpansion

set "WMUX_CODEX_REAL="
for %%N in (codex.exe codex.cmd codex.bat) do (
  for /f "delims=" %%I in ('where %%N 2^>nul') do (
    if not defined WMUX_CODEX_REAL if /I not "%%~fI"=="%~f0" set "WMUX_CODEX_REAL=%%~fI"
  )
)

if not defined WMUX_CODEX_REAL (
  echo codex: real Codex launcher not found outside the wmux shim directory. 1>&2
  exit /b 1
)

set "WMUX_CODEX_ARGS=%*"
if not "%WMUX_CODEX_ARGS:--enable hooks=%"=="%WMUX_CODEX_ARGS%" goto codex_hooks_configured
if not "%WMUX_CODEX_ARGS:--disable hooks=%"=="%WMUX_CODEX_ARGS%" goto codex_hooks_configured
if not "%WMUX_CODEX_ARGS:--enable=hooks=%"=="%WMUX_CODEX_ARGS%" goto codex_hooks_configured
if not "%WMUX_CODEX_ARGS:--disable=hooks=%"=="%WMUX_CODEX_ARGS%" goto codex_hooks_configured
if not "%WMUX_CODEX_ARGS:features.hooks=%"=="%WMUX_CODEX_ARGS%" goto codex_hooks_configured

"%WMUX_CODEX_REAL%" --enable hooks %*
exit /b %ERRORLEVEL%

:codex_hooks_configured
"%WMUX_CODEX_REAL%" %*
exit /b %ERRORLEVEL%
