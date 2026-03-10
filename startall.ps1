param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendEnvPath = Join-Path $projectRoot 'backend\.env'
$backendPath = Join-Path $projectRoot 'backend'
$frontendPath = Join-Path $projectRoot 'frontend'

function Test-JsonRpcReady {
    param(
        [string]$Uri = 'http://127.0.0.1:18545'
    )

    try {
        $body = '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
        $response = Invoke-RestMethod -Uri $Uri -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 2
        return [bool]$response.result
    }
    catch {
        return $false
    }
}

function Wait-JsonRpcReady {
    param(
        [int]$TimeoutSeconds = 30
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-JsonRpcReady) {
            return
        }
        Start-Sleep -Seconds 1
    }

    throw 'Timed out waiting for Hardhat JSON-RPC on http://127.0.0.1:18545.'
}

function Test-HttpReady {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri
    )

    try {
        $response = Invoke-WebRequest -Uri $Uri -Method Get -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    }
    catch {
        return $false
    }
}

function Wait-HttpReady {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri,
        [int]$TimeoutSeconds = 30,
        [string]$Label = 'service'
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-HttpReady -Uri $Uri) {
            return
        }
        Start-Sleep -Milliseconds 800
    }

    throw "Timed out waiting for $Label on $Uri."
}

function Start-ServiceWindow {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Service
    )

    $cmdLine = "title $($Service.Title) && cd /d `"$($Service.Path)`" && $($Service.Command)"

    if ($DryRun) {
        Write-Host "[$($Service.Name)] cmd.exe /k $cmdLine"
        return
    }

    Write-Host "Starting $($Service.Title)..."
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', $cmdLine | Out-Null
}

function Stop-ServiceWindow {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Service
    )

    $matchingProcesses = Get-Process -Name 'cmd' -ErrorAction SilentlyContinue | Where-Object {
        $_.MainWindowTitle -eq $Service.Title
    }

    if (-not $matchingProcesses) {
        Write-Host "No existing window found for $($Service.Title)."
        return
    }

    foreach ($process in $matchingProcesses) {
        if ($DryRun) {
            Write-Host "[$($Service.Name)] stop process $($process.Id) with title $($Service.Title)"
            continue
        }

        Write-Host "Stopping existing $($Service.Title) (PID $($process.Id))..."
        Stop-Process -Id $process.Id -Force
    }
}

function Stop-ServiceByPort {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Service
    )

    if (-not $Service.ContainsKey('Port')) {
        return
    }

    $port = [int]$Service.Port
    $listeners = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    if (-not $listeners) {
        Write-Host "No listening process found on port $port for $($Service.Title)."
        return
    }

    foreach ($listener in $listeners) {
        $processId = $listener.OwningProcess
        if ($DryRun) {
            Write-Host "[$($Service.Name)] stop process $processId on port $port"
            continue
        }

        Write-Host "Stopping process $processId on port $port for $($Service.Title)..."
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
}

function Run-BackendCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command
    )

    if ($DryRun) {
        Write-Host "[backend-task] cmd.exe /c title Backend - Deploy Contract && cd /d \"$backendPath\" && npm run $Command"
        return
    }

    Push-Location $backendPath
    try {
        Write-Host "Running backend task: $Command"
        npm run $Command
    }
    finally {
        Pop-Location
    }
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'npm was not found. Install Node.js and make sure npm is available in PATH.'
}

if (-not (Test-Path $backendEnvPath)) {
    Write-Warning 'backend/.env was not found. Configure backend/.env before starting the backend service.'
}

$pythonDetectorPath = Join-Path $projectRoot 'backend\python-services\image-detector'

$services = @(
    @{
        Name    = 'blockchain'
        Title   = 'Blockchain - Hardhat Local'
        Path    = $backendPath
        Command = 'npm run chain:node'
        Port    = 18545
    },
    @{
        Name    = 'detector'
        Title   = 'Image Detector - Python'
        Path    = $pythonDetectorPath
        Command = 'python detector_service.py'
        Port    = 5001
    },
    @{
        Name    = 'backend'
        Title   = 'Backend - Express API'
        Path    = $backendPath
        Command = 'npm run dev'
        Port    = 3000
    },
    @{
        Name    = 'frontend'
        Title   = 'Frontend - Vite'
        Path    = $frontendPath
        Command = 'npm run dev'
        Port    = 5173
    }
)

foreach ($service in $services) {
    if (-not (Test-Path $service.Path)) {
        throw "Directory not found: $($service.Path)"
    }
}

foreach ($service in $services) {
    Stop-ServiceWindow -Service $service
    Stop-ServiceByPort -Service $service
}

if (-not $DryRun) {
    Start-Sleep -Seconds 1
}

Start-ServiceWindow -Service $services[0]

if (-not $DryRun) {
    Wait-JsonRpcReady
}

Run-BackendCommand -Command 'chain:deploy:v2'
Run-BackendCommand -Command 'db:sync:role-permissions'
Run-BackendCommand -Command 'db:seed:demo-records'

Start-ServiceWindow -Service $services[1]
if (-not $DryRun) {
    Wait-HttpReady -Uri 'http://127.0.0.1:5001/health' -TimeoutSeconds 30 -Label 'image detector service'
}

Start-ServiceWindow -Service $services[2]
if (-not $DryRun) {
    Wait-HttpReady -Uri 'http://127.0.0.1:3000/health' -TimeoutSeconds 30 -Label 'backend API'
}

Start-ServiceWindow -Service $services[3]

if (-not $DryRun) {
    Wait-HttpReady -Uri 'http://127.0.0.1:5173/' -TimeoutSeconds 30 -Label 'frontend Vite server'
}

if (-not $DryRun) {
    Write-Host 'All services started: Blockchain, Image Detector, Backend API, and Frontend.'
}
