#!/usr/bin/env bash
# ============================================================================
# LibraMail — construction d'un paquet Debian .deb à partir du portable Linux
#
# Le paquet installé est immuable sous /opt/libramail. Toutes les données
# utilisateur sont redirigées vers :
#   $XDG_DATA_HOME/libramail
# ou, si XDG_DATA_HOME n'est pas défini :
#   $HOME/.local/share/libramail
#
# Usage :
#   ./build_deb.sh
#   ./build_deb.sh --fresh-npm
#   ./build_deb.sh --skip-portable-build
# ============================================================================

set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$SCRIPT_DIR"

FRESH_NPM=0
OFFLINE=0
SKIP_PORTABLE_BUILD=0
NODE_VERSION=""

usage() {
  cat <<'USAGE'
LibraMail — construction du paquet Debian

Options :
  --fresh-npm             Demande à build_linux.sh de réinstaller les dépendances.
  --offline               Interdit les téléchargements pendant le build portable.
  --skip-portable-build   Réutilise un dossier portable déjà construit.
  --node-version VERSION  Version Node.js transmise à build_linux.sh.
  -h, --help              Affiche cette aide.
USAGE
}

while (($#)); do
  case "$1" in
    --fresh-npm) FRESH_NPM=1 ;;
    --offline) OFFLINE=1 ;;
    --skip-portable-build) SKIP_PORTABLE_BUILD=1 ;;
    --node-version)
      shift
      (($#)) || { printf 'Valeur manquante après --node-version\n' >&2; exit 2; }
      NODE_VERSION="$1"
      ;;
    --node-version=*) NODE_VERSION="${1#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Option inconnue : %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '\033[1;34m[deb]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ OK ]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[ERREUR]\033[0m %s\n' "$*" >&2; exit 1; }

require_file() { [[ -f "$PROJECT_DIR/$1" ]] || die "Fichier introuvable : $1"; }
require_cmd()  { command -v "$1" >/dev/null 2>&1 || die "Commande requise absente : $1"; }

require_file VERSION
require_file neutralino.config.json
require_file build_linux.sh
require_file packaging/linux/libramail.desktop
require_file resources/icons/appIcon.png
require_cmd python3
require_cmd dpkg-deb
require_cmd sha256sum

cd "$PROJECT_DIR"

VERSION="$(tr -d '\r\n' < VERSION)"
CONFIG_VERSION="$(python3 - <<'PY'
import json
print(json.load(open('neutralino.config.json', encoding='utf-8'))['version'])
PY
)"
[[ "$VERSION" == "$CONFIG_VERSION" ]] \
  || die "VERSION ($VERSION) et neutralino.config.json ($CONFIG_VERSION) diffèrent."

case "$(uname -m)" in
  x86_64|amd64)
    PORTABLE_ARCH="x86_64"
    DEB_ARCH="amd64"
    ;;
  *)
    die "Le paquet Debian 0.4.8 est actuellement prévu pour amd64 uniquement."
    ;;
esac

PORTABLE_NAME="LibraMail-${VERSION}-linux-${PORTABLE_ARCH}"
PORTABLE_DIR="$PROJECT_DIR/build/linux/$PORTABLE_NAME"
OUTPUT_DIR="$PROJECT_DIR/build/linux"
WORK_DIR="$PROJECT_DIR/.build-deb-work"
PKG_ROOT="$WORK_DIR/libramail_${VERSION}_${DEB_ARCH}"
OPT_DIR="$PKG_ROOT/opt/libramail"
DEBIAN_DIR="$PKG_ROOT/DEBIAN"
BIN_DIR="$PKG_ROOT/usr/bin"
APPS_DIR="$PKG_ROOT/usr/share/applications"
ICON_DIR="$PKG_ROOT/usr/share/icons/hicolor/256x256/apps"
DOC_DIR="$PKG_ROOT/usr/share/doc/libramail"
DEB_FILE="$OUTPUT_DIR/libramail_${VERSION}_${DEB_ARCH}.deb"

cleanup() {
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT INT TERM HUP

if [[ "$SKIP_PORTABLE_BUILD" -eq 0 ]]; then
  BUILD_ARGS=()
  [[ "$FRESH_NPM" -eq 1 ]] && BUILD_ARGS+=(--fresh-npm)
  [[ "$OFFLINE" -eq 1 ]] && BUILD_ARGS+=(--offline)
  [[ -n "$NODE_VERSION" ]] && BUILD_ARGS+=(--node-version "$NODE_VERSION")
  log "Construction préalable du paquet Linux autonome..."
  "$PROJECT_DIR/build_linux.sh" "${BUILD_ARGS[@]}"
else
  log "Réutilisation du paquet Linux autonome existant."
fi

[[ -d "$PORTABLE_DIR" ]] \
  || die "Dossier portable introuvable : $PORTABLE_DIR"
[[ -x "$PORTABLE_DIR/libramail-app" ]] \
  || die "Binaire Neutralino absent du portable."
[[ -x "$PORTABLE_DIR/runtime/node/bin/node" ]] \
  || die "Runtime Node.js absent du portable."
[[ -f "$PORTABLE_DIR/engine/backend.js" ]] \
  || die "Moteur backend absent du portable."

rm -rf -- "$WORK_DIR"
mkdir -p -- \
  "$OPT_DIR" "$DEBIAN_DIR" "$BIN_DIR" "$APPS_DIR" "$ICON_DIR" "$DOC_DIR"

log "Copie du runtime autonome sous /opt/libramail..."
cp -a "$PORTABLE_DIR/." "$OPT_DIR/"

# Le .deb n'utilise jamais le data/ ni le lanceur portable placés sous /opt.
rm -rf -- "$OPT_DIR/data"
rm -f -- \
  "$OPT_DIR/libramail" \
  "$OPT_DIR/check_portable.sh" \
  "$OPT_DIR/README_LINUX.txt"

# Défense supplémentaire pour --skip-portable-build : un ancien portable local
# ne doit jamais faire entrer de reliquat de développement dans le .deb.
find "$OPT_DIR/engine" -type f \
  \( -name '*.old' -o -name '*.bak' -o -name '*.orig' \) -delete

cat > "$BIN_DIR/libramail" <<'LAUNCHER'
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

APP_DIR="/opt/libramail"
NODE_BIN="$APP_DIR/runtime/node/bin/node"
ENGINE_FILE="$APP_DIR/engine/backend.js"
APP_BIN="$APP_DIR/libramail-app"

if [[ -n "${XDG_DATA_HOME:-}" ]]; then
  STATE_ROOT="${XDG_DATA_HOME%/}/libramail"
else
  STATE_ROOT="${HOME:?HOME non défini}/.local/share/libramail"
fi

DATA_DIR="$STATE_ROOT/data"
LOG_FILE="$DATA_DIR/engine.log"

export LIBRAMAIL_STATE_ROOT="$STATE_ROOT"
export WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"

[[ -x "$NODE_BIN" ]] || {
  printf 'Erreur : runtime Node.js LibraMail introuvable : %s\n' "$NODE_BIN" >&2
  exit 1
}
[[ -f "$ENGINE_FILE" ]] || {
  printf 'Erreur : moteur LibraMail introuvable : %s\n' "$ENGINE_FILE" >&2
  exit 1
}
[[ -x "$APP_BIN" ]] || {
  printf 'Erreur : interface LibraMail introuvable : %s\n' "$APP_BIN" >&2
  exit 1
}

mkdir -p "$DATA_DIR"
cd "$APP_DIR"

port_is_open() {
  (exec 3<>/dev/tcp/127.0.0.1/47800) >/dev/null 2>&1
}

if port_is_open; then
  printf 'Erreur : LibraMail est déjà en cours d’exécution (port 47800 occupé).\n' >&2
  exit 1
fi

"$NODE_BIN" "$ENGINE_FILE" >>"$LOG_FILE" 2>&1 &
ENGINE_PID=$!

cleanup() {
  if [[ -n "${ENGINE_PID:-}" ]] && kill -0 "$ENGINE_PID" >/dev/null 2>&1; then
    kill -TERM "$ENGINE_PID" >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
      kill -0 "$ENGINE_PID" >/dev/null 2>&1 || break
      sleep 0.1
    done
    if kill -0 "$ENGINE_PID" >/dev/null 2>&1; then
      kill -KILL "$ENGINE_PID" >/dev/null 2>&1 || true
    fi
    wait "$ENGINE_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM HUP

for _ in $(seq 1 150); do
  port_is_open && break
  if ! kill -0 "$ENGINE_PID" >/dev/null 2>&1; then
    printf 'Le moteur LibraMail ne démarre pas. Consultez : %s\n' "$LOG_FILE" >&2
    tail -n 40 "$LOG_FILE" >&2 || true
    exit 1
  fi
  sleep 0.1
done

if ! port_is_open; then
  printf 'Délai dépassé pendant le démarrage du moteur. Consultez : %s\n' "$LOG_FILE" >&2
  exit 1
fi

"$APP_BIN" "$@"
LAUNCHER
chmod 0755 "$BIN_DIR/libramail"

install -m 0644 \
  "$PROJECT_DIR/packaging/linux/libramail.desktop" \
  "$APPS_DIR/libramail.desktop"
install -m 0644 \
  "$PROJECT_DIR/resources/icons/appIcon.png" \
  "$ICON_DIR/libramail.png"

cat > "$DOC_DIR/README.Debian" <<EOF
LibraMail ${VERSION} — paquet Debian amd64

Programme :
  /opt/libramail

Lanceur :
  /usr/bin/libramail

Données utilisateur :
  \${XDG_DATA_HOME}/libramail
ou, si XDG_DATA_HOME n'est pas défini :
  \${HOME}/.local/share/libramail

Les données d'une version portable ne sont pas déplacées automatiquement.
Utilisez de préférence la sauvegarde/restauration complète de LibraMail pour
migrer une installation existante vers le paquet Debian.

Node.js est embarqué dans /opt/libramail/runtime/node ; aucun paquet nodejs
système n'est nécessaire.
EOF

cat > "$DOC_DIR/copyright" <<'EOF'
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: LibraMail
Source: https://github.com/technifree/LibraMail

Files: *
Copyright: Vincent (technifree.com)
License: MIT

License: MIT
 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:
 .
 The above copyright notice and this permission notice shall be included in all
 copies or substantial portions of the Software.
 .
 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 SOFTWARE.
EOF

INSTALLED_SIZE="$(
  du -sk "$PKG_ROOT/opt" "$PKG_ROOT/usr" |
  awk '{ total += $1 } END { print total + 0 }'
)"

cat > "$DEBIAN_DIR/control" <<EOF
Package: libramail
Version: ${VERSION}
Section: mail
Priority: optional
Architecture: ${DEB_ARCH}
Maintainer: Vincent <vincent@technifree.fr>
Installed-Size: ${INSTALLED_SIZE}
Depends: libwebkit2gtk-4.1-0, libstdc++6, libgcc-s1, xdg-utils
Recommends: zenity | yad | kdialog
Homepage: https://github.com/technifree/LibraMail
Description: client de messagerie et planning local
 LibraMail est un client de messagerie de bureau avec gestion IMAP/POP3/SMTP,
 dossiers locaux, sauvegarde, restauration et planning. Le paquet embarque son
 propre runtime Node.js.
EOF

# Permissions déterministes : aucun fichier installé ne reste inscriptible par
# le groupe à cause des permissions du répertoire de développement.
find "$PKG_ROOT" -type d -exec chmod 0755 {} +
find "$PKG_ROOT" -type f -exec chmod 0644 {} +
chmod 0755 \
  "$BIN_DIR/libramail" \
  "$OPT_DIR/libramail-app" \
  "$OPT_DIR/runtime/node/bin/node"

# Vérifications de sécurité/structure avant création du paquet.
[[ ! -e "$OPT_DIR/data" ]] \
  || die "Le paquet Debian contient à tort /opt/libramail/data."
grep -Fq 'LIBRAMAIL_STATE_ROOT="$STATE_ROOT"' "$BIN_DIR/libramail" \
  || die "Le lanceur Debian ne configure pas LIBRAMAIL_STATE_ROOT."
grep -Fq 'XDG_DATA_HOME' "$BIN_DIR/libramail" \
  || die "Le lanceur Debian ne respecte pas XDG_DATA_HOME."
if grep -Fq 'APP_DIR/data' "$BIN_DIR/libramail"; then
  die "Le lanceur Debian tente encore d'écrire sous /opt/libramail."
fi
if find "$OPT_DIR/engine" -type f \
    \( -name '*.old' -o -name '*.bak' -o -name '*.orig' \) -print -quit | grep -q .; then
  die "Le paquet Debian contient encore un fichier .old/.bak/.orig."
fi
if find "$PKG_ROOT" -type f -perm /022 -print -quit | grep -q .; then
  die "Le paquet Debian contient un fichier inscriptible par groupe/autres."
fi

bash -n "$BIN_DIR/libramail"
"$OPT_DIR/runtime/node/bin/node" --check "$OPT_DIR/engine/backend.js"

if ldd "$OPT_DIR/libramail-app" 2>/dev/null | grep -q 'not found'; then
  ldd "$OPT_DIR/libramail-app" >&2 || true
  die "Une bibliothèque requise par Neutralino est absente sur la machine de build."
fi

mkdir -p "$OUTPUT_DIR"
rm -f -- "$DEB_FILE" "$DEB_FILE.sha256"

log "Création de $(basename "$DEB_FILE")..."
dpkg-deb --root-owner-group --build "$PKG_ROOT" "$DEB_FILE"

(
  cd "$OUTPUT_DIR"
  sha256sum "$(basename "$DEB_FILE")" > "$(basename "$DEB_FILE").sha256"
)

log "Contrôle du paquet..."
dpkg-deb --info "$DEB_FILE" >/dev/null

# Avec `set -o pipefail`, un `grep -q` directement branché sur dpkg-deb peut
# fermer le tube dès la première correspondance et faire terminer dpkg-deb par
# SIGPIPE. On génère donc la liste une seule fois puis on la contrôle hors pipe.
CONTENTS_FILE="$WORK_DIR/deb-contents.txt"
dpkg-deb --contents "$DEB_FILE" > "$CONTENTS_FILE"

grep -Fq './usr/bin/libramail' "$CONTENTS_FILE"
grep -Fq './opt/libramail/libramail-app' "$CONTENTS_FILE"
grep -Fq './usr/share/applications/libramail.desktop' "$CONTENTS_FILE"
grep -Fq './usr/share/icons/hicolor/256x256/apps/libramail.png' "$CONTENTS_FILE"

if grep -Fq './opt/libramail/data/' "$CONTENTS_FILE"; then
  die "Le .deb final contient un dossier de données sous /opt."
fi

ok "Paquet Debian créé."
printf '\nPaquet :\n  %s\n' "$DEB_FILE"
printf 'SHA-256 :\n  %s.sha256\n' "$DEB_FILE"
printf '\nInspection :\n  dpkg-deb --info %q\n  dpkg-deb --contents %q | less\n' "$DEB_FILE" "$DEB_FILE"
