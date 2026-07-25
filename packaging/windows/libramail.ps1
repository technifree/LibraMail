$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeExe = Join-Path $AppDir 'runtime\node\node.exe'
$EngineFile = Join-Path $AppDir 'engine\backend.js'
$AppExe = Join-Path $AppDir 'libramail-app.exe'
$DataDir = Join-Path $AppDir 'data'
$OutLog = Join-Path $DataDir 'engine-console.log'
$ErrLog = Join-Path $DataDir 'engine-error.log'

function Test-LocalPort([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $result = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $result.AsyncWaitHandle.WaitOne(120)) { return $false }
        $client.EndConnect($result)
        return $true
    }
    catch { return $false }
    finally { $client.Close() }
}

if (-not (Test-Path -LiteralPath $NodeExe)) { throw "Runtime Node.js introuvable : $NodeExe" }
if (-not (Test-Path -LiteralPath $EngineFile)) { throw "Moteur LibraMail introuvable : $EngineFile" }
if (-not (Test-Path -LiteralPath $AppExe)) { throw "Application Neutralino introuvable : $AppExe" }
if (Test-LocalPort 47800) { throw 'Le port 47800 est déjà utilisé. Une autre instance de LibraMail est probablement ouverte.' }

New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
$EngineProcess = $null
try {
    $EngineProcess = Start-Process -FilePath $NodeExe `
        -ArgumentList ('"{0}"' -f $EngineFile) `
        -WorkingDirectory $AppDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $OutLog `
        -RedirectStandardError $ErrLog `
        -PassThru

    $Ready = $false
    for ($i = 0; $i -lt 150; $i++) {
        if (Test-LocalPort 47800) { $Ready = $true; break }
        if ($EngineProcess.HasExited) {
            $details = if (Test-Path -LiteralPath $ErrLog) { Get-Content -LiteralPath $ErrLog -Tail 40 | Out-String } else { '' }
            throw "Le moteur LibraMail ne démarre pas.`r`n$details"
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $Ready) { throw "Délai dépassé pendant le démarrage du moteur. Consultez $ErrLog" }

    $AppProcess = Start-Process -FilePath $AppExe -WorkingDirectory $AppDir -PassThru
    $AppProcess.WaitForExit()
    exit $AppProcess.ExitCode
}
finally {
    if ($EngineProcess -and -not $EngineProcess.HasExited) {
        & taskkill.exe /PID $EngineProcess.Id /T /F 2>$null | Out-Null
    }
}
