@echo off
rem Installs the last built release APK on every phone connected over USB and
rem opens the app. Each phone gets the build that fits its processor: the usual
rem 64-bit one, or the 32-bit one made by "scripts\build-app.bat 32".
rem Usage: scripts\install-app.bat
setlocal enabledelayedexpansion
set "ROOT=%~dp0.."
set "APK64=%ROOT%\android\app\build\outputs\flarenode\flarenode.apk"
set "APK32=%ROOT%\android\app\build\outputs\flarenode\flarenode-32bit.apk"
set "PKG=com.disaster.response"

if not exist "%APK64%" if not exist "%APK32%" (
  echo ERROR: APK not found. Run scripts\build-app.bat first.
  exit /b 1
)

set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
if not exist "%ADB%" set "ADB=adb"

set /a INSTALLED=0
set /a FAILED=0
for /f "skip=1 tokens=1,2" %%a in ('call "%ADB%" devices') do (
  if "%%b"=="device" (
    set "PHONE="
    for /f "delims=" %%i in ('call "%ADB%" -s %%a shell getprop ro.product.cpu.abi') do set "PHONE=%%i"
    set "APK=!APK32!"
    if /i "!PHONE:~0,5!"=="arm64" set "APK=!APK64!"
    echo.
    echo === %%a: installing
    if not exist "!APK!" (
      echo === %%a: a !PHONE! phone, and that build does not exist yet. Run scripts\build-app.bat with or without 32.
      set /a FAILED+=1
    ) else (
    rem -t is required because a single-processor build is flagged test-only
    call "%ADB%" -s %%a install -r -t --user 0 "!APK!"
    if errorlevel 1 (
      echo === %%a: INSTALL FAILED. If it says UPDATE_INCOMPATIBLE, the phone has FlareNode signed with a different key:
      echo     uninstall it on the phone first ^(its local data goes; it syncs back from the mesh and the Mothership^).
      echo     Otherwise check free storage on the phone.
      set /a FAILED+=1
    ) else (
      call "%ADB%" -s %%a shell am force-stop %PKG%
      call "%ADB%" -s %%a shell monkey -p %PKG% -c android.intent.category.LAUNCHER 1 >nul 2>&1
      echo === %%a: installed and launched
      set /a INSTALLED+=1
    )
    )
  ) else if "%%b"=="unauthorized" (
    echo.
    echo === %%a: UNAUTHORIZED - unlock the phone and tap Allow on the USB debugging prompt
    set /a FAILED+=1
  )
)

echo.
echo Installed on !INSTALLED! phone^(s^), !FAILED! not installed.
if !INSTALLED! EQU 0 if !FAILED! EQU 0 echo No phones found. Plug one in with USB debugging enabled.
if !FAILED! GTR 0 exit /b 1
endlocal & exit /b 0
