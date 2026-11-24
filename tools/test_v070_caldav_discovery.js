'use strict';
const assert = require('node:assert/strict');
const { discoverCalDav, parseMultiStatus } = require('../engine/lib/calendar_caldav_discovery');
const { createCalDavClient } = require('../engine/lib/calendar_caldav');
const D = 'DAV:', C = 'urn:ietf:params:xml:ns:caldav';
const multi = body => `<?xml version="1.0" encoding="utf-8"?><multistatus xmlns="${D}" xmlns:c="${C}" xmlns:x="urn:foreign">${body}</multistatus>`;
const ps = (props, code = 200) => `<propstat><prop>${props}</prop><status>HTTP/1.1 ${code} ${code===200?'OK':'Not Found'}</status></propstat>`;
const row = (href, ...props) => `<response><href>${href}</href>${props.join('')}</response>`;
const principal = href => multi(row('/dav/', ps(`<current-user-principal><href>${href}</href></current-user-principal>`)));
const homes = href => multi(row('/principal/', ps(`<c:calendar-home-set><href>${href}</href></c:calendar-home-set>`)));
const kind = '<resourcetype><collection/><c:calendar/></resourcetype>';
const events = '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>';
const privilege = name => `<current-user-privilege-set><privilege><${name}/></privilege></current-user-privilege-set>`;
const calendars = multi(
  row('/home/', ps('<resourcetype><collection/></resourcetype>')) +
  row('/home/one/', ps(kind+events+'<displayname>Famille &amp; amis &#x1F600;</displayname>'+privilege('write'))) +
  row('/home/two/', ps(kind+events+'<displayname><![CDATA[Anniversaires <3]]></displayname>'+privilege('read')), ps(privilege('write'),404)) +
  row('/home/unknown/', ps(kind+'<displayname>Unknown</displayname>'+privilege('x:write'))) +
  row('/home/tasks/', ps(kind+'<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>')) +
  row('/home/fake/', ps('<resourcetype><x:calendar/></resourcetype>')) +
  row('/home/failed/', ps(kind,404))
);
const response = (body, status = 207, headers) => new Response(body, {status,headers});
function setup(routes, extra = {}) {
  const calls = [];
  const config = { serverURL:'https://calendar.example/', username:'demo',password:'test-password', ...extra,
    fetchImpl: async (url, opts) => {
      calls.push({url,opts});
      assert.equal(opts.redirect,'manual');
      assert.equal(opts.method,'PROPFIND');
      assert.equal(opts.headers.Authorization,'Basic '+Buffer.from('demo:test-password').toString('base64'));
      const fn = routes[url];
      if (!fn) throw new Error('Unexpected request');
      return fn();
    }};
  return {calls,run:()=>discoverCalDav(config)};
}
(async()=>{
  const good = setup({
    'https://calendar.example/.well-known/caldav':()=>response(null,301,{location:'/dav/'}),
    'https://calendar.example/dav/':()=>response(principal('/principal/')),
    'https://calendar.example/principal/':()=>response(homes('/home/')),
    'https://calendar.example/home/':()=>response(calendars),
  });
  assert.deepEqual(await good.run(),[
    {url:'https://calendar.example/home/one/',name:'Famille & amis 😀',access:'readWrite',readOnly:false},
    {url:'https://calendar.example/home/two/',name:'Anniversaires <3',access:'readOnly',readOnly:true},
    {url:'https://calendar.example/home/unknown/',name:'Unknown',access:'unknown',readOnly:true},
  ]);
  assert.deepEqual(good.calls.map(c=>c.opts.headers.Depth),['0','0','0','1']);
  const apple = setup({
    'https://caldav.icloud.com/':()=>response(null,302,{location:'https://p42-caldav.icloud.com/dav/'}),
    'https://p42-caldav.icloud.com/dav/':()=>response(principal('/principal/')),
    'https://p42-caldav.icloud.com/principal/':()=>response(homes('https://p43-caldav.icloud.com/home/')),
    'https://p43-caldav.icloud.com/home/':()=>response(calendars),
  },{provider:'icloud',serverURL:undefined});
  assert.equal((await apple.run())[0].url,'https://p43-caldav.icloud.com/home/one/');
  assert.equal(apple.calls.length,4);
  for(const location of ['https://p42-caldav.icloud.com.evil.test/','https://evil.test/','http://p42-caldav.icloud.com/','https://p42-caldav.icloud.com:444/','https://user@p42-caldav.icloud.com/']) {
    const attack = setup({'https://caldav.icloud.com/':()=>response(null,307,{location})},{provider:'icloud',serverURL:undefined});
    await assert.rejects(attack.run(), e=>['CROSS_ORIGIN','INVALID_URL'].includes(e.code));
    assert.equal(attack.calls.length,1);
  }
  const generic = setup({'https://calendar.example/.well-known/caldav':()=>response(null,302,{location:'https://p42-caldav.icloud.com/'})});
  await assert.rejects(generic.run(),{code:'CROSS_ORIGIN'}); assert.equal(generic.calls.length,1);
  const poisoned = setup({'https://calendar.example/.well-known/caldav':()=>response(principal('https://evil.test/'))});
  await assert.rejects(poisoned.run(),{code:'CROSS_ORIGIN'}); assert.equal(poisoned.calls.length,1);
  const cycle = setup({'https://calendar.example/.well-known/caldav':()=>response(null,308,{location:'/.well-known/caldav'})});
  await assert.rejects(cycle.run(),{code:'DISCOVERY_LIMIT'}); assert.equal(cycle.calls.length,1);
  const fallback = setup({
    'https://calendar.example/.well-known/caldav':()=>response(null,404),
    'https://calendar.example/':()=>response(homes('/home/')),
    'https://calendar.example/home/':()=>response(multi('')),
  });
  assert.deepEqual(await fallback.run(),[]);
  const denied = setup({'https://calendar.example/.well-known/caldav':()=>response(null,401)});
  await assert.rejects(denied.run(),{code:'AUTHENTICATION_FAILED'}); assert.equal(denied.calls.length,1);
  for(const xml of [
    '<!DOCTYPE a [<!ENTITY ext SYSTEM "file:///etc/passwd">]>'+multi(''),
    multi(row('/x',ps('<displayname>&ext;</displayname>'))),
    multi(row('/x',ps('<displayname>&#0;</displayname>'))),
    multi('<response><href>/x</href></bad>'),
    '<x:multistatus xmlns:x="urn:foreign"/>',
    multi('<response><href>/x</href><href>/y</href></response>'),
    multi('<response><href>/x</href><propstat><prop/><status>no</status></propstat></response>'),
    multi('<a>'.repeat(50)+'</a>'.repeat(50)),
    multi('<a x="1" x="2"/>'),
    multi('<q:a/>'),
    multi(row('/x',ps('<displayname>one</displayname><displayname>two</displayname>'))),
  ]) assert.throws(()=>parseMultiStatus(xml),{code:'INVALID_DAV_XML'});
  assert.equal(parseMultiStatus('<D:multistatus xmlns:D="DAV:"><D:response><D:href>/test/</D:href></D:response></D:multistatus>')[0].href,'/test/');
  const client = createCalDavClient({serverURL:'https://caldav.icloud.com/',username:'demo',password:'test',fetchImpl:async()=>response(null,302,{location:'https://p42-caldav.icloud.com/'})});
  await assert.rejects(client.principal(),{code:'REDIRECT_BLOCKED'});
  await assert.rejects(client.get('/event.ics'),{code:'REDIRECT_BLOCKED'});
  assert.equal((await client.discovery('principal','/')).location,'https://p42-caldav.icloud.com/');
  console.log('[OK] LibraMail 0.7.0 : découverte CalDAV, namespaces, droits, redirections contrôlées et XML hostile');
})().catch(e=>{console.error(e);process.exitCode=1;});
