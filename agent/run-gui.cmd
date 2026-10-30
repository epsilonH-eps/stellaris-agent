@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0gui\StellarisAgent.ps1" %*
exit /b %errorlevel%