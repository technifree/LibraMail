#!/usr/bin/env node
'use strict';

const assert = require('assert');
const google = require('../engine/lib/calendar_google');

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

(async () => {
  const calendarOwner = google.normalizeCalendarListEntry({
    id: 'primary@example.test',
    summary: 'Personnel',
    backgroundColor: '#8b7dd8',
    timeZone: 'Europe/Paris',
    accessRole: 'owner',
    primary: true,
  });
  assert.strictEqual(calendarOwner.primary, true);
  assert.strictEqual(calendarOwner.writable, true);
  assert.strictEqual(calendarOwner.color, '#8B7DD8');

  const specialWriter = google.normalizeCalendarListEntry({
    id: 'shared@example.test',
    summary: 'Partagé',
    accessRole: 'writerWithoutPrivateAccess',
  });
  assert.strictEqual(specialWriter.readable, true);
  assert.strictEqual(specialWriter.writable, true);

  const allDay = google.normalizeGoogleEvent({
    id: 'all-day-1',
    etag: '"etag-a"',
    status: 'confirmed',
    summary: 'Jour complet',
    start: { date: '2026-09-27' },
    end: { date: '2026-09-28' },
    updated: '2026-09-27T10:00:00Z',
  });
  assert.strictEqual(allDay.allDay, true);
  assert.strictEqual(allDay.endAt - allDay.startAt, 24 * 60 * 60 * 1000);

  const cancelled = google.normalizeGoogleEvent({ id: 'gone-1', status: 'cancelled' });
  assert.strictEqual(cancelled.deleted, true);

  const outbound = google.localEventToGoogle({
    title: 'Test',
    startAt: Date.parse('2026-09-27T10:00:00Z'),
    endAt: Date.parse('2026-09-27T11:00:00Z'),
    notes: 'Note',
    location: 'Paris',
  });
  assert.strictEqual(outbound.summary, 'Test');
  assert.strictEqual(outbound.start.dateTime, '2026-09-27T10:00:00.000Z');

  const calls = [];
  let tokenGeneration = 0;
  const client = google.createGoogleCalendarClient({
    getAccessToken: async ({ forceRefresh }) => {
      if (forceRefresh) tokenGeneration += 1;
      return tokenGeneration ? 'token-refreshed' : 'token-initial';
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      const call = calls.length;
      if (call === 1) return response(401, { error: { code: 401, message: 'Expired', errors: [{ reason: 'authError' }] } });
      if (call === 2) return response(200, {
        items: [{ id: 'primary', summary: 'Principal', accessRole: 'owner', primary: true }],
        nextPageToken: 'p2',
      });
      if (call === 3) return response(200, {
        items: [{ id: 'shared', summary: 'Partagé', accessRole: 'reader' }],
        nextSyncToken: 'calendar-list-token',
      });
      if (call === 4) return response(200, {
        timeZone: 'Europe/Paris',
        items: [{
          id: 'evt-1', status: 'confirmed', summary: 'Rendez-vous', etag: '"e1"',
          start: { dateTime: '2026-09-27T14:00:00+02:00' },
          end: { dateTime: '2026-09-27T15:00:00+02:00' },
          updated: '2026-09-27T12:00:00Z',
        }],
        nextPageToken: 'events-p2',
      });
      if (call === 5) return response(200, {
        timeZone: 'Europe/Paris',
        items: [{ id: 'evt-deleted', status: 'cancelled', etag: '"e2"' }],
        nextSyncToken: 'events-sync-token',
      });
      if (call === 6) return response(200, {
        items: [],
        nextSyncToken: 'events-sync-token-2',
      });
      if (call === 7) return response(200, { id: 'created', etag: '"new"' });
      if (call === 8) return response(200, { id: 'evt-1', etag: '"patched"' });
      if (call === 9) return { ok: true, status: 204, async json() { throw new Error('no body'); } };
      throw new Error(`unexpected call ${call}`);
    },
  });

  const calendars = await client.listCalendars();
  assert.strictEqual(calendars.items.length, 2);
  assert.strictEqual(calendars.nextSyncToken, 'calendar-list-token');
  assert.strictEqual(calls[0].options.headers.authorization, 'Bearer token-initial');
  assert.strictEqual(calls[1].options.headers.authorization, 'Bearer token-refreshed');
  assert.strictEqual(calls[1].url.searchParams.get('maxResults'), '250');
  assert.strictEqual(calls[2].url.searchParams.get('pageToken'), 'p2');

  const full = await client.listEventChanges({
    calendarId: 'shared@example.test',
    timeMin: '2025-09-27T00:00:00Z',
    timeMax: '2031-09-27T00:00:00Z',
  });
  assert.strictEqual(full.fullSync, true);
  assert.strictEqual(full.items.length, 2);
  assert.strictEqual(full.items[1].deleted, true);
  assert.strictEqual(full.nextSyncToken, 'events-sync-token');
  assert.strictEqual(calls[3].url.searchParams.get('singleEvents'), 'true');
  assert.strictEqual(calls[3].url.searchParams.get('showDeleted'), 'true');
  assert.strictEqual(calls[3].url.searchParams.get('maxResults'), '2500');
  assert.strictEqual(calls[4].url.searchParams.get('pageToken'), 'events-p2');

  const incremental = await client.listEventChanges({
    calendarId: 'shared@example.test',
    syncToken: 'events-sync-token',
  });
  assert.strictEqual(incremental.fullSync, false);
  assert.strictEqual(incremental.nextSyncToken, 'events-sync-token-2');
  assert.strictEqual(calls[5].url.searchParams.get('syncToken'), 'events-sync-token');
  assert.strictEqual(calls[5].url.searchParams.get('timeMin'), null);
  assert.strictEqual(calls[5].url.searchParams.get('timeMax'), null);
  await assert.rejects(() => client.listEventChanges({
    calendarId: 'primary', syncToken: 'x', timeMin: '2026-01-01T00:00:00Z',
  }), /timeMin\/timeMax/);

  await client.insertEvent('primary', {
    title: 'Créé', startAt: Date.now() + 3600000, endAt: Date.now() + 7200000,
  });
  assert.strictEqual(calls[6].options.method, 'POST');
  assert.strictEqual(calls[6].url.origin, 'https://www.googleapis.com');

  await client.patchEvent('primary', 'evt-1', {
    title: 'Modifié', startAt: Date.now() + 3600000, endAt: Date.now() + 7200000,
  }, { etag: '"etag-before"' });
  assert.strictEqual(calls[7].options.method, 'PATCH');
  assert.strictEqual(calls[7].options.headers['if-match'], '"etag-before"');

  await client.deleteEvent('primary', 'evt-1', { etag: '"etag-after"' });
  assert.strictEqual(calls[8].options.method, 'DELETE');
  assert.strictEqual(calls[8].options.headers['if-match'], '"etag-after"');

  let goneCalls = 0;
  const goneClient = google.createGoogleCalendarClient({
    getAccessToken: async () => 'token',
    fetchImpl: async () => {
      goneCalls += 1;
      return response(410, {
        error: { code: 410, message: 'Sync token is no longer valid', errors: [{ reason: 'fullSyncRequired' }] },
      });
    },
  });
  await assert.rejects(
    () => goneClient.listEventChanges({ calendarId: 'primary', syncToken: 'expired' }),
    error => error instanceof google.GoogleCalendarApiError
      && error.status === 410
      && error.fullSyncRequired === true,
  );
  assert.strictEqual(goneCalls, 1);

  console.log('[LibraMail] Test client Google Calendar API 0.6.0 : OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
