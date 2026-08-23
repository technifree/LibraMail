'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../engine/lib/db');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-local-tree-'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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

  // Cas de régression exactement représentatif :
  // Job = 2 directs, Job1 = 2 directs, Job11 = 1 direct.
  insertMessage.run(1, 'account-a', 'INBOX', 'inbox', 1, 'Job A', Date.now(), 0, 0, '');
  insertMessage.run(2, 'account-a', 'INBOX', 'inbox', 2, 'Job B', Date.now(), 1, 0, '');
  insertMessage.run(3, 'account-a', 'INBOX', 'inbox', 3, 'Job1 A', Date.now(), 0, 0, '');
  insertMessage.run(4, 'account-a', 'INBOX', 'inbox', 4, 'Job1 B', Date.now(), 0, 0, '');
  insertMessage.run(5, 'account-a', 'INBOX', 'inbox', 5, 'Job11 A', Date.now(), 1, 0, '');

  const rootId = Number(db.addLocalFolder('Job').lastInsertRowid);
  const childId = Number(db.addLocalFolder('Job1', '', rootId).lastInsertRowid);
  const grandId = Number(db.addLocalFolder('Job11', '', childId).lastInsertRowid);

  db.setMessageLocalFolder(1, rootId);
  db.setMessageLocalFolder(2, rootId);
  db.setMessageLocalFolder(3, childId);
  db.setMessageLocalFolder(4, childId);
  db.setMessageLocalFolder(5, grandId);

  let folders = db.listLocalFolders();
  const rootFolder = folders.find(item => Number(item.id) === rootId);
  const childFolder = folders.find(item => Number(item.id) === childId);
  const grandFolder = folders.find(item => Number(item.id) === grandId);

  assert(Number(rootFolder?.child_count) === 1, 'Job doit avoir un enfant');
  assert(Number(childFolder?.parent_id) === rootId, 'Job1 doit être enfant de Job');
  assert(Number(grandFolder?.parent_id) === childId, 'Job11 doit être enfant de Job1');

  assert(Number(rootFolder?.direct_message_count) === 2, 'Job doit contenir 2 messages directs');
  assert(Number(childFolder?.direct_message_count) === 2, 'Job1 doit contenir 2 messages directs');
  assert(Number(grandFolder?.direct_message_count) === 1, 'Job11 doit contenir 1 message direct');

  assert(Number(rootFolder?.message_count) === 5, 'Job doit afficher 5 messages au total');
  assert(Number(childFolder?.message_count) === 3, 'Job1 doit afficher 3 messages au total');
  assert(Number(grandFolder?.message_count) === 1, 'Job11 doit afficher 1 message au total');

  assert(Number(rootFolder?.unread_count) === 3, 'Job doit agréger 3 non lus');
  assert(Number(childFolder?.unread_count) === 2, 'Job1 doit agréger 2 non lus');
  assert(Number(grandFolder?.unread_count) === 0, 'Job11 ne doit avoir aucun non lu');

  mustThrow(
    () => db.removeLocalFolder(rootId),
    'Un parent ne doit pas être supprimable avec enfants'
  );
  mustThrow(
    () => db.updateLocalFolder(rootId, 'Job', '', grandId),
    'Un cycle doit être refusé'
  );

  console.log('[LibraMail] Tests arborescence + compteurs récursifs : OK (Job=5, Job1=3, Job11=1)');
} finally {
  try { db.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
