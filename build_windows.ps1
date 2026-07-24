#requires -version 5.1
<#
LibraMail — construction d'un paquet Windows x64 autonome

Le paquet final embarque son propre node.exe et les dépendances npm de
production. Aucun Node.js installé n'est requis sur le poste cible.

Usage :
  .\build_windows.bat
  .\build_windows.bat --with-data
  .\build_windows.bat --fresh-npm
  .\build_windows.bat --with-data --fresh-npm
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WithData = $false
$FreshNpm = $false
$EmbedResources = $false
$Offline = $false
$KeepWork = $false
$NodeVersion = if ($env:LIBRAMAIL_NODE_VERSION) { $env:LIBRAMAIL_NODE_VERSION } else { '24.18.0' }
$NodeMirror = if ($env:LIBRAMAIL_NODE_MIRROR) { $env:LIBRAMAIL_NODE_MIRROR.TrimEnd('/') } else { 'https://nodejs.org/dist' }

function Show-Usage {
@'
LibraMail — construction Windows autonome

Options :
  --with-data             Inclut data\ dans le paquet final.
                          Attention : comptes, mots de passe et messages seront
                          présents dans l'archive privée.
  --fresh-npm             Réinstalle les dépendances de production avec le
                          Node.js Windows embarqué.
  --embed-resources       Intègre resources.neu dans l'exécutable Neutralino.
  --node-version VERSION  Version officielle de Node.js à embarquer.
                          Valeur par défaut : 24.18.0
  --offline               Interdit les téléchargements. Le cache doit être prêt.
  --keep-work             Conserve .build-windows-work pour diagnostic.
  -h, --help              Affiche cette aide.

Variables facultatives :
  LIBRAMAIL_NODE_VERSION
  LIBRAMAIL_NODE_MIRROR
'@
}

for ($i = 0; $i -lt $args.Count; $i++) {
    switch -Regex ($args[$i]) {
        '^--with-data$'       { $WithData = $true; continue }
        '^--fresh-npm$'       { $FreshNpm = $true; continue }
        '^--embed-resources$' { $EmbedResources = $true; continue }
        '^--offline$'         { $Offline = $true; continue }
        '^--keep-work$'       { $KeepWork = $true; continue }
        '^--node-version=(.+)$' { $NodeVersion = $Matches[1]; continue }
        '^--node-version$' {
            $i++
            if ($i -ge $args.Count) { throw 'Valeur manquante après --node-version.' }
            $NodeVersion = $args[$i]
            continue
        }
        '^(-h|--help)$' { Show-Usage; exit 0 }
        default { throw "Option inconnue : $($args[$i])" }
    }
}

if ($NodeVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version Node.js invalide : $NodeVersion"
}

function Write-Build([string]$Message) { Write-Host "[build] $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message)    { Write-Host "[ OK  ] $Message" -ForegroundColor Green }
function Write-Warn([string]$Message)  { Write-Warning $Message }
function Require-File([string]$RelativePath) {
    $full = Join-Path $ProjectDir $RelativePath
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "Fichier introuvable : $RelativePath" }
}
function Require-Directory([string]$RelativePath) {
    $full = Join-Path $ProjectDir $RelativePath
    if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw "Dossier introuvable : $RelativePath" }
}
function Ensure-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
}
function Copy-DirectoryContents([string]$Source, [string]$Destination) {
    Ensure-Directory $Destination
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }
}
function Invoke-Checked([string]$FilePath, [string[]]$ArgumentList, [string]$WorkingDirectory = $ProjectDir) {
    Push-Location $WorkingDirectory
    try {
        & $FilePath @ArgumentList
        if ($LASTEXITCODE -ne 0) {
            throw "La commande a échoué avec le code $LASTEXITCODE : $FilePath $($ArgumentList -join ' ')"
        }
    }
    finally { Pop-Location }
}
function Download-File([string]$Url, [string]$Destination) {
    if ($Offline) { throw "Mode hors ligne : fichier absent du cache : $Destination" }
    Ensure-Directory (Split-Path -Parent $Destination)
    $temporary = "$Destination.part"
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    Write-Build "Téléchargement : $Url"
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $temporary
    if (-not (Test-Path -LiteralPath $temporary) -or (Get-Item -LiteralPath $temporary).Length -eq 0) {
        throw "Téléchargement vide : $Url"
    }
    Move-Item -LiteralPath $temporary -Destination $Destination -Force
}

Require-File 'neutralino.config.json'
Require-File 'resources\index.html'
Require-File 'engine\backend.js'
Require-Directory 'resources'
Require-Directory 'engine'

$ConfigPath = Join-Path $ProjectDir 'neutralino.config.json'
$Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$Version = if ($Config.version) { [string]$Config.version } else { '0.0.0' }
$BinaryName = if ($Config.cli -and $Config.cli.binaryName) { [string]$Config.cli.binaryName } else { 'libramail' }

$NodeArchive = "node-v$NodeVersion-win-x64.zip"
$NodeFolder = "node-v$NodeVersion-win-x64"
$NodeReleaseUrl = "$NodeMirror/v$NodeVersion"
$CacheDir = Join-Path $ProjectDir ".cache\libramail-node\v$NodeVersion"
$NodeArchivePath = Join-Path $CacheDir $NodeArchive
$NodeShasumsPath = Join-Path $CacheDir 'SHASUMS256.txt'

$WorkDir = Join-Path $ProjectDir '.build-windows-work'
$NodeExtractDir = Join-Path $WorkDir 'node-runtime-source'
$NodeDistDir = Join-Path $NodeExtractDir $NodeFolder
$NodeExe = Join-Path $NodeDistDir 'node.exe'
$NpmCli = Join-Path $NodeDistDir 'node_modules\npm\bin\npm-cli.js'
$NpxCli = Join-Path $NodeDistDir 'node_modules\npm\bin\npx-cli.js'
$NeuDist = Join-Path $WorkDir 'neutralino-dist'
$PackageName = "LibraMail-$Version-windows-x86_64"
$PackageDir = Join-Path $WorkDir $PackageName
$OutputDir = Join-Path $ProjectDir 'build\windows'
$ConfigBackup = Join-Path $WorkDir 'neutralino.config.original.json'
$ConfigPatched = $false

function Restore-ProjectConfig {
    if ($ConfigPatched -and (Test-Path -LiteralPath $ConfigBackup)) {
        Copy-Item -LiteralPath $ConfigBackup -Destination $ConfigPath -Force
        $script:ConfigPatched = $false
    }
}

try {
    Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
    Ensure-Directory $CacheDir
    Ensure-Directory $NodeExtractDir
    Ensure-Directory $NeuDist
    Ensure-Directory $PackageDir
    Ensure-Directory $OutputDir

    if (-not (Test-Path -LiteralPath $NodeShasumsPath)) {
        Download-File "$NodeReleaseUrl/SHASUMS256.txt" $NodeShasumsPath
    }
    if (-not (Test-Path -LiteralPath $NodeArchivePath)) {
        Download-File "$NodeReleaseUrl/$NodeArchive" $NodeArchivePath
    }

    $checksumLine = Get-Content -LiteralPath $NodeShasumsPath | Where-Object {
        $_ -match ("\s" + [regex]::Escape($NodeArchive) + '$')
    } | Select-Object -First 1
    if (-not $checksumLine) { throw "$NodeArchive n'est pas référencé dans SHASUMS256.txt." }
    $expectedHash = (($checksumLine -split '\s+')[0]).ToLowerInvariant()
    $actualHash = (Get-FileHash -LiteralPath $NodeArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        if ($Offline) { throw "Somme SHA-256 invalide pour l'archive Node.js en cache." }
        Write-Warn 'Archive Node.js invalide. Nouveau téléchargement.'
        Remove-Item -LiteralPath $NodeArchivePath, $NodeShasumsPath -Force -ErrorAction SilentlyContinue
        Download-File "$NodeReleaseUrl/SHASUMS256.txt" $NodeShasumsPath
        Download-File "$NodeReleaseUrl/$NodeArchive" $NodeArchivePath
        $checksumLine = Get-Content -LiteralPath $NodeShasumsPath | Where-Object {
            $_ -match ("\s" + [regex]::Escape($NodeArchive) + '$')
        } | Select-Object -First 1
        $expectedHash = (($checksumLine -split '\s+')[0]).ToLowerInvariant()
        $actualHash = (Get-FileHash -LiteralPath $NodeArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) { throw 'Échec de la vérification SHA-256 de Node.js.' }
    }
    Write-Ok "Archive Node.js $NodeVersion vérifiée."

    Expand-Archive -LiteralPath $NodeArchivePath -DestinationPath $NodeExtractDir -Force
    if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { throw "node.exe absent après extraction : $NodeExe" }
    if (-not (Test-Path -LiteralPath $NpmCli -PathType Leaf)) { throw 'npm est absent de la distribution Node.js.' }
    if (-not (Test-Path -LiteralPath $NpxCli -PathType Leaf)) { throw 'npx est absent de la distribution Node.js.' }
    $ActualNodeVersion = (& $NodeExe --version).Trim()
    if ($ActualNodeVersion -ne "v$NodeVersion") { throw "Version Node.js inattendue : $ActualNodeVersion" }
    $env:Path = "$NodeDistDir;$env:Path"
    Write-Ok "Moteur de construction : Node.js $ActualNodeVersion (Windows x64)."

    Copy-Item -LiteralPath $ConfigPath -Destination $ConfigBackup -Force
    $ConfigPatched = $true
    $PatchedConfig = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $PatchedConfig.cli) { $PatchedConfig | Add-Member -MemberType NoteProperty -Name cli -Value ([pscustomobject]@{}) }
    $PatchedConfig.cli | Add-Member -MemberType NoteProperty -Name distributionPath -Value '.build-windows-work/neutralino-dist' -Force
    if (-not $PatchedConfig.modes) { $PatchedConfig | Add-Member -MemberType NoteProperty -Name modes -Value ([pscustomobject]@{}) }
    if (-not $PatchedConfig.modes.window) { $PatchedConfig.modes | Add-Member -MemberType NoteProperty -Name window -Value ([pscustomobject]@{}) }
    $PatchedConfig.modes.window | Add-Member -MemberType NoteProperty -Name title -Value "LibraMail $Version" -Force
    $PatchedConfig | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8

    $BuildArguments = @('build')
    if ($EmbedResources) { $BuildArguments += '--embed-resources' }
    $LocalNeu = Join-Path $ProjectDir 'node_modules\.bin\neu.cmd'
    $GlobalNeu = Get-Command 'neu.cmd' -ErrorAction SilentlyContinue
    if (-not $GlobalNeu) { $GlobalNeu = Get-Command 'neu' -ErrorAction SilentlyContinue }

    Write-Build "Construction Neutralino $Version pour Windows x64..."
    if (Test-Path -LiteralPath $LocalNeu) {
        Invoke-Checked $LocalNeu $BuildArguments
    }
    elseif ($GlobalNeu) {
        Invoke-Checked $GlobalNeu.Source $BuildArguments
    }
    else {
        Write-Warn 'neu CLI absent. Utilisation de npx avec le Node.js embarqué.'
        Invoke-Checked $NodeExe (@($NpxCli, '--yes', '@neutralinojs/neu') + $BuildArguments)
    }
    Restore-ProjectConfig

    $ExpectedNeuBinary = Join-Path $NeuDist "$BinaryName-win_x64.exe"
    $NeuBinary = $null
    if (Test-Path -LiteralPath $ExpectedNeuBinary -PathType Leaf) {
        $NeuBinary = Get-Item -LiteralPath $ExpectedNeuBinary
    }
    else {
        $Candidates = Get-ChildItem -LiteralPath $NeuDist -Recurse -File -Filter '*-win_x64.exe' | Sort-Object FullName
        if (-not $Candidates) {
            Write-Warn "Binaire attendu absent : $ExpectedNeuBinary"
            Get-ChildItem -LiteralPath $NeuDist -Recurse -File | ForEach-Object {
                Write-Host "  - $($_.FullName.Substring($NeuDist.Length).TrimStart('\'))"
            }
            throw 'Aucun binaire Neutralino Windows x64 trouvé.'
        }
        $NeuBinary = $Candidates | Where-Object { $_.Name.ToLowerInvariant() -eq "$BinaryName-win_x64.exe".ToLowerInvariant() } | Select-Object -First 1
        if (-not $NeuBinary) { $NeuBinary = $Candidates | Select-Object -First 1 }
        Write-Warn "Nom Neutralino différent de la valeur attendue : $($NeuBinary.Name)"
    }
    Copy-Item -LiteralPath $NeuBinary.FullName -Destination (Join-Path $PackageDir 'libramail-app.exe') -Force
    Write-Ok "Binaire Neutralino : $($NeuBinary.Name)"

    if (-not $EmbedResources) {
        $ResourcesNeu = Join-Path $NeuDist 'resources.neu'
        if (-not (Test-Path -LiteralPath $ResourcesNeu)) {
            $ResourceCandidate = Get-ChildItem -LiteralPath $NeuDist -Recurse -File -Filter 'resources.neu' | Select-Object -First 1
            if (-not $ResourceCandidate) { throw "resources.neu n'a pas été généré." }
            $ResourcesNeu = $ResourceCandidate.FullName
        }
        Copy-Item -LiteralPath $ResourcesNeu -Destination (Join-Path $PackageDir 'resources.neu') -Force
        Write-Ok 'Ressources Neutralino intégrées au paquet.'
    }

    Write-Build 'Intégration du runtime Node.js Windows...'
    $RuntimeNodeDir = Join-Path $PackageDir 'runtime\node'
    Ensure-Directory $RuntimeNodeDir
    Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $RuntimeNodeDir 'node.exe') -Force
    $NodeLicense = Join-Path $NodeDistDir 'LICENSE'
    if (Test-Path -LiteralPath $NodeLicense) { Copy-Item -LiteralPath $NodeLicense -Destination (Join-Path $RuntimeNodeDir 'LICENSE') -Force }
    Set-Content -LiteralPath (Join-Path $RuntimeNodeDir 'VERSION') -Value $NodeVersion -Encoding ASCII
    Write-Ok "Runtime intégré : runtime\node\node.exe (v$NodeVersion)."

    Write-Build 'Préparation du moteur JavaScript...'
    $PackageEngine = Join-Path $PackageDir 'engine'
    Ensure-Directory $PackageEngine
    Copy-DirectoryContents (Join-Path $ProjectDir 'engine') $PackageEngine
    Remove-Item -LiteralPath (Join-Path $PackageEngine 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $PackageEngine '.npm') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $PackageEngine '.cache') -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath $PackageEngine -Recurse -File -Filter '*.log' -ErrorAction SilentlyContinue | Remove-Item -Force

    function Install-EngineDependencies {
        if (Test-Path -LiteralPath (Join-Path $PackageEngine 'package-lock.json')) {
            Invoke-Checked $NodeExe @($NpmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--foreground-scripts') $PackageEngine
        }
        elseif (Test-Path -LiteralPath (Join-Path $PackageEngine 'package.json')) {
            Invoke-Checked $NodeExe @($NpmCli, 'install', '--omit=dev', '--no-audit', '--no-fund', '--foreground-scripts') $PackageEngine
        }
        else { throw 'engine\package.json est absent.' }
    }

    $SourceNodeModules = Join-Path $ProjectDir 'engine\node_modules'
    if (-not $FreshNpm -and (Test-Path -LiteralPath $SourceNodeModules -PathType Container)) {
        Write-Build 'Copie des dépendances existantes...'
        Copy-Item -LiteralPath $SourceNodeModules -Destination (Join-Path $PackageEngine 'node_modules') -Recurse -Force
    }
    else {
        Write-Build "Installation des dépendances avec Node.js $NodeVersion..."
        Install-EngineDependencies
    }

    function Test-BetterSqlite3 {
        Push-Location $PackageEngine
        try {
            & $NodeExe -e "const Database=require('better-sqlite3');const db=new Database(':memory:');const r=db.prepare('SELECT 1 AS ok').get();if(!r||r.ok!==1)throw new Error('SQLite invalide');db.close();"
            return ($LASTEXITCODE -eq 0)
        }
        finally { Pop-Location }
    }

    if (-not (Test-BetterSqlite3)) {
        Write-Warn "better-sqlite3 n'est pas compatible avec Node.js $NodeVersion. Reconstruction..."
        try { Invoke-Checked $NodeExe @($NpmCli, 'rebuild', 'better-sqlite3', '--no-audit', '--no-fund', '--foreground-scripts') $PackageEngine }
        catch { Write-Warn $_.Exception.Message }
    }
    if (-not (Test-BetterSqlite3)) {
        Write-Warn 'Réinstallation complète des dépendances Windows...'
        Remove-Item -LiteralPath (Join-Path $PackageEngine 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue
        Install-EngineDependencies
    }
    if (-not (Test-BetterSqlite3)) {
        throw 'better-sqlite3 reste inutilisable. Installez Visual Studio Build Tools 2022 avec « Développement Desktop en C++ » et Python 3, puis relancez avec --fresh-npm.'
    }
    Write-Ok 'better-sqlite3 fonctionne avec le runtime Windows embarqué.'

    $PackageData = Join-Path $PackageDir 'data'
    Ensure-Directory $PackageData
    if ($WithData) {
        $SourceData = Join-Path $ProjectDir 'data'
        if (-not (Test-Path -LiteralPath $SourceData -PathType Container)) { throw '--with-data demandé, mais data\ est absent.' }
        Write-Warn 'Le paquet contiendra les comptes, messages et secrets enregistrés.'
        Copy-DirectoryContents $SourceData $PackageData
        Remove-Item -LiteralPath (Join-Path $PackageData 'index.db') -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $PackageData 'index.db-wal') -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $PackageData 'index.db-shm') -Force -ErrorAction SilentlyContinue
        Get-ChildItem -LiteralPath $PackageData -Recurse -File -Filter '*.log' -ErrorAction SilentlyContinue | Remove-Item -Force

        $SourceDatabase = Join-Path $SourceData 'index.db'
        if (Test-Path -LiteralPath $SourceDatabase) {
            Write-Build 'Création d’un instantané cohérent de SQLite...'
            $SnapshotScript = Join-Path $WorkDir 'snapshot-db.js'
            @'
const fs = require('fs');
const path = require('path');
const engineDir = process.argv[2];
const source = process.argv[3];
const target = process.argv[4];
const Database = require(path.join(engineDir, 'node_modules', 'better-sqlite3'));

(async () => {
  if (fs.existsSync(target)) fs.unlinkSync(target);
  const src = new Database(source, { readonly: true, fileMustExist: true });
  await src.backup(target);
  src.close();

  const dst = new Database(target);
  try {
    const tables = new Set(dst.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    if (tables.has('messages')) {
      const columns = new Set(dst.prepare('PRAGMA table_info(messages)').all().map(r => r.name));
      if (['id', 'account_id', 'folder', 'uid', 'eml_path'].every(name => columns.has(name))) {
        const rows = dst.prepare("SELECT id, account_id, folder, uid FROM messages WHERE eml_path IS NOT NULL AND eml_path <> ''").all();
        const update = dst.prepare('UPDATE messages SET eml_path=? WHERE id=?');
        const transaction = dst.transaction(items => {
          for (const row of items) {
            const safeFolder = String(row.folder || 'INBOX').replace(/[^A-Za-z0-9_.-]/g, '_');
            const relative = ['mail', String(row.account_id || ''), safeFolder, `${row.uid}.eml`].join('/');
            update.run(relative, row.id);
          }
        });
        transaction(rows);
      }
    }
  } finally {
    dst.close();
  }
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
'@ | Set-Content -LiteralPath $SnapshotScript -Encoding UTF8
            Invoke-Checked $NodeExe @($SnapshotScript, $PackageEngine, $SourceDatabase, (Join-Path $PackageData 'index.db'))
        }
        else { Write-Warn 'Aucune base data\index.db à inclure.' }

        $MailDir = Join-Path $PackageData 'mail'
        $EmlCount = if (Test-Path -LiteralPath $MailDir) { @(Get-ChildItem -LiteralPath $MailDir -Recurse -File -Filter '*.eml').Count } else { 0 }
        Write-Ok "Messages locaux copiés : $EmlCount fichier(s) .eml."
    }

    @'
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
'@ | Set-Content -LiteralPath (Join-Path $PackageDir 'libramail.ps1') -Encoding UTF8

    @'
@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0libramail.ps1" %*
if errorlevel 1 pause
'@ | Set-Content -LiteralPath (Join-Path $PackageDir 'libramail.cmd') -Encoding ASCII

    @'
Option Explicit
Dim shell, fso, appDir, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
command = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & appDir & "\libramail.ps1"""
shell.Run command, 0, False
'@ | Set-Content -LiteralPath (Join-Path $PackageDir 'LibraMail.vbs') -Encoding ASCII

    @'
$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeExe = Join-Path $AppDir 'runtime\node\node.exe'
Write-Host -NoNewline 'Runtime embarqué : '
& $NodeExe --version
if ($LASTEXITCODE -ne 0) { throw 'node.exe ne fonctionne pas.' }
& $NodeExe --check (Join-Path $AppDir 'engine\backend.js')
if ($LASTEXITCODE -ne 0) { throw 'La syntaxe du moteur est invalide.' }
Push-Location (Join-Path $AppDir 'engine')
try {
    & $NodeExe -e "const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('SELECT 1').get();db.close();console.log('better-sqlite3 : OK');"
    if ($LASTEXITCODE -ne 0) { throw 'better-sqlite3 ne fonctionne pas.' }
}
finally { Pop-Location }
Write-Host 'Lanceur autonome : OK'
'@ | Set-Content -LiteralPath (Join-Path $PackageDir 'check_portable.ps1') -Encoding UTF8

    @'
@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0check_portable.ps1"
if errorlevel 1 pause
'@ | Set-Content -LiteralPath (Join-Path $PackageDir 'check_portable.cmd') -Encoding ASCII

    @"
LibraMail $Version — paquet autonome Windows x86_64

Lancement sans console :
  double-cliquer sur LibraMail.vbs

Lancement avec diagnostic :
  double-cliquer sur libramail.cmd

Contrôle du paquet :
  double-cliquer sur check_portable.cmd

Node.js :
  - version embarquée : $NodeVersion
  - exécutable utilisé : .\runtime\node\node.exe
  - aucune installation de Node.js ou npm n'est requise sur le poste cible.

Prérequis système :
  - Windows 10 ou Windows 11 x64 ;
  - Microsoft Edge WebView2 Runtime ;
  - éventuellement Microsoft Visual C++ 2015-2022 x64 si un module natif le réclame.

Le dossier entier est portable. Ne déplacez pas seulement LibraMail.vbs ou
libramail-app.exe : runtime, engine, resources.neu et data sont nécessaires.

Avec --with-data, le paquet contient les comptes, mots de passe et messages.
Il doit être traité comme une sauvegarde confidentielle.
"@ | Set-Content -LiteralPath (Join-Path $PackageDir 'README_WINDOWS.txt') -Encoding UTF8

    $ArchivePath = Join-Path $OutputDir "$PackageName.zip"
    Remove-Item -LiteralPath $ArchivePath -Force -ErrorAction SilentlyContinue
    Write-Build 'Création de l’archive ZIP...'
    Compress-Archive -LiteralPath $PackageDir -DestinationPath $ArchivePath -CompressionLevel Optimal
    $Hash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath "$ArchivePath.sha256" -Value "$Hash  $([IO.Path]::GetFileName($ArchivePath))" -Encoding ASCII

    $FinalPackageDir = Join-Path $OutputDir $PackageName
    Remove-Item -LiteralPath $FinalPackageDir -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $PackageDir -Destination $FinalPackageDir

    Write-Host ''
    Write-Ok 'Construction terminée.'
    Write-Host "Dossier : $FinalPackageDir"
    Write-Host "Archive : $ArchivePath"
    Write-Host "Contrôle : $FinalPackageDir\check_portable.cmd"
    Write-Host "Lancement : $FinalPackageDir\LibraMail.vbs"
}
catch {
    Write-Host ''
    Write-Host "[ERREUR] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
finally {
    Restore-ProjectConfig
    if (-not $KeepWork) {
        Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    elseif (Test-Path -LiteralPath $WorkDir) {
        Write-Warn "Dossier de travail conservé : $WorkDir"
    }
}
