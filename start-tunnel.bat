@echo off
REM Inicia la caja y la publica en internet con un tunel de Cloudflare.
REM Los celulares entran con sus datos moviles; solo este PC necesita internet.
cd /d "%~dp0"
where cloudflared >nul 2>nul
if errorlevel 1 (
  echo Falta cloudflared. Instalalo una vez con:
  echo   winget install --id Cloudflare.cloudflared
  echo y vuelve a abrir este archivo.
  pause >nul
  exit /b 1
)
node server.js --tunnel %*
echo.
echo La caja se detuvo. Presiona una tecla para cerrar.
pause >nul
