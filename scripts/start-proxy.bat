@echo off
pushd "%~dp0.."

echo Installing Node.js dependencies...
npm install

echo.
echo Starting JIRA Proxy Server...
echo Server will run on http://localhost:3000
echo.
echo Keep this window open while using the dashboard
echo Press Ctrl+C to stop the server
echo.

node server\proxy-server.js

pause
popd