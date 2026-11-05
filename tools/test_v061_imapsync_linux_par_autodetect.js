#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const build = fs.readFileSync(path.join(root, 'build_linux.sh'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  build.includes('# LibraMail 0.6.1 - imapsync Linux PAR autodetect'),
  'Marqueur PAR autodetect absent.'
);

const start = build.indexOf('prepare_imapsync_runtime()');
assert(start >= 0, 'Fonction prepare_imapsync_runtime absente.');

const call = build.indexOf('\nprepare_imapsync_runtime', start + 1);
const section = build.slice(start, call >= 0 ? call : undefined);

assert(
  section.includes('pp \\') &&
  section.includes('-o "$staged"') &&
  section.includes('"$source_candidate"'),
  'Commande PAR::Packer simplifiée absente.'
);

assert(
  !/^\s*-M\s+\S+/m.test(section),
  'Des modules Perl -M sont encore forcés dans le packaging imapsync.'
);

assert(
  section.includes('"$staged" --version') &&
  section.includes('"$staged" --help'),
  'Les vérifications du binaire imapsync généré ont disparu.'
);

console.log('[OK] PAR::Packer imapsync en détection automatique');
