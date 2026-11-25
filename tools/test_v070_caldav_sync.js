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
const propstat=(props,status)=>`<d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 ${status} Test</d:status></d:propstat>`;
const mixed=(href,props)=>`<d:response><d:href>${escape(href)}</d:href>${props}</d:response>`;
function setup(){
  const state={calendar:{id:1,connectionId:2,remoteId:collection,selected:true,lastSyncAt:7},connection:{id:2,provider:'caldav',credentialKey:key,email:'demo',enabled:true},cache:new Map(),calls:0,applied:0,locked:false,password:'private-password',body:xml(''),status:207,gate:null,direct:null,directCalls:0,inventory:null,inventoryCalls:0};
  const db={getCalendarRemoteCalendar:id=>id===1?{...state.calendar}:null,getCalendarConnection:id=>id===2?{...state.connection}:null,
    syncCalendarRemoteEvents:(id,items,options)=>{assert.equal(id,1);assert.equal(typeof options.fullSync,'boolean');state.applied++;const old=state.cache;state.cache=new Map([...(options.fullSync?[]:old),...items.map(i=>[i.remoteEventId,i])]);return {created:items.filter(i=>!old.has(i.remoteEventId)).length,removed:[...old.keys()].filter(k=>!state.cache.has(k)).length};},
    updateCalendarRemoteCalendarSync:(id,patch)=>{assert.equal(id,1);Object.assign(state.calendar,patch);return {...state.calendar};}};
  const options={db,now:()=>42,isLocked:()=>state.locked,readPassword:(id,config)=>{assert.equal(id,key);assert.deepEqual(config,identity);return state.password;},fetchImpl:async(href,opts)=>{state.calls++;assert.equal(opts.redirect,'manual');assert.equal(opts.headers.Authorization,'Basic '+Buffer.from('demo:private-password').toString('base64'));
      if(opts.method==='GET'){state.directCalls++;assert(state.direct);assert.equal(href,state.direct.href);assert.equal(opts.headers['If-Match'],state.direct.expected);return new Response(state.direct.body,{status:state.direct.status||200,headers:state.direct.etag?{etag:state.direct.etag}:{}});}
      if(opts.method==='PROPFIND'){state.inventoryCalls++;assert.equal(href,state.calendar.remoteId);assert.equal(opts.headers.Depth,'1');assert(state.inventory);return new Response(state.inventory,{status:207});}
      assert.equal(href,state.calendar.remoteId);assert.equal(opts.method,'REPORT');if(state.gate)await state.gate;return new Response(state.body,{status:state.status});}};
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
  // Some DAV implementations include a sync token beside full REPORT rows.
  // Accept only metadata; never treat a token-only result as an empty snapshot.
  state.body=xml(row(a,ics('a','Changed'),'"2"')+'<d:sync-token>urn:test:private-token</d:sync-token>');
  assert.equal((await run()).removed,0);assert.equal(state.cache.size,1);
  // A failed optional property must not invalidate an otherwise complete row.
  const valid=propstat(`<d:getetag>"2"</d:getetag><c:calendar-data>${escape(ics('a','Changed'))}</c:calendar-data>`,200);
  const missingData=propstat('<c:calendar-data/>',404);
  const tag=propstat('<d:getetag>"2"</d:getetag>',200);
  state.body=xml(mixed(a,valid+propstat('<d:displayname/>',404)));
  assert.equal((await run()).removed,0);assert.equal(state.cache.size,1);assert.equal(state.directCalls,0);
  state.body=xml(mixed(a,tag+missingData));
  state.direct={href:a,expected:'"2"',etag:'"2"',body:ics('a','Changed')};
  assert.equal((await run()).removed,0);assert.equal(state.directCalls,1);assert.equal(state.cache.get(a).title,'Changed');
  const before=state.applied;
  for(const direct of [{etag:'"3"'},{etag:null},{status:412},{status:404}]){
    state.direct={href:a,expected:'"2"',etag:'"2"',body:ics('a','Not applied'),...direct};
    await assert.rejects(run(),{code:direct.status===404?'HTTP_ERROR':'DAV_RESOURCE_CHANGED'});
    assert.equal(state.applied,before);assert.equal(state.cache.get(a).title,'Changed');
  }
  state.direct=null;
  state.body=xml(mixed(a,propstat('<d:getetag/><c:calendar-data/>',404)));
  await assert.rejects(run(),{code:'DAV_ETAG_NOT_FOUND'});assert.equal(state.applied,before);
  state.body=xml(mixed(a,tag));await assert.rejects(run(),{code:'INCOMPLETE_SNAPSHOT'});assert.equal(state.applied,before);
  for(const [body,code] of [
    [xml('<d:sync-token>urn:test:private-token</d:sync-token>'),'TOKEN_ONLY'],
    [xml(row(a,ics('a'))+'<d:sync-token>one</d:sync-token><d:sync-token>two</d:sync-token>'),'DUPLICATE'],
    [xml('<d:error><d:number-of-matches-within-limits/></d:error>'),'ROOT_CHILD'],
    [xml(mixed(a,valid+propstat('<d:displayname/>',403))),'PROPSTAT_FORBIDDEN'],
    [xml(mixed(a,valid+propstat('<d:displayname/>',507))),'PROPSTAT_LIMIT'],
    [xml(mixed(a,valid+missingData)),'DUPLICATE_PROPERTY'],
    [xml(mixed(a,missingData+valid)),'DUPLICATE_PROPERTY'],
    [xml('<d:response><d:href>/x</d:href></d:bad>'),'CLOSING_TAG'],
    [xml('<d:response><d:href>&private-token;</d:href></d:response>'),'ENTITY'],
    [xml('private-event-text'),'ROOT_CHILD'],
  ]) {
    state.body=body;
    await assert.rejects(run(),{code:'INVALID_DAV_XML_'+code});
    assert.equal(state.calendar.lastError,'INVALID_DAV_XML_'+code);
    assert.equal(state.applied,before);assert.equal(state.cache.get(a).title,'Changed');
  }
  for(const body of [xml(row(a,ics('a'), '"1"',404)),xml('<d:error><d:number-of-matches-within-limits/></d:error>'),xml('<d:response><d:href>'+a+'</d:href><d:status>HTTP/1.1 507 No</d:status></d:response>'),xml(row(a,ics('a'))+row(a,ics('a'))),xml(row(a,ics('a'))+row(b,ics('a'))),xml(row('https://evil.test/a.ics',ics('a'))),xml(row(base+'elsewhere.ics',ics('a'))),xml(row(a,ics('a'),'W/"1"')),xml(row(a,ics('a','Unsupported','RRULE:FREQ=HOURLY\r\n'))),xml(row(a,ics('a','Invalid','','DTSTART:20260231T100000Z\r\nDTEND:20260303T100000Z'))),xml(row(a,ics('a','Invalid','','DTSTART;TZID=Invented/Zone:20261124T100000\r\nDTEND;TZID=Invented/Zone:20261124T110000'))),'<bad>']){
    state.body=body;await assert.rejects(run(),e=>e.name==='CalDavError');assert.equal(state.applied,before);assert.equal(state.cache.get(a).title,'Changed');assert.equal(state.calendar.lastSyncAt,42);assert.equal(state.calendar.lastStatus,'error');assert(!state.calendar.lastError.includes('private-password'));
  }
  // Mixed supported and unsupported resources: upsert only; no deletion or
  // successful timestamp until the entire collection is understood.
  state.calendar.lastSyncAt=7;
  state.body=xml(row(a,ics('a','Changed'),'"2"')+row(b,ics('b','Unsupported','RRULE:FREQ=HOURLY\r\n'))+row(c,ics('c','New')));
  let partial=await run();assert(partial.partial);assert.equal(partial.unsupportedCount,1);assert.equal(partial.error,'UNSUPPORTED_EVENT_RRULE');
  assert.equal(partial.removed,0);assert.equal(state.cache.size,2);assert.equal(state.calendar.lastSyncAt,7);assert.equal(state.calendar.lastStatus,'error');
  assert.equal((await run()).created,0);assert.equal(state.cache.size,2);
  state.body=xml(row(c,ics('c','New'))+row(b,ics('b','Unsupported','EXDATE:20261124T100000Z\r\n')));
  partial=await run();assert.equal(partial.error,'UNSUPPORTED_EVENT_EXDATE');assert.equal(partial.removed,0);assert(state.cache.has(a));
  state.body=xml(row(a,ics('a','Changed'),'"2"'));assert.equal((await run()).removed,1);assert.equal(state.cache.size,1);assert.equal(state.calendar.lastStatus,'ok');
  // Monthly series is now fully supported and reconciled without duplicates.
  state.body=xml(row(a,ics('a','Changed'),'"2"')+row(b,ics('b','Monthly','RRULE:FREQ=MONTHLY;COUNT=3\r\n')));
  assert.equal((await run()).created,3);assert.equal(state.cache.size,4);
  assert.equal((await run()).created,0);assert.equal(state.cache.size,4);
  state.body=xml(row(a,ics('a','Changed'),'"2"')+row(b,ics('b','Monthly','RRULE:FREQ=MONTHLY;COUNT=2\r\n')));
  assert.equal((await run()).removed,1);assert.equal(state.cache.size,3);
  state.body=xml(row(a,ics('a','Changed'),'"2"'));assert.equal((await run()).removed,2);
  const beforeAfterPartial=state.applied;
  state.body=xml('');state.status=503;await assert.rejects(run());assert.equal(state.applied,beforeAfterPartial);state.status=207;
  state.locked=true;const calls=state.calls;await assert.rejects(run(),{code:'CREDENTIALS_LOCKED'});assert.equal(state.calls,calls);state.locked=false;
  state.connection.provider='google';await assert.rejects(run(),{code:'INVALID_CONNECTION'});state.connection.provider='caldav';
  state.calendar.remoteId='https://evil.test/';await assert.rejects(run(),{code:'CROSS_ORIGIN'});state.calendar.remoteId=collection;
  state.password=null;await assert.rejects(run(),{code:'CREDENTIALS_REQUIRED'});state.password='private-password';
  let release;state.gate=new Promise(r=>release=r);const inflight=run();await assert.rejects(run(),{code:'SYNC_BUSY'});state.calendar.selected=false;release();await assert.rejects(inflight,{code:'INVALID_CONNECTION'});assert.equal(state.applied,beforeAfterPartial);state.calendar.selected=true;state.gate=null;
  state.body=xml('');assert.equal((await run()).removed,1);assert.equal(state.cache.size,0);
  const appleConfig={provider:'icloud',username:'demo'};
  state.connection.provider='icloud';state.calendar.remoteId='https://p42-caldav.icloud.com/calendar/';
  const apple=createCalDavSyncEngine({...options,readPassword:(id,config)=>{assert.equal(id,key);assert.equal(config.provider,'icloud');return 'private-password';}});
  await apple.syncRemoteCalendar(1,appleConfig);
  const shard=state.calendar.remoteId, generic='https://caldav.icloud.com/calendar/';
  const self=mixed(generic,propstat('<d:getetag/><c:calendar-data/>',404));
  const event=shard+'one.ics';
  state.body=xml(self+row(generic+'one.ics',ics('apple'),'"a"'));
  assert.equal((await apple.syncRemoteCalendar(1,appleConfig)).created,1);
  assert.equal(state.cache.get(event).title,'Meeting');
  state.body=xml(self+mixed(generic+'one.ics',propstat('<d:getetag>"a"</d:getetag>',200)+missingData));
  state.direct={href:event,expected:'"a"',etag:'"a"',body:ics('apple')};
  assert.equal((await apple.syncRemoteCalendar(1,appleConfig)).created,0);
  state.direct=null;
  const applied=state.applied;
  for(const [bad,code] of [
    [row('https://evil.test/calendar/one.ics',ics('apple')),'DAV_RESOURCE_ORIGIN'],
    [row('https://p99-caldav.icloud.com/calendar/one.ics',ics('apple')),'DAV_RESOURCE_ORIGIN'],
    [row('https://caldav.icloud.com/elsewhere/one.ics',ics('apple')),'DAV_RESOURCE_OUTSIDE'],
    [row(generic+'folder/one.ics',ics('apple')),'DAV_RESOURCE_NESTED'],
    [row(generic+'folder%2fone.ics',ics('apple')),'DAV_RESOURCE_ENCODING'],
    [row(generic,ics('apple')),'DAV_RESOURCE_SELF'],
    [self+self,'DAV_RESOURCE_SELF'],
    [row(generic+'one.ics',ics('apple'))+row(event,ics('apple')),'INCOMPLETE_SNAPSHOT']
  ]){
    state.body=xml(bad);await assert.rejects(apple.syncRemoteCalendar(1,appleConfig),{code});
    assert.equal(state.applied,applied);assert(state.cache.has(event));
  }
  state.body=xml(self);
  const own=mixed(shard,propstat('<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>',200));
  state.inventory=xml(own+mixed(event,propstat('<d:resourcetype/>',200)));
  await assert.rejects(apple.syncRemoteCalendar(1,appleConfig),{code:'DAV_EMPTY_UNVERIFIED'});
  assert.equal(state.applied,applied);assert(state.cache.has(event));
  state.inventory=xml(own);
  assert.equal((await apple.syncRemoteCalendar(1,appleConfig)).removed,1);
  assert.equal(state.inventoryCalls,2);assert.equal(state.cache.size,0);
  state.calendar.remoteId='https://p42-caldav.icloud.com.evil.test/calendar/';await assert.rejects(apple.syncRemoteCalendar(1,appleConfig),{code:'CROSS_ORIGIN'});
  // Reconcile a moved occurrence by its original identity; cancelled or
  // excluded occurrences disappear only in a verified complete snapshot.
  const fixture=setup(), runSeries=fixture.run, series=collection+'series.ics';
  const initial=ics('series','Series','RRULE:FREQ=DAILY;COUNT=3\r\n');
  fixture.state.body=xml(row(series,initial));assert.equal((await runSeries()).created,3);
  const originalKey=series+'#'+Date.UTC(2026,10,25,10), excludedKey=series+'#'+Date.UTC(2026,10,26,10);
  const revised=initial.replace('END:VEVENT','EXDATE:20261126T100000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:series\r\nRECURRENCE-ID:20261125T100000Z\r\nDTSTART:20261129T140000Z\r\nDTEND:20261129T150000Z\r\nSUMMARY:Moved\r\nEND:VEVENT');
  fixture.state.body=xml(row(series,revised,'"2"'));
  assert.equal((await runSeries()).removed,1);assert.equal(fixture.state.cache.size,2);assert(!fixture.state.cache.has(excludedKey));
  assert.equal(fixture.state.cache.get(originalKey).startAt,Date.UTC(2026,10,29,14));
  assert.equal((await runSeries()).created,0);assert.equal(fixture.state.cache.size,2);
  fixture.state.body=xml(row(series,revised.replace('RECURRENCE-ID:','RECURRENCE-ID;RANGE=THISANDFUTURE:'),'"3"')+row(a,ics('a')));
  const incomplete=await runSeries();assert(incomplete.partial);assert.equal(incomplete.removed,0);assert.equal(fixture.state.cache.get(originalKey).title,'Moved');
  console.log('[OK] LibraMail 0.7.0 : snapshots CalDAV, cache, refus des réponses partielles et concurrence');
})().catch(e=>{console.error(e);process.exitCode=1;});
