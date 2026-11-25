'use strict';
const assert=require('node:assert/strict');
const {project}=require('../engine/lib/calendar_caldav_sync');
const href='https://example.test/cal/series.ics',tag='"fixture"',now=Date.UTC(2026,10,24);
const at=(day,h=10)=>Date.UTC(2026,10,day,h);
const comp=(...lines)=>['BEGIN:VEVENT','UID:fixture',...lines,'END:VEVENT'];
const master=(...lines)=>comp('DTSTART:20261124T100000Z','DTEND:20261124T110000Z','SUMMARY:Master','RRULE:FREQ=DAILY;COUNT=4',...lines);
const override=(rid,...lines)=>comp('RECURRENCE-ID:'+rid,...lines);
const move=override('20261125T100000Z','DTSTART:20261129T140000Z','DTEND:20261129T150000Z','SUMMARY:Moved');
const cancel=override('20261126T100000Z','STATUS:CANCELLED');
const run=(...components)=>project(['BEGIN:VCALENDAR','VERSION:2.0',...components.flat(),'END:VCALENDAR'].join('\r\n'),href,tag,now).items;
const original=run(master());
assert.deepEqual(original.map(x=>x.startAt),[24,25,26,27].map(d=>at(d)));
const changed=run(move,master('EXDATE:20261125T100000Z,20261127T100000Z','EXDATE:20261127T100000Z','RDATE:20261128T100000Z,20261124T100000Z'),cancel);
assert.deepEqual(changed.map(x=>x.startAt),[at(24),at(28),at(29,14)]);
assert.equal(changed[2].remoteEventId,original[1].remoteEventId);assert.equal(changed[2].title,'Moved');assert.equal(changed[2].remoteEtag,tag);
assert.equal(new Set(changed.map(x=>x.remoteEventId)).size,3);
assert.deepEqual(run(master(),cancel,move).map(x=>x.remoteEventId),[href+'#'+at(24),href+'#'+at(27),href+'#'+at(25)]);
assert.deepEqual(run(comp('DTSTART:20261124T100000Z','DTEND:20261124T110000Z','RDATE;VALUE=DATE-TIME:20261125T100000Z,20261125T100000Z','EXDATE:20261124T100000Z')).map(x=>x.remoteEventId),[href+'#'+at(25)]);
assert.equal(run(master('EXDATE:20261124T100000Z,20261125T100000Z,20261126T100000Z,20261127T100000Z')).length,0);
assert.equal(run(master('STATUS:CANCELLED'),move).length,0);
const all=run(comp('DTSTART;VALUE=DATE:20260328','DTEND;VALUE=DATE:20260330','RRULE:FREQ=DAILY;COUNT=3','EXDATE;VALUE=DATE:20260329','RDATE;VALUE=DATE:20260401'),comp('RECURRENCE-ID;VALUE=DATE:20260330','DTSTART;VALUE=DATE:20260403','DTEND;VALUE=DATE:20260405','SUMMARY:Moved day'));
assert.deepEqual(all.map(x=>new Date(x.startAt).getDate()),[28,1,3]);
assert(all.every(x=>{const d=new Date(x.startAt);d.setDate(d.getDate()+2);return x.allDay&&x.endAt===d.getTime();}));
assert.equal(all[2].remoteEventId,href+'#'+new Date(2026,2,30).getTime());
const zoned=run(comp('DTSTART;TZID=Europe/Paris:20260328T090000','DTEND;TZID=Europe/Paris:20260328T100000','RRULE:FREQ=DAILY;COUNT=3','EXDATE;TZID=Europe/Paris:20260329T090000'),comp('RECURRENCE-ID;TZID=Europe/Paris:20260330T090000','DTSTART;TZID=Europe/Paris:20260330T140000','DTEND;TZID=Europe/Paris:20260330T150000','SUMMARY:Moved DST'));
assert.deepEqual(zoned.map(x=>x.startAt),[Date.UTC(2026,2,28,8),Date.UTC(2026,2,30,12)]);assert.equal(zoned[1].remoteEventId,href+'#'+Date.UTC(2026,2,30,7));
// A historic occurrence moved inside the bounded display window, including BYSETPOS.
const old=run(comp('DTSTART:20100129T100000Z','DTEND:20100129T110000Z','RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'),override('20100226T100000Z','DTSTART:20261129T140000Z','DTEND:20261129T150000Z','SUMMARY:Historic move'));
assert.equal(old.find(x=>x.title==='Historic move').remoteEventId,href+'#'+Date.UTC(2010,1,26,10));
for(const components of [[master(),move,move],[master(),override('20261128T100000Z','STATUS:CANCELLED')],[master(),comp('RECURRENCE-ID;RANGE=THISANDFUTURE:20261125T100000Z','STATUS:CANCELLED')],[master('RDATE;VALUE=PERIOD:20261128T100000Z/20261128T110000Z')],[master('EXDATE;VALUE=DATE:20261125')],[master(),override('20261125T100000Z','RRULE:FREQ=DAILY','STATUS:CANCELLED')],[master(),comp('RECURRENCE-ID:20261125T100000Z','UID:other','STATUS:CANCELLED')],[move],[master(),master()]]){
  assert.throws(()=>run(...components),e=>e.code==='UNSUPPORTED_EVENT');
}
console.log('[OK] LibraMail 0.7.0 : exceptions CalDAV, RDATE, EXDATE, RECURRENCE-ID, annulations, DST et identifiants stables');
