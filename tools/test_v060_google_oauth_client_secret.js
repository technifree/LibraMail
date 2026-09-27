#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const calendarAuth = require('../engine/lib/calendar_auth');
const credentialStore = require('../engine/lib/credential_store');
const { createGoogleOAuthFlowManager } = require('../engine/lib/calendar_google_oauth');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    req.on('error', reject);
  });
}

async function testTokenExchangeUsesSecret() {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(new URLSearchParams(options.body));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: 'access-token-test',
          refresh_token: requests.length === 1 ? 'refresh-token-test' : undefined,
          expires_in: 3600,
          token_type: 'Bearer',
        };
      },
    };
  };

  const pkce = calendarAuth.generatePkce();
  await calendarAuth.exchangeAuthorizationCode({
    clientId: 'desktop.apps.googleusercontent.com',
    clientSecret: 'desktop-client-secret',
    code: 'authorization-code',
    codeVerifier: pkce.verifier,
    redirectUri: 'http://127.0.0.1:49152/oauth2/callback',
    fetchImpl,
  });
  assert.strictEqual(requests[0].get('client_secret'), 'desktop-client-secret');

  await calendarAuth.refreshAccessToken({
    clientId: 'desktop.apps.googleusercontent.com',
    clientSecret: 'desktop-client-secret',
    refreshToken: 'refresh-token-test',
    fetchImpl,
  });
  assert.strictEqual(requests[1].get('client_secret'), 'desktop-client-secret');
}

function testSecureClientSecretStore() {
  let raw = null;
  const io = {
    readSecret: name => {
      assert.strictEqual(name, credentialStore.CALENDAR_OAUTH_CLIENT_SECRET_SERVICE_SECRET);
      return raw;
    },
    writeSecret: (name, value) => {
      assert.strictEqual(name, credentialStore.CALENDAR_OAUTH_CLIENT_SECRET_SERVICE_SECRET);
      raw = value;
      return true;
    },
    removeSecret: name => {
      assert.strictEqual(name, credentialStore.CALENDAR_OAUTH_CLIENT_SECRET_SERVICE_SECRET);
      raw = null;
      return true;
    },
  };

  credentialStore.writeCalendarOAuthClientSecret('google:test', 'secret-A', io);
  assert.strictEqual(
    credentialStore.readCalendarOAuthClientSecret('google:test', io),
    'secret-A',
  );
  credentialStore.removeCalendarOAuthClientSecret('google:test', io);
  assert.strictEqual(raw, null);
}

async function testInteractiveFlowDoesNotExposeSecret() {
  let received = null;
  const manager = createGoogleOAuthFlowManager({
    timeoutMs: 60_000,
    onCode: async payload => {
      received = payload;
      return { connection: { id: 7, provider: 'google' } };
    },
  });

  const secret = 'super-secret-desktop-client';
  const flow = await manager.begin({
    clientId: 'desktop.apps.googleusercontent.com',
    clientSecret: secret,
    loginHint: 'user@example.test',
  });
  assert(!JSON.stringify(flow).includes(secret));

  const authUrl = new URL(flow.authUrl);
  const state = authUrl.searchParams.get('state');
  const response = await httpGet(
    `${flow.redirectUri}?state=${encodeURIComponent(state)}&code=code-test`,
  );
  assert.strictEqual(response.status, 200);

  for (let i = 0; i < 100 && manager.status(flow.id)?.status === 'completing'; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  const done = manager.status(flow.id);
  assert.strictEqual(done.status, 'complete');
  assert(received);
  assert.strictEqual(received.clientSecret, secret);
  assert(!JSON.stringify(done).includes(secret));
}

function testIntegrationContract() {
  const backend = fs.readFileSync(path.join(__dirname, '../engine/backend.js'), 'utf8');
  const planner = fs.readFileSync(path.join(__dirname, '../resources/js/planner.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../resources/index.html'), 'utf8');
  const db = fs.readFileSync(path.join(__dirname, '../engine/lib/db.js'), 'utf8');

  assert(backend.includes('credentialStore.CALENDAR_OAUTH_CLIENT_SECRET_SERVICE_SECRET'));
  assert(backend.includes('credentialStore.writeCalendarOAuthClientSecret(credentialKey, clientSecret)'));
  assert(backend.includes('credentialStore.readCalendarOAuthClientSecret(credentialKey)'));
  assert(backend.includes('clientSecret,'));
  assert(planner.includes("document.getElementById('planner-google-client-secret')"));
  assert(planner.includes("{ clientId, clientSecret, loginHint }"));
  assert(html.includes('id="planner-google-client-secret"'));
  assert(html.includes('type="password"'));
  assert(!db.includes('oauth_client_secret'), 'le client secret ne doit pas être ajouté à SQLite');
}

(async () => {
  await testTokenExchangeUsesSecret();
  testSecureClientSecretStore();
  await testInteractiveFlowDoesNotExposeSecret();
  testIntegrationContract();
  console.log('[LibraMail] Test Client secret OAuth Google Calendar 0.6.0 : OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
