#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const migration = require('../engine/lib/imap_migration');
const history = require('../engine/lib/imap_migration_history');

function account(id, host) {
  return { id, receiveProtocol: 'imap', imap: { host, user: `${id}@example.test`, port: 993, secure: true, pass: `secret-${id}` } };
}
const source = migration.accountDescriptor(account('source', 'source.example.test'), 'Source');
const destination = migration.accountDescriptor(account('destination', 'dest.example.test'), 'Destination');

// Source safety is invariant in every mode.
for (const mode of ['login', 'preview', 'copy']) {
  const args = migration.buildCommandArgs(source, destination, mode, { mirror: true });
  assert(args.includes('--nodelete1'), `${mode}: --nodelete1 absent`);
  assert(args.includes('--noexpunge1'), `${mode}: --noexpunge1 absent`);
  assert(!args.includes('--delete1'), `${mode}: suppression source interdite`);
  assert(!args.includes('--expunge1'), `${mode}: expunge source interdite`);
  assert(!args.includes('--delete2folders'), `${mode}: suppression dossiers destination interdite`);
  assert(!args.includes('--expunge2'), `${mode}: expunge destination automatique interdit`);
  assert(args.includes('--noexpunge2'), `${mode}: --noexpunge2 attendu`);
  assert(args.includes('--nouidexpunge2'), `${mode}: --nouidexpunge2 attendu`);
  assert.strictEqual(args.includes('--delete2'), mode !== 'login', `${mode}: --delete2 seulement preview/copy`);
}

// Mirror and filters must never coexist.
for (const filters of [
  { since: '2026-01-01' }, { until: '2026-12-31' }, { minSize: 1024 }, { maxSize: 4096 },
]) {
  assert.throws(() => migration.normalizeMigrationPlan({ mirror: true, filters }), /miroir/i);
}
assert.strictEqual(migration.normalizeMigrationPlan({ mirror: false, filters: { since: '2026-01-01' } }).mirror, false);
assert.throws(() => migration.normalizeMigrationPlan({ mirror: 'yes' }), /miroir/i);

// Preview parser counts destination deletions announced by real imapsync wording.
const summary = migration.emptySummary();
migration.parseSummaryLine(summary, 'Host2: msg INBOX/12 marked \\Deleted on host2 [a]\t(not really since --dry mode)\n');
migration.parseSummaryLine(summary, 'Host2: msg INBOX/13 marked \\Deleted [not in cache] on host2\r\n');
migration.parseSummaryLine(summary, 'Folders deleted on host2                : 0\n');
assert.strictEqual(summary.markedDeleted, 2);
assert.strictEqual(summary.deletedFolders, 0);

// Build a fake successful preview and prove copy cannot run without the exact server-side confirmation.
function fakeChild(lines, closeCode = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {}; child.stderr.setEncoding = () => {};
  child.kill = () => true;
  process.nextTick(() => {
    for (const line of lines) child.stdout.emit('data', line + '\n');
    child.emit('close', closeCode);
  });
  return child;
}
const spawnCalls = [];
const manager = new migration.ImapMigrationManager({
  root: path.resolve(__dirname, '..'),
  engineResolver: () => ({ path: process.execPath, source: 'test' }),
  spawnImpl: (_exe, args) => {
    spawnCalls.push([...args]);
    return fakeChild([
      'Host2: msg INBOX/42 marked \\Deleted on host2 [x]\t(not really since --dry mode)',
      'Messages transferred                    : 0 \t(could be 0 without --dry mode)',
      'Messages skipped                        : 0',
      'Messages found in host1 not in host2    : 0',
      'Detected 0 errors',
      'There is no unidentified message on host1.',
    ]);
  },
});

(async () => {
  const sourceAccount = account('source', 'source.example.test');
  const destinationAccount = account('destination', 'dest.example.test');
  const preview = await manager.run({ mode: 'preview', sourceAccount, destinationAccount, plan: { mirror: true } });
  assert.strictEqual(preview.summary.markedDeleted, 1);
  assert(preview.previewToken);
  assert.strictEqual(manager.status().previewMirror, true);
  assert.strictEqual(manager.status().previewMarkedDeleted, 1);

  await assert.rejects(
    manager.run({ mode: 'copy', sourceAccount, destinationAccount, plan: { mirror: true }, previewToken: preview.previewToken }),
    /Confirmation miroir incorrecte/,
  );
  // Wrong confirmation must not consume the matching preview.
  assert.strictEqual(manager.status().previewValid, true);
  await assert.rejects(
    manager.run({ mode: 'copy', sourceAccount, destinationAccount, plan: { mirror: true }, previewToken: preview.previewToken, mirrorConfirmation: 'supprimer' }),
    /Confirmation miroir incorrecte/,
  );
  assert.strictEqual(manager.status().previewValid, true);

  const copy = await manager.run({
    mode: 'copy', sourceAccount, destinationAccount, plan: { mirror: true },
    previewToken: preview.previewToken, mirrorConfirmation: 'SUPPRIMER',
  });
  assert.strictEqual(copy.ok, true);
  assert(spawnCalls[1].includes('--delete2'));
  assert(!spawnCalls[1].includes('--delete1'));
  assert(!spawnCalls[1].includes('--expunge2'));
  assert.strictEqual(manager.status().previewValid, false);

  // History remembers that a run was destructive, but sanitizePlan does not persist an armable mirror flag.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-mirror-history-'));
  const store = new history.ImapMigrationHistoryStore({ dataDir: temp });
  store.add({
    id: 'mirror-run', startedAt: 1, finishedAt: 2, status: 'completed',
    sourceAccountId: 'source', destinationAccountId: 'destination', mirror: true,
    plan: { mirror: true, folders: [{ source: 'INBOX', destination: 'INBOX' }], filters: {} },
    summary: { markedDeleted: 3 }, elapsedMs: 1, exitCode: 0,
  });
  const saved = store.list()[0];
  assert.strictEqual(saved.mirror, true);
  assert.strictEqual('mirror' in saved.plan, false, 'le miroir ne doit jamais être réarmable depuis le plan historisé');
  assert.strictEqual(saved.summary.markedDeleted, 3);
  fs.rmSync(temp, { recursive: true, force: true });

  const html = fs.readFileSync(path.join(__dirname, '../resources/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../resources/js/app.js'), 'utf8');
  const fr = JSON.parse(fs.readFileSync(path.join(__dirname, '../resources/locales/fr.json'), 'utf8'));
  assert(html.includes('id="imap-migration-mirror"'));
  assert(html.includes('id="confirm-action-typed-input"'));
  assert(app.includes("requireText: I18N.locale === 'en' ? 'DELETE' : 'SUPPRIMER'"));
  assert(app.includes("mirrorConfirmation = 'SUPPRIMER'"));
  assert(app.includes("if (mirror) mirror.checked = false"));
  assert(fr['migrationImap.mirrorSafety'].includes('--nodelete1'));

  console.log('[LibraMail] Test miroir protégé Migration IMAP 0.6.1 : OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
