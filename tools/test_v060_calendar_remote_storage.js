#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../engine/lib/db');

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-calendar-remote-'));
  try {
    db.init(tmp);

    const connection = db.saveCalendarConnection({
      provider: 'google',
      credentialKey: 'calendar-google-test-1',
      email: 'user@example.test',
      displayName: 'Google test',
    });
    assert(connection.id > 0);
    assert.strictEqual(connection.provider, 'google');
    assert.strictEqual(connection.credentialKey, 'calendar-google-test-1');
    assert.strictEqual(connection.enabled, true);
    assert.strictEqual(db.listCalendarConnections().length, 1);

    const work = db.saveCalendarRemoteCalendar({
      connectionId: connection.id,
      remoteId: 'work@example.test',
      name: 'Travail',
      description: 'Agenda partagé',
      timeZone: 'Europe/Paris',
      color: '#4f8bd6',
      accessRole: 'writer',
      primary: false,
      selected: true,
    });
    const personal = db.saveCalendarRemoteCalendar({
      connectionId: connection.id,
      remoteId: 'primary',
      name: 'Personnel',
      timeZone: 'Europe/Paris',
      color: '#8b7dd8',
      accessRole: 'owner',
      primary: true,
      selected: true,
    });
    assert(work.id > 0 && personal.id > 0);
    assert.strictEqual(db.listCalendarRemoteCalendars({ connectionId: connection.id }).length, 2);
    assert.strictEqual(db.listCalendarRemoteCalendars({ connectionId: connection.id, selectedOnly: true }).length, 2);

    const synced = db.updateCalendarRemoteCalendarSync(work.id, {
      syncToken: 'next-sync-token-1',
      lastSyncAt: 123456789,
      lastStatus: 'ok',
      lastError: '',
    });
    assert.strictEqual(synced.syncToken, 'next-sync-token-1');
    assert.strictEqual(synced.lastSyncAt, 123456789);
    assert.strictEqual(synced.lastStatus, 'ok');

    const event = db.saveCalendarEvent({
      title: 'Réunion distante',
      startAt: Date.now() + 3600000,
      endAt: Date.now() + 7200000,
      color: '#4f8bd6',
    });
    const linked = db.setCalendarEventRemoteState(event.id, {
      remoteCalendarId: work.id,
      remoteEventId: 'google-event-123',
      remoteEtag: '"etag-1"',
      remoteUpdatedAt: 987654321,
    });
    assert.strictEqual(linked.remoteCalendarId, work.id);
    assert.strictEqual(linked.remoteCalendarName, 'Travail');
    assert.strictEqual(linked.remoteEventId, 'google-event-123');
    assert.strictEqual(linked.remoteEtag, '"etag-1"');
    assert.strictEqual(linked.remoteUpdatedAt, 987654321);

    assert.throws(() => {
      db.setCalendarEventRemoteState(db.saveCalendarEvent({
        title: 'Doublon',
        startAt: Date.now() + 10800000,
        endAt: Date.now() + 14400000,
      }).id, {
        remoteCalendarId: work.id,
        remoteEventId: 'google-event-123',
      });
    }, /UNIQUE|unique/i);

    const connectionSync = db.updateCalendarConnectionSync(connection.id, {
      lastSyncAt: 222,
      lastStatus: 'ok',
      lastError: '',
    });
    assert.strictEqual(connectionSync.lastSyncAt, 222);

    const removed = db.removeCalendarConnection(connection.id);
    assert.strictEqual(removed.removed, true);
    assert.strictEqual(db.listCalendarConnections().length, 0);
    assert.strictEqual(db.listCalendarRemoteCalendars({}).length, 0);
    assert.strictEqual(db.getCalendarEvent(event.id), null, 'les événements distants doivent suivre la suppression de la connexion');
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('[LibraMail] Test stockage agendas distants 0.6.0 : OK');
}

main();
