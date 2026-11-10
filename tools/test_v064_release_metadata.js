#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const version = read('VERSION').trim();
assert.equal(version, '0.6.4', 'La version publique doit être 0.6.4');
const changelog = read('CHANGELOG.md');
assert.match(changelog, /^# LibraMail 0\.6\.4 - \d{4}-\d{2}-\d{2}/);
assert.equal((changelog.match(/^# LibraMail 0\.6\.4 - /gm) || []).length, 1);
assert.match(changelog, /^# LibraMail 0\.6\.3 - /m, 'Historique 0.6.3 conservé');
const currentSection = changelog.split(/^# LibraMail 0\.6\.3 - /m)[0];
for (const required of ['## Français', '## English', 'SMTP', 'MIME', 'brouillon', 'draft', 'attachments']) {
  assert(currentSection.includes(required), `Note de version incomplète : ${required}`);
}
const readme = read('README.md');
assert(readme.includes('version-0.6.4-'));
assert(readme.includes('## Latest version — 0.6.4'));
assert(readme.includes('## Dernière version — 0.6.4'));
assert(readme.includes('/releases/tag/v0.6.4'));
assert(readme.includes('./github.sh notes 0.6.4'));
assert(readme.includes('./github.sh release 0.6.4'));
const note = read('.github/release-notes.md');
assert(note.startsWith('# LibraMail 0.6.4'));
assert(note.includes('macOS Intel x86_64'));
assert(note.includes('## Français') && note.includes('## English'));
assert.equal(read('NOTES_0.6.4.md'), note);
const publishing = read('docs/PUBLISHING.md');
assert(publishing.includes('Validation avant publication de la 0.6.4'));
assert(publishing.includes('unsigned and unnotarized'));
assert(publishing.includes('dev-0.6.4'));
assert(read('release.sh').includes('./release.sh 0.6.4'));
console.log('[OK] LibraMail 0.6.4 : métadonnées, notes FR/EN et publication contrôlées');
