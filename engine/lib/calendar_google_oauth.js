'use strict';

const http = require('http');
const crypto = require('crypto');
const calendarAuth = require('./calendar_auth');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const COMPLETED_TTL_MS = 10 * 60 * 1000;
const CALLBACK_PATH = '/oauth2/callback';

function cleanError(value, fallback = 'Erreur OAuth2 Google Calendar') {
  const text = String(value?.message || value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 1200);
  return text || fallback;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function publicFlow(flow) {
  if (!flow) return null;
  return {
    id: flow.id,
    provider: 'google',
    status: flow.status,
    authUrl: flow.status === 'pending' ? flow.authUrl : '',
    redirectUri: flow.redirectUri,
    startedAt: flow.startedAt,
    finishedAt: flow.finishedAt || 0,
    error: flow.error || '',
    result: flow.result || null,
  };
}

function responseHtml(title, message) {
  const safeTitle = String(title || 'LibraMail').replace(/[<>&"]/g, '');
  const safeMessage = String(message || '').replace(/[<>&"]/g, '');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title></head><body style="font-family:system-ui,sans-serif;max-width:620px;margin:48px auto;padding:0 20px;line-height:1.5"><h1>${safeTitle}</h1><p>${safeMessage}</p></body></html>`;
}

function sendHtml(res, statusCode, title, message) {
  const body = responseHtml(title, message);
  res.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store, max-age=0',
    pragma: 'no-cache',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function createGoogleOAuthFlowManager({
  onCode,
  onChange = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  completedTtlMs = COMPLETED_TTL_MS,
  createServer = handler => http.createServer(handler),
  now = () => Date.now(),
} = {}) {
  if (typeof onCode !== 'function') throw new Error('Gestionnaire de code OAuth2 Google requis');
  const flows = new Map();
  const activeTimeout = Math.max(30_000, Math.min(15 * 60 * 1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const resultTtl = Math.max(60_000, Math.min(60 * 60 * 1000, Number(completedTtlMs) || COMPLETED_TTL_MS));

  function notify(flow) {
    if (typeof onChange !== 'function') return;
    try { onChange(publicFlow(flow)); } catch {}
  }

  function closeServer(flow) {
    if (!flow?.server) return;
    try { flow.server.close(); } catch {}
    flow.server = null;
  }

  function clearTimers(flow) {
    if (flow?.timeout) clearTimeout(flow.timeout);
    flow.timeout = null;
  }

  function expireLater(flow) {
    const timer = setTimeout(() => {
      if (flows.get(flow.id) === flow && flow.status !== 'pending' && flow.status !== 'completing') {
        flows.delete(flow.id);
      }
    }, resultTtl);
    timer.unref?.();
  }

  function finish(flow, status, { error = '', result = null } = {}) {
    if (!flow || !['pending', 'completing'].includes(flow.status)) return publicFlow(flow);
    clearTimers(flow);
    closeServer(flow);
    flow.status = status;
    flow.finishedAt = Math.max(flow.startedAt, Number(now()) || Date.now());
    flow.error = cleanError(error, '') || '';
    flow.result = result || null;
    // Les secrets de session n'ont plus de raison de rester en mémoire.
    flow.oauthState = '';
    flow.codeVerifier = '';
    notify(flow);
    expireLater(flow);
    return publicFlow(flow);
  }

  async function handleCallback(flow, req, res) {
    if (!flow || flow.status !== 'pending') {
      sendHtml(res, 410, 'LibraMail', 'Cette demande de connexion Google n’est plus active.');
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' });
      res.end();
      return;
    }

    let url;
    try { url = new URL(req.url || '/', flow.redirectUri); }
    catch {
      sendHtml(res, 400, 'LibraMail', 'Réponse OAuth2 invalide.');
      return;
    }
    if (url.pathname !== CALLBACK_PATH) {
      sendHtml(res, 404, 'LibraMail', 'Adresse de retour inconnue.');
      return;
    }

    const returnedState = String(url.searchParams.get('state') || '');
    if (!safeEqual(returnedState, flow.oauthState)) {
      // Ne pas fermer le serveur : une requête locale parasite ne doit pas
      // pouvoir annuler la véritable connexion encore en attente.
      sendHtml(res, 403, 'LibraMail', 'État OAuth2 invalide. Retournez dans LibraMail et réessayez.');
      return;
    }

    const oauthError = String(url.searchParams.get('error') || '');
    if (oauthError) {
      const description = String(url.searchParams.get('error_description') || oauthError);
      const cancelled = oauthError === 'access_denied';
      finish(flow, cancelled ? 'cancelled' : 'error', { error: description });
      sendHtml(res, cancelled ? 200 : 400, 'LibraMail', cancelled
        ? 'Connexion Google annulée. Vous pouvez fermer cette fenêtre.'
        : 'Google a refusé la connexion. Vous pouvez fermer cette fenêtre.');
      return;
    }

    const code = String(url.searchParams.get('code') || '').trim();
    if (!code || /[\r\n]/.test(code)) {
      finish(flow, 'error', { error: 'Code OAuth2 Google absent ou invalide' });
      sendHtml(res, 400, 'LibraMail', 'Le code d’autorisation Google est invalide.');
      return;
    }

    clearTimers(flow);
    closeServer(flow);
    flow.status = 'completing';
    notify(flow);
    sendHtml(res, 200, 'LibraMail', 'Autorisation reçue. Vous pouvez fermer cette fenêtre et revenir dans LibraMail.');

    const codeVerifier = flow.codeVerifier;
    Promise.resolve().then(() => onCode({
      flowId: flow.id,
      clientId: flow.clientId,
      loginHint: flow.loginHint,
      code,
      codeVerifier,
      redirectUri: flow.redirectUri,
      isActive: () => flow.status === 'completing',
    })).then(result => {
      finish(flow, 'complete', { result });
    }).catch(error => {
      finish(flow, 'error', { error: cleanError(error) });
    });
  }

  async function begin({ clientId, loginHint = '' } = {}) {
    const normalizedClientId = String(clientId || '').trim();
    if (!normalizedClientId || normalizedClientId.length > 1000 || /[\r\n]/.test(normalizedClientId)) {
      throw new Error('Client ID Google OAuth2 invalide');
    }
    const normalizedHint = String(loginHint || '').trim().slice(0, 320);
    if (/[\r\n]/.test(normalizedHint)) throw new Error('Compte Google invalide');

    // Un seul flux interactif à la fois évite d'ouvrir plusieurs navigateurs
    // et de mélanger les retours OAuth dans l'interface.
    for (const flow of flows.values()) {
      if (flow.status === 'pending' || flow.status === 'completing') {
        throw new Error('Une connexion Google est déjà en cours');
      }
    }

    const id = `google-oauth:${crypto.randomUUID()}`;
    const startedAt = Math.max(0, Number(now()) || Date.now());
    const flow = {
      id,
      status: 'starting',
      clientId: normalizedClientId,
      loginHint: normalizedHint,
      startedAt,
      finishedAt: 0,
      redirectUri: '',
      authUrl: '',
      oauthState: '',
      codeVerifier: '',
      result: null,
      error: '',
      server: null,
      timeout: null,
    };
    flows.set(id, flow);

    const server = createServer((req, res) => {
      handleCallback(flow, req, res).catch(error => {
        try { sendHtml(res, 500, 'LibraMail', 'La connexion Google n’a pas pu être finalisée.'); } catch {}
        finish(flow, 'error', { error });
      });
    });
    flow.server = server;

    await new Promise((resolve, reject) => {
      const onError = error => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    }).catch(error => {
      flows.delete(id);
      closeServer(flow);
      throw new Error(`Impossible d’ouvrir le retour OAuth2 local : ${cleanError(error)}`);
    });

    const address = server.address();
    const port = Number(address?.port) || 0;
    if (!port) {
      flows.delete(id);
      closeServer(flow);
      throw new Error('Port OAuth2 local indisponible');
    }

    flow.redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const authRequest = calendarAuth.buildAuthorizationRequest({
      provider: 'google',
      clientId: normalizedClientId,
      redirectUri: flow.redirectUri,
      loginHint: normalizedHint,
      prompt: 'consent',
    });
    flow.authUrl = authRequest.url;
    flow.oauthState = authRequest.state;
    flow.codeVerifier = authRequest.codeVerifier;
    flow.status = 'pending';
    flow.timeout = setTimeout(() => finish(flow, 'timeout', { error: 'Délai de connexion Google dépassé' }), activeTimeout);
    flow.timeout.unref?.();
    notify(flow);
    return publicFlow(flow);
  }

  function status(flowId) {
    return publicFlow(flows.get(String(flowId || '').trim()));
  }

  function cancel(flowId, reason = 'Connexion Google annulée') {
    const flow = flows.get(String(flowId || '').trim());
    if (!flow) return { cancelled: false };
    if (!['pending', 'completing'].includes(flow.status)) return { cancelled: false, flow: publicFlow(flow) };
    const result = finish(flow, 'cancelled', { error: reason });
    return { cancelled: true, flow: result };
  }

  function cancelAll(reason = 'Connexion Google interrompue') {
    let cancelled = 0;
    for (const flow of flows.values()) {
      if (['pending', 'completing'].includes(flow.status)) {
        finish(flow, 'cancelled', { error: reason });
        cancelled += 1;
      }
    }
    return cancelled;
  }

  return { begin, status, cancel, cancelAll };
}

module.exports = {
  CALLBACK_PATH,
  DEFAULT_TIMEOUT_MS,
  createGoogleOAuthFlowManager,
};
