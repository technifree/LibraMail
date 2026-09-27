'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const calendarAuth = require('../engine/lib/calendar_auth');
const credentialStore = require('../engine/lib/credential_store');

const pkce = calendarAuth.generatePkce();
assert(pkce.verifier.length >= 43 && pkce.verifier.length <= 128);
assert(/^[A-Za-z0-9._~-]+$/.test(pkce.verifier));
assert(/^[A-Za-z0-9_-]{43}$/.test(pkce.challenge));
assert.strictEqual(pkce.method, 'S256');

const auth = calendarAuth.buildAuthorizationRequest({
  clientId: 'desktop-client.apps.googleusercontent.com',
  redirectUri: 'http://127.0.0.1:49152/oauth2/callback',
  loginHint: 'calendar-user@example.test',
  state: 'state-for-test',
  pkce,
});
const authUrl = new URL(auth.url);
assert.strictEqual(auth.provider, 'google');
assert.strictEqual(auth.state, 'state-for-test');
assert.strictEqual(auth.codeVerifier, pkce.verifier);
assert.strictEqual(authUrl.origin, 'https://accounts.google.com');
assert.strictEqual(authUrl.searchParams.get('response_type'), 'code');
assert.strictEqual(authUrl.searchParams.get('access_type'), 'offline');
assert.strictEqual(authUrl.searchParams.get('code_challenge_method'), 'S256');
assert.strictEqual(authUrl.searchParams.get('code_challenge'), pkce.challenge);
const scopes = new Set(String(authUrl.searchParams.get('scope') || '').split(/\s+/));
assert(scopes.has('https://www.googleapis.com/auth/calendar.events'));
assert(scopes.has('https://www.googleapis.com/auth/calendar.calendarlist.readonly'));
assert.throws(
  () => calendarAuth.buildAuthorizationRequest({
    clientId: 'client',
    redirectUri: 'https://example.test/callback',
  }),
  /loopback/i,
);

(async () => {
  const requests = [];
  const mockFetch = async (url, options) => {
    requests.push({ url, options, body: new URLSearchParams(options.body) });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: `access-${requests.length}`,
          refresh_token: requests.length === 1 ? 'refresh-secret-test' : undefined,
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'calendar',
        };
      },
    };
  };

  const exchanged = await calendarAuth.exchangeAuthorizationCode({
    clientId: 'desktop-client.apps.googleusercontent.com',
    code: 'authorization-code',
    codeVerifier: pkce.verifier,
    redirectUri: 'http://127.0.0.1:49152/oauth2/callback',
    fetchImpl: mockFetch,
  });
  assert.strictEqual(exchanged.accessToken, 'access-1');
  assert.strictEqual(exchanged.refreshToken, 'refresh-secret-test');
  assert.strictEqual(requests[0].url, 'https://oauth2.googleapis.com/token');
  assert.strictEqual(requests[0].body.get('grant_type'), 'authorization_code');
  assert.strictEqual(requests[0].body.get('code_verifier'), pkce.verifier);
  assert.strictEqual(requests[0].body.get('client_secret'), null);

  const refreshed = await calendarAuth.refreshAccessToken({
    clientId: 'desktop-client.apps.googleusercontent.com',
    refreshToken: 'refresh-secret-test',
    fetchImpl: mockFetch,
  });
  assert.strictEqual(refreshed.accessToken, 'access-2');
  assert.strictEqual(requests[1].body.get('grant_type'), 'refresh_token');
  assert.strictEqual(requests[1].body.get('refresh_token'), 'refresh-secret-test');

  // Le refresh token calendrier est stocké dans UN secret de service du
  // trousseau système. Cela permet au mot de passe principal de le migrer même
  // lorsque la base SQLite n'est pas encore ouverte au déverrouillage.
  let stored = null;
  const io = {
    readSecret: name => {
      assert.strictEqual(name, credentialStore.CALENDAR_OAUTH_SERVICE_SECRET);
      return stored;
    },
    writeSecret: (name, value) => {
      assert.strictEqual(name, credentialStore.CALENDAR_OAUTH_SERVICE_SECRET);
      stored = value;
      return true;
    },
    removeSecret: name => {
      assert.strictEqual(name, credentialStore.CALENDAR_OAUTH_SERVICE_SECRET);
      stored = null;
      return true;
    },
  };

  credentialStore.writeCalendarOAuthRefreshToken('connection-1', 'refresh-A', io);
  credentialStore.writeCalendarOAuthRefreshToken('connection-2', 'refresh-B', io);
  assert(stored && !stored.includes('access-1'), 'un access token ne doit jamais être persisté');
  assert.strictEqual(
    credentialStore.readCalendarOAuthRefreshToken('connection-1', io),
    'refresh-A',
  );
  assert.strictEqual(
    credentialStore.readCalendarOAuthRefreshToken('connection-2', io),
    'refresh-B',
  );
  credentialStore.removeCalendarOAuthRefreshToken('connection-1', io);
  assert.strictEqual(credentialStore.readCalendarOAuthRefreshToken('connection-1', io), null);
  assert.strictEqual(credentialStore.readCalendarOAuthRefreshToken('connection-2', io), 'refresh-B');
  credentialStore.removeCalendarOAuthRefreshToken('connection-2', io);
  assert.strictEqual(stored, null);

  const backend = fs.readFileSync(path.join(root, 'engine/backend.js'), 'utf8');
  assert(backend.includes('credentialStore.CALENDAR_OAUTH_SERVICE_SECRET'));
  assert(backend.includes('const SECURITY_SERVICE_SECRETS = ['));
  assert(!fs.readFileSync(path.join(root, 'engine/lib/calendar_auth.js'), 'utf8')
    .includes("console.log"));

  console.log('[LibraMail] Test socle OAuth2 calendrier 0.6.0 : OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
