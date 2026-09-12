#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const pkg = JSON.parse(read('engine/package.json'));
const runner = read('tools/run_tests.js');
const verify = read('.github/workflows/verify.yml');
const github = read('github.sh');

assert.strictEqual(pkg.scripts?.test, 'node ../tools/run_tests.js');
assert(runner.includes("/^test_.*\\.js$/i"), 'le runner doit découvrir tous les tools/test_*.js');
assert(runner.includes("'--test'"), 'le runner doit utiliser node:test');
assert(runner.includes("'--test-concurrency=1'"), 'la suite doit être séquentielle pour éviter les interférences');
assert(runner.includes('cwd: ROOT'), 'les tests doivent s’exécuter depuis la racine du dépôt');
assert(runner.includes('canLoadBetterSqlite3'), 'le runner doit vérifier la compatibilité ABI de better-sqlite3');
assert(runner.includes("path.join(ROOT, 'bin', 'node')"), 'le runner doit pouvoir utiliser le runtime LibraMail sous Linux');
assert(runner.includes("path.join(ROOT, 'bin', 'node.exe')"), 'le runner doit prévoir le runtime LibraMail sous Windows');
assert(runner.includes('LIBRAMAIL_TEST_NODE_REEXEC'), 'la relance du runtime doit être protégée contre les boucles');

assert(verify.includes('ubuntu-24.04'), 'la CI doit tester Linux');
assert(verify.includes('windows-2022'), 'la CI doit tester Windows');
assert(verify.includes('dev-*'), 'la CI doit vérifier les branches de développement');
assert(verify.includes('npm test'), 'la CI doit lancer npm test');
assert(verify.includes('actions/checkout@v5'), 'la CI doit utiliser checkout@v5 ou ultérieur compatible Node 24');
assert(verify.includes('actions/setup-node@v5'), 'la CI doit utiliser setup-node@v5 ou ultérieur compatible Node 24');
assert(verify.includes('actions/setup-python@v6'), 'la CI doit utiliser setup-python@v6 ou ultérieur compatible Node 24');
assert(verify.includes('node-version: "22.23.1"'), 'la CI doit tester avec le même Node 22.23.1 que le runtime LibraMail');
assert(
  verify.includes('working-directory: engine\n        run: |\n          node -e "const Database=require(\'better-sqlite3\')'),
  'la commande SQLite du workflow doit utiliser un bloc YAML run: |'
);
assert(github.includes('tools/run_tests.js'), './github.sh check doit exécuter la suite complète');

console.log('[LibraMail] Test runner/CI 0.5.1 : OK');
