'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'resources/js/app.js'), 'utf8');
const mail = fs.readFileSync(path.join(root, 'resources/js/maillist.js'), 'utf8');

assert(app.includes('// LibraMail 0.4.7 — propagation immédiate des étiquettes dans les discussions.'));
assert(app.includes('const selectedThreadKeys = new Set(threadKeys);'));
assert(app.includes('for (const threadKey of selectedThreadKeys)'));
assert(app.includes('currentConversation.messages = currentConversation.messages.map(message => ({'));
assert(app.includes('list.expandThread(threadKey, currentConversation.messages, activeId);'));
assert(app.includes('list.patchExpandedThreadMessages?.(threadKey, message => ({'));

assert(mail.includes("// LibraMail 0.4.7 — mise à jour locale des messages d'une discussion dépliée."));
assert(mail.includes('patchExpandedThreadMessages(threadKey, updater)'));
assert(mail.includes('const state = this.expandedThreads.get(key);'));
assert(mail.includes('this.expandedThreads.set(key, { ...state, messages });'));
assert(mail.includes('this.render(true);'));

// Garde-fou : l'étiquetage d'un message individuel ne doit pas être transformé
// en étiquetage de toute sa discussion.
const selectedThreadPos = app.indexOf('const selectedThreadKeys = new Set(threadKeys);');
const viewerThreadPos = app.indexOf('if (viewerThread) threadKeys.add(viewerThread);', selectedThreadPos);
assert(selectedThreadPos >= 0 && viewerThreadPos > selectedThreadPos);

console.log('[LibraMail] Tests étiquettes discussions 0.4.7 : OK');
