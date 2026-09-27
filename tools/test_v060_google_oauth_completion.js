#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const calendarAuth = require('../engine/lib/calendar_auth');

async function testTokenEndpointTimeout() {
  const fetchImpl = (_url, options = {}) => new Promise((resolve, reject) => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    if (options.signal?.aborted) return reject(error);
    options.signal?.addEventListener('abort', () => reject(error), { once: true });
  });

  const started = Date.now();
  await assert.rejects(
    () => calendarAuth.exchangeAuthorizationCode({
      provider: 'google',
      clientId: 'desktop-test.apps.googleusercontent.com',
      code: 'authorization-code-test',
      codeVerifier: 'a'.repeat(43),
      redirectUri: 'http://127.0.0.1:54321/oauth2/google/callback',
      fetchImpl,
      timeoutMs: 1000,
    }),
    /délai d’attente dépassé/i,
  );
  assert(Date.now() - started < 5000, 'le timeout OAuth ne doit pas laisser le flux bloqué indéfiniment');
}

function testBackendCompletionContract() {
  const backend = fs.readFileSync(path.join(__dirname, '../engine/backend.js'), 'utf8');
  const savePos = backend.indexOf('connection = db.saveCalendarConnection({');
  const pendingPos = backend.indexOf('syncPending: true');
  const startSyncPos = backend.indexOf('startInitialGoogleCalendarSync(connection.id, loginHint)');
  assert(savePos >= 0 && pendingPos > savePos && startSyncPos > pendingPos,
    'la connexion doit être persistée avant la synchronisation initiale en arrière-plan');
  assert(backend.includes('function startInitialGoogleCalendarSync('));
  assert(backend.includes("action: 'initial-sync-complete'"));
  assert(backend.includes("action: 'initial-sync-error'"));
}

function testUiContract() {
  const planner = fs.readFileSync(path.join(__dirname, '../resources/js/planner.js'), 'utf8');
  const fr = JSON.parse(fs.readFileSync(path.join(__dirname, '../resources/locales/fr.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '../resources/locales/en.json'), 'utf8'));
  assert(planner.includes("t('planner.googleConnectedSyncing')"));
  assert(fr['planner.googleConnectedSyncing']);
  assert(en['planner.googleConnectedSyncing']);
}

(async () => {
  await testTokenEndpointTimeout();
  testBackendCompletionContract();
  testUiContract();
  console.log('[LibraMail] Test finalisation OAuth Google Calendar 0.6.0 : OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
