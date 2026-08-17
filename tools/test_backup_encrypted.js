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
const backup = require('../engine/lib/backup');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-backup-test-'));
const data = path.join(root, 'data');
const archive = path.join(root, 'backup.zip');
const extractedRoot = path.join(root, 'extract');

(async () => {
  try {
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'accounts.json'), '[]\n');
    fs.writeFileSync(path.join(data, 'config.json'), '{}\n');
    db.init(data);
    mailStore.init(data);
    const raw = Buffer.from('From: a@example.test\r\nTo: b@example.test\r\nSubject: Backup\r\n\r\nSecret backup body');
    const row = {
      account_id: 'backup-account', folder: 'INBOX', folder_role: 'inbox', uid: 1,
      message_id: '<backup@example.test>', subject: 'Backup', from_name: '',
      from_addr: 'a@example.test', to_addr: 'b@example.test', date: Date.now(),
      snippet: 'Secret backup body', seen: 0, flagged: 0, answered: 0, has_attach: 0,
      size: raw.length, eml_path: '', is_spam: 0, thread_key: 'backup-thread',
      in_reply_to: null, references_json: '[]',
    };
    const inserted = db.upsertMessage(row);
    const descriptor = mailStore.storeMessage({ ...row, id: inserted.id }, raw);
    db.setMessageStorage(inserted.id, descriptor);

    const result = await backup.exportArchive({
      dataDir: data, database: db.db, targetPath: archive, appVersion: '0.4.0',
      password: 'mot-de-passe-backup',
    });
    assert.strictEqual(result.manifest.formatVersion, 2);
    assert.strictEqual(result.manifest.mailStoreEncryption.enabled, true);
    assert(result.manifest.mailStoreEncryption.keyEnvelope);

    const inspection = await backup.inspectArchive(archive);
    const extracted = await backup.extractArchive(archive, extractedRoot);
    await backup.validateExtractedData(extracted.dataDir, {
      manifest: inspection.manifest, password: 'mot-de-passe-backup',
    });
    await assert.rejects(
      backup.validateExtractedData(extracted.dataDir, { manifest: inspection.manifest, password: 'incorrect-password' }),
      /incorrect|endommag/i,
    );
    console.log('[LibraMail] Test sauvegarde chiffrée : OK');
  } finally {
    try { mailStore.close(); } catch {}
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
