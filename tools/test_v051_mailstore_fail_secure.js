'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const credentialStore = require('../engine/lib/credential_store');

const originalReadServiceSecret = credentialStore.readServiceSecret;
const originalWriteServiceSecret = credentialStore.writeServiceSecret;
const originalRemoveServiceSecret = credentialStore.removeServiceSecret;

credentialStore.readServiceSecret = () => {
  throw new Error('Trousseau système indisponible pour le test');
};
credentialStore.writeServiceSecret = () => {
  throw new Error('Trousseau système indisponible pour le test');
};

const mailStore = require('../engine/lib/mail_store');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-mailstore-fail-secure-'));

function listEmlFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const found = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.eml')) found.push(target);
    }
  };
  walk(directory);
  return found;
}

try {
  const status = mailStore.init(root);
  assert.strictEqual(status.available, false, 'le magasin doit signaler le coffre indisponible');
  assert.match(status.error, /trousseau|indisponible/i);

  const raw = Buffer.from([
    'From: Alice <alice@example.test>',
    'To: Bob <bob@example.test>',
    'Subject: Fail secure',
    'Message-ID: <fail-secure@example.test>',
    '',
    'Ce corps ne doit jamais être écrit en clair.',
  ].join('\r\n'));

  const row = {
    id: 1,
    account_id: 'account-fail-secure',
    folder: 'INBOX',
    uid: 42,
    storage_kind: 'eml',
    eml_path: '',
  };
  const legacyPath = mailStore.expectedEmlPath(root, row);

  assert.throws(
    () => mailStore.storeMessage(row, raw),
    /stockage local chiffré indisponible|coffre-fort système indisponible|trousseau système indisponible/i,
    'storeMessage doit refuser l’écriture si la clé de chiffrement est indisponible'
  );

  assert.strictEqual(fs.existsSync(legacyPath), false, 'aucun nouvel .eml ne doit être créé');
  assert.deepStrictEqual(
    listEmlFiles(path.join(root, 'mail')),
    [],
    'aucun corps de mail ne doit apparaître en clair dans le répertoire mail'
  );

  const storeDir = path.join(root, 'mailstore');
  assert.strictEqual(fs.existsSync(storeDir), true);
  assert.deepStrictEqual(
    fs.readdirSync(storeDir),
    [],
    'aucune base de magasin ne doit être créée après l’échec avant chiffrement'
  );

  // Compatibilité descendante : les anciens .eml restent lisibles. Le
  // fail-secure concerne uniquement les nouvelles écritures.
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, raw);
  const legacyRead = mailStore.readMessage({ ...row, eml_path: legacyPath });
  assert(legacyRead.equals(raw), 'un ancien .eml doit rester lisible même si le coffre est indisponible');

  console.log('[LibraMail] Test stockage mail fail-secure 0.5.1 : OK');
} finally {
  try { mailStore.close(); } catch {}
  credentialStore.readServiceSecret = originalReadServiceSecret;
  credentialStore.writeServiceSecret = originalWriteServiceSecret;
  credentialStore.removeServiceSecret = originalRemoveServiceSecret;
  fs.rmSync(root, { recursive: true, force: true });
}
