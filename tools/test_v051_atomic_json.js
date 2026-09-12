'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const atomicFile = require('../engine/lib/atomic_file');

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

(async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-atomic-json-'));
  const target = path.join(tempRoot, 'state.json');

  try {
    atomicFile.writeJsonAtomicSync(target, { version: 1, name: 'LibraMail' });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), {
      version: 1,
      name: 'LibraMail',
    });

    if (process.platform !== 'win32') {
      assert.strictEqual(
        fs.statSync(target).mode & 0o777,
        0o600,
        'le JSON persistant doit être en 0600'
      );
    }

    await atomicFile.writeJsonAtomic(target, { version: 2, ok: true });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), {
      version: 2,
      ok: true,
    });

    const beforeRenameFailure = fs.readFileSync(target, 'utf8');
    const realRenameSync = fs.renameSync;
    fs.renameSync = () => {
      const error = new Error('échec rename simulé');
      error.code = 'EIO';
      throw error;
    };
    try {
      assert.throws(
        () => atomicFile.writeJsonAtomicSync(target, { version: 3 }),
        /échec rename simulé/
      );
    } finally {
      fs.renameSync = realRenameSync;
    }

    assert.strictEqual(fs.readFileSync(target, 'utf8'), beforeRenameFailure);
    assert.deepStrictEqual(
      fs.readdirSync(tempRoot).filter(name => name.includes('.tmp-')),
      [],
      'un échec de rename ne doit pas laisser de fichier temporaire'
    );

    const beforeFsyncFailure = fs.readFileSync(target, 'utf8');
    const realFsyncSync = fs.fsyncSync;
    fs.fsyncSync = () => {
      const error = new Error('échec fsync simulé');
      error.code = 'EIO';
      throw error;
    };
    try {
      assert.throws(
        () => atomicFile.writeJsonAtomicSync(target, { version: 4 }),
        /échec fsync simulé/
      );
    } finally {
      fs.fsyncSync = realFsyncSync;
    }

    assert.strictEqual(fs.readFileSync(target, 'utf8'), beforeFsyncFailure);
    assert.deepStrictEqual(
      fs.readdirSync(tempRoot).filter(name => name.includes('.tmp-')),
      [],
      'un échec de fsync ne doit pas laisser de fichier temporaire'
    );

    const helper = read('engine/lib/atomic_file.js');
    assert(helper.includes("mode = 0o600"), 'le mode sécurisé 0600 doit être la valeur par défaut');
    assert(helper.includes('fs.fsyncSync(fd)'), 'le fichier temporaire doit être fsync avant rename');
    assert(helper.includes('await handle.sync()'), 'la variante asynchrone doit fsync avant rename');
    assert(helper.includes('fsyncDirectorySync(directory)'), 'le répertoire doit être fsync sous POSIX');
    assert(
      helper.includes("process.platform === 'win32' ? 5 : 1"),
      'Windows doit bénéficier de retries de rename'
    );
    assert(!helper.includes('rmSync(resolved'), 'le fichier final ne doit pas être supprimé avant rename');

    const backend = read('engine/backend.js');
    assert(backend.includes("require('./lib/atomic_file')"));
    assert(backend.includes('atomicFile.writeJsonAtomicSync(file, object)'));
    assert(backend.includes('atomicFile.writeJsonAtomicSync(RESTORE_STATE_FILE'));
    assert(!backend.includes('fs.writeFileSync(RESTORE_STATE_FILE'));

    const masterPassword = read('engine/lib/master_password.js');
    assert(masterPassword.includes("require('./atomic_file')"));
    assert(masterPassword.includes('atomicFile.writeJsonAtomicSync(securityFile, value)'));

    const rpcSecurity = read('engine/lib/rpc_security.js');
    assert(rpcSecurity.includes("require('./atomic_file')"));
    assert(rpcSecurity.includes('atomicFile.writeJsonAtomicSync(target'));
    assert(!rpcSecurity.includes('fs.writeFileSync(target, `${payload}'));

    const backup = read('engine/lib/backup.js');
    assert(backup.includes("require('./atomic_file')"));
    assert(backup.includes('await atomicFile.writeJsonAtomic(accountsPath, [])'));
    assert(backup.includes('await atomicFile.writeJsonAtomic(configPath, {})'));
    assert(backup.includes('await atomicFile.writeJsonAtomic(safeAccountsPath, safeAccounts)'));
    assert(backup.includes('await atomicFile.writeJsonAtomic(manifestPath, manifest)'));

    console.log('[LibraMail] Test écritures JSON atomiques 0.5.1 : OK');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
