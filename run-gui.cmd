@echo off
setlocal
"%~dp0agent\run-gui.cmd" %*
exit /b %errorlevel%
