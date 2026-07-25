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
