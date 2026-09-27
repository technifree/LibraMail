#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const mock = require('../engine/lib/calendar_google_mock');

const removedIds = [];
const fakeDb = {
  listCalendarConnections() {
    return [
      {
        id: 1,
        provider: 'google',
        credentialKey: `${mock.MOCK_CREDENTIAL_PREFIX}local`,
        oauthClientId: mock.MOCK_CLIENT_ID,
      },
      {
        id: 2,
        provider: 'google',
        credentialKey: 'calendar-google-real-1',
        oauthClientId: 'real-client.apps.googleusercontent.com',
      },
      {
        id: 3,
        provider: 'google',
        credentialKey: `${mock.MOCK_CREDENTIAL_PREFIX}old`,
        oauthClientId: '',
      },
    ];
  },
  removeCalendarConnection(id) {
    removedIds.push(Number(id));
    return { removed: true };
  },
};

const result = mock.purgePersistedMockConnections(fakeDb);
assert.deepStrictEqual(result, { removedConnections: 2 });
assert.deepStrictEqual(removedIds, [1, 3], 'la connexion Google réelle ne doit jamais être supprimée');

assert.strictEqual(
  mock.isGoogleCalendarMockConnection({
    credentialKey: 'calendar-google-real-1',
    oauthClientId: 'real-client.apps.googleusercontent.com',
  }),
  false,
);
assert.strictEqual(
  mock.isGoogleCalendarMockConnection({
    credentialKey: `${mock.MOCK_CREDENTIAL_PREFIX}local`,
  }),
  true,
);

const backend = fs.readFileSync(path.join(__dirname, '..', 'engine', 'backend.js'), 'utf8');
assert(backend.includes("if (!GOOGLE_CALENDAR_MOCK_ENABLED) {"));
assert(backend.includes("calendarGoogleMock.purgePersistedMockConnections(db)"));
assert(backend.includes("Données Google Calendar simulées nettoyées"));

console.log('[LibraMail] Test isolation simulateur Google Calendar 0.6.0 : OK');
