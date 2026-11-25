'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'resources/js/planner.js'),'utf8');
const html=fs.readFileSync(path.join(root,'resources/index.html'),'utf8');
for(const id of ['planner-calendar-provider','planner-provider-google','planner-provider-caldav','planner-provider-ics','planner-caldav-password','btn-planner-caldav-test','btn-planner-caldav-add'])assert(html.includes(`id="${id}"`));
assert(html.includes('data-password-toggle="planner-caldav-password"'));
class Element {
  constructor(){this.value='';this.textContent='';this.checked=true;this.disabled=false;this.dataset={};this.children={};this.options=[];const set=new Set();this.classList={add:k=>set.add(k),remove:k=>set.delete(k),contains:k=>set.has(k),toggle:(k,v)=>v?set.add(k):set.delete(k)};}
  set innerHTML(v){this._html=v;this.children={};this.options=[];}
  get innerHTML(){return this._html||'';}
  querySelector(q){return this.children[q]||null;}
  querySelectorAll(q){return this.children[q]||[];}
  setAttribute(k,v){this[k]=v;}
  focus(){}
}
const els=new Map();const el=k=>{if(!els.has(k))els.set(k,new Element());return els.get(k);};
const doc={getElementById:el,querySelector:el,querySelectorAll:()=>[],createElement:()=>new Element()};
const calls=[];let delayed=null,reject=null,connections=[],failedSync=false;
const calendars=[{url:'https://caldav.icloud.com/one/',name:'<script>unsafe</script>',readOnly:false},{url:'https://caldav.icloud.com/two/',name:'Read only',readOnly:true}];
const App={rpc:async(method,params)=>{calls.push({method,params});if(reject===method)throw Error('CalDAV: AUTHENTICATION_FAILED');if(method==='calendar.caldav.preview')return delayed||calendars;if(method==='calendar.caldav.add'){connections=[{id:7,provider:params.provider,enabled:true,email:params.username}];return{connection:connections[0]};}if(method==='calendar.caldav.sync')return{synced:failedSync?0:1,failed:failedSync?1:0};if(method==='calendar.connections.list')return connections;if(method==='calendar.remoteCalendars.list')return [];if(method==='calendar.caldav.replacePassword')return{updated:true};throw Error('unexpected '+method);},accounts:[]};
const window={addEventListener(){},I18N:{locale:'fr'}};
const ctx=vm.createContext({document:doc,window,App,t:k=>k,console,URL});
vm.runInContext(source.replace('  window.PlannerUI =',`  populateAccountSelects=()=>{}; refreshSummary=async()=>{}; loadEvents=async()=>{}; window.test={state,cdSwitch,cdTest,cdAdd,cdReset,cdInvalidate,cdBeginPassword,onEngineEvent,renderCalDavConnections,cdRenderIcsWarning};\n  window.PlannerUI =`),ctx);
const ui=window.test, cd=k=>el('planner-caldav-'+k), provider=el('planner-calendar-provider');
function fill(){cd('user').value='test@example.test';cd('password').value='test-only-secret';cd('refresh').value='15';}
function choose(){const row=new Element();row.dataset.cdChoice='0';cd('discovery').children['[data-cd-choice]:checked']=[row];cd('discovery').children['[data-cd-color="0"]']={value:'#123456'};}
(async()=>{
 provider.value='icloud';ui.cdSwitch();assert(el('planner-provider-google').classList.contains('hidden'));assert(cd('server-field').classList.contains('hidden'));
 fill();await ui.cdTest();assert.equal(calls.at(-1).params.serverURL,'https://caldav.icloud.com/');assert.equal(ui.state.caldavDiscovered.length,2);assert(cd('discovery').innerHTML.includes('&lt;script&gt;'));assert(!cd('discovery').innerHTML.includes('test-only-secret'));
 ui.cdInvalidate();assert.equal(ui.state.caldavDiscovered.length,0);await ui.cdAdd();assert(!calls.some(x=>x.method==='calendar.caldav.add'));
 await ui.cdTest();choose();failedSync=true;await ui.cdAdd();assert.equal(cd('password').value,'');assert.equal(cd('status').textContent,'planner.caldavAddedPending');const add=calls.find(x=>x.method==='calendar.caldav.add');assert.equal(add.params.selectedURLs[0],calendars[0].url);assert.equal(add.params.calendarColors[0].color,'#123456');assert.equal(calls.filter(x=>x.method==='calendar.caldav.add').length,1);
 ui.cdBeginPassword(connections[0]);assert(provider.disabled);cd('password').value='replacement';await ui.cdTest();assert.equal(cd('password').value,'');assert.equal(calls.at(-1).method,'calendar.caldav.replacePassword');
 provider.value='caldav';ui.cdSwitch();fill();cd('server').value='https://example.test/dav/';reject='calendar.caldav.preview';await ui.cdTest();assert.equal(cd('status').textContent,'planner.caldavAuthorization (AUTHENTICATION_FAILED)');reject=null;
 cd('password').type='text';const toggle=el('[data-password-toggle="planner-caldav-password"]');const icon=new Element();icon.className='fa-solid fa-eye-slash';toggle.children.i=icon;
 let resolve;delayed=new Promise(r=>resolve=r);const pending=ui.cdTest();ui.onEngineEvent('security.locked');assert.equal(cd('password').value,'');assert.equal(cd('password').type,'password');assert.equal(icon.className,'fa-solid fa-eye');assert.equal(toggle['aria-label'],'security.showPassword');resolve(calendars);await pending;assert.equal(ui.state.caldavDiscovered.length,0);assert(el('btn-planner-caldav-add').classList.contains('hidden'));
 provider.value='icloud';ui.state.caldavConnections=[{id:7,provider:'icloud',enabled:true,email:'demo'}];
 ui.state.caldavCalendars=[{id:8,connectionId:7,name:'Test',selected:true,lastStatus:'error',lastError:'DAV_RESOURCE_SELF'},{id:9,connectionId:7,name:'Other',selected:false,lastStatus:'error',lastError:'PRIVATE'}];
 ui.renderCalDavConnections();assert(cd('connections').innerHTML.includes('DAV_RESOURCE_SELF'));assert(cd('connections').innerHTML.includes('planner.caldavInactive'));assert(!cd('connections').innerHTML.includes('PRIVATE'));
 ui.state.caldavCalendars[0].lastError='UNSUPPORTED_EVENT_RRULE';ui.renderCalDavConnections();assert(cd('connections').innerHTML.includes('planner.caldavUnsupportedEvents'));assert(cd('connections').innerHTML.includes('UNSUPPORTED_EVENT_RRULE'));
 ui.state.subscriptions=[{url:'webcal://p12-caldav.icloud.com/published/private'}];ui.cdRenderIcsWarning();assert(!cd('ics-warning').classList.contains('hidden'));assert.equal(cd('ics-warning').textContent,'planner.caldavIcsWarning');assert(!cd('ics-warning').textContent.includes('private'));
 ui.state.subscriptions=[{url:'https://icloud.com.evil.test/'}];ui.cdRenderIcsWarning();assert(cd('ics-warning').classList.contains('hidden'));
 ui.state.caldavCalendars[0].cachedEventCount=2;ui.renderCalDavConnections();assert(cd('connections').innerHTML.includes('planner.caldavCachedCount'));assert(cd('connections').innerHTML.includes('data-cd-recolor="8"'));assert(cd('connections').innerHTML.includes('data-cd-calendar-sync="8"'));assert(cd('connections').innerHTML.includes('data-cd-rediscover="7"'));assert(cd('connections').innerHTML.includes('data-cd-unavailable disabled'));
 provider.value='ics';ui.cdSwitch();assert(!el('planner-provider-ics').classList.contains('hidden'));provider.value='google';ui.cdSwitch();assert(!el('planner-provider-google').classList.contains('hidden'));
 for(const lang of ['fr','en']){const dict=JSON.parse(fs.readFileSync(path.join(root,'resources/locales',lang+'.json'),'utf8'));for(const key of new Set([...source.matchAll(/['"](planner\.caldav[A-Za-z]+)['"]/g),...html.matchAll(/data-i18n="(planner\.caldav[A-Za-z]+)"/g)].map(m=>m[1])))assert.equal(typeof dict[key],'string',key+' '+lang);}
 console.log('[OK] LibraMail 0.7.0 : assistant CalDAV, découverte, couleurs, première synchronisation, verrouillage et FR/EN');
})().catch(e=>{console.error(e);process.exitCode=1;});
