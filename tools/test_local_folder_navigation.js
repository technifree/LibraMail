'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(
  path.join(__dirname, '..', 'resources', 'js', 'app.js'),
  'utf8'
);

assert(app.includes('// LibraMail 0.4.4 — navigation locale préchargée'));
assert(app.includes('LOCAL_FOLDER_CACHE_FRESH_MS = 3500'));
assert(app.includes('LOCAL_FOLDER_PREFETCH_TTL_MS = 15000'));
assert(app.includes('function localFolderPrefetchCandidates(folderId)'));
assert(app.includes('function scheduleLocalFolderPrefetch(folderId'));
assert(app.includes('function scheduleLocalFolderRevalidate(options'));
assert(app.includes('refresh({ localFolderNavigation: true });'));
assert(app.includes('if (!localFolderNavigation) scheduleSidebarCountsRefresh();'));
assert(app.includes('invalidateLocalFolderCachedViews(['));

// Non-régressions.
assert(app.includes('// LibraMail 0.4.4 — déplacement des dossiers locaux par Pointer Events.'));
assert(app.includes('libramail:local-folder-drag-start'));
assert(app.includes('const listViewCache = new Map();'));

console.log('[LibraMail] Tests navigation dossiers locaux 3E-3 : OK');
