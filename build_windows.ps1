#requires -version 5.1
<#
LibraMail - construction d'un paquet Windows x64 autonome à lancement natif.

Exemples :
  .\build_windows.ps1 -FreshNpm
  .\build_windows.ps1 -WithData -FreshNpm
#>

[CmdletBinding()]
param(
    [switch]$WithData,
    [switch]$FreshNpm,
    [switch]$EmbedResources,
    [switch]$Offline,
    [switch]$KeepWork,
    [string]$NodeVersion = '24.18.0'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeMirror = if ($env:LIBRAMAIL_NODE_MIRROR) {
    $env:LIBRAMAIL_NODE_MIRROR.TrimEnd('/')
}
else {
    'https://nodejs.org/dist'
}

function Write-Build {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "[build] $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "[ OK  ] $Message" -ForegroundColor Green
}

function Ensure-Directory {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Require-File {
    param([Parameter(Mandatory)][string]$RelativePath)
    $fullPath = Join-Path $ProjectDir $RelativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Fichier introuvable : $RelativePath"
    }
}

function Require-Directory {
    param([Parameter(Mandatory)][string]$RelativePath)
    $fullPath = Join-Path $ProjectDir $RelativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
        throw "Dossier introuvable : $RelativePath"
    }
}

function Copy-DirectoryContents {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )

    Ensure-Directory -Path $Destination
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$WorkingDirectory = $ProjectDir
    )

    Push-Location $WorkingDirectory
    try {
        & $FilePath @ArgumentList
        $exitCode = $LASTEXITCODE
        if ($null -ne $exitCode -and $exitCode -ne 0) {
            throw "Commande en échec ($exitCode) : $FilePath $($ArgumentList -join ' ')"
        }
    }
    finally {
        Pop-Location
    }
}

function Download-File {
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$Destination
    )

    if ($Offline) {
        throw "Mode hors ligne : fichier absent du cache : $Destination"
    }

    Ensure-Directory -Path (Split-Path -Parent $Destination)
    $temporaryPath = "$Destination.part"
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue

    Write-Build -Message "Téléchargement : $Url"
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $temporaryPath

    if (-not (Test-Path -LiteralPath $temporaryPath -PathType Leaf)) {
        throw "Téléchargement absent : $Url"
    }

    if ((Get-Item -LiteralPath $temporaryPath).Length -le 0) {
        throw "Téléchargement vide : $Url"
    }

    Move-Item -LiteralPath $temporaryPath -Destination $Destination -Force
}

if ($NodeVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version Node.js invalide : $NodeVersion"
}

Require-File -RelativePath 'neutralino.config.json'
Require-File -RelativePath 'resources\index.html'
Require-File -RelativePath 'engine\backend.js'
Require-Directory -RelativePath 'resources'
Require-Directory -RelativePath 'engine'
Require-Directory -RelativePath 'packaging\windows'
Require-File -RelativePath 'packaging\windows\snapshot-db.js'
Require-File -RelativePath 'packaging\windows\README_WINDOWS.txt.in'

$ConfigPath = Join-Path $ProjectDir 'neutralino.config.json'
$Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$Version = [string]$Config.version
if ([string]::IsNullOrWhiteSpace($Version)) {
    throw 'La version est absente de neutralino.config.json.'
}

$BinaryName = 'libramail'
if ($Config.cli -and $Config.cli.binaryName) {
    $BinaryName = [string]$Config.cli.binaryName
}

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
    if ($script:ConfigPatched -and (Test-Path -LiteralPath $script:ConfigBackup -PathType Leaf)) {
        Copy-Item -LiteralPath $script:ConfigBackup -Destination $script:ConfigPath -Force
        $script:ConfigPatched = $false
    }
}

function Install-EngineDependencies {
    param(
        [Parameter(Mandatory)][string]$PackageEngine,
        [Parameter(Mandatory)][string]$NodeExe,
        [Parameter(Mandatory)][string]$NpmCli
    )

    $lockFile = Join-Path $PackageEngine 'package-lock.json'
    $packageFile = Join-Path $PackageEngine 'package.json'

    if (Test-Path -LiteralPath $lockFile -PathType Leaf) {
        Invoke-Checked `
            -FilePath $NodeExe `
            -ArgumentList @(
                $NpmCli,
                'ci',
                '--omit=dev',
                '--no-audit',
                '--no-fund',
                '--foreground-scripts'
            ) `
            -WorkingDirectory $PackageEngine
        return
    }

    if (Test-Path -LiteralPath $packageFile -PathType Leaf) {
        Invoke-Checked `
            -FilePath $NodeExe `
            -ArgumentList @(
                $NpmCli,
                'install',
                '--omit=dev',
                '--no-audit',
                '--no-fund',
                '--foreground-scripts'
            ) `
            -WorkingDirectory $PackageEngine
        return
    }

    throw 'engine\package.json est absent.'
}

function Test-BetterSqlite3 {
    param(
        [Parameter(Mandatory)][string]$PackageEngine,
        [Parameter(Mandatory)][string]$NodeExe
    )

    Push-Location $PackageEngine
    try {
        & $NodeExe -e "const Database=require('better-sqlite3');const db=new Database(':memory:');const row=db.prepare('SELECT 1 AS ok').get();if(!row||row.ok!==1){throw new Error('SQLite invalide');}db.close();"
        return ($LASTEXITCODE -eq 0)
    }
    finally {
        Pop-Location
    }
}

try {
    Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue

    Ensure-Directory -Path $CacheDir
    Ensure-Directory -Path $NodeExtractDir
    Ensure-Directory -Path $NeuDist
    Ensure-Directory -Path $PackageDir
    Ensure-Directory -Path $OutputDir

    if (-not (Test-Path -LiteralPath $NodeShasumsPath -PathType Leaf)) {
        Download-File `
            -Url "$NodeReleaseUrl/SHASUMS256.txt" `
            -Destination $NodeShasumsPath
    }

    if (-not (Test-Path -LiteralPath $NodeArchivePath -PathType Leaf)) {
        Download-File `
            -Url "$NodeReleaseUrl/$NodeArchive" `
            -Destination $NodeArchivePath
    }

    $checksumLine = Get-Content -LiteralPath $NodeShasumsPath | Where-Object {
        $_ -match ("\s" + [regex]::Escape($NodeArchive) + '$')
    } | Select-Object -First 1

    if (-not $checksumLine) {
        throw "$NodeArchive n'est pas référencé dans SHASUMS256.txt."
    }

    $expectedHash = (($checksumLine -split '\s+')[0]).ToLowerInvariant()
    $actualHash = (Get-FileHash -LiteralPath $NodeArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()

    if ($actualHash -ne $expectedHash) {
        throw "Somme SHA-256 incorrecte pour $NodeArchive."
    }

    Write-Ok -Message "Archive Node.js $NodeVersion vérifiée."

    Expand-Archive `
        -LiteralPath $NodeArchivePath `
        -DestinationPath $NodeExtractDir `
        -Force

    if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
        throw "node.exe absent après extraction : $NodeExe"
    }

    if (-not (Test-Path -LiteralPath $NpmCli -PathType Leaf)) {
        throw 'npm est absent de la distribution Node.js.'
    }

    if (-not (Test-Path -LiteralPath $NpxCli -PathType Leaf)) {
        throw 'npx est absent de la distribution Node.js.'
    }

    $actualNodeVersion = (& $NodeExe --version).Trim()
    if ($actualNodeVersion -ne "v$NodeVersion") {
        throw "Version Node.js inattendue : $actualNodeVersion"
    }

    $env:Path = "$NodeDistDir;$env:Path"
    Write-Ok -Message "Moteur de construction : Node.js $actualNodeVersion."

    Copy-Item -LiteralPath $ConfigPath -Destination $ConfigBackup -Force
    $ConfigPatched = $true

    $patchedConfig = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

    if (-not $patchedConfig.cli) {
        $patchedConfig | Add-Member `
            -MemberType NoteProperty `
            -Name cli `
            -Value ([pscustomobject]@{})
    }

    $patchedConfig.cli | Add-Member `
        -MemberType NoteProperty `
        -Name distributionPath `
        -Value '.build-windows-work/neutralino-dist' `
        -Force

    if (-not $patchedConfig.modes) {
        $patchedConfig | Add-Member `
            -MemberType NoteProperty `
            -Name modes `
            -Value ([pscustomobject]@{})
    }

    if (-not $patchedConfig.modes.window) {
        $patchedConfig.modes | Add-Member `
            -MemberType NoteProperty `
            -Name window `
            -Value ([pscustomobject]@{})
    }

    $patchedConfig.modes.window | Add-Member `
        -MemberType NoteProperty `
        -Name title `
        -Value "LibraMail $Version" `
        -Force

    if ((-not ($patchedConfig.PSObject.Properties.Name -contains 'globalVariables')) -or (-not $patchedConfig.globalVariables)) {
        $patchedConfig | Add-Member `
            -MemberType NoteProperty `
            -Name globalVariables `
            -Value ([pscustomobject]@{})
    }

    # Le binaire Windows démarre lui-même le moteur Node.js. Cette variable
    # n'est injectée que dans le paquet Windows, pas dans les builds Linux/dev.
    $patchedConfig.globalVariables | Add-Member `
        -MemberType NoteProperty `
        -Name BUNDLED_ENGINE `
        -Value $true `
        -Force

    $json = $patchedConfig | ConvertTo-Json -Depth 100
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($ConfigPath, $json, $utf8NoBom)

    $localNeu = Join-Path $ProjectDir 'node_modules\.bin\neu.cmd'
    $globalNeu = Get-Command 'neu.cmd' -ErrorAction SilentlyContinue
    if (-not $globalNeu) {
        $globalNeu = Get-Command 'neu' -ErrorAction SilentlyContinue
    }

    $neuCommand = $null
    $neuPrefixArguments = @()

    if (Test-Path -LiteralPath $localNeu -PathType Leaf) {
        $neuCommand = $localNeu
    }
    elseif ($globalNeu) {
        $neuCommand = $globalNeu.Source
    }
    else {
        Write-Build -Message 'Utilisation de npx @neutralinojs/neu.'
        $neuCommand = $NodeExe
        $neuPrefixArguments = @(
            $NpxCli,
            '--yes',
            '@neutralinojs/neu'
        )
    }

    $requiredNeuBinary = Join-Path $ProjectDir 'bin\neutralino-win_x64.exe'

    if (-not (Test-Path -LiteralPath $requiredNeuBinary -PathType Leaf)) {
        Write-Build -Message 'Téléchargement des binaires Neutralino.'
        Invoke-Checked `
            -FilePath $neuCommand `
            -ArgumentList ($neuPrefixArguments + @('update'))
    }

    if (-not (Test-Path -LiteralPath $requiredNeuBinary -PathType Leaf)) {
        throw "Binaire Neutralino absent : $requiredNeuBinary"
    }

    # Le paquet Windows n'utilise plus de resources.neu séparé : les ressources
    # sont injectées dans LibraMail.exe pour avoir un seul exécutable à lancer.
    $buildArguments = @('build', '--embed-resources')

    Write-Build -Message "Construction Neutralino $Version pour Windows x64."
    Invoke-Checked `
        -FilePath $neuCommand `
        -ArgumentList ($neuPrefixArguments + $buildArguments)

    Restore-ProjectConfig

    $expectedNeuBinary = Join-Path $NeuDist "$BinaryName-win_x64.exe"
    $neuBinary = $null

    if (Test-Path -LiteralPath $expectedNeuBinary -PathType Leaf) {
        $neuBinary = Get-Item -LiteralPath $expectedNeuBinary
    }
    else {
        $candidates = @(
            Get-ChildItem `
                -LiteralPath $NeuDist `
                -Recurse `
                -File `
                -Filter '*-win_x64.exe'
        )

        if ($candidates.Count -eq 0) {
            throw 'Aucun binaire Neutralino Windows x64 trouvé.'
        }

        $neuBinary = $candidates | Where-Object {
            $_.Name.ToLowerInvariant() -eq "$BinaryName-win_x64.exe".ToLowerInvariant()
        } | Select-Object -First 1

        if (-not $neuBinary) {
            $neuBinary = $candidates | Select-Object -First 1
        }
    }

    Copy-Item `
        -LiteralPath $neuBinary.FullName `
        -Destination (Join-Path $PackageDir 'LibraMail.exe') `
        -Force

    Write-Ok -Message 'Ressources Neutralino intégrées directement dans LibraMail.exe.'

    Write-Build -Message 'Intégration du runtime Node.js.'

    $runtimeNodeDir = Join-Path $PackageDir 'runtime\node'
    Ensure-Directory -Path $runtimeNodeDir

    Copy-Item `
        -LiteralPath $NodeExe `
        -Destination (Join-Path $runtimeNodeDir 'node.exe') `
        -Force

    $nodeLicense = Join-Path $NodeDistDir 'LICENSE'
    if (Test-Path -LiteralPath $nodeLicense -PathType Leaf) {
        Copy-Item `
            -LiteralPath $nodeLicense `
            -Destination (Join-Path $runtimeNodeDir 'LICENSE') `
            -Force
    }

    Set-Content `
        -LiteralPath (Join-Path $runtimeNodeDir 'VERSION') `
        -Value $NodeVersion `
        -Encoding ASCII

    Write-Build -Message 'Préparation du moteur JavaScript.'

    $packageEngine = Join-Path $PackageDir 'engine'
    Ensure-Directory -Path $packageEngine
    Copy-DirectoryContents `
        -Source (Join-Path $ProjectDir 'engine') `
        -Destination $packageEngine

    Remove-Item `
        -LiteralPath (Join-Path $packageEngine 'node_modules') `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue

    $sourceNodeModules = Join-Path $ProjectDir 'engine\node_modules'

    if ((-not $FreshNpm) -and (Test-Path -LiteralPath $sourceNodeModules -PathType Container)) {
        Copy-Item `
            -LiteralPath $sourceNodeModules `
            -Destination (Join-Path $packageEngine 'node_modules') `
            -Recurse `
            -Force
    }
    else {
        Install-EngineDependencies `
            -PackageEngine $packageEngine `
            -NodeExe $NodeExe `
            -NpmCli $NpmCli
    }

    if (-not (Test-BetterSqlite3 -PackageEngine $packageEngine -NodeExe $NodeExe)) {
        Invoke-Checked `
            -FilePath $NodeExe `
            -ArgumentList @(
                $NpmCli,
                'rebuild',
                'better-sqlite3',
                '--no-audit',
                '--no-fund',
                '--foreground-scripts'
            ) `
            -WorkingDirectory $packageEngine
    }

    if (-not (Test-BetterSqlite3 -PackageEngine $packageEngine -NodeExe $NodeExe)) {
        throw 'better-sqlite3 reste inutilisable après reconstruction.'
    }

    Write-Ok -Message 'better-sqlite3 fonctionne avec le runtime Windows embarqué.'

    # Les shims npm (.cmd/.ps1) ne servent pas à l'exécution de LibraMail.
    # On ne les distribue pas afin de garder un paquet runtime aussi sobre que possible.
    Remove-Item `
        -LiteralPath (Join-Path $packageEngine 'node_modules\.bin') `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue

    $packageData = Join-Path $PackageDir 'data'
    Ensure-Directory -Path $packageData

    if ($WithData) {
        $sourceData = Join-Path $ProjectDir 'data'

        if (-not (Test-Path -LiteralPath $sourceData -PathType Container)) {
            throw '-WithData demandé, mais data\ est absent.'
        }

        Write-Warning 'Le paquet contiendra les comptes, messages et secrets enregistrés.'
        Copy-DirectoryContents -Source $sourceData -Destination $packageData

        Remove-Item `
            -LiteralPath (Join-Path $packageData 'index.db') `
            -Force `
            -ErrorAction SilentlyContinue

        Remove-Item `
            -LiteralPath (Join-Path $packageData 'index.db-wal') `
            -Force `
            -ErrorAction SilentlyContinue

        Remove-Item `
            -LiteralPath (Join-Path $packageData 'index.db-shm') `
            -Force `
            -ErrorAction SilentlyContinue

        $sourceDatabase = Join-Path $sourceData 'index.db'
        if (Test-Path -LiteralPath $sourceDatabase -PathType Leaf) {
            $snapshotScript = Join-Path $ProjectDir 'packaging\windows\snapshot-db.js'
            Invoke-Checked `
                -FilePath $NodeExe `
                -ArgumentList @(
                    $snapshotScript,
                    $packageEngine,
                    $sourceDatabase,
                    (Join-Path $packageData 'index.db')
                )
        }
    }

    Write-Build -Message 'Préparation du lancement natif Windows.'

    $windowsPackagingDir = Join-Path $ProjectDir 'packaging\windows'
    $appExePath = Join-Path $PackageDir 'LibraMail.exe'
    if (-not (Test-Path -LiteralPath $appExePath -PathType Leaf)) {
        throw 'LibraMail.exe est absent du paquet Windows.'
    }
    if (Test-Path -LiteralPath (Join-Path $PackageDir 'resources.neu')) {
        throw 'resources.neu ne doit pas être présent : les ressources doivent être intégrées dans LibraMail.exe.'
    }

    $readmeTemplatePath = Join-Path $windowsPackagingDir 'README_WINDOWS.txt.in'
    $readmeText = Get-Content -LiteralPath $readmeTemplatePath -Raw -Encoding UTF8
    $readmeText = $readmeText.Replace('__LIBRAMAIL_VERSION__', $Version)
    $readmeText = $readmeText.Replace('__NODE_VERSION__', $NodeVersion)

    $readmeEncoding = New-Object System.Text.UTF8Encoding($true)
    [IO.File]::WriteAllText(
        (Join-Path $PackageDir 'README_WINDOWS.txt'),
        $readmeText,
        $readmeEncoding
    )

    $obsoleteLaunchers = @('LibraMail.vbs', 'libramail.ps1', 'libramail.cmd')
    foreach ($obsoleteLauncher in $obsoleteLaunchers) {
        if (Test-Path -LiteralPath (Join-Path $PackageDir $obsoleteLauncher)) {
            throw "Ancien lanceur interdit dans le paquet : $obsoleteLauncher"
        }
    }

    $vbsFiles = @(Get-ChildItem -LiteralPath $PackageDir -Recurse -File -Filter '*.vbs' -ErrorAction SilentlyContinue)
    if ($vbsFiles.Count -gt 0) {
        throw "Le paquet Windows contient encore un fichier VBS : $($vbsFiles[0].FullName)"
    }

    $archivePath = Join-Path $OutputDir "$PackageName.zip"
    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue

    Write-Build -Message "Création de l'archive ZIP."
    Compress-Archive `
        -LiteralPath $PackageDir `
        -DestinationPath $archivePath `
        -CompressionLevel Optimal

    $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content `
        -LiteralPath "$archivePath.sha256" `
        -Value "$hash  $([IO.Path]::GetFileName($archivePath))" `
        -Encoding ASCII

    $finalPackageDir = Join-Path $OutputDir $PackageName
    Remove-Item `
        -LiteralPath $finalPackageDir `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue

    Move-Item -LiteralPath $PackageDir -Destination $finalPackageDir

    Write-Host ''
    Write-Ok -Message 'Construction Windows terminée.'
    Write-Host "Dossier : $finalPackageDir"
    Write-Host "Archive : $archivePath"
}
catch {
    Write-Host ''
    Write-Host "[ERREUR] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
finally {
    Restore-ProjectConfig

    if (-not $KeepWork) {
        Remove-Item `
            -LiteralPath $WorkDir `
            -Recurse `
            -Force `
            -ErrorAction SilentlyContinue
    }
    elseif (Test-Path -LiteralPath $WorkDir -PathType Container) {
        Write-Warning "Dossier de travail conservé : $WorkDir"
    }
}
