#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const db = require('../engine/lib/db');
const { createGoogleOAuthFlowManager } = require('../engine/lib/calendar_google_oauth');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body,
      }));
    });
    req.on('error', reject);
  });
}

async function testLoopbackOAuth() {
  let received = null;
  const manager = createGoogleOAuthFlowManager({
    timeoutMs: 60_000,
    onCode: async payload => {
      received = payload;
      return { connection: { id: 42, provider: 'google' }, syncError: '' };
    },
  });

  const flow = await manager.begin({
    clientId: 'desktop-test.apps.googleusercontent.com',
    loginHint: 'user@example.test',
  });
  assert.strictEqual(flow.status, 'pending');
  assert(flow.redirectUri.startsWith('http://127.0.0.1:'));
  assert(flow.authUrl.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'));
  assert(!Object.prototype.hasOwnProperty.call(flow, 'codeVerifier'));

  const authUrl = new URL(flow.authUrl);
  const state = authUrl.searchParams.get('state');
  assert(state);
  assert.strictEqual(authUrl.searchParams.get('redirect_uri'), flow.redirectUri);
  assert.strictEqual(authUrl.searchParams.get('code_challenge_method'), 'S256');

  const wrong = await httpGet(`${flow.redirectUri}?state=wrong&code=evil`);
  assert.strictEqual(wrong.status, 403);
  assert.strictEqual(manager.status(flow.id).status, 'pending');
  assert.strictEqual(received, null);

  const ok = await httpGet(`${flow.redirectUri}?state=${encodeURIComponent(state)}&code=authorization-code-test`);
  assert.strictEqual(ok.status, 200);
  assert(String(ok.headers['cache-control'] || '').includes('no-store'));
  assert(!ok.body.includes('authorization-code-test'));
  assert(!ok.body.includes(state));

  for (let i = 0; i < 100 && manager.status(flow.id)?.status === 'completing'; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const done = manager.status(flow.id);
  assert.strictEqual(done.status, 'complete');
  assert.strictEqual(done.result.connection.id, 42);
  assert(received);
  assert.strictEqual(received.code, 'authorization-code-test');
  assert.strictEqual(received.clientId, 'desktop-test.apps.googleusercontent.com');
  assert(received.codeVerifier.length >= 43);
  assert(!JSON.stringify(done).includes(received.codeVerifier));

  const second = await manager.begin({ clientId: 'desktop-test.apps.googleusercontent.com' });
  const cancelled = manager.cancel(second.id);
  assert.strictEqual(cancelled.cancelled, true);
  assert.strictEqual(manager.status(second.id).status, 'cancelled');
}

function testConnectionMetadata() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-google-oauth-rpc-'));
  try {
    db.init(tmp);
    const connection = db.saveCalendarConnection({
      provider: 'google',
      credentialKey: 'google:test-credential',
      oauthClientId: 'desktop-test.apps.googleusercontent.com',
      email: 'user@example.test',
      displayName: 'Google test',
    });
    assert.strictEqual(connection.oauthClientId, 'desktop-test.apps.googleusercontent.com');
    assert.strictEqual(
      db.getCalendarConnection(connection.id).oauthClientId,
      'desktop-test.apps.googleusercontent.com',
    );
    assert.throws(() => db.saveCalendarConnection({
      provider: 'google',
      credentialKey: 'google:bad-client',
      oauthClientId: 'bad\nclient',
    }), /Client ID/i);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testBackendContract() {
  const backend = fs.readFileSync(path.join(__dirname, '../engine/backend.js'), 'utf8');
  for (const method of [
    "'calendar.connections.list'",
    "'calendar.remoteCalendars.list'",
    "'calendar.google.oauth.begin'",
    "'calendar.google.oauth.status'",
    "'calendar.google.oauth.cancel'",
    "'calendar.google.sync'",
    "'calendar.google.syncAll'",
    "'calendar.connections.remove'",
  ]) assert(backend.includes(method), `RPC absent : ${method}`);

  assert(backend.includes('calendarGoogleOAuth.createGoogleOAuthFlowManager'));
  assert(backend.includes('credentialStore.writeCalendarOAuthRefreshToken(credentialKey, tokens.refreshToken)'));
  assert(backend.includes('credentialStore.readCalendarOAuthRefreshToken(credentialKey)'));
  assert(backend.includes('oauthClientId: String(clientId || \'\').trim()'));
  assert(backend.includes("stopGoogleCalendarSensitiveRuntime('LibraMail a été verrouillé')"));

  const oauthModule = fs.readFileSync(path.join(__dirname, '../engine/lib/calendar_google_oauth.js'), 'utf8');
  assert(oauthModule.includes("server.listen(0, '127.0.0.1')"));
  assert(oauthModule.includes('crypto.timingSafeEqual'));
  assert(oauthModule.includes("'cache-control': 'no-store, max-age=0'"));
  assert(!oauthModule.includes('console.log'));
}

(async () => {
  testConnectionMetadata();
  await testLoopbackOAuth();
  testBackendContract();
  console.log('[LibraMail] Test OAuth interactif + RPC Google Calendar 0.6.0 : OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
