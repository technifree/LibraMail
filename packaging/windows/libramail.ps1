#requires -version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeExe = Join-Path $AppDir 'runtime\node\node.exe'
$EngineFile = Join-Path $AppDir 'engine\backend.js'
$AppExe = Join-Path $AppDir 'libramail-app.exe'
$DataDir = Join-Path $AppDir 'data'
$LogFile = Join-Path $DataDir 'engine.log'
$EngineOut = Join-Path $DataDir 'engine.stdout.log'
$EngineErr = Join-Path $DataDir 'engine.stderr.log'
$EngineProcess = $null

function Fail($Message) {
    Write-Host $Message -ForegroundColor Red
    exit 1
}

function Test-PortOpen {
    param([int]$Port = 47800)
    $client = $null
    try {
        $client = New-Object Net.Sockets.TcpClient
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(150, $false)) { return $false }
        $client.EndConnect($async)
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($client) { $client.Close() }
    }
}

function Stop-EngineQuietly {
    if (-not $script:EngineProcess) { return }
    try { $script:EngineProcess.Refresh() } catch {}
    if ($script:EngineProcess.HasExited) { return }

    $pidText = [string]$script:EngineProcess.Id

    # Stop-Process suffit souvent pour Node. taskkill /T sert uniquement à nettoyer
    # d'éventuels enfants, mais ne doit jamais faire échouer la fermeture.
    try {
        Stop-Process -Id $script:EngineProcess.Id -Force -ErrorAction SilentlyContinue
    }
    catch {}

    Start-Sleep -Milliseconds 200

    try { $script:EngineProcess.Refresh() } catch {}
    if ($script:EngineProcess.HasExited) { return }

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $pidText /T /F *> $null
    }
    catch {}
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

try {
    Set-Location $AppDir
    if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { Fail "Erreur : runtime Node.js embarqué introuvable : $NodeExe" }
    if (-not (Test-Path -LiteralPath $EngineFile -PathType Leaf)) { Fail "Erreur : moteur LibraMail introuvable : $EngineFile" }
    if (-not (Test-Path -LiteralPath $AppExe -PathType Leaf)) { Fail "Erreur : exécutable Neutralino introuvable : $AppExe" }

    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

    if (Test-PortOpen -Port 47800) {
        Fail 'Erreur : le port 47800 est déjà utilisé. Une autre instance de LibraMail est probablement ouverte.'
    }

    Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Démarrage du moteur LibraMail"
    $EngineProcess = Start-Process `
        -FilePath $NodeExe `
        -ArgumentList @($EngineFile) `
        -WorkingDirectory $AppDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $EngineOut `
        -RedirectStandardError $EngineErr `
        -PassThru

    $ready = $false
    for ($i = 0; $i -lt 150; $i++) {
        if (Test-PortOpen -Port 47800) { $ready = $true; break }
        try { $EngineProcess.Refresh() } catch {}
        if ($EngineProcess.HasExited) {
            Write-Host "Le moteur LibraMail ne démarre pas. Consultez : $EngineErr" -ForegroundColor Red
            if (Test-Path -LiteralPath $EngineErr -PathType Leaf) {
                Get-Content -LiteralPath $EngineErr -Tail 40 -ErrorAction SilentlyContinue
            }
            exit 1
        }
        Start-Sleep -Milliseconds 100
    }

    if (-not $ready) {
        Fail "Délai dépassé pendant le démarrage du moteur. Consultez : $EngineErr"
    }

    & $AppExe @args
}
finally {
    Stop-EngineQuietly
}
