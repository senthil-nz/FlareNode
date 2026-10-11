@echo off
rem Builds "FlareNode Mesh Lab" and installs it on every connected phone.
rem
rem The Mesh Lab is the same app with a raw test bench for the mesh added
rem (see src\screens\MeshLabScreen.js). It has its own app id, so it installs
rem next to the normal FlareNode app and does not replace it or touch its data.
rem The two do talk to each other over the mesh.
rem
rem Usage: scripts\build-mesh-lab.bat
setlocal enabledelayedexpansion
set "ROOT=%~dp0.."
set "BUILT=%ROOT%\android\app\build\intermediates\apk\release\app-release.apk"
set "LABDIR=%ROOT%\android\app\build\outputs\meshlab"
set "LAB=%LABDIR%\flarenode-mesh-lab.apk"
set "PKG=com.disaster.response.meshlab"

if not exist "%ROOT%\android\gradlew.bat" (
  echo ERROR: android\ folder not found.
  exit /b 1
)
if not defined JAVA_HOME (
  for /d %%d in ("%USERPROFILE%\.jdks\jbr-21*" "%USERPROFILE%\.jdks\*21*" "%USERPROFILE%\.jdks\*17*") do (
    if not defined JAVA_HOME if exist "%%d\bin\java.exe" set "JAVA_HOME=%%d"
  )
)
if not defined JAVA_HOME (
  echo ERROR: JAVA_HOME is not set and no JDK 17/21 was found under %USERPROFILE%\.jdks.
  exit /b 1
)

rem Gradle writes every variant to the same path, so the finished APK is
rem copied to a place of its own. install-app.bat installs FlareNode from its
rem own copy and is not affected by this build.
if not exist "%LABDIR%" mkdir "%LABDIR%"

pushd "%ROOT%\android"
call "%ROOT%\android\gradlew.bat" app:assembleRelease --console=plain ^
  -PappIdSuffix=.meshlab ^
  -PreactNativeArchitectures=arm64-v8a ^
  -Pandroid.injected.build.abi=arm64-v8a ^
  -x lint -x lintVitalRelease -x lintVitalAnalyzeRelease -x lintVitalReportRelease
set "RC=%ERRORLEVEL%"
popd

if "%RC%"=="0" copy /y "%BUILT%" "%LAB%" >nul
if not "%RC%"=="0" (
  echo.
  echo BUILD FAILED ^(exit %RC%^)
  exit /b %RC%
)
echo.
echo BUILD OK: %LAB%

set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
if not exist "%ADB%" set "ADB=adb"
set /a INSTALLED=0
for /f "skip=1 tokens=1,2" %%a in ('call "%ADB%" devices') do (
  if "%%b"=="device" (
    echo === %%a: installing Mesh Lab
    call "%ADB%" -s %%a install -r -t --user 0 "%LAB%"
    if not errorlevel 1 (
      call "%ADB%" -s %%a shell monkey -p %PKG% -c android.intent.category.LAUNCHER 1 >nul 2>&1
      set /a INSTALLED+=1
    )
  ) else if "%%b"=="unauthorized" (
    echo === %%a: UNAUTHORIZED - unlock the phone and tap Allow on the USB debugging prompt
  )
)
echo.
echo Mesh Lab installed on !INSTALLED! phone^(s^).
endlocal & exit /b 0
