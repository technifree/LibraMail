'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'app.js'), 'utf8');

assert(app.includes('// LibraMail 0.4.6 — réconciliation forte après suppression.'));
assert(app.includes('async function reconcileAfterMessageDeletion(items = [])'));
assert(app.includes('removeLocalFolderItemsFromVisibleList(normalizedItems);'));
assert(app.includes("updateBulkSelection([], { total: 0, allSelected: false });"));
assert(app.includes('invalidateListViewCacheAfterMutation();'));
assert(app.includes('await refreshSidebarCounts();'));

const calls = app.match(/await reconcileAfterMessageDeletion\(deletedItems\);/g) || [];
assert.strictEqual(calls.length, 2);

console.log('[LibraMail] Tests suppression/compteurs 0.4.6 : OK');
