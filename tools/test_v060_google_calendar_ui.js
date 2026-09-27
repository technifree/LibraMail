#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../engine/lib/db');

const root = path.resolve(__dirname, '..');
const planner = fs.readFileSync(path.join(root, 'resources/js/planner.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'resources/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'resources/css/app.css'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'engine/backend.js'), 'utf8');
const dbSource = fs.readFileSync(path.join(root, 'engine/lib/db.js'), 'utf8');
const fr = JSON.parse(fs.readFileSync(path.join(root, 'resources/locales/fr.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(root, 'resources/locales/en.json'), 'utf8'));

assert(html.includes('id="planner-google-client-id"'));
assert(html.includes('id="btn-planner-google-connect"'));
assert(html.includes('id="btn-planner-google-cancel"'));
assert(html.includes('id="planner-google-connections"'));
assert(html.includes('id="planner-remote-readonly"'));

assert(css.includes('.planner-google-connection'));
assert(css.includes('.planner-google-calendar-row'));
assert(css.includes('.planner-remote-readonly'));

assert(planner.includes("App.rpc('calendar.google.oauth.begin'"));
assert(planner.includes("App.rpc('calendar.google.oauth.status'"));
assert(planner.includes("App.rpc('calendar.google.oauth.cancel'"));
assert(planner.includes("App.rpc('calendar.google.sync'"));
assert(planner.includes("App.rpc('calendar.google.syncAll'"));
assert(planner.includes("App.rpc('calendar.connections.remove'"));
assert(planner.includes("App.rpc('calendar.remoteCalendars.select'"));
assert(planner.includes("event.remoteCalendarName || event.subscriptionName"));
assert(planner.includes("setRemoteEditorReadonly(Boolean(event.remoteCalendarId))"));
assert(planner.includes("document.getElementById('btn-planner-refresh')?.addEventListener('click', syncAllExternalCalendars)"));
assert(planner.includes("event === 'calendar.google.changed'"));
assert(planner.includes("event === 'calendar.google.oauth.changed'"));

assert(backend.includes("'calendar.remoteCalendars.select': async"));
assert((backend.match(/existing\?\.remoteCalendarId/g) || []).length >= 2);
assert(backend.includes("lecture seule dans cette version de LibraMail"));
assert(dbSource.includes('function setCalendarRemoteCalendarSelected'));
assert(dbSource.includes("DELETE FROM calendar_events WHERE remote_calendar_id=?"));
assert(dbSource.includes('setCalendarRemoteCalendarSelected,'));

for (const messages of [fr, en]) {
  [
    'planner.googleCalendar',
    'planner.googleConnect',
    'planner.googleClientId',
    'planner.googleReadOnlyEvent',
    'planner.internetCalendars',
    'planner.externalSyncDone',
  ].forEach(key => assert.strictEqual(typeof messages[key], 'string', `clé absente: ${key}`));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-google-ui-'));
try {
  db.init(tmp);
  const connection = db.saveCalendarConnection({
    provider: 'google',
    credentialKey: 'google-ui-test',
    oauthClientId: 'desktop.apps.googleusercontent.com',
    displayName: 'Google UI test',
  });
  const remote = db.saveCalendarRemoteCalendar({
    connectionId: connection.id,
    remoteId: 'primary',
    name: 'Principal',
    selected: true,
  });
  const event = db.saveCalendarEvent({
    title: 'Événement Google',
    startAt: Date.now() + 60_000,
    endAt: Date.now() + 120_000,
  });
  db.setCalendarEventRemoteState(event.id, {
    remoteCalendarId: remote.id,
    remoteEventId: 'google-event-ui-test',
  });
  db.updateCalendarRemoteCalendarSync(remote.id, { syncToken: 'sync-token-ui' });

  const disabled = db.setCalendarRemoteCalendarSelected(remote.id, false);
  assert.strictEqual(disabled.calendar.selected, false);
  assert.strictEqual(disabled.calendar.syncToken, '');
  assert.strictEqual(disabled.removedEvents, 1);
  assert.strictEqual(db.getCalendarEvent(event.id), null);

  const enabled = db.setCalendarRemoteCalendarSelected(remote.id, true);
  assert.strictEqual(enabled.calendar.selected, true);
  assert.strictEqual(enabled.calendar.syncToken, '');
} finally {
  try { db.close(); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('[LibraMail] Test interface Google Calendar 0.6.0 : OK');
