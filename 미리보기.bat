@echo off
chcp 65001 >nul
cd /d "%~dp0"
node ".preview\serve.js" pattern
pause
