'use strict';

// C4a: explicit read-only snapshot of an already selected DAV collection.
// No RPC, timer, credential persistence, remote write or automatic selection.
const { createCalDavClient, CalDavError } = require('./calendar_caldav');
const { parseMultiStatus } = require('./calendar_caldav_discovery');
const { parseIcs } = require('./calendar_import');
const { expandRule } = require('./calendar_caldav_recurrence');
const DAV = 'DAV:', CAL = 'urn:ietf:params:xml:ns:caldav';
const active = new WeakMap();
const fail = code => { throw new CalDavError(code); };
// Only fixed, non-personal reason codes may cross the diagnostics boundary.
// Recognized projection limitations may be skipped in a non-destructive pass;
// malformed structure or unverified transport still aborts the entire pass.
function unsupported(reason, skippable=false) {
  const error = new CalDavError('UNSUPPORTED_EVENT');
  error.eventReason = reason;
  error.skippable = skippable;
  throw error;
}
const apple = u => !u.port && /^(?:caldav|p[0-9]{1,4}-caldav)\.icloud\.com$/.test(u.hostname);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function url(value, base) {
  if (typeof value !== 'string' || !value || value.length > 2000 || /[\x00-\x20\x7f\\]/.test(value)) fail('INVALID_URL');
  let u;
  try { u = new URL(value, base); } catch { fail('INVALID_URL'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) fail('INVALID_URL');
  return u;
}
function collectionURL(identity, value) {
  const entry = url(identity.serverURL || (identity.provider === 'icloud' ? 'https://caldav.icloud.com/' : ''));
  const collection = url(value);
  if (identity.provider === 'icloud' ? !apple(entry) || !apple(collection) : collection.origin !== entry.origin) fail('CROSS_ORIGIN');
  if (!collection.pathname.endsWith('/')) fail('INVALID_COLLECTION');
  return collection;
}
// An iCloud REPORT may use the generic front end instead of the already
// authenticated partition host. Rebind only that exact alias to the original
// origin; never contact another host or loosen the collection boundary.
function reportURL(collection, value, provider) {
  const href = url(value, collection.href);
  if (href.origin !== collection.origin) {
    if (provider !== 'icloud' || !apple(collection) || !apple(href) ||
        (collection.hostname !== 'caldav.icloud.com' && href.hostname !== 'caldav.icloud.com')) fail('DAV_RESOURCE_ORIGIN');
    href.host = collection.host;
  }
  return href;
}
function isCollectionSelf(collection, href) {
  return href.origin === collection.origin && (href.pathname === collection.pathname || href.pathname + '/' === collection.pathname);
}
function resourceURL(collection, value) {
  const href = url(value, collection.href);
  if (href.origin !== collection.origin) fail('DAV_RESOURCE_ORIGIN');
  if (isCollectionSelf(collection, href)) fail('DAV_RESOURCE_SELF');
  if (!href.pathname.startsWith(collection.pathname)) fail('DAV_RESOURCE_OUTSIDE');
  if (href.pathname.slice(collection.pathname.length).includes('/')) fail('DAV_RESOURCE_NESTED');
  if (/%(?:2f|5c)/i.test(href.pathname)) fail('DAV_RESOURCE_ENCODING');
  return href;
}
function scalar(node) {
  if (!node || node.children.length) fail('INCOMPLETE_SNAPSHOT');
  return node.text;
}
function dateLine(line) {
  const m = /^(?:DTSTART|DTEND)(?:;(VALUE=DATE|TZID=(?:"[^"\r\n]+"|[^;:\r\n]+)))?:(\d{8})(?:T(\d{6})(Z)?)?$/i.exec(line);
  if (!m) unsupported('DATE_FORMAT',true);
  const [, parameter = '', date, clock, utc] = m;
  const allDay = !clock;
  if ((parameter.toUpperCase() === 'VALUE=DATE' && !allDay) || (parameter.toUpperCase().startsWith('TZID=') && (allDay || utc))) unsupported('DATE_PARAMETERS');
  const year = +date.slice(0,4), month = +date.slice(4,6), day = +date.slice(6,8);
  const h = +(clock || '000000').slice(0,2), min = +(clock || '000000').slice(2,4), sec = +(clock || '000000').slice(4,6);
  const d = new Date(Date.UTC(year,month-1,day,h,min,sec));
  if (year < 1970 || d.getUTCFullYear() !== year || d.getUTCMonth()+1 !== month || d.getUTCDate() !== day || h>23 || min>59 || sec>59) unsupported('INVALID_DATE');
  if (parameter.toUpperCase().startsWith('TZID=')) {
    const tz = parameter.slice(5).replace(/^"|"$/g,'');
    try { new Intl.DateTimeFormat('en',{timeZone:tz}); } catch { unsupported('TIMEZONE',true); }
  }
  return { allDay, date, clock, utc: Boolean(utc), parameter };
}
function project(ics, href, etag, now=Date.now()) {
  // The general import parser is permissive; never interpret its silently
  // dropped events as deletions. Only validated single events and explicitly supported
  // recurrence rules are projected. Unsupported resources prohibit full reconciliation.
  const lines = ics.replace(/\r\n?/g,'\n').replace(/\n[ \t]/g,'').trimEnd().split('\n');
  if (lines[0]?.toUpperCase() !== 'BEGIN:VCALENDAR' || lines.at(-1)?.toUpperCase() !== 'END:VCALENDAR') unsupported('STRUCTURE');
  const stack = [], event = [];
  let count = 0, roots = 0;
  for (const line of lines) {
    const begin = /^BEGIN:([A-Z0-9-]+)$/i.exec(line), end = /^END:([A-Z0-9-]+)$/i.exec(line);
    if (begin) {
      const type = begin[1].toUpperCase(), parent = stack.at(-1);
      if ((!parent && (type !== 'VCALENDAR' || ++roots !== 1)) || (parent === 'VCALENDAR' && !['VEVENT','VTIMEZONE'].includes(type)) ||
          (parent === 'VEVENT' && type !== 'VALARM') || (parent === 'VTIMEZONE' && !['STANDARD','DAYLIGHT'].includes(type)) ||
          (parent && !['VCALENDAR','VEVENT','VTIMEZONE'].includes(parent))) fail('UNSUPPORTED_EVENT');
      if (type === 'VEVENT' && ++count !== 1) unsupported('MULTIPLE_COMPONENTS',true);
      stack.push(type); continue;
    }
    if (end) { if (stack.pop() !== end[1].toUpperCase()) fail('UNSUPPORTED_EVENT'); continue; }
    if (!stack.length || !line.includes(':')) fail('UNSUPPORTED_EVENT');
    if (stack.at(-1) === 'VEVENT') event.push(line);
  }
  if (stack.length || count !== 1) unsupported('STRUCTURE');
  const props = new Map();
  for (const line of event) {
    const name = line.split(/[;:]/,1)[0].toUpperCase();
    if (!/^[A-Z0-9-]+$/.test(name)) fail('UNSUPPORTED_EVENT');
    const list = props.get(name) || []; list.push(line); props.set(name,list);
  }
  const single = name => { const list=props.get(name)||[]; if(list.length>1) fail('UNSUPPORTED_EVENT'); return list[0]; };
  for (const p of ['RECURRENCE-ID','RDATE','EXDATE','EXRULE','DURATION']) if (props.has(p)) unsupported(p.replace('-','_'),true);
  const uid = single('UID');
  if (!uid || !/^UID:[^\s].{0,1023}$/i.test(uid)) unsupported('UID');
  const start = single('DTSTART'), end = single('DTEND');
  if (!start) unsupported('MISSING_START');
  const a = dateLine(start);
  if (end) {
    const b=dateLine(end);
    if(a.allDay!==b.allDay || a.utc!==b.utc || a.parameter.toUpperCase()!==b.parameter.toUpperCase() ||
       a.date+(a.clock||'') >= b.date+(b.clock||'')) unsupported('DATE_RANGE',true);
  } else if (a.allDay) {
    const d=new Date(Date.UTC(+a.date.slice(0,4),+a.date.slice(4,6)-1,+a.date.slice(6,8)+1));
    event.push('DTEND;VALUE=DATE:'+d.toISOString().slice(0,10).replace(/-/g,''));
  } else unsupported('MISSING_END',true);
  for (const p of ['SUMMARY','DESCRIPTION','LOCATION','STATUS']) single(p);
  const status = single('STATUS');
  if(status && !/^STATUS:(?:CONFIRMED|TENTATIVE|CANCELLED)$/i.test(status)) fail('UNSUPPORTED_EVENT');
  const rule=single('RRULE');
  if(status?.toUpperCase()==='STATUS:CANCELLED' && !rule) return {uid:uid.slice(4),items:[]};
  const projectedLines=event.filter(line=>line!==rule&&!(line===status&&status?.toUpperCase()==='STATUS:CANCELLED'));
  const parsed=parseIcs(['BEGIN:VCALENDAR','BEGIN:VEVENT',...projectedLines,'END:VEVENT','END:VCALENDAR'].join('\r\n'));
  if(parsed.truncated || parsed.events.length!==1) unsupported('PROJECTION');
  const e=parsed.events[0];
  const endLine=projectedLines.find(l=>/^DTEND[;:]/i.test(l));
  function matches(epoch,line){
    const spec=dateLine(line), tz=spec.parameter.toUpperCase().startsWith('TZID=')?spec.parameter.slice(5).replace(/^"|"$/g,''):spec.utc?'UTC':undefined;
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(epoch).map(p=>[p.type,p.value]));
    return parts.year+parts.month+parts.day===spec.date && (spec.allDay||parts.hour+parts.minute+parts.second===spec.clock);
  }
  if(!Number.isSafeInteger(e.startAt)||!Number.isSafeInteger(e.endAt)||e.startAt<=0||e.endAt<=e.startAt||!e.title.trim()||!matches(e.startAt,start)||!matches(e.endAt,endLine)) unsupported('PROJECTION');
  const duration=e.endAt-e.startAt;
  const instances=rule?expandRule(rule,a,e.startAt,duration,{dateLine,unsupported,now}):[{at:e.startAt}];
  if(status?.toUpperCase()==='STATUS:CANCELLED') return {uid:uid.slice(4),items:[]};
  const dayEpoch=spec=>Date.UTC(+spec.date.slice(0,4),+spec.date.slice(4,6)-1,+spec.date.slice(6,8));
  const days=a.allDay?(dayEpoch(dateLine(endLine))-dayEpoch(a))/86400000:0;
  const items=[];
  for(const instance of instances){
    const startAt=instance.at;
    let endAt=startAt+duration;
    // All-day events retain their nominal calendar-day duration across DST.
    if(rule&&a.allDay){
      const endDate=new Date(startAt);endDate.setDate(endDate.getDate()+days);
      endAt=endDate.getTime();
    }
    if(!Number.isSafeInteger(startAt)||!Number.isSafeInteger(endAt)||startAt<=0||endAt<=startAt) unsupported('PROJECTION');
    const id=rule?href+'#'+startAt:href;
    if(id.length>2000) fail('INVALID_URL');
    items.push({remoteEventId:id,remoteEtag:etag,remoteUpdatedAt:0,title:e.title,startAt,endAt,allDay:e.allDay,location:e.location,notes:e.notes});
  }
  return {uid:uid.slice(4),items};
}
// An anomalous REPORT containing only the collection's own row is not
// enough to conclude that all cached events were removed. Check Depth:1
// PROPFIND and require exactly the calendar collection with no children.
async function verifyEmptyCollection(collection, client, provider) {
  const response = await client.inventory(collection.href);
  const rows = parseMultiStatus(response.text,{completeSnapshot:true});
  if (rows.length !== 1) fail('DAV_EMPTY_UNVERIFIED');
  const row = rows[0], href = reportURL(collection,row.href,provider);
  const type = row.properties.get(DAV+'\0resourcetype');
  if (!isCollectionSelf(collection,href) || (row.status !== null && (row.status < 200 || row.status >= 300)) ||
      !type?.children.some(n=>n.uri===DAV && n.local==='collection') ||
      !type.children.some(n=>n.uri===CAL && n.local==='calendar')) fail('DAV_EMPTY_UNVERIFIED');
}
async function parseSnapshot(text, collection, client, provider) {
  const items=[], resources=new Set(), ids=new Set(), uids=new Set(), reasons=new Set();
  let unsupportedCount=0;
  let directReads=0, directBytes=0, sawSelf=false;
  const directStart=performance.now(), reference=Date.now();
  for (const row of parseMultiStatus(text,{completeSnapshot:true})) {
    if(row.status!==null && (row.status<200||row.status>=300)) fail('INCOMPLETE_SNAPSHOT');
    const tagKey=DAV+'\0getetag', dataKey=CAL+'\0calendar-data';
    const resolved=reportURL(collection,row.href,provider);
    if(isCollectionSelf(collection,resolved)) {
      // iCloud includes its collection URL among event URLs. Ignore only a
      // metadata row with no successful calendar-data and explicit evidence
      // of the absent property (or a DAV collection type).
      const type=row.properties.get(DAV+'\0resourcetype');
      if(provider!=='icloud'||sawSelf||row.properties.has(dataKey)||
         !(row.failedProperties.has(dataKey)||type?.children.some(n=>n.uri===DAV&&n.local==='collection'))) fail('DAV_RESOURCE_SELF');
      sawSelf=true;
      continue;
    }
    const href=resourceURL(collection,resolved.href);
    if(resources.has(href.href)) fail('INCOMPLETE_SNAPSHOT');
    resources.add(href.href);
    if(row.failedProperties.has(tagKey)) fail('DAV_ETAG_NOT_FOUND');
    const etag=scalar(row.properties.get(tagKey)).trim();
    if(!/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)||etag.length>2000) fail('INCOMPLETE_SNAPSHOT');
    let data;
    if(row.failedProperties.has(dataKey)) {
      // Some servers omit calendar-data in a REPORT but serve the resource
      // directly. Require the same strong ETag and bound the extra work.
      if(++directReads>64 || performance.now()-directStart>30000) fail('DAV_DIRECT_READ_LIMIT');
      let result;
      try { result=await client.get(href.href,etag); }
      catch(error) { if(error instanceof CalDavError && error.code==='CONFLICT') fail('DAV_RESOURCE_CHANGED'); throw error; }
      if(result.etag!==etag) fail('DAV_RESOURCE_CHANGED');
      data=result.text;
      directBytes+=Buffer.byteLength(data);
      if(directBytes>8*1024*1024 || performance.now()-directStart>30000) fail('DAV_DIRECT_READ_LIMIT');
    } else data=scalar(row.properties.get(dataKey));
    if(performance.now()-directStart>30000) fail('SNAPSHOT_LIMIT');
    let projection;
    try { projection=project(data,href.href,etag,reference); }
    catch (error) {
      if (!(error instanceof CalDavError) || error.code!=='UNSUPPORTED_EVENT' || !error.skippable) throw error;
      unsupportedCount++;
      reasons.add(error.eventReason);
      continue;
    }
    if(uids.has(projection.uid)) fail('INCOMPLETE_SNAPSHOT');
    uids.add(projection.uid);
    for(const item of projection.items){
      if(ids.has(item.remoteEventId)||items.length>=10000) fail('SNAPSHOT_LIMIT');
      ids.add(item.remoteEventId); items.push(item);
    }
  }
  if(sawSelf && resources.size===0) await verifyEmptyCollection(collection,client,provider);
  return {items,unsupportedCount,reason:[...reasons].sort()[0] || ''};
}
function createCalDavSyncEngine({db, readPassword, isLocked, fetchImpl, now=Date.now}={}) {
  if(!db || typeof db.syncCalendarRemoteEvents!=='function') fail('INVALID_OPTIONS');
  readPassword ||= (...args)=>require('./calendar_caldav_credentials').readPassword(...args);
  isLocked ||= ()=>require('./master_password').isLocked();
  if(!active.has(db)) active.set(db,new Set());
  const pending=active.get(db);
  function state(id,identity){
    if(isLocked()) fail('CREDENTIALS_LOCKED');
    const calendar=db.getCalendarRemoteCalendar(id);
    const connection=calendar&&db.getCalendarConnection(calendar.connectionId);
    if(!calendar?.selected||!connection?.enabled||!['caldav','icloud'].includes(connection.provider)||
       connection.provider!==identity?.provider||connection.email!==identity.username||!uuid.test(connection.credentialKey)) fail('INVALID_CONNECTION');
    const collection=collectionURL(identity,calendar.remoteId);
    return {calendar,connection,collection};
  }
  async function syncRemoteCalendar(id, identity){
    id=Number(id);
    if(!Number.isSafeInteger(id)||id<=0||pending.has(id)) fail('SYNC_BUSY');
    const initial=state(id,identity);
    const config={provider:identity.provider,serverURL:identity.serverURL,username:identity.username};
    const signature=s=>JSON.stringify([s.calendar.id,s.calendar.connectionId,s.calendar.remoteId,s.calendar.selected,s.connection.id,s.connection.provider,s.connection.email,s.connection.credentialKey,s.connection.enabled]);
    pending.add(id);
    try {
      const password=readPassword(initial.connection.credentialKey,config);
      if(!password) fail('CREDENTIALS_REQUIRED');
      const client=createCalDavClient({serverURL:initial.collection.href,username:config.username,password,fetchImpl});
      const response=await client.events(initial.collection.href);
      const {items,unsupportedCount,reason}=await parseSnapshot(response.text,initial.collection,client,config.provider);
      const latest=state(id,config);
      if(signature(initial)!==signature(latest)||readPassword(latest.connection.credentialKey,config)!==password) fail('SYNC_STATE_CHANGED');
      // The existing SQLite adapter applies a complete snapshot transactionally
      // and scopes all deletes to this remote calendar, never a local/ICS row.
      if(unsupportedCount){
        const code='UNSUPPORTED_EVENT_'+reason;
        // A partial projection is never a deletion authority. In particular,
        // keep all previously cached occurrences of unrecognized resources.
        if(!items.length) fail(code);
        const result=db.syncCalendarRemoteEvents(id,items,{fullSync:false});
        const calendar=db.updateCalendarRemoteCalendarSync(id,{lastStatus:'error',lastError:code});
        return {calendar,...result,partial:true,unsupportedCount,error:code};
      }
      const result=db.syncCalendarRemoteEvents(id,items,{fullSync:true});
      const calendar=db.updateCalendarRemoteCalendarSync(id,{lastSyncAt:now(),lastStatus:'ok',lastError:'',syncToken:''});
      return {calendar,...result};
    } catch(error){
      const known=error instanceof CalDavError && /^[A-Z_]{1,80}$/.test(error.code)
        ? (error.code === 'INVALID_DAV_XML' && /^[A-Z_]{1,40}$/.test(error.xmlReason || '') ? 'INVALID_DAV_XML_' + error.xmlReason
          : error.code === 'UNSUPPORTED_EVENT' && /^[A-Z_]{1,40}$/.test(error.eventReason || '') ? 'UNSUPPORTED_EVENT_' + error.eventReason : error.code)
        : 'SYNC_FAILED';
      // Retain the timestamp of the last successful snapshot. No raw error,
      // URL, credential or server response is exposed in diagnostics.
      try { if(signature(initial)===signature(state(id,config))) db.updateCalendarRemoteCalendarSync(id,{lastStatus:'error',lastError:known}); } catch {}
      throw new CalDavError(known);
    } finally {pending.delete(id);}
  }
  return Object.freeze({syncRemoteCalendar});
}
module.exports={createCalDavSyncEngine,collectionURL,resourceURL,project};
