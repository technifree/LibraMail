'use strict';

const fs = require('fs');
const assert = require('assert');

const backend = fs.readFileSync('engine/backend.js', 'utf8');
const app = fs.readFileSync('resources/js/app.js', 'utf8');
const fr = JSON.parse(fs.readFileSync('resources/locales/fr.json', 'utf8'));
const en = JSON.parse(fs.readFileSync('resources/locales/en.json', 'utf8'));

const start = backend.indexOf("'localFolders.assignSelection'");
const end = backend.indexOf('// ---------- Étiquettes ----------', start);
assert(start >= 0 && end > start);
const handler = backend.slice(start, end);

assert(handler.includes('restoreFromTrash = false'));
assert(handler.includes('resolveTrashRestoreSelection(items)'));
assert(handler.includes('isLocalImportedMessage(message)'));
assert(handler.includes("db.moveLocalMessages(ids, 'Local/Imported', 'inbox')"));
assert(handler.includes("throw new Error('LOCAL_FOLDER_TRASH_REMOTE_UNSUPPORTED')"));
assert(handler.includes('restored, folders: db.listLocalFolders()'));

assert(!handler.includes('imap.'));
assert(!handler.includes('serverActionSafe('));

assert(app.includes("const restoreFromTrash = view.type === 'trash' && Boolean(folder);"));
assert(app.includes('restoreFromTrash,'));
assert(app.includes('if (restoreFromTrash) scheduleSidebarCountsRefresh(100);'));
assert(app.includes("t('localFolder.trashRestoreRemoteUnsupported')"));

assert(fr['localFolder.trashRestoreRemoteUnsupported']);
assert(en['localFolder.trashRestoreRemoteUnsupported']);

console.log('[LibraMail] Test Corbeille -> dossier local 0.5.0 : OK');
