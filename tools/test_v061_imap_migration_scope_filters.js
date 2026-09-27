#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const root = path.resolve(__dirname, '..');
const migration = require('../engine/lib/imap_migration');

function descriptor(id, host, user, password) {
  return { id, host, port: 993, user, secure: true, password };
}

const source = descriptor('source', 'imap.source.test', 'source@example.test', 'source-secret');
const destination = descriptor('destination', 'imap.destination.test', 'destination@example.test', 'destination-secret');

assert.strictEqual(migration.imapUtf7('INBOX'), 'INBOX');
assert.strictEqual(migration.imapUtf7('A&B'), 'A&-B');
assert(migration.imapUtf7('Été').startsWith('&'));

const proposals = migration.proposeFolderMappings([
  { path: 'INBOX', delimiter: '/', flags: [], specialUse: '\\Inbox', selectable: true },
  { path: 'Envoyés', delimiter: '/', flags: [], specialUse: '\\Sent', selectable: true },
  { path: 'Envoyés/2025', delimiter: '/', flags: [], specialUse: '', selectable: true },
  { path: '[Gmail]/Tous les messages', delimiter: '/', flags: [], specialUse: '\\All', selectable: true },
  { path: '[Gmail]', delimiter: '/', flags: ['\\Noselect'], specialUse: '', selectable: false },
], [
  { path: 'INBOX', delimiter: '.', flags: [], specialUse: '\\Inbox', selectable: true },
  { path: 'Sent Items', delimiter: '.', flags: [], specialUse: '\\Sent', selectable: true },
]);

const bySource = new Map(proposals.mappings.map(item => [item.source, item]));
assert.strictEqual(bySource.get('INBOX').destination, 'INBOX');
assert.strictEqual(bySource.get('INBOX').kind, 'identical');
assert.strictEqual(bySource.get('Envoyés').destination, 'Sent Items');
assert.strictEqual(bySource.get('Envoyés').kind, 'role');
assert.strictEqual(bySource.get('Envoyés/2025').destination, 'Sent Items.2025');
assert.strictEqual(bySource.get('Envoyés/2025').kind, 'parent');
assert.strictEqual(bySource.get('[Gmail]/Tous les messages').selected, false);
assert.strictEqual(bySource.get('[Gmail]/Tous les messages').kind, 'excludedAll');
assert.strictEqual(bySource.get('[Gmail]').locked, true);

const plan = {
  folders: [
    { source: 'INBOX', destination: 'INBOX.Import' },
    { source: 'Archives/Été', destination: 'Archives.Été' },
  ],
  filters: {
    since: '2024-01-01',
    until: '2024-06-30',
    minSize: 512,
    maxSize: 25 * 1024,
  },
};
const normalized = migration.normalizeMigrationPlan(plan);
assert.strictEqual(normalized.folders.length, 2);
assert.strictEqual(normalized.filters.maxSize, 25600);
assert.strictEqual(
  migration.searchCriteria(normalized.filters),
  'SINCE 1-Jan-2024 BEFORE 1-Jul-2024',
);

for (const mode of ['preview', 'copy']) {
  const args = migration.buildCommandArgs(source, destination, mode, plan);
  assert(args.includes('--folder'));
  assert(args.includes('--f1f2'));
  assert(args.includes('--search'));
  assert.strictEqual(args[args.indexOf('--search') + 1], 'SINCE 1-Jan-2024 BEFORE 1-Jul-2024');
  assert.strictEqual(args[args.indexOf('--minsize') + 1], '512');
  assert.strictEqual(args[args.indexOf('--maxsize') + 1], '25600');
  assert(!args.includes('--delete1') && !args.includes('--delete2'));
  assert(!args.includes(source.password) && !args.includes(destination.password));
}
const loginArgs = migration.buildCommandArgs(source, destination, 'login', plan);
assert(loginArgs.includes('--justlogin'));
assert(!loginArgs.includes('--folder'));
assert(!loginArgs.includes('--search'));
assert(!loginArgs.includes('--minsize'));
assert(!loginArgs.includes('--maxsize'));

assert.throws(
  () => migration.normalizeMigrationPlan({
    folders: [
      { source: 'One', destination: 'Same' },
      { source: 'Two', destination: 'same' },
    ],
  }),
  /même dossier destination/,
);
assert.throws(
  () => migration.normalizeMigrationPlan({ filters: { since: '2024-12-31', until: '2024-01-01' } }),
  /date de début/,
);
assert.throws(
  () => migration.normalizeMigrationPlan({ filters: { minSize: 4096, maxSize: 1024 } }),
  /taille maximale/,
);

function fakeAccount(id, host, user, password) {
  return {
    id,
    receiveProtocol: 'imap',
    displayName: id,
    email: user,
    imap: { host, port: 993, secure: true, user, pass: password },
  };
}
const account1 = fakeAccount('a', 'imap.a.test', 'a@test.invalid', 'alpha-secret');
const account2 = fakeAccount('b', 'imap.b.test', 'b@test.invalid', 'beta-secret');

function fakeSpawn(program, args) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  process.nextTick(() => {
    const lines = args.includes('--dry') ? [
      'Host1 Total size:                 50000 bytes (48.828 KiB)',
      'Messages transferred                    : 0 (could be 3 without --dry mode)',
      'Messages skipped                        : 0',
      'Messages found in host1 not in host2    : 3 messages',
      'Total bytes skipped                     : 0',
      'Detected 0 errors',
      'There is no unidentified message on host1.',
    ] : [
      'Messages transferred                    : 3',
      'Messages skipped                        : 0',
      'Messages found in host1 not in host2    : 0 messages',
      'Total bytes transferred                 : 50000',
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
  const manager = new migration.ImapMigrationManager({
    root,
    spawnImpl: fakeSpawn,
    engineResolver: () => ({ path: '/fake/imapsync', source: 'test' }),
  });

  const firstPlan = {
    folders: [{ source: 'INBOX', destination: 'Import' }],
    filters: { since: '2024-01-01', maxSize: 4096 },
  };
  const preview = await manager.run({
    mode: 'preview',
    sourceAccount: account1,
    destinationAccount: account2,
    plan: firstPlan,
  });
  assert(preview.previewToken);
  assert.strictEqual(preview.summary.estimateBeforeSizeFilter, true);

  await assert.rejects(
    manager.run({
      mode: 'copy',
      sourceAccount: account1,
      destinationAccount: account2,
      plan: { ...firstPlan, filters: { since: '2024-02-01', maxSize: 4096 } },
      previewToken: preview.previewToken,
    }),
    /simulation réussie du même plan/,
  );

  const html = fs.readFileSync(path.join(root, 'resources/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'resources/js/app.js'), 'utf8');
  const backend = fs.readFileSync(path.join(root, 'engine/backend.js'), 'utf8');
  const imap = fs.readFileSync(path.join(root, 'engine/lib/imap.js'), 'utf8');
  const fr = JSON.parse(fs.readFileSync(path.join(root, 'resources/locales/fr.json'), 'utf8'));

  assert(html.includes('id="btn-imap-migration-discover"'));
  assert(html.includes('id="imap-migration-folder-body"'));
  assert(html.includes('id="imap-migration-date-from"'));
  assert(html.includes('id="imap-migration-max-size"'));
  assert(app.includes("'migration.imap.discover'"));
  assert(app.includes('imapMigrationPlan()'));
  assert(backend.includes("'migration.imap.discover'"));
  assert(backend.includes("imap.listFolders(sourceAccount, { requireStartTls: true })"));
  assert(imap.includes('delimiter: folder.delimiter || null'));
  assert(imap.includes("folder.flags.has('\\\\Noselect')"));
  assert(imap.includes('doSTARTTLS: true'));
  assert(fr['migrationImap.phaseBadge'].includes('Phase B'));
  assert(fr['migrationImap.filterSemantics'].includes('simulation'));

  console.log('[LibraMail] Test périmètre/filtres Migration IMAP 0.6.1 : OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
