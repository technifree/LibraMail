#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const dnsPromises = require('dns').promises;
const https = require('https');
const subscriptions = require('../engine/lib/calendar_subscriptions');

async function expectReject(promise, pattern) {
  await assert.rejects(promise, error => {
    assert.match(String(error?.message || error), pattern);
    return true;
  });
}

function fakeResponse(statusCode, headers = {}, body = '') {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.headers = headers;
  response.resume = () => {};
  response.send = () => {
    if (body) response.emit('data', Buffer.from(body));
    response.emit('end');
  };
  return response;
}

async function main() {
  assert.equal(
    subscriptions.normalizeSubscriptionUrl('webcal://calendar.example.test/public.ics'),
    'https://calendar.example.test/public.ics'
  );
  assert.throws(
    () => subscriptions.normalizeSubscriptionUrl('http://calendar.example.test/public.ics'),
    /HTTPS|sécurité/i
  );
  assert.throws(
    () => subscriptions.normalizeSubscriptionUrl('https://user:secret@calendar.example.test/public.ics'),
    /identifiants/i
  );

  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(subscriptions._security.isBlockedIpAddress(address), true, `${address} doit être bloquée`);
  }
  assert.equal(subscriptions._security.isBlockedIpAddress('8.8.8.8'), false);
  assert.equal(subscriptions._security.isBlockedIpAddress('2001:4860:4860::8888'), false);

  await expectReject(
    subscriptions.fetchCalendar('https://127.0.0.1/private.ics', { timeoutMs: 3000 }),
    /privée|locale|réservée/i
  );
  await expectReject(
    subscriptions.fetchCalendar('https://localhost/private.ics', { timeoutMs: 3000 }),
    /locale/i
  );

  const originalLookup = dnsPromises.lookup;
  const originalRequest = https.request;
  try {
    let requestCount = 0;
    dnsPromises.lookup = async hostname => {
      if (hostname === 'calendar.example.test') return [{ address: '93.184.216.34', family: 4 }];
      throw new Error(`Résolution inattendue : ${hostname}`);
    };

    https.request = (url, options, callback) => {
      requestCount += 1;
      const request = new EventEmitter();
      request.end = () => {
        const response = fakeResponse(302, { location: 'https://127.0.0.1/internal.ics' });
        callback(response);
      };
      request.destroy = () => {};
      return request;
    };

    await expectReject(
      subscriptions.fetchCalendar('https://calendar.example.test/start.ics', { timeoutMs: 3000 }),
      /privée|locale|réservée/i
    );
    assert.equal(requestCount, 1, 'la redirection privée doit être bloquée avant une deuxième requête');

    requestCount = 0;
    const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
    https.request = (url, options, callback) => {
      requestCount += 1;
      const request = new EventEmitter();
      request.destroy = () => {};
      request.end = () => {
        const response = fakeResponse(200, {
          'content-type': 'text/calendar',
          etag: '"v1"',
          'content-length': String(Buffer.byteLength(ics)),
        }, ics);
        callback(response);
        process.nextTick(() => response.send());
      };
      return request;
    };
    const fetched = await subscriptions.fetchCalendar('https://calendar.example.test/public.ics', { timeoutMs: 3000 });
    assert.equal(fetched.notModified, false);
    assert.equal(fetched.etag, '"v1"');
    assert.ok(fetched.text.includes('BEGIN:VCALENDAR'));
    assert.equal(requestCount, 1);
  } finally {
    dnsPromises.lookup = originalLookup;
    https.request = originalRequest;
  }

  console.log('[LibraMail] Test sécurité SSRF abonnements calendrier 0.5.1 : OK');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
