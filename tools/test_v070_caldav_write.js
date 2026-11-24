'use strict';
const assert=require('node:assert/strict');
const {createCalDavRuntime}=require('../engine/lib/calendar_caldav_runtime');
const base='https://example.test/dav/', collection=base+'one/';
const key='12345678-1234-4234-8234-123456789abc';
const operation='12345678-1234-4234-8234-123456789abd';
const operation2='12345678-1234-4234-8234-123456789abe';
const href=collection+operation+'.ics';
const connection={id:1,provider:'caldav',email:'demo',credentialKey:key,caldavServerURL:base,enabled:true};
const calendar={id:2,connectionId:1,selected:true,accessRole:'caldav-readWrite',remoteId:collection};
const cache=new Map(), server=new Map(), changes=[], requests=[];
let calls=0, serial=0, locked=false, failGetAfterWrite=false, failAfterPut=false, race=false, cancelAfterPut=false, written=false;
const db={getCalendarConnection:id=>id===1?{...connection}:null,getCalendarRemoteCalendar:id=>id===2?{...calendar}:null,
  getCalendarEvent:id=>[...cache.values()].find(x=>x.id===id), getCalendarEventByRemote:(id,url)=>id===2?cache.get(url):null,
  syncCalendarRemoteEvents:(id,items,options)=>{assert.equal(id,2);assert.equal(options.fullSync,false);let removed=0;for(const i of items){if(i.deleted){removed+=Number(cache.delete(i.remoteEventId));continue;}cache.set(i.remoteEventId,{id:cache.get(i.remoteEventId)?.id||++serial,remoteCalendarId:id,...i});}return{removed,skipped:0};},
  updateCalendarRemoteCalendarSync:(id,patch)=>Object.assign(calendar,patch),
};
const runtime=createCalDavRuntime({db,credentials:{readPassword:(id,identity)=>{assert.equal(id,key);assert.equal(identity.serverURL,base);return 'private-password';}},available:()=>!locked,now:()=>Date.UTC(2026,10,24,9),onChange:e=>changes.push(e),
  fetchImpl:async(url,opts)=>{
    assert(url.startsWith(collection));assert.equal(opts.redirect,'manual');assert.equal(opts.headers.Authorization,'Basic '+Buffer.from('demo:private-password').toString('base64'));
    requests.push({url,method:opts.method,headers:opts.headers,body:opts.body});calls++;
    const existing=server.get(url);
    if(opts.method==='GET'){
      if(failGetAfterWrite&&written)return new Response(null,{status:401});
      if(!existing)return new Response(null,{status:404});
      return new Response(existing.ics,{headers:{ETag:existing.tag}});
    }
    if(race&&existing){existing.tag='"race"';race=false;}
    if(opts.headers['If-None-Match']==='*'&&existing || opts.headers['If-Match']&&existing?.tag!==opts.headers['If-Match'])return new Response(null,{status:412});
    if(opts.method==='PUT'){
      const tag='"'+calls+'"';server.set(url,{tag,ics:opts.body});written=true;
      if(cancelAfterPut)runtime.stop();
      if(failAfterPut)throw Error('private-password');
      return new Response(null,{status:existing?204:201,headers:{ETag:tag}});
    }
    if(opts.method==='DELETE'){server.delete(url);return new Response(null,{status:204});}
    throw Error('unexpected method');
  }});
const event={title:'Café, réunion; équipe',startAt:Date.UTC(2026,10,24,10),endAt:Date.UTC(2026,10,24,11),allDay:false,location:'Paris',notes:'Ligne 1\n'+ 'é😀'.repeat(40)};
const create=(op=operation,e=event)=>runtime.write('create',{remoteCalendarId:2,operationId:op,event:e});
const update=(e,tag=cache.get(href).remoteEtag)=>runtime.write('update',{remoteCalendarId:2,id:cache.get(href).id,expectedEtag:tag,event:e});
const remove=(confirmed=true,tag=cache.get(href).remoteEtag)=>runtime.write('remove',{remoteCalendarId:2,id:cache.get(href).id,expectedEtag:tag,confirmed});
(async()=>{
  const r=await create();assert.equal(r.event.title,event.title);assert.equal(r.event.notes,event.notes);assert.equal(server.size,1);assert.equal(cache.size,1);
  assert.equal(requests[0].headers['If-None-Match'],'*');assert.match(server.get(href).ics,new RegExp('UID:'+operation+'@libramail'));
  for(const line of server.get(href).ics.split('\r\n'))assert(Buffer.byteLength(line)<=75);
  const initial=r.event.remoteEtag;let n=calls;
  await assert.rejects(create(),{code:'CONFLICT'});assert.equal(calls,n);
  await assert.rejects(create(operation2,{...event,endAt:event.startAt}),{code:'INVALID_EVENT'});assert.equal(calls,n);
  await assert.rejects(create(operation2,{...event,notes:'bad\0value'}),{code:'INVALID_EVENT'});assert.equal(calls,n);
  calendar.accessRole='caldav-readOnly';await assert.rejects(update(event),{code:'READ_ONLY'});assert.equal(calls,n);calendar.accessRole='caldav-readWrite';
  connection.provider='google';await assert.rejects(create(operation2),{code:'INVALID_CONNECTION'});assert.equal(calls,n);connection.provider='caldav';
  await assert.rejects(remove(false),{code:'CONFIRMATION_REQUIRED'});assert.equal(calls,n);
  // Existing provider metadata and alarm must survive editing.
  let resource=server.get(href);resource.ics=resource.ics.replace('END:VEVENT','X-APPLE-TEST:preserved\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\nEND:VEVENT');
  const modified={...event,title:'Modifié',startAt:event.startAt+3600000,endAt:event.endAt+3600000};
  const updated=await update(modified);assert.equal(updated.event.id,r.event.id);assert.equal(updated.event.title,'Modifié');assert.notEqual(updated.event.remoteEtag,initial);assert.match(server.get(href).ics,/X-APPLE-TEST:preserved/);assert.match(server.get(href).ics,/BEGIN:VALARM/);
  assert.equal(requests.at(-2).headers['If-Match'],initial);
  n=calls;await assert.rejects(update(event,initial),{code:'CONFLICT'});assert.equal(calls,n);
  // Conflict between GET and PUT: server changes the ETag just before PUT.
  race=true;await assert.rejects(update(event),{code:'CONFLICT'});assert.equal(cache.get(href).title,'Modifié');assert.equal(calendar.lastError,'CONFLICT');
  server.get(href).tag=cache.get(href).remoteEtag;
  // Unsupported invitations and recurrences cannot be mutated/deleted.
  resource=server.get(href);const old=resource.ics;resource.ics=old.replace('END:VEVENT','ATTENDEE:mailto:guest@example.test\r\nEND:VEVENT');
  n=calls;await assert.rejects(remove(),{code:'UNSUPPORTED_EVENT'});assert.equal(calls,n+1);assert.equal(server.size,1);
  resource.ics=old.replace('END:VEVENT','RRULE:FREQ=DAILY;COUNT=2\r\nEND:VEVENT');await assert.rejects(update(event),{code:'UNSUPPORTED_EVENT'});resource.ics=old;
  // Strong ETag check also protects deletions.
  race=true;await assert.rejects(remove(),{code:'CONFLICT'});assert.equal(cache.size,1);server.get(href).tag=cache.get(href).remoteEtag;
  assert((await remove()).removed);assert.equal(cache.size,0);assert.equal(server.size,0);assert.equal(changes.at(-1).removed,true);
  const day={...event,title:'Jour entier',startAt:new Date(2026,2,29).getTime(),endAt:new Date(2026,2,30).getTime(),allDay:true};
  const all=await create(operation,day);assert(all.event.allDay);assert.equal(all.event.endAt,day.endAt);assert.match(server.get(href).ics,/DTSTART;VALUE=DATE:20260329/);await remove();
  // Network error after committed write: no local success; retry same ID cannot duplicate.
  failAfterPut=true;await assert.rejects(create(),{code:'WRITE_UNCERTAIN'});assert.equal(cache.size,0);assert.equal(server.size,1);assert.equal(calendar.lastError,'WRITE_UNCERTAIN');failAfterPut=false;
  await assert.rejects(create(),{code:'CONFLICT'});assert.equal(server.size,1);server.clear();
  // A GET failure after successful PUT is also uncertain, not an auth refusal of the write.
  written=false;failGetAfterWrite=true;await assert.rejects(create(),{code:'WRITE_UNCERTAIN'});assert.equal(cache.size,0);failGetAfterWrite=false;server.clear();
  cancelAfterPut=true;await assert.rejects(create(),{code:'WRITE_UNCERTAIN'});assert.equal(cache.size,0);assert(!runtime.busy());cancelAfterPut=false;server.clear();
  locked=true;n=calls;await assert.rejects(create(),{code:'RUNTIME_UNAVAILABLE'});assert.equal(calls,n);locked=false;
  calendar.remoteId='https://evil.test/';await assert.rejects(create(),{code:'CROSS_ORIGIN'});assert.equal(calls,n);calendar.remoteId=collection;
  assert(!JSON.stringify(changes).includes('private-password'));
  const backend=require('node:fs').readFileSync(require('node:path').join(__dirname,'../engine/backend.js'),'utf8');
  for(const name of ['create','update','remove'])assert(backend.includes(`'calendar.caldav.event.${name}':`));
  assert(backend.includes('assertCalDavReadOnly(requestedRemoteCalendarId)'));
  console.log('[OK] LibraMail 0.7.0 : écritures CalDAV conditionnelles, conflits, UID, cache et reprise sécurisée');
})().catch(e=>{console.error(e);process.exitCode=1;});
