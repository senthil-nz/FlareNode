@echo off
rem Installs the last built release APK on every phone connected over USB and
rem opens the app. Usage: scripts\install-app.bat
setlocal enabledelayedexpansion
set "ROOT=%~dp0.."
set "APK=%ROOT%\android\app\build\outputs\flarenode\flarenode.apk"
set "PKG=com.disaster.response"

if not exist "%APK%" (
  echo ERROR: APK not found. Run scripts\build-app.bat first.
  exit /b 1
)

set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
if not exist "%ADB%" set "ADB=adb"

set /a INSTALLED=0
set /a FAILED=0
for /f "skip=1 tokens=1,2" %%a in ('call "%ADB%" devices') do (
  if "%%b"=="device" (
    echo.
    echo === %%a: installing
    rem -t is required because the arm64-only build is flagged test-only
    call "%ADB%" -s %%a install -r -t --user 0 "%APK%"
    if errorlevel 1 (
      echo === %%a: INSTALL FAILED ^(check free storage on the phone^)
      set /a FAILED+=1
    ) else (
      call "%ADB%" -s %%a shell am force-stop %PKG%
      call "%ADB%" -s %%a shell monkey -p %PKG% -c android.intent.category.LAUNCHER 1 >nul 2>&1
      echo === %%a: installed and launched
      set /a INSTALLED+=1
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
