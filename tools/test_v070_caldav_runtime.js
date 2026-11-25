'use strict';
const assert = require('node:assert/strict');
const { createCalDavRuntime } = require('../engine/lib/calendar_caldav_runtime');
const { CalDavError } = require('../engine/lib/calendar_caldav');
const base='https://example.test/dav/', first=base+'one/', second=base+'two/';
const connections = new Map(), calendars = new Map(), secrets = new Map();
let id=0, allowed=true, time=1000, failDB=false, failRemote=false, partialRemote=false, wait=null, syncs=0;
const copy = x => x ? {...x} : null;
const db={
  db:{ transaction: fn=>()=>{const c=new Map(connections),a=new Map(calendars);try{return fn();}catch(e){connections.clear();calendars.clear();for(const pair of c)connections.set(...pair);for(const pair of a)calendars.set(...pair);throw e;}} },
  saveCalendarConnection:(x,i)=>{i=i||++id; const r={lastSyncAt:0,...x,id:i};connections.set(i,r);return copy(r);},
  getCalendarConnection:i=>copy(connections.get(i)),
  listCalendarConnections:({enabledOnly=false}={})=>[...connections.values()].filter(c=>!enabledOnly||c.enabled).map(copy),
  saveCalendarRemoteCalendar:x=>{if(failDB)throw Error('secret from db');const r={lastSyncAt:0,...x,id:++id};calendars.set(r.id,r);return copy(r);},
  getCalendarRemoteCalendar:i=>copy(calendars.get(i)),
  listCalendarRemoteCalendars:({connectionId,selectedOnly})=>[...calendars.values()].filter(c=>c.connectionId===connectionId&&(!selectedOnly||c.selected)).map(copy),
  updateCalendarConnectionSync:(i,p)=>Object.assign(connections.get(i),p),
  updateCalendarRemoteCalendarSync:(i,p)=>Object.assign(calendars.get(i),p),
  setCalendarRemoteCalendarSelected:(i,selected)=>({calendar:copy(Object.assign(calendars.get(i),{selected}))}),
  removeCalendarConnection:i=>{for(const [k,c]of calendars)if(c.connectionId===i)calendars.delete(k);return{removed:connections.delete(i)};},
};
const credentials={putPassword:(k,c,p)=>secrets.set(k,p),readPassword:k=>secrets.get(k),removePassword:k=>secrets.delete(k)};
const input={provider:'caldav',serverURL:base,username:'demo',password:'private-password',selectedURLs:[first],refreshMinutes:5};
const runtime=createCalDavRuntime({db,credentials,available:()=>allowed,now:()=>time,
  discover:async()=>[{url:first,name:'One',readOnly:false},{url:second,name:'Two',readOnly:true}],
  createEngine:({isLocked,readPassword})=>({syncRemoteCalendar:async i=>{
    syncs++; const cal=calendars.get(i);assert(readPassword(connections.get(cal.connectionId).credentialKey));
    if(wait) await wait;
    if(isLocked())throw new CalDavError('CREDENTIALS_LOCKED');
    if(failRemote)throw Error('private-password');
    if(partialRemote)return {partial:true,error:'UNSUPPORTED_EVENT_RRULE',created:2};
    db.updateCalendarRemoteCalendarSync(i,{lastSyncAt:time,lastStatus:'ok'});return {created:1};
  }})});
(async()=>{
  const google=db.saveCalendarConnection({provider:'google',enabled:true,credentialKey:'google'});
  assert.equal((await runtime.preview(input)).length,2);assert.equal(secrets.size,0);
  await assert.rejects(runtime.add({...input,selectedURLs:['https://evil.test/']}),/INVALID_SELECTION/);
  await assert.rejects(runtime.add({...input,serverURL:'http://example.test/'}),/INVALID_URL/);
  failDB=true;await assert.rejects(runtime.add(input),/OPERATION_FAILED/);assert.equal(secrets.size,0);assert.equal(connections.size,1);failDB=false;
  await assert.rejects(runtime.add({...input,calendarColors:[{url:second,color:'#123456'}]}),/INVALID_OPTIONS/);
  await assert.rejects(runtime.add({...input,calendarColors:[{url:first,color:'bad'}]}),/INVALID_OPTIONS/);
  assert.equal(secrets.size,0);
  const {connection:c,calendars:rows}=await runtime.add({...input,calendarColors:[{url:first,color:'#12ab34'}]});
  assert.equal(rows[0].color,'#12AB34');
  assert.equal(c.caldavServerURL,base);assert.equal(c.caldavRefreshMinutes,5);assert.equal(rows[0].selected,true);assert.equal(rows[1].selected,false);
  assert(!JSON.stringify([c,rows]).includes(input.password));assert.equal(secrets.size,1);
  await assert.rejects(runtime.add(input),/DUPLICATE_CONNECTION/);
  assert.equal((await runtime.syncAll({dueOnly:true}))[0].created,1);assert.equal(syncs,1);
  assert.deepEqual(await runtime.syncAll({dueOnly:true}),[]);
  time+=300001;failRemote=true;const bad=(await runtime.syncAll({dueOnly:true}))[0];assert.equal(bad.failed,1);assert(!JSON.stringify(bad).includes(input.password));assert.equal(db.getCalendarConnection(c.id).lastSyncAt,1000);
  assert.deepEqual(await runtime.syncAll({dueOnly:true}),[]);failRemote=false;
  partialRemote=true;const partial=await runtime.sync(c.id);assert.equal(partial.failed,1);assert.equal(partial.partial,1);assert.equal(partial.synced,0);assert.equal(partial.created,2);assert.equal(db.getCalendarConnection(c.id).lastSyncAt,1000);partialRemote=false;
  runtime.select(rows[1].id,true);assert.equal((await runtime.sync(c.id)).synced,2);
  runtime.configure({id:c.id,enabled:false});assert.deepEqual(await runtime.syncAll(),[]);runtime.configure({id:c.id,enabled:true});
  assert.throws(()=>runtime.remove(google.id),/INVALID_CONNECTION/);
  let release;wait=new Promise(r=>release=r);const running=runtime.sync(c.id);assert(runtime.busy());assert.throws(()=>runtime.remove(c.id),/SYNC_BUSY/);
  runtime.stop();allowed=false;allowed=true;release();await assert.rejects(running,/RUNTIME_UNAVAILABLE/);assert(!runtime.busy());wait=null;
  await runtime.replacePassword({id:c.id,password:'new-secret'});assert.equal(secrets.get(c.credentialKey),'new-secret');
  assert(runtime.remove(c.id).removed);assert.equal(secrets.size,0);assert(db.getCalendarConnection(google.id));
  let networkSignal;
  const cancellable=createCalDavRuntime({db,credentials,available:()=>true,
    discover:async ({fetchImpl})=>fetchImpl(base,{signal:AbortSignal.timeout(30000)}),
    fetchImpl:async (url,{signal})=>{networkSignal=signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}
  });
  const discovery=cancellable.preview(input);assert(networkSignal);cancellable.stop();assert(networkSignal.aborted);await assert.rejects(discovery,/OPERATION_FAILED/);
  console.log('[OK] LibraMail 0.7.0 : cycle de vie CalDAV, planification, annulation et cloisonnement');
})().catch(e=>{console.error(e);process.exitCode=1;});
