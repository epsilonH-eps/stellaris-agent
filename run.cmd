@echo off
setlocal
"%~dp0agent\run.cmd" %*
exit /b %errorlevel%
