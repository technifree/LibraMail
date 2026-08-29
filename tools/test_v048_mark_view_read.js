'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const db = fs.readFileSync(path.join(root, 'engine/lib/db.js'), 'utf8');
const imap = fs.readFileSync(path.join(root, 'engine/lib/imap.js'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'engine/backend.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'resources/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'resources/index.html'), 'utf8');
const fr = JSON.parse(fs.readFileSync(path.join(root, 'resources/locales/fr.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(root, 'resources/locales/en.json'), 'utf8'));

const unreadStart = db.indexOf('function listUnreadMessages(');
const unreadEnd = db.indexOf('\nfunction setMessagesSeen(', unreadStart);
assert(unreadStart >= 0 && unreadEnd > unreadStart);
const unreadBlock = db.slice(unreadStart, unreadEnd);
assert(unreadBlock.includes('const filter = buildFilter(filters);'));
assert(unreadBlock.includes('AND m.seen=0'));
assert(!unreadBlock.includes('LIMIT'), 'La sélection globale ne doit pas être limitée à la liste UI');

assert(db.includes('function setMessagesSeen(ids, value = true)'));
assert(db.includes('listUnreadMessages,'));
assert(db.includes('setMessagesSeen,'));

const imapStart = imap.indexOf('async function setSeenUids(');
const imapEnd = imap.indexOf('\nasync function moveUids(', imapStart);
assert(imapStart >= 0 && imapEnd > imapStart);
const imapBlock = imap.slice(imapStart, imapEnd);
assert(imapBlock.includes('index += 1000'));
assert(imapBlock.includes("client.messageFlagsAdd(sequence, ['\\\\Seen'], { uid: true })"));
assert(imapBlock.includes("client.messageFlagsRemove(sequence, ['\\\\Seen'], { uid: true })"));
assert(imap.includes('setSeenUids,'));

assert(backend.includes('// LibraMail 0.4.8 — marquer toute la vue comme lue.'));
assert(backend.includes('function markReadFiltersForView(target = {})'));
assert(backend.includes("if (type === 'unified')"));
assert(backend.includes("if (type === 'account')"));
assert(backend.includes("if (type === 'spam')"));
assert(backend.includes("if (type === 'trash')"));
assert(backend.includes("if (type === 'localFolder')"));
assert(backend.includes("if (type === 'label')"));
assert(backend.includes('const unread = db.listUnreadMessages(filters);'));
assert(backend.includes('for (const group of groupMessages(remoteMessages))'));
assert(backend.includes('await imap.setSeenUids(account, first.folder, uids, true);'));
assert(backend.includes("'messages.markViewRead': async ({ view: target } = {}) => markViewRead(target)"));

assert(html.includes('id="btn-mark-view-read"'));
assert(html.includes('data-i18n-title="action.markViewRead"'));

assert(app.includes('function currentMarkReadTarget()'));
assert(app.includes("await rpc('messages.markViewRead', { view: target })"));
assert(app.includes('patchVisibleRowsRead();'));
assert(app.includes('await refreshSidebarCounts();'));
assert(app.includes("if (errors.length) {\n        await refreshVisibleList({ preserveListState: true });"));
assert(!app.includes("await Promise.all([\n        refreshVisibleList({ preserveListState: true }),\n        refreshSidebarCounts(),\n      ]);"));
assert(app.includes("document.getElementById('search-input')?.value"));
assert(app.includes("local-folder-mail-count${unreadCount ? ' has-unread' : ''}"));
assert(app.includes("${unreadCount}/${messageCount}"));

for (const key of [
  'action.markViewRead',
  'status.markViewReadBusy',
  'status.markViewReadDone',
  'status.markViewReadNone',
  'status.markViewReadPartial',
]) {
  assert(fr[key], `Traduction FR manquante : ${key}`);
  assert(en[key], `Traduction EN manquante : ${key}`);
}

console.log('[LibraMail] Tests « Tout marquer comme lu » 0.4.8 : OK');
