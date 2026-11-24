'use strict';
const assert=require('node:assert/strict');
const {createCalDavSyncEngine}=require('../engine/lib/calendar_caldav_sync');
const base='https://example.test/dav/';
const collection=base+'family/';
const key='12345678-1234-4234-8234-123456789abc';
const identity={provider:'caldav',serverURL:base,username:'demo'};
const xml=rows=>`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${rows}</d:multistatus>`;
const escape=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const ics=(uid,title='Meeting',extra='',dates='DTSTART:20261124T100000Z\r\nDTEND:20261124T110000Z')=>`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\n${dates}\r\nSUMMARY:${title}\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`;
const row=(href,body,etag='"1"',status=200)=>`<d:response><d:href>${escape(href)}</d:href><d:propstat><d:prop><d:getetag>${escape(etag)}</d:getetag><c:calendar-data>${escape(body)}</c:calendar-data></d:prop><d:status>HTTP/1.1 ${status} Test</d:status></d:propstat></d:response>`;
function setup(){
  const state={calendar:{id:1,connectionId:2,remoteId:collection,selected:true,lastSyncAt:7},connection:{id:2,provider:'caldav',credentialKey:key,email:'demo',enabled:true},cache:new Map(),calls:0,applied:0,locked:false,password:'private-password',body:xml(''),status:207,gate:null};
  const db={getCalendarRemoteCalendar:id=>id===1?{...state.calendar}:null,getCalendarConnection:id=>id===2?{...state.connection}:null,
    syncCalendarRemoteEvents:(id,items,options)=>{assert.equal(id,1);assert.deepEqual(options,{fullSync:true});state.applied++;const old=state.cache;state.cache=new Map(items.map(i=>[i.remoteEventId,i]));return {created:items.filter(i=>!old.has(i.remoteEventId)).length,removed:[...old.keys()].filter(k=>!state.cache.has(k)).length};},
    updateCalendarRemoteCalendarSync:(id,patch)=>{assert.equal(id,1);Object.assign(state.calendar,patch);return {...state.calendar};}};
  const options={db,now:()=>42,isLocked:()=>state.locked,readPassword:(id,config)=>{assert.equal(id,key);assert.deepEqual(config,identity);return state.password;},fetchImpl:async(href,opts)=>{state.calls++;assert.equal(href,state.calendar.remoteId);assert.equal(opts.method,'REPORT');assert.equal(opts.redirect,'manual');assert.equal(opts.headers.Authorization,'Basic '+Buffer.from('demo:private-password').toString('base64'));if(state.gate)await state.gate;return new Response(state.body,{status:state.status});}};
  return {state,db,options,engine:createCalDavSyncEngine(options),run:()=>createCalDavSyncEngine(options).syncRemoteCalendar(1,identity)};
}
(async()=>{
  const {state,run,options}=setup();
  const a=collection+'a.ics',b=collection+'b.ics',c=collection+'c.ics';
  state.body=xml(row(a,ics('a','First & second'))+row(b,ics('b','Repeat','RRULE:FREQ=DAILY;COUNT=3\r\n'))+row(c,ics('c','All day','','DTSTART;VALUE=DATE:20261124\r\nDTEND;VALUE=DATE:20261125')));
  assert.equal((await run()).created,5);assert.equal(state.cache.size,5);assert.equal(state.cache.get(a).title,'First & second');assert.equal(state.cache.get(a).startAt,Date.UTC(2026,10,24,10));assert(state.cache.get(c).allDay);assert.equal(state.calendar.lastSyncAt,42);
  assert.equal((await run()).created,0);assert.equal(state.cache.size,5);
  state.body=xml(row(a,ics('a','Changed'),'"2"'));
  assert.equal((await run()).removed,4);assert.equal(state.cache.get(a).title,'Changed');
  const before=state.applied;
  for(const body of [xml(row(a,ics('a'), '"1"',404)),xml('<d:error><d:number-of-matches-within-limits/></d:error>'),xml('<d:response><d:href>'+a+'</d:href><d:status>HTTP/1.1 507 No</d:status></d:response>'),xml(row(a,ics('a'))+row(a,ics('a'))),xml(row(a,ics('a'))+row(b,ics('a'))),xml(row('https://evil.test/a.ics',ics('a'))),xml(row(base+'elsewhere.ics',ics('a'))),xml(row(a,ics('a'),'W/"1"')),xml(row(a,ics('a','Unsupported','RRULE:FREQ=MONTHLY\r\n'))),xml(row(a,ics('a','Invalid','','DTSTART:20260231T100000Z\r\nDTEND:20260303T100000Z'))),xml(row(a,ics('a','Invalid','','DTSTART;TZID=Invented/Zone:20261124T100000\r\nDTEND;TZID=Invented/Zone:20261124T110000'))),'<bad>']){
    state.body=body;await assert.rejects(run(),e=>e.name==='CalDavError');assert.equal(state.applied,before);assert.equal(state.cache.get(a).title,'Changed');assert.equal(state.calendar.lastSyncAt,42);assert.equal(state.calendar.lastStatus,'error');assert(!state.calendar.lastError.includes('private-password'));
  }
  state.body=xml('');state.status=503;await assert.rejects(run());assert.equal(state.applied,before);state.status=207;
  state.locked=true;const calls=state.calls;await assert.rejects(run(),{code:'CREDENTIALS_LOCKED'});assert.equal(state.calls,calls);state.locked=false;
  state.connection.provider='google';await assert.rejects(run(),{code:'INVALID_CONNECTION'});state.connection.provider='caldav';
  state.calendar.remoteId='https://evil.test/';await assert.rejects(run(),{code:'CROSS_ORIGIN'});state.calendar.remoteId=collection;
  state.password=null;await assert.rejects(run(),{code:'CREDENTIALS_REQUIRED'});state.password='private-password';
  let release;state.gate=new Promise(r=>release=r);const inflight=run();await assert.rejects(run(),{code:'SYNC_BUSY'});state.calendar.selected=false;release();await assert.rejects(inflight,{code:'INVALID_CONNECTION'});assert.equal(state.applied,before);state.calendar.selected=true;state.gate=null;
  state.body=xml('');assert.equal((await run()).removed,1);assert.equal(state.cache.size,0);
  const appleConfig={provider:'icloud',username:'demo'};
  state.connection.provider='icloud';state.calendar.remoteId='https://p42-caldav.icloud.com/calendar/';
  const apple=createCalDavSyncEngine({...options,readPassword:(id,config)=>{assert.equal(id,key);assert.equal(config.provider,'icloud');return 'private-password';}});
  await apple.syncRemoteCalendar(1,appleConfig);
  state.calendar.remoteId='https://p42-caldav.icloud.com.evil.test/calendar/';await assert.rejects(apple.syncRemoteCalendar(1,appleConfig),{code:'CROSS_ORIGIN'});
  console.log('[OK] LibraMail 0.7.0 : snapshots CalDAV, cache, refus des réponses partielles et concurrence');
})().catch(e=>{console.error(e);process.exitCode=1;});
