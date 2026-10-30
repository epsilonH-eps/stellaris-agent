@echo off
setlocal
"%~dp0agent\\run.cmd" init %*
exit /b %errorlevel%
