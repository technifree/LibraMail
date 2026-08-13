#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { parseCalendarImport } = require('../engine/lib/calendar_import');

const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Agenda test\r\nBEGIN:VEVENT\r\nUID:weekly@example.test\r\nDTSTART;TZID=Europe/Paris:20260814T100000\r\nDTEND;TZID=Europe/Paris:20260814T110000\r\nRRULE:FREQ=WEEKLY;COUNT=3;BYDAY=FR\r\nEXDATE;TZID=Europe/Paris:20260828T100000\r\nSUMMARY:Réunion récurrente\r\nLOCATION:Bureau\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:weekly@example.test\r\nRECURRENCE-ID;TZID=Europe/Paris:20260821T100000\r\nDTSTART;TZID=Europe/Paris:20260821T120000\r\nDTEND;TZID=Europe/Paris:20260821T130000\r\nSUMMARY:Réunion déplacée\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:allday@example.test\r\nDTSTART;VALUE=DATE:20260815\r\nDTEND;VALUE=DATE:20260816\r\nSUMMARY:Journée entière\r\nEND:VEVENT\r\nEND:VCALENDAR`;

const imported = parseCalendarImport({ text: ics, fileName: 'agenda.ics', accountId: 'acc-test' });
assert.equal(imported.format, 'ics');
assert.equal(imported.calendarName, 'Agenda test');
assert.equal(imported.recurringSeries, 1);
assert.equal(imported.events.length, 3); // 14/08, exception du 21/08, journée du 15/08 ; 28/08 exclu.
const recurrent = imported.events.filter(event => event.title.startsWith('Réunion'));
assert.equal(recurrent.length, 2);
assert.equal(new Date(recurrent[0].startAt).toISOString(), '2026-08-14T08:00:00.000Z');
assert.equal(recurrent[1].title, 'Réunion déplacée');
assert.equal(new Date(recurrent[1].startAt).toISOString(), '2026-08-21T10:00:00.000Z');
assert.ok(recurrent.every(event => event.importKey.startsWith('ics:acc-test:weekly@example.test:')));

const csv = `Objet;Date de début;Heure de début;Date de fin;Heure de fin;Journée entière;Description;Lieu\nRendez-vous CSV;14/08/2026;10:00;14/08/2026;11:30;Non;Description test;Bordeaux\nJournée CSV;15/08/2026;;15/08/2026;;Oui;;`;
const importedCsv = parseCalendarImport({ text: csv, fileName: 'agenda.csv', locale: 'fr' });
assert.equal(importedCsv.format, 'csv');
assert.equal(importedCsv.events.length, 2);
assert.equal(importedCsv.events[0].title, 'Rendez-vous CSV');
assert.equal(importedCsv.events[1].allDay, true);
assert.ok(importedCsv.events.every(event => event.endAt > event.startAt));

console.log('[LibraMail] Tests import calendrier : OK');
