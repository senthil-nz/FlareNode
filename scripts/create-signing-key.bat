@echo off
rem Creates FlareNode's release signing key, once, outside the repository.
rem
rem The key and a file holding its passwords go in %USERPROFILE%\.flarenode.
rem Release builds then use it (see plugins\release-signing). Keep a copy of
rem that folder somewhere safe, such as a password manager: without the key,
rem a new version cannot be installed over one signed with it.
rem
rem Usage: scripts\create-signing-key.bat
setlocal
set "DIR=%USERPROFILE%\.flarenode"
set "STORE=%DIR%\flarenode-release.jks"
set "PROPS=%DIR%\signing.properties"

if exist "%STORE%" (
  echo A signing key already exists at %STORE%. Nothing done.
  exit /b 0
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
if not exist "%DIR%" mkdir "%DIR%"

rem A random password, never shown
for /f "delims=" %%p in ('powershell -NoProfile -Command "$b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b) -replace '[+/=]', 'x'"') do set "PASS=%%p"

"%JAVA_HOME%\bin\keytool.exe" -genkeypair -storetype PKCS12 -keystore "%STORE%" -alias flarenode ^
  -keyalg RSA -keysize 2048 -validity 10000 -storepass "%PASS%" -keypass "%PASS%" ^
  -dname "CN=FlareNode, O=FlareNode contributors" >nul
if errorlevel 1 (
  echo ERROR: keytool could not create the key.
  exit /b 1
)

set "STOREFWD=%STORE:\=/%"
> "%PROPS%" echo storeFile=%STOREFWD%
>> "%PROPS%" echo storePassword=%PASS%
>> "%PROPS%" echo keyAlias=flarenode
>> "%PROPS%" echo keyPassword=%PASS%

echo Created the release signing key:
echo   %STORE%
echo   %PROPS% (holds the password)
echo Back up both files somewhere safe. They are not in the repository.
endlocal & exit /b 0
