'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const credentialStore = require('../engine/lib/credential_store');
const secrets = new Map();
credentialStore.readServiceSecret = name => secrets.get(String(name)) || '';
credentialStore.writeServiceSecret = (name, value) => { secrets.set(String(name), String(value)); return true; };
credentialStore.removeServiceSecret = name => secrets.delete(String(name));

const db = require('../engine/lib/db');
const mailStore = require('../engine/lib/mail_store');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-mailstore-test-'));
(async () => {
try {
  db.init(temp);
  mailStore.init(temp);
  const raw = Buffer.from([
    'From: Alice <alice@example.test>',
    'To: Bob <bob@example.test>',
    'Subject: Test chiffrement',
    'Message-ID: <mailstore-test@example.test>',
    'Date: Sat, 15 Aug 2026 12:00:00 +0200',
    '',
    'Contenu confidentiel LibraMail.',
  ].join('\r\n'));
  const row = {
    account_id: 'account-test', folder: 'INBOX', folder_role: 'inbox', uid: 1,
    message_id: '<mailstore-test@example.test>', subject: 'Test chiffrement',
    from_name: 'Alice', from_addr: 'alice@example.test', to_addr: 'bob@example.test',
    date: Date.now(), snippet: 'Contenu confidentiel LibraMail.', seen: 0,
    flagged: 0, answered: 0, has_attach: 0, size: raw.length, is_spam: 0,
    thread_key: 'test-thread', in_reply_to: null, references_json: '[]', eml_path: '',
  };
  const inserted = db.upsertMessage(row);
  const indexed = db.getMessage(inserted.id);
  const legacy = mailStore.expectedEmlPath(temp, indexed);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, raw);
  db.db.prepare('UPDATE messages SET eml_path=?, storage_kind=\'eml\' WHERE id=?').run(legacy, inserted.id);

  const migration = await mailStore.migrateLegacyMessages(db.db);
  assert.strictEqual(migration.encrypted, 1, 'le .eml doit être migré');
  assert.strictEqual(fs.existsSync(legacy), false, 'le .eml n’est supprimé qu’après migration vérifiée');
  const migrated = db.getMessage(inserted.id);
  assert.strictEqual(migrated.storage_kind, 'encrypted');
  assert(mailStore.readMessage(migrated).equals(raw), 'le message déchiffré doit être identique');
  const coverage = mailStore.verifyIndexCoverage(db.db, temp);
  assert.strictEqual(coverage.complete, true);
  assert.strictEqual(coverage.encrypted, 1);
  const secondMigration = await mailStore.migrateLegacyMessages(db.db);
  assert.strictEqual(secondMigration.encrypted, 0, 'une seconde migration doit être idempotente');
  assert.strictEqual(mailStore.verifyIndexCoverage(db.db, temp).complete, true);

  const envelope = mailStore.exportKeyEnvelope('mot-de-passe-test');
  assert.strictEqual(mailStore.unwrapKeyEnvelope(envelope, 'mot-de-passe-test').length, 32);
  assert.throws(() => mailStore.unwrapKeyEnvelope(envelope, 'mauvais-mot-de-passe'), /incorrect|endommag/i);

  console.log('[LibraMail] Test magasin chiffré : OK');
} finally {
  try { mailStore.close(); } catch {}
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
}
})().catch(error => { console.error(error); process.exitCode = 1; });
