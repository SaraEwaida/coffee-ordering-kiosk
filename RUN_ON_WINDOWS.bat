@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Node.js is not installed. Please install Node.js 22 LTS or later.
 pause
 exit /b 1
)
if not exist "node_modules" (
 echo Installing project dependencies...
 call npm install
 if errorlevel 1 (pause & exit /b 1)
)
echo Starting Coffee Ordering Kiosk...
echo Customer kiosk: http://localhost:5173
echo Kitchen view:   http://localhost:5173/?view=kitchen
echo Admin view:     http://localhost:5173/?view=admin
call npm run dev
pause
