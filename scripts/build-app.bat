@echo off
rem Builds the standalone FlareNode Android release APK (arm64, JS bundled in).
rem Usage: scripts\build-app.bat
setlocal
set "ROOT=%~dp0.."
set "BUILT=%ROOT%\android\app\build\intermediates\apk\release\app-release.apk"
rem Gradle reuses the path above for every variant (the Mesh Lab build too),
rem so the finished FlareNode APK is copied to a place of its own.
set "OUTDIR=%ROOT%\android\app\build\outputs\flarenode"
set "APK=%OUTDIR%\flarenode.apk"

if not exist "%ROOT%\.env" (
  echo ERROR: .env not found in the project root. Copy .env.example to .env and fill it in.
  exit /b 1
)
if not exist "%ROOT%\android\gradlew.bat" (
  echo ERROR: android\ folder not found. It is git-ignored; generate it with "npx expo prebuild -p android".
  exit /b 1
)

rem Gradle 8.8 needs JDK 17 or 21 ^(the JDK bundled with recent Android Studio is too new^).
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

pushd "%ROOT%\android"
rem arm64 only keeps the APK small enough for phones that are short on storage.
rem The lint tasks are skipped to keep the build short.
call "%ROOT%\android\gradlew.bat" app:assembleRelease --console=plain ^
  -PreactNativeArchitectures=arm64-v8a ^
  -Pandroid.injected.build.abi=arm64-v8a ^
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
