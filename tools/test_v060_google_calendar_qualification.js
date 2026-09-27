#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const masterPassword = require('../engine/lib/master_password');
const credentialStore = require('../engine/lib/credential_store');

// Le mailstore utilise le trousseau système. Pour ce test automatisé, on garde
// les secrets de service dans une Map strictement locale au processus.
const serviceSecrets = new Map();
credentialStore.readServiceSecret = name => serviceSecrets.get(String(name)) || '';
credentialStore.writeServiceSecret = (name, value) => {
  serviceSecrets.set(String(name), String(value));
  return true;
};
credentialStore.removeServiceSecret = name => serviceSecrets.delete(String(name));

const db = require('../engine/lib/db');
const mailStore = require('../engine/lib/mail_store');
const backup = require('../engine/lib/backup');
const Database = require(require.resolve('better-sqlite3', {
  paths: [path.join(__dirname, '../engine')],
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-google-qualification-'));
const vaultDir = path.join(root, 'vault');
const data = path.join(root, 'data');
const archive = path.join(root, 'qualification.zip');
const extractedRoot = path.join(root, 'extract');

function containsSecret(file, secret) {
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file).includes(Buffer.from(secret, 'utf8'));
}

(async () => {
  const refreshToken = 'qualification-refresh-token-MUST-NOT-LEAK';
  const accessToken = 'qualification-access-token-MUST-NOT-LEAK';
  const clientId = 'qualification-desktop.apps.googleusercontent.com';

  try {
    // 1) Le secret OAuth calendrier utilise bien le coffre principal et reste
    // lisible après changement du mot de passe principal.
    masterPassword.init(vaultDir);
    masterPassword.enable('Qualification-060-Initial!');
    const context = credentialStore.serviceSecretContext(credentialStore.CALENDAR_OAUTH_SERVICE_SECRET);
    const protectedRefresh = credentialStore.encodeForStorage(refreshToken, context);
    assert(protectedRefresh.startsWith('vault1:'));
    assert(!protectedRefresh.includes(refreshToken));
    assert.strictEqual(credentialStore.decodeForStorage(protectedRefresh, context), refreshToken);
    masterPassword.changePassword('Qualification-060-Initial!', 'Qualification-060-New!');
    assert.strictEqual(credentialStore.decodeForStorage(protectedRefresh, context), refreshToken);
    masterPassword.disable('Qualification-060-New!');

    // 2) Le bundle de refresh tokens est indépendant de SQLite et ne contient
    // jamais l'access token éphémère.
    let calendarVault = '';
    const secretIo = {
      readSecret: name => {
        assert.strictEqual(name, credentialStore.CALENDAR_OAUTH_SERVICE_SECRET);
        return calendarVault;
      },
      writeSecret: (name, value) => {
        assert.strictEqual(name, credentialStore.CALENDAR_OAUTH_SERVICE_SECRET);
        calendarVault = String(value);
        return true;
      },
      removeSecret: name => {
        assert.strictEqual(name, credentialStore.CALENDAR_OAUTH_SERVICE_SECRET);
        calendarVault = '';
        return true;
      },
    };
    credentialStore.writeCalendarOAuthRefreshToken('google:qualification', refreshToken, secretIo);
    assert.strictEqual(
      credentialStore.readCalendarOAuthRefreshToken('google:qualification', secretIo),
      refreshToken,
    );
    assert(!calendarVault.includes(accessToken));

    // 3) Connexion, agendas, sync token et ETag doivent survivre à un vrai
    // close/reopen de index.db.
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'accounts.json'), '[]\n');
    fs.writeFileSync(path.join(data, 'config.json'), '{}\n');
    db.init(data);
    mailStore.init(data);

    const connection = db.saveCalendarConnection({
      provider: 'google',
      credentialKey: 'google:qualification',
      oauthClientId: clientId,
      email: 'qualification@example.test',
      displayName: 'Google qualification',
    });
    const remote = db.saveCalendarRemoteCalendar({
      connectionId: connection.id,
      remoteId: 'primary',
      name: 'Qualification',
      timeZone: 'Europe/Paris',
      color: '#4F8BD6',
      accessRole: 'owner',
      primary: true,
      selected: true,
    });
    db.updateCalendarRemoteCalendarSync(remote.id, {
      syncToken: 'qualification-sync-token',
      lastSyncAt: 123456,
      lastStatus: 'ok',
      lastError: '',
    });
    const event = db.saveCalendarEvent({
      title: 'Qualification Google Calendar',
      startAt: Date.now() + 3600000,
      endAt: Date.now() + 7200000,
      color: '#4F8BD6',
    });
    db.setCalendarEventRemoteState(event.id, {
      remoteCalendarId: remote.id,
      remoteEventId: 'qualification-event-1',
      remoteEtag: '"qualification-etag-1"',
      remoteUpdatedAt: 654321,
    });

    const databasePath = path.join(data, 'index.db');
    assert(!containsSecret(databasePath, refreshToken));
    assert(!containsSecret(databasePath, accessToken));
    const columns = db.db.prepare('PRAGMA table_info(calendar_connections)').all().map(row => row.name);
    assert(!columns.includes('access_token'));
    assert(!columns.includes('refresh_token'));

    mailStore.close();
    db.close();
    db.init(data);
    mailStore.init(data);

    const persistedConnection = db.getCalendarConnection(connection.id);
    assert(persistedConnection);
    assert.strictEqual(persistedConnection.oauthClientId, clientId);
    assert.strictEqual(persistedConnection.credentialKey, 'google:qualification');
    const persistedRemote = db.getCalendarRemoteCalendar(remote.id);
    assert.strictEqual(persistedRemote.syncToken, 'qualification-sync-token');
    const persistedEvent = db.getCalendarEvent(event.id);
    assert.strictEqual(persistedEvent.remoteEventId, 'qualification-event-1');
    assert.strictEqual(persistedEvent.remoteEtag, '"qualification-etag-1"');

    // 4) La sauvegarde complète transporte la configuration/calendrier mais
    // annonce explicitement qu'elle n'embarque pas les identifiants système.
    const exported = await backup.exportArchive({
      dataDir: data,
      database: db.db,
      targetPath: archive,
      appVersion: '0.6.0-qualification',
      password: '',
    });
    assert.strictEqual(exported.manifest.includesCredentials, false);

    const inspection = await backup.inspectArchive(archive);
    assert.strictEqual(inspection.manifest.includesCredentials, false);
    const extracted = await backup.extractArchive(archive, extractedRoot);
    await backup.validateExtractedData(extracted.dataDir, {
      manifest: inspection.manifest,
      password: '',
    });

    for (const rel of ['index.db', 'accounts.json', 'config.json']) {
      const file = path.join(extracted.dataDir, rel);
      assert(!containsSecret(file, refreshToken), `${rel} contient un refresh token`);
      assert(!containsSecret(file, accessToken), `${rel} contient un access token`);
    }
    const manifestText = JSON.stringify(inspection.manifest);
    assert(!manifestText.includes(refreshToken));
    assert(!manifestText.includes(accessToken));

    const restoredDb = new Database(path.join(extracted.dataDir, 'index.db'), { readonly: true });
    try {
      const restoredConnection = restoredDb.prepare('SELECT * FROM calendar_connections WHERE id=?').get(connection.id);
      assert(restoredConnection);
      assert.strictEqual(restoredConnection.oauth_client_id, clientId);
      assert.strictEqual(restoredConnection.credential_key, 'google:qualification');
      const restoredCalendar = restoredDb.prepare('SELECT * FROM calendar_remote_calendars WHERE id=?').get(remote.id);
      assert.strictEqual(restoredCalendar.sync_token, 'qualification-sync-token');
      const restoredEvent = restoredDb.prepare('SELECT * FROM calendar_events WHERE id=?').get(event.id);
      assert.strictEqual(restoredEvent.remote_event_id, 'qualification-event-1');
      assert.strictEqual(restoredEvent.remote_etag, '"qualification-etag-1"');
    } finally {
      restoredDb.close();
    }

    // 5) Garde-fous de cycle de vie : verrouillage / changement de mot de passe
    // coupent les flux OAuth et purgent les access tokens mémoire.
    const backend = fs.readFileSync(path.join(__dirname, '../engine/backend.js'), 'utf8');
    assert(backend.includes('credentialStore.CALENDAR_OAUTH_SERVICE_SECRET,'));
    assert(backend.includes("stopGoogleCalendarSensitiveRuntime('LibraMail a été verrouillé')"));
    assert(backend.includes("stopGoogleCalendarSensitiveRuntime('Activation du mot de passe principal')"));
    assert(backend.includes("stopGoogleCalendarSensitiveRuntime('Modification du mot de passe principal')"));
    assert(backend.includes("stopGoogleCalendarSensitiveRuntime('Désactivation du mot de passe principal')"));
    assert(backend.includes('calendarGoogleMock.purgePersistedMockConnections(db)'));

    console.log('[LibraMail] Qualification cycle de vie Google Calendar 0.6.0 : OK');
  } finally {
    try { mailStore.close(); } catch {}
    try { db.close(); } catch {}
    try { masterPassword.lock(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
