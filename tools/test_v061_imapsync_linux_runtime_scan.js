#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const build = fs.readFileSync(path.join(root, 'build_linux.sh'), 'utf8');

function assert(cond, msg) { if (!cond) throw new Error(msg); }

assert(build.includes('# LibraMail 0.6.1 - imapsync Linux runtime scan'), 'Marqueur runtime scan absent.');
assert(build.includes('--xargs="--version"'), 'PAR::Packer sans scan dynamique.');
assert(build.includes('imapsync-standalone-check.log'), 'Journal détaillé standalone absent.');
assert(build.includes('Diagnostic imapsync standalone'), 'Affichage du diagnostic standalone absent.');

console.log('[OK] Runtime scan PAR::Packer imapsync 0.6.1');
