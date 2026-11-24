'use strict';

const { createCalDavClient, CalDavError } = require('./calendar_caldav');
const DAV = 'DAV:';
const CAL = 'urn:ietf:params:xml:ns:caldav';
const XML = 'http://www.w3.org/XML/1998/namespace';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const fail = code => { throw new CalDavError(code); };
const invalid = () => fail('INVALID_DAV_XML');
const namePattern = '[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?';
const nameRE = new RegExp(namePattern, 'y');
const attrRE = new RegExp(`\\s+(${namePattern})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, 'y');
const whitespace = /^[\t\n\r ]*$/;
function validChar(n) {
  return n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0xd7ff) ||
    (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff);
}
function decode(text) {
  return text.replace(/&(?:([^&;\s<]*);)?/g, (_, entity) => {
    const predefined = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(predefined, entity)) return predefined[entity];
    if (typeof entity !== 'string' || !/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity)) invalid();
    const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!validChar(code)) invalid();
    return String.fromCodePoint(code);
  });
}

// Intentionally restricted XML reader for DAV responses. No DTD, external
// entities, arbitrary processing instructions or external resource resolution.
// Unknown element namespaces are retained, never interpreted as DAV/CALDAV.
function parseXML(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 8 * 1024 * 1024) invalid();
  for (const ch of source) if (!validChar(ch.codePointAt(0))) invalid();
  source = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let i = 0, count = 0, root = null;
  const stack = [];
  const nsRoot = new Map([['xml', XML], ['', '']]);
  const addText = (text, raw = false) => {
    if (!stack.length) { if (!whitespace.test(text)) invalid(); return; }
    if (!raw && text.includes(']]>')) invalid();
    stack.at(-1).node.text += raw ? text : decode(text);
  };
  if (source.startsWith('<?xml ')) {
    const end = source.indexOf('?>');
    if (end < 0 || !/^<\?xml\s+version\s*=\s*(['"])1\.0\1(?:\s+encoding\s*=\s*(['"])UTF-8\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*\?>$/i.test(source.slice(0, end + 2))) invalid();
    i = end + 2;
  }
  while (i < source.length) {
    if (source[i] !== '<') {
      const end = source.indexOf('<', i);
      const next = end < 0 ? source.length : end;
      addText(source.slice(i, next)); i = next; continue;
    }
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      if (end < 0 || source.slice(i + 4, end).includes('--')) invalid();
      i = end + 3; continue;
    }
    if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i + 9);
      if (end < 0 || !stack.length) invalid();
      addText(source.slice(i + 9, end), true); i = end + 3; continue;
    }
    if (source.startsWith('<!', i) || source.startsWith('<?', i)) invalid();
    if (source.startsWith('</', i)) {
      nameRE.lastIndex = i + 2;
      const m = nameRE.exec(source);
      if (!m || !stack.length || m[0] !== stack.at(-1).qname) invalid();
      i = nameRE.lastIndex;
      while (/[\t\n ]/.test(source[i] || '>')) i++;
      if (source[i++] !== '>') invalid();
      stack.pop(); continue;
    }
    nameRE.lastIndex = i + 1;
    const m = nameRE.exec(source);
    if (!m || ++count > 40000 || stack.length >= 48 || (!stack.length && root)) invalid();
    const qname = m[0], attrs = new Map();
    i = nameRE.lastIndex;
    while (true) {
      attrRE.lastIndex = i;
      const a = attrRE.exec(source);
      if (!a) break;
      if (attrs.size >= 64 || attrs.has(a[1])) invalid();
      attrs.set(a[1], decode(a[2] ?? a[3])); i = attrRE.lastIndex;
    }
    while (/[\t\n ]/.test(source[i] || '>')) i++;
    const closed = source.startsWith('/>', i);
    if (!closed && source[i] !== '>') invalid();
    i += closed ? 2 : 1;
    const ns = new Map(stack.at(-1)?.ns || nsRoot);
    for (const [key, value] of attrs) {
      if (key !== 'xmlns' && !key.startsWith('xmlns:')) continue;
      const prefix = key === 'xmlns' ? '' : key.slice(6);
      if (prefix === 'xmlns' || value === XMLNS || (prefix === 'xml') !== (value === XML) || (prefix && !value)) invalid();
      ns.set(prefix, value);
    }
    const resolve = (key, attribute = false) => {
      const parts = key.split(':');
      const prefix = parts.length === 2 ? parts[0] : '';
      if (!ns.has(prefix) || prefix === 'xmlns') invalid();
      return [attribute && !prefix ? '' : ns.get(prefix), parts.at(-1)];
    };
    const [uri, local] = resolve(qname);
    const node = { uri, local, attrs: Object.create(null), children: [], text: '' };
    const expanded = new Set();
    for (const [key, value] of attrs) {
      if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
      const [au, al] = resolve(key, true);
      const id = `${au}\0${al}`;
      if (expanded.has(id)) invalid();
      expanded.add(id);
      if (!au) node.attrs[al] = value;
    }
    if (stack.length) stack.at(-1).node.children.push(node); else root = node;
    if (!closed) stack.push({ node, qname, ns });
  }
  if (stack.length || !root) invalid();
  return root;
}
const children = (n, uri, local) => n.children.filter(x => x.uri === uri && x.local === local);
function one(n, uri, local) {
  const list = children(n, uri, local);
  if (list.length > 1) invalid();
  return list[0];
}
function scalar(n) {
  if (!n || n.children.length) invalid();
  return n.text.trim();
}
function status(n) {
  const m = /^HTTP\/\d+(?:\.\d+)? ([1-5]\d\d)(?:[ \t].*)?$/.exec(scalar(n));
  if (!m) invalid();
  return Number(m[1]);
}
function parseMultiStatus(source, { completeSnapshot = false } = {}) {
  const root = parseXML(source);
  if (root.uri !== DAV || root.local !== 'multistatus') invalid();
  if (completeSnapshot && root.children.some(n => n.uri !== DAV || !['response', 'responsedescription'].includes(n.local))) invalid();
  const responses = children(root, DAV, 'response');
  if (responses.length > 1000) fail('DISCOVERY_LIMIT');
  return responses.map(response => {
    if (completeSnapshot && response.children.some(n => n.uri !== DAV || !['href', 'status', 'propstat', 'responsedescription'].includes(n.local))) invalid();
    const href = scalar(one(response, DAV, 'href'));
    if (!href || href.length > 4096) invalid();
    const result = { href, properties: new Map(), status: null };
    const overall = one(response, DAV, 'status');
    if (overall) result.status = status(overall);
    for (const ps of children(response, DAV, 'propstat')) {
      const code = status(one(ps, DAV, 'status'));
      const prop = one(ps, DAV, 'prop');
      if (!prop) invalid();
      if (completeSnapshot && (code < 200 || code >= 300)) invalid();
      if (code < 200 || code >= 300 || (result.status !== null && (result.status < 200 || result.status >= 300))) continue;
      for (const p of prop.children) {
        const key = `${p.uri}\0${p.local}`;
        if (result.properties.has(key)) invalid();
        result.properties.set(key, p);
      }
    }
    return result;
  });
}
const property = (r, uri, name) => r.properties.get(`${uri}\0${name}`);
const links = p => p ? children(p, DAV, 'href').map(scalar) : [];
function safeURL(value, base) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value)) fail('INVALID_URL');
  let u;
  try { u = new URL(value, base); } catch { fail('INVALID_URL'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.search) fail('INVALID_URL');
  return u;
}
const appleHost = url => url.port === '' && /^(?:caldav|p[0-9]{1,4}-caldav)\.icloud\.com$/.test(url.hostname);

async function discoverCalDav({ provider = 'caldav', serverURL, username, password, fetchImpl, timeoutMs, maxBytes } = {}) {
  if (!['caldav', 'icloud'].includes(provider)) fail('INVALID_OPTIONS');
  const initial = safeURL(provider === 'icloud' ? (serverURL || 'https://caldav.icloud.com/') : serverURL);
  if (provider === 'icloud' && !appleHost(initial)) fail('CROSS_ORIGIN');
  const permitted = (href, base = initial.href) => {
    const url = safeURL(href, base);
    if (url.origin !== initial.origin && !(provider === 'icloud' && appleHost(url))) fail('CROSS_ORIGIN');
    return url;
  };
  const clients = new Map();
  let requests = 0;
  async function query(kind, href) {
    let url = permitted(href);
    const seen = new Set();
    while (true) {
      if (++requests > 24 || seen.size >= 5 || seen.has(url.href)) fail('DISCOVERY_LIMIT');
      seen.add(url.href);
      if (!clients.has(url.origin)) clients.set(url.origin, createCalDavClient({ serverURL: url.origin + '/', username, password, fetchImpl, timeoutMs, maxBytes }));
      const result = await clients.get(url.origin).discovery(kind, url.href);
      if (result.status === 207) return { url, rows: parseMultiStatus(result.text) };
      if (!result.location) fail('REDIRECT_BLOCKED');
      url = permitted(result.location, url.href);
    }
  }
  function ownRow(result) {
    // Depth 0 must identify exactly one resource. Validate its href even if
    // the server reports a canonical path rather than the request path.
    if (result.rows.length !== 1) fail('INVALID_DISCOVERY');
    const row = result.rows[0];
    permitted(row.href, result.url.href);
    if (row.status !== null && (row.status < 200 || row.status >= 300)) fail('INVALID_DISCOVERY');
    return row;
  }
  const start = provider === 'caldav' && initial.pathname === '/' ? new URL('/.well-known/caldav', initial).href : initial.href;
  let result;
  try { result = await query('principal', start); }
  catch (e) {
    if (start === initial.href || e.code !== 'HTTP_ERROR' || ![404, 405].includes(e.status)) throw e;
    result = await query('principal', initial.href);
  }
  let row = ownRow(result);
  let homes = links(property(row, CAL, 'calendar-home-set')).map(h => permitted(h, result.url.href).href);
  if (!homes.length) {
    const principals = links(property(row, DAV, 'current-user-principal'));
    if (principals.length !== 1) fail('PRINCIPAL_NOT_FOUND');
    result = await query('home', permitted(principals[0], result.url.href).href);
    row = ownRow(result);
    homes = links(property(row, CAL, 'calendar-home-set')).map(h => permitted(h, result.url.href).href);
  }
  homes = [...new Set(homes)];
  if (!homes.length) fail('CALENDAR_HOME_NOT_FOUND');
  if (homes.length > 8) fail('DISCOVERY_LIMIT');
  const calendars = new Map();
  for (const home of homes) {
    result = await query('calendars', home);
    for (const r of result.rows) {
      const type = property(r, DAV, 'resourcetype');
      if (!type || !one(type, CAL, 'calendar')) continue;
      const components = property(r, CAL, 'supported-calendar-component-set');
      if (components && !children(components, CAL, 'comp').some(c => c.attrs.name === 'VEVENT')) continue;
      const url = permitted(r.href, result.url.href).href;
      const privileges = property(r, DAV, 'current-user-privilege-set');
      const names = privileges ? new Set(children(privileges, DAV, 'privilege').flatMap(p => p.children.filter(x => x.uri === DAV).map(x => x.local))) : new Set();
      // Conservative: collection privileges are hints only; event-level ACLs
      // and conditional write responses must still be enforced in later phases.
      const writable = names.has('all') || names.has('write') || (names.has('write-content') && names.has('bind') && names.has('unbind'));
      const display = property(r, DAV, 'displayname');
      const item = { url, name: display ? scalar(display).slice(0, 512) || 'Calendar' : 'Calendar', access: writable ? 'readWrite' : names.has('read') ? 'readOnly' : 'unknown', readOnly: !writable };
      if (calendars.has(url)) fail('INVALID_DISCOVERY');
      calendars.set(url, item);
      if (calendars.size > 250) fail('DISCOVERY_LIMIT');
    }
  }
  return [...calendars.values()];
}
module.exports = { discoverCalDav, parseMultiStatus };
