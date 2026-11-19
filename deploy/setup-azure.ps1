<#
.SYNOPSIS
  One-time Azure setup for HobbySite: creates the website, the scheduled-scripts app,
  and a passwordless sign-in for GitHub Actions, then stores what GitHub needs.

.DESCRIPTION
  Creates (in one resource group):
    - App Service plan (Linux, B1) + Web App running Node 22      -> the website
    - Storage account + Function App on the Flex Consumption plan -> monitors + daily price sync
    - An Entra ID app registration with a federated credential   -> GitHub Actions can deploy
      without any stored password (OIDC), limited to the main branch of your repo
  Then sets every app setting (MongoDB, login, Telegram, schedules) and, if the GitHub CLI
  (gh) is installed and signed in, sets the repository variables the workflows read.

  Safe to re-run: existing resources are reused, and settings are overwritten with what you enter.

.EXAMPLE
  az login
  .\deploy\setup-azure.ps1
  .\deploy\setup-azure.ps1 -Location westus2 -Repo Emay08/HobbySite
#>
[CmdletBinding()]
param(
  [string]$Repo = 'Emay08/HobbySite',
  [string]$ResourceGroup = 'hobbysite-rg',
  [string]$Location = 'canadacentral',
  # Flex Consumption isn't in every region. List them with: az functionapp list-flexconsumption-locations -o table
  [string]$FunctionsLocation = '',
  [string]$AppSku = 'B1'
)

$ErrorActionPreference = 'Stop'
if (-not $FunctionsLocation) { $FunctionsLocation = $Location }

# ---------------------------------------------------------------- helpers

function Invoke-Az {
  # Runs az and returns its trimmed stdout. Warnings (stderr) go straight to the console so
  # they can't end up inside captured IDs. Throws if az fails.
  $ErrorActionPreference = 'Continue'   # Windows PowerShell 5.1 would otherwise abort on any stderr line
  $out = & az @args
  if ($LASTEXITCODE -ne 0) { throw "az $($args -join ' ') failed (see the error above)." }
  if ($out) { return ($out | Out-String).Trim() }
}

function Invoke-AzRetry {
  # Like Invoke-Az, but retries for up to ~2 minutes. Azure sometimes reports a resource it
  # created seconds ago as "not found" until the change has spread through its systems.
  $ErrorActionPreference = 'Continue'
  for ($attempt = 1; $attempt -le 8; $attempt++) {
    $out = & az @args
    if ($LASTEXITCODE -eq 0) { if ($out) { return ($out | Out-String).Trim() } else { return } }
    if ($attempt -lt 8) {
      Write-Host "  Azure isn't ready yet; retrying in 15 seconds ($attempt/7)..." -ForegroundColor DarkYellow
      Start-Sleep -Seconds 15
    }
  }
  throw "az $($args -join ' ') failed after several retries (see the error above)."
}

function Test-Az {
  # Runs az quietly and returns $true if it succeeded (used for "does this exist?" checks).
  $ErrorActionPreference = 'Continue'
  & az @args *> $null
  return ($LASTEXITCODE -eq 0)
}

function Write-JsonFile($object) {
  # Settings go through a temp file: the MongoDB URI (&) and bcrypt hash ($) would be
  # mangled if passed on the command line through az.cmd. Written without a BOM.
  $path = [System.IO.Path]::GetTempFileName()
  [System.IO.File]::WriteAllText($path, (ConvertTo-Json -InputObject $object -Depth 5))
  return $path
}

function Read-Value($prompt, [switch]$Secret, [string]$Default = '') {
  $label = if ($Default) { "$prompt [$Default]" } else { $prompt }
  if ($Secret) {
    $s = Read-Host $label -AsSecureString
    $v = [System.Net.NetworkCredential]::new('', $s).Password
  } else {
    $v = Read-Host $label
  }
  if (-not $v) { $v = $Default }
  return $v.Trim()
}

function New-Secret([int]$bytes = 48) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return [Convert]::ToBase64String($b)
}

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }

# ---------------------------------------------------------------- preflight

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw 'Azure CLI not found. Install it from https://aka.ms/installazurecliwindows, then run: az login'
}
if (-not (Test-Az account show)) { throw 'Not signed in to Azure. Run: az login' }

$subscriptionId = Invoke-Az account show --query id -o tsv
$tenantId       = Invoke-Az account show --query tenantId -o tsv
$subName        = Invoke-Az account show --query name -o tsv
Write-Host "Subscription: $subName ($subscriptionId)"
Write-Host "GitHub repo:  $Repo"

# Remember generated names between runs so re-running reuses the same apps.
$stateFile = Join-Path $PSScriptRoot '.azure-names.json'
if (Test-Path $stateFile) {
  $names = Get-Content $stateFile -Raw | ConvertFrom-Json
} else {
  $suffix = -join ((97..122) + (48..57) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
  $names = [pscustomobject]@{
    WebApp      = "hobbysite-$suffix"
    FunctionApp = "hobbysite-func-$suffix"
    Storage     = "hobbysitefn$suffix"
    Plan        = 'hobbysite-plan'
  }
  $names | ConvertTo-Json | Set-Content $stateFile
}

# ---------------------------------------------------------------- settings from you

Step 'Settings (press Enter to keep a default)'
Write-Host 'Your MongoDB Atlas connection string: Atlas > Database > Connect > Drivers.'
$mongoUri = Read-Value 'MONGODB_URI' -Secret
if (-not $mongoUri.StartsWith('mongodb')) { throw 'That does not look like a MongoDB connection string.' }
$mongoDb  = Read-Value 'Database name' -Default 'mtgo_manager'

Write-Host "`nSite login. Create the password hash first with:  cd web; npm install; npm run hash-password"
$adminUser = Read-Value 'Username' -Default 'me'
$adminHash = Read-Value 'ADMIN_PASSWORD_HASH (starts with $2a$ or $2b$)' -Secret
if ($adminHash -notmatch '^\$2[aby]\$\d\d\$') { throw 'That does not look like a bcrypt hash. Run npm run hash-password in the web folder.' }

Write-Host "`nTelegram (leave blank to skip; you can add them later in the Function App settings)."
$tgToken = Read-Value 'TELEGRAM_BOT_TOKEN' -Secret
$tgChat  = Read-Value 'TELEGRAM_CHAT_ID'

# ---------------------------------------------------------------- resource group

Step "Resource group $ResourceGroup ($Location)"
Invoke-Az group create -n $ResourceGroup -l $Location -o none

# ---------------------------------------------------------------- website

Step "Website: $($names.WebApp)"
if (-not (Test-Az appservice plan show -g $ResourceGroup -n $names.Plan)) {
  Invoke-Az appservice plan create -g $ResourceGroup -n $names.Plan --is-linux --sku $AppSku -o none
}
if (-not (Test-Az webapp show -g $ResourceGroup -n $names.WebApp)) {
  Invoke-Az webapp create -g $ResourceGroup -p $names.Plan -n $names.WebApp --runtime 'NODE:22-lts' -o none
}
Invoke-AzRetry webapp update -g $ResourceGroup -n $names.WebApp --https-only true -o none
$alwaysOn = if ($AppSku -in @('F1', 'FREE', 'D1', 'SHARED')) { 'false' } else { 'true' }   # free tiers don't support Always On
Invoke-AzRetry webapp config set -g $ResourceGroup -n $names.WebApp --startup-file 'npm start' --always-on $alwaysOn --min-tls-version 1.2 --ftps-state Disabled -o none

$webSettings = @(
  @{ name = 'NODE_ENV';                       value = 'production';   slotSetting = $false },
  @{ name = 'MONGODB_URI';                    value = $mongoUri;      slotSetting = $false },
  @{ name = 'MONGODB_DB';                     value = $mongoDb;       slotSetting = $false },
  @{ name = 'ADMIN_USERNAME';                 value = $adminUser;     slotSetting = $false },
  @{ name = 'ADMIN_PASSWORD_HASH';            value = $adminHash;     slotSetting = $false },
  @{ name = 'SESSION_SECRET';                 value = (New-Secret);   slotSetting = $false },
  @{ name = 'WATCH_ALERT_PCT';                value = '15';           slotSetting = $false },
  # The GitHub workflow ships node_modules already installed, so App Service shouldn't rebuild.
  @{ name = 'SCM_DO_BUILD_DURING_DEPLOYMENT'; value = 'false';        slotSetting = $false }
)
$tmp = Write-JsonFile $webSettings
try { Invoke-AzRetry webapp config appsettings set -g $ResourceGroup -n $names.WebApp --settings "@$tmp" -o none }
finally { Remove-Item $tmp -Force }

# ---------------------------------------------------------------- functions

Step "Scheduled scripts: $($names.FunctionApp) (Flex Consumption, $FunctionsLocation)"
if (-not (Test-Az storage account show -g $ResourceGroup -n $names.Storage)) {
  Invoke-Az storage account create -g $ResourceGroup -n $names.Storage -l $FunctionsLocation --sku Standard_LRS --allow-blob-public-access false -o none
}
if (-not (Test-Az functionapp show -g $ResourceGroup -n $names.FunctionApp)) {
  Invoke-Az functionapp create -g $ResourceGroup -n $names.FunctionApp --storage-account $names.Storage `
    --flexconsumption-location $FunctionsLocation --runtime node --runtime-version 22 -o none
}

$fnSettings = @(
  @{ name = 'MONGODB_URI';          value = $mongoUri;            slotSetting = $false },
  @{ name = 'MONGODB_DB';           value = $mongoDb;             slotSetting = $false },
  @{ name = 'MONITOR_SCHEDULE';     value = '0 */30 * * * *';     slotSetting = $false },
  @{ name = 'PRICE_SYNC_SCHEDULE';  value = '0 20 10 * * *';      slotSetting = $false },
  @{ name = 'WATCH_ALERT_PCT';      value = '15';                 slotSetting = $false }
)
if ($tgToken) { $fnSettings += @{ name = 'TELEGRAM_BOT_TOKEN'; value = $tgToken; slotSetting = $false } }
if ($tgChat)  { $fnSettings += @{ name = 'TELEGRAM_CHAT_ID';   value = $tgChat;  slotSetting = $false } }
$tmp = Write-JsonFile $fnSettings
try { Invoke-AzRetry functionapp config appsettings set -g $ResourceGroup -n $names.FunctionApp --settings "@$tmp" -o none }
finally { Remove-Item $tmp -Force }

# ---------------------------------------------------------------- GitHub -> Azure sign-in (OIDC)

Step 'Passwordless sign-in for GitHub Actions'
$appName = "github-$($Repo.Replace('/', '-'))-deploy"
$clientId = Invoke-Az ad app list --display-name $appName --query '[0].appId' -o tsv
if (-not $clientId) {
  $clientId = Invoke-Az ad app create --display-name $appName --query appId -o tsv
}
if (-not (Test-Az ad sp show --id $clientId)) {
  Invoke-Az ad sp create --id $clientId -o none
  Start-Sleep -Seconds 15   # give Entra ID a moment before assigning a role
}

$subject = "repo:${Repo}:ref:refs/heads/main"
$subjects = @((Invoke-Az ad app federated-credential list --id $clientId --query '[].subject' -o tsv) -split "`r?`n")
if ($subjects -notcontains $subject) {
  $fc = Write-JsonFile @{
    name      = 'github-main'
    issuer    = 'https://token.actions.githubusercontent.com'
    subject   = $subject
    audiences = @('api://AzureADTokenExchange')
  }
  try { Invoke-Az ad app federated-credential create --id $clientId --parameters "@$fc" -o none }
  finally { Remove-Item $fc -Force }
}

# Deploy rights on this resource group only.
$scope = "/subscriptions/$subscriptionId/resourceGroups/$ResourceGroup"
$hasRole = Invoke-Az role assignment list --assignee $clientId --scope $scope --role Contributor --query '[].id' -o tsv
if (-not $hasRole) {
  $assigned = $false
  for ($i = 0; $i -lt 6 -and -not $assigned; $i++) {
    # A brand-new app identity can take a minute to become visible; retry.
    $assigned = Test-Az role assignment create --assignee $clientId --role Contributor --scope $scope -o none
    if (-not $assigned) { Start-Sleep -Seconds 10 }
  }
  if (-not $assigned) { throw "Couldn't give the GitHub deploy identity access to $ResourceGroup. Re-run the script in a minute." }
}

# ---------------------------------------------------------------- GitHub repository variables

$vars = [ordered]@{
  AZURE_CLIENT_ID        = $clientId
  AZURE_TENANT_ID        = $tenantId
  AZURE_SUBSCRIPTION_ID  = $subscriptionId
  AZURE_RESOURCE_GROUP   = $ResourceGroup
  AZURE_WEBAPP_NAME      = $names.WebApp
  AZURE_FUNCTIONAPP_NAME = $names.FunctionApp
}

Step 'GitHub repository variables'
$ghOk = $false
if (Get-Command gh -ErrorAction SilentlyContinue) {
  $ErrorActionPreference = 'Continue'
  & gh auth status *> $null
  $ghOk = ($LASTEXITCODE -eq 0)
}
if ($ghOk) {
  foreach ($k in $vars.Keys) {
    & gh variable set $k --body $vars[$k] --repo $Repo *> $null
    if ($LASTEXITCODE -ne 0) { Write-Warning "Could not set $k with gh"; $ghOk = $false } else { Write-Host "  set $k" }
  }
}
if (-not $ghOk) {
  Write-Host "Add these at https://github.com/$Repo/settings/variables/actions (Variables tab, not Secrets):" -ForegroundColor Yellow
  foreach ($k in $vars.Keys) { Write-Host ("  {0,-24} {1}" -f $k, $vars[$k]) }
}

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- summary

$webHost = Invoke-AzRetry webapp show -g $ResourceGroup -n $names.WebApp --query defaultHostName -o tsv
$webIps  = Invoke-AzRetry webapp show -g $ResourceGroup -n $names.WebApp --query possibleOutboundIpAddresses -o tsv

Step 'Done'
Write-Host "Website (after the first deploy):  https://$webHost"
Write-Host "Function App:                      $($names.FunctionApp)"
Write-Host ''
Write-Host 'MongoDB Atlas > Network Access must let Azure in:' -ForegroundColor Yellow
Write-Host "  - the website's outbound IPs: $webIps"
Write-Host '  - the Flex Consumption scripts have no fixed IPs, so they need 0.0.0.0/0'
Write-Host '    (the database user and password still protect the data).'
Write-Host ''
Write-Host 'Next: commit and push to main. The two workflows in .github/workflows deploy everything;'
Write-Host "watch them at https://github.com/$Repo/actions"
