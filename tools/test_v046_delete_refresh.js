'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'resources', 'js', 'app.js'), 'utf8');

assert(app.includes('async function reconcileAfterMessageDeletion(items = [])'));
assert(app.includes('removeLocalFolderItemsFromVisibleList(normalizedItems);'));
assert(app.includes("updateBulkSelection([], { total: 0, allSelected: false });"));
assert(app.includes('invalidateListViewCacheAfterMutation();'));

const start = app.indexOf('async function reconcileAfterMessageDeletion(items = [])');
const end = app.indexOf('async function prefetchLocalFolderView', start);
assert(start >= 0 && end > start);
const reconcile = app.slice(start, end);

// 0.4.7 conserve les garanties introduites en 0.4.6, mais la
// réconciliation n'est plus bloquante : la ligne est retirée immédiatement
// et les compteurs sont actualisés de façon différée.
assert(reconcile.includes('scheduleSidebarCountsRefresh(160);'));
assert(!reconcile.includes('await refreshVisibleList'));
assert(!reconcile.includes('await refreshSidebarCounts'));

const calls = app.match(/await reconcileAfterMessageDeletion\(deletedItems\);/g) || [];
assert.strictEqual(calls.length, 2);

console.log('[LibraMail] Tests suppression/compteurs 0.4.6→0.4.7 : OK');
