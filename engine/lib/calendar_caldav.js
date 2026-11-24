'use strict';

// CalDAV transport foundation. No persistence, UI, background sync or network
// requests until an explicit client method is called. XML is returned raw for
// the namespace-aware discovery/parser layer to consume in the next phase.
const DAV = 'DAV:';
const CALDAV = 'urn:ietf:params:xml:ns:caldav';
const XML = '<?xml version="1.0" encoding="utf-8"?>';
const propfind = props => `${XML}<d:propfind xmlns:d="${DAV}" xmlns:c="${CALDAV}"><d:prop>${props}</d:prop></d:propfind>`;
const DISCOVERY = Object.freeze({
  principal: propfind('<d:current-user-principal/><c:calendar-home-set/>'),
  home: propfind('<c:calendar-home-set/>'),
  calendars: propfind('<d:displayname/><d:resourcetype/><d:current-user-privilege-set/><c:supported-calendar-component-set/>'),
  events: `${XML}<c:calendar-query xmlns:d="${DAV}" xmlns:c="${CALDAV}"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>`,
});

class CalDavError extends Error {
  constructor(code, status = null) {
    super(`CalDAV: ${code}${status === null ? '' : ` (HTTP ${status})`}`);
    this.name = 'CalDavError';
    this.code = code;
    this.status = status;
  }
}
function checkedURL(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw new CalDavError('INVALID_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
    throw new CalDavError('INVALID_URL');
  return url;
}
function strongETag(etag) {
  if (typeof etag !== 'string' || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag))
    throw new CalDavError('ETAG_REQUIRED');
  return etag;
}
async function boundedText(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new CalDavError('RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    try { await reader.cancel(); } catch { /* do not mask original error */ }
    reader.releaseLock();
  }
}
function createCalDavClient({ serverURL, username, password, fetchImpl = globalThis.fetch,
  timeoutMs = 15000, maxBytes = 8 * 1024 * 1024 } = {}) {
  const base = checkedURL(serverURL);
  if (typeof username !== 'string' || !username.trim() || /[:\r\n\0]/.test(username) ||
      typeof password !== 'string' || !password || /[\r\n\0]/.test(password))
    throw new CalDavError('INVALID_CREDENTIALS');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024 ||
      typeof fetchImpl !== 'function') throw new CalDavError('INVALID_OPTIONS');
  const authorization = 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  function target(href) {
    const url = checkedURL(href, base);
    // Never follow server-provided links to a different origin or redirect
    // credentials automatically. iCloud shard discovery needs its own policy.
    if (url.origin !== base.origin) throw new CalDavError('CROSS_ORIGIN');
    return url;
  }
  async function request(method, href, headers, body, accepted, discovery = false) {
    const url = target(href);
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(url.href, { method, headers: { ...headers, Authorization: authorization }, body,
        redirect: 'manual', signal });
      // Discovery may inspect redirects, but never follows them here.
      if (discovery && [301, 302, 307, 308].includes(response.status)) {
        try { await response.body?.cancel(); } catch { /* ignore */ }
        return { status: response.status, location: response.headers.get('location'), text: '' };
      }
      if (!accepted.includes(response.status)) {
        try { await response.body?.cancel(); } catch { /* ignore */ }
        const code = response.status === 401 ? 'AUTHENTICATION_FAILED' : response.status === 403 ? 'FORBIDDEN' :
          response.status === 412 ? 'CONFLICT' : response.status >= 300 && response.status < 400 ? 'REDIRECT_BLOCKED' : 'HTTP_ERROR';
        throw new CalDavError(code, response.status);
      }
      const text = await boundedText(response, maxBytes);
      return { status: response.status, etag: response.headers.get('etag'), text };
    } catch (error) {
      if (error instanceof CalDavError) throw error;
      // Do not expose URLs, credentials or raw transport error messages.
      throw new CalDavError(signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR');
    }
  }
  function xml(method, href, depth, body, discovery = false) {
    return request(method, href, { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' }, body, [207], discovery);
  }
  function calendarBody(ics) {
    if (typeof ics !== 'string' || !/^BEGIN:VCALENDAR\r?\n/i.test(ics) || !/\r?\nEND:VCALENDAR(?:\r?\n)?$/i.test(ics) || Buffer.byteLength(ics) > maxBytes)
      throw new CalDavError('INVALID_CALENDAR_DATA');
    return ics;
  }
  return Object.freeze({
    // Only the explicit discovery layer can inspect a PROPFIND redirect.
    discovery: (kind, href) => {
      if (!['principal', 'home', 'calendars'].includes(kind)) throw new CalDavError('INVALID_OPTIONS');
      return xml('PROPFIND', href, kind === 'calendars' ? 1 : 0, DISCOVERY[kind], true);
    },
    principal: (href = base.href) => xml('PROPFIND', href, 0, DISCOVERY.principal),
    home: href => xml('PROPFIND', href, 0, DISCOVERY.home),
    calendars: href => xml('PROPFIND', href, 1, DISCOVERY.calendars),
    events: href => xml('REPORT', href, 1, DISCOVERY.events),
    get: href => request('GET', href, { Accept: 'text/calendar' }, undefined, [200]),
    create: (href, ics) => request('PUT', href, { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' }, calendarBody(ics), [201, 204]),
    update: (href, ics, etag) => request('PUT', href, { 'Content-Type': 'text/calendar; charset=utf-8', 'If-Match': strongETag(etag) }, calendarBody(ics), [200, 204]),
    remove: (href, etag) => request('DELETE', href, { 'If-Match': strongETag(etag) }, undefined, [200, 204]),
  });
}
module.exports = { createCalDavClient, CalDavError };
