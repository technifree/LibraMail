'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require(require.resolve('better-sqlite3', {
  paths: [path.join(__dirname, '../engine')],
}));

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
const backup = require('../engine/lib/backup');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-local-folder-backup-'));
const data = path.join(root, 'data');
const archive = path.join(root, 'backup.zip');
const extractedRoot = path.join(root, 'extract');

(async () => {
  let restoredDb = null;
  try {
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'accounts.json'), '[]\n');
    fs.writeFileSync(path.join(data, 'config.json'), '{}\n');

    db.init(data);
    mailStore.init(data);

    const raw = Buffer.from([
      'From: banque@example.test',
      'To: user@example.test',
      'Subject: Relevé',
      'Message-ID: <local-folder-backup@example.test>',
      '',
      'Message de test sauvegarde dossiers locaux',
    ].join('\r\n'));

    const row = {
      account_id: 'backup-account',
      folder: 'INBOX',
      folder_role: 'inbox',
      uid: 1,
      message_id: '<local-folder-backup@example.test>',
      subject: 'Relevé',
      from_name: 'Banque',
      from_addr: 'banque@example.test',
      to_addr: 'user@example.test',
      date: Date.now(),
      snippet: 'Message de test sauvegarde dossiers locaux',
      seen: 1,
      flagged: 0,
      answered: 0,
      has_attach: 0,
      size: raw.length,
      eml_path: '',
      is_spam: 0,
      thread_key: 'local-folder-backup-thread',
      in_reply_to: null,
      references_json: '[]',
    };

    const inserted = db.upsertMessage(row);
    const descriptor = mailStore.storeMessage({ ...row, id: inserted.id }, raw);
    db.setMessageStorage(inserted.id, descriptor);

    const rootFolder = db.addLocalFolder('Banque');
    const rootId = Number(rootFolder.lastInsertRowid);
    const childFolder = db.addLocalFolder('Relevés', '', rootId);
    const childId = Number(childFolder.lastInsertRowid);
    const grandFolder = db.addLocalFolder('2026', '', childId);
    const grandId = Number(grandFolder.lastInsertRowid);

    db.setMessageLocalFolder(inserted.id, grandId);

    await backup.exportArchive({
      dataDir: data,
      database: db.db,
      targetPath: archive,
      appVersion: '0.4.4',
      password: 'mot-de-passe-backup',
    });

    const inspection = await backup.inspectArchive(archive);
    const extracted = await backup.extractArchive(archive, extractedRoot);
    await backup.validateExtractedData(extracted.dataDir, {
      manifest: inspection.manifest,
      password: 'mot-de-passe-backup',
    });

    restoredDb = new Database(path.join(extracted.dataDir, 'index.db'), { readonly: true });

    const folders = restoredDb.prepare(`
      SELECT id, name, parent_id
        FROM local_folders
       WHERE id IN (?,?,?)
       ORDER BY id
    `).all(rootId, childId, grandId);

    assert.strictEqual(folders.length, 3, 'Les trois niveaux doivent être présents dans la sauvegarde');

    const restoredRoot = folders.find(item => Number(item.id) === rootId);
    const restoredChild = folders.find(item => Number(item.id) === childId);
    const restoredGrand = folders.find(item => Number(item.id) === grandId);

    assert.strictEqual(restoredRoot.parent_id, null, 'Le dossier racine ne doit pas avoir de parent');
    assert.strictEqual(Number(restoredChild.parent_id), rootId, 'Le niveau 2 doit conserver son parent');
    assert.strictEqual(Number(restoredGrand.parent_id), childId, 'Le niveau 3 doit conserver son parent');

    const assignment = restoredDb.prepare(`
      SELECT folder_id
        FROM message_local_folder
       WHERE message_id=?
    `).get(inserted.id);

    assert(assignment, 'L’affectation du message au dossier local doit être sauvegardée');
    assert.strictEqual(Number(assignment.folder_id), grandId, 'Le message doit rester dans le niveau 3');

    console.log('[LibraMail] Test sauvegarde dossiers locaux hiérarchiques : OK');
  } finally {
    try { restoredDb?.close(); } catch {}
    try { mailStore.close(); } catch {}
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
