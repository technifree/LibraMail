#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

assert(changelog.startsWith('# LibraMail 0.6.0 - 2026-09-27'));
assert(changelog.includes('Google Calendar'));
assert(changelog.includes('POP3'));
assert(changelog.includes('Node.js 22.23.1'));

for (const obsolete of ['check_portable.cmd', 'LibraMail.vbs']) {
  assert(!readme.includes(obsolete), `référence Windows obsolète dans README.md : ${obsolete}`);
}

assert(readme.includes('double-click `LibraMail.exe`'));
assert(readme.includes('double-cliquez sur `LibraMail.exe`'));
assert(readme.includes('authenticated Google Calendar synchronisation'));
assert(readme.includes('synchronisation Google Calendar authentifiée'));
assert(readme.includes('Multiple IMAP, POP3 and SMTP accounts'));
assert(readme.includes('Plusieurs comptes IMAP, POP3 et SMTP'));

console.log('[LibraMail] Test documentation pré-release 0.6.0 : OK');
