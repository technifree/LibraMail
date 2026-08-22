'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../engine/lib/db');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-local-folders-'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  db.init(root);

  const insertMessage = db.db.prepare(`
    INSERT INTO messages(
      id, account_id, folder, folder_role, uid, subject, date,
      seen, is_spam, snippet
    ) VALUES(?,?,?,?,?,?,?,?,?,?)
  `);
  insertMessage.run(1, 'account-a', 'INBOX', 'inbox', 1, 'Message A', Date.now(), 0, 0, '');
  insertMessage.run(2, 'account-b', 'Sent', 'sent', 2, 'Message B', Date.now(), 1, 0, '');
  insertMessage.run(3, 'account-a', 'Trash', 'trash', 3, 'Message C', Date.now(), 0, 0, '');

  db.addLocalFolder('Banque', '#336699');
  const folder = db.listLocalFolders().find(item => item.name === 'Banque');
  assert(folder, 'Le dossier Banque n’a pas été créé');

  const assigned = db.setMessagesLocalFolder([1, 2, 3], folder.id);
  assert(assigned.processed === 3, 'Trois messages devaient être traités');

  const selected = db.getMessageLocalFolder(1);
  assert(selected && selected.id === folder.id, 'Le message 1 doit être classé dans Banque');

  const counts = db.countMessages({
    localFolderId: folder.id,
    folderRoles: ['inbox', 'sent', 'other'],
    spam: 0,
  });
  assert(counts.n === 2, 'Le filtre du dossier local doit exclure la corbeille');
  assert(counts.unread === 1, 'Un message doit être non lu');

  const listed = db.listLocalFolders().find(item => item.id === folder.id);
  assert(Number(listed.message_count) === 2, 'Le compteur visible du dossier doit être 2');
  assert(Number(listed.unread_count) === 1, 'Le compteur non lu visible doit être 1');

  db.updateLocalFolder(folder.id, 'Banque 2026', '#445566');
  assert(db.listLocalFolders().some(item => item.name === 'Banque 2026'), 'Le renommage a échoué');

  db.setMessageLocalFolder(1, null);
  assert(db.getMessageLocalFolder(1) === null, 'Le déclassement du message 1 a échoué');

  assert(db.removeLocalFolder(folder.id), 'La suppression du dossier a échoué');
  assert(db.getMessage(2), 'Supprimer un dossier local ne doit pas supprimer le message');

  console.log('[LibraMail] Tests dossiers locaux : OK');
} finally {
  try { db.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
