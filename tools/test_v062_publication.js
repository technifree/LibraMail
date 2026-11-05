#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const script = path.join('tools', 'generate_release_notes.py');
const pythonCmd = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

function run(root, ...args) {
  return spawnSync(pythonCmd, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

// Publication documents must already match the single changelog source.
let result = run(ROOT, '0.6.2', '--check');
assert.strictEqual(result.status, 0, `Documents 0.6.2 incohérents : ${result.stderr}`);

const notes = fs.readFileSync(path.join(ROOT, '.github', 'release-notes.md'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
assert(notes.includes('## Français') && notes.includes('## English'));
assert(notes.includes('0-second') && notes.includes('0 seconde'));
assert(readme.includes('Latest version — 0.6.2') && readme.includes('Dernière version — 0.6.2'));
assert(readme.includes('/releases/tag/v0.6.2'));

// Isolated fixtures: no GitHub requests, no publication and no source changes.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-publish-'));
try {
  fs.mkdirSync(path.join(temp, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(temp, '.github'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, script), path.join(temp, script));
  fs.writeFileSync(path.join(temp, 'VERSION'), '0.6.2\n');
  const source = [
    '# LibraMail 0.6.2 - 2026-11-04',
    '', '## Français', '', '### Nouveautés', '- Première correction.',
    '', '### Lecture', '- Correction du délai zéro.',
    '', '## English', '', '### Changes', '- First improvement.',
    '', '### Read state', '- Fixed zero delay.',
    '', '---', '', '# LibraMail 0.6.0 - 2026-09-27',
    '', '- Ancienne version.', '',
  ].join('\n');
  fs.writeFileSync(path.join(temp, 'CHANGELOG.md'), source);
  fs.writeFileSync(path.join(temp, 'README.md'), '# LibraMail\n\n## Highlights\n\ntext\n\n# Français\n\n## Fonctions principales\n');

  result = run(temp, '0.6.2', '--check');
  assert.notStrictEqual(result.status, 0, 'Absence de notes non détectée');
  result = run(temp, '0.6.2');
  assert.strictEqual(result.status, 0, result.stderr);
  const output = fs.readFileSync(path.join(temp, '.github', 'release-notes.md'), 'utf8');
  const updatedReadme = fs.readFileSync(path.join(temp, 'README.md'), 'utf8');
  result = run(temp, '0.6.2', '--check');
  assert.strictEqual(result.status, 0, result.stderr);
  result = run(temp, '0.6.2');
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(fs.readFileSync(path.join(temp, '.github', 'release-notes.md'), 'utf8'), output, 'Génération non idempotente');
  assert.strictEqual(fs.readFileSync(path.join(temp, 'README.md'), 'utf8'), updatedReadme, 'README non idempotent');

  fs.writeFileSync(path.join(temp, '.github', 'release-notes.md'), output + '\nobsolete\n');
  result = run(temp, '0.6.2', '--check');
  assert.notStrictEqual(result.status, 0, 'Notes périmées acceptées');
  assert(result.stderr.includes('non synchronisés'));
  fs.writeFileSync(path.join(temp, '.github', 'release-notes.md'), output);

  // A future release with no English text must never generate generic fake notes.
  fs.writeFileSync(path.join(temp, 'CHANGELOG.md'), source.replace('## English', '## Autre'));
  result = run(temp, '0.6.2', '--validate-only');
  assert.notStrictEqual(result.status, 0, 'Section EN manquante acceptée');
  result = run(temp, '0.6.2');
  assert.notStrictEqual(result.status, 0, 'La génération a accepté un changelog unilingue');
  assert.strictEqual(fs.readFileSync(path.join(temp, '.github', 'release-notes.md'), 'utf8'), output, 'Publication modifiée après refus');

  fs.writeFileSync(path.join(temp, 'CHANGELOG.md'), source.replace('# LibraMail 0.6.2 - 2026-11-04', '# LibraMail 0.7.0 - 2026-11-04'));
  result = run(temp, '0.6.2', '--validate-only');
  assert.notStrictEqual(result.status, 0, 'Version absente acceptée');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('[LibraMail] Test de publication automatique 0.6.2 : OK');
