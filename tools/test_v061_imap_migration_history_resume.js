#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const root = path.resolve(__dirname, '..');
const migration = require('../engine/lib/imap_migration');
const historyModule = require('../engine/lib/imap_migration_history');

function fakeAccount(id, host, user, password) {
  return {
    id,
    receiveProtocol: 'imap',
    displayName: id,
    email: user,
    imap: { host, port: 993, secure: true, user, pass: password },
  };
}

const account1 = fakeAccount('source-id', 'imap.source.test', 'source@test.invalid', 'source-secret');
const account2 = fakeAccount('destination-id', 'imap.destination.test', 'destination@test.invalid', 'destination-secret');
const plan = {
  folders: [
    { source: 'INBOX', destination: 'INBOX' },
    { source: 'Archives/Été', destination: 'Import/Été' },
  ],
  filters: { since: '2025-01-01', until: '2025-12-31', minSize: 2048, maxSize: 5242880 },
};

function fakeSpawn(program, args) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  process.nextTick(() => {
    const lines = args.includes('--dry') ? [
      'Host1 Total size:                 90000 bytes',
      'Messages transferred                    : 0 (could be 4 without --dry mode)',
      'Messages skipped                        : 1',
      'Messages found in host1 not in host2    : 4 messages',
      'Total bytes skipped                     : 10000',
      'Detected 0 errors',
      'There is no unidentified message on host1.',
    ] : [
      'Messages transferred                    : 4',
      'Messages skipped                        : 1',
      'Messages found in host1 not in host2    : 0 messages',
      'Total bytes transferred                 : 80000',
      'Detected 0 errors',
      'There is no unidentified message on host1.',
    ];
    child.stdout.end(lines.join('\n') + '\n');
    child.stderr.end();
    child.emit('close', 0);
  });
  return child;
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-imap-history-test-'));
  try {
    const store = new historyModule.ImapMigrationHistoryStore({ dataDir: temp, limit: 30 });
    const records = [];
    let clock = 1_700_000_000_000;
    const manager = new migration.ImapMigrationManager({
      root,
      spawnImpl: fakeSpawn,
      engineResolver: () => ({ path: '/fake/imapsync', source: 'test' }),
      now: () => (clock += 250),
      onRecord: record => {
        records.push(record);
        store.add(record);
      },
    });

    const preview = await manager.run({
      mode: 'preview', sourceAccount: account1, destinationAccount: account2, plan,
    });
    assert(preview.previewToken);
    assert.strictEqual(store.list().length, 0, 'une simulation ne doit pas entrer dans l’historique persistant');

    const copy = await manager.run({
      mode: 'copy', sourceAccount: account1, destinationAccount: account2,
      previewToken: preview.previewToken, plan,
    });
    assert(copy.ok);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].status, 'completed');
    assert.strictEqual(records[0].summary.transferred, 4);

    const history = store.list();
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].status, 'completed');
    assert.strictEqual(history[0].sourceAccountId, account1.id);
    assert.strictEqual(history[0].destinationAccountId, account2.id);
    assert.deepStrictEqual(history[0].plan.folders, plan.folders);
    assert.strictEqual(history[0].plan.filters.minSize, 2048);
    assert.strictEqual(history[0].summary.transferredBytes, 80000);

    const historyPath = path.join(temp, 'imap-migration-history.json');
    const raw = fs.readFileSync(historyPath, 'utf8');
    assert(!raw.includes(account1.imap.pass));
    assert(!raw.includes(account2.imap.pass));
    assert(!raw.includes(account1.email));
    assert(!raw.includes(account2.email));
    assert(!/password|token|journal|log/i.test(raw));
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(historyPath).mode & 0o777, 0o600);
    }

    store.clear();
    assert.strictEqual(store.list().length, 0);
    assert(!fs.existsSync(historyPath));

    const html = fs.readFileSync(path.join(root, 'resources/index.html'), 'utf8');
    const app = fs.readFileSync(path.join(root, 'resources/js/app.js'), 'utf8');
    const backend = fs.readFileSync(path.join(root, 'engine/backend.js'), 'utf8');
    const backup = fs.readFileSync(path.join(root, 'engine/lib/backup.js'), 'utf8');
    const fr = JSON.parse(fs.readFileSync(path.join(root, 'resources/locales/fr.json'), 'utf8'));

    assert(html.includes('id="imap-migration-history-list"'));
    assert(html.includes('id="btn-imap-migration-history-clear"'));
    assert(app.includes("'migration.imap.history.list'"));
    assert(app.includes("'migration.imap.history.clear'"));
    assert(app.includes('reuseImapMigrationHistory'));
    assert(app.includes('await discoverImapMigrationFolders({ forResume: true })'));
    assert(app.includes('historyRestored'));
    assert(backend.includes("'migration.imap.history.list'"));
    assert(backend.includes("'migration.imap.history.clear'"));
    assert(backend.includes("broadcast('migration.imap.history.changed'"));
    assert(backup.includes("'imap-migration-history.json'"), 'l’historique ne doit pas être inclus dans les sauvegardes');
    assert(fr['migrationImap.phaseBadge'].includes('Phase D'));
    assert(fr['migrationImap.historyHint'].includes('aucun mot de passe'));
    assert(fr['migrationImap.historyRestored'].includes('nouvelle simulation'));

    console.log('[LibraMail] Test historique/reprise Migration IMAP 0.6.1 : OK');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
