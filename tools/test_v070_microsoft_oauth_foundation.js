'use strict';
const assert = require('node:assert/strict');
const oauth = require('../engine/lib/mail_microsoft_oauth');
const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function stub(body, code = 200) {
  return async (url, options) => {
    assert.ok(url.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/'));
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['content-type'], 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('client_id'), CLIENT_ID);
    return { ok: code >= 200 && code < 300, status: code, json: async () => body };
  };
}
(async () => {
  assert.throws(() => oauth.validateClientId('not-a-guid'), /invalide/);
  assert.throws(() => oauth.validateTenant('https://evil.invalid'), /invalide/);
  assert.ok(oauth.SCOPES.some(scope => scope.endsWith('/IMAP.AccessAsUser.All')));
  assert.ok(oauth.SCOPES.some(scope => scope.endsWith('/SMTP.Send')));
  const device = await oauth.beginDeviceAuthorization({ clientId: CLIENT_ID, fetchImpl: stub({
    verification_uri: 'https://microsoft.com/devicelogin',
    user_code: 'ABCD-WXYZ', device_code: 'ephemeral-device-code',
    expires_in: 900, interval: 5,
  }) });
  assert.equal(device.userCode, 'ABCD-WXYZ');
  assert.equal(device.verificationUri, 'https://microsoft.com/devicelogin');
  await assert.rejects(
    oauth.pollDeviceAuthorization({ clientId: CLIENT_ID, deviceCode: device.deviceCode, fetchImpl: stub({ error: 'authorization_pending', error_description: 'Pending' }, 400) }),
    e => e instanceof oauth.MicrosoftOAuthError && e.retryable && e.code === 'authorization_pending',
  );
  const tokens = await oauth.pollDeviceAuthorization({ clientId: CLIENT_ID, deviceCode: device.deviceCode, fetchImpl: stub({
    access_token: 'access-test', refresh_token: 'refresh-test', token_type: 'Bearer', expires_in: 3600,
  }) });
  assert.equal(tokens.accessToken, 'access-test');
  assert.equal(tokens.refreshToken, 'refresh-test');
  assert.deepEqual(await oauth.refreshMicrosoftAccessToken({ clientId: CLIENT_ID, refreshToken: tokens.refreshToken, fetchImpl: stub({ access_token: 'new-token', expires_in: 3600 }) }), {
    accessToken: 'new-token', refreshToken: '', expiresIn: 3600, tokenType: '',
  });
  await assert.rejects(
    oauth.beginDeviceAuthorization({ clientId: CLIENT_ID, fetchImpl: stub({ verification_uri: 'https://evil.invalid/authorize', device_code: 'some-secret' }) }),
    /inattendue/,
  );
  console.log('✓ LibraMail 0.7.0 Microsoft OAuth2 foundation: device authorization + refresh + validations');
})().catch(error => { console.error(error); process.exitCode = 1; });
