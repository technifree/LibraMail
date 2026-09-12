#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../engine/lib/db');
const { parseCalendarImport } = require('../engine/lib/calendar_import');
const subscriptions = require('../engine/lib/calendar_subscriptions');

async function testFetchSecurityBoundary() {
  await assert.rejects(
    subscriptions.fetchCalendar('http://127.0.0.1/calendar.ics', { timeoutMs: 3000 }),
    /HTTPS|sécurité/i
  );
  await assert.rejects(
    subscriptions.fetchCalendar('https://127.0.0.1/calendar.ics', { timeoutMs: 3000 }),
    /privée|locale|réservée/i
  );
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-calendar-sub-'));
  try {
    db.init(tmp);
    assert.equal(subscriptions.normalizeSubscriptionUrl('webcal://example.test/calendar.ics'), 'https://example.test/calendar.ics');
    const sub = db.saveCalendarSubscription({ name: 'Agenda test', url: 'https://example.test/calendar.ics', color: '#e65c00', refreshMinutes: 15 });
    assert.ok(sub.id > 0);
    assert.equal(sub.refreshMinutes, 15);
    const ics1 = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a@example.test\r\nDTSTART:20260814T100000Z\r\nDTEND:20260814T110000Z\r\nSUMMARY:A\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b@example.test\r\nDTSTART:20260815T100000Z\r\nDTEND:20260815T110000Z\r\nSUMMARY:B\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    const parsed1 = parseCalendarImport({ text: ics1, fileName: 'calendar.ics', color: sub.color, importNamespace: `sub-${sub.id}` });
    const first = db.syncCalendarSubscriptionEvents(sub.id, parsed1.events);
    assert.equal(first.created, 2);
    assert.equal(db.listCalendarEvents({}).length, 2);
    assert.ok(db.listCalendarEvents({}).every(event => event.subscriptionId === sub.id));
    assert.ok(db.listCalendarEvents({}).every(event => event.color === '#E65C00'));
    const changed = db.saveCalendarSubscription({ ...sub, color: '#7b61d1', accountId: 'account-test', refreshMinutes: 120 }, sub.id);
    assert.equal(changed.refreshMinutes, 120);
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

    const unchanged = db.syncCalendarSubscriptionEvents(sub.id, parsed2.events);
    assert.equal(unchanged.created, 0);
    assert.equal(unchanged.updated, 0);
    assert.equal(unchanged.unchanged, 1);
    assert.equal(unchanged.removed, 0);

    const removed = db.removeCalendarSubscription(sub.id);
    assert.equal(removed.removed, true);
    assert.equal(db.listCalendarEvents({}).length, 0);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  await testFetchSecurityBoundary();
  console.log('[LibraMail] Tests abonnements calendrier : OK');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
