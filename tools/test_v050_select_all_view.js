'use strict';

const fs = require('fs');
const assert = require('assert');

const list = fs.readFileSync('resources/js/maillist.js', 'utf8');
const app = fs.readFileSync('resources/js/app.js', 'utf8');
const backend = fs.readFileSync('engine/backend.js', 'utf8');

assert(list.includes('this.allViewSelectionItems = null;'));
assert(list.includes('setAllViewSelection(items = [])'));
assert(list.includes('allView: true'));
assert(list.includes('? (this.allViewSelectionItems'));
assert(list.includes('? this.allViewSelectionItems'));
assert(list.includes('this.allViewSelectionItems = null;\n    }\n    const key'));

assert(app.includes('let bulkSelectionMeta = { total: 0, allSelected: false, allView: false };'));
assert(app.includes('allView: Boolean(meta.allView)'));
assert(app.includes('async function selectAllCurrentView()'));
assert(app.includes("rpc('messages.selectionForView'"));
assert(app.includes('list.setAllViewSelection(result?.items || [])'));
assert(app.includes("document.getElementById('btn-select-all').onclick = () =>"));

assert(backend.includes('function selectionItemsForView(target = {}, conversationMode = true)'));
assert(backend.includes('db.countConversations(filters)'));
assert(backend.includes('db.countMessages(filters)'));
assert(backend.includes('limit: total'));
assert(backend.includes("'messages.selectionForView'"));

console.log('[LibraMail] Test sélection globale de vue 0.5.0 : OK');
