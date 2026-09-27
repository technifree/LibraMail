'use strict';

const calendarAuth = require('./calendar_auth');

const GOOGLE = calendarAuth.providerFor('google');
const API_BASE = GOOGLE.apiBase;
const DEFAULT_TIMEOUT_MS = 30000;
const CALENDAR_PAGE_SIZE = 250;
const EVENT_PAGE_SIZE = 2500;
const WRITABLE_ROLES = new Set(['writerWithoutPrivateAccess', 'writer', 'owner']);
const READABLE_ROLES = new Set(['reader', 'writerWithoutPrivateAccess', 'writer', 'owner']);

class GoogleCalendarApiError extends Error {
  constructor(message, { status = 0, reason = '', payload = null } = {}) {
    super(String(message || 'Erreur Google Calendar'));
    this.name = 'GoogleCalendarApiError';
    this.status = Number(status) || 0;
    this.reason = String(reason || '');
    this.payload = payload || null;
    this.authRequired = this.status === 401;
    this.fullSyncRequired = this.status === 410
      || this.reason === 'fullSyncRequired'
      || this.reason === 'updatedMinTooLongAgo';
    this.conflict = this.status === 409 || this.status === 412;
    this.retryable = this.status === 429 || [500, 502, 503, 504].includes(this.status);
  }
}

function cleanText(value, max = 800) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function cleanAccessToken(value) {
  const token = String(value || '').trim();
  if (!token || token.length > 20000 || /[\r\n]/.test(token)) {
    throw new Error('Access token Google Calendar invalide');
  }
  return token;
}

function safePathSegment(value, label = 'identifiant') {
  const text = String(value || '').trim();
  if (!text || text.length > 2000 || /[\r\n]/.test(text)) {
    throw new Error(`${label} Google Calendar invalide`);
  }
  return encodeURIComponent(text);
}

function appendQuery(url, query = {}) {
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else if (typeof value === 'boolean') {
      url.searchParams.set(key, value ? 'true' : 'false');
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

function googleErrorFromResponse(response, payload) {
  const status = Number(response?.status) || 0;
  const error = payload?.error || {};
  const reason = cleanText(error?.errors?.[0]?.reason || error?.status || '', 120);
  const message = cleanText(error?.message || `Google Calendar : HTTP ${status}`);
  return new GoogleCalendarApiError(message, { status, reason, payload });
}

function normalizeCalendarListEntry(entry = {}) {
  const remoteId = String(entry.id || '').trim();
  if (!remoteId) return null;
  const rawColor = String(entry.backgroundColor || '').trim();
  const accessRole = String(entry.accessRole || '').trim();
  return {
    remoteId,
    name: cleanText(entry.summaryOverride || entry.summary || remoteId, 240),
    description: String(entry.description || '').trim().slice(0, 2000),
    timeZone: String(entry.timeZone || '').trim().slice(0, 120),
    color: /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor.toUpperCase() : '',
    accessRole,
    primary: Boolean(entry.primary),
    hidden: Boolean(entry.hidden),
    deleted: Boolean(entry.deleted),
    selected: !entry.hidden && !entry.deleted,
    readable: READABLE_ROLES.has(accessRole),
    writable: WRITABLE_ROLES.has(accessRole),
  };
}

function parseDateOnlyLocal(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return NaN;
  return date.getTime();
}

function parseGoogleDateTime(spec = {}) {
  if (spec.date) return parseDateOnlyLocal(spec.date);
  const timestamp = Date.parse(String(spec.dateTime || ''));
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function normalizeGoogleEvent(event = {}, { titleFallback = 'Untitled event' } = {}) {
  const remoteEventId = String(event.id || '').trim();
  if (!remoteEventId) return null;
  const status = String(event.status || '').trim();
  const remoteEtag = String(event.etag || '').trim().slice(0, 2000);
  const remoteUpdatedAt = Number.isFinite(Date.parse(String(event.updated || '')))
    ? Date.parse(String(event.updated || ''))
    : 0;

  if (status === 'cancelled') {
    return {
      remoteEventId,
      remoteEtag,
      remoteUpdatedAt,
      deleted: true,
      status,
      recurringEventId: String(event.recurringEventId || '').trim(),
    };
  }

  const startAt = parseGoogleDateTime(event.start || {});
  let endAt = parseGoogleDateTime(event.end || {});
  if (!Number.isFinite(startAt)) return null;
  const allDay = Boolean(event.start?.date);
  if (!Number.isFinite(endAt) || endAt <= startAt) {
    endAt = startAt + (allDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000);
  }

  return {
    remoteEventId,
    remoteEtag,
    remoteUpdatedAt,
    deleted: false,
    status,
    title: cleanText(event.summary || titleFallback, 240) || cleanText(titleFallback, 240),
    startAt,
    endAt,
    allDay,
    location: String(event.location || '').trim().slice(0, 500),
    notes: String(event.description || '').trim().slice(0, 20000),
    recurringEventId: String(event.recurringEventId || '').trim(),
    originalStartAt: parseGoogleDateTime(event.originalStartTime || {}) || 0,
    eventType: String(event.eventType || 'default').trim(),
    htmlLink: String(event.htmlLink || '').trim().slice(0, 4000),
    visibility: String(event.visibility || '').trim().slice(0, 80),
    transparency: String(event.transparency || '').trim().slice(0, 80),
  };
}

function formatLocalDate(timestamp) {
  const date = new Date(Number(timestamp));
  if (!Number.isFinite(date.getTime())) throw new Error('Date de rendez-vous invalide');
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localEventToGoogle(event = {}) {
  const startAt = Number(event.startAt);
  let endAt = Number(event.endAt);
  if (!Number.isFinite(startAt) || startAt <= 0) throw new Error('Date de début invalide');
  if (!Number.isFinite(endAt) || endAt <= startAt) {
    endAt = startAt + (event.allDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000);
  }

  const resource = {
    summary: String(event.title || '').trim().slice(0, 240),
    description: String(event.notes || '').trim().slice(0, 20000),
    location: String(event.location || '').trim().slice(0, 500),
  };
  if (!resource.summary) throw new Error('Le titre du rendez-vous est obligatoire');

  if (event.allDay) {
    resource.start = { date: formatLocalDate(startAt) };
    resource.end = { date: formatLocalDate(endAt) };
  } else {
    resource.start = { dateTime: new Date(startAt).toISOString() };
    resource.end = { dateTime: new Date(endAt).toISOString() };
  }
  return resource;
}

function createGoogleCalendarClient({
  getAccessToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof getAccessToken !== 'function') throw new Error('Fournisseur d’access token Google Calendar requis');
  if (typeof fetchImpl !== 'function') throw new Error('Client HTTP Google Calendar indisponible');
  const requestTimeout = Math.max(1000, Math.min(120000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

  async function requestWithToken(method, path, { query = {}, body = undefined, etag = '' } = {}, accessToken) {
    const url = new URL(`${API_BASE}${path}`);
    appendQuery(url, query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${cleanAccessToken(accessToken)}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
    if (etag) headers['if-match'] = String(etag).slice(0, 2000);

    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new GoogleCalendarApiError('Google Calendar : délai d’attente dépassé', { reason: 'timeout' });
      }
      throw new GoogleCalendarApiError(cleanText(error?.message || error, 800), { reason: 'network' });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 204) return null;
    let payload = null;
    try { payload = await response.json(); }
    catch {
      if (!response.ok) throw googleErrorFromResponse(response, null);
      throw new GoogleCalendarApiError('Réponse JSON Google Calendar invalide', { status: response.status });
    }
    if (!response.ok) throw googleErrorFromResponse(response, payload);
    return payload;
  }

  async function request(method, path, options = {}) {
    const firstToken = cleanAccessToken(await getAccessToken({ forceRefresh: false }));
    try {
      return await requestWithToken(method, path, options, firstToken);
    } catch (error) {
      if (!(error instanceof GoogleCalendarApiError) || !error.authRequired) throw error;
      const refreshed = cleanAccessToken(await getAccessToken({ forceRefresh: true }));
      return requestWithToken(method, path, options, refreshed);
    }
  }

  async function listCalendars() {
    const items = [];
    let pageToken = '';
    let nextSyncToken = '';
    do {
      const payload = await request('GET', '/users/me/calendarList', {
        query: {
          maxResults: CALENDAR_PAGE_SIZE,
          showHidden: true,
          pageToken,
        },
      });
      for (const entry of payload?.items || []) {
        const normalized = normalizeCalendarListEntry(entry);
        if (normalized) items.push(normalized);
      }
      pageToken = String(payload?.nextPageToken || '');
      if (!pageToken) nextSyncToken = String(payload?.nextSyncToken || '');
    } while (pageToken);
    return { items, nextSyncToken };
  }

  async function listEventChanges({
    calendarId,
    syncToken = '',
    timeMin = '',
    timeMax = '',
    singleEvents = true,
  } = {}) {
    const calendarPath = safePathSegment(calendarId, 'Identifiant d’agenda');
    const token = String(syncToken || '').trim();
    if (token && (timeMin || timeMax)) {
      throw new Error('timeMin/timeMax ne peuvent pas être utilisés avec un syncToken Google Calendar');
    }

    const items = [];
    let pageToken = '';
    let nextSyncToken = '';
    let timeZone = '';
    do {
      const query = {
        maxResults: EVENT_PAGE_SIZE,
        showDeleted: true,
        singleEvents: Boolean(singleEvents),
        pageToken,
      };
      if (token) query.syncToken = token;
      else {
        if (timeMin) query.timeMin = String(timeMin);
        if (timeMax) query.timeMax = String(timeMax);
      }
      const payload = await request('GET', `/calendars/${calendarPath}/events`, { query });
      for (const entry of payload?.items || []) {
        const normalized = normalizeGoogleEvent(entry);
        if (normalized) items.push(normalized);
      }
      if (!timeZone) timeZone = String(payload?.timeZone || '');
      pageToken = String(payload?.nextPageToken || '');
      if (!pageToken) nextSyncToken = String(payload?.nextSyncToken || '');
    } while (pageToken);

    if (!nextSyncToken) throw new GoogleCalendarApiError('Google Calendar : nextSyncToken absent', { reason: 'missingSyncToken' });
    return {
      items,
      nextSyncToken,
      timeZone,
      fullSync: !token,
    };
  }

  async function getEvent(calendarId, eventId) {
    const calendarPath = safePathSegment(calendarId, 'Identifiant d’agenda');
    const eventPath = safePathSegment(eventId, 'Identifiant de rendez-vous');
    return request('GET', `/calendars/${calendarPath}/events/${eventPath}`);
  }

  async function insertEvent(calendarId, event, { sendUpdates = '' } = {}) {
    const calendarPath = safePathSegment(calendarId, 'Identifiant d’agenda');
    return request('POST', `/calendars/${calendarPath}/events`, {
      query: sendUpdates ? { sendUpdates } : {},
      body: localEventToGoogle(event),
    });
  }

  async function patchEvent(calendarId, eventId, event, { etag = '', sendUpdates = '' } = {}) {
    const calendarPath = safePathSegment(calendarId, 'Identifiant d’agenda');
    const eventPath = safePathSegment(eventId, 'Identifiant de rendez-vous');
    return request('PATCH', `/calendars/${calendarPath}/events/${eventPath}`, {
      query: sendUpdates ? { sendUpdates } : {},
      body: localEventToGoogle(event),
      etag,
    });
  }

  async function deleteEvent(calendarId, eventId, { etag = '', sendUpdates = '' } = {}) {
    const calendarPath = safePathSegment(calendarId, 'Identifiant d’agenda');
    const eventPath = safePathSegment(eventId, 'Identifiant de rendez-vous');
    return request('DELETE', `/calendars/${calendarPath}/events/${eventPath}`, {
      query: sendUpdates ? { sendUpdates } : {},
      etag,
    });
  }

  return {
    listCalendars,
    listEventChanges,
    getEvent,
    insertEvent,
    patchEvent,
    deleteEvent,
  };
}

module.exports = {
  API_BASE,
  CALENDAR_PAGE_SIZE,
  EVENT_PAGE_SIZE,
  GoogleCalendarApiError,
  normalizeCalendarListEntry,
  normalizeGoogleEvent,
  localEventToGoogle,
  createGoogleCalendarClient,
};
