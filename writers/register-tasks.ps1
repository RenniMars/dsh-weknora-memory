<#
  Registers the optional write-side scheduled tasks for this machine.

  Nothing here runs at install time: the plugin's read path works without any of it,
  and a task that writes into a knowledge base is a decision the user makes, not a
  side effect of an npm install.

    .\register-tasks.ps1              # register (or update) the tasks
    .\register-tasks.ps1 -Unregister  # remove them
    .\register-tasks.ps1 -Prefix WK   # rename the task group (default DSH-Memory)

  Tasks are registered for the current user only: no admin rights, no system-wide
  service. Times can be changed in -Times like @{ Ingest='hourly'; Distill='04:30'; Dream='03:30' }.
#>
[CmdletBinding()]
param(
  [switch]$Unregister,
  [string]$Prefix = 'DSH-Memory',
  [string]$Config = '',
  [hashtable]$Times = @{ Ingest = 'hourly'; Distill = '04:30'; Dream = '03:30' }
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction Stop).Source

$names = @{
  Ingest = "$Prefix-Session-Ingest"
  Distill = "$Prefix-Session-Distill"
  Dream = "$Prefix-Memory-Dream"
}

function Get-ArgList([string]$script) {
  # --config is only passed when the caller named one; the scripts find writer.config.json themselves.
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

# Hourly transcript ingest: one task per hour, starting now.
Register-WriterTask $names.Ingest (Get-ArgList 'ingest.mjs') (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 1)) 'DSH sessions -> WeKnora session KB (verbatim transcripts)'

# Nightly distillation of conclusions into the knowledge KB.
Register-WriterTask $names.Distill (Get-ArgList 'distill.mjs') (New-ScheduledTaskTrigger -Daily -At $Times.Distill) 'DSH sessions -> WeKnora knowledge KB (distilled conclusions)'

# Nightly dream: adjudicate fact cards, then let the profile writer review them.
$dreamArgs = (Get-ArgList 'dream.mjs') + @('--then-profile')
Register-WriterTask $names.Dream $dreamArgs (New-ScheduledTaskTrigger -Daily -At $Times.Dream) 'Adjudicate fact cards, then review the standing profile'

Write-Output ''
Write-Output 'Verify with: Get-ScheduledTask | Where-Object TaskName -like "' + $Prefix + '*"'
