'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(
  path.join(__dirname, '..', 'resources', 'js', 'app.js'),
  'utf8'
);

assert(app.includes('// LibraMail 0.4.6 — mutations légères sans rafraîchissement complet.'));
assert(app.includes('function invalidateLabelCachedViews(labelIds = [])'));
assert(app.includes('function scheduleLabelSidebarRefresh(delay = 70)'));
assert(app.includes('function reconcileLabelMutation(labelId, {'));
assert(app.includes('function patchSelectionFlagInPlace(items, flag, value)'));
assert(app.includes('scheduleSidebarCountsRefresh(220);'));
assert(app.includes('updateCurrentListCacheRows(list.rows);'));

const bulkFlagStart = app.indexOf('async function runBulkFlag(flag, value)');
const bulkFlagEnd = app.indexOf('async function runBulkRestore()', bulkFlagStart);
const bulkFlag = app.slice(bulkFlagStart, bulkFlagEnd);
assert(bulkFlag.includes('patchSelectionFlagInPlace(bulkSelection, flag, Boolean(value));'));
assert(!bulkFlag.includes('await refresh();'));
assert(!bulkFlag.includes('clearReader();'));

const quickStart = app.indexOf('async function renderQuickLabelMenu(context, token)');
const quickEnd = app.indexOf('async function toggleQuickLabelMenu(row, anchor)', quickStart);
const quick = app.slice(quickStart, quickEnd);
assert(quick.includes('reconcileLabelMutation(label.id'));
assert(!quick.includes("renderLabels(await rpc('labels.list'))"));
assert(!quick.includes('await refreshVisibleList({ preserveListState: true });'));

const bulkLabelStart = app.indexOf('async function renderBulkLabelMenu()');
const bulkLabelEnd = app.indexOf('async function toggleBulkLabelMenu(event)', bulkLabelStart);
const bulkLabel = app.slice(bulkLabelStart, bulkLabelEnd);
assert(bulkLabel.includes('const affectedItems = [...bulkSelection];'));
assert(bulkLabel.includes('reconcileLabelMutation(label.id'));
assert(!bulkLabel.includes("renderLabels(await rpc('labels.list'))"));
assert(!bulkLabel.includes('await refreshVisibleList({ preserveListState: true });'));

const readerLabelStart = app.indexOf('async function renderLabelMenu()');
const readerLabelEnd = app.indexOf('async function toggleLabelMenu(event)', readerLabelStart);
const readerLabel = app.slice(readerLabelStart, readerLabelEnd);
assert(readerLabel.includes('reconcileLabelMutation(label.id'));
assert(!readerLabel.includes('await refreshVisibleList({ preserveListState: true });'));

console.log('[LibraMail] Tests performance mutations 0.4.6 : OK');
