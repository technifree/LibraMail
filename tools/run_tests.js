#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');
const ENGINE = path.join(ROOT, 'engine');

function discoverTests() {
  return fs.readdirSync(TOOLS, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^test_.*\.js$/i.test(entry.name))
    .map(entry => path.join('tools', entry.name))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function canLoadBetterSqlite3(nodeBin) {
  if (!nodeBin) return false;
  const probe = [
    "const Database=require('better-sqlite3');",
    "const db=new Database(':memory:');",
    "db.prepare('SELECT 1 AS ok').get();",
    "db.close();",
  ].join('');
  const result = spawnSync(nodeBin, ['-e', probe], {
    cwd: ENGINE,
    stdio: 'ignore',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  return !result.error && result.status === 0;
}

function bundledNodeCandidates() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(ROOT, 'bin', 'node.exe'),
        path.join(ROOT, 'runtime', 'node', 'node.exe'),
      ]
    : [
        path.join(ROOT, 'bin', 'node'),
      ];

  return candidates.filter(candidate => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function ensureCompatibleNodeRuntime() {
  // En CI, npm ci compile/installe better-sqlite3 pour le Node fourni par
  // actions/setup-node : on conserve donc le runtime courant s'il fonctionne.
  if (canLoadBetterSqlite3(process.execPath)) return;

  // En développement LibraMail peut volontairement utiliser ./bin/node,
  // différent du Node système. npm peut alors démarrer le script avec le Node
  // système et provoquer ERR_DLOPEN_FAILED sur better-sqlite3. On relance le
  // runner avec le runtime embarqué uniquement s'il sait charger le module.
  if (process.env.LIBRAMAIL_TEST_NODE_REEXEC === '1') {
    console.error(
      `[LibraMail] Runtime Node incompatible avec better-sqlite3 : ${process.execPath} ` +
      `(ABI ${process.versions.modules || '?'})`
    );
    process.exit(1);
  }

  for (const candidate of bundledNodeCandidates()) {
    if (path.resolve(candidate) === path.resolve(process.execPath)) continue;
    if (!canLoadBetterSqlite3(candidate)) continue;

    const versionProbe = spawnSync(candidate, ['-p', 'process.version + " / ABI " + process.versions.modules'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const version = String(versionProbe.stdout || '').trim();

    console.log(
      `[LibraMail] Node courant incompatible avec better-sqlite3 ` +
      `(${process.version} / ABI ${process.versions.modules || '?'}).`
    );
    console.log(`[LibraMail] Relance avec le runtime LibraMail : ${candidate}${version ? ` (${version})` : ''}`);

    const result = spawnSync(
      candidate,
      [__filename, ...process.argv.slice(2)],
      {
        cwd: ROOT,
        stdio: 'inherit',
        env: {
          ...process.env,
          NODE_ENV: 'test',
          LIBRAMAIL_TEST_NODE_REEXEC: '1',
        },
      }
    );

    if (result.error) {
      console.error(`[LibraMail] Impossible de relancer les tests : ${result.error.message}`);
      process.exit(1);
    }
    process.exit(Number.isInteger(result.status) ? result.status : 1);
  }

  console.error(
    `[LibraMail] Aucun runtime Node installé ne peut charger better-sqlite3. ` +
    `Node courant : ${process.version} / ABI ${process.versions.modules || '?'}.`
  );
  console.error(
    '[LibraMail] Ne lancez pas npm rebuild au hasard : utilisez le runtime prévu par LibraMail ' +
    'ou réinstallez les dépendances avec le même Node que celui utilisé pour les tests.'
  );
  process.exit(1);
}

function main() {
  const tests = discoverTests();
  if (!tests.length) {
    console.error('[LibraMail] Aucun test tools/test_*.js trouvé.');
    process.exitCode = 1;
    return;
  }

  if (process.argv.includes('--list')) {
    tests.forEach(test => console.log(test));
    console.log(`[LibraMail] ${tests.length} fichier(s) de test détecté(s).`);
    return;
  }

  ensureCompatibleNodeRuntime();

  console.log(`[LibraMail] Exécution de ${tests.length} fichier(s) de test avec node:test (${process.platform}).`);

  // Les tests historiques sont des scripts autonomes utilisant assert. Le
  // runner natif node:test sait les exécuter comme sous-tests sans imposer une
  // réécriture massive. La concurrence est volontairement limitée à 1 pour
  // éviter les interférences entre tests de stockage/SQLite et rester stable
  // sur Linux comme sur Windows.
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', ...tests],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test' },
    }
  );

  if (result.error) {
    console.error(`[LibraMail] Impossible de lancer la suite de tests : ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
}

main();
