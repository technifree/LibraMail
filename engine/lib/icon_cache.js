/**
 * LibraMail — cache local des icônes d'expéditeurs.
 * Ne charge jamais les images du message. On tente uniquement le favicon du domaine,
 * avec délai court et cache local. Si ça échoue, l'interface garde les initiales.
 */
'use strict';
const { Buffer } = require('buffer');

const MAX_ICON_BYTES = 160 * 1024;
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function domainFromEmail(email) {
  const match = String(email || '').trim().toLowerCase().match(/@([^>\s]+)$/);
  return match ? match[1].replace(/^www\./, '') : '';
}

function providerKey(domain) {
  const source = String(domain || '').toLowerCase();
  if (/gmail|googlemail/.test(source)) return 'gmail';
  if (/outlook|hotmail|live\.com|office365|microsoft/.test(source)) return 'outlook';
  if (/yahoo/.test(source)) return 'yahoo';
  if (/icloud|me\.com|mac\.com/.test(source)) return 'icloud';
  if (/proton/.test(source)) return 'proton';
  if (/laposte\.net/.test(source)) return 'laposte';
  if (/free\.fr/.test(source)) return 'free';
  if (/orange|wanadoo/.test(source)) return 'orange';
  if (/sfr\.fr/.test(source)) return 'sfr';
  if (/ovh|ovhcloud/.test(source)) return 'ovh';
  return '';
}

async function fetchWithTimeout(url, timeout = 2500) {
  if (typeof fetch !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'LibraMail/0.2.23 icon-cache' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!/^image\//.test(contentType) && !contentType.includes('x-icon')) return null;
    const arrayBuffer = await response.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength <= 0 || arrayBuffer.byteLength > MAX_ICON_BYTES) return null;
    const mime = contentType.split(';')[0] || 'image/png';
    return `data:${mime};base64,${Buffer.from(arrayBuffer).toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveSenderIcon({ email, db }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const domain = domainFromEmail(cleanEmail);
  if (!domain) return { email: cleanEmail, domain: '', iconData: '', providerKey: '', source: 'initials' };
  const provider = providerKey(domain);
  const cacheKey = `domain:${domain}`;
  const cached = db.getSenderIconCache(cacheKey);
  const now = Date.now();
  if (cached && cached.checked_at && now - Number(cached.checked_at) < CACHE_TTL_MS) {
    return { email: cleanEmail, domain, providerKey: provider, iconData: cached.icon_data || '', source: cached.source || 'cache' };
  }

  // Fournisseurs connus : on évite le réseau, l'interface sait afficher l'icône.
  if (provider) {
    db.setSenderIconCache(cacheKey, { iconData: '', source: `provider:${provider}`, status: 'provider' });
    return { email: cleanEmail, domain, providerKey: provider, iconData: '', source: `provider:${provider}` };
  }

  const candidates = [
    `https://${domain}/favicon.ico`,
    `https://${domain}/apple-touch-icon.png`,
    `https://www.${domain}/favicon.ico`,
  ];
  let iconData = '';
  for (const url of candidates) {
    iconData = await fetchWithTimeout(url);
    if (iconData) break;
  }
  db.setSenderIconCache(cacheKey, {
    iconData,
    source: iconData ? 'favicon' : 'initials',
    status: iconData ? 'ok' : 'missing',
  });
  return { email: cleanEmail, domain, providerKey: provider, iconData, source: iconData ? 'favicon' : 'initials' };
}

module.exports = { resolveSenderIcon, domainFromEmail, providerKey };
