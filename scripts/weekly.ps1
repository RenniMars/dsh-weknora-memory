# Weekly WeKnora injection report (Windows PowerShell 5.1 compatible).
# Runs scripts/report.mjs --days 7 and APPENDS the result to
#   <repo>/reports/weekly-<yyyy-MM-dd>.txt
# Registered as scheduled task DSH-Memory-Weekly (every Monday 09:15); safe to run by hand.
# String building uses -f formatting on purpose: this host's parser splits an array literal
# that concatenates with + inside it, which turned the header into one line per fragment.
[CmdletBinding()]
param([int]$Days = 7)

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$reportDir = Join-Path (Split-Path -Parent $pluginRoot) 'reports'
$stamp = Get-Date -Format 'yyyy-MM-dd'
$outFile = Join-Path $reportDir ('weekly-{0}.txt' -f $stamp)

if (-not (Test-Path -LiteralPath $reportDir)) {
  New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'D:\basetools\node\node.exe' }
$report = Join-Path $pluginRoot 'scripts\report.mjs'
$logFile = Join-Path $pluginRoot 'logs\inject.log'

# report.mjs prints UTF-8; decode native stdout as UTF-8 so CJK survives into the file.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$body = & $node $report --days $Days 2>&1 | Out-String
$code = $LASTEXITCODE
$ErrorActionPreference = $prev

$header = @(
  ('=' * 62),
  ('WeKnora inject - weekly report (--days {0})' -f $Days),
  ('generated {0}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')),
  ('log {0}' -f $logFile),
  ('=' * 62)
) -join [Environment]::NewLine

$text = '{0}{1}{1}{2}{1}{1}' -f $header, [Environment]::NewLine, $body.TrimEnd()
[System.IO.File]::AppendAllText($outFile, $text, [System.Text.Encoding]::UTF8)

Write-Output ('appended -> {0}' -f $outFile)
exit $code
