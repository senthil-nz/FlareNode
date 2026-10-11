@echo off
rem Starts (or restarts) the Mothership server: API + live dashboard on port 3000.
rem There is no build step; this installs dependencies if needed and runs it.
rem Usage: scripts\start-mothership.bat      (Ctrl+C to stop)
setlocal
set "SERVER=%~dp0..\mothership-server"

if not exist "%SERVER%\.env" (
  echo ERROR: mothership-server\.env not found. Copy .env.example to .env and fill it in.
  exit /b 1
)

pushd "%SERVER%"
if not exist "node_modules\leaflet\dist\leaflet.js" (
  echo Installing server dependencies...
  call npm install || (popd & exit /b 1)
)

rem Stop a server that is already listening on port 3000 so the new code is picked up
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3000 .*LISTENING"') do (
  echo Stopping previous server ^(PID %%p^)
  taskkill /PID %%p /F >nul 2>&1
)

echo Dashboard: http://localhost:3000/
node src\index.js
popd
endlocal
