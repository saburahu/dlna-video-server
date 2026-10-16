@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
set "PT3_SETUP_EXIT=%ERRORLEVEL%"
if not "%PT3_SETUP_EXIT%"=="0" echo Setup failed. Review the error above before retrying.
pause
endlocal & exit /b %PT3_SETUP_EXIT%
