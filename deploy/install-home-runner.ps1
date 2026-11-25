<#
  Installs the Vault home runner on this PC (hobbymini) as a scheduled task that starts at
  boot, runs whether or not you're signed in, and restarts itself if it stops.

  Run once, from the repo, in a PowerShell window opened with "Run as administrator":
      cd C:\git\hobbysite
      .\deploy\install-home-runner.ps1

  If functions\local.settings.json doesn't exist yet, it's created from the Function App's
  settings (needs `az login`). It holds your MongoDB and Telegram secrets and git ignores it.

  To remove:  Unregister-ScheduledTask -TaskName 'Vault home runner' -Confirm:$false
#>
param(
    [string]$ResourceGroup = 'hobbysite-rg',
    [string]$FunctionApp = 'hobbysite-func-6xrma0'
)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$functions = Join-Path $repo 'functions'
$taskName = 'Vault home runner'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Open PowerShell with "Run as administrator" and run this again (needed to create a task that starts at boot).' }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js was not found. Install Node 22 from https://nodejs.org and open a new PowerShell window.' }

# 1. Packages
Push-Location $functions
if (-not (Test-Path 'node_modules')) { npm install --no-audit --no-fund }

# 2. Settings
$settings = Join-Path $functions 'local.settings.json'
if (-not (Test-Path $settings)) {
    Write-Host 'Creating functions\local.settings.json from the Function App settings...'
    $all = az functionapp config appsettings list -g $ResourceGroup -n $FunctionApp | ConvertFrom-Json
    if (-not $all) { throw 'Could not read the Function App settings. Run "az login" and try again.' }
    $skip = '^(AzureWebJobs|FUNCTIONS_|APPLICATIONINSIGHTS|APPINSIGHTS|WEBSITE_|DEPLOYMENT_|SCM_)'
    $values = [ordered]@{}
    foreach ($s in $all) { if ($s.name -notmatch $skip) { $values[$s.name] = $s.value } }
    if (-not $values.Contains('MONGODB_URI')) { throw 'MONGODB_URI is not among the Function App settings.' }
    @{ IsEncrypted = $false; Values = $values } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $settings
    Write-Host "  copied $($values.Count) settings"
}

# 3. Quick test: one tick (writes the heartbeat, checks the two mtgo.com pages if they're due)
Write-Host 'Testing one tick...'
& $node scripts/home-runner.js --once
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'The test tick failed; see the messages above.' }
Pop-Location

# 4. The scheduled task
$loop = Join-Path $repo 'deploy\home-runner-loop.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$loop`" -Node `"$node`"" `
    -WorkingDirectory $functions
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $taskSettings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host ''
Write-Host "Installed and started '$taskName'."
Write-Host "  Log:     $functions\logs\home-runner.log"
Write-Host '  Status:  Highlights -> Monitors on the website ("Home runner")'
Write-Host '  Keep this PC from sleeping: Settings -> System -> Power -> Sleep: Never (when plugged in).'
