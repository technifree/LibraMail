'use strict';

const calendarGoogle = require('./calendar_google');

const WRITABLE_ROLES = new Set(['writerWithoutPrivateAccess', 'writer', 'owner']);

function isWritableCalendar(calendar = {}) {
  return Boolean(calendar?.selected) && WRITABLE_ROLES.has(String(calendar?.accessRole || ''));
}

function cleanError(error) {
  return String(error?.message || error || 'Erreur Google Calendar')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 2000);
}

function normalizedGoogleEvent(raw) {
  const event = calendarGoogle.normalizeGoogleEvent(raw || {});
  if (!event || event.deleted) return null;
  return event;
}

function createGoogleCalendarWriteEngine({ db, clientForConnection } = {}) {
  if (!db) throw new Error('Base calendrier requise');
  if (typeof clientForConnection !== 'function') throw new Error('Client Google Calendar requis');

  function contextForRemoteCalendar(remoteCalendarId) {
    const calendar = db.getCalendarRemoteCalendar(remoteCalendarId);
    if (!calendar) throw new Error('Agenda Google introuvable');
    if (!calendar.selected) throw new Error('Cet agenda Google est désactivé dans LibraMail');
    if (!WRITABLE_ROLES.has(String(calendar.accessRole || ''))) {
      throw new Error('Cet agenda Google est en lecture seule');
    }
    const connection = db.getCalendarConnection(calendar.connectionId);
    if (!connection || connection.provider !== 'google') throw new Error('Connexion Google Calendar introuvable');
    if (!connection.enabled) throw new Error('Cette connexion Google Calendar est désactivée');
    return { calendar, connection, client: clientForConnection(connection) };
  }

  function persistRemoteEvent(localId, localInput, remoteCalendar, rawRemote) {
    const remote = normalizedGoogleEvent(rawRemote);
    if (!remote) throw new Error('Google Calendar n’a pas renvoyé le rendez-vous enregistré');
    const categoryId = Number(localInput?.categoryId) > 0 ? Number(localInput.categoryId) : null;
    const payload = {
      title: remote.title,
      startAt: remote.startAt,
      endAt: remote.endAt,
      allDay: remote.allDay,
      location: remote.location,
      notes: remote.notes,
      accountId: '',
      categoryId,
      color: remoteCalendar.color,
    };
    const saved = db.saveCalendarEvent(payload, localId || null);
    return db.setCalendarEventRemoteState(saved.id, {
      remoteCalendarId: remoteCalendar.id,
      remoteEventId: remote.remoteEventId,
      remoteEtag: remote.remoteEtag,
      remoteUpdatedAt: remote.remoteUpdatedAt,
    });
  }

  async function refreshConflict(existing, calendar, client) {
    let raw;
    try {
      raw = await client.getEvent(calendar.remoteId, existing.remoteEventId);
    } catch (error) {
      if (error instanceof calendarGoogle.GoogleCalendarApiError && error.status === 404) {
        db.removeCalendarEvent(existing.id);
        return { conflict: true, removed: true, event: null };
      }
      throw error;
    }
    const latest = calendarGoogle.normalizeGoogleEvent(raw || {});
    if (!latest || latest.deleted) {
      db.removeCalendarEvent(existing.id);
      return { conflict: true, removed: true, event: null };
    }
    db.syncCalendarRemoteEvents(calendar.id, [latest], { fullSync: false });
    return { conflict: true, removed: false, event: db.getCalendarEvent(existing.id) };
  }

  async function createEvent(remoteCalendarId, input = {}) {
    const { calendar, client } = contextForRemoteCalendar(remoteCalendarId);
    const raw = await client.insertEvent(calendar.remoteId, input);
    const event = persistRemoteEvent(null, input, calendar, raw);
    return { conflict: false, created: true, event };
  }

  async function updateEvent(id, input = {}) {
    const existing = db.getCalendarEvent(id);
    if (!existing) throw new Error('Rendez-vous introuvable');
    if (!existing.remoteCalendarId || !existing.remoteEventId) {
      throw new Error('Ce rendez-vous n’est pas lié à Google Calendar');
    }
    const { calendar, client } = contextForRemoteCalendar(existing.remoteCalendarId);
    try {
      const raw = await client.patchEvent(calendar.remoteId, existing.remoteEventId, input, {
        etag: existing.remoteEtag,
      });
      const event = persistRemoteEvent(existing.id, input, calendar, raw);
      return { conflict: false, updated: true, event };
    } catch (error) {
      if (!(error instanceof calendarGoogle.GoogleCalendarApiError) || !error.conflict) throw error;
      return refreshConflict(existing, calendar, client);
    }
  }

  async function deleteEvent(id) {
    const existing = db.getCalendarEvent(id);
    if (!existing) return { conflict: false, removed: false, event: null };
    if (!existing.remoteCalendarId || !existing.remoteEventId) {
      throw new Error('Ce rendez-vous n’est pas lié à Google Calendar');
    }
    const { calendar, client } = contextForRemoteCalendar(existing.remoteCalendarId);
    try {
      await client.deleteEvent(calendar.remoteId, existing.remoteEventId, { etag: existing.remoteEtag });
    } catch (error) {
      if (error instanceof calendarGoogle.GoogleCalendarApiError && error.status === 404) {
        db.removeCalendarEvent(existing.id);
        return { conflict: false, removed: true, event: null, alreadyRemoved: true };
      }
      if (!(error instanceof calendarGoogle.GoogleCalendarApiError) || !error.conflict) throw error;
      return refreshConflict(existing, calendar, client);
    }
    db.removeCalendarEvent(existing.id);
    return { conflict: false, removed: true, event: null };
  }

  return { createEvent, updateEvent, deleteEvent };
}

module.exports = {
  WRITABLE_ROLES,
  isWritableCalendar,
  cleanError,
  createGoogleCalendarWriteEngine,
};
