@echo off
rem Builds an offline map pack from Protomaps data.
rem
rem   scripts\build-map-pack.bat <id> "<name>" <west,south,east,north> [--bundle]
rem
rem Without --bundle the pack goes to mothership-server\maps, where phones can
rem download it from Profile ^> Offline map. With --bundle it replaces the map
rem built into the app (rebuild the app afterwards).
rem
rem Example:
rem   scripts\build-map-pack.bat lower-hutt "Lower Hutt" 174.85,-41.25,174.98,-41.17
setlocal
if "%~3"=="" (
  echo Usage: scripts\build-map-pack.bat ^<id^> "^<name^>" ^<west,south,east,north^> [--bundle]
  exit /b 1
)
pushd "%~dp0..\tools\map-pack"
if not exist "node_modules\pmtiles" (
  echo Installing map-pack tool dependencies...
  call npm install || (popd & exit /b 1)
)
node build-pack.js --id %~1 --name "%~2" --bbox "%~3" %4
set "RC=%ERRORLEVEL%"
popd
endlocal & exit /b %RC%
