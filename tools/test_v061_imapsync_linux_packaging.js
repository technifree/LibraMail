#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const build = fs.readFileSync(path.join(root, 'build_linux.sh'), 'utf8');
const required = [
  'LibraMail 0.6.1 - imapsync Linux packaging',
  '--without-imapsync',
  'prepare_imapsync_runtime',
  'runtime/imapsync/imapsync',
  'command -v pp',
  'PAR::Packer',
  'Le moteur imapsync attendu est absent du paquet final.'
];
for (const token of required) {
  if (!build.includes(token)) throw new Error(`Packaging imapsync incomplet : ${token}`);
}
console.log('[OK] Packaging Linux imapsync 0.6.1');
