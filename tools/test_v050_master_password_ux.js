'use strict';

const fs = require('fs');
const assert = require('assert');

const backend = fs.readFileSync('engine/backend.js', 'utf8');
const app = fs.readFileSync('resources/js/app.js', 'utf8');
const html = fs.readFileSync('resources/index.html', 'utf8');
const css = fs.readFileSync('resources/css/app.css', 'utf8');
const fr = JSON.parse(fs.readFileSync('resources/locales/fr.json', 'utf8'));
const en = JSON.parse(fs.readFileSync('resources/locales/en.json', 'utf8'));

assert(backend.includes('SECURITY_UNLOCK_FREE_FAILURES = 4'));
assert(backend.includes('SECURITY_UNLOCK_BASE_DELAY_MS = 10_000'));
assert(backend.includes('SECURITY_UNLOCK_MAX_DELAY_MS = 5 * 60_000'));
assert(backend.includes('function assertSecurityUnlockAllowed()'));
assert(backend.includes('registerSecurityUnlockFailure()'));
assert(backend.includes('resetSecurityUnlockThrottle()'));
assert(backend.includes('SECURITY_RETRY_AFTER:'));
assert(backend.includes('...securityUnlockThrottleStatus()'));

const unlockStart = backend.indexOf("'security.unlock'");
const lockStart = backend.indexOf("'security.lock'", unlockStart);
const unlockBlock = backend.slice(unlockStart, lockStart);
assert(unlockBlock.includes('assertSecurityUnlockAllowed();'));
assert(unlockBlock.includes('masterPassword.unlock(password);'));
assert(unlockBlock.includes('registerSecurityUnlockFailure()'));
assert(unlockBlock.includes('resetSecurityUnlockThrottle()'));

for (const id of [
  'security-unlock-password',
  'security-current-password',
  'security-new-password',
  'security-confirm-password',
]) {
  assert(html.includes(`data-password-toggle="${id}"`));
  assert(html.includes(`data-caps-warning-for="${id}"`));
}

assert(css.includes('LibraMail 0.5.0 - mot de passe principal'));
assert(css.includes('.security-password-toggle'));
assert(css.includes('.security-caps-warning'));

assert(app.includes('function securityRetryRemainingMs()'));
assert(app.includes('function updateSecurityRetryUi(retryAfterMs = 0)'));
assert(app.includes('function resetSecurityPasswordUi(scope = document)'));
assert(app.includes('function wireSecurityPasswordInputs()'));
assert(app.includes("rawMessage.match(/^SECURITY_RETRY_AFTER:"));
assert(app.includes('wireSecurityPasswordInputs();'));

for (const locale of [fr, en]) {
  assert(locale['security.showPassword']);
  assert(locale['security.hidePassword']);
  assert(locale['security.capsLockOn']);
  assert(locale['security.retryIn']);
}

console.log('[LibraMail] Test UX/securite mot de passe principal 0.5.0 : OK');
