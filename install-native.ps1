# This is the NATIVE installer (Node.js + optional Windows service).
# If you want Docker instead: docker compose up -d --build  (see README).

# Yellow body with a blue top-left shadow, mirroring the navbar logo style.
$esc = [char]27
$Y = "$esc[38;5;229m"
$B = "$esc[38;5;111m"
$R = "$esc[0m"
Write-Host "$B ▄▄   ▄▄ ▄▄▄▄▄ ▄▄▄▄  ▄▄▄▄▄$R"
Write-Host "$Y ██╗  ██╗$B▄$Y███████╗██████╗ ████████╗$R"
Write-Host "$Y ██║ ██╔╝██╔════╝██╔══██╗╚══██╔══╝$R"
Write-Host "$Y █████╔╝ █████╗  ██████╔╝   ██║   $R"
Write-Host "$Y ██╔═██╗ ██╔══╝  ██╔═══╝    ██║   $R"
Write-Host "$Y ██║  ██╗███████╗██║        ██║   $R"
Write-Host "$Y ╚═╝  ╚═╝╚══════╝╚═╝        ╚═╝   $R"
Write-Host ""
Write-Host "          ${Y}Kept Installer$R"
Write-Host "        ${B}www.keepitkept.xyz$R"
Write-Host ""

# Check Node version, install if missing
function Install-NodeJs {
    Write-Host "Node.js v24 not found. Attempting to install..." -ForegroundColor Yellow

    if (Get-Command "winget" -ErrorAction SilentlyContinue) {
        Write-Host "Installing via winget..."
        winget install -e --id OpenJS.NodeJS --version "24.*" --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -eq 0) {
            # winget updates PATH for new shells; refresh this session so node resolves immediately.
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
            return $true
        }
    }

    if (Get-Command "choco" -ErrorAction SilentlyContinue) {
        Write-Host "Installing via Chocolatey..."
        choco install nodejs --version=24.0.0 -y
        if ($LASTEXITCODE -eq 0) {
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
            return $true
        }
    }

    Write-Host "Error: Could not install Node.js automatically (winget and Chocolatey not found or failed). Install Node.js v24 manually from https://nodejs.org and rerun this script." -ForegroundColor Red
    return $false
}

if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) {
    if (-not (Install-NodeJs)) {
        Write-Host "Error: Node.js v24 install failed. The app requires Node.js v24.x; if your OS does not support an automated install, install it manually and rerun this script." -ForegroundColor Red
        exit 1
    }
}

$nodeVerString = (node -v)
$nodeVerMatch = [regex]::match($nodeVerString, "v(\d+)")
if ($nodeVerMatch.Success) {
    $nodeVer = [int]$nodeVerMatch.Groups[1].Value
    if ($nodeVer -lt 24) {
        Write-Host "Warning: Node.js v24 or higher is required. Found: $nodeVerString" -ForegroundColor Yellow
        Write-Host "Attempting to upgrade Node.js..." -ForegroundColor Yellow
        if (-not (Install-NodeJs)) {
            Write-Host "Could not upgrade Node.js automatically. Press Enter to continue with the current version anyway, or Ctrl+C to abort."
            Read-Host
        }
    }
}

Write-Host "1. Installing dependencies..." -ForegroundColor Green
npm install
if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed!" -ForegroundColor Red; exit $LASTEXITCODE }

Write-Host "2. Building the Angular application..." -ForegroundColor Green
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "npm run build failed!" -ForegroundColor Red; exit $LASTEXITCODE }

Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host "You can start the app manually at any time by running:"
Write-Host "$env:PORT=6767; npm run api" -ForegroundColor Yellow
Write-Host ""

$response = Read-Host "Would you like to install this as a Scheduled Task to run automatically on boot? (y/N)"
if ($response -match "^[Yy]$") {
    # Check for Admin rights
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    
    if (-not $isAdmin) {
        Write-Host "Error: You must run this script as Administrator to configure a Scheduled Task." -ForegroundColor Red
        Write-Host "Please open a new PowerShell window as Administrator and re-run this script." -ForegroundColor Yellow
        exit 1
    }

    $taskName = "GoogleKeepCloneAPI"
    $nodePath = (Get-Command "node").Source
    $scriptPath = Join-Path $PWD "server\server.js"
    $workingDir = $PWD.Path
    
    # We will use a small wrapper batch script to set the PORT environment variable before calling node
    $batPath = Join-Path $PWD "start-service.bat"
    Set-Content -Path $batPath -Value "@echo off`r`nset PORT=6767`r`nset NODE_ENV=production`r`n`"$nodePath`" `"$scriptPath`""
    
    Write-Host "Creating Scheduled Task '$taskName'..."
    
    # Remove existing task if it exists
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    
    $action = New-ScheduledTaskAction -Execute $batPath -WorkingDirectory $workingDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Description "Google Keep Clone API Server on port 6767" | Out-Null
    
    Write-Host "Starting the service now..."
    Start-ScheduledTask -TaskName $taskName
    
    Write-Host "Task installed and started! The application should be running at http://localhost:6767" -ForegroundColor Green
} else {
    Write-Host "Skipping automatic boot setup."
    Write-Host "The application is ready. Run "`$env:PORT=6767; npm run api`" to start."
}
