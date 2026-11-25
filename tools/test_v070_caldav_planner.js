'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'resources/js/planner.js'), 'utf8');
// Exercise the real planner functions in an isolated DOM/RPC harness. No network,
// real calendar, credential, production test hook or modified source on disk.
class Element {
  constructor() {
    this.value=''; this.textContent=''; this.disabled=false; this.checked=false; this.options=[];
    const classes=new Set(); this.classList={add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k),toggle:(k,v)=>v?classes.add(k):classes.delete(k)};
    this.children={};
  }
  set innerHTML(html) {
    this._html=html;
    this.options=[...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(m=>({value:m[1],textContent:m[2]}));
    this.value=this.options[0]?.value||'';
  }
  get innerHTML(){return this._html||'';}
  get selectedOptions(){return this.options.filter(o=>o.value===this.value);}
  appendChild(o){this.options.push(o);}
  querySelector(k){return this.children[k] ||= new Element();}
  querySelectorAll(){return [];}
  focus(){}
}
const elements = new Map();
const el = k => { if (!elements.has(k)) elements.set(k,new Element());return elements.get(k); };
const ids=['planner-title','planner-event-id','planner-account','planner-category','planner-all-day','planner-start-date','planner-start-time','planner-end-date','planner-end-time','planner-location','planner-notes','btn-planner-save','btn-planner-delete','btn-planner-cancel'];
const document={getElementById:el,createElement:()=>new Element(),querySelector:el,querySelectorAll:s=>s.includes('#planner-editor input')?ids.map(el):[]};
const calls=[], statuses=[];
let response, reject, confirm=true, connections=[{id:1,provider:'icloud',enabled:true,displayName:'Apple'},{id:2,provider:'caldav',enabled:false},{id:3,provider:'google',enabled:true}];
const calendar={id:10,connectionId:1,name:'Personnel',selected:true,accessRole:'caldav-readWrite'};
const readOnly={...calendar,id:11,name:'Lecture seule',accessRole:'caldav-readOnly'};
const app={accounts:[],accountColor:()=>'',status:(...x)=>statuses.push(x),confirmAction:async()=>confirm,rpc:async(method,params)=>{
  calls.push({method,params});
  if(method==='calendar.connections.list')return connections;
  if(method==='calendar.remoteCalendars.list')return params.connectionId===1?[calendar,readOnly,{...calendar,id:12,selected:false}]:[{...calendar,id:20,connectionId:2}];
  if(method==='calendar.attachments.list')return [];
  if(method==='calendar.list')return [];
  if(reject)throw new Error(reject);
  return response;
}};
const window={I18N:{locale:'fr'},crypto:webcrypto,addEventListener:()=>{}};
const ctx=vm.createContext({document,window,App:app,t:key=>key,Date,Uint8Array,console});
const expose=`\n  render = () => {};\n  window.test = {state,loadCalDavConnections,populateAccountSelects,openNewEvent,openEditor,syncEditorTargetMode,saveEvent,deleteEvent,renderSelectedDay,paneEventHtml};\n`;
assert(source.includes('  window.PlannerUI ='));
vm.runInContext(source.replace('  window.PlannerUI =',expose+'  window.PlannerUI ='),ctx);
const ui=window.test, method=()=>calls.filter(x=>x.method.startsWith('calendar.caldav.event.')).at(-1), writes=()=>calls.filter(x=>x.method.startsWith('calendar.caldav.event.')).length;
const date=new Date(2026,10,24,10,0,42);
const base={id:42,title:'Rendez-vous',startAt:date.getTime(),endAt:date.getTime()+3600000,allDay:false,location:'Paris',notes:'Note',remoteCalendarId:10,remoteCalendarName:'Personnel',remoteCalendarAccessRole:'caldav-readWrite',remoteEventId:'https://example.test/one.ics',remoteEtag:'"v1"'};
function choose(){ui.openNewEvent(date);el('planner-account').value='caldav:10';el('planner-title').value='Création';ui.syncEditorTargetMode();}
(async()=>{
  await ui.loadCalDavConnections();
  assert.deepEqual(el('planner-account').options.map(o=>o.value),['','caldav:10']);
  // Same title and time can legitimately exist in different sources. Render
  // all rows, with their true origin instead of incorrectly labeling them local.
  ui.state.selected=date;
  const remote={...base,remoteCalendarConnectionId:1};
  const local={...base,id:43,remoteCalendarId:null,remoteCalendarName:'',remoteCalendarAccessRole:'',remoteCalendarConnectionId:null};
  const ics={...local,id:44,subscriptionId:7,subscriptionName:'Flux Apple'};
  const google={...remote,id:45,remoteCalendarId:30,remoteCalendarName:'Agenda Google',remoteCalendarAccessRole:'writer',remoteCalendarConnectionId:3};
  ui.state.events=[remote,local,ics,google];
  ui.renderSelectedDay();
  const dayHtml=el('planner-day-events').innerHTML;
  assert.equal((dayHtml.match(/data-planner-day-event=/g)||[]).length,4);
  assert(dayHtml.includes('Personnel · planner.caldavApple'));
  assert(dayHtml.includes('planner.localCalendar'));
  assert(dayHtml.includes('Flux Apple · ICS'));
  assert(dayHtml.includes('Agenda Google · planner.googleCalendar'));
  assert(ui.paneEventHtml(remote).includes('Personnel · planner.caldavApple'));
  assert(ui.paneEventHtml(ics).includes('Flux Apple · ICS'));
  assert(ui.paneEventHtml(google).includes('Agenda Google · planner.googleCalendar'));
  assert(ui.paneEventHtml(local).includes('planner.localCalendar'));
  assert(ui.paneEventHtml({...google,remoteCalendarName:'Agenda <privé>',categoryName:'Travail',location:'Salle A'}).includes('Travail · Agenda &lt;privé&gt; · planner.googleCalendar · Salle A'));
  assert(ui.paneEventHtml({...ics,subscriptionName:'Flux <privé>'}).includes('Flux &lt;privé&gt; · ICS'));
  choose();assert(el('planner-category').disabled);assert(el('#planner-editor .planner-attachments-section').classList.contains('hidden'));
  reject='CalDAV: SYNC_BUSY';await ui.saveEvent();assert.equal(el('planner-form-error').textContent,'planner.caldavBusy');assert.equal(method().method,'calendar.caldav.event.create');
  const operationId=method().params.operationId;assert.match(operationId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(method().params.event).sort(),['allDay','endAt','location','notes','startAt','title']);
  reject=null;response={event:{...base,title:'Création'}};await ui.saveEvent();assert.equal(method().params.operationId,operationId);assert(el('planner-editor').classList.contains('hidden'));
  ui.openEditor(base);assert.equal(el('planner-account').value,'caldav:10');assert(el('planner-account').disabled);
  ui.state.events=[{...base,remoteEtag:'"v2"'}];await ui.loadCalDavConnections(); // refresh while editing
  el('planner-title').value='Modifié';reject='CalDAV: CONFLICT';await ui.saveEvent();assert.equal(method().method,'calendar.caldav.event.update');assert.equal(method().params.expectedEtag,'"v1"');assert.equal(method().params.event.startAt,base.startAt);assert.equal(el('planner-title').value,'Modifié');assert.equal(el('planner-form-error').textContent,'planner.caldavConflict');assert(el('btn-planner-save').disabled);
  let n=writes();await ui.saveEvent();assert.equal(writes(),n);
  ui.openEditor({...base,remoteEtag:'"v2"'});assert(!el('btn-planner-save').disabled);
  confirm=false;await ui.deleteEvent();assert.equal(writes(),n);confirm=true;reject=null;response={id:42,removed:true};await ui.deleteEvent();assert.equal(method().method,'calendar.caldav.event.remove');assert.equal(method().params.expectedEtag,'"v2"');assert.equal(method().params.confirmed,true);
  ui.openEditor({...base,remoteCalendarId:11,remoteCalendarAccessRole:'caldav-readOnly'});assert(el('btn-planner-save').classList.contains('hidden'));assert.equal(el('planner-account').value,'caldav:11');n=writes();await ui.saveEvent();await ui.deleteEvent();assert.equal(writes(),n);
  ui.openEditor({...base,remoteEventId:base.remoteEventId+'#1'});assert(el('btn-planner-save').classList.contains('hidden'));
  choose();reject='socket closed';await ui.saveEvent();assert.equal(el('planner-form-error').textContent,'planner.caldavUncertain');assert.equal(el('planner-title').value,'Création');n=writes();await ui.saveEvent();assert.equal(writes(),n);
  // A target disappearing during a refresh must not silently turn into local.
  choose();connections=[];await ui.loadCalDavConnections();assert.equal(el('planner-account').value,'caldav:10');n=writes();await ui.saveEvent();assert.equal(writes(),n);assert.equal(el('planner-form-error').textContent,'planner.caldavReadOnlyEvent');
  // Local and Google still use the original RPC, never the CalDAV path.
  ui.openNewEvent(date);el('planner-title').value='Local';reject=null;response=base;await ui.saveEvent();assert(calls.some(x=>x.method==='calendar.save'&&!x.params.event.remoteCalendarId));
  ui.state.googleConnections=[{id:3,displayName:'Google'}];ui.state.googleCalendars={3:[{id:30,selected:true,accessRole:'writer',name:'Google'}]};ui.populateAccountSelects();ui.openNewEvent(date);el('planner-account').value='google:30';el('planner-title').value='Google';ui.syncEditorTargetMode();await ui.saveEvent();assert(calls.some(x=>x.method==='calendar.save'&&x.params.event.remoteCalendarId===30));assert.equal(writes(),n);
  for(const lang of ['fr','en']){const dict=JSON.parse(fs.readFileSync(path.join(root,'resources/locales',lang+'.json'),'utf8'));for(const key of ['caldavCalendar','caldavConflict','caldavUncertain','caldavReadOnlyEvent','caldavDeleteNote'])assert.equal(typeof dict['planner.'+key],'string');}
  console.log('[OK] LibraMail 0.7.0 : routage Planning CalDAV, ETag à l’ouverture, conflit, création stable, lecture seule et non-régression locale/Google');
})().catch(e=>{console.error(e);process.exitCode=1;});
