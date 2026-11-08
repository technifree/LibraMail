#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'build_macos.sh'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/macos-preview.yml'), 'utf8');
assert(source.includes('LIBRAMAIL_STATE_ROOT'), 'macOS data must be written outside read-only .app');
assert(source.includes('Library/Application Support/LibraMail'));
assert(source.includes('better-sqlite3'), 'native SQLite packaging must be tested');
assert(source.includes('IMAPSYNC_MACOS_X64_SHA256'), 'Intel imapsync must be checksum-verified');
assert(source.includes('prepare_imapsync_ci.py linux'), 'native arm64 must use pinned source');
assert(source.includes('PAR::Packer') && source.includes('pp -x'), 'native ARM imapsync packaging is mandatory');
assert(!source.includes('--without-imapsync'), 'preview must not omit imapsync silently');
assert(workflow.includes('macos-15-intel') && workflow.includes('macos-15'));
assert(workflow.includes('workflow_dispatch:'));
assert(workflow.includes('brew --prefix imapsync'), 'PAR scanner must receive Homebrew imapsync module paths');
assert(workflow.includes('Digest::HMAC_SHA1'), 'arm64 package must validate required Perl HMAC module');
assert(workflow.includes('brew install imapsync cpanminus'), 'brew imapsync and Perl packager prerequisites must be installed');
assert(!workflow.includes('brew install imapsync perl cpanminus'), 'do not force Homebrew Perl for imapsync dependencies');
assert(workflow.includes('export PATH="/usr/bin:$PATH"'), 'arm64 must use system Perl to match Homebrew imapsync');
assert(workflow.split("test \"$(command -v perl)\" = '/usr/bin/perl'").length >= 3, 'system Perl must be asserted in both steps');
assert(workflow.includes('IO::Socket::SSL') && workflow.includes('Net::SSLeay'), 'arm64 must verify SSL Perl dependencies');
assert(workflow.includes('PERL5LIB=$PERL5LIB'), 'Perl module paths must persist to packaging step');
assert(/push:\s*\n\s*branches:\s*\n\s*- dev-0\.6\.3/.test(workflow), 'preview must trigger on development branch push');
assert(!/release:\s*\n\s*types:/.test(workflow), 'preview must not publish a release');
assert(workflow.includes('libramail-macos-${{ matrix.arch }}-preview'), 'preview artifacts must be explicitly marked');
const smokeShell = fs.readFileSync(path.join(root, 'tools/smoke_macos_package.sh'), 'utf8');
const smokeEngine = fs.readFileSync(path.join(root, 'tools/smoke_macos_engine.js'), 'utf8');
assert(workflow.includes('bash tools/smoke_macos_package.sh'), 'macOS jobs must smoke-test the exact generated .app ZIP');
assert(workflow.indexOf('bash tools/smoke_macos_package.sh') < workflow.indexOf('actions/upload-artifact@'),
  'smoke tests must gate upload of preview artifacts');
assert(workflow.includes('actions/upload-artifact@v6'), 'use the Node.js 24 artifact action');
assert(smokeShell.includes('shasum -a 256 -c') && smokeShell.includes('ditto -x -k'),
  'inspect the checksum-verified extracted package');
assert(smokeShell.includes('lipo -archs') && smokeShell.includes('otool -L'),
  'check native architectures and external library dependencies');
assert(smokeShell.includes('env -i') && smokeShell.includes('imapsync'),
  'imapsync must start without Homebrew or PERL5LIB');
assert(smokeShell.includes('smoke_macos_engine.js'), 'run the bundled Node and SQLite engine smoke test');
assert(smokeEngine.includes('LIBRAMAIL_STATE_ROOT: stateRoot'),
  'the backend smoke test must isolate local data to a disposable directory');
assert(smokeEngine.includes("'security.status'") && smokeEngine.includes("'app.shutdown'"),
  'the smoke test must make an authenticated RPC request and shut down cleanly');
assert(smokeEngine.includes('fs.rmSync(stateRoot'), 'temporary test data must be deleted');
console.log('[OK] LibraMail 0.6.3 : pipeline macOS apercu Intel/Apple Silicon, migration obligatoire');
