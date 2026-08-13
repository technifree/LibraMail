#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const db = require('../engine/lib/db');
const { parseCalendarImport } = require('../engine/lib/calendar_import');
const subscriptions = require('../engine/lib/calendar_subscriptions');

async function testFetch() {
  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:http@example.test\r\nDTSTART:20260814T100000Z\r\nDTEND:20260814T110000Z\r\nSUMMARY:HTTP\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  const server = http.createServer((req, res) => {
    if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304, { ETag: '"v1"' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/calendar', ETag: '"v1"' });
    res.end(ics);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const first = await subscriptions.fetchCalendar(`http://127.0.0.1:${port}/calendar.ics`);
    assert.equal(first.notModified, false);
    assert.ok(first.text.includes('BEGIN:VCALENDAR'));
    assert.equal(first.etag, '"v1"');
    const second = await subscriptions.fetchCalendar(`http://127.0.0.1:${port}/calendar.ics`, { etag: first.etag });
    assert.equal(second.notModified, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-calendar-sub-'));
  try {
    db.init(tmp);
    assert.equal(subscriptions.normalizeSubscriptionUrl('webcal://example.test/calendar.ics'), 'https://example.test/calendar.ics');
    const sub = db.saveCalendarSubscription({ name: 'Agenda test', url: 'https://example.test/calendar.ics', color: '#e65c00' });
    assert.ok(sub.id > 0);
    const ics1 = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a@example.test\r\nDTSTART:20260814T100000Z\r\nDTEND:20260814T110000Z\r\nSUMMARY:A\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b@example.test\r\nDTSTART:20260815T100000Z\r\nDTEND:20260815T110000Z\r\nSUMMARY:B\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    const parsed1 = parseCalendarImport({ text: ics1, fileName: 'calendar.ics', color: sub.color, importNamespace: `sub-${sub.id}` });
    const first = db.syncCalendarSubscriptionEvents(sub.id, parsed1.events);
    assert.equal(first.created, 2);
    assert.equal(db.listCalendarEvents({}).length, 2);
    assert.ok(db.listCalendarEvents({}).every(event => event.subscriptionId === sub.id));
    assert.ok(db.listCalendarEvents({}).every(event => event.color === '#E65C00'));
    const changed = db.saveCalendarSubscription({ ...sub, color: '#7b61d1', accountId: 'account-test' }, sub.id);
    db.updateCalendarSubscriptionEventsPresentation(sub.id, { color: changed.color, accountId: changed.accountId });
    assert.ok(db.listCalendarEvents({}).every(event => event.color === '#7B61D1' && event.accountId === 'account-test'));

    const ics2 = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a@example.test\r\nDTSTART:20260814T120000Z\r\nDTEND:20260814T130000Z\r\nSUMMARY:A déplacé\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    const parsed2 = parseCalendarImport({ text: ics2, fileName: 'calendar.ics', color: changed.color, accountId: changed.accountId, importNamespace: `sub-${sub.id}` });
    const second = db.syncCalendarSubscriptionEvents(sub.id, parsed2.events);
    assert.equal(second.updated, 1);
    assert.equal(second.removed, 1);
    const rows = db.listCalendarEvents({});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'A déplacé');

    const removed = db.removeCalendarSubscription(sub.id);
    assert.equal(removed.removed, true);
    assert.equal(db.listCalendarEvents({}).length, 0);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  await testFetch();
  console.log('[LibraMail] Tests abonnements calendrier : OK');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
