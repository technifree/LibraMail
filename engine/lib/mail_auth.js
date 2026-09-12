/**
 * LibraMail 0.5.1 — socle d'authentification mail.
 *
 * Ce module ne réalise volontairement aucun flux OAuth interactif : il fournit
 * uniquement une bifurcation sûre et testable entre l'authentification historique
 * par mot de passe et une authentification OAuth2 alimentée par un access token
 * éphémère. Le gestionnaire Microsoft/PKCE sera ajouté dans le lot suivant.
 *
 * Compatibilité : en l'absence de account.authentication.type === 'oauth2',
 * les objets auth produits sont strictement ceux utilisés par LibraMail 0.5.0.
 */
'use strict';

const AUTH_PASSWORD = 'password';
const AUTH_OAUTH2 = 'oauth2';

function typeFor(account = {}) {
  return account?.authentication?.type === AUTH_OAUTH2 ? AUTH_OAUTH2 : AUTH_PASSWORD;
}

function providerFor(account = {}) {
  if (typeFor(account) !== AUTH_OAUTH2) return '';
  return String(account?.authentication?.provider || '').trim().toLowerCase();
}

function transientAccessToken(account = {}) {
  // _oauthAccessToken est une donnée d'exécution uniquement. credential_store
  // garantit qu'elle ne peut pas être sérialisée dans accounts.json.
  return String(account?._oauthAccessToken || '').trim();
}

function requireAccessToken(account = {}) {
  const token = transientAccessToken(account);
  if (!token) {
    const provider = providerFor(account) || 'OAuth2';
    throw new Error(`Jeton d’accès ${provider} indisponible`);
  }
  return token;
}

function incomingUser(account = {}) {
  return String(account?.imap?.user || account?.email || '').trim();
}

function smtpUser(account = {}) {
  return String(
    account?.smtp?.user || account?.pop3?.user || account?.imap?.user || account?.email || ''
  ).trim();
}

function imapAuth(account = {}) {
  const user = incomingUser(account);
  if (typeFor(account) === AUTH_OAUTH2) {
    return { user, accessToken: requireAccessToken(account) };
  }
  return { user, pass: account?.imap?.pass };
}

function smtpAuth(account = {}) {
  const user = smtpUser(account);
  if (typeFor(account) === AUTH_OAUTH2) {
    return {
      type: 'OAuth2',
      user,
      accessToken: requireAccessToken(account),
    };
  }
  return {
    user,
    pass: account?.smtp?.pass || account?.pop3?.pass || account?.imap?.pass,
  };
}

module.exports = {
  AUTH_PASSWORD,
  AUTH_OAUTH2,
  typeFor,
  providerFor,
  transientAccessToken,
  imapAuth,
  smtpAuth,
};
