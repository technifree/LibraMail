#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const read = name =>
  fs.readFileSync(path.join(root, name), 'utf8');

const version = read('VERSION').trim();
const changelog = read('CHANGELOG.md');

assert.match(version, /^\d+\.\d+\.\d+$/);

// Contrôle de la version courante
const headers = [...changelog.matchAll(
  /^# LibraMail (\d+\.\d+\.\d+) - \d{4}-\d{2}-\d{2}/gm
)];

assert(headers.length > 0);
assert.equal(headers[0][1], version);
assert.equal(
  headers.filter(h => h[1] === version).length, 1
);

// Conservation de l'historique 0.6.4
assert.equal(
  headers.filter(h => h[1] === '0.6.4').length, 1
);

assert.match(
  changelog,
  /^# LibraMail 0\.6\.3 - /m
);

const historical = changelog
  .split(/^# LibraMail 0\.6\.4 - /m)[1]
  .split(/^# LibraMail /m)[0];

const archived = read('NOTES_0.6.4.md');

for (const required of [
  '## Français', '## English', 'SMTP',
  'MIME', 'brouillon', 'draft', 'attachments'
]) {
  assert(historical.includes(required), required);
  assert(archived.includes(required), required);
}

assert(archived.startsWith('# LibraMail 0.6.4'));
assert(archived.includes('macOS Intel x86_64'));

// Documentation de la version courante
const readme = read('README.md');

for (const required of [
  `version-${version}-`,
  `## Latest version — ${version}`,
  `## Dernière version — ${version}`,
  `/releases/tag/v${version}`,
  './github.sh notes',
  './github.sh release'
]) {
  assert(readme.includes(required), required);
}

const note = read('.github/release-notes.md');

assert(note.startsWith(`# LibraMail ${version} —`));
assert(note.includes('macOS Intel x86_64'));
assert(note.includes('## Français'));
assert(note.includes('## English'));

const publishing = read('docs/PUBLISHING.md');
assert(publishing.includes('unsigned and unnotarized'));
assert(read('release.sh').includes('./release.sh'));

console.log(
  `[OK] LibraMail ${version} : métadonnées courantes et historique 0.6.4`
);
