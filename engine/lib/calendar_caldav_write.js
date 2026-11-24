'use strict';
// C5a: conditional mutations of simple VEVENT resources. Called only inside
// the CalDAV runtime's exclusive operation / abort boundary. No offline queue.
const { createCalDavClient, CalDavError } = require('./calendar_caldav');
const { collectionURL, resourceURL, project } = require('./calendar_caldav_sync');
const fail = code => { throw new CalDavError(code); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function etag(value) {
  if (typeof value !== 'string' || value.length > 2000 || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value)) fail('ETAG_REQUIRED');
  return value;
}
function text(value, max, required = false) {
  if (typeof value !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]/u.test(value)) fail('INVALID_EVENT');
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (normalized.length > max || (required && !normalized)) fail('INVALID_EVENT');
  return normalized;
}
function eventFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['title','startAt','endAt','allDay','location','notes'].includes(k))) fail('INVALID_EVENT');
  const {startAt,endAt,allDay} = input;
  if (typeof allDay !== 'boolean' || ![startAt,endAt].every(n => Number.isSafeInteger(n) && n > 0 && n < Date.UTC(9999,0,1) && n % 1000 === 0) || endAt <= startAt) fail('INVALID_EVENT');
  if (allDay && [startAt,endAt].some(n => {const d=new Date(n);return d.getHours()||d.getMinutes()||d.getSeconds()||d.getMilliseconds();})) fail('INVALID_EVENT');
  return {title:text(input.title,240,true),startAt,endAt,allDay,location:text(input.location ?? '',500),notes:text(input.notes ?? '',20000)};
}
const escape = s => s.replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
const utc = n => new Date(n).toISOString().slice(0,19).replace(/[-:]/g,'')+'Z';
const pad = n => String(n).padStart(2,'0');
function dateProperty(name,n,allDay,original) {
  const d=new Date(n);
  if (allDay) return `${name};VALUE=DATE:${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
  // Preserve TZID or floating semantics when editing an existing timed event.
  const zone=original && /^(?:DTSTART|DTEND);TZID=("[^"\r\n]+"|[^;:\r\n]+):/i.exec(original);
  if(zone){
    const tz=zone[1].replace(/^"|"$/g,'');
    const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(d).map(x=>[x.type,x.value]));
    return `${name};TZID=${zone[1]}:${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
  }
  if(original && /^(?:DTSTART|DTEND):\d{8}T\d{6}$/i.test(original)) return `${name}:${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${name}:${utc(n)}`;
}
function fold(line) {
  const result=[]; let part='', size=0;
  for(const ch of line){const n=Buffer.byteLength(ch);if(size+n>75){result.push(part);part=' ';size=1;}part+=ch;size+=n;}
  result.push(part);return result.join('\r\n');
}
const serialize=lines=>lines.map(fold).join('\r\n')+'\r\n';
const eventLines=(e,stamp,original={})=>[
  `DTSTAMP:${stamp}`,`LAST-MODIFIED:${stamp}`,
  dateProperty('DTSTART',e.startAt,e.allDay,original.DTSTART),dateProperty('DTEND',e.endAt,e.allDay,original.DTEND),
  'SUMMARY:'+escape(e.title),'LOCATION:'+escape(e.location),'DESCRIPTION:'+escape(e.notes),
];
function sameFields(item,e){return ['title','startAt','endAt','allDay','location','notes'].every(k=>item[k]===e[k]);}
function checkResource(ics, href, tag) {
  const projection=project(ics,href,tag);
  if(projection.items.length!==1 || projection.items[0].remoteEventId!==href) fail('UNSUPPORTED_EVENT');
  const lines=ics.replace(/\r\n?/g,'\n').replace(/\n[ \t]/g,'').trimEnd().split('\n');
  const stack=[], top=new Map(); let end=-1;
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line)) fail('UNSUPPORTED_EVENT');
    if(/^BEGIN:/i.test(line)){stack.push(line.slice(6).toUpperCase());continue;}
    if(/^END:/i.test(line)){if(stack.pop()==='VEVENT') end=i;continue;}
    const name=line.split(/[;:]/,1)[0].toUpperCase();
    // Do not trigger invitations/cancellations or destroy unsupported attachments.
    if(['METHOD','ATTENDEE','ORGANIZER','ATTACH','RECURRENCE-ID','RRULE','RDATE','EXDATE','EXRULE','DURATION'].includes(name)) {
      // Timezone definitions and alarms legitimately contain RRULE/DURATION.
      if(!((stack.includes('VTIMEZONE') && name==='RRULE') || (stack.at(-1)==='VALARM' && name==='DURATION'))) fail('UNSUPPORTED_EVENT');
    }
    if(stack.at(-1)==='VEVENT' && ['UID','DTSTAMP','LAST-MODIFIED','SEQUENCE','DTSTART','DTEND','SUMMARY','LOCATION','DESCRIPTION'].includes(name)){
      if(top.has(name)) fail('UNSUPPORTED_EVENT');
      top.set(name,{i,line});
      if(['SUMMARY','LOCATION','DESCRIPTION'].includes(name) && !new RegExp('^'+name+':','i').test(line)) fail('UNSUPPORTED_EVENT');
    }
  }
  if(end<0 || !top.has('UID')) fail('UNSUPPORTED_EVENT');
  return {projection,lines,top,end};
}
function changedBody(original,e,stamp,href,tag){
  const {lines,top,end}=original;
  const seq=top.get('SEQUENCE')?.line;
  if(seq && !/^SEQUENCE:[0-9]{1,9}$/i.test(seq)) fail('UNSUPPORTED_EVENT');
  const sequence=seq?Number(seq.split(':')[1])+1:1;
  const dates={DTSTART:top.get('DTSTART')?.line,DTEND:top.get('DTEND')?.line || top.get('DTSTART')?.line?.replace(/^DTSTART/i,'DTEND')};
  const additions=[...eventLines(e,stamp,dates),`SEQUENCE:${sequence}`];
  // Preserve untouched date properties and timezone blocks, alarms, and vendor
  // extensions. Reject edits that cannot round-trip through the local parser.
  for(const [k,i,field] of [['DTSTART',2,'startAt'],['DTEND',3,'endAt']]){
    if(top.has(k)&&original.projection.items[0][field]===e[field]&&original.projection.items[0].allDay===e.allDay) additions[i]=top.get(k).line;
  }
  const replaced=new Set([...top].filter(([k])=>k!=='UID').map(([,v])=>v.i));
  // Put VEVENT properties before any VALARM subcomponent.
  const insert=lines.findIndex(l=>/^BEGIN:VEVENT$/i.test(l))+1;
  const next=serialize(lines.flatMap((line,i)=>[...(i===insert?additions:[]),...(!replaced.has(i)?[line]:[])]));
  const validated=checkResource(next,href,tag);
  if(validated.projection.uid!==original.projection.uid||!sameFields(validated.projection.items[0],e)) fail('UNSUPPORTED_EVENT');
  return next;
}
async function writeCalDavEvent({db, calendar, connection, identity, password, check, fetchImpl, now=Date.now}, action, input){
  if(!calendar?.selected || !connection?.enabled || !['caldav','icloud'].includes(connection.provider) || calendar.connectionId!==connection.id || identity.provider!==connection.provider || identity.username!==connection.email) fail('INVALID_CONNECTION');
  if(calendar.accessRole!=='caldav-readWrite') fail('READ_ONLY');
  if(!['create','update','remove'].includes(action)) fail('INVALID_OPTIONS');
  const collection=collectionURL(identity,calendar.remoteId);
  const client=createCalDavClient({serverURL:collection.href,username:identity.username,password,fetchImpl});
  let href, existing, expected, uid, body, desired;
  check();
  if(action==='create'){
    if(typeof input.operationId!=='string'||!uuid.test(input.operationId)) fail('INVALID_OPERATION_ID');
    href=resourceURL(collection,input.operationId+'.ics').href;
    uid=input.operationId+'@libramail';
    desired=eventFields(input.event);
    if(db.getCalendarEventByRemote(calendar.id,href)) fail('CONFLICT');
    body=serialize(['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Technifree//LibraMail//EN','BEGIN:VEVENT','UID:'+uid,...eventLines(desired,utc(now())), 'SEQUENCE:0','END:VEVENT','END:VCALENDAR']);
    const validated=checkResource(body,href,'"new"');
    if(!sameFields(validated.projection.items[0],desired)) fail('UNSUPPORTED_EVENT');
  }else{
    existing=db.getCalendarEvent(input.id);
    if(!existing||existing.remoteCalendarId!==calendar.id||!existing.remoteEventId) fail('INVALID_EVENT');
    if(existing.remoteEventId.includes('#')) fail('UNSUPPORTED_EVENT');
    href=resourceURL(collection,existing.remoteEventId).href;
    expected=etag(input.expectedEtag);
    if(existing.remoteEtag!==expected) fail('CONFLICT');
    if(action==='remove'&&input.confirmed!==true) fail('CONFIRMATION_REQUIRED');
    if(action==='update') desired=eventFields(input.event);
    let remote;
    try {remote=await client.get(href);} catch(e){if(e.status===404||e.status===410)fail('CONFLICT');throw e;}
    check();
    if(etag(remote.etag)!==expected) fail('CONFLICT');
    const original=checkResource(remote.text,href,expected);
    uid=original.projection.uid;
    if(action==='update') body=changedBody(original,desired,utc(now()),href,expected);
  }
  check();
  // No automatic retry of writes. A timeout/connection loss can occur after the
  // server has applied the mutation. Explicit sync is required before retrying.
  let acknowledged=false;
  try {
    const response=action==='create'?await client.create(href,body):action==='update'?await client.update(href,body,expected):await client.remove(href,expected);
    acknowledged=true;
    check();
    if(action==='remove'){
      const r=db.syncCalendarRemoteEvents(calendar.id,[{remoteEventId:href,deleted:true}],{fullSync:false});
      if(r.removed!==1) fail('CACHE_UPDATE_FAILED');
      return {removed:true,id:existing.id};
    }
    // Servers may normalize ICS on PUT. Fetch authoritative data and strong ETag.
    const remote=await client.get(href);check();
    const actual=etag(remote.etag);
    if(response.etag && /^"/.test(response.etag) && response.etag!==actual) fail('CONFLICT');
    const result=checkResource(remote.text,href,actual).projection;
    if(result.uid!==uid||!sameFields(result.items[0],desired)) fail('WRITE_NOT_VERIFIED');
    const stats=db.syncCalendarRemoteEvents(calendar.id,result.items,{fullSync:false});
    if(stats.skipped) fail('CACHE_UPDATE_FAILED');
    const event=db.getCalendarEventByRemote(calendar.id,href);
    if(!event||event.remoteEtag!==actual||!sameFields(event,desired)) fail('CACHE_UPDATE_FAILED');
    return {event};
  }catch(e){
    if(!acknowledged && e instanceof CalDavError && ['FORBIDDEN','AUTHENTICATION_FAILED','CONFLICT','HTTP_ERROR'].includes(e.code) && e.status>=400 && e.status<500) throw e;
    fail('WRITE_UNCERTAIN');
  }
}
module.exports={writeCalDavEvent};
