@echo off
set "PT3_AUDIT_NODE=%~dp0runtime\node.exe"
if not exist "%PT3_AUDIT_NODE%" (
  echo Bundled Node not found. Place these two audit files beside the installed runtime folder.
  pause
  exit /b 1
)
"%PT3_AUDIT_NODE%" "%~dp0audit-pcr-cache.mjs" --out "%TEMP%\DLNA-Video-Server-pcr-cache-audit-%RANDOM%-%RANDOM%.json" %*
pause
