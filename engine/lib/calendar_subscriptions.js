'use strict';

const dns = require('dns').promises;
const https = require('https');
const net = require('net');

const MAX_CALENDAR_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 5;

function normalizeSubscriptionUrl(value) {
  let raw = String(value || '').trim();
  if (!raw) throw new Error('URL du calendrier obligatoire');
  raw = raw.replace(/^webcals?:\/\//i, 'https://');
  let url;
  try { url = new URL(raw); }
  catch { throw new Error('URL du calendrier invalide'); }
  if (url.protocol !== 'https:') {
    throw new Error('Pour des raisons de sécurité, seuls les calendriers HTTPS ou webcal sont pris en charge');
  }
  if (url.username || url.password) {
    throw new Error('Les identifiants intégrés dans l’URL du calendrier ne sont pas autorisés');
  }
  url.hash = '';
  return url.toString();
}

function displayNameFromUrl(value) {
  try {
    const url = new URL(normalizeSubscriptionUrl(value));
    const leaf = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '').replace(/\.(ics|ical|vcs)$/i, '').trim();
    return leaf || url.hostname;
  } catch {
    return '';
  }
}

function normalizeHostname(value) {
  let hostname = String(value || '').trim().toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  return hostname.replace(/\.$/, '');
}

function parseIpv4(address) {
  const parts = String(address || '').split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(part => Number(part));
  if (octets.some((part, index) => !Number.isInteger(part) || part < 0 || part > 255 || String(part) !== String(Number(parts[index])))) {
    return null;
  }
  return octets;
}

function ipv6Bytes(address) {
  let value = String(address || '').toLowerCase().split('%')[0];
  if (!net.isIPv6(value)) return null;

  const embedded = value.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded) {
    const ipv4 = parseIpv4(embedded[1]);
    if (!ipv4) return null;
    const a = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const b = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    value = value.slice(0, value.length - embedded[1].length) + `${a}:${b}`;
  }

  const pieces = value.split('::');
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(':').filter(Boolean) : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(':').filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (pieces.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8) return null;

  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const n = Number.parseInt(group, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

function isBlockedIpv4(address) {
  const p = parseIpv4(address);
  if (!p) return true;
  const [a, b, c] = p;
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isBlockedIpv6(address) {
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;

  const allZero = bytes.every(value => value === 0);
  if (allZero) return true;
  const loopback = bytes.slice(0, 15).every(value => value === 0) && bytes[15] === 1;
  if (loopback) return true;

  const mappedIpv4 = bytes.slice(0, 10).every(value => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const compatibleIpv4 = bytes.slice(0, 12).every(value => value === 0);
  if (mappedIpv4 || compatibleIpv4) {
    return isBlockedIpv4(bytes.slice(12).join('.'));
  }

  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true; // fec0::/10 site local (historique)
  if (bytes[0] === 0xff) return true; // multicast
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // documentation
  return false;
}

function isBlockedIpAddress(address) {
  const value = normalizeHostname(address);
  const family = net.isIP(value);
  if (family === 4) return isBlockedIpv4(value);
  if (family === 6) return isBlockedIpv6(value);
  return true;
}

function assertSafeHostname(hostname) {
  const value = normalizeHostname(hostname);
  if (!value) throw new Error('Hôte du calendrier invalide');
  if (value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local')) {
    throw new Error('Les calendriers hébergés sur une adresse locale ne sont pas autorisés');
  }
  if (!value.includes('.') && !net.isIP(value)) {
    throw new Error('Les noms d’hôte locaux ne sont pas autorisés pour les calendriers distants');
  }
  if (net.isIP(value) && isBlockedIpAddress(value)) {
    throw new Error('Les calendriers hébergés sur une adresse privée, locale ou réservée ne sont pas autorisés');
  }
  return value;
}

async function resolvePublicAddresses(urlValue) {
  const url = urlValue instanceof URL ? urlValue : new URL(normalizeSubscriptionUrl(urlValue));
  const hostname = assertSafeHostname(url.hostname);
  if (net.isIP(hostname)) {
    return [{ address: hostname, family: net.isIP(hostname) }];
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Impossible de résoudre l’adresse du serveur de calendrier');
  }
  if (!Array.isArray(addresses) || !addresses.length) {
    throw new Error('Impossible de résoudre l’adresse du serveur de calendrier');
  }
  for (const item of addresses) {
    if (!item || !net.isIP(item.address) || isBlockedIpAddress(item.address)) {
      throw new Error('Le serveur de calendrier résout vers une adresse privée, locale ou réservée');
    }
  }
  return addresses.map(item => ({ address: item.address, family: item.family || net.isIP(item.address) }));
}

function pinnedLookup(addresses) {
  let index = 0;
  return (_hostname, options, callback) => {
    const opts = typeof options === 'object' && options ? options : {};
    const requestedFamily = Number(opts.family) || 0;
    const candidates = requestedFamily
      ? addresses.filter(item => Number(item.family) === requestedFamily)
      : addresses;
    if (!candidates.length) {
      callback(new Error('Aucune adresse réseau compatible pour le serveur de calendrier'));
      return;
    }
    if (opts.all) {
      callback(null, candidates.map(item => ({ address: item.address, family: Number(item.family) })));
      return;
    }
    const item = candidates[index % candidates.length];
    index += 1;
    callback(null, item.address, Number(item.family));
  };
}

function requestCalendarOnce(url, headers, signal, addresses) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = https.request(url, {
      method: 'GET',
      headers,
      lookup: pinnedLookup(addresses),
      signal,
    }, response => {
      const status = Number(response.statusCode || 0);
      const responseHeaders = response.headers || {};
      const redirect = [301, 302, 303, 307, 308].includes(status);
      if (redirect) {
        const location = String(responseHeaders.location || '').trim();
        response.resume();
        if (!location) {
          finishReject(new Error(`Redirection du calendrier invalide (HTTP ${status})`));
          return;
        }
        if (!settled) {
          settled = true;
          resolve({ status, location, headers: responseHeaders, buffer: null });
        }
        return;
      }
      if (status === 304) {
        response.resume();
        if (!settled) {
          settled = true;
          resolve({ status, headers: responseHeaders, buffer: null });
        }
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        finishReject(new Error(`Téléchargement du calendrier impossible (HTTP ${status})`));
        return;
      }

      const length = Number(responseHeaders['content-length'] || 0);
      if (Number.isFinite(length) && length > MAX_CALENDAR_BYTES) {
        response.resume();
        finishReject(new Error('Le calendrier distant dépasse 20 Mo'));
        return;
      }

      const chunks = [];
      let total = 0;
      response.on('data', chunk => {
        if (settled) return;
        total += chunk.length;
        if (total > MAX_CALENDAR_BYTES) {
          settled = true;
          req.destroy();
          reject(new Error('Le calendrier distant dépasse 20 Mo'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ status, headers: responseHeaders, buffer: Buffer.concat(chunks) });
      });
      response.on('aborted', () => finishReject(new Error('Téléchargement du calendrier interrompu')));
      response.on('error', finishReject);
    });
    req.on('error', finishReject);
    req.end();
  });
}

function headerValue(headers, name) {
  const value = headers?.[String(name || '').toLowerCase()];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

async function fetchCalendar(urlValue, { etag = '', lastModified = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let currentUrl = normalizeSubscriptionUrl(urlValue);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  timer.unref?.();
  const headers = {
    Accept: 'text/calendar, application/ics, text/plain;q=0.9, */*;q=0.2',
    'User-Agent': 'LibraMail/0.3.2',
  };
  if (etag) headers['If-None-Match'] = String(etag);
  if (lastModified) headers['If-Modified-Since'] = String(lastModified);

  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const url = new URL(currentUrl);
      const addresses = await resolvePublicAddresses(url);
      const response = await requestCalendarOnce(url, headers, controller.signal, addresses);

      if (response.location) {
        if (redirects >= MAX_REDIRECTS) throw new Error('Trop de redirections lors du téléchargement du calendrier');
        let next;
        try { next = new URL(response.location, url); }
        catch { throw new Error('Redirection du calendrier invalide'); }
        currentUrl = normalizeSubscriptionUrl(next.toString());
        continue;
      }

      const responseEtag = headerValue(response.headers, 'etag');
      const responseLastModified = headerValue(response.headers, 'last-modified');
      const contentType = headerValue(response.headers, 'content-type');
      if (response.status === 304) {
        return {
          notModified: true,
          url: currentUrl,
          etag: responseEtag || etag || '',
          lastModified: responseLastModified || lastModified || '',
          contentType,
        };
      }

      const text = Buffer.from(response.buffer || []).toString('utf8');
      if (!text.trim()) throw new Error('Le calendrier distant est vide');
      return {
        notModified: false,
        url: currentUrl,
        text,
        etag: responseEtag,
        lastModified: responseLastModified,
        contentType,
      };
    }
    throw new Error('Trop de redirections lors du téléchargement du calendrier');
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
      throw new Error('Le serveur du calendrier ne répond pas');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  normalizeSubscriptionUrl,
  displayNameFromUrl,
  fetchCalendar,
  _security: {
    isBlockedIpAddress,
    assertSafeHostname,
  },
};
