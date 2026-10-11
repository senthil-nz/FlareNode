@echo off
rem Creates or resets the demo responders (admin, alpha, bravo) with the
rem password from SEED_PASSWORD in mothership-server\.env.
rem Usage: scripts\seed-mothership.bat
setlocal
pushd "%~dp0..\mothership-server"
node seed.js
set "RC=%ERRORLEVEL%"
popd
endlocal & exit /b %RC%
