#!/usr/bin/env bash
# Smoke-test the actual ZIP and bundled binaries on the matching macOS runner.
# No user accounts, real email addresses, or persistent data are accessed.
set -Eeuo pipefail
IFS=$'\n\t'

[[ "$(uname -s)" == Darwin ]] || { echo '[SMOKE] Exécution réservée à macOS' >&2; exit 1; }
[[ $# == 1 ]] || { echo 'Usage: smoke_macos_package.sh {x86_64|arm64}' >&2; exit 1; }
ARCH="$1"
case "$ARCH" in x86_64|arm64) ;; *) echo "[SMOKE] Architecture invalide: $ARCH" >&2; exit 1;; esac
[[ "$(uname -m)" == "$ARCH" ]] || { echo '[SMOKE] Runner et paquet incompatibles' >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
VERSION="$(tr -d '\r\n' < "$ROOT/VERSION")"
ZIP="$ROOT/build/macos/LibraMail-${VERSION}-macos-${ARCH}.zip"
CHECKSUM="${ZIP}.sha256"
[[ -s "$ZIP" && -s "$CHECKSUM" ]] || { echo '[SMOKE] ZIP ou empreinte absents' >&2; exit 1; }
(
  cd "$(dirname "$ZIP")"
  shasum -a 256 -c "$(basename "$CHECKSUM")"
)
WORK="$(mktemp -d "${TMPDIR:-/tmp}/libramail-macos-smoke.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT
# ditto preserves executable modes and the .app bundle structure.
ditto -x -k "$ZIP" "$WORK"
APP="$WORK/LibraMail.app"
APPROOT="$APP/Contents/Resources/app"
PLIST="$APP/Contents/Info.plist"
[[ -f "$PLIST" ]] || { echo '[SMOKE] Info.plist absent' >&2; exit 1; }
plutil -lint "$PLIST"
[[ "$(plutil -extract CFBundleShortVersionString raw -o - "$PLIST")" == "$VERSION" ]] || {
  echo '[SMOKE] Version Info.plist incorrecte' >&2; exit 1;
}
[[ "$(plutil -extract CFBundleExecutable raw -o - "$PLIST")" == 'LibraMail' ]] || {
  echo '[SMOKE] Lanceur principal incorrect' >&2; exit 1;
}
[[ -x "$APP/Contents/MacOS/LibraMail" ]] || { echo '[SMOKE] Lanceur non exécutable' >&2; exit 1; }
[[ -s "$APPROOT/neutralino.config.json" && -s "$APPROOT/engine/backend.js" ]] || {
  echo '[SMOKE] Configuration ou moteur absents' >&2; exit 1;
}
for BIN in "$APPROOT/runtime/node/bin/node" "$APPROOT/bin/libramail-app" "$APPROOT/runtime/imapsync/imapsync"; do
  [[ -x "$BIN" ]] || { echo "[SMOKE] Binaire non exécutable: $BIN" >&2; exit 1; }
  file "$BIN"
  lipo -archs "$BIN" | tr ' ' '\n' | grep -Fxq "$ARCH" || {
    echo "[SMOKE] Architecture incorrecte: $BIN" >&2; exit 1;
  }
done
[[ -s "$APPROOT/runtime/imapsync/LICENSE" ]] || { echo '[SMOKE] Licence imapsync absente' >&2; exit 1; }
[[ -s "$APPROOT/runtime/node/LICENSE" ]] || { echo '[SMOKE] Licence Node.js absente' >&2; exit 1; }
# The package must not require a Homebrew/CPAN runtime from the developer machine.
for BIN in "$APPROOT/runtime/node/bin/node" "$APPROOT/bin/libramail-app" "$APPROOT/runtime/imapsync/imapsync"; do
  if otool -L "$BIN" | grep -E '/(opt/homebrew|usr/local/(opt|Cellar))/' ; then
    echo "[SMOKE] Dépendance dynamique Homebrew détectée: $BIN" >&2
    exit 1
  fi
done
mkdir -p "$WORK/empty-home" "$WORK/tmp"
# Empty environment removes PERL5LIB and Homebrew from PATH, as on a user's Mac.
if ! env -i HOME="$WORK/empty-home" TMPDIR="$WORK/tmp" PATH='/usr/bin:/bin:/usr/sbin:/sbin' \
  "$APPROOT/runtime/imapsync/imapsync" --version > "$WORK/imapsync.log" 2>&1; then
  if ! env -i HOME="$WORK/empty-home" TMPDIR="$WORK/tmp" PATH='/usr/bin:/bin:/usr/sbin:/sbin' \
    "$APPROOT/runtime/imapsync/imapsync" --help > "$WORK/imapsync.log" 2>&1; then
    echo '[SMOKE] imapsync non autonome' >&2
    tail -n 30 "$WORK/imapsync.log" >&2
    exit 1
  fi
fi
echo '[SMOKE] imapsync autonome: OK'
"$APPROOT/runtime/node/bin/node" "$ROOT/tools/smoke_macos_engine.js" "$APP" "$VERSION" "$ARCH"
echo "[SMOKE] Paquet LibraMail ${VERSION} macOS ${ARCH}: OK"
