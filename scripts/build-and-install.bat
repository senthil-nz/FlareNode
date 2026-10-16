@echo off
rem Builds the release APK and installs it on every connected phone.
rem Pass 32 to build for an older 32-bit phone.
rem Usage: scripts\build-and-install.bat [32]
call "%~dp0build-app.bat" %1 || exit /b 1
call "%~dp0install-app.bat"
