@echo off
REM Inicia la caja en Windows. Doble clic para abrir.
cd /d "%~dp0"
node server.js %*
echo.
echo La caja se detuvo. Presiona una tecla para cerrar.
pause >nul
