'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const credentialStore = require('../engine/lib/credential_store');
const secrets = new Map();
credentialStore.readServiceSecret = name => secrets.get(String(name)) || '';
credentialStore.writeServiceSecret = (name, value) => {
  secrets.set(String(name), String(value));
  return true;
};
credentialStore.removeServiceSecret = name => secrets.delete(String(name));

const db = require('../engine/lib/db');
const mailStore = require('../engine/lib/mail_store');
const emlImport = require('../engine/lib/eml_import');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-eml-import-'));
const data = path.join(root, 'data');
const imports = path.join(root, 'imports');
fs.mkdirSync(imports, { recursive: true });

const received = path.join(imports, 'received.eml');
const sent = path.join(imports, 'sent.eml');
fs.writeFileSync(received, [
  'From: Alice <alice@example.test>',
  'To: user@example.test',
  'Date: Thu, 20 Aug 2026 08:00:00 +0200',
  'Message-ID: <received-1@example.test>',
  'Subject: Received import',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Imported received body',
].join('\r\n'));
fs.writeFileSync(sent, [
  'From: User <user@example.test>',
  'To: Bob <bob@example.test>',
  'Date: Thu, 20 Aug 2026 08:05:00 +0200',
  'Message-ID: <sent-1@example.test>',
  'Subject: Sent import',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Imported sent body',
].join('\r\n'));

(async () => {
  try {
    db.init(data);
    mailStore.init(data);
    const account = { id: 'test-account', email: 'user@example.test' };

    const first = await emlImport.importFiles({
      account,
      paths: [received, sent],
      mode: 'auto',
    });
    assert.deepStrictEqual(
      { imported: first.imported, duplicates: first.duplicates, failed: first.failed },
      { imported: 2, duplicates: 0, failed: 0 }
    );

    const inbox = db.listMessages({ accountId: account.id, folderRole: 'inbox', spam: null, limit: 20 }) || [];
    const sentRows = db.listMessages({ accountId: account.id, folderRole: 'sent', spam: null, limit: 20 }) || [];
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(sentRows.length, 1);
    assert.strictEqual(inbox[0].folder, emlImport.LOCAL_INBOX);
    assert.strictEqual(sentRows[0].folder, emlImport.LOCAL_SENT);

    const inboxStored = db.getMessage(inbox[0].id);
    assert.strictEqual(inboxStored.storage_kind, 'encrypted');
    assert(mailStore.readMessage(inboxStored).toString('utf8').includes('Imported received body'));

    const second = await emlImport.importFiles({
      account,
      paths: [received, sent],
      mode: 'auto',
    });
    assert.deepStrictEqual(
      { imported: second.imported, duplicates: second.duplicates, failed: second.failed },
      { imported: 0, duplicates: 2, failed: 0 }
    );
    assert.strictEqual(db.countMessages({ accountId: account.id, spam: null }).n, 2);

    const legacyRoot = path.join(data, 'mail');
    const emlFiles = fs.existsSync(legacyRoot)
      ? fs.readdirSync(legacyRoot, { recursive: true }).filter(name => String(name).toLowerCase().endsWith('.eml'))
      : [];
    assert.strictEqual(emlFiles.length, 0);

    console.log('[LibraMail] Test import EML local chiffré : OK');
  } finally {
    try { mailStore.close(); } catch {}
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
