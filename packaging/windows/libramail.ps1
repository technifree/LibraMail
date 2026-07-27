$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeExe = Join-Path $AppDir 'runtime\node\node.exe'
$EngineFile = Join-Path $AppDir 'engine\backend.js'
$AppExe = Join-Path $AppDir 'libramail-app.exe'
$DataDir = Join-Path $AppDir 'data'
$OutLog = Join-Path $DataDir 'engine.stdout.log'
$ErrLog = Join-Path $DataDir 'engine.stderr.log'
$EngineLog = Join-Path $DataDir 'engine.log'

function Test-LocalPort([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $result = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $result.AsyncWaitHandle.WaitOne(150)) { return $false }
        $client.EndConnect($result)
        return $true
    }
    catch { return $false }
    finally { $client.Close() }
}

function Stop-EngineProcess {
    param([System.Diagnostics.Process]$Process)
    if (-not $Process) { return }
    try { $Process.Refresh() } catch { return }
    if ($Process.HasExited) { return }

    try {
        Stop-Process -Id $Process.Id -Force -ErrorAction Stop
        return
    }
    catch {}

    try {
        $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
        if (Test-Path -LiteralPath $taskkill) {
            & $taskkill /PID $Process.Id /T /F 2>$null | Out-Null
        }
    }
    catch {}
}

if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { throw "Runtime Node.js introuvable : $NodeExe" }
if (-not (Test-Path -LiteralPath $EngineFile -PathType Leaf)) { throw "Moteur LibraMail introuvable : $EngineFile" }
if (-not (Test-Path -LiteralPath $AppExe -PathType Leaf)) { throw "Application Neutralino introuvable : $AppExe" }
if (Test-LocalPort 47800) { throw 'Le port 47800 est déjà utilisé. Une autre instance de LibraMail est probablement ouverte.' }

New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
$EngineProcess = $null
try {
    Add-Content -LiteralPath $EngineLog -Encoding UTF8 -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Démarrage du moteur LibraMail"

    $EngineProcess = Start-Process -FilePath $NodeExe `
        -ArgumentList @($EngineFile) `
        -WorkingDirectory $AppDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $OutLog `
        -RedirectStandardError $ErrLog `
        -PassThru

    $Ready = $false
    for ($i = 0; $i -lt 200; $i++) {
        if (Test-LocalPort 47800) { $Ready = $true; break }
        $EngineProcess.Refresh()
        if ($EngineProcess.HasExited) {
            $details = if (Test-Path -LiteralPath $ErrLog) { Get-Content -LiteralPath $ErrLog -Tail 80 | Out-String } else { '' }
            throw "Le moteur LibraMail ne démarre pas.`r`n$details"
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $Ready) { throw "Délai dépassé pendant le démarrage du moteur. Consultez $ErrLog" }

    $AppProcess = Start-Process -FilePath $AppExe -WorkingDirectory $AppDir -PassThru
    $AppProcess.WaitForExit()
    $exitCode = $AppProcess.ExitCode
}
finally {
    Stop-EngineProcess -Process $EngineProcess
}

exit $exitCode
