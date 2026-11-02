@echo off
rem Manual one-shot runner for the optional write-side tasks.
rem   run-all.cmd                run ingest, distill, dream, profile-writer in order
rem   run-all.cmd --dry-run      print the plan only (no DB write, no file write)
rem   run-all.cmd ingest         run one step only (ingest | distill | dream | profile)
setlocal
cd /d "%~dp0"

set "ARGS="
set "STEP="
:parse
if "%~1"=="" goto run
if /i "%~1"=="ingest"  (set "STEP=ingest"  & shift & goto parse)
if /i "%~1"=="distill" (set "STEP=distill" & shift & goto parse)
if /i "%~1"=="dream"   (set "STEP=dream"   & shift & goto parse)
if /i "%~1"=="profile" (set "STEP=profile" & shift & goto parse)
set "ARGS=%ARGS% %~1"
shift
goto parse

:run
set "RC=0"
if "%STEP%"=="" goto all
if /i "%STEP%"=="ingest"  goto do_ingest
if /i "%STEP%"=="distill" goto do_distill
if /i "%STEP%"=="dream"   goto do_dream
if /i "%STEP%"=="profile" goto do_profile

:all
call :do_ingest  || set "RC=%ERRORLEVEL%"
call :do_distill || set "RC=%ERRORLEVEL%"
call :do_dream   || set "RC=%ERRORLEVEL%"
goto end

:do_ingest
node ingest.mjs%ARGS%
exit /b %ERRORLEVEL%

:do_distill
node distill.mjs%ARGS%
exit /b %ERRORLEVEL%

:do_dream
node dream.mjs%ARGS% --then-profile
exit /b %ERRORLEVEL%

:do_profile
node profile-writer.mjs --review --write%ARGS%
exit /b %ERRORLEVEL%

:end
if not "%RC%"=="0" echo [run-all] one or more steps failed, rc=%RC%
exit /b %RC%
