#!/usr/bin/env bash
# LibraMail macOS portable preview: one native .app per architecture.
# Intended to run on the matching macOS GitHub-hosted runner, not on Linux.
# Public builds must embed Node, native SQLite and an executable imapsync.
set -Eeuo pipefail
IFS=$'\n\t'
ROOT="$(cd "$(dirname "$0")" && pwd -P)"
cd "$ROOT"
[[ "$(uname -s)" == Darwin ]] || { echo '[macOS] Construction réservée à macOS.' >&2; exit 1; }
for tool in curl tar shasum zip python3 file; do
  command -v "$tool" >/dev/null || { echo "[macOS] Outil manquant : $tool" >&2; exit 1; }
done

VERSION="$(cat VERSION | tr -d '\r\n')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) NODE_ARCH=x64; NEU_ARCH=x64; LABEL=x86_64;;
  arm64) NODE_ARCH=arm64; NEU_ARCH=arm64; LABEL=arm64;;
  *) echo "[macOS] Architecture inconnue : $ARCH" >&2; exit 1;;
esac
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo '[macOS] Version invalide.' >&2; exit 1; }
NODE_VERSION=22.23.1
NODE_ARCHIVE="node-v${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz"
case "$ARCH" in
  x86_64) NODE_SHA=b8da981b8a0b1241b70249204916da76c63573ddf5814dbd2d1e41069105cb81;;
  arm64) NODE_SHA=ef28d8fab2c0e4314522d4bb1b7173270aa3937e93b92cb7de79c112ac1fa953;;
esac

WORK="$ROOT/.build-macos-work"
OUT="$ROOT/build/macos"
APP="$WORK/LibraMail.app"
APP_ROOT="$APP/Contents/Resources/app"
STAGING="$WORK/neutralino-src"
NODE_FOLDER="$WORK/node-v${NODE_VERSION}-darwin-${NODE_ARCH}"
clean() { if [[ "${LIBRAMAIL_KEEP_MAC_WORK:-0}" != 1 ]]; then rm -rf "$WORK"; fi; }
trap clean EXIT
rm -rf "$WORK"
mkdir -p "$WORK" "$OUT" "$STAGING" "$APP_ROOT/runtime/node/bin" "$APP_ROOT/bin" "$APP/Contents/MacOS"

# Pin and verify the official Node.js runtime, including the exact architecture.
NODE_DOWNLOAD="$WORK/$NODE_ARCHIVE"
curl -fLsS --retry 3 --connect-timeout 20 \
  "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" -o "$NODE_DOWNLOAD"
[[ "$(shasum -a 256 "$NODE_DOWNLOAD" | awk '{print $1}')" == "$NODE_SHA" ]] || {
  echo '[macOS] Empreinte Node.js invalide.' >&2; exit 1;
}
tar -xzf "$NODE_DOWNLOAD" -C "$WORK"
NODE_BIN="$NODE_FOLDER/bin/node"
NPM_CLI="$NODE_FOLDER/lib/node_modules/npm/bin/npm-cli.js"
NPX_CLI="$NODE_FOLDER/lib/node_modules/npm/bin/npx-cli.js"
[[ "$($NODE_BIN -v)" == "v${NODE_VERSION}" ]] || { echo '[macOS] Node incorrect.' >&2; exit 1; }
install -m 0755 "$NODE_BIN" "$APP_ROOT/runtime/node/bin/node"
cp "$NODE_FOLDER/LICENSE" "$APP_ROOT/runtime/node/LICENSE"
printf '%s\n' "$NODE_VERSION" > "$APP_ROOT/runtime/node/VERSION"
export PATH="$NODE_FOLDER/bin:$PATH"

# Neutralino includes Apple-specific binaries; rebuild resources from project sources.
cp -R "$ROOT/resources" "$STAGING/resources"
python3 - "$ROOT/neutralino.config.json" "$STAGING/neutralino.config.json" <<'PY'
import json, sys
cfg=json.load(open(sys.argv[1], encoding='utf-8'))
cfg.setdefault('cli', {})['distributionPath']='dist'
with open(sys.argv[2], 'w', encoding='utf-8') as fd: json.dump(cfg,fd,indent=2,ensure_ascii=False)
PY
(
  cd "$STAGING"
  "$NODE_BIN" "$NPX_CLI" --yes @neutralinojs/neu update
  "$NODE_BIN" "$NPX_CLI" --yes @neutralinojs/neu build --embed-resources
)
NEU_BINARY="$STAGING/dist/libramail-mac_${NEU_ARCH}"
if [[ ! -f "$NEU_BINARY" ]]; then
  NEU_BINARY="$(find "$STAGING/dist" -type f -name "*-mac_${NEU_ARCH}" -print -quit)"
fi
[[ -n "$NEU_BINARY" && -s "$NEU_BINARY" ]] || { echo '[macOS] Binaire Neutralino absent.' >&2; exit 1; }
install -m 0755 "$NEU_BINARY" "$APP_ROOT/bin/libramail-app"
cp "$ROOT/neutralino.config.json" "$APP_ROOT/neutralino.config.json"

# Native Node modules are installed and verified on their target macOS runner.
cp -R "$ROOT/engine" "$APP_ROOT/engine"
rm -rf "$APP_ROOT/engine/node_modules"
(
 cd "$APP_ROOT/engine"
 "$NODE_BIN" "$NPM_CLI" ci --omit=dev --no-audit --no-fund --foreground-scripts
 "$NODE_BIN" - <<'NODE'
const Database=require('better-sqlite3');
const db=new Database(':memory:');
if(db.prepare('SELECT 1 AS ok').get().ok!==1)process.exit(1);
db.close();
console.log('[macOS] SQLite natif compatible.');
NODE
)

# imapsync is mandatory on macOS too. Never ship a preview that silently
# disables migration. Intel uses upstream's standalone; arm64 uses a native
# PAR::Packer executable prepared from the pinned 2.314 Perl source.
IMAP_DIR="$APP_ROOT/runtime/imapsync"
mkdir -p "$IMAP_DIR"
if [[ "$ARCH" == x86_64 ]]; then
  IMAP_SHA="${IMAPSYNC_MACOS_X64_SHA256:-}"
  [[ "$IMAP_SHA" =~ ^[a-fA-F0-9]{64}$ ]] || {
    echo '[macOS] SHA-256 imapsync Intel absent : configurer IMAPSYNC_MACOS_X64_SHA256.' >&2; exit 1;
  }
  curl -fLsS --retry 3 --connect-timeout 20 \
    'https://imapsync.lamiral.info/dist2/imapsync_bin_Darwin_x86_64' -o "$WORK/imapsync-x64"
  [[ "$(shasum -a 256 "$WORK/imapsync-x64" | awk '{print $1}')" == "$(printf %s "$IMAP_SHA" | tr "[:upper:]" "[:lower:]")" ]] || {
    echo '[macOS] SHA-256 imapsync Intel invalide.' >&2; exit 1;
  }
  file "$WORK/imapsync-x64" | grep -q 'Mach-O.*x86_64' || {
    echo '[macOS] Exécutable imapsync Intel invalide.' >&2; exit 1;
  }
  install -m 0755 "$WORK/imapsync-x64" "$IMAP_DIR/imapsync"
else
  command -v pp >/dev/null || { echo '[macOS] PAR::Packer (pp) requis pour imapsync natif arm64.' >&2; exit 1; }
  python3 tools/prepare_imapsync_ci.py linux --dest "$WORK/imapsync-source"
  pp -x --xargs='--version' -o "$WORK/imapsync-arm64" "$WORK/imapsync-source/imapsync"
  file "$WORK/imapsync-arm64" | grep -q 'Mach-O.*arm64' || {
    echo '[macOS] PAR::Packer n’a pas produit un exécutable arm64.' >&2; exit 1;
  }
  install -m 0755 "$WORK/imapsync-arm64" "$IMAP_DIR/imapsync"
fi
# Same verified 2.314 source tarball provides upstream license.
python3 tools/prepare_imapsync_ci.py linux --dest "$WORK/imapsync-source"
cp "$WORK/imapsync-source/LICENSE" "$IMAP_DIR/LICENSE"
"$IMAP_DIR/imapsync" --version >/dev/null 2>&1 || "$IMAP_DIR/imapsync" --help >/dev/null 2>&1 || {
  echo '[macOS] imapsync ne démarre pas.' >&2; exit 1;
}

cat > "$APP/Contents/Info.plist" <<EOF_PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>CFBundleName</key><string>LibraMail</string>
 <key>CFBundleDisplayName</key><string>LibraMail</string>
 <key>CFBundleIdentifier</key><string>eu.libramail.app</string>
 <key>CFBundleExecutable</key><string>LibraMail</string>
 <key>CFBundlePackageType</key><string>APPL</string>
 <key>CFBundleShortVersionString</key><string>$VERSION</string>
 <key>CFBundleVersion</key><string>$VERSION</string>
 <key>LSMinimumSystemVersion</key><string>12.0</string>
 <key>NSHighResolutionCapable</key><true/>
</dict></plist>
EOF_PLIST
cat > "$APP/Contents/MacOS/LibraMail" <<'EOF_LAUNCH'
#!/bin/bash
set -Eeuo pipefail
APP_ROOT="$(cd "$(dirname "$0")/../Resources/app" && pwd -P)"
STATE_ROOT="$HOME/Library/Application Support/LibraMail"
export LIBRAMAIL_STATE_ROOT="$STATE_ROOT"
umask 077
mkdir -p "$STATE_ROOT/data"
LOG="$STATE_ROOT/data/engine.log"
cd "$APP_ROOT"
if nc -z 127.0.0.1 47800 2>/dev/null; then
  echo 'LibraMail: port 47800 déjà utilisé' >> "$LOG"
  exit 1
fi
"$APP_ROOT/runtime/node/bin/node" "$APP_ROOT/engine/backend.js" >>"$LOG" 2>&1 &
ENGINE_PID=$!
cleanup() { kill "$ENGINE_PID" 2>/dev/null || true; wait "$ENGINE_PID" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM
for ((i=0;i<150;i++)); do
  if nc -z 127.0.0.1 47800 2>/dev/null; then break; fi
  kill -0 "$ENGINE_PID" 2>/dev/null || { echo 'LibraMail: moteur arrêté, voir engine.log' >> "$LOG"; exit 1; }
  sleep 0.1
done
nc -z 127.0.0.1 47800 2>/dev/null || { echo 'LibraMail: délai de démarrage dépassé' >> "$LOG"; exit 1; }
"$APP_ROOT/bin/libramail-app" --path="$APP_ROOT"
EOF_LAUNCH
chmod 0755 "$APP/Contents/MacOS/LibraMail"

# Check the staged package, not only the source files.
"$APP_ROOT/runtime/node/bin/node" --check "$APP_ROOT/engine/backend.js"
file "$APP_ROOT/bin/libramail-app" | grep -q "Mach-O" || { echo '[macOS] Binaire application non Mach-O.' >&2; exit 1; }
APP_ZIP="LibraMail-${VERSION}-macos-${LABEL}.zip"
(
  cd "$WORK"
  zip -qry "$OUT/$APP_ZIP" 'LibraMail.app'
)
(cd "$OUT" && shasum -a 256 "$APP_ZIP" > "$APP_ZIP.sha256")
echo "[macOS] Préversion construite : $OUT/$APP_ZIP"
echo '[macOS] Non signée/non notarizée : validation réelle sur Mac nécessaire avant publication.'
