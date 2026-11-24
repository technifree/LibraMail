/* LibraMail — configuration assistée des fournisseurs de messagerie.
 * Aucun identifiant ni secret n'est stocké ici : valeurs publiques uniquement.
 * Module partagé entre l'application et les tests Node.js.
 */
'use strict';
(function (root) {
  const EMAIL_DOMAINS = Object.freeze({
    gmail: new Set(['gmail.com', 'googlemail.com']),
    microsoft: new Set([
      'outlook.com', 'outlook.fr', 'hotmail.com', 'hotmail.fr',
      'live.com', 'live.fr', 'msn.com', 'passport.com',
    ]),
  });
  const KNOWN_HOSTS = new Set([
    'imap.gmail.com', 'smtp.gmail.com', 'pop.gmail.com',
    'outlook.office365.com', 'smtp-mail.outlook.com', 'smtp.office365.com',
  ]);

  function normalizedEmail(email) {
    return String(email || '').trim().toLowerCase();
  }
  function recognizedProvider(email) {
    const value = normalizedEmail(email);
    const at = value.lastIndexOf('@');
    if (at < 1 || at === value.length - 1 || /\s/.test(value)) return '';
    const domain = value.slice(at + 1);
    if (EMAIL_DOMAINS.gmail.has(domain)) return 'gmail';
    if (EMAIL_DOMAINS.microsoft.has(domain)) return 'microsoft';
    return '';
  }
  function resolvedProvider(email, selected = 'auto') {
    const explicit = String(selected || 'auto').toLowerCase();
    return explicit === 'auto' ? recognizedProvider(email)
      : ['gmail', 'microsoft', 'other'].includes(explicit) ? explicit : '';
  }
  function profileFor(provider, email) {
    const user = String(email || '').trim();
    if (provider === 'gmail') return {
      imap: { host: 'imap.gmail.com', port: 993, secure: true, user },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user },
      authentication: 'app-password',
    };
    if (provider === 'microsoft') return {
      imap: { host: 'outlook.office365.com', port: 993, secure: true, user },
      smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false, user },
      authentication: 'oauth2-required',
    };
    return null;
  }
  function mayReplace(field, value) {
    const current = String(value == null ? '' : value).trim();
    if (!current) return true;
    if (field === 'host') return KNOWN_HOSTS.has(current.toLowerCase());
    if (field === 'port') return ['993', '995', '465', '587'].includes(current);
    return false;
  }
  const api = Object.freeze({ recognizedProvider, resolvedProvider, profileFor, mayReplace });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LibraMailProviderSetup = api;
})(typeof globalThis !== 'undefined' ? globalThis : null);
