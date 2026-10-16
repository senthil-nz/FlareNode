@echo off
rem Builds "FlareNode Mesh Lab" and installs it on every connected phone.
rem
rem The Mesh Lab is the same app with a raw test bench for the mesh added
rem (see src\screens\MeshLabScreen.js). It has its own app id, so it installs
rem next to the normal FlareNode app and does not replace it or touch its data.
rem The two do talk to each other over the mesh.
rem
rem Usage: scripts\build-mesh-lab.bat [32]
setlocal enabledelayedexpansion
rem Most phones are 64-bit. Pass 32 to build for an older 32-bit phone
rem (the Galaxy A10, for one); the two builds are kept side by side.
set "ABI=arm64-v8a"
set "BITS="
if /i "%~1"=="32" (
  set "ABI=armeabi-v7a"
  set "BITS=-32bit"
)
set "ROOT=%~dp0.."
set "BUILT=%ROOT%\android\app\build\intermediates\apk\release\app-release.apk"
set "LABDIR=%ROOT%\android\app\build\outputs\meshlab"
set "LAB=%LABDIR%\flarenode-mesh-lab%BITS%.apk"
set "LAB64=%LABDIR%\flarenode-mesh-lab.apk"
set "LAB32=%LABDIR%\flarenode-mesh-lab-32bit.apk"
set "PKG=com.disaster.response.meshlab"

if not exist "%ROOT%\android\gradlew.bat" (
  echo ERROR: android\ folder not found.
  exit /b 1
)
rem The Android SDK: ANDROID_HOME if set, otherwise where Android Studio installs it
if not defined ANDROID_HOME if exist "%LOCALAPPDATA%\Android\Sdk" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if not defined ANDROID_HOME (
  echo ERROR: the Android SDK was not found. Install it with Android Studio, or set ANDROID_HOME.
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

rem Expo writes the app settings (from app.json) into a file that is packaged
rem in the APK, and Gradle then reuses that file even after app.json changes.
rem Remove it so every build packages the current settings.
if exist "%ROOT%\node_modules\expo-constants\android\build\generated\assets" rmdir /s /q "%ROOT%\node_modules\expo-constants\android\build\generated\assets"

pushd "%ROOT%\android"
call "%ROOT%\android\gradlew.bat" app:assembleRelease --console=plain ^
  -PappIdSuffix=.meshlab ^
  -PreactNativeArchitectures=%ABI% ^
  -Pandroid.injected.build.abi=%ABI% ^
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
    rem Each phone gets the build that fits its processor, if that one has been built
    set "PHONE="
    for /f "delims=" %%i in ('call "%ADB%" -s %%a shell getprop ro.product.cpu.abi') do set "PHONE=%%i"
    set "FITS=!LAB32!"
    if /i "!PHONE:~0,5!"=="arm64" set "FITS=!LAB64!"
    if exist "!FITS!" (
      echo === %%a: installing Mesh Lab
      call "%ADB%" -s %%a install -r -t --user 0 "!FITS!"
      if errorlevel 1 (
        echo === %%a: INSTALL FAILED. If it says UPDATE_INCOMPATIBLE, Mesh Lab on the phone is signed with a different key: uninstall it there first.
      ) else (
        call "%ADB%" -s %%a shell monkey -p %PKG% -c android.intent.category.LAUNCHER 1 >nul 2>&1
        set /a INSTALLED+=1
      )
    ) else (
      echo === %%a: a !PHONE! phone, and that build does not exist yet. Run this script with or without 32 to make it.
    )
  ) else if "%%b"=="unauthorized" (
    echo === %%a: UNAUTHORIZED - unlock the phone and tap Allow on the USB debugging prompt
  )
)
echo.
echo Mesh Lab installed on !INSTALLED! phone^(s^).
endlocal & exit /b 0
