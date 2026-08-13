'use strict';

const MAX_CALENDAR_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20000;

function normalizeSubscriptionUrl(value) {
  let raw = String(value || '').trim();
  if (!raw) throw new Error('URL du calendrier obligatoire');
  raw = raw.replace(/^webcals?:\/\//i, match => match.toLowerCase().startsWith('webcals') ? 'https://' : 'https://');
  let url;
  try { url = new URL(raw); }
  catch { throw new Error('URL du calendrier invalide'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Seuls les calendriers HTTP(S) ou webcal sont pris en charge');
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

async function fetchCalendar(urlValue, { etag = '', lastModified = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = normalizeSubscriptionUrl(urlValue);
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
    const response = await fetch(url, { method: 'GET', headers, redirect: 'follow', signal: controller.signal });
    if (response.status === 304) {
      return {
        notModified: true,
        url: response.url || url,
        etag: response.headers.get('etag') || etag || '',
        lastModified: response.headers.get('last-modified') || lastModified || '',
        contentType: response.headers.get('content-type') || '',
      };
    }
    if (!response.ok) throw new Error(`Téléchargement du calendrier impossible (HTTP ${response.status})`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_CALENDAR_BYTES) throw new Error('Le calendrier distant dépasse 20 Mo');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_CALENDAR_BYTES) throw new Error('Le calendrier distant dépasse 20 Mo');
    const text = buffer.toString('utf8');
    if (!text.trim()) throw new Error('Le calendrier distant est vide');
    return {
      notModified: false,
      url: response.url || url,
      text,
      etag: response.headers.get('etag') || '',
      lastModified: response.headers.get('last-modified') || '',
      contentType: response.headers.get('content-type') || '',
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Le serveur du calendrier ne répond pas');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  normalizeSubscriptionUrl,
  displayNameFromUrl,
  fetchCalendar,
};
