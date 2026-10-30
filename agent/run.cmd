@echo off
setlocal
set "NODE_BIN=%STELLARIS_AGENT_NODE%"
if not defined NODE_BIN (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE_BIN=node"
)
if not defined NODE_BIN (
  if exist "%~dp0runtime\node.exe" set "NODE_BIN=%~dp0runtime\node.exe"
)
if not defined NODE_BIN (
  if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_BIN=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
)
if not defined NODE_BIN (
  echo [stellaris-agent] node not found. Install Node 22+ or set STELLARIS_AGENT_NODE.
  exit /b 1
)
"%NODE_BIN%" "%~dp0bin\stellaris-agent.mjs" %*
exit /b %errorlevel%
