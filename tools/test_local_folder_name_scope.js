'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Database = require(require.resolve('better-sqlite3', {
  paths: [path.join(__dirname, '../engine')],
}));
const db = require('../engine/lib/db');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-folder-scope-'));
const databasePath = path.join(root, 'index.db');

function mustThrow(fn, message) {
  let thrown = false;
  try { fn(); } catch { thrown = true; }
  assert(thrown, message);
}

try {
  db.init(root);

  db.db.prepare(`
    INSERT INTO messages(
      id, account_id, folder, folder_role, uid,
      subject, date, seen, is_spam, snippet
    ) VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(
    100, 'account-test', 'INBOX', 'inbox', 100,
    'Test', Date.now(), 1, 0, ''
  );

  const banqueId = Number(db.addLocalFolder('Banque').lastInsertRowid);
  const archivesId = Number(db.addLocalFolder('Archives').lastInsertRowid);
  const contratsId = Number(
    db.addLocalFolder('Contrats', '', banqueId).lastInsertRowid
  );

  db.setMessageLocalFolder(100, contratsId);
  db.close();

  // Recréation volontaire du schéma historique UNIQUE(name).
  const legacy = new Database(databasePath);
  legacy.pragma('foreign_keys = OFF');

  legacy.transaction(() => {
    legacy.exec(`
      CREATE TABLE local_folders_legacy (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        color TEXT NOT NULL DEFAULT '#4f8bd6',
        parent_id INTEGER REFERENCES local_folders_legacy(id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      INSERT INTO local_folders_legacy
        (id, name, color, parent_id, created_at, updated_at)
      SELECT id, name, color, parent_id, created_at, updated_at
        FROM local_folders;

      CREATE TABLE message_local_folder_legacy (
        message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        folder_id INTEGER NOT NULL REFERENCES local_folders_legacy(id) ON DELETE CASCADE,
        assigned_at INTEGER NOT NULL
      );

      INSERT INTO message_local_folder_legacy
        (message_id, folder_id, assigned_at)
      SELECT message_id, folder_id, assigned_at
        FROM message_local_folder;

      DROP TABLE message_local_folder;
      DROP TABLE local_folders;

      ALTER TABLE local_folders_legacy RENAME TO local_folders;
      ALTER TABLE message_local_folder_legacy RENAME TO message_local_folder;
    `);
  })();

  legacy.close();

  // db.init() exécute la migration.
  db.init(root);

  const migrated = db.listLocalFolders();
  assert(migrated.some(item => Number(item.id) === banqueId), 'Banque perdu');
  assert(migrated.some(item => Number(item.id) === archivesId), 'Archives perdu');
  assert(migrated.some(item => Number(item.id) === contratsId), 'Contrats perdu');

  assert.strictEqual(
    Number(db.getMessageLocalFolder(100)?.id),
    contratsId,
    'Affectation du message perdue'
  );

  // Même nom dans des branches différentes : autorisé.
  db.addLocalFolder('2025', '', banqueId);
  db.addLocalFolder('2025', '', archivesId);

  // Même nom entre frères : interdit.
  mustThrow(
    () => db.addLocalFolder('2025', '', banqueId),
    'Doublon entre frères accepté'
  );
  mustThrow(
    () => db.addLocalFolder('2025'.toLowerCase(), '', archivesId),
    'Doublon insensible à la casse accepté'
  );

  // Même nom à la racine : interdit.
  db.addLocalFolder('Racine unique');
  mustThrow(
    () => db.addLocalFolder('racine UNIQUE'),
    'Doublon racine accepté'
  );

  // Un déplacement ne doit pas créer deux frères de même nom.
  const moveId = Number(
    db.addLocalFolder('À déplacer', '', banqueId).lastInsertRowid
  );
  db.addLocalFolder('À déplacer', '', archivesId);

  mustThrow(
    () => db.updateLocalFolder(moveId, 'À déplacer', '', archivesId),
    'Déplacement créant un doublon accepté'
  );

  console.log('[LibraMail] Tests noms de dossiers par parent : OK');
} finally {
  try { db.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
