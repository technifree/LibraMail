/**
 * LibraMail — Sélecteurs de fichiers natifs du moteur Node.js.
 *
 * Neutralino fournit normalement ces dialogues. Certaines versions compilées
 * sous Linux ferment toutefois la promesse sans afficher de fenêtre. Ce module
 * utilise les outils graphiques disponibles sur le poste comme solution fiable.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function safeDefaultName(value) {
  const name = String(value || 'LibraMail-sauvegarde.zip')
    .replace(/[\\/\0\r\n]/g, '_')
    .trim();
  return name || 'LibraMail-sauvegarde.zip';
}

function defaultDirectory() {
  const documents = path.join(os.homedir(), 'Documents');
  return fs.existsSync(documents) ? documents : os.homedir();
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.once('error', error => {
      if (error && error.code === 'ENOENT') {
        resolve({ available: false, cancelled: false, output: '', error: '' });
        return;
      }
      reject(error);
    });

    child.once('close', code => {
      if (code === 0) {
        resolve({ available: true, cancelled: false, output: stdout.trim(), error: stderr.trim() });
        return;
      }
      // Zenity/Yad/KDialog utilisent 1 ou 255 lorsque l'utilisateur annule.
      if (code === 1 || code === 255) {
        resolve({ available: true, cancelled: true, output: '', error: stderr.trim() });
        return;
      }
      reject(new Error(stderr.trim() || `${command} s’est terminé avec le code ${code}`));
    });
  });
}

async function tryCandidates(candidates) {
  for (const candidate of candidates) {
    const result = await runCommand(candidate.command, candidate.args);
    if (!result.available) continue;
    if (result.cancelled) return null;
    return result.output || null;
  }
  throw new Error(
    'Aucun sélecteur de fichiers graphique n’est disponible. Installez zenity, yad ou kdialog.'
  );
}

function linuxCandidates({ mode, title, defaultName }) {
  const directory = defaultDirectory();
  const initial = mode === 'save'
    ? path.join(directory, safeDefaultName(defaultName))
    : `${directory}${path.sep}`;

  const commonZenity = [
    '--file-selection',
    `--title=${title}`,
    '--file-filter=Sauvegardes ZIP | *.zip',
    '--file-filter=Tous les fichiers | *',
    `--filename=${initial}`,
  ];
  if (mode === 'save') commonZenity.push('--save', '--confirm-overwrite');

  const commonYad = [
    '--file-selection',
    `--title=${title}`,
    '--file-filter=Sauvegardes ZIP | *.zip',
    '--file-filter=Tous les fichiers | *',
    `--filename=${initial}`,
  ];
  if (mode === 'save') commonYad.push('--save', '--confirm-overwrite');

  const kdialogArgs = mode === 'save'
    ? ['--title', title, '--getsavefilename', initial, 'Sauvegardes ZIP (*.zip)']
    : ['--title', title, '--getopenfilename', directory, 'Sauvegardes ZIP (*.zip)'];

  return [
    { command: 'zenity', args: commonZenity },
    { command: 'yad', args: commonYad },
    { command: 'kdialog', args: kdialogArgs },
  ];
}

function macCandidates({ mode, title, defaultName }) {
  const escapedTitle = String(title).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedName = safeDefaultName(defaultName).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = mode === 'save'
    ? `POSIX path of (choose file name with prompt "${escapedTitle}" default name "${escapedName}")`
    : `POSIX path of (choose file with prompt "${escapedTitle}")`;
  return [{ command: 'osascript', args: ['-e', script] }];
}

function windowsCandidates({ mode, title, defaultName }) {
  const dialogClass = mode === 'save' ? 'SaveFileDialog' : 'OpenFileDialog';
  const properties = [
    `$dialog = New-Object System.Windows.Forms.${dialogClass}`,
    `$dialog.Title = ${JSON.stringify(String(title))}`,
    '$dialog.Filter = "Sauvegarde LibraMail (*.zip)|*.zip|Tous les fichiers (*.*)|*.*"',
    `$dialog.InitialDirectory = ${JSON.stringify(defaultDirectory())}`,
  ];
  if (mode === 'save') {
    properties.push(`$dialog.FileName = ${JSON.stringify(safeDefaultName(defaultName))}`);
    properties.push('$dialog.OverwritePrompt = $true');
  }
  properties.push('if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }');
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    ...properties,
  ].join('; ');
  return [
    { command: 'powershell.exe', args: ['-NoProfile', '-STA', '-Command', script] },
    { command: 'pwsh', args: ['-NoProfile', '-STA', '-Command', script] },
  ];
}

async function showBackupDialog({ mode, defaultName = '', title = '' } = {}) {
  if (mode !== 'save' && mode !== 'open') throw new Error('Mode de dialogue invalide');
  const resolvedTitle = String(title || (mode === 'save'
    ? 'Enregistrer la sauvegarde LibraMail'
    : 'Choisir une sauvegarde LibraMail'));

  let candidates;
  if (process.platform === 'linux') {
    candidates = linuxCandidates({ mode, title: resolvedTitle, defaultName });
  } else if (process.platform === 'darwin') {
    candidates = macCandidates({ mode, title: resolvedTitle, defaultName });
  } else if (process.platform === 'win32') {
    candidates = windowsCandidates({ mode, title: resolvedTitle, defaultName });
  } else {
    throw new Error(`Sélecteur de fichiers non pris en charge sur ${process.platform}`);
  }

  const selected = await tryCandidates(candidates);
  if (!selected) return null;
  return path.resolve(selected);
}

module.exports = { showBackupDialog };
