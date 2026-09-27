'use strict';

const crypto = require('crypto');

const GOOGLE = Object.freeze({
  id: 'google',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  apiBase: 'https://www.googleapis.com/calendar/v3',
  scopes: Object.freeze([
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  ]),
});

const PROVIDERS = Object.freeze({ google: GOOGLE });
const DEFAULT_TOKEN_TIMEOUT_MS = 30_000;

function providerFor(value = 'google') {
  const key = String(value || '').trim().toLowerCase();
  const provider = PROVIDERS[key];
  if (!provider) throw new Error(`Fournisseur de calendrier OAuth2 non pris en charge : ${key || '(vide)'}`);
  return provider;
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function generatePkce() {
  // RFC 7636 : 43 à 128 caractères. 32 octets aléatoires encodés en
  // base64url donnent 43 caractères avec une entropie suffisante.
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
  return { verifier, challenge, method: 'S256' };
}

function generateState() {
  return base64url(crypto.randomBytes(24));
}

function assertLoopbackRedirect(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new Error('Adresse de retour OAuth2 invalide'); }

  const host = String(url.hostname || '').toLowerCase();
  const loopback = host === '127.0.0.1' || host === '[::1]' || host === '::1';
  if (url.protocol !== 'http:' || !loopback || !url.port) {
    throw new Error('OAuth2 calendrier exige une adresse de retour HTTP loopback avec port local');
  }
  if (url.username || url.password) throw new Error('Adresse de retour OAuth2 invalide');
  return url.toString();
}

function normalizeClientId(value) {
  const clientId = String(value || '').trim();
  if (!clientId || clientId.length > 1000 || /[\r\n]/.test(clientId)) {
    throw new Error('Client ID OAuth2 calendrier invalide');
  }
  return clientId;
}

function normalizeClientSecret(value) {
  const clientSecret = String(value || '').trim();
  if (clientSecret.length > 4000 || /[\r\n]/.test(clientSecret)) {
    throw new Error('Client secret OAuth2 calendrier invalide');
  }
  return clientSecret;
}

function buildAuthorizationRequest({
  provider = 'google',
  clientId,
  redirectUri,
  loginHint = '',
  prompt = 'consent',
  state = '',
  pkce = null,
} = {}) {
  const definition = providerFor(provider);
  const oauthClientId = normalizeClientId(clientId);
  const callback = assertLoopbackRedirect(redirectUri);
  const pkcePair = pkce || generatePkce();
  const verifier = String(pkcePair.verifier || '');
  const challenge = String(pkcePair.challenge || '');
  if (verifier.length < 43 || verifier.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(verifier)) {
    throw new Error('Code verifier PKCE invalide');
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new Error('Code challenge PKCE invalide');

  const requestState = String(state || generateState());
  if (!requestState || requestState.length > 512 || /[\r\n]/.test(requestState)) {
    throw new Error('État OAuth2 invalide');
  }

  const url = new URL(definition.authorizationEndpoint);
  url.searchParams.set('client_id', oauthClientId);
  url.searchParams.set('redirect_uri', callback);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', definition.scopes.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', requestState);

  const hint = String(loginHint || '').trim();
  if (hint && hint.length <= 320 && !/[\r\n]/.test(hint)) url.searchParams.set('login_hint', hint);
  const promptValue = String(prompt || '').trim();
  if (promptValue) url.searchParams.set('prompt', promptValue);

  return {
    provider: definition.id,
    url: url.toString(),
    state: requestState,
    codeVerifier: verifier,
    redirectUri: callback,
    scopes: [...definition.scopes],
  };
}

function cleanOAuthError(value, fallback = 'Erreur OAuth2 calendrier') {
  const text = String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 800);
  return text || fallback;
}

async function tokenRequest(definition, body, fetchImpl, timeoutMs = DEFAULT_TOKEN_TIMEOUT_MS) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('Client HTTP OAuth2 indisponible');
  const requestTimeout = Math.max(1_000, Math.min(120_000, Number(timeoutMs) || DEFAULT_TOKEN_TIMEOUT_MS));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeout);

  let response;
  try {
    response = await fetchFn(definition.tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'accept': 'application/json',
      },
      body: new URLSearchParams(body).toString(),
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('OAuth2 calendrier : délai d’attente dépassé lors de l’échange avec Google');
    }
    throw new Error(cleanOAuthError(error?.message || error, 'OAuth2 calendrier : erreur réseau'));
  } finally {
    clearTimeout(timer);
  }

  let payload = {};
  try { payload = await response.json(); }
  catch {
    if (!response.ok) throw new Error(`OAuth2 calendrier : HTTP ${response.status}`);
  }

  if (!response.ok || payload?.error) {
    throw new Error(cleanOAuthError(
      payload?.error_description || payload?.error || `HTTP ${response.status}`,
    ));
  }

  const accessToken = String(payload?.access_token || '');
  if (!accessToken) throw new Error('OAuth2 calendrier : jeton d’accès absent');

  return {
    accessToken,
    refreshToken: String(payload?.refresh_token || ''),
    expiresIn: Math.max(0, Number(payload?.expires_in) || 0),
    scope: String(payload?.scope || ''),
    tokenType: String(payload?.token_type || 'Bearer'),
  };
}

async function exchangeAuthorizationCode({
  provider = 'google',
  clientId,
  clientSecret = '',
  code,
  codeVerifier,
  redirectUri,
  fetchImpl = null,
  timeoutMs = DEFAULT_TOKEN_TIMEOUT_MS,
} = {}) {
  const definition = providerFor(provider);
  const authorizationCode = String(code || '').trim();
  const verifier = String(codeVerifier || '').trim();
  if (!authorizationCode || /[\r\n]/.test(authorizationCode)) {
    throw new Error('Code OAuth2 calendrier invalide');
  }
  if (verifier.length < 43 || verifier.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(verifier)) {
    throw new Error('Code verifier PKCE invalide');
  }

  const body = {
    client_id: normalizeClientId(clientId),
    code: authorizationCode,
    code_verifier: verifier,
    redirect_uri: assertLoopbackRedirect(redirectUri),
    grant_type: 'authorization_code',
  };
  const secret = normalizeClientSecret(clientSecret);
  if (secret) body.client_secret = secret;
  return tokenRequest(definition, body, fetchImpl, timeoutMs);
}

async function refreshAccessToken({
  provider = 'google',
  clientId,
  clientSecret = '',
  refreshToken,
  fetchImpl = null,
  timeoutMs = DEFAULT_TOKEN_TIMEOUT_MS,
} = {}) {
  const definition = providerFor(provider);
  const token = String(refreshToken || '').trim();
  if (!token || token.length > 20000 || /[\r\n]/.test(token)) {
    throw new Error('Refresh token OAuth2 calendrier invalide');
  }

  const body = {
    client_id: normalizeClientId(clientId),
    refresh_token: token,
    grant_type: 'refresh_token',
  };
  const secret = normalizeClientSecret(clientSecret);
  if (secret) body.client_secret = secret;
  return tokenRequest(definition, body, fetchImpl, timeoutMs);
}

module.exports = {
  PROVIDERS,
  DEFAULT_TOKEN_TIMEOUT_MS,
  providerFor,
  generatePkce,
  generateState,
  assertLoopbackRedirect,
  buildAuthorizationRequest,
  exchangeAuthorizationCode,
  refreshAccessToken,
};
