@echo off
setlocal
chcp 65001 >nul <nul
cd /d "%~dp0"

set "HAS_CHECK="
set "HAS_NOWAIT="
set "HAS_AUTO="
:PARSE_ARGS
if "%~1"=="" goto :ARGS_DONE
if /i "%~1"=="--check" set "HAS_CHECK=1"
if /i "%~1"=="--no-wait" set "HAS_NOWAIT=1"
if /i "%~1"=="--auto" set "HAS_AUTO=1"
shift
goto :PARSE_ARGS

:ARGS_DONE
set "ANTIGRAVITY_EXE=%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe"
if not exist "%ANTIGRAVITY_EXE%" set "ANTIGRAVITY_EXE=%ProgramFiles%\Antigravity\Antigravity.exe"
if not exist "%ANTIGRAVITY_EXE%" set "ANTIGRAVITY_EXE=%ProgramFiles(x86)%\Antigravity\Antigravity.exe"
if not exist "%ANTIGRAVITY_EXE%" goto :TRY_NODE
set "ELECTRON_RUN_AS_NODE=1"
"%ANTIGRAVITY_EXE%" "%~dp0localization_engine.js" --brand-title english --launch %*
set "EXIT_CODE=%errorlevel%"
goto :DONE

:TRY_NODE
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"

where node >nul 2>nul
if %errorlevel% neq 0 goto :NO_RUNTIME
call node "%~dp0localization_engine.js" --brand-title english --launch %*
set "EXIT_CODE=%errorlevel%"
goto :DONE

:NO_RUNTIME
echo [ERROR] Antigravity or Node.js runtime not found.
echo Default path: %LOCALAPPDATA%\Programs\antigravity\Antigravity.exe
if defined HAS_NOWAIT exit 1
if defined HAS_AUTO exit 1
if defined HAS_CHECK exit /b 1
pause
exit 1

:DONE
if %EXIT_CODE% equ 0 (
    if defined HAS_CHECK exit /b %EXIT_CODE%
    exit %EXIT_CODE%
)
if %EXIT_CODE% equ 2 exit /b %EXIT_CODE%
if defined HAS_CHECK exit /b %EXIT_CODE%
if defined HAS_NOWAIT exit %EXIT_CODE%
if defined HAS_AUTO exit %EXIT_CODE%
echo.
pause
exit %EXIT_CODE%
