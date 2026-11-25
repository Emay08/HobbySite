# Keeps the Vault home runner going (started by the "Vault home runner" scheduled task).
# Restarts it 10 seconds after it stops: after a crash, or after it exits by itself
# because a git pull changed its code. Output goes to functions\logs\home-runner.log.
param([string]$Node = 'node')

$functions = Join-Path $PSScriptRoot '..\functions' | Resolve-Path
Set-Location $functions
$logs = Join-Path $functions 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$log = Join-Path $logs 'home-runner.log'

while ($true) {
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) {
        Move-Item $log "$log.old" -Force
    }
    & $Node scripts/home-runner.js *>> $log
    Add-Content $log "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  (runner exited with code $LASTEXITCODE; restarting in 10 s)"
    Start-Sleep -Seconds 10
}
