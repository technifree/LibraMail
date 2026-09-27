#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../engine/lib/db');
const { GoogleCalendarApiError } = require('../engine/lib/calendar_google');
const { createGoogleCalendarSyncEngine } = require('../engine/lib/calendar_google_sync');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-google-sync-'));
  let clock = 1000;
  try {
    db.init(tmp);
    const connection = db.saveCalendarConnection({
      provider: 'google',
      credentialKey: 'calendar-google-sync-test',
      email: 'user@example.test',
      displayName: 'Google test',
    });

    let phase = 0;
    let shared410Raised = false;
    const client = {
      async listCalendars() {
        if (phase === 3) {
          return { items: [{
            remoteId: 'primary', name: 'Personnel', color: '#8B7DD8', accessRole: 'owner',
            primary: true, selected: true, readable: true, writable: true,
          }] };
        }
        return { items: [
          {
            remoteId: 'primary', name: 'Personnel', color: '#8B7DD8', accessRole: 'owner',
            primary: true, selected: true, readable: true, writable: true,
          },
          {
            remoteId: 'shared@example.test', name: 'Travail partagé', color: '#4F8BD6', accessRole: 'writer',
            primary: false, selected: true, readable: true, writable: true,
          },
          {
            remoteId: 'freebusy@example.test', name: 'Disponibilités', color: '#667085', accessRole: 'freeBusyReader',
            primary: false, selected: true, readable: false, writable: false,
          },
        ] };
      },
      async listEventChanges({ calendarId, syncToken }) {
        if (phase === 0 && calendarId === 'primary') {
          assert.strictEqual(syncToken, '');
          return {
            fullSync: true,
            nextSyncToken: 'primary-sync-1',
            items: [
              { remoteEventId: 'event-a', remoteEtag: 'etag-a1', remoteUpdatedAt: 100, title: 'A', startAt: 100000, endAt: 160000, allDay: false, location: '', notes: '' },
              { remoteEventId: 'event-b', remoteEtag: 'etag-b1', remoteUpdatedAt: 100, title: 'B', startAt: 200000, endAt: 260000, allDay: false, location: '', notes: '' },
            ],
          };
        }
        if (phase === 0 && calendarId === 'shared@example.test') {
          assert.strictEqual(syncToken, '');
          return {
            fullSync: true,
            nextSyncToken: 'shared-sync-1',
            items: [
              { remoteEventId: 'shared-old', remoteEtag: 'etag-s1', remoteUpdatedAt: 100, title: 'Partagé', startAt: 300000, endAt: 360000, allDay: false, location: '', notes: '' },
            ],
          };
        }
        if (phase === 1 && calendarId === 'primary') {
          assert.strictEqual(syncToken, 'primary-sync-1');
          return {
            fullSync: false,
            nextSyncToken: 'primary-sync-2',
            items: [
              { remoteEventId: 'event-a', remoteEtag: 'etag-a2', remoteUpdatedAt: 200, title: 'A modifié', startAt: 100000, endAt: 170000, allDay: false, location: 'Paris', notes: 'mise à jour' },
              { remoteEventId: 'event-b', remoteEtag: 'etag-b2', remoteUpdatedAt: 200, deleted: true },
            ],
          };
        }
        if (phase === 1 && calendarId === 'shared@example.test') {
          assert.strictEqual(syncToken, 'shared-sync-1');
          return { fullSync: false, nextSyncToken: 'shared-sync-2', items: [] };
        }
        if (phase === 2 && calendarId === 'primary') {
          assert.strictEqual(syncToken, 'primary-sync-2');
          return { fullSync: false, nextSyncToken: 'primary-sync-3', items: [] };
        }
        if (phase === 2 && calendarId === 'shared@example.test') {
          if (syncToken === 'shared-sync-2' && !shared410Raised) {
            shared410Raised = true;
            throw new GoogleCalendarApiError('Sync token expiré', { status: 410, reason: 'fullSyncRequired' });
          }
          assert.strictEqual(syncToken, '');
          return {
            fullSync: true,
            nextSyncToken: 'shared-sync-3',
            items: [
              { remoteEventId: 'shared-new', remoteEtag: 'etag-s2', remoteUpdatedAt: 300, title: 'Nouveau partagé', startAt: 400000, endAt: 460000, allDay: false, location: '', notes: '' },
            ],
          };
        }
        if (phase === 3 && calendarId === 'primary') {
          assert.strictEqual(syncToken, 'primary-sync-3');
          return { fullSync: false, nextSyncToken: 'primary-sync-4', items: [] };
        }
        throw new Error(`Appel inattendu ${phase}/${calendarId}/${syncToken}`);
      },
    };

    const engine = createGoogleCalendarSyncEngine({ db, client, now: () => ++clock });

    const first = await engine.syncConnection(connection.id);
    assert.strictEqual(first.created, 3);
    assert.strictEqual(first.failedCalendars, 0);
    assert.strictEqual(db.listCalendarRemoteCalendars({ connectionId: connection.id }).length, 2, 'freeBusyReader ne doit pas être synchronisé');
    const primary = db.getCalendarRemoteCalendarByRemoteId(connection.id, 'primary');
    const shared = db.getCalendarRemoteCalendarByRemoteId(connection.id, 'shared@example.test');
    assert(primary && shared);
    assert.strictEqual(primary.syncToken, 'primary-sync-1');
    assert.strictEqual(shared.syncToken, 'shared-sync-1');
    assert.strictEqual(db.getCalendarEventByRemote(primary.id, 'event-a').title, 'A');
    assert.strictEqual(db.getCalendarEventByRemote(shared.id, 'shared-old').title, 'Partagé');

    phase = 1;
    const second = await engine.syncConnection(connection.id);
    assert.strictEqual(second.updated, 1);
    assert.strictEqual(second.removed, 1);
    assert.strictEqual(db.getCalendarEventByRemote(primary.id, 'event-a').title, 'A modifié');
    assert.strictEqual(db.getCalendarEventByRemote(primary.id, 'event-a').location, 'Paris');
    assert.strictEqual(db.getCalendarEventByRemote(primary.id, 'event-b'), null);
    assert.strictEqual(db.getCalendarRemoteCalendar(shared.id).syncToken, 'shared-sync-2');

    phase = 2;
    const third = await engine.syncConnection(connection.id);
    assert.strictEqual(third.fullSyncResets, 1);
    assert.strictEqual(db.getCalendarEventByRemote(shared.id, 'shared-old'), null, 'le full sync après 410 doit purger les événements devenus absents');
    assert.strictEqual(db.getCalendarEventByRemote(shared.id, 'shared-new').title, 'Nouveau partagé');
    assert.strictEqual(db.getCalendarRemoteCalendar(shared.id).syncToken, 'shared-sync-3');

    phase = 3;
    const fourth = await engine.syncConnection(connection.id);
    assert.strictEqual(fourth.discovery.removed, 1, 'un agenda qui disparaît de CalendarList doit être retiré localement');
    assert.strictEqual(db.getCalendarRemoteCalendarByRemoteId(connection.id, 'shared@example.test'), null);
    assert.strictEqual(db.getCalendarEventByRemote(shared.id, 'shared-new'), null);
    assert.strictEqual(db.getCalendarConnection(connection.id).lastStatus, 'ok');
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('[LibraMail] Test moteur de synchronisation Google Calendar 0.6.0 : OK');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
