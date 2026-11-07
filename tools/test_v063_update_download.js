#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'resources/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'resources/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'resources/css/app.css'), 'utf8');
const begin = js.indexOf('  function releaseDownloadPage(version) {');
const end = js.indexOf('\n  async function fetchLatestReleaseFromBrowser()', begin);
assert(begin >= 0 && end > begin, 'Update controller functions are missing');

const calls = [], systemCalls = [], messages = [];
const noticeClasses = new Set(['hidden']);
const long = { textContent: '' };
const short = { textContent: '' };
const notice = {
  title: '', attrs: {},
  classList: { add(c) { noticeClasses.add(c); }, remove(c) { noticeClasses.delete(c); } },
  querySelector(selector) { return selector === '.update-notice-long' ? long : selector === '.update-notice-short' ? short : null; },
  setAttribute(name, value) { this.attrs[name] = value; },
};
let aboutClick = null;
const state = {
  innerHTML: '',
  querySelector(selector) {
    assert(['#about-update-link', '#about-current-downloads-link'].includes(selector),
      'Only the official release links may be bound');
    return { addEventListener(type, handler) { assert.equal(type, 'click'); aboutClick = handler; } };
  },
};
const details = { textContent: '' };
const checkButton = {
  disabled: false,
  classList: { toggle() {} },
};
const elements = {
  'update-notice': notice,
  'about-update-state': state,
  'about-update-details': details,
  'btn-check-update': checkButton,
};
const updateState = { checking: false, latest: '', url: '', available: false, checkedAt: 0, error: '' };
let failEngine = false;
let failSystem = false;
const context = {
  updateState,
  document: { getElementById(id) { return elements[id]; } },
  t: (id, values={}) => `${id}${values.version ? ': '+values.version : ''}`,
  esc: value => String(value),
  appVersion: () => '0.6.3',
  rpc: async (...args) => { calls.push(args); if (failEngine) throw Error('RPC unavailable'); },
  Neutralino: { os: { open: async url => { systemCalls.push(url); if (failSystem) throw Error('browser unavailable'); } } },
  status: (...args) => messages.push(args),
};
const functions = vm.runInNewContext(`${js.slice(begin, end)}\n({ releaseDownloadPage, openUpdateDownloadPage, openCurrentDownloadsPage, setUpdateNotice, renderUpdateStatus })`, context);

(async () => {
  const expected = 'https://github.com/technifree/LibraMail/releases/tag/v0.6.4';
  assert.equal(functions.releaseDownloadPage('0.6.4'), expected);
  assert.equal(functions.releaseDownloadPage('v0.6.4'), expected);
  assert.equal(functions.releaseDownloadPage('0.6.4/../../evil'), 'https://github.com/technifree/LibraMail/releases');
  assert.equal(functions.releaseDownloadPage('https://attacker.invalid'), 'https://github.com/technifree/LibraMail/releases');
  assert.equal(await functions.openUpdateDownloadPage(), false, 'No download when there is no newer release');

  updateState.latest = '0.6.4';
  updateState.available = true;
  functions.setUpdateNotice();
  assert(!noticeClasses.has('hidden'), 'Update pill must become visible');
  assert.match(long.textContent, /0.6.4/);
  assert.match(short.textContent, /0.6.4/);
  assert.match(notice.attrs['aria-label'], /0.6.4/);
  functions.renderUpdateStatus();
  assert.match(state.innerHTML, /about-update-link/);
  assert.equal(typeof aboutClick, 'function', 'About update title should be clickable');
  aboutClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1)[0], 'app.openExternal');
  assert.equal(calls.at(-1)[1].url, expected);

  failEngine = true;
  assert.equal(await functions.openUpdateDownloadPage(), true, 'Neutralino fallback should work');
  assert.equal(systemCalls.at(-1), expected);
  failSystem = true;
  assert.equal(await functions.openUpdateDownloadPage(), false, 'Failed browsers must not be reported as success');
  assert.equal(messages.at(-1)[1], 'error');

  updateState.available = false;
  failEngine = false;
  failSystem = false;
  aboutClick = null;
  functions.setUpdateNotice();
  functions.renderUpdateStatus();
  assert(noticeClasses.has('hidden'), 'No pill when the installed version is current');
  assert(!state.innerHTML.includes('id="about-update-link"'));
  assert(state.innerHTML.includes('about-current-downloads-link'), 'Up-to-date status must link to official downloads');
  assert.equal(typeof aboutClick, 'function', 'The current status title should be clickable');
  aboutClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1)[0], 'app.openExternal');
  assert.equal(calls.at(-1)[1].url, 'https://github.com/technifree/LibraMail/releases',
    'An up-to-date development build must not open a potentially unpublished version tag');
  failEngine = true;
  assert.equal(await functions.openCurrentDownloadsPage(), true, 'Neutralino fallback should work for current downloads');
  assert.equal(systemCalls.at(-1), 'https://github.com/technifree/LibraMail/releases');
  failSystem = true;
  assert.equal(await functions.openCurrentDownloadsPage(), false, 'Browser failure must be reported');
  assert.equal(messages.at(-1)[1], 'error');

  const topbarStart = html.indexOf('<div id="topbar">');
  const topbarEnd = html.indexOf('</div>\n\n', topbarStart);
  const noticePosition = html.indexOf('id="update-notice"');
  assert(topbarStart >= 0 && noticePosition > topbarStart && noticePosition < topbarEnd,
    'The update notice must live in the topbar');
  assert(css.includes('#topbar .update-notice') && !css.includes('.update-notice {\n  position: fixed'),
    'Update pill must not float on top of the message list');
  assert(js.includes("document.getElementById('update-notice')?.addEventListener('click', () => { openUpdateDownloadPage(); });"));
  assert(js.includes('}, 6 * 60 * 60 * 1000);'), 'A running client must periodically check for updates');
  for (const locale of ['fr', 'en']) {
    const translations = JSON.parse(fs.readFileSync(path.join(root, `resources/locales/${locale}.json`), 'utf8'));
    for (const id of ['update.notice', 'update.noticeShort', 'update.noticeTitle', 'update.downloadsTitle', 'update.openFailed']) {
      assert(translations[id], `Missing ${locale} translation: ${id}`);
    }
  }
  console.log('[OK] LibraMail 0.6.3 : notification de version, ouverture de la Release et sécurité du lien');
})().catch(error => { console.error(error); process.exitCode = 1; });
