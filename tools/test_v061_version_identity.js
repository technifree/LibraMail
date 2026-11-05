#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const version = read('VERSION').trim();
const neutralino = JSON.parse(read('neutralino.config.json'));
const backend = read('engine/backend.js');
const html = read('resources/index.html');
const app = read('resources/js/app.js');

assert(/^0\.6\.[0-9]+$/.test(version), `VERSION=${version}`);
assert(neutralino.version === version, `neutralino.version=${neutralino.version}`);
assert(
  neutralino.modes &&
  neutralino.modes.window &&
  neutralino.modes.window.title === `LibraMail ${version}`,
  'Titre Neutralino incorrect.'
);
assert(
  backend.includes(`const APP_VERSION = '${version}';`),
  'APP_VERSION backend incorrect.'
);
assert(
  html.includes(`<title>LibraMail ${version}</title>`),
  'Titre HTML incorrect.'
);
assert(
  html.includes(`title="LibraMail ${version}"`),
  'Titre du bouton marque incorrect.'
);
assert(
  html.includes(`<span class="version-badge" id="app-version">v${version}</span>`),
  'Badge de version incorrect.'
);

const fallback = `window.NL_APPVERSION || '${version}'`;
const count = app.split(fallback).length - 1;
assert(count === 2, `Fallback JS version courante attendu 2 fois, trouvé ${count}.`);

console.log(`[OK] Identité de version LibraMail ${version}`);
