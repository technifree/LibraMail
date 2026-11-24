'use strict';
const { randomUUID } = require('node:crypto');
const { CalDavError } = require('./calendar_caldav');
const { discoverCalDav } = require('./calendar_caldav_discovery');
const { createCalDavSyncEngine } = require('./calendar_caldav_sync');
const { writeCalDavEvent } = require('./calendar_caldav_write');
const providers = new Set(['caldav', 'icloud']);
const fail = code => { throw new CalDavError(code); };
const safeCode = e => e instanceof CalDavError && /^[A-Z_]{1,80}$/.test(e.code) ? e.code : 'OPERATION_FAILED';
const isCalDav = c => providers.has(c?.provider);
function minutes(value = 15) {
  if (!Number.isInteger(value) || value < 5 || value > 1440) fail('INVALID_INTERVAL');
  return value;
}
function identity(input = {}) {
  const { provider = 'caldav', username } = input;
  const serverURL = input.serverURL || (provider === 'icloud' ? 'https://caldav.icloud.com/' : '');
  if (!providers.has(provider) || typeof username !== 'string' || !username || username.trim() !== username || username.length > 320 || /[:\x00-\x1f\x7f]/.test(username)) fail('INVALID_CREDENTIALS');
  if (typeof serverURL !== 'string' || !serverURL || serverURL.length > 2000 || /[\x00-\x20\x7f\\]/.test(serverURL)) fail('INVALID_URL');
  let u;
  try { u = new URL(serverURL); } catch { fail('INVALID_URL'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (provider === 'icloud' && (u.port || !/^(?:caldav|p[0-9]{1,4}-caldav)\.icloud\.com$/.test(u.hostname)))) fail('INVALID_URL');
  return { provider, username, serverURL: u.href };
}
function password(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 512 || /[\x00-\x1f\x7f]/.test(value)) fail('INVALID_CREDENTIALS');
  return value;
}
function createCalDavRuntime({ db, credentials, available, fetchImpl = globalThis.fetch, now = Date.now, onChange = () => {}, discover = discoverCalDav, createEngine = createCalDavSyncEngine }) {
  let active = null;
  const attempted = new Map();
  const busy = () => active !== null;
  function ready() { if (!available()) fail('RUNTIME_UNAVAILABLE'); }
  function idle() { ready(); if (busy()) fail('SYNC_BUSY'); }
  function notify(data) { try { onChange(data); } catch {} }
  function row(id) {
    const c = db.getCalendarConnection(Number(id));
    if (!isCalDav(c)) fail('INVALID_CONNECTION');
    return c;
  }
  function fromRow(c) { return identity({ provider:c.provider, username:c.email, serverURL:c.caldavServerURL }); }
  async function run(task) {
    idle();
    const controller = new AbortController(); active = controller;
    const cancelled = () => controller.signal.aborted || !available();
    const check = () => { if (cancelled()) fail('RUNTIME_UNAVAILABLE'); };
    const fetch = (url, options = {}) => {
      check();
      return fetchImpl(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
    };
    try { return await task({ check, fetch, cancelled }); }
    catch (e) { throw new CalDavError(safeCode(e)); }
    finally { active = null; }
  }
  async function discoverWith(input, ctx) {
    const config = identity(input);
    const calendars = await discover({ ...config, password: password(input.password), fetchImpl: ctx.fetch });
    ctx.check();
    return { config, calendars };
  }
  const preview = input => run(async ctx => (await discoverWith(input, ctx)).calendars);
  const add = input => run(async ctx => {
    const interval = minutes(input.refreshMinutes);
    if (!Array.isArray(input.selectedURLs) || !input.selectedURLs.length || input.selectedURLs.length > 250 || new Set(input.selectedURLs).size !== input.selectedURLs.length) fail('INVALID_SELECTION');
    const { config, calendars } = await discoverWith(input, ctx);
    if (input.selectedURLs.some(url => !calendars.some(c => c.url === url))) fail('INVALID_SELECTION');
    if (db.listCalendarConnections().some(c => isCalDav(c) && c.provider === config.provider && c.email === config.username && c.caldavServerURL === config.serverURL)) fail('DUPLICATE_CONNECTION');
    const key = randomUUID();
    credentials.putPassword(key, config, password(input.password));
    let connection;
    try {
      connection = db.db.transaction(() => {
        const c = db.saveCalendarConnection({ provider:config.provider, credentialKey:key, email:config.username, displayName:String(input.displayName || (config.provider === 'icloud' ? 'iCloud' : 'CalDAV')).slice(0,240), caldavServerURL:config.serverURL, caldavRefreshMinutes:interval, enabled:true });
        for (const calendar of calendars) db.saveCalendarRemoteCalendar({ connectionId:c.id, remoteId:calendar.url, name:calendar.name, selected:input.selectedURLs.includes(calendar.url), accessRole:calendar.readOnly ? 'caldav-readOnly' : 'caldav-readWrite' });
        return c;
      })();
    } catch (e) {
      try { credentials.removePassword(key); } catch { fail('CREDENTIAL_ROLLBACK_FAILED'); }
      throw e;
    }
    notify({ action:'caldav-added', connectionId:connection.id });
    return { connection, calendars:db.listCalendarRemoteCalendars({ connectionId:connection.id }) };
  });
  async function syncOne(id, ctx, dueOnly = false) {
    ctx.check();
    const c = row(id);
    if (!c.enabled) fail('INVALID_CONNECTION');
    const config = fromRow(c);
    const selected = db.listCalendarRemoteCalendars({ connectionId:c.id, selectedOnly:true });
    const lastAttempt = attempted.get(c.credentialKey);
    if (dueOnly && lastAttempt !== undefined && now() - lastAttempt < minutes(c.caldavRefreshMinutes)*60000) return null;
    if (dueOnly && lastAttempt === undefined && c.lastSyncAt && now() - c.lastSyncAt < minutes(c.caldavRefreshMinutes)*60000 && selected.every(cal => cal.lastSyncAt && cal.lastStatus === 'ok')) return null;
    attempted.set(c.credentialKey, now());
    const engine = createEngine({ db, readPassword:credentials.readPassword, isLocked:ctx.cancelled, fetchImpl:ctx.fetch, now });
    const totals = { id:c.id, synced:0, failed:0, created:0, updated:0, removed:0 };
    for (const cal of selected) {
      ctx.check();
      try {
        const r = await engine.syncRemoteCalendar(cal.id, config);
        ctx.check();
        totals.synced++;
        for (const k of ['created','updated','removed']) totals[k] += Number(r[k]) || 0;
      } catch(e) {
        ctx.check(); totals.failed++; totals.error = safeCode(e);
      }
    }
    ctx.check();
    db.updateCalendarConnectionSync(c.id, { lastStatus:totals.failed ? 'error' : 'ok', lastError:totals.error || '', ...(totals.failed ? {} : { lastSyncAt:now() }) });
    notify({action:'caldav-synced', connectionId:c.id, ...totals});
    return totals;
  }
  const sync = id => run(ctx => syncOne(id, ctx));
  const syncAll = ({dueOnly=false} = {}) => run(async ctx => {
    const results = [];
    for (const c of db.listCalendarConnections({enabledOnly:true}).filter(isCalDav)) {
      ctx.check();
      try { const result = await syncOne(c.id, ctx, dueOnly); if (result) results.push(result); }
      catch(e) { ctx.check(); results.push({id:c.id, error:safeCode(e)}); }
    }
    return results;
  });
  function configure({id, refreshMinutes, enabled} = {}) {
    idle(); const c = row(id);
    if (enabled !== undefined && typeof enabled !== 'boolean') fail('INVALID_OPTIONS');
    const next = db.saveCalendarConnection({...c, caldavRefreshMinutes:minutes(refreshMinutes ?? c.caldavRefreshMinutes), enabled:enabled ?? c.enabled}, c.id);
    attempted.delete(c.credentialKey); notify({action:'caldav-configured', connectionId:c.id}); return next;
  }
  function select(id, selected) {
    idle(); const cal = db.getCalendarRemoteCalendar(Number(id)); const c = row(cal?.connectionId);
    if (typeof selected !== 'boolean') fail('INVALID_SELECTION');
    const result = db.setCalendarRemoteCalendarSelected(cal.id, selected);
    if (selected) db.updateCalendarRemoteCalendarSync(cal.id, {lastSyncAt:0});
    attempted.delete(c.credentialKey); notify({action:'caldav-selection', connectionId:c.id}); return result;
  }
  function remove(id) {
    idle(); const c = row(id);
    // Remove the secret before the cache: a failing DB deletion is recoverable
    // by reconfiguration, and never leaves an unreferenced secret silently.
    try { credentials.removePassword(c.credentialKey); } catch(e) { fail(safeCode(e)); }
    const result = db.removeCalendarConnection(c.id);
    attempted.delete(c.credentialKey); notify({action:'caldav-removed', connectionId:c.id});
    return {...result, credentialRemoved:true};
  }
  function replacePassword({id, password:secret} = {}) {
    return run(async ctx => {
      const c = row(id), config = fromRow(c);
      await discoverWith({...config, password:secret},ctx);
      credentials.putPassword(c.credentialKey,config,password(secret));
      attempted.delete(c.credentialKey);
      return {updated:true};
    });
  }
  function write(action, input = {}) {
    return run(async ctx => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_OPTIONS');
      const id = Number(input.remoteCalendarId);
      if (!Number.isSafeInteger(id) || id <= 0) fail('INVALID_SELECTION');
      const calendar = db.getCalendarRemoteCalendar(id);
      const c = row(calendar?.connectionId);
      if (!c.enabled || !calendar.selected) fail('INVALID_CONNECTION');
      if (calendar.accessRole !== 'caldav-readWrite') fail('READ_ONLY');
      const config = fromRow(c);
      const secret = credentials.readPassword(c.credentialKey, config);
      if (!secret) fail('CREDENTIALS_REQUIRED');
      try {
        const result = await writeCalDavEvent({db, calendar, connection:c, identity:config, password:secret, check:ctx.check, fetchImpl:ctx.fetch, now}, action, input);
        notify({action:'caldav-event-'+action, connectionId:c.id, remoteCalendarId:id, id:result.event?.id || result.id, removed:Boolean(result.removed)});
        return result;
      } catch (e) {
        // A failed or conflicting write may have reached the server. Never
        // repeat the mutation automatically; allow the next pull to reconcile.
        if (!ctx.cancelled() && ['CONFLICT','WRITE_UNCERTAIN'].includes(e.code)) {
          attempted.delete(c.credentialKey);
          try { db.updateCalendarRemoteCalendarSync(id,{lastStatus:'error',lastError:e.code}); } catch {}
          notify({action:'caldav-write-error',connectionId:c.id,remoteCalendarId:id,error:e.code});
        }
        throw e;
      }
    });
  }
  function stop() { active?.abort(); attempted.clear(); }
  return Object.freeze({busy, stop, preview, add, sync, syncAll, configure, select, remove, replacePassword, write});
}
module.exports = { createCalDavRuntime, isCalDav };
