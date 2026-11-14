<#
  Registers the optional write-side scheduled tasks for this machine.

  Nothing here runs at install time: the plugin's read path works without any of it,
  and a task that writes into a knowledge base is a decision the user makes, not a
  side effect of an npm install.

    .\register-tasks.ps1              # register (or update) the tasks
    .\register-tasks.ps1 -Unregister  # remove them
    .\register-tasks.ps1 -Prefix WK   # rename the task group (default DSH: takes over the old DSH-Session-* tasks by name)

  Tasks are registered for the current user only: no admin rights, no system-wide
  service. Times come from the shared config's writers.tasks (ingest: hourly|every6h,
  distill/dream: HH:MM); -Times @{...} overrides them for one run, -Force registers even
  when writers.enabled is still false.
#>
[CmdletBinding()]
param(
  [switch]$Unregister,
  [string]$Prefix = 'DSH',
  [string]$Config = '',
  [hashtable]$Times = @{},
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# pwsh 里 node 常常不在 PATH（尤其是从快捷方式起的窗口），所以三级回退：环境变量 → PATH → 本机固定路径。
$node = $env:NODE_EXE
if (-not $node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source }
  elseif (Test-Path 'D:/basetools/node/node.exe') { $node = 'D:/basetools/node/node.exe' }
  else { throw 'node not found: set NODE_EXE to the node.exe path' }
}

# 时间与开关都从共享配置的 writers 段来：一个文件管四件事，别在这里再写死一份。
$effective = @{ ingest = 'hourly'; distill = '00:00'; dream = '00:30' }
$enabled = $false
try {
  $jsonArgs = @((Join-Path $here 'print-config.mjs'), '--json')
  if ($Config) { $jsonArgs += @('--config', $Config) }
  $resolved = (& $node @jsonArgs) | ConvertFrom-Json
  if ($resolved.tasks) {
    foreach ($key in @('ingest', 'distill', 'dream')) {
      if ($resolved.tasks.$key) { $effective[$key] = [string]$resolved.tasks.$key }
    }
  }
  $enabled = [bool]$resolved.enabled
} catch {
  Write-Output "warning: 读不到配置文件里的 writers 段，按默认时间注册（$($_.Exception.Message)）"
}
if ($Times) {
  foreach ($key in $Times.Keys) { $effective[$key.ToLower()] = [string]$Times[$key] }
}
if (-not $Unregister -and -not $enabled -and -not $Force) {
  Write-Output '写入侧还没打开：配置文件里的 writers.enabled 是 false。'
  Write-Output '先去配置里把它改成 true（顺便填 kbs 的三个库 id），或者加 -Force 硬注册。'
  return
}

$names = @{
  Ingest = "$Prefix-Session-Ingest"
  Distill = "$Prefix-Session-Distill"
  Dream = "$Prefix-Memory-Dream"
}

function Get-ArgList([string]$script) {
  # --config is only passed when the caller named one; otherwise the scripts read the shared config.
  if ($Config) { return @($script, '--config', $Config) }
  return @($script)
}

if ($Unregister) {
  foreach ($name in $names.Values) {
    $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($existing) {
      Unregister-ScheduledTask -TaskName $name -Confirm:$false
      Write-Output "removed $name"
    } else {
      Write-Output "not present $name"
    }
  }
  return
}

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)

function Register-WriterTask([string]$name, [string[]]$arguments, $trigger, [string]$description) {
  $action = New-ScheduledTaskAction -Execute $node -Argument ($arguments -join ' ') -WorkingDirectory $here
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description $description -Force | Out-Null
  Write-Output "registered $name -> node $($arguments -join ' ')"
}

# Hourly transcript ingest: one task per hour (or every<N>h / every<N>m) starting soon.
function New-IngestTrigger([string]$spec) {
  if (-not $spec -or $spec -eq 'hourly') {
    return New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 1)
  }
  # every6h / every30m are accepted too, so changing the cadence never needs a script edit.
  if ($spec -match '^every([0-9]+)([hm])$') {
    $count = [int]$Matches[1]
    $span = if ($Matches[2] -eq 'h') { New-TimeSpan -Hours $count } else { New-TimeSpan -Minutes $count }
    return New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval $span
  }
  throw "writers.tasks.ingest accepts hourly / everyNh / everyNm, got: " + $spec
}
Register-WriterTask $names.Ingest (Get-ArgList 'ingest.mjs') (New-IngestTrigger $effective.ingest) 'DSH sessions -> WeKnora session KB (verbatim transcripts)'

# Nightly distillation of conclusions into the knowledge KB.
Register-WriterTask $names.Distill (Get-ArgList 'distill.mjs') (New-ScheduledTaskTrigger -Daily -At $effective.distill) 'DSH sessions -> WeKnora knowledge KB (distilled conclusions)'

# Nightly dream: adjudicate fact cards, then let the profile writer review them.
$dreamArgs = (Get-ArgList 'dream.mjs') + @('--then-profile')
Register-WriterTask $names.Dream $dreamArgs (New-ScheduledTaskTrigger -Daily -At $effective.dream) 'Adjudicate fact cards, then review the standing profile'

Write-Output ''
Write-Output 'Verify with: Get-ScheduledTask | Where-Object TaskName -like "' + $Prefix + '*"'