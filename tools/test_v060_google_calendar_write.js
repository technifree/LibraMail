#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../engine/lib/db');
const calendarGoogleMock = require('../engine/lib/calendar_google_mock');
const calendarGoogleSync = require('../engine/lib/calendar_google_sync');
const calendarGoogleWrite = require('../engine/lib/calendar_google_write');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-google-write-'));
  try {
    db.init(tmp);
    const mock = calendarGoogleMock.createGoogleCalendarMockService({
      now: () => new Date('2026-09-27T08:00:00+02:00').getTime(),
    });
    const connection = db.saveCalendarConnection({
      provider: 'google',
      credentialKey: 'mock-google:write-test',
      oauthClientId: calendarGoogleMock.MOCK_CLIENT_ID,
      email: calendarGoogleMock.MOCK_EMAIL,
      displayName: 'Google write test',
    });
    const client = mock.client();
    const sync = calendarGoogleSync.createGoogleCalendarSyncEngine({ db, client });
    await sync.syncConnection(connection.id);

    const write = calendarGoogleWrite.createGoogleCalendarWriteEngine({
      db,
      clientForConnection: () => client,
    });
    const calendars = db.listCalendarRemoteCalendars({ connectionId: connection.id });
    const primary = calendars.find(item => item.primary);
    const readonly = calendars.find(item => item.accessRole === 'reader');
    assert(primary && readonly);
    assert.strictEqual(calendarGoogleWrite.isWritableCalendar(primary), true);
    assert.strictEqual(calendarGoogleWrite.isWritableCalendar(readonly), false);

    const created = await write.createEvent(primary.id, {
      title: 'Créé depuis LibraMail',
      startAt: new Date('2026-10-02T09:00:00+02:00').getTime(),
      endAt: new Date('2026-10-02T10:00:00+02:00').getTime(),
      location: 'Local test',
      notes: 'Écriture bidirectionnelle',
    });
    assert.strictEqual(created.created, true);
    assert(created.event.remoteEventId);
    assert(created.event.remoteEtag);
    assert.strictEqual(created.event.remoteCalendarId, primary.id);

    const updated = await write.updateEvent(created.event.id, {
      ...created.event,
      title: 'Modifié depuis LibraMail',
      location: 'Local test 2',
    });
    assert.strictEqual(updated.conflict, false);
    assert.strictEqual(updated.event.title, 'Modifié depuis LibraMail');
    assert.notStrictEqual(updated.event.remoteEtag, created.event.remoteEtag);

    await assert.rejects(
      () => write.createEvent(readonly.id, {
        title: 'Interdit',
        startAt: Date.now() + 60_000,
        endAt: Date.now() + 120_000,
      }),
      /lecture seule/i,
    );

    const stale = db.listCalendarEvents({}).find(item => item.remoteCalendarId === primary.id && item.remoteEventId === 'mock-primary-meeting');
    assert(stale);
    mock.simulateConflict(primary.remoteId);
    const conflict = await write.updateEvent(stale.id, {
      ...stale,
      title: 'Tentative locale sur version périmée',
    });
    assert.strictEqual(conflict.conflict, true);
    assert(conflict.event);
    assert(/Modification externe non synchronisée/.test(conflict.event.title));

    const retried = await write.updateEvent(stale.id, {
      ...conflict.event,
      title: 'Réappliqué après conflit',
    });
    assert.strictEqual(retried.conflict, false);
    assert.strictEqual(retried.event.title, 'Réappliqué après conflit');

    const removed = await write.deleteEvent(created.event.id);
    assert.strictEqual(removed.removed, true);
    assert.strictEqual(db.getCalendarEvent(created.event.id), null);

    const root = path.resolve(__dirname, '..');
    const backend = fs.readFileSync(path.join(root, 'engine/backend.js'), 'utf8');
    const planner = fs.readFileSync(path.join(root, 'resources/js/planner.js'), 'utf8');
    assert(backend.includes("const calendarGoogleWrite = require('./lib/calendar_google_write')"));
    assert(backend.includes("'calendar.google.mock.conflict'"));
    assert(planner.includes('planner.googleConflictUpdate'));
    assert(planner.includes("value=\"google:${Number(calendar.id)}\""));

    console.log('[LibraMail] Test écriture bidirectionnelle Google Calendar 0.6.0 : OK');
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
