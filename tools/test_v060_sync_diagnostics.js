#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const backend = fs.readFileSync(path.join(__dirname, '../engine/backend.js'), 'utf8');
const imap = fs.readFileSync(path.join(__dirname, '../engine/lib/imap.js'), 'utf8');
const pop3 = fs.readFileSync(path.join(__dirname, '../engine/lib/pop3.js'), 'utf8');
const googleSync = fs.readFileSync(path.join(__dirname, '../engine/lib/calendar_google_sync.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../resources/js/app.js'), 'utf8');
const planner = fs.readFileSync(path.join(__dirname, '../resources/js/planner.js'), 'utf8');
const fr = JSON.parse(fs.readFileSync(path.join(__dirname, '../resources/locales/fr.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(__dirname, '../resources/locales/en.json'), 'utf8'));

assert(backend.includes('sanitizeSyncDiagnosticError'));
assert(backend.includes('syncDiagnosticCategory'));
assert(backend.includes("broadcast('calendar.google.sync.started'"));
assert(backend.includes("broadcast('calendar.google.sync.progress'"));
assert(backend.includes("broadcast('calendar.google.sync.done'"));
assert(backend.includes("broadcast('calendar.google.sync.error'"));
assert(backend.includes("protocol: meta.protocol"));
assert(backend.includes("category: syncDiagnosticCategory(error)"));
assert(backend.includes("results.diagnostics || null"));
assert(backend.includes("replace(/Bearer\\s+"));
assert(backend.includes("access_token|refresh_token|client_secret"));

for (const phase of ['connecting', 'connected', 'folder-start', 'folder-done', 'retry', 'timeout', 'summary']) {
  assert(imap.includes(`phase: '${phase}'`), `phase IMAP manquante: ${phase}`);
}
assert(imap.includes("protocol: 'imap'"));
assert(imap.includes("Object.defineProperty(results, 'diagnostics'"));

for (const phase of ['connecting', 'connected', 'listing', 'deleting', 'summary']) {
  assert(pop3.includes(`phase: '${phase}'`), `phase POP3 manquante: ${phase}`);
}
assert(pop3.includes("protocol: 'pop3'"));
assert(pop3.includes('diagnostics,'));

assert(googleSync.includes('onProgress = null'));
for (const phase of ['discovery-start', 'discovery-done', 'calendar-start', 'calendar-done', 'calendar-error', 'full-resync', 'summary']) {
  assert(googleSync.includes(`phase: '${phase}'`), `phase Google manquante: ${phase}`);
}
assert(googleSync.includes("protocol: 'google-calendar'"));

assert(app.includes("event === 'calendar.google.sync.started'"));
assert(app.includes("event === 'calendar.google.sync.progress'"));
assert(app.includes("event === 'calendar.google.sync.done'"));
assert(app.includes("event === 'calendar.google.sync.error'"));
assert(app.includes('function syncDiagnosticSuffix'));
assert(planner.includes("event === 'calendar.google.sync.progress'"));

for (const locale of [fr, en]) {
  for (const key of [
    'activity.syncConnecting', 'activity.syncConnected', 'activity.syncFolderStart',
    'activity.syncFolderDone', 'activity.syncRetry', 'activity.syncTimeout',
    'activity.diagnosticDuration', 'activity.diagnosticConnect',
    'activity.googleSyncStarted', 'activity.googleSyncDone', 'activity.googleSyncFailed',
    'planner.googleSyncDiagnosticDiscovery', 'planner.googleSyncDiagnosticDone',
  ]) assert(locale[key], `traduction manquante: ${key}`);
}

// Les diagnostics structurés ne doivent jamais transporter les secrets OAuth.
assert(!googleSync.includes('accessToken'));
assert(!googleSync.includes('refreshToken'));
assert(!googleSync.includes('clientSecret'));

console.log('[LibraMail] Test diagnostics de synchronisation 0.6.0 : OK');
