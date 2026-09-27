'use strict';

const calendarGoogle = require('./calendar_google');

const READABLE_ROLES = new Set(['reader', 'writerWithoutPrivateAccess', 'writer', 'owner']);

function cleanError(error) {
  return String(error?.message || error || 'Erreur Google Calendar').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 2000);
}

function isReadableCalendar(calendar = {}) {
  if (calendar.readable === false) return false;
  if (calendar.readable === true) return true;
  return READABLE_ROLES.has(String(calendar.accessRole || ''));
}

function createGoogleCalendarSyncEngine({ db, client, now = () => Date.now() } = {}) {
  if (!db || typeof db.getCalendarConnection !== 'function') {
    throw new Error('Stockage calendrier requis');
  }
  if (!client || typeof client.listCalendars !== 'function' || typeof client.listEventChanges !== 'function') {
    throw new Error('Client Google Calendar requis');
  }

  async function syncRemoteCalendar(remoteCalendar) {
    const startedAt = Math.max(0, Number(now()) || Date.now());
    let syncToken = String(remoteCalendar?.syncToken || '');
    let fullSyncReset = false;
    let changes;

    try {
      changes = await client.listEventChanges({
        calendarId: remoteCalendar.remoteId,
        syncToken,
      });
    } catch (error) {
      if (!(error instanceof calendarGoogle.GoogleCalendarApiError)
          || !error.fullSyncRequired
          || !syncToken) {
        db.updateCalendarRemoteCalendarSync(remoteCalendar.id, {
          lastSyncAt: startedAt,
          lastStatus: 'error',
          lastError: cleanError(error),
        });
        throw error;
      }

      // Un token Google invalidé ne doit pas être réutilisé au prochain essai
      // si la resynchronisation complète échoue à son tour.
      syncToken = '';
      fullSyncReset = true;
      db.updateCalendarRemoteCalendarSync(remoteCalendar.id, {
        syncToken: '',
        lastStatus: 'resync',
        lastError: '',
      });
      try {
        changes = await client.listEventChanges({
          calendarId: remoteCalendar.remoteId,
          syncToken: '',
        });
      } catch (retryError) {
        db.updateCalendarRemoteCalendarSync(remoteCalendar.id, {
          syncToken: '',
          lastSyncAt: startedAt,
          lastStatus: 'error',
          lastError: cleanError(retryError),
        });
        throw retryError;
      }
    }

    const applied = db.syncCalendarRemoteEvents(remoteCalendar.id, changes.items || [], {
      fullSync: Boolean(changes.fullSync || fullSyncReset),
    });
    const finishedAt = Math.max(startedAt, Number(now()) || Date.now());
    const saved = db.updateCalendarRemoteCalendarSync(remoteCalendar.id, {
      syncToken: String(changes.nextSyncToken || ''),
      lastSyncAt: finishedAt,
      lastStatus: 'ok',
      lastError: '',
    });

    return {
      calendar: saved,
      ...applied,
      fullSync: Boolean(changes.fullSync || fullSyncReset),
      fullSyncReset,
      nextSyncToken: saved.syncToken,
    };
  }

  async function syncConnection(connectionId) {
    const connection = db.getCalendarConnection(connectionId);
    if (!connection) throw new Error('Connexion calendrier introuvable');
    if (connection.provider !== 'google') throw new Error('Cette connexion calendrier n’est pas Google');
    if (!connection.enabled) throw new Error('Cette connexion calendrier est désactivée');

    let discovered;
    try {
      discovered = await client.listCalendars();
    } catch (error) {
      db.updateCalendarConnectionSync(connection.id, {
        lastSyncAt: Math.max(0, Number(now()) || Date.now()),
        lastStatus: 'error',
        lastError: cleanError(error),
      });
      throw error;
    }

    const readable = (discovered?.items || []).filter(isReadableCalendar);
    const discovery = db.syncCalendarRemoteCalendars(connection.id, readable);
    const calendars = db.listCalendarRemoteCalendars({
      connectionId: connection.id,
      selectedOnly: true,
    });

    const results = [];
    const errors = [];
    let created = 0;
    let updated = 0;
    let removed = 0;
    let unchanged = 0;
    let skipped = 0;
    let fullSyncs = 0;
    let fullSyncResets = 0;

    for (const remoteCalendar of calendars) {
      try {
        const result = await syncRemoteCalendar(remoteCalendar);
        results.push(result);
        created += result.created || 0;
        updated += result.updated || 0;
        removed += result.removed || 0;
        unchanged += result.unchanged || 0;
        skipped += result.skipped || 0;
        if (result.fullSync) fullSyncs += 1;
        if (result.fullSyncReset) fullSyncResets += 1;
      } catch (error) {
        errors.push({
          calendarId: remoteCalendar.id,
          remoteId: remoteCalendar.remoteId,
          name: remoteCalendar.name,
          error: cleanError(error),
        });
        // Si Google refuse toujours l'authentification après la tentative de
        // renouvellement du client, inutile de provoquer la même erreur sur
        // chacun des autres agendas de cette connexion.
        if (error instanceof calendarGoogle.GoogleCalendarApiError && error.authRequired) break;
      }
    }

    const finishedAt = Math.max(0, Number(now()) || Date.now());
    const successes = results.length;
    const status = errors.length ? (successes ? 'partial' : 'error') : 'ok';
    const lastError = errors.map(item => `${item.name || item.remoteId}: ${item.error}`).join(' · ').slice(0, 2000);
    const savedConnection = db.updateCalendarConnectionSync(connection.id, {
      lastSyncAt: finishedAt,
      lastStatus: status,
      lastError,
    });

    return {
      connection: savedConnection,
      discovery,
      calendars: calendars.length,
      syncedCalendars: successes,
      failedCalendars: errors.length,
      created,
      updated,
      removed,
      unchanged,
      skipped,
      fullSyncs,
      fullSyncResets,
      errors,
      results,
    };
  }

  return { syncRemoteCalendar, syncConnection };
}

module.exports = {
  READABLE_ROLES,
  isReadableCalendar,
  createGoogleCalendarSyncEngine,
};
