@echo off
setlocal
set "TETHOQ_BRIDGE_HOME=%~dp0"
"%TETHOQ_BRIDGE_HOME%runtime\node.exe" "%TETHOQ_BRIDGE_HOME%app\apps\agent_bridge\src\main.js" --phone-pair %*
set "TETHOQ_BRIDGE_EXIT=%ERRORLEVEL%"
endlocal & exit /b %TETHOQ_BRIDGE_EXIT%
