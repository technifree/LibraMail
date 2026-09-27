'use strict';

const { GoogleCalendarApiError } = require('./calendar_google');

const MOCK_CREDENTIAL_PREFIX = 'mock-google:';
const MOCK_CLIENT_ID = 'mock://libraMail-google-calendar';
const MOCK_EMAIL = 'libramail.test@example.invalid';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function startOfToday(now = Date.now()) {
  const date = new Date(Number(now) || Date.now());
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function at(base, dayOffset, hour = 0, minute = 0) {
  return base + dayOffset * 24 * 60 * 60 * 1000 + hour * 60 * 60 * 1000 + minute * 60 * 1000;
}

function event({ id, title, startAt, endAt, allDay = false, location = '', notes = '', revision = 1 } = {}) {
  return {
    remoteEventId: String(id || ''),
    remoteEtag: `\"mock-${String(id || 'event')}-r${revision}\"`,
    remoteUpdatedAt: Number(startAt) - 60 * 60 * 1000 + revision,
    deleted: false,
    status: 'confirmed',
    title: String(title || 'Événement simulé'),
    startAt: Number(startAt),
    endAt: Number(endAt),
    allDay: Boolean(allDay),
    location: String(location || ''),
    notes: String(notes || ''),
  };
}

function cancelled(id, revision = 1) {
  return {
    remoteEventId: String(id || ''),
    remoteEtag: `\"mock-${String(id || 'event')}-cancelled-r${revision}\"`,
    remoteUpdatedAt: Date.now(),
    deleted: true,
    status: 'cancelled',
  };
}

function createGoogleCalendarMockService({ now = () => Date.now() } = {}) {
  let base = startOfToday(now());
  let revision = 1;
  let calendars = [];
  let snapshots = new Map();
  let deltas = new Map();
  let expireNext = new Set();
  let localCounter = 0;
  let lastConflictEventId = '';

  function reset() {
    base = startOfToday(now());
    revision = 1;
    calendars = [
      {
        remoteId: 'mock-primary@example.invalid',
        name: 'Agenda principal simulé',
        description: 'Agenda Google principal de test LibraMail',
        timeZone: 'Europe/Paris',
        color: '#4285F4',
        accessRole: 'owner',
        primary: true,
        hidden: false,
        deleted: false,
        selected: true,
        readable: true,
        writable: true,
      },
      {
        remoteId: 'mock-work@example.invalid',
        name: 'Travail simulé',
        description: 'Agenda partagé avec droit d’écriture',
        timeZone: 'Europe/Paris',
        color: '#34A853',
        accessRole: 'writer',
        primary: false,
        hidden: false,
        deleted: false,
        selected: true,
        readable: true,
        writable: true,
      },
      {
        remoteId: 'mock-shared@example.invalid',
        name: 'Partagé lecture seule',
        description: 'Agenda partagé en lecture seule',
        timeZone: 'Europe/Paris',
        color: '#FBBC04',
        accessRole: 'reader',
        primary: false,
        hidden: false,
        deleted: false,
        selected: true,
        readable: true,
        writable: false,
      },
      {
        remoteId: 'mock-freebusy@example.invalid',
        name: 'Disponibilités uniquement',
        description: 'Agenda non lisible, utilisé pour vérifier le filtrage freeBusyReader',
        timeZone: 'Europe/Paris',
        color: '#9AA0A6',
        accessRole: 'freeBusyReader',
        primary: false,
        hidden: false,
        deleted: false,
        selected: false,
        readable: false,
        writable: false,
      },
    ];

    snapshots = new Map([
      ['mock-primary@example.invalid', new Map([
        ['mock-primary-meeting', event({
          id: 'mock-primary-meeting', title: 'Réunion Google simulée',
          startAt: at(base, 1, 10), endAt: at(base, 1, 11),
          location: 'Salle virtuelle', notes: 'Créé par le simulateur LibraMail.', revision,
        })],
        ['mock-primary-allday', event({
          id: 'mock-primary-allday', title: 'Journée entière simulée',
          startAt: at(base, 2), endAt: at(base, 3), allDay: true,
          notes: 'Vérification des événements journée entière.', revision,
        })],
      ])],
      ['mock-work@example.invalid', new Map([
        ['mock-work-review', event({
          id: 'mock-work-review', title: 'Revue projet simulée',
          startAt: at(base, 1, 14), endAt: at(base, 1, 15, 30),
          location: 'Bureau 2', revision,
        })],
      ])],
      ['mock-shared@example.invalid', new Map([
        ['mock-shared-readonly', event({
          id: 'mock-shared-readonly', title: 'Agenda partagé – lecture seule',
          startAt: at(base, 3, 9), endAt: at(base, 3, 10),
          notes: 'Cet événement doit rester non modifiable dans LibraMail.', revision,
        })],
      ])],
      ['mock-freebusy@example.invalid', new Map()],
    ]);
    deltas = new Map();
    expireNext = new Set();
    localCounter = 0;
    lastConflictEventId = '';
    return status();
  }

  function token(calendarId, value = revision) {
    return `mock-sync:${encodeURIComponent(String(calendarId || ''))}:${Number(value) || 1}`;
  }

  function parseToken(calendarId, value) {
    const match = String(value || '').match(/^mock-sync:([^:]+):(\d+)$/);
    if (!match) return null;
    try {
      if (decodeURIComponent(match[1]) !== String(calendarId || '')) return null;
    } catch { return null; }
    return Number(match[2]) || null;
  }

  function deltaBucket(rev, calendarId) {
    if (!deltas.has(rev)) deltas.set(rev, new Map());
    const byCalendar = deltas.get(rev);
    if (!byCalendar.has(calendarId)) byCalendar.set(calendarId, []);
    return byCalendar.get(calendarId);
  }

  function upsert(calendarId, item, rev) {
    const snapshot = snapshots.get(calendarId);
    if (!snapshot) throw new Error('Agenda simulé introuvable');
    const next = { ...item, remoteEtag: `\"mock-${item.remoteEventId}-r${rev}\"`, remoteUpdatedAt: Date.now() + rev };
    snapshot.set(next.remoteEventId, next);
    deltaBucket(rev, calendarId).push(clone(next));
  }

  function remove(calendarId, eventId, rev) {
    const snapshot = snapshots.get(calendarId);
    if (!snapshot) throw new Error('Agenda simulé introuvable');
    snapshot.delete(eventId);
    deltaBucket(rev, calendarId).push(cancelled(eventId, rev));
  }

  function advance() {
    revision += 1;
    const rev = revision;
    const primary = snapshots.get('mock-primary@example.invalid');
    const meeting = primary.get('mock-primary-meeting');
    upsert('mock-primary@example.invalid', {
      ...meeting,
      title: `Réunion Google modifiée – étape ${rev}`,
      notes: `Modification distante simulée n°${rev}.`,
    }, rev);
    upsert('mock-primary@example.invalid', event({
      id: `mock-primary-added-${rev}`,
      title: `Nouveau rendez-vous distant ${rev}`,
      startAt: at(base, rev + 1, 16), endAt: at(base, rev + 1, 17),
      location: 'Google Calendar simulé', revision: rev,
    }), rev);

    if (rev === 2) remove('mock-work@example.invalid', 'mock-work-review', rev);
    else upsert('mock-work@example.invalid', event({
      id: `mock-work-added-${rev}`,
      title: `Événement travail distant ${rev}`,
      startAt: at(base, rev, 11), endAt: at(base, rev, 12), revision: rev,
    }), rev);

    upsert('mock-shared@example.invalid', event({
      id: `mock-shared-added-${rev}`,
      title: `Partagé lecture seule ${rev}`,
      startAt: at(base, rev + 2, 9), endAt: at(base, rev + 2, 9, 45), revision: rev,
    }), rev);
    return status();
  }

  function expireSyncTokens() {
    expireNext = new Set(calendars.filter(item => item.readable).map(item => item.remoteId));
    return status();
  }

  function status() {
    return {
      revision,
      calendars: calendars.length,
      readableCalendars: calendars.filter(item => item.readable).length,
      pendingExpiredTokens: expireNext.size,
      email: MOCK_EMAIL,
      lastConflictEventId,
    };
  }

  async function listCalendars() {
    return { items: clone(calendars), nextSyncToken: `mock-calendar-list:${revision}` };
  }

  async function listEventChanges({ calendarId, syncToken = '' } = {}) {
    const remoteId = String(calendarId || '');
    const snapshot = snapshots.get(remoteId);
    if (!snapshot) throw new GoogleCalendarApiError('Agenda simulé introuvable', { status: 404, reason: 'notFound' });

    const currentToken = String(syncToken || '').trim();
    if (currentToken && expireNext.has(remoteId)) {
      expireNext.delete(remoteId);
      throw new GoogleCalendarApiError('Sync token simulé expiré', { status: 410, reason: 'fullSyncRequired' });
    }

    if (!currentToken) {
      return {
        items: clone([...snapshot.values()]),
        nextSyncToken: token(remoteId),
        timeZone: 'Europe/Paris',
        fullSync: true,
      };
    }

    const since = parseToken(remoteId, currentToken);
    if (!since || since > revision) {
      throw new GoogleCalendarApiError('Sync token simulé invalide', { status: 410, reason: 'fullSyncRequired' });
    }

    const changes = [];
    for (let rev = since + 1; rev <= revision; rev += 1) {
      const byCalendar = deltas.get(rev);
      if (!byCalendar) continue;
      changes.push(...(byCalendar.get(remoteId) || []));
    }
    return {
      items: clone(changes),
      nextSyncToken: token(remoteId),
      timeZone: 'Europe/Paris',
      fullSync: false,
    };
  }

  function calendarDefinition(calendarId) {
    const item = calendars.find(calendar => calendar.remoteId === String(calendarId || ''));
    if (!item) throw new GoogleCalendarApiError('Agenda simulé introuvable', { status: 404, reason: 'notFound' });
    return item;
  }

  function assertWritable(calendarId) {
    const item = calendarDefinition(calendarId);
    if (!item.writable) {
      throw new GoogleCalendarApiError('Agenda simulé en lecture seule', { status: 403, reason: 'forbidden' });
    }
    return item;
  }

  function rawFromNormalized(item) {
    if (!item) return null;
    const dateOnly = value => {
      const date = new Date(Number(value));
      return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    };
    const start = item.allDay
      ? { date: dateOnly(item.startAt) }
      : { dateTime: new Date(item.startAt).toISOString() };
    const end = item.allDay
      ? { date: dateOnly(item.endAt) }
      : { dateTime: new Date(item.endAt).toISOString() };
    return {
      id: item.remoteEventId,
      etag: item.remoteEtag,
      updated: new Date(Math.max(1, Number(item.remoteUpdatedAt) || Date.now())).toISOString(),
      status: item.deleted ? 'cancelled' : 'confirmed',
      summary: item.title || '',
      description: item.notes || '',
      location: item.location || '',
      start,
      end,
    };
  }

  function normalizedFromLocal(eventInput, remoteEventId, rev) {
    const startAt = Number(eventInput?.startAt);
    let endAt = Number(eventInput?.endAt);
    const allDay = Boolean(eventInput?.allDay);
    if (!Number.isFinite(startAt) || startAt <= 0) throw new Error('Date de début simulée invalide');
    if (!Number.isFinite(endAt) || endAt <= startAt) endAt = startAt + (allDay ? 86400000 : 3600000);
    return {
      remoteEventId: String(remoteEventId || ''),
      remoteEtag: `"mock-${String(remoteEventId || 'event')}-r${rev}"`,
      remoteUpdatedAt: Date.now() + rev,
      deleted: false,
      status: 'confirmed',
      title: String(eventInput?.title || '').trim() || 'Événement simulé',
      startAt,
      endAt,
      allDay,
      location: String(eventInput?.location || ''),
      notes: String(eventInput?.notes || ''),
    };
  }

  async function getEvent(calendarId, eventId) {
    calendarDefinition(calendarId);
    const item = snapshots.get(String(calendarId || ''))?.get(String(eventId || '')) || null;
    if (!item) throw new GoogleCalendarApiError('Rendez-vous simulé introuvable', { status: 404, reason: 'notFound' });
    return rawFromNormalized(item);
  }

  async function insertEvent(calendarId, eventInput) {
    assertWritable(calendarId);
    revision += 1;
    localCounter += 1;
    const eventId = `mock-libramail-${revision}-${localCounter}`;
    const item = normalizedFromLocal(eventInput, eventId, revision);
    upsert(String(calendarId), item, revision);
    return rawFromNormalized(snapshots.get(String(calendarId)).get(eventId));
  }

  async function patchEvent(calendarId, eventId, eventInput, { etag = '' } = {}) {
    assertWritable(calendarId);
    const snapshot = snapshots.get(String(calendarId));
    const current = snapshot?.get(String(eventId || '')) || null;
    if (!current) throw new GoogleCalendarApiError('Rendez-vous simulé introuvable', { status: 404, reason: 'notFound' });
    if (etag && String(etag) !== String(current.remoteEtag || '')) {
      throw new GoogleCalendarApiError('Precondition Failed', { status: 412, reason: 'conditionNotMet' });
    }
    revision += 1;
    const item = normalizedFromLocal(eventInput, current.remoteEventId, revision);
    upsert(String(calendarId), item, revision);
    return rawFromNormalized(snapshot.get(current.remoteEventId));
  }

  async function deleteEvent(calendarId, eventId, { etag = '' } = {}) {
    assertWritable(calendarId);
    const snapshot = snapshots.get(String(calendarId));
    const current = snapshot?.get(String(eventId || '')) || null;
    if (!current) throw new GoogleCalendarApiError('Rendez-vous simulé introuvable', { status: 404, reason: 'notFound' });
    if (etag && String(etag) !== String(current.remoteEtag || '')) {
      throw new GoogleCalendarApiError('Precondition Failed', { status: 412, reason: 'conditionNotMet' });
    }
    revision += 1;
    remove(String(calendarId), current.remoteEventId, revision);
    return null;
  }

  function simulateConflict(calendarId = 'mock-primary@example.invalid') {
    assertWritable(calendarId);
    const snapshot = snapshots.get(String(calendarId));
    const current = [...(snapshot?.values() || [])][0];
    if (!current) throw new Error('Aucun rendez-vous simulé disponible pour créer un conflit');
    revision += 1;
    lastConflictEventId = current.remoteEventId;
    upsert(String(calendarId), {
      ...current,
      title: `Modification externe non synchronisée – conflit ${revision}`,
      notes: `Le simulateur a modifié ce rendez-vous hors de LibraMail à la révision ${revision}.`,
    }, revision);
    return { calendarId: String(calendarId), eventId: lastConflictEventId, revision };
  }

  function client() {
    return { listCalendars, listEventChanges, getEvent, insertEvent, patchEvent, deleteEvent };
  }

  reset();
  return { client, reset, advance, expireSyncTokens, simulateConflict, status };
}

function isGoogleCalendarMockConnection(connection = {}) {
  return String(connection?.credentialKey || '').startsWith(MOCK_CREDENTIAL_PREFIX)
    || String(connection?.oauthClientId || '') === MOCK_CLIENT_ID;
}

module.exports = {
  MOCK_CREDENTIAL_PREFIX,
  MOCK_CLIENT_ID,
  MOCK_EMAIL,
  isGoogleCalendarMockConnection,
  createGoogleCalendarMockService,
};
