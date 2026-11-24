'use strict';

// C4a: explicit read-only snapshot of an already selected DAV collection.
// No RPC, timer, credential persistence, remote write or automatic selection.
const { createCalDavClient, CalDavError } = require('./calendar_caldav');
const { parseMultiStatus } = require('./calendar_caldav_discovery');
const { parseIcs } = require('./calendar_import');
const DAV = 'DAV:', CAL = 'urn:ietf:params:xml:ns:caldav';
const active = new WeakMap();
const fail = code => { throw new CalDavError(code); };
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
function scalar(node) {
  if (!node || node.children.length) fail('INCOMPLETE_SNAPSHOT');
  return node.text;
}
function dateLine(line) {
  const m = /^(?:DTSTART|DTEND)(?:;(VALUE=DATE|TZID=(?:"[^"\r\n]+"|[^;:\r\n]+)))?:(\d{8})(?:T(\d{6})(Z)?)?$/i.exec(line);
  if (!m) fail('UNSUPPORTED_EVENT');
  const [, parameter = '', date, clock, utc] = m;
  const allDay = !clock;
  if ((parameter.toUpperCase() === 'VALUE=DATE' && !allDay) || (parameter.toUpperCase().startsWith('TZID=') && (allDay || utc))) fail('UNSUPPORTED_EVENT');
  const year = +date.slice(0,4), month = +date.slice(4,6), day = +date.slice(6,8);
  const h = +(clock || '000000').slice(0,2), min = +(clock || '000000').slice(2,4), sec = +(clock || '000000').slice(4,6);
  const d = new Date(Date.UTC(year,month-1,day,h,min,sec));
  if (year < 1970 || d.getUTCFullYear() !== year || d.getUTCMonth()+1 !== month || d.getUTCDate() !== day || h>23 || min>59 || sec>59) fail('UNSUPPORTED_EVENT');
  if (parameter.toUpperCase().startsWith('TZID=')) {
    const tz = parameter.slice(5).replace(/^"|"$/g,'');
    try { new Intl.DateTimeFormat('en',{timeZone:tz}); } catch { fail('UNSUPPORTED_EVENT'); }
  }
  return { allDay, date, clock, utc: Boolean(utc), parameter };
}
function project(ics, href, etag) {
  // The general import parser is permissive; never interpret its silently
  // dropped events as deletions. C4a supports single events and bounded simple
  // DAILY/WEEKLY COUNT series. Unsupported resources abort the full snapshot.
  const lines = ics.replace(/\r\n?/g,'\n').replace(/\n[ \t]/g,'').trimEnd().split('\n');
  if (lines[0]?.toUpperCase() !== 'BEGIN:VCALENDAR' || lines.at(-1)?.toUpperCase() !== 'END:VCALENDAR') fail('UNSUPPORTED_EVENT');
  const stack = [], event = [];
  let count = 0, roots = 0;
  for (const line of lines) {
    const begin = /^BEGIN:([A-Z0-9-]+)$/i.exec(line), end = /^END:([A-Z0-9-]+)$/i.exec(line);
    if (begin) {
      const type = begin[1].toUpperCase(), parent = stack.at(-1);
      if ((!parent && (type !== 'VCALENDAR' || ++roots !== 1)) || (parent === 'VCALENDAR' && !['VEVENT','VTIMEZONE'].includes(type)) ||
          (parent === 'VEVENT' && type !== 'VALARM') || (parent === 'VTIMEZONE' && !['STANDARD','DAYLIGHT'].includes(type)) ||
          (parent && !['VCALENDAR','VEVENT','VTIMEZONE'].includes(parent))) fail('UNSUPPORTED_EVENT');
      if (type === 'VEVENT' && ++count !== 1) fail('UNSUPPORTED_EVENT');
      stack.push(type); continue;
    }
    if (end) { if (stack.pop() !== end[1].toUpperCase()) fail('UNSUPPORTED_EVENT'); continue; }
    if (!stack.length || !line.includes(':')) fail('UNSUPPORTED_EVENT');
    if (stack.at(-1) === 'VEVENT') event.push(line);
  }
  if (stack.length || count !== 1) fail('UNSUPPORTED_EVENT');
  const props = new Map();
  for (const line of event) {
    const name = line.split(/[;:]/,1)[0].toUpperCase();
    if (!/^[A-Z0-9-]+$/.test(name)) fail('UNSUPPORTED_EVENT');
    const list = props.get(name) || []; list.push(line); props.set(name,list);
  }
  const single = name => { const list=props.get(name)||[]; if(list.length>1) fail('UNSUPPORTED_EVENT'); return list[0]; };
  for (const p of ['RECURRENCE-ID','RDATE','EXDATE','EXRULE','DURATION']) if (props.has(p)) fail('UNSUPPORTED_EVENT');
  const uid = single('UID');
  if (!uid || !/^UID:[^\s].{0,1023}$/i.test(uid)) fail('UNSUPPORTED_EVENT');
  const start = single('DTSTART'), end = single('DTEND');
  if (!start) fail('UNSUPPORTED_EVENT');
  const a = dateLine(start);
  if (end) {
    const b=dateLine(end);
    if(a.allDay!==b.allDay || a.utc!==b.utc || a.parameter.toUpperCase()!==b.parameter.toUpperCase() ||
       a.date+(a.clock||'') >= b.date+(b.clock||'')) fail('UNSUPPORTED_EVENT');
  } else if (a.allDay) {
    const d=new Date(Date.UTC(+a.date.slice(0,4),+a.date.slice(4,6)-1,+a.date.slice(6,8)+1));
    event.push('DTEND;VALUE=DATE:'+d.toISOString().slice(0,10).replace(/-/g,''));
  } else fail('UNSUPPORTED_EVENT');
  for (const p of ['SUMMARY','DESCRIPTION','LOCATION','STATUS']) single(p);
  const status = single('STATUS');
  if(status && !/^STATUS:(?:CONFIRMED|TENTATIVE|CANCELLED)$/i.test(status)) fail('UNSUPPORTED_EVENT');
  const rule=single('RRULE');
  let expected=1, stride=1;
  if(rule){
    const m=/^RRULE:FREQ=(DAILY|WEEKLY);COUNT=([1-9]\d{0,2})(?:;INTERVAL=([1-9]\d?))?$/i.exec(rule);
    if(!m || +m[2]>366 || +(m[3]||1)>12) fail('UNSUPPORTED_EVENT');
    expected=+m[2]; stride=(m[1].toUpperCase()==='WEEKLY'?7:1)*+(m[3]||1);
  }
  if(status?.toUpperCase()==='STATUS:CANCELLED') return {uid:uid.slice(4),items:[]};
  // Expand this narrow recurrence subset ourselves, shifting wall dates rather
  // than adding 24h in epoch time. The existing parser handles each occurrence.
  function shifted(line,days){
    const spec=dateLine(line);
    const d=new Date(Date.UTC(+spec.date.slice(0,4),+spec.date.slice(4,6)-1,+spec.date.slice(6,8)+days));
    const date=d.toISOString().slice(0,10).replace(/-/g,'');
    return line.replace(/:\d{8}/,':'+date);
  }
  function matches(epoch,line){
    const spec=dateLine(line), tz=spec.parameter.toUpperCase().startsWith('TZID=')?spec.parameter.slice(5).replace(/^"|"$/g,''):spec.utc?'UTC':undefined;
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(epoch).map(p=>[p.type,p.value]));
    return parts.year+parts.month+parts.day===spec.date && (spec.allDay||parts.hour+parts.minute+parts.second===spec.clock);
  }
  const items=[];
  for(let n=0;n<expected;n++){
    const lines=event.filter(line=>line!==rule).map(line=>/^(?:DTSTART|DTEND)[;:]/i.test(line)?shifted(line,n*stride):line);
    const parsed=parseIcs(['BEGIN:VCALENDAR','BEGIN:VEVENT',...lines,'END:VEVENT','END:VCALENDAR'].join('\r\n'));
    if(parsed.truncated || parsed.events.length!==1) fail('UNSUPPORTED_EVENT');
    const e=parsed.events[0];
    if(!Number.isSafeInteger(e.startAt)||!Number.isSafeInteger(e.endAt)||e.startAt<=0||e.endAt<=e.startAt||!e.title.trim()||
       !matches(e.startAt,lines.find(l=>/^DTSTART[;:]/i.test(l)))||!matches(e.endAt,lines.find(l=>/^DTEND[;:]/i.test(l)))) fail('UNSUPPORTED_EVENT');
    const id=rule?href+'#'+e.startAt:href;
    if(id.length>2000) fail('INVALID_URL');
    items.push({remoteEventId:id,remoteEtag:etag,remoteUpdatedAt:0,title:e.title,startAt:e.startAt,endAt:e.endAt,allDay:e.allDay,location:e.location,notes:e.notes});
  }
  return {uid:uid.slice(4),items};
}
function parseSnapshot(text, collection) {
  const items=[], resources=new Set(), ids=new Set(), uids=new Set();
  for (const row of parseMultiStatus(text,{completeSnapshot:true})) {
    if(row.status!==null && (row.status<200||row.status>=300)) fail('INCOMPLETE_SNAPSHOT');
    const href=url(row.href,collection.href);
    if(href.origin!==collection.origin || !href.pathname.startsWith(collection.pathname) || href.pathname===collection.pathname ||
       href.pathname.slice(collection.pathname.length).includes('/') || /%2f|%5c/i.test(href.pathname)) fail('INVALID_RESOURCE');
    if(resources.has(href.href)) fail('INCOMPLETE_SNAPSHOT');
    resources.add(href.href);
    const etag=scalar(row.properties.get(DAV+'\0getetag')).trim();
    if(!/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)||etag.length>2000) fail('INCOMPLETE_SNAPSHOT');
    const data=scalar(row.properties.get(CAL+'\0calendar-data'));
    const projection=project(data,href.href,etag);
    if(uids.has(projection.uid)) fail('INCOMPLETE_SNAPSHOT');
    uids.add(projection.uid);
    for(const item of projection.items){
      if(ids.has(item.remoteEventId)||items.length>=10000) fail('SNAPSHOT_LIMIT');
      ids.add(item.remoteEventId); items.push(item);
    }
  }
  return items;
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
      const items=parseSnapshot(response.text,initial.collection);
      const latest=state(id,config);
      if(signature(initial)!==signature(latest)||readPassword(latest.connection.credentialKey,config)!==password) fail('SYNC_STATE_CHANGED');
      // The existing SQLite adapter applies a complete snapshot transactionally
      // and scopes all deletes to this remote calendar, never a local/ICS row.
      const result=db.syncCalendarRemoteEvents(id,items,{fullSync:true});
      const calendar=db.updateCalendarRemoteCalendarSync(id,{lastSyncAt:now(),lastStatus:'ok',lastError:'',syncToken:''});
      return {calendar,...result};
    } catch(error){
      const known=error instanceof CalDavError && /^[A-Z_]{1,80}$/.test(error.code)?error.code:'SYNC_FAILED';
      // Retain the timestamp of the last successful snapshot. No raw error,
      // URL, credential or server response is exposed in diagnostics.
      try { if(signature(initial)===signature(state(id,config))) db.updateCalendarRemoteCalendarSync(id,{lastStatus:'error',lastError:known}); } catch {}
      throw new CalDavError(known);
    } finally {pending.delete(id);}
  }
  return Object.freeze({syncRemoteCalendar});
}
module.exports={createCalDavSyncEngine};
