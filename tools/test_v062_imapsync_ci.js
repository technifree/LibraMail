#!/usr/bin/env node
// Regression guard: CI must prepare both verified engines, not silently skip migration.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const release = read('.github/workflows/release.yml');
const build = read('.github/workflows/build.yml');
const loader = read('tools/prepare_imapsync_ci.py');
for (const [file, contents] of [['release.yml', release], ['build.yml', build]]) {
  assert(contents.includes('tools/prepare_imapsync_ci.py linux'), `${file}: Linux imapsync provisioning absent`);
  assert(contents.includes('tools/prepare_imapsync_ci.py windows'), `${file}: Windows imapsync provisioning absent`);
  assert(contents.includes('IMAPSYNC_WINDOWS_ZIP_SHA256'), `${file}: no pinned Windows checksum`);
  assert(!contents.includes('WithoutImapsync') && !contents.includes('--without-imapsync'), `${file}: incomplete release allowed`);
}
assert(release.includes('workflow_dispatch:'), 'Missing manual release recovery');
assert(release.includes('git merge-base --is-ancestor'), 'Missing original tag ancestry verification');
assert(loader.includes('check_sha256(archive, expected_hash)'), 'Missing archive hash verification');
assert(loader.includes('34e1715c6584889ff3bd9c0acc2fab254446282beda90c8e5a71a83b3a59dbca'), 'Source version not pinned');
assert(read('.gitignore').includes('/runtime/imapsync/'), 'Temporary engines not excluded from Git');
console.log('[OK] LibraMail 0.6.2 : provisionnement imapsync Linux/Windows sécurisé en CI');
