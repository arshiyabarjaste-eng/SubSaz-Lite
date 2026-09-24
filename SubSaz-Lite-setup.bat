@echo off
title SubSaz Lite - Setup Helper
echo ============================================
echo  SubSaz Lite - CEP Setup Helper
echo ============================================
echo.

rem -- 1) Copy panel into CEP extensions (if it sits next to this .bat)
if exist "%~dp0com.srt2graphics.panel" (
    if not exist "%AppData%\Adobe\CEP\extensions" mkdir "%AppData%\Adobe\CEP\extensions"
    echo Copying panel to: %AppData%\Adobe\CEP\extensions
    xcopy "%~dp0com.srt2graphics.panel" "%AppData%\Adobe\CEP\extensions\com.srt2graphics.panel\" /E /I /Y >nul
    echo   [OK] panel copied
) else (
    echo [SKIP] com.srt2graphics.panel not found next to this .bat
    echo        (put this .bat inside the extracted SubSaz-Lite folder)
)

echo.

rem -- 2) Enable CEP debug mode for all common Premiere versions (HKCU = no admin needed)
echo Setting PlayerDebugMode=1 ...
reg add "HKCU\Software\Adobe\CSXS.9"  /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
reg add "HKCU\Software\Adobe\CSXS.10" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
reg add "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
reg add "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
echo   [OK] registry set for CSXS.9 / 10 / 11 / 12

echo.
echo ============================================
echo  DONE.
echo  1) Close Premiere COMPLETELY
echo  2) Reopen Premiere
echo  3) Window ^> Extensions ^> SubSaz Lite
echo ============================================
pause
