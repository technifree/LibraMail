'use strict';
const assert = require('node:assert/strict');
const { createCalDavClient } = require('../engine/lib/calendar_caldav');
const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:demo\r\nDTSTAMP:20261124T090000Z\r\nDTSTART:20261125T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const calls = [];
let status = 207, body = '<d:multistatus xmlns:d="DAV:"/>', headers = {};
const client = createCalDavClient({ serverURL:'https://calendar.example/dav/', username:'demo', password:'test-password',
  fetchImpl: async (url, opts) => { calls.push({url, ...opts}); return new Response([204, 304].includes(status) ? null : body, {status, headers}); } });
(async () => {
  assert.equal((await client.principal()).status,207);
  assert.equal(calls.at(-1).method,'PROPFIND');
  assert.equal(calls.at(-1).headers.Depth,'0');
  assert.match(calls.at(-1).body,/current-user-principal/);
  await client.home('/principals/demo/');
  assert.match(calls.at(-1).body,/calendar-home-set/);
  await client.calendars('/home/');
  assert.equal(calls.at(-1).headers.Depth,'1');
  await client.events('/home/calendar/');
  assert.equal(calls.at(-1).method,'REPORT');
  assert.match(calls.at(-1).body,/VEVENT/);
  assert.equal(calls.at(-1).redirect,'manual');
  assert.equal(calls.at(-1).headers.Authorization,'Basic '+Buffer.from('demo:test-password').toString('base64'));
  status=200; body=ics; headers={etag:'"v1"'};
  assert.equal((await client.get('/home/calendar/demo.ics')).etag,'"v1"');
  status=201; await client.create('/home/calendar/demo.ics',ics);
  assert.equal(calls.at(-1).headers['If-None-Match'],'*');
  status=204; await client.update('/home/calendar/demo.ics',ics,'"v1"');
  assert.equal(calls.at(-1).headers['If-Match'],'"v1"');
  await client.remove('/home/calendar/demo.ics','"v2"');
  assert.equal(calls.at(-1).method,'DELETE');
  let count=calls.length;
  for(const tag of ['', '*', 'W/"v1"', '"x"\r\nInjected: yes']) {
    assert.throws(()=>client.remove('/home/calendar/demo.ics',tag), {code:'ETAG_REQUIRED'});
  }
  assert.throws(()=>client.create('/home/calendar/demo.ics','not ICS'), {code:'INVALID_CALENDAR_DATA'});
  await assert.rejects(client.get('https://other.example/demo.ics'),{code:'CROSS_ORIGIN'});
  await assert.rejects(client.get('http://calendar.example/demo.ics'),{code:'INVALID_URL'});
  await assert.rejects(client.get('https://demo:secret@calendar.example/demo.ics'),{code:'INVALID_URL'});
  assert.equal(calls.length,count);
  for(const [s,code] of [[401,'AUTHENTICATION_FAILED'],[403,'FORBIDDEN'],[302,'REDIRECT_BLOCKED'],[412,'CONFLICT']]) {
    status=s; await assert.rejects(client.update('/home/calendar/demo.ics',ics,'"v1"'), {code,status:s});
  }
  const small=createCalDavClient({serverURL:'https://calendar.example/',username:'demo',password:'test',maxBytes:4,fetchImpl:async()=>new Response('12345')});
  await assert.rejects(small.get('/demo.ics'),{code:'RESPONSE_TOO_LARGE'});
  const broken=createCalDavClient({serverURL:'https://calendar.example/',username:'demo',password:'test',fetchImpl:async()=>{throw new Error('private secret');}});
  await assert.rejects(broken.get('/demo.ics'), error=>error.code==='NETWORK_ERROR'&&!error.message.includes('secret'));
  assert.throws(()=>createCalDavClient({serverURL:'http://calendar.example/',username:'demo',password:'test'}),{code:'INVALID_URL'});
  console.log('[OK] LibraMail 0.7.0 : transport CalDAV, découverte, lecture, écritures conditionnelles et protections');
})().catch(e=>{console.error(e);process.exitCode=1;});
