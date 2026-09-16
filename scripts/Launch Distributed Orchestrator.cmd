@echo off
cd /d "%~dp0.."
wsl.exe --exec sh -c "cd \"$(wslpath -u \"%CD%\")\" && python3 scripts/launcher.py"
if errorlevel 1 (
  echo Install WSL2 Ubuntu, Python 3 with python3-tk, Node.js 22+, and WSLg first.
  pause
)
