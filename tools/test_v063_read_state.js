#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Reproduce the real controller branch which handles a viewed e-mail.
// A one-message conversation is an is_thread row, even when the panel is closed.
const source = fs.readFileSync(path.join(__dirname, '../resources/js/app.js'), 'utf8');
const begin = source.indexOf('  async function setSeenState(row, seen, { automatic = false } = {}) {');
const end = source.indexOf('\n  function clearReader()', begin);
assert(begin >= 0 && end > begin, 'Read-state controller function missing');

async function run({ row, visibleRows, conversation = null }) {
  const calls = [], patches = [];
  const list = {
    rows: visibleRows,
    patchThread(key, patch) {
      patches.push(['thread', key, { ...patch }]);
      const found = this.rows.find(item => item.thread_key === key);
      if (found) Object.assign(found, patch);
    },
    patchRow(id, patch) {
      patches.push(['message', id, { ...patch }]);
      const found = this.rows.find(item => item.id === id);
      if (found) Object.assign(found, patch);
    },
    patchConversationMessage() {},
    expandThread() {},
  };
  let invalidations = 0;
  let readerSeen = null;
  const context = {
    row,
    rpc: async (...args) => { calls.push(args); return true; },
    list,
    currentConversation: conversation,
    Viewer: { current: { meta: { id: row.id, seen: row.seen } } },
    updateReaderTabsFlag() {},
    renderConversationPanel() {},
    invalidateListViewCacheAfterMutation() { invalidations += 1; },
    setReaderSeenButton(value) { readerSeen = value; },
    scheduleSidebarCountsRefresh() {},
    clearReadTimer() {},
  };
  await vm.runInNewContext(`${source.slice(begin, end)}\nsetSeenState(row, true, { automatic: true })`, context);
  return { calls, patches, list, invalidations, readerSeen };
}

(async () => {
  const single = { id: 42, thread_key: 'one', seen: 0, is_thread: true, thread_count: 1, thread_unread: 1 };
  const one = await run({ row: { id: 42, thread_key: 'one', seen: 0 }, visibleRows: [single] });
  assert.equal(one.list.rows[0].thread_unread, 0, 'Single-message conversation stayed unread');
  assert.equal(one.list.rows[0].seen, 1);
  assert.equal(one.readerSeen, true);
  assert.equal(one.invalidations, 1, 'Cached unread rows must be invalidated');
  assert.equal(one.calls[0][0], 'messages.setFlag');

  const rows = [{ id: 44, thread_key: 'long', seen: 0, is_thread: true, thread_count: 2, thread_unread: 2 }];
  const thread = { threadKey: 'long', messages: [
    { id: 43, seen: 0 }, { id: 44, seen: 0 },
  ] };
  const two = await run({ row: { id: 44, thread_key: 'long', seen: 0 }, visibleRows: rows, conversation: thread });
  assert.equal(two.list.rows[0].thread_unread, 1, 'Thread aggregate must reflect remaining unread');
  assert.equal(two.list.rows[0].seen, 0);

  const plain = await run({ row: { id: 51, seen: 0 }, visibleRows: [{ id: 51, seen: 0 }] });
  assert.equal(plain.list.rows[0].seen, 1, 'Ungrouped message was not patched');
  console.log('[OK] LibraMail 0.6.3 : lecture immediate, conversation unique et cache');
})().catch(error => { console.error(error); process.exitCode = 1; });
