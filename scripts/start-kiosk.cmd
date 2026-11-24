@echo off
REM Launch the kiosk full screen with no browser UI.
REM
REM   scripts\start-kiosk.cmd                       uses http://localhost:5173
REM   scripts\start-kiosk.cmd http://localhost:4173 any other address
REM
REM Exit the kiosk with Alt+F4.
REM
REM The servers must already be running (npm run dev). This only opens the
REM browser; it does not start the application.

setlocal
set "URL=%~1"
if "%URL%"=="" set "URL=http://localhost:5173"

set "FLAGS=--kiosk --no-first-run --noerrdialogs --disable-session-crashed-bubble"
set "FLAGS=%FLAGS% --disable-infobars --disable-pinch --overscroll-history-navigation=0"
set "FLAGS=%FLAGS% --disable-features=TranslateUI --check-for-update-interval=31536000"

REM A fresh profile each run, so a previous session's zoom, cached errors or
REM restore prompt cannot appear in front of a customer.
set "PROFILE=%TEMP%\bean-bloom-kiosk-profile"
set "FLAGS=%FLAGS% --user-data-dir=%PROFILE%"

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
set "CHROME86=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if exist "%EDGE%" (
  echo Starting kiosk in Edge at %URL%
  start "" "%EDGE%" %FLAGS% --edge-kiosk-type=fullscreen "%URL%"
  goto :eof
)
if exist "%CHROME%" (
  echo Starting kiosk in Chrome at %URL%
  start "" "%CHROME%" %FLAGS% "%URL%"
  goto :eof
)
if exist "%CHROME86%" (
  echo Starting kiosk in Chrome at %URL%
  start "" "%CHROME86%" %FLAGS% "%URL%"
  goto :eof
)

echo Could not find Microsoft Edge or Google Chrome in the usual locations.
echo Open the browser yourself and press F11.
exit /b 1
