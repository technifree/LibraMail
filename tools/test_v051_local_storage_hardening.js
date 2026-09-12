'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const credentialStore = require('../engine/lib/credential_store');

const secrets = new Map();
let failSecrets = false;

credentialStore.readServiceSecret = name => {
  if (failSecrets) throw new Error('Trousseau système indisponible pour le test');
  return secrets.get(String(name)) || '';
};
credentialStore.writeServiceSecret = (name, value) => {
  if (failSecrets) throw new Error('Trousseau système indisponible pour le test');
  secrets.set(String(name), String(value));
  return true;
};
credentialStore.removeServiceSecret = name => secrets.delete(String(name));

const db = require('../engine/lib/db');
const mailStore = require('../engine/lib/mail_store');

function modeOf(target) {
  return fs.statSync(target).mode & 0o777;
}

function assertPrivateIfPosix(target, label) {
  if (process.platform === 'win32' || !fs.existsSync(target)) return;
  assert.strictEqual(modeOf(target), 0o600, `${label} doit être en 0600`);
}

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-storage-hardening-'));
const unavailable = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-storage-unavailable-'));

try {
  const indexFile = path.join(data, 'index.db');
  fs.writeFileSync(indexFile, '', { mode: 0o644 });

  const storeDir = path.join(data, 'mailstore');
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o755 });

  db.init(data);
  const status = mailStore.init(data);
  assert.strictEqual(status.available, true);

  const text = 'Extrait confidentiel LibraMail';
  const protectedSnippet = mailStore.protectSnippet('acc-secure', text);
  assert(protectedSnippet.startsWith('enc1:'), 'le snippet doit être chiffré');

  const row = {
    account_id: 'acc-secure',
    folder: 'INBOX',
    folder_role: 'inbox',
    uid: 1,
    message_id: '<storage-hardening@test>',
    subject: 'Test durcissement stockage',
    from_name: 'Alice',
    from_addr: 'alice@example.test',
    to_addr: 'bob@example.test',
    date: Date.now(),
    snippet: protectedSnippet,
    seen: 0,
    flagged: 0,
    answered: 0,
    has_attach: 0,
    is_spam: 0,
    size: 64,
    eml_path: '',
    thread_key: 'storage-hardening',
    in_reply_to: null,
    references_json: '[]',
  };

  const { id } = db.upsertMessage(row);

  const storeFile = mailStore.storeFileForAccount(data, row.account_id);
  fs.writeFileSync(storeFile, '', { mode: 0o644 });

  const raw = Buffer.from(
    'From: Alice <alice@example.test>\r\n' +
    'To: Bob <bob@example.test>\r\n' +
    'Subject: Test durcissement stockage\r\n\r\n' +
    text
  );
  const descriptor = mailStore.storeMessage({ ...row, id }, raw);
  db.setMessageStorage(id, descriptor);

  assertPrivateIfPosix(indexFile, 'index.db');
  assertPrivateIfPosix(`${indexFile}-wal`, 'index.db-wal');
  assertPrivateIfPosix(`${indexFile}-shm`, 'index.db-shm');
  assertPrivateIfPosix(storeFile, 'mailstore/*.db');
  assertPrivateIfPosix(`${storeFile}-wal`, 'mailstore/*.db-wal');
  assertPrivateIfPosix(`${storeFile}-shm`, 'mailstore/*.db-shm');

  if (process.platform !== 'win32') {
    assert.strictEqual(modeOf(storeDir), 0o700, 'le répertoire mailstore doit être en 0700');
  }

  mailStore.close();
  db.close();

  failSecrets = true;
  const unavailableStatus = mailStore.init(unavailable);
  assert.strictEqual(unavailableStatus.available, false);

  assert.throws(
    () => mailStore.protectSnippet('acc-fail', 'snippet secret'),
    /stockage local chiffré indisponible|trousseau système indisponible|coffre-fort système indisponible/i,
    'un snippet ne doit jamais retomber en clair si la clé manque'
  );
  assert.throws(
    () => mailStore.protectSnippet('acc-fail', ''),
    /stockage local chiffré indisponible|trousseau système indisponible|coffre-fort système indisponible/i,
    'même un message sans texte doit échouer avant une écriture partielle lorsque le coffre est indisponible'
  );

  const imap = read('engine/lib/imap.js');
  const pop3 = read('engine/lib/pop3.js');

  assert(
    !imap.includes(': text.slice(0, 160)'),
    'IMAP ne doit plus contenir de fallback snippet en clair'
  );
  assert(
    !pop3.includes(': text.slice(0, 160)'),
    'POP3 ne doit plus contenir de fallback snippet en clair'
  );
  assert(
    imap.includes('snippet: mailStore.protectSnippet(account.id, text.slice(0, 160))'),
    'IMAP doit toujours protéger le snippet avant insertion'
  );
  assert(
    pop3.includes('snippet: mailStore.protectSnippet(account.id, text.slice(0, 160))'),
    'POP3 doit toujours protéger le snippet avant insertion'
  );

  console.log('[LibraMail] Test durcissement stockage local 0.5.1 : OK');
} finally {
  try { mailStore.close(); } catch {}
  try { db.close(); } catch {}
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(unavailable, { recursive: true, force: true });
}
