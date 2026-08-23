'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../engine/lib/db');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-folder-move-'));

function mustThrow(fn, message) {
  let thrown = false;
  try { fn(); } catch { thrown = true; }
  assert(thrown, message);
}

try {
  db.init(root);

  const insertMessage = db.db.prepare(`
    INSERT INTO messages(
      id, account_id, folder, folder_role, uid,
      subject, date, seen, is_spam, snippet
    ) VALUES(?,?,?,?,?,?,?,?,?,?)
  `);

  insertMessage.run(1, 'account-a', 'INBOX', 'inbox', 1, 'M1', Date.now(), 0, 0, '');
  insertMessage.run(2, 'account-a', 'INBOX', 'inbox', 2, 'M2', Date.now(), 1, 0, '');

  const a = Number(db.addLocalFolder('A').lastInsertRowid);
  const b = Number(db.addLocalFolder('B').lastInsertRowid);
  const child = Number(db.addLocalFolder('Projet', '', a).lastInsertRowid);
  const grand = Number(db.addLocalFolder('Sous-projet', '', child).lastInsertRowid);

  db.setMessageLocalFolder(1, child);
  db.setMessageLocalFolder(2, grand);

  let folders = db.listLocalFolders();
  assert(Number(folders.find(f => Number(f.id) === a)?.message_count) === 2);
  assert(Number(folders.find(f => Number(f.id) === b)?.message_count) === 0);

  db.updateLocalFolder(child, 'Projet', '', b);

  folders = db.listLocalFolders();
  assert(Number(folders.find(f => Number(f.id) === child)?.parent_id) === b);
  assert(Number(folders.find(f => Number(f.id) === grand)?.parent_id) === child);
  assert(Number(folders.find(f => Number(f.id) === a)?.message_count) === 0);
  assert(Number(folders.find(f => Number(f.id) === b)?.message_count) === 2);
  assert(Number(folders.find(f => Number(f.id) === child)?.message_count) === 2);

  mustThrow(
    () => db.updateLocalFolder(b, 'B', '', grand),
    'Un déplacement cyclique doit être refusé'
  );

  db.addLocalFolder('Projet', '', a);
  mustThrow(
    () => db.updateLocalFolder(child, 'Projet', '', a),
    'Un déplacement créant deux frères de même nom doit être refusé'
  );

  db.updateLocalFolder(child, 'Projet', '', null);
  folders = db.listLocalFolders();
  assert(
    folders.find(f => Number(f.id) === child)?.parent_id == null,
    'Projet doit pouvoir revenir à la racine'
  );

  console.log('[LibraMail] Tests déplacement dossiers locaux : OK');
} finally {
  try { db.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
