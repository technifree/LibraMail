/**
 * LibraMail — Import de calendriers (iCalendar/vCalendar/CSV)
 *
 * Le parseur reste volontairement sans dépendance externe afin que les paquets
 * portables LibraMail conservent leur caractère autonome.
 */
'use strict';

const crypto = require('crypto');

const MAX_IMPORTED_EVENTS = 20000;
const MAX_RECURRENCES_PER_SERIES = 8000;
const UNBOUNDED_PAST_YEARS = 3;
const UNBOUNDED_FUTURE_YEARS = 10;

function hash(value) {
  return crypto.createHash('sha1').update(String(value || ''), 'utf8').digest('hex');
}

function decodeIcsText(value) {
  return String(value || '')
    .replace(/\\[nN]/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function unfoldIcs(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function splitPropertyLine(line) {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    if (ch === ':' && !quoted) { colon = i; break; }
  }
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const chunks = left.split(';');
  const name = String(chunks.shift() || '').trim().toUpperCase();
  const params = {};
  for (const chunk of chunks) {
    const eq = chunk.indexOf('=');
    if (eq < 0) continue;
    const key = chunk.slice(0, eq).trim().toUpperCase();
    let paramValue = chunk.slice(eq + 1).trim();
    if (paramValue.startsWith('"') && paramValue.endsWith('"')) paramValue = paramValue.slice(1, -1);
    params[key] = paramValue;
  }
  return { name, params, value };
}

function localPartsToEpoch(parts) {
  return new Date(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0, 0).getTime();
}

function zonedPartsAt(timestamp, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const values = {};
  for (const part of formatter.formatToParts(new Date(timestamp))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year, month: values.month, day: values.day,
    hour: values.hour || 0, minute: values.minute || 0, second: values.second || 0,
  };
}

function zonedPartsToEpoch(parts, timeZone) {
  if (!timeZone) return localPartsToEpoch(parts);
  let guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0, 0);
  try {
    // Convergence en quelques itérations, y compris autour des changements DST.
    for (let i = 0; i < 4; i += 1) {
      const actual = zonedPartsAt(guess, timeZone);
      const desiredUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0, 0);
      const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour || 0, actual.minute || 0, actual.second || 0, 0);
      const delta = desiredUtc - actualUtc;
      guess += delta;
      if (!delta) break;
    }
    return guess;
  } catch {
    // Certains exports Outlook utilisent des TZID Windows ou privés. Dans ce
    // cas on conserve l'heure murale plutôt que d'abandonner le rendez-vous.
    return localPartsToEpoch(parts);
  }
}

function parseIcsDateValue(value, params = {}) {
  const raw = String(value || '').trim();
  const dateOnly = params.VALUE?.toUpperCase() === 'DATE' || /^\d{8}$/.test(raw);
  let match;
  if (dateOnly) {
    match = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!match) return null;
    const parts = { year: +match[1], month: +match[2], day: +match[3], hour: 0, minute: 0, second: 0 };
    return { timestamp: localPartsToEpoch(parts), parts, allDay: true, tzid: '', utc: false, raw };
  }
  match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i);
  if (!match) return null;
  const parts = {
    year: +match[1], month: +match[2], day: +match[3],
    hour: +match[4], minute: +match[5], second: +(match[6] || 0),
  };
  const utc = Boolean(match[7]);
  const tzid = utc ? '' : String(params.TZID || '').replace(/^"|"$/g, '');
  const timestamp = utc
    ? Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0)
    : zonedPartsToEpoch(parts, tzid);
  return { timestamp, parts, allDay: false, tzid, utc, raw };
}

function addCalendarDays(parts, days) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour || 0, parts.minute || 0, parts.second || 0));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: parts.hour || 0, minute: parts.minute || 0, second: parts.second || 0 };
}

function addCalendarMonths(parts, months) {
  const targetMonth = (parts.month - 1) + months;
  const year = parts.year + Math.floor(targetMonth / 12);
  const monthIndex = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return { ...parts, year, month: monthIndex + 1, day: Math.min(parts.day, lastDay) };
}

function weekdayOf(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

const WEEKDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseByDay(token) {
  const match = String(token || '').trim().toUpperCase().match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);
  if (!match) return null;
  return { ordinal: match[1] ? Number(match[1]) : null, weekday: WEEKDAY[match[2]] };
}

function nthWeekdayOfMonth(year, month, weekday, ordinal) {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (ordinal > 0) {
    const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const day = 1 + ((weekday - firstWeekday + 7) % 7) + (ordinal - 1) * 7;
    return day <= daysInMonth ? day : null;
  }
  const lastWeekday = new Date(Date.UTC(year, month - 1, daysInMonth)).getUTCDay();
  const day = daysInMonth - ((lastWeekday - weekday + 7) % 7) - (Math.abs(ordinal) - 1) * 7;
  return day >= 1 ? day : null;
}

function parseDuration(value) {
  const match = String(value || '').trim().match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!match) return null;
  return (((+(match[1] || 0) * 7 + +(match[2] || 0)) * 24 + +(match[3] || 0)) * 60 + +(match[4] || 0)) * 60 * 1000 + +(match[5] || 0) * 1000;
}

function parseRRule(value, startSpec) {
  const rule = {};
  for (const part of String(value || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    rule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  const until = rule.UNTIL ? parseIcsDateValue(rule.UNTIL, rule.UNTIL.length === 8 ? { VALUE: 'DATE' } : {}) : null;
  return {
    freq: String(rule.FREQ || '').toUpperCase(),
    interval: Math.max(1, Number(rule.INTERVAL) || 1),
    count: Math.max(0, Number(rule.COUNT) || 0),
    untilAt: until?.timestamp || null,
    byDay: String(rule.BYDAY || '').split(',').map(parseByDay).filter(Boolean),
    byMonthDay: String(rule.BYMONTHDAY || '').split(',').map(Number).filter(Number.isFinite),
    byMonth: String(rule.BYMONTH || '').split(',').map(Number).filter(value => value >= 1 && value <= 12),
    bySetPos: String(rule.BYSETPOS || '').split(',').map(Number).filter(Number.isFinite),
    wkst: WEEKDAY[String(rule.WKST || 'MO').toUpperCase()] ?? 1,
    startSpec,
  };
}

function occurrenceEpoch(parts, spec) {
  if (spec.utc) return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0, 0);
  return zonedPartsToEpoch(parts, spec.tzid || '');
}

function uniqueParts(items) {
  const seen = new Set();
  return items.filter(parts => {
    const key = `${parts.year}-${parts.month}-${parts.day}-${parts.hour || 0}-${parts.minute || 0}-${parts.second || 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function monthlyCandidates(base, rule, monthOffset) {
  const monthBase = addCalendarMonths({ ...base, day: 1 }, monthOffset);
  const { year, month } = monthBase;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const candidates = [];
  if (rule.byMonth.length && !rule.byMonth.includes(month)) return candidates;

  if (rule.byMonthDay.length) {
    for (const rawDay of rule.byMonthDay) {
      const day = rawDay > 0 ? rawDay : daysInMonth + rawDay + 1;
      if (day >= 1 && day <= daysInMonth) candidates.push({ ...base, year, month, day });
    }
  } else if (rule.byDay.length) {
    const ordinalDays = rule.byDay.filter(item => item.ordinal);
    if (ordinalDays.length) {
      for (const item of ordinalDays) {
        const day = nthWeekdayOfMonth(year, month, item.weekday, item.ordinal);
        if (day) candidates.push({ ...base, year, month, day });
      }
    } else {
      for (let day = 1; day <= daysInMonth; day += 1) {
        const parts = { ...base, year, month, day };
        if (rule.byDay.some(item => item.weekday === weekdayOf(parts))) candidates.push(parts);
      }
    }
  } else if (base.day <= daysInMonth) {
    candidates.push({ ...base, year, month, day: base.day });
  }

  const sorted = uniqueParts(candidates).sort((a, b) => a.day - b.day);
  if (!rule.bySetPos.length) return sorted;
  const selected = [];
  for (const pos of rule.bySetPos) {
    const index = pos > 0 ? pos - 1 : sorted.length + pos;
    if (sorted[index]) selected.push(sorted[index]);
  }
  return uniqueParts(selected);
}

function yearlyCandidates(base, rule, yearOffset) {
  const year = base.year + yearOffset;
  const months = rule.byMonth.length ? rule.byMonth : [base.month];
  const candidates = [];
  for (const month of months) {
    const monthRule = { ...rule, byMonth: [month] };
    candidates.push(...monthlyCandidates({ ...base, year, month }, monthRule, 0));
  }
  return uniqueParts(candidates).sort((a, b) => a.month - b.month || a.day - b.day);
}

function recurrenceCandidates(base, rule, step) {
  switch (rule.freq) {
    case 'DAILY': {
      const parts = addCalendarDays(base, step * rule.interval);
      if (rule.byDay.length && !rule.byDay.some(item => item.weekday === weekdayOf(parts))) return [];
      if (rule.byMonth.length && !rule.byMonth.includes(parts.month)) return [];
      if (rule.byMonthDay.length) {
        const dim = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
        const allowed = rule.byMonthDay.map(day => day > 0 ? day : dim + day + 1);
        if (!allowed.includes(parts.day)) return [];
      }
      return [parts];
    }
    case 'WEEKLY': {
      const weekStart = addCalendarDays(base, -((weekdayOf(base) - rule.wkst + 7) % 7) + step * rule.interval * 7);
      const days = rule.byDay.length ? rule.byDay.map(item => item.weekday) : [weekdayOf(base)];
      return [...new Set(days)].sort((a, b) => ((a - rule.wkst + 7) % 7) - ((b - rule.wkst + 7) % 7)).map(weekday => {
        const offset = (weekday - rule.wkst + 7) % 7;
        const day = addCalendarDays(weekStart, offset);
        return { ...day, hour: base.hour, minute: base.minute, second: base.second };
      });
    }
    case 'MONTHLY':
      return monthlyCandidates(base, rule, step * rule.interval);
    case 'YEARLY':
      return yearlyCandidates(base, rule, step * rule.interval);
    default:
      return step === 0 ? [base] : [];
  }
}

function expandRecurrence(event, now = Date.now()) {
  if (!event.rrule || !event.startSpec) return [event];
  const rule = parseRRule(event.rrule, event.startSpec);
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq)) return [event];

  const base = event.startSpec.parts;
  const hasFiniteEnd = rule.count > 0 || Number.isFinite(rule.untilAt);
  const pastLimit = new Date(now);
  pastLimit.setFullYear(pastLimit.getFullYear() - UNBOUNDED_PAST_YEARS);
  const futureLimit = new Date(now);
  futureLimit.setFullYear(futureLimit.getFullYear() + UNBOUNDED_FUTURE_YEARS);
  const minAt = hasFiniteEnd ? -Infinity : pastLimit.getTime();
  const maxAt = rule.untilAt || (hasFiniteEnd && rule.count ? Infinity : futureLimit.getTime());
  const duration = Math.max(1, event.endAt - event.startAt);
  const allDayDurationDays = Math.max(1, Number(event.allDayDurationDays) || 1);
  const excluded = new Set(event.exdates || []);
  const output = [];
  let generated = 0;
  let step = 0;
  let stop = false;

  while (!stop && step < MAX_RECURRENCES_PER_SERIES * 2) {
    const candidates = recurrenceCandidates(base, rule, step);
    if (!candidates.length && step > MAX_RECURRENCES_PER_SERIES) break;
    for (const parts of candidates) {
      const startAt = occurrenceEpoch(parts, event.startSpec);
      if (startAt < event.startAt) continue;
      if (Number.isFinite(rule.untilAt) && startAt > rule.untilAt) { stop = true; break; }
      generated += 1;
      if (rule.count && generated > rule.count) { stop = true; break; }
      if (startAt > maxAt) { stop = true; break; }
      if (startAt < minAt || excluded.has(startAt)) continue;
      const endAt = event.allDay
        ? occurrenceEpoch(addCalendarDays(parts, allDayDurationDays), event.startSpec)
        : startAt + duration;
      output.push({ ...event, startAt, endAt, recurrenceStartAt: startAt });
      if (output.length >= MAX_RECURRENCES_PER_SERIES) { stop = true; break; }
    }
    step += 1;
    if (!rule.count && !rule.untilAt && step > MAX_RECURRENCES_PER_SERIES) break;
  }

  return output.length ? output : (event.startAt >= minAt && event.startAt <= maxAt ? [event] : []);
}

function collectIcsEvents(text) {
  const lines = unfoldIcs(text).split('\n');
  const calendar = { name: '', color: '' };
  const rawEvents = [];
  let current = null;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.toUpperCase() === 'BEGIN:VEVENT') { current = { props: [] }; continue; }
    if (line.toUpperCase() === 'END:VEVENT') { if (current) rawEvents.push(current); current = null; continue; }
    const prop = splitPropertyLine(line);
    if (!prop) continue;
    if (current) current.props.push(prop);
    else {
      if (['X-WR-CALNAME', 'NAME'].includes(prop.name) && !calendar.name) calendar.name = decodeIcsText(prop.value);
      if (['X-APPLE-CALENDAR-COLOR', 'COLOR'].includes(prop.name) && !calendar.color) calendar.color = String(prop.value || '').trim().slice(0, 7);
    }
  }
  return { calendar, rawEvents };
}

function propsByName(rawEvent) {
  const map = new Map();
  for (const prop of rawEvent.props || []) {
    if (!map.has(prop.name)) map.set(prop.name, []);
    map.get(prop.name).push(prop);
  }
  return map;
}

function firstProp(map, name) { return map.get(name)?.[0] || null; }

function normalizeIcsEvent(rawEvent, calendar, sourceName, accountId, fallbackColor) {
  const props = propsByName(rawEvent);
  const startProp = firstProp(props, 'DTSTART');
  if (!startProp) return null;
  const startSpec = parseIcsDateValue(startProp.value, startProp.params);
  if (!startSpec) return null;
  const endProp = firstProp(props, 'DTEND');
  const durationProp = firstProp(props, 'DURATION');
  let endSpec = endProp ? parseIcsDateValue(endProp.value, endProp.params) : null;
  let endAt = endSpec?.timestamp;
  if (!Number.isFinite(endAt) && durationProp) endAt = startSpec.timestamp + (parseDuration(durationProp.value) || 0);
  if (!Number.isFinite(endAt) || endAt <= startSpec.timestamp) {
    endAt = startSpec.timestamp + (startSpec.allDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000);
  }
  const summary = decodeIcsText(firstProp(props, 'SUMMARY')?.value || '(sans titre)').trim() || '(sans titre)';
  const uid = decodeIcsText(firstProp(props, 'UID')?.value || '').trim();
  const recurrenceIdProp = firstProp(props, 'RECURRENCE-ID');
  const recurrenceSpec = recurrenceIdProp ? parseIcsDateValue(recurrenceIdProp.value, recurrenceIdProp.params) : null;
  const exdates = [];
  for (const prop of props.get('EXDATE') || []) {
    for (const value of String(prop.value || '').split(',')) {
      const parsed = parseIcsDateValue(value, prop.params);
      if (parsed) exdates.push(parsed.timestamp);
    }
  }
  const colorRaw = String(firstProp(props, 'COLOR')?.value || calendar.color || fallbackColor || '').trim();
  const color = /^#[0-9a-fA-F]{6}$/.test(colorRaw) ? colorRaw.toUpperCase() : '';
  let allDayDurationDays = 1;
  if (startSpec.allDay && endSpec?.allDay) {
    const startDay = Date.UTC(startSpec.parts.year, startSpec.parts.month - 1, startSpec.parts.day);
    const endDay = Date.UTC(endSpec.parts.year, endSpec.parts.month - 1, endSpec.parts.day);
    allDayDurationDays = Math.max(1, Math.round((endDay - startDay) / (24 * 60 * 60 * 1000)));
  } else if (startSpec.allDay && durationProp) {
    allDayDurationDays = Math.max(1, Math.round((parseDuration(durationProp.value) || 0) / (24 * 60 * 60 * 1000)));
  }
  return {
    title: summary.slice(0, 240),
    startAt: startSpec.timestamp,
    endAt,
    allDay: startSpec.allDay,
    location: decodeIcsText(firstProp(props, 'LOCATION')?.value || '').trim().slice(0, 500),
    notes: decodeIcsText(firstProp(props, 'DESCRIPTION')?.value || '').trim().slice(0, 20000),
    accountId: accountId || '',
    color,
    uid: uid || hash(`${sourceName}|${summary}|${startSpec.timestamp}|${endAt}`),
    recurrenceIdAt: recurrenceSpec?.timestamp || null,
    rrule: firstProp(props, 'RRULE')?.value || '',
    exdates,
    startSpec,
    allDayDurationDays,
    status: String(firstProp(props, 'STATUS')?.value || '').trim().toUpperCase(),
  };
}

function parseIcs(text, { fileName = '', accountId = '', color = '', importNamespace = '' } = {}) {
  const { calendar, rawEvents } = collectIcsEvents(text);
  const normalized = rawEvents.map(raw => normalizeIcsEvent(raw, calendar, fileName, accountId, color)).filter(Boolean);
  const grouped = new Map();
  for (const event of normalized) {
    if (!grouped.has(event.uid)) grouped.set(event.uid, []);
    grouped.get(event.uid).push(event);
  }

  const namespace = String(importNamespace || accountId || 'local').trim() || 'local';
  const events = [];
  let recurringSeries = 0;
  let cancelled = 0;
  for (const [uid, items] of grouped) {
    const base = items.find(item => !item.recurrenceIdAt) || null;
    const exceptions = new Map(items.filter(item => item.recurrenceIdAt).map(item => [item.recurrenceIdAt, item]));
    if (!base) {
      for (const exception of items) {
        if (exception.status === 'CANCELLED') { cancelled += 1; continue; }
        events.push({ ...exception, importKey: `ics:${namespace}:${uid}:${exception.recurrenceIdAt || exception.startAt}` });
      }
      continue;
    }
    if (base.status === 'CANCELLED') { cancelled += 1; continue; }
    const occurrences = base.rrule ? expandRecurrence(base) : [base];
    if (base.rrule) recurringSeries += 1;
    for (const occurrence of occurrences) {
      const occurrenceKey = occurrence.recurrenceStartAt || occurrence.startAt;
      const exception = exceptions.get(occurrenceKey);
      if (exception?.status === 'CANCELLED') { cancelled += 1; exceptions.delete(occurrenceKey); continue; }
      const chosen = exception || occurrence;
      if (exception) exceptions.delete(occurrenceKey);
      const importOccurrenceKey = base.rrule ? occurrenceKey : 'single';
      events.push({ ...chosen, importKey: `ics:${namespace}:${uid}:${importOccurrenceKey}` });
      if (events.length >= MAX_IMPORTED_EVENTS) break;
    }
    if (events.length >= MAX_IMPORTED_EVENTS) break;
    for (const [recurrenceAt, exception] of exceptions) {
      if (exception.status === 'CANCELLED') { cancelled += 1; continue; }
      events.push({ ...exception, importKey: `ics:${namespace}:${uid}:${recurrenceAt}` });
      if (events.length >= MAX_IMPORTED_EVENTS) break;
    }
    if (events.length >= MAX_IMPORTED_EVENTS) break;
  }

  return {
    format: 'ics',
    calendarName: calendar.name || '',
    events: events.map(({ uid, recurrenceIdAt, rrule, exdates, startSpec, allDayDurationDays, status, recurrenceStartAt, ...event }) => event),
    recurringSeries,
    cancelled,
    truncated: events.length >= MAX_IMPORTED_EVENTS,
  };
}

function detectDelimiter(firstLine) {
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = -1;
  for (const delimiter of candidates) {
    let count = 0;
    let quoted = false;
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted;
      else if (ch === delimiter && !quoted) count += 1;
    }
    if (count > bestCount) { best = delimiter; bestCount = count; }
  }
  return best;
}

function parseCsvRows(text) {
  const normalized = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const firstLine = normalized.split('\n')[0] || '';
  const delimiter = detectDelimiter(firstLine);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === '"') {
      if (quoted && normalized[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = !quoted;
      continue;
    }
    if (ch === delimiter && !quoted) { row.push(field); field = ''; continue; }
    if (ch === '\n' && !quoted) {
      row.push(field); field = '';
      if (row.some(value => String(value).trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  row.push(field);
  if (row.some(value => String(value).trim() !== '')) rows.push(row);
  return rows;
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[._-]+/g, ' ').replace(/\s+/g, ' ');
}

const CSV_HEADERS = {
  title: ['subject', 'objet', 'title', 'titre', 'summary', 'evenement', 'event'],
  startDate: ['start date', 'date de debut', 'date debut', 'debut date'],
  startTime: ['start time', 'heure de debut', 'heure debut', 'debut heure'],
  endDate: ['end date', 'date de fin', 'fin date'],
  endTime: ['end time', 'heure de fin', 'fin heure'],
  start: ['start', 'debut', 'date heure debut', 'date/heure debut'],
  end: ['end', 'fin', 'date heure fin', 'date/heure fin'],
  allDay: ['all day event', 'all day', 'journee entiere', 'toute la journee', 'jour entier'],
  location: ['location', 'emplacement', 'lieu'],
  notes: ['description', 'notes', 'note', 'details', 'detail'],
};

function columnIndex(headers, names) {
  for (const name of names) {
    const index = headers.indexOf(name);
    if (index >= 0) return index;
  }
  return -1;
}

function csvTruthy(value) {
  return /^(1|true|yes|oui|o|vrai|x)$/i.test(String(value || '').trim());
}

function parseClock(value) {
  const raw = String(value || '').trim();
  if (!raw) return { hour: 0, minute: 0, second: 0 };
  let match = raw.match(/^(\d{1,2})[:h](\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  let hour, minute, second, ampm;
  if (match) {
    hour = Number(match[1]);
    minute = Number(match[2] || 0);
    second = Number(match[3] || 0);
    ampm = String(match[4] || '').toUpperCase();
  } else {
    match = raw.match(/^(\d{1,2})\s*(AM|PM)$/i);
    if (!match) return null;
    hour = Number(match[1]);
    minute = 0;
    second = 0;
    ampm = String(match[2] || '').toUpperCase();
  }
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

function parseCsvDate(value, preferDmy = true) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) return { year: +match[1], month: +match[2], day: +match[3] };
  match = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (match) {
    let first = +match[1];
    let second = +match[2];
    let year = +match[3];
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    let day, month;
    if (first > 12) { day = first; month = second; }
    else if (second > 12) { month = first; day = second; }
    else if (preferDmy) { day = first; month = second; }
    else { month = first; day = second; }
    return { year, month, day };
  }
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) {
    const d = new Date(parsed);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }
  return null;
}

function parseCsvDateTime(dateValue, timeValue, preferDmy) {
  const rawDate = String(dateValue || '').trim();
  if (!timeValue && /[T ]\d{1,2}:\d{2}/.test(rawDate)) {
    const native = Date.parse(rawDate);
    if (!Number.isNaN(native)) return native;
    const parts = rawDate.split(/[T ]/, 2);
    return parseCsvDateTime(parts[0], parts[1], preferDmy);
  }
  const date = parseCsvDate(rawDate, preferDmy);
  const time = parseClock(timeValue || '00:00');
  if (!date || !time) return NaN;
  return localPartsToEpoch({ ...date, ...time });
}

function parseCsv(text, { fileName = '', accountId = '', color = '', locale = 'fr', importNamespace = '' } = {}) {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return { format: 'csv', calendarName: '', events: [], recurringSeries: 0, cancelled: 0, truncated: false };
  const headers = rows[0].map(normalizeHeader);
  const idx = {};
  for (const [key, names] of Object.entries(CSV_HEADERS)) idx[key] = columnIndex(headers, names);
  if (idx.title < 0 || (idx.startDate < 0 && idx.start < 0)) throw new Error('Colonnes CSV de calendrier non reconnues');
  const preferDmy = String(locale || 'fr').toLowerCase().startsWith('fr');
  const events = [];
  for (let rowIndex = 1; rowIndex < rows.length && events.length < MAX_IMPORTED_EVENTS; rowIndex += 1) {
    const row = rows[rowIndex];
    const get = key => idx[key] >= 0 ? String(row[idx[key]] || '').trim() : '';
    const title = get('title');
    if (!title) continue;
    const allDay = csvTruthy(get('allDay'));
    const startAt = idx.start >= 0
      ? parseCsvDateTime(get('start'), '', preferDmy)
      : parseCsvDateTime(get('startDate'), allDay ? '00:00' : get('startTime'), preferDmy);
    if (!Number.isFinite(startAt)) continue;
    let endAt = NaN;
    if (idx.end >= 0 && get('end')) endAt = parseCsvDateTime(get('end'), '', preferDmy);
    else if (idx.endDate >= 0 && get('endDate')) endAt = parseCsvDateTime(get('endDate'), allDay ? '00:00' : get('endTime'), preferDmy);
    if (!Number.isFinite(endAt) || endAt <= startAt) endAt = startAt + (allDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000);
    // Dans les CSV Google/Outlook, une journée entière a souvent une date de
    // fin inclusive. Notre stockage utilise une borne de fin exclusive.
    if (allDay && endAt === startAt) endAt += 24 * 60 * 60 * 1000;
    const location = get('location').slice(0, 500);
    const notes = get('notes').slice(0, 20000);
    const namespace = String(importNamespace || accountId || 'local').trim() || 'local';
    const importKey = `csv:${hash(`${namespace}|${fileName}|${title}|${startAt}|${endAt}|${location}`)}`;
    events.push({ title: title.slice(0, 240), startAt, endAt, allDay, location, notes, accountId: accountId || '', color, importKey });
  }
  return { format: 'csv', calendarName: '', events, recurringSeries: 0, cancelled: 0, truncated: events.length >= MAX_IMPORTED_EVENTS };
}

function detectFormat(text, fileName = '') {
  const lower = String(fileName || '').toLowerCase();
  if (/\.(ics|ical|vcs)$/.test(lower)) return 'ics';
  if (/\.csv$/.test(lower)) return 'csv';
  const head = String(text || '').slice(0, 4000).toUpperCase();
  if (head.includes('BEGIN:VCALENDAR') || head.includes('BEGIN:VEVENT')) return 'ics';
  return 'csv';
}

function parseCalendarImport({ text = '', fileName = '', accountId = '', color = '', locale = 'fr', importNamespace = '' } = {}) {
  const source = String(text || '');
  if (!source.trim()) throw new Error('Le fichier de calendrier est vide');
  if (Buffer.byteLength(source, 'utf8') > 20 * 1024 * 1024) throw new Error('Le fichier de calendrier dépasse 20 Mo');
  const format = detectFormat(source, fileName);
  const parsed = format === 'ics'
    ? parseIcs(source, { fileName, accountId, color, importNamespace })
    : parseCsv(source, { fileName, accountId, color, locale, importNamespace });
  if (!parsed.events.length) throw new Error('Aucun rendez-vous importable trouvé dans ce fichier');
  return parsed;
}

module.exports = { parseCalendarImport, parseIcs, parseCsv };
