'use strict';
/**
 * LibraMail 0.7.0 — client OAuth2 public Microsoft (socle hors ligne / tests).
 * Aucune connexion de compte n'est créée par ce module, qui sera intégré
 * au moteur IMAP/SMTP dans le lot OAuth2 Microsoft. Aucun secret client.
 */
const AUTHORITY = 'https://login.microsoftonline.com';
const RESOURCE = 'https://outlook.office.com';
const SCOPES = Object.freeze([
  'offline_access',
  `${RESOURCE}/IMAP.AccessAsUser.All`,
  `${RESOURCE}/SMTP.Send`,
]);

class MicrosoftOAuthError extends Error {
  constructor(message, { code = '', retryable = false, interval = 0 } = {}) {
    super(String(message || 'Erreur OAuth2 Microsoft'));
    this.name = 'MicrosoftOAuthError';
    this.code = String(code || '');
    this.retryable = Boolean(retryable);
    this.interval = Number(interval) || 0;
  }
}

function validateClientId(value) {
  const id = String(value || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Identifiant public de l’application Microsoft manquant ou invalide');
  }
  return id;
}
function validateTenant(value = 'common') {
  const tenant = String(value || '').trim().toLowerCase();
  if (!['common', 'consumers', 'organizations'].includes(tenant)
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant)) {
    throw new Error('Tenant Microsoft invalide');
  }
  return tenant;
}
function sanitize(message) {
  return String(message || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 1000);
}
function safeToken(value) {
  const token = String(value || '').trim();
  if (!token || token.length > 20000 || /[\r\n]/.test(token)) {
    throw new Error('Jeton OAuth2 Microsoft invalide');
  }
  return token;
}
async function postForm(path, { tenant = 'common', form, fetchImpl, timeoutMs = 30000 } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('Client HTTP OAuth2 indisponible');
  const endpoint = `${AUTHORITY}/${validateTenant(tenant)}/oauth2/v2.0/${path}`;
  const controller = new AbortController();
  const waitMs = Math.max(1000, Math.min(120000, Number(timeoutMs) || 30000));
  const timeout = setTimeout(() => controller.abort(), waitMs);
  let response;
  try {
    response = await fetchFn(endpoint, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal,
    });
  } catch (error) {
    throw new MicrosoftOAuthError(error?.name === 'AbortError'
      ? 'Délai de connexion à Microsoft dépassé'
      : `Connexion Microsoft impossible : ${sanitize(error?.message || error)}`);
  } finally {
    clearTimeout(timeout);
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new MicrosoftOAuthError(`Réponse OAuth2 Microsoft invalide (HTTP ${Number(response.status)})`); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new MicrosoftOAuthError('Réponse OAuth2 Microsoft invalide');
  }
  if (!response.ok || payload.error) {
    const code = sanitize(payload.error).slice(0, 100);
    const retryable = ['authorization_pending', 'slow_down'].includes(code);
    throw new MicrosoftOAuthError(sanitize(payload.error_description) || `OAuth2 Microsoft : ${code || response.status}`,
      { code, retryable, interval: code === 'slow_down' ? 5 : 0 });
  }
  return payload;
}
function normalizeTokens(payload) {
  return {
    accessToken: safeToken(payload.access_token),
    refreshToken: payload.refresh_token ? safeToken(payload.refresh_token) : '',
    expiresIn: Math.max(1, Math.min(86400, Number(payload.expires_in) || 3600)),
    tokenType: String(payload.token_type || ''),
  };
}
async function beginDeviceAuthorization({ clientId, tenant = 'common', fetchImpl } = {}) {
  const payload = await postForm('devicecode', {
    tenant, fetchImpl,
    form: { client_id: validateClientId(clientId), scope: SCOPES.join(' ') },
  });
  const url = String(payload.verification_uri || '');
  if (!url.startsWith('https://microsoft.com/') && !url.startsWith('https://www.microsoft.com/')) {
    throw new MicrosoftOAuthError('Adresse de validation Microsoft inattendue');
  }
  return {
    verificationUri: url,
    userCode: String(payload.user_code || '').replace(/[\r\n]/g, '').slice(0, 30),
    deviceCode: safeToken(payload.device_code), // Secret éphémère : ne jamais écrire sur disque ni journaliser.
    interval: Math.max(5, Math.min(60, Number(payload.interval) || 5)),
    expiresIn: Math.max(30, Math.min(1800, Number(payload.expires_in) || 900)),
  };
}
async function pollDeviceAuthorization({ clientId, tenant = 'common', deviceCode, fetchImpl } = {}) {
  const payload = await postForm('token', {
    tenant, fetchImpl,
    form: {
      client_id: validateClientId(clientId), grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: safeToken(deviceCode),
    },
  });
  return normalizeTokens(payload);
}
async function refreshMicrosoftAccessToken({ clientId, tenant = 'common', refreshToken, fetchImpl } = {}) {
  const payload = await postForm('token', {
    tenant, fetchImpl,
    form: {
      client_id: validateClientId(clientId), grant_type: 'refresh_token',
      refresh_token: safeToken(refreshToken), scope: SCOPES.join(' '),
    },
  });
  return normalizeTokens(payload);
}
module.exports = {
  AUTHORITY, RESOURCE, SCOPES, MicrosoftOAuthError, validateClientId, validateTenant,
  beginDeviceAuthorization, pollDeviceAuthorization, refreshMicrosoftAccessToken,
};
