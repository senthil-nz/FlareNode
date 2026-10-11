@echo off
rem Builds the release APK and installs it on every connected phone.
rem Usage: scripts\build-and-install.bat
call "%~dp0build-app.bat" || exit /b 1
call "%~dp0install-app.bat"
