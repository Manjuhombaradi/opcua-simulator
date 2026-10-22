@echo off
rem Windows: double-click to run the simulator from source (installs dependencies on first run).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js 22.13 or newer is required. Install the LTS version from https://nodejs.org
    echo or use the ready-made OPC UA Simulator installer / portable .exe instead.
    pause
    exit /b 1
)
rem node-opcua and Electron's installer need Node.js 22.13 or newer
node -e "var v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=13)?0:1)" 2>nul
if errorlevel 1 (
    for /f "delims=" %%v in ('node -v') do echo Node.js 22.13 or newer is required, found %%v.
    echo Install the LTS version from https://nodejs.org
    echo or use the ready-made OPC UA Simulator installer / portable .exe instead.
    pause
    exit /b 1
)

rem node_modules must match this OS / CPU (Electron's binary is platform specific): a folder copied
rem from or shared with another machine is reinstalled once.
set "SYSTEM=%OS%-%PROCESSOR_ARCHITECTURE%"
if not exist node_modules goto firstrun
set "HAVE="
if exist node_modules\.installed-for set /p HAVE=<node_modules\.installed-for
if "%HAVE%"=="%SYSTEM%" goto start
set "ELECTRON_BINARY="
if exist node_modules\electron\path.txt set /p ELECTRON_BINARY=<node_modules\electron\path.txt
if exist node_modules\.installed-for goto reinstall
if defined ELECTRON_BINARY if not "%ELECTRON_BINARY%"=="electron.exe" goto reinstall
rem no marker yet: an earlier install may have been interrupted - npm install completes it (quick when complete)
echo Checking dependencies (one time)...
goto install

:firstrun
echo First run: installing dependencies (one time, needs internet)...
goto install

:reinstall
echo node_modules was installed on another system - reinstalling for %SYSTEM% (one time, needs internet)...
rem Electron downloads the binary for this system on the next start
if exist node_modules\electron\dist rmdir /s /q node_modules\electron\dist
if exist node_modules\electron\path.txt del /q node_modules\electron\path.txt

:install
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo npm install failed - check the internet connection and try again.
    pause
    exit /b 1
)
>node_modules\.installed-for echo %SYSTEM%

:start
call npm start -- %*
