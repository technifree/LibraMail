#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const db = require('../engine/lib/db');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'resources/js/app.js'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'engine/backend.js'), 'utf8');

// Vérifier le vrai schéma, les vraies requêtes et les compteurs par compte.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-v062-'));
try {
  db.init(directory);
  const insert = db.db.prepare(`INSERT INTO messages
    (account_id, folder, folder_role, uid, date, thread_key, seen, is_spam)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  db.db.transaction(() => {
    insert.run('a', 'INBOX', 'inbox', 1, 100, 'thread:1', 0, 0);
    insert.run('a', 'INBOX', 'inbox', 2, 200, 'thread:1', 1, 0);
    insert.run('a', 'INBOX', 'inbox', 3, 300, 'thread:2', 1, 0);
    insert.run('a', 'Junk', 'junk', 4, 400, 'spam:4', 0, 1);
    insert.run('a', 'Sent', 'sent', 5, 500, 'sent:5', 1, 0);
    insert.run('a', 'Trash', 'trash', 6, 600, 'trash:6', 1, 0);
    insert.run('b', 'INBOX', 'inbox', 1, 700, 'thread:7', 0, 0);
    insert.run('b', 'Sent', 'sent', 2, 800, 'sent:8', 1, 0);
  })();
  // Classement local : le message sort de la vue standard sans être supprimé.
  db.db.prepare(`INSERT INTO local_folders (id, name, created_at, updated_at)
                  VALUES (1, 'Classés', 1, 1)`).run();
  db.db.prepare(`INSERT INTO message_local_folder (message_id, folder_id, assigned_at)
                  VALUES (3, 1, 1)`).run();
  db.db.prepare(`INSERT INTO message_local_folder (message_id, folder_id, assigned_at)
                  VALUES (8, 1, 1)`).run();

  const counts = db.sidebarCounts();
  assert.equal(counts.unifiedUnread, 2);
  assert.equal(counts.spamTotal, 1);
  assert.equal(counts.sentTotal, 1);
  assert.equal(counts.trashTotal, 1);
  assert.deepEqual(counts.accounts.a, { n: 2, unread: 1 });
  assert.deepEqual(counts.accounts.b, { n: 1, unread: 1 });
  assert.equal(counts.accounts.a.n, db.countMessages({ folderRole: 'inbox', spam: 0,
    excludeLocalFolders: true, accountId: 'a' }).n);

  const plan = db.db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM messages
    WHERE COALESCE(NULLIF(thread_key, ''), 'message:' || id) = ?`).all('thread:1');
  assert(plan.some(row => String(row.detail).includes('idx_msg_conversation_key')),
    `Index de conversation non utilisé : ${JSON.stringify(plan)}`);
  const conversations = db.listConversations({ folderRole: 'inbox', spam: 0 });
  assert(conversations.some(row => row.thread_key === 'thread:1' && row.thread_unread === 1),
    'Une conversation avec dernier message lu doit rester non lue tant que son premier ne l’est pas');
} finally {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

// Exécuter la vraie fonction du contrôleur avec un minuteur déterministe,
// sans navigateur ni compte de messagerie externe.
const begin = app.indexOf('  function scheduleAutoMarkRead(meta, token) {');
const end = app.indexOf('\n  function setReaderSeenButton(', begin);
assert(begin >= 0 && end > begin);
const scheduleCode = app.slice(begin, end);
function testReading({ meta, conversation = null, auto = true, delay = 0 }) {
  const calls = [];
  const timers = [];
  const context = {
    config: { autoMarkRead: auto, markReadDelaySeconds: delay },
    currentConversation: conversation,
    currentMessageToken: 5,
    currentReadTimer: null,
    Viewer: { current: { meta: { ...meta } } },
    setSeenState: (row, seen, options) => { calls.push({ row, seen, options }); return Promise.resolve(); },
    status: error => { throw error; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 1; },
  };
  vm.runInNewContext(`${scheduleCode}\nscheduleAutoMarkRead(meta, 5);`, { ...context, meta });
  return { calls, timers };
}
{
  const msg = { id: 11, thread_key: 'thread:11', seen: 0 };
  const immediate = testReading({ meta: msg });
  assert.equal(immediate.calls.length, 1);
  assert.equal(immediate.calls[0].row.id, 11);
  assert.equal(immediate.calls[0].seen, true);
  assert.equal(immediate.timers.length, 0);
  const alreadyRead = testReading({ meta: { ...msg, seen: 1 } });
  assert.equal(alreadyRead.calls.length, 0);
  const disabled = testReading({ meta: msg, auto: false });
  assert.equal(disabled.calls.length, 0);
  const delayed = testReading({ meta: msg, delay: 2 });
  assert.equal(delayed.calls.length, 0);
  assert.equal(delayed.timers[0].ms, 2000);
  delayed.timers[0].fn();
  assert.equal(delayed.calls.length, 1);
}
{
  const last = { id: 12, thread_key: 'thread:11', seen: 1 };
  const thread = { threadKey: 'thread:11', messages: [
    { id: 11, thread_key: 'thread:11', seen: 0 }, last,
  ] };
  const opened = testReading({ meta: last, conversation: thread });
  assert.equal(opened.calls.length, 1);
  assert.equal(opened.calls[0].row.is_thread, true);
  assert.equal(opened.calls[0].row.thread_key, 'thread:11');
}

assert(app.includes("rpc('messages.sidebarSummary')"));
assert(backend.includes("'messages.sidebarSummary': async ()"));
assert(backend.includes('queueServerSeen(messages, Boolean(value));'));
assert(backend.includes("broadcast('folder.updated', { kind: 'trash', accountId })"));
assert(backend.includes('Math.min(3, groups.length)'));
console.log('[OK] LibraMail 0.6.2 : lecture immédiate, fils, compteurs, index et opérations par lots');
