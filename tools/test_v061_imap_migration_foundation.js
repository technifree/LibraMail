#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const root = path.resolve(__dirname, '..');
const migration = require('../engine/lib/imap_migration');

function descriptor(id, host, user, secure, password) {
  return { id, host, port: secure ? 993 : 143, user, secure, password };
}

const source = descriptor('source', 'imap.source.test', 'source@example.test', true, 'Source secret 123!');
const destination = descriptor('destination', 'imap.destination.test', 'destination@example.test', false, 'Destination secret 456!');

for (const mode of ['login', 'preview', 'copy']) {
  const args = migration.buildCommandArgs(source, destination, mode);
  assert(args.includes('--nodelete1'), 'la suppression source doit être explicitement interdite');
  assert(args.includes('--noexpunge1'), 'la source ne doit jamais être expurgée');
  assert(args.includes('--noexpunge2'), 'la phase A ne doit pas expurger la destination');
  assert(!args.includes('--delete1'), 'aucun mode ne doit supprimer à la source');
  assert(!args.includes('--delete2'), 'le miroir ne fait pas partie de la phase A');
  assert(!args.some(arg => /^--pass(?:word|file)/i.test(arg)), 'aucun mot de passe sur la ligne de commande');
  assert(!args.includes(source.password) && !args.includes(destination.password));
  assert(args.includes('--ssl1') && args.includes('--notls1'));
  assert(args.includes('--nossl2') && args.includes('--tls2'));
  assert(args.includes('SSL_verify_mode=1'));
  assert(args.includes('SSL_verifycn_scheme=imap'));
  assert(args.includes('SSL_verifycn_name=imap.source.test'));
  assert(args.includes('SSL_verifycn_name=imap.destination.test'));
  if (mode === 'login') assert(args.includes('--justlogin'));
  if (mode === 'preview') assert(args.includes('--dry'));
  if (mode === 'copy') assert(!args.includes('--dry') && !args.includes('--justlogin'));
}

assert.throws(
  () => migration.buildCommandArgs(source, { ...source }, 'copy'),
  /même compte IMAP|deux comptes différents/,
);

const redacted = migration.redactLine(
  `password1=${source.password} encoded=${encodeURIComponent(destination.password)} base64=${Buffer.from(source.password).toString('base64')}`,
  [source.password, destination.password],
);
assert(!redacted.includes(source.password));
assert(!redacted.includes(destination.password));
assert(!redacted.includes(encodeURIComponent(destination.password)));
assert(!redacted.includes(Buffer.from(source.password).toString('base64')));
assert(redacted.includes('[MASQUÉ]'));

const env = migration.processEnvironment(
  { PATH: '/usr/bin', IMAPSYNC_PASSWORD1: 'old', IMAPSYNC_FOO: 'bar', HOME: '/tmp/home' },
  source.password,
  destination.password,
);
assert.strictEqual(env.PATH, '/usr/bin');
assert.strictEqual(env.HOME, '/tmp/home');
assert.strictEqual(env.IMAPSYNC_PASSWORD1, source.password);
assert.strictEqual(env.IMAPSYNC_PASSWORD2, destination.password);
assert(!('IMAPSYNC_FOO' in env));

const summary = migration.emptySummary();
for (const line of [
  'Host1 Total size:                 50000 bytes (48.828 KiB)',
  'Messages transferred                    : 0 \t(could be 3 without --dry mode)',
  'Messages skipped                        : 2',
  'Messages found in host1 not in host2    : 3 messages',
  'Total bytes skipped                     : 20000 (19.531 KiB)',
  'Detected 0 errors',
  'There is no unidentified message on host1.',
]) migration.parseSummaryLine(summary, line);
assert.strictEqual(summary.plannable, 3);
assert.strictEqual(summary.skipped, 2);
assert.strictEqual(summary.missing, 3);
assert.strictEqual(summary.errors, 0);
assert.strictEqual(summary.unidentified, 0);
assert.strictEqual(migration.estimatedBytes(summary), 30000);

function fakeAccount(id, host, user, secure, password) {
  return {
    id,
    receiveProtocol: 'imap',
    displayName: id,
    email: user,
    imap: { host, port: secure ? 993 : 143, secure, user, pass: password },
  };
}

const account1 = fakeAccount('a', 'imap.a.test', 'a@test.invalid', true, 'alpha-secret');
const account2 = fakeAccount('b', 'imap.b.test', 'b@test.invalid', false, 'beta-secret');
const spawns = [];

function fakeSpawn(program, args, options) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  spawns.push({ program, args: [...args], env: { ...options.env } });
  process.nextTick(() => {
    const lines = args.includes('--justlogin') ? [
      'Detected 0 errors',
    ] : args.includes('--dry') ? [
      'Host1 Total size:                 50000 bytes (48.828 KiB)',
      'Messages transferred                    : 0 \t(could be 3 without --dry mode)',
      'Messages skipped                        : 2',
      'Messages found in host1 not in host2    : 3 messages',
      'Total bytes skipped                     : 20000 (19.531 KiB)',
      'Detected 0 errors',
      'There is no unidentified message on host1.',
    ] : [
      'Messages transferred                    : 3',
      'Messages skipped                        : 2',
      'Messages found in host1 not in host2    : 0 messages',
      'Total bytes transferred                 : 30000 (29.297 KiB)',
      'Detected 0 errors',
      'There is no unidentified message on host1.',
    ];
    child.stdout.write(lines.join('\n') + '\n');
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);
  });
  return child;
}

(async () => {
  const events = [];
  const manager = new migration.ImapMigrationManager({
    root,
    spawnImpl: fakeSpawn,
    engineResolver: () => ({ path: '/fake/imapsync', source: 'test' }),
    onEvent: (event, data) => events.push({ event, data }),
  });

  const login = await manager.run({ mode: 'login', sourceAccount: account1, destinationAccount: account2 });
  assert(login.ok && login.mode === 'login');

  let preview = await manager.run({ mode: 'preview', sourceAccount: account1, destinationAccount: account2 });
  assert(preview.ok && preview.previewToken);
  assert.strictEqual(preview.summary.plannable, 3);
  assert.strictEqual(preview.summary.estimatedBytes, 30000);

  await assert.rejects(
    manager.run({
      mode: 'copy',
      sourceAccount: account1,
      destinationAccount: { ...account2, imap: { ...account2.imap, host: 'changed.test' } },
      previewToken: preview.previewToken,
    }),
    /simulation réussie du même plan/,
  );

  preview = await manager.run({ mode: 'preview', sourceAccount: account1, destinationAccount: account2 });
  const copy = await manager.run({
    mode: 'copy',
    sourceAccount: account1,
    destinationAccount: account2,
    previewToken: preview.previewToken,
  });
  assert(copy.ok && copy.summary.destinationConfirmed);
  assert.strictEqual(copy.summary.transferred, 3);
  assert.strictEqual(copy.summary.transferredBytes, 30000);

  for (const call of spawns) {
    assert(!call.args.includes(account1.imap.pass));
    assert(!call.args.includes(account2.imap.pass));
    assert.strictEqual(call.env.IMAPSYNC_PASSWORD1, account1.imap.pass);
    assert.strictEqual(call.env.IMAPSYNC_PASSWORD2, account2.imap.pass);
  }
  assert(events.some(item => item.event === 'migration.imap.started'));
  assert(events.some(item => item.event === 'migration.imap.line'));
  assert(events.some(item => item.event === 'migration.imap.done'));
  assert(!events.some(item => JSON.stringify(item.data).includes(account1.imap.pass)));
  assert(!events.some(item => JSON.stringify(item.data).includes(account2.imap.pass)));

  const html = fs.readFileSync(path.join(root, 'resources/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'resources/js/app.js'), 'utf8');
  const backend = fs.readFileSync(path.join(root, 'engine/backend.js'), 'utf8');
  const fr = JSON.parse(fs.readFileSync(path.join(root, 'resources/locales/fr.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(root, 'resources/locales/en.json'), 'utf8'));

  assert(html.includes('data-settings-tab="migration"'));
  assert(html.includes('data-settings-panel="migration"'));
  assert(html.includes('id="btn-imap-migration-test"'));
  assert(html.includes('id="btn-imap-migration-preview"'));
  assert(html.includes('id="btn-imap-migration-copy"') && html.includes('disabled'));
  assert(app.includes("'migration.imap.preview'"));
  assert(app.includes("'migration.imap.copy'"));
  assert(app.includes('invalidateImapMigrationPreview'));
  assert(backend.includes("'migration.imap.test'"));
  assert(backend.includes("'migration.imap.preview'"));
  assert(backend.includes("'migration.imap.copy'"));
  assert(backend.includes("'migration.imap.cancel'"));
  assert(backend.includes("'migration.imap.invalidatePreview'"));
  assert(fr['settings.tab.migration'] === 'Migration IMAP');
  assert(en['settings.tab.migration'] === 'IMAP migration');
  assert(fr['migrationImap.safety'].includes('simulation réussie'));
  assert(html.includes('id="btn-imap-migration-origin"'));
  assert(html.includes('data-i18n="migrationImap.origin"'));
  assert(app.includes('https://github.com/Othman-Benbrahim/Mailbox-Synchroniseur'));
  assert(fr['migrationImap.origin'].includes('Mailbox Synchroniseur'));
  assert(en['migrationImap.origin'].includes('Mailbox Synchroniseur'));
  const notices = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert(notices.includes('https://github.com/Othman-Benbrahim/Mailbox-Synchroniseur'));
  assert(notices.includes('Copyright (c) 2026 Mailbox Synchroniseur contributors'));

  console.log('[LibraMail] Test socle Migration IMAP 0.6.1 : OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
