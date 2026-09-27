#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const calendarGoogle = require('../engine/lib/calendar_google');
const mockModule = require('../engine/lib/calendar_google_mock');

(async () => {
  let now = new Date('2026-09-27T08:00:00+02:00').getTime();
  const mock = mockModule.createGoogleCalendarMockService({ now: () => now });
  const client = mock.client();

  const firstCalendars = await client.listCalendars();
  assert.strictEqual(firstCalendars.items.length, 4);
  assert.strictEqual(firstCalendars.items.filter(item => item.readable).length, 3);
  assert(firstCalendars.items.some(item => item.primary && item.accessRole === 'owner'));
  assert(firstCalendars.items.some(item => item.accessRole === 'reader' && item.writable === false));
  assert(firstCalendars.items.some(item => item.accessRole === 'freeBusyReader' && item.readable === false));

  const primaryId = 'mock-primary@example.invalid';
  const initial = await client.listEventChanges({ calendarId: primaryId, syncToken: '' });
  assert.strictEqual(initial.fullSync, true);
  assert(initial.items.length >= 2);
  assert(initial.items.some(item => item.allDay));
  assert(/^mock-sync:/.test(initial.nextSyncToken));

  const unchanged = await client.listEventChanges({ calendarId: primaryId, syncToken: initial.nextSyncToken });
  assert.strictEqual(unchanged.fullSync, false);
  assert.strictEqual(unchanged.items.length, 0);

  mock.advance();
  const delta = await client.listEventChanges({ calendarId: primaryId, syncToken: initial.nextSyncToken });
  assert.strictEqual(delta.fullSync, false);
  assert(delta.items.some(item => /modifiée/.test(item.title)));
  assert(delta.items.some(item => /Nouveau rendez-vous distant/.test(item.title)));

  const workInitial = await client.listEventChanges({ calendarId: 'mock-work@example.invalid', syncToken: '' });
  assert.strictEqual(workInitial.items.some(item => item.remoteEventId === 'mock-work-review'), false,
    'après advance(), le full sync doit refléter la suppression distante');

  mock.expireSyncTokens();
  await assert.rejects(
    () => client.listEventChanges({ calendarId: primaryId, syncToken: delta.nextSyncToken }),
    error => error instanceof calendarGoogle.GoogleCalendarApiError && error.fullSyncRequired && error.status === 410,
  );
  const recovered = await client.listEventChanges({ calendarId: primaryId, syncToken: '' });
  assert.strictEqual(recovered.fullSync, true);
  assert(recovered.items.length >= 3);

  mock.reset();
  assert.strictEqual(mock.status().revision, 1);
  assert.strictEqual(mock.status().pendingExpiredTokens, 0);
  assert.strictEqual(mockModule.isGoogleCalendarMockConnection({ credentialKey: 'mock-google:local' }), true);
  assert.strictEqual(mockModule.isGoogleCalendarMockConnection({ oauthClientId: mockModule.MOCK_CLIENT_ID }), true);
  assert.strictEqual(mockModule.isGoogleCalendarMockConnection({ credentialKey: 'google:real' }), false);

  const root = path.resolve(__dirname, '..');
  const backend = fs.readFileSync(path.join(root, 'engine/backend.js'), 'utf8');
  const planner = fs.readFileSync(path.join(root, 'resources/js/planner.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'resources/index.html'), 'utf8');
  assert(backend.includes("process.env.LIBRAMAIL_GOOGLE_CALENDAR_MOCK === '1'"));
  assert(backend.includes("'calendar.google.mock.status'"));
  assert(backend.includes("'calendar.google.mock.connect'"));
  assert(backend.includes("'calendar.google.mock.advance'"));
  assert(backend.includes("'calendar.google.mock.expireSyncToken'"));
  assert(backend.includes("'calendar.google.mock.reset'"));
  assert(planner.includes("App.rpc('calendar.google.mock.status')"));
  assert(html.includes('id="planner-google-mock"'));
  assert(html.includes('class="planner-google-mock hidden"'));

  console.log('[LibraMail] Test simulateur Google Calendar 0.6.0 : OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
