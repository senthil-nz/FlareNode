@echo off
rem Builds the standalone FlareNode Android release APK (arm64, JS bundled in).
rem Usage: scripts\build-app.bat [32]
setlocal
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
rem Gradle reuses the path above for every variant (the Mesh Lab build too),
rem so the finished FlareNode APK is copied to a place of its own.
set "OUTDIR=%ROOT%\android\app\build\outputs\flarenode"
set "APK=%OUTDIR%\flarenode%BITS%.apk"

if not exist "%ROOT%\.env" (
  echo ERROR: .env not found in the project root. Copy .env.example to .env and fill it in.
  exit /b 1
)
if not exist "%ROOT%\android\gradlew.bat" (
  echo ERROR: android\ folder not found. It is git-ignored; generate it with "npx expo prebuild -p android".
  exit /b 1
)

rem Gradle 8.8 needs JDK 17 or 21 ^(the JDK bundled with recent Android Studio is too new^).
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
echo Using JAVA_HOME=%JAVA_HOME%

rem Expo writes the app settings (from app.json) into a file that is packaged
rem in the APK, and Gradle then reuses that file even after app.json changes.
rem Remove it so every build packages the current settings.
if exist "%ROOT%\node_modules\expo-constants\android\build\generated\assets" rmdir /s /q "%ROOT%\node_modules\expo-constants\android\build\generated\assets"

pushd "%ROOT%\android"
rem One processor type per APK keeps it small enough for phones short on storage.
rem The lint tasks are skipped to keep the build short.
call "%ROOT%\android\gradlew.bat" app:assembleRelease --console=plain ^
  -PreactNativeArchitectures=%ABI% ^
  -Pandroid.injected.build.abi=%ABI% ^
  -x lint -x lintVitalRelease -x lintVitalAnalyzeRelease -x lintVitalReportRelease
set "RC=%ERRORLEVEL%"
popd

if not "%RC%"=="0" (
  echo.
  echo BUILD FAILED ^(exit %RC%^)
  exit /b %RC%
)
if not exist "%OUTDIR%" mkdir "%OUTDIR%"
copy /y "%BUILT%" "%APK%" >nul
echo.
echo BUILD OK: %APK%
endlocal & exit /b 0
