const fs = require('fs');
const path = require('path');
const engineDir = process.argv[2];
const source = process.argv[3];
const target = process.argv[4];
const Database = require(path.join(engineDir, 'node_modules', 'better-sqlite3'));

(async () => {
  if (fs.existsSync(target)) fs.unlinkSync(target);
  const src = new Database(source, { readonly: true, fileMustExist: true });
  await src.backup(target);
  src.close();

  const dst = new Database(target);
  try {
    const tables = new Set(dst.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    if (tables.has('messages')) {
      const columns = new Set(dst.prepare('PRAGMA table_info(messages)').all().map(r => r.name));
      if (['id', 'account_id', 'folder', 'uid', 'eml_path'].every(name => columns.has(name))) {
        const rows = dst.prepare("SELECT id, account_id, folder, uid FROM messages WHERE eml_path IS NOT NULL AND eml_path <> ''").all();
        const update = dst.prepare('UPDATE messages SET eml_path=? WHERE id=?');
        const transaction = dst.transaction(items => {
          for (const row of items) {
            const safeFolder = String(row.folder || 'INBOX').replace(/[^A-Za-z0-9_.-]/g, '_');
            const relative = ['mail', String(row.account_id || ''), safeFolder, `${row.uid}.eml`].join('/');
            update.run(relative, row.id);
          }
        });
        transaction(rows);
      }
    }
  } finally {
    dst.close();
  }
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
