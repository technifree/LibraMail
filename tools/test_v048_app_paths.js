'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appPaths = require(path.join(root, 'engine/lib/app_paths'));

const portableRoot = path.resolve('/tmp/libramail-portable');
const portable = appPaths.createAppPaths(portableRoot, {});
assert.strictEqual(portable.root, portableRoot);
assert.strictEqual(portable.stateRoot, portableRoot);
assert.strictEqual(portable.dataDir, path.join(portableRoot, 'data'));
assert.strictEqual(portable.backupsDir, path.join(portableRoot, 'backups'));
assert.strictEqual(
  portable.restoreStateFile,
  path.join(portableRoot, '.libramail-restore-state.json')
);
assert.strictEqual(portable.portable, true);

const installedRoot = path.resolve('/opt/libramail');
const stateRoot = path.resolve('/home/test/.local/share/libramail');
const installed = appPaths.createAppPaths(installedRoot, {
  LIBRAMAIL_STATE_ROOT: stateRoot,
});
assert.strictEqual(installed.root, installedRoot);
assert.strictEqual(installed.stateRoot, stateRoot);
assert.strictEqual(installed.dataDir, path.join(stateRoot, 'data'));
assert.strictEqual(installed.backupsDir, path.join(stateRoot, 'backups'));
assert.strictEqual(
  installed.restoreStateFile,
  path.join(stateRoot, '.libramail-restore-state.json')
);
assert.strictEqual(installed.portable, false);

assert.strictEqual(
  appPaths.isInsideStateRoot(path.join(stateRoot, '.libramail-restore-abc'), stateRoot),
  true
);
assert.strictEqual(
  appPaths.isInsideStateRoot(path.join(stateRoot, '.libramail-rollback-abc'), stateRoot),
  true
);
assert.strictEqual(appPaths.isInsideStateRoot(stateRoot, stateRoot), false);
assert.strictEqual(
  appPaths.isInsideStateRoot('/opt/libramail/.libramail-rollback-abc', stateRoot),
  false
);

const backend = fs.readFileSync(path.join(root, 'engine/backend.js'), 'utf8');
assert(backend.includes("const appPaths = require('./lib/app_paths');"));
assert(backend.includes('stateRoot: STATE_ROOT'));
assert(backend.includes('fs.mkdirSync(STATE_ROOT, { recursive: true });'));
assert(backend.includes('appPaths.isInsideStateRoot(rollbackRoot, STATE_ROOT)'));
assert(backend.includes("fs.mkdtempSync(path.join(STATE_ROOT, '.libramail-restore-'))"));
assert(backend.includes('path.join(STATE_ROOT, `.libramail-rollback-'));
assert(!backend.includes("const DATA = path.join(ROOT, 'data');"));
assert(!backend.includes("const BACKUPS_DIR = path.join(ROOT, 'backups');"));

console.log('[LibraMail] Tests chemins application / données 0.4.8 : OK');
