#!/usr/bin/env bash
# ============================================================================
# LibraMail — Construction d'un paquet GNU/Linux autonome
#
# Le paquet final embarque son propre exécutable Node.js. Aucun Node.js installé
# sur le poste cible n'est nécessaire.
#
# Usage courant :
#   ./build_linux.sh
#   ./build_linux.sh --with-data
#   ./build_linux.sh --fresh-npm
#
# Le script doit être placé à la racine du projet, à côté de :
#   neutralino.config.json, resources/, engine/ et éventuellement data/.
# ============================================================================

set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$SCRIPT_DIR"

WITH_DATA=0
FRESH_NPM=0
EMBED_RESOURCES=0
KEEP_WORK=0
OFFLINE=0
NODE_VERSION="${LIBRAMAIL_NODE_VERSION:-24.18.0}"

usage() {
  cat <<'USAGE'
LibraMail — construction Linux autonome

Options :
  --with-data             Inclut data/ dans le paquet final.
                          Attention : les comptes et mots de passe enregistrés
                          seront présents dans l'archive privée.
  --fresh-npm             Réinstalle les dépendances de production avec le
                          Node.js embarqué, au lieu de recopier node_modules.
  --embed-resources       Intègre les ressources Neutralino dans l'exécutable.
  --node-version VERSION  Version officielle de Node.js à embarquer.
                          Valeur par défaut : 24.18.0
  --offline               Interdit tout téléchargement. Les fichiers Node.js
                          doivent déjà être présents dans le cache du projet.
  --keep-work             Conserve le dossier .build-linux-work pour diagnostic.
  -h, --help              Affiche cette aide.

Variables facultatives :
  LIBRAMAIL_NODE_VERSION  Même rôle que --node-version.
  LIBRAMAIL_NODE_MIRROR   Miroir Node.js, par défaut https://nodejs.org/dist
USAGE
}

while (($#)); do
  case "$1" in
    --with-data) WITH_DATA=1 ;;
    --fresh-npm) FRESH_NPM=1 ;;
    --embed-resources) EMBED_RESOURCES=1 ;;
    --offline) OFFLINE=1 ;;
    --keep-work) KEEP_WORK=1 ;;
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

log()  { printf '\033[1;34m[build]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ OK  ]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARN ]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[ERREUR]\033[0m %s\n' "$*" >&2; exit 1; }

require_file() { [[ -f "$PROJECT_DIR/$1" ]] || die "Fichier introuvable : $1"; }
require_dir()  { [[ -d "$PROJECT_DIR/$1" ]] || die "Dossier introuvable : $1"; }
require_cmd()  { command -v "$1" >/dev/null 2>&1 || die "Commande requise absente : $1"; }

[[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "Version Node.js invalide : $NODE_VERSION"

require_file neutralino.config.json
require_file resources/index.html
require_file resources/js/i18n.js
require_file resources/js/maillist.js
require_file resources/js/viewer.js
require_file resources/vendor/purify.min.js
require_file engine/backend.js
require_dir resources
require_dir engine
require_cmd python3
require_cmd tar
require_cmd xz
require_cmd sha256sum

if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  [[ "$OFFLINE" -eq 1 ]] || die "curl ou wget est requis pour télécharger Node.js."
fi

cd "$PROJECT_DIR"

# Évite de prendre un instantané pendant que le moteur écrit dans SQLite.
if pgrep -f "${PROJECT_DIR//\//\\/}/engine/backend\.js" >/dev/null 2>&1; then
  die "Le moteur LibraMail semble actif. Fermez l'application avant la compilation."
fi

readarray -t META < <(python3 - <<'PY'
import json
from pathlib import Path
cfg = json.loads(Path('neutralino.config.json').read_text(encoding='utf-8'))
print(cfg.get('version', '0.0.0'))
print(cfg.get('cli', {}).get('binaryName', 'libramail'))
print(cfg.get('applicationId', 'eu.libramail.app'))
PY
)

VERSION="${META[0]}"
BINARY_NAME="${META[1]}"
APPLICATION_ID="${META[2]}"

case "$(uname -m)" in
  x86_64|amd64)
    NODE_ARCH="x64"
    NEU_ARCH="x64"
    PACKAGE_ARCH="x86_64"
    ;;
  aarch64|arm64)
    NODE_ARCH="arm64"
    NEU_ARCH="arm64"
    PACKAGE_ARCH="arm64"
    ;;
  *)
    die "Architecture non prise en charge : $(uname -m). Le script gère x86_64 et arm64."
    ;;
esac

NODE_MIRROR="${LIBRAMAIL_NODE_MIRROR:-https://nodejs.org/dist}"
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
NODE_FOLDER="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
NODE_RELEASE_URL="${NODE_MIRROR%/}/v${NODE_VERSION}"

CACHE_DIR="$PROJECT_DIR/.cache/libramail-node/v${NODE_VERSION}"
NODE_ARCHIVE_PATH="$CACHE_DIR/$NODE_ARCHIVE"
NODE_SHASUMS_PATH="$CACHE_DIR/SHASUMS256.txt"

WORK_DIR="$PROJECT_DIR/.build-linux-work"
NODE_EXTRACT_DIR="$WORK_DIR/node-runtime-source"
NODE_DIST_DIR="$NODE_EXTRACT_DIR/$NODE_FOLDER"
NODE_BIN="$NODE_DIST_DIR/bin/node"
NPM_CLI="$NODE_DIST_DIR/lib/node_modules/npm/bin/npm-cli.js"
NPX_CLI="$NODE_DIST_DIR/lib/node_modules/npm/bin/npx-cli.js"

NEU_DIST="$WORK_DIR/neutralino-dist"
PACKAGE_NAME="LibraMail-${VERSION}-linux-${PACKAGE_ARCH}"
PACKAGE_DIR="$WORK_DIR/$PACKAGE_NAME"
OUTPUT_DIR="$PROJECT_DIR/build/linux"
CONFIG_BACKUP="$WORK_DIR/neutralino.config.original.json"
CONFIG_PATCHED=0

restore_project_config() {
  if [[ "$CONFIG_PATCHED" -eq 1 && -f "$CONFIG_BACKUP" ]]; then
    cp -- "$CONFIG_BACKUP" "$PROJECT_DIR/neutralino.config.json"
    CONFIG_PATCHED=0
  fi
}

cleanup() {
  restore_project_config
  if [[ "$KEEP_WORK" -eq 0 ]]; then
    rm -rf -- "$WORK_DIR"
  else
    warn "Dossier de travail conservé : $WORK_DIR"
  fi
}
trap cleanup EXIT INT TERM HUP

rm -rf -- "$WORK_DIR"
mkdir -p -- "$CACHE_DIR" "$NODE_EXTRACT_DIR" "$NEU_DIST" "$PACKAGE_DIR" "$OUTPUT_DIR"

download_file() {
  local url="$1"
  local destination="$2"
  local temporary="${destination}.part"

  [[ "$OFFLINE" -eq 0 ]] || die "Mode hors ligne : fichier absent du cache : $destination"
  rm -f -- "$temporary"
  log "Téléchargement : $url"

  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --retry 3 --retry-delay 2 \
      --connect-timeout 20 --output "$temporary" "$url"
  else
    wget --tries=3 --timeout=30 --output-document="$temporary" "$url"
  fi

  [[ -s "$temporary" ]] || die "Téléchargement vide : $url"
  mv -- "$temporary" "$destination"
}

prepare_embedded_node() {
  if [[ ! -s "$NODE_SHASUMS_PATH" ]]; then
    download_file "$NODE_RELEASE_URL/SHASUMS256.txt" "$NODE_SHASUMS_PATH"
  fi
  if [[ ! -s "$NODE_ARCHIVE_PATH" ]]; then
    download_file "$NODE_RELEASE_URL/$NODE_ARCHIVE" "$NODE_ARCHIVE_PATH"
  fi

  local expected
  expected="$(awk -v file="$NODE_ARCHIVE" '$2 == file { print $1 "  " $2; exit }' "$NODE_SHASUMS_PATH")"
  [[ -n "$expected" ]] || die "$NODE_ARCHIVE n'est pas référencé dans SHASUMS256.txt."

  if ! (cd "$CACHE_DIR" && printf '%s\n' "$expected" | sha256sum --check --status -); then
    if [[ "$OFFLINE" -eq 1 ]]; then
      die "La somme SHA-256 de l'archive Node.js en cache est invalide."
    fi
    warn "Archive Node.js invalide. Nouveau téléchargement..."
    rm -f -- "$NODE_ARCHIVE_PATH" "$NODE_SHASUMS_PATH"
    download_file "$NODE_RELEASE_URL/SHASUMS256.txt" "$NODE_SHASUMS_PATH"
    download_file "$NODE_RELEASE_URL/$NODE_ARCHIVE" "$NODE_ARCHIVE_PATH"
    expected="$(awk -v file="$NODE_ARCHIVE" '$2 == file { print $1 "  " $2; exit }' "$NODE_SHASUMS_PATH")"
    [[ -n "$expected" ]] || die "$NODE_ARCHIVE n'est pas référencé après téléchargement."
    (cd "$CACHE_DIR" && printf '%s\n' "$expected" | sha256sum --check --status -) \
      || die "Échec de la vérification SHA-256 de Node.js."
  fi
  ok "Archive Node.js ${NODE_VERSION} vérifiée."

  tar -xJf "$NODE_ARCHIVE_PATH" -C "$NODE_EXTRACT_DIR"
  [[ -x "$NODE_BIN" ]] || die "Exécutable Node.js absent après extraction : $NODE_BIN"
  [[ -f "$NPM_CLI" ]] || die "npm est absent de la distribution Node.js extraite."
  [[ -f "$NPX_CLI" ]] || die "npx est absent de la distribution Node.js extraite."

  local actual_version
  actual_version="$($NODE_BIN --version)"
  [[ "$actual_version" == "v$NODE_VERSION" ]] \
    || die "Version Node.js extraite inattendue : $actual_version"

  export PATH="$NODE_DIST_DIR/bin:$PATH"
  ok "Moteur de construction : Node.js $actual_version (${NODE_ARCH})."
}

npm_cmd() { "$NODE_BIN" "$NPM_CLI" "$@"; }
npx_cmd() { "$NODE_BIN" "$NPX_CLI" "$@"; }

prepare_embedded_node

# neu CLI lit neutralino.config.json dans le dossier courant. Le fichier est
# modifié uniquement pendant le build, puis restauré même en cas d'interruption.
cp -- "$PROJECT_DIR/neutralino.config.json" "$CONFIG_BACKUP"
CONFIG_PATCHED=1
python3 - <<'PY'
import json
from pathlib import Path

path = Path('neutralino.config.json')
cfg = json.loads(path.read_text(encoding='utf-8'))
version = cfg.get('version', '0.0.0')
cfg.setdefault('modes', {}).setdefault('window', {})['title'] = f'LibraMail {version}'
cfg.setdefault('cli', {})['distributionPath'] = '.build-linux-work/neutralino-dist'
path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
PY

if [[ -x "$PROJECT_DIR/node_modules/.bin/neu" ]]; then
  NEU=("$PROJECT_DIR/node_modules/.bin/neu")
elif command -v neu >/dev/null 2>&1; then
  NEU=(neu)
else
  warn "neu CLI absent. Utilisation de npx avec le Node.js embarqué."
  NEU=("$NODE_BIN" "$NPX_CLI" --yes @neutralinojs/neu)
fi

NEU_SOURCE_BINARY="$PROJECT_DIR/bin/neutralino-linux_${NEU_ARCH}"
NEU_CLIENT_LIBRARY="$PROJECT_DIR/resources/js/neutralino.js"
if [[ ! -f "$NEU_SOURCE_BINARY" || ! -f "$NEU_CLIENT_LIBRARY" ]]; then
  log "Binaires ou client Neutralino absents. Téléchargement de la version déclarée dans neutralino.config.json..."
  "${NEU[@]}" update
fi
[[ -f "$NEU_SOURCE_BINARY" ]] \
  || die "Le binaire Neutralino attendu n'a pas été téléchargé : $NEU_SOURCE_BINARY"
[[ -f "$NEU_CLIENT_LIBRARY" ]] \
  || die "Le client Neutralino attendu n'a pas été généré : $NEU_CLIENT_LIBRARY"

log "Construction Neutralino ${VERSION} pour Linux ${PACKAGE_ARCH}..."
BUILD_ARGS=(build)
[[ "$EMBED_RESOURCES" -eq 1 ]] && BUILD_ARGS+=(--embed-resources)
"${NEU[@]}" "${BUILD_ARGS[@]}"
restore_project_config

EXPECTED_NEU_BINARY="$NEU_DIST/${BINARY_NAME}-linux_${NEU_ARCH}"
NEU_BINARY=""

if [[ -f "$EXPECTED_NEU_BINARY" ]]; then
  NEU_BINARY="$EXPECTED_NEU_BINARY"
else
  mapfile -t NEU_BINARY_CANDIDATES < <(
    find "$NEU_DIST" -maxdepth 4 -type f \
      -name "*-linux_${NEU_ARCH}" \
      ! -name '*.sha256' ! -name '*.zip' ! -name '*.tar.gz' \
      -print | sort
  )

  if [[ "${#NEU_BINARY_CANDIDATES[@]}" -eq 0 ]]; then
    warn "Binaire attendu absent : $EXPECTED_NEU_BINARY"
    warn "Contenu produit par neu :"
    while IFS= read -r file; do
      printf '  - %s\n' "${file#"$NEU_DIST"/}" >&2
    done < <(find "$NEU_DIST" -maxdepth 4 -type f -print | sort)
    die "Aucun binaire Neutralino Linux ${NEU_ARCH} trouvé."
  fi

  expected_lower="${BINARY_NAME,,}-linux_${NEU_ARCH}"
  for candidate in "${NEU_BINARY_CANDIDATES[@]}"; do
    candidate_name="${candidate##*/}"
    if [[ "${candidate_name,,}" == "$expected_lower" ]]; then
      NEU_BINARY="$candidate"
      break
    fi
  done

  if [[ -z "$NEU_BINARY" ]]; then
    for candidate in "${NEU_BINARY_CANDIDATES[@]}"; do
      if [[ -x "$candidate" ]]; then
        NEU_BINARY="$candidate"
        break
      fi
    done
  fi
  [[ -n "$NEU_BINARY" ]] || NEU_BINARY="${NEU_BINARY_CANDIDATES[0]}"
  warn "Nom Neutralino différent de la valeur attendue : ${NEU_BINARY#"$NEU_DIST"/}"
fi

[[ -s "$NEU_BINARY" ]] || die "Le binaire Neutralino détecté est vide."
install -m 0755 "$NEU_BINARY" "$PACKAGE_DIR/libramail-app"
ok "Binaire Neutralino : ${NEU_BINARY#"$NEU_DIST"/}"

if [[ "$EMBED_RESOURCES" -eq 0 ]]; then
  RESOURCES_NEU="$NEU_DIST/resources.neu"
  if [[ ! -f "$RESOURCES_NEU" ]]; then
    mapfile -t RESOURCE_CANDIDATES < <(
      find "$NEU_DIST" -maxdepth 4 -type f -name resources.neu -print | sort
    )
    [[ "${#RESOURCE_CANDIDATES[@]}" -gt 0 ]] || die "resources.neu n'a pas été généré."
    RESOURCES_NEU="${RESOURCE_CANDIDATES[0]}"
  fi
  cp -- "$RESOURCES_NEU" "$PACKAGE_DIR/resources.neu"
  ok "Ressources Neutralino : ${RESOURCES_NEU#"$NEU_DIST"/}"
fi

# ---------------------------------------------------------------------------
# Runtime Node.js embarqué
# ---------------------------------------------------------------------------
log "Intégration du runtime Node.js autonome..."
mkdir -p "$PACKAGE_DIR/runtime/node/bin"
install -m 0755 "$NODE_BIN" "$PACKAGE_DIR/runtime/node/bin/node"
if [[ -f "$NODE_DIST_DIR/LICENSE" ]]; then
  cp -- "$NODE_DIST_DIR/LICENSE" "$PACKAGE_DIR/runtime/node/LICENSE"
fi
printf '%s\n' "$NODE_VERSION" > "$PACKAGE_DIR/runtime/node/VERSION"
ok "Runtime intégré : runtime/node/bin/node (v${NODE_VERSION})."

# ---------------------------------------------------------------------------
# Moteur LibraMail et dépendances npm
# ---------------------------------------------------------------------------
log "Préparation du moteur JavaScript..."
mkdir -p "$PACKAGE_DIR/engine"

if command -v rsync >/dev/null 2>&1; then
  rsync -a \
    --exclude node_modules \
    --exclude '*.log' \
    --exclude '.npm' \
    --exclude '.cache' \
    "$PROJECT_DIR/engine/" "$PACKAGE_DIR/engine/"
else
  cp -a "$PROJECT_DIR/engine/." "$PACKAGE_DIR/engine/"
  rm -rf "$PACKAGE_DIR/engine/node_modules" \
         "$PACKAGE_DIR/engine/.npm" \
         "$PACKAGE_DIR/engine/.cache"
  find "$PACKAGE_DIR/engine" -type f -name '*.log' -delete
fi

install_engine_dependencies() {
  local target="$PACKAGE_DIR/engine"
  if [[ -f "$target/package-lock.json" ]]; then
    (cd "$target" && npm_cmd ci --omit=dev --no-audit --no-fund --foreground-scripts)
  elif [[ -f "$target/package.json" ]]; then
    (cd "$target" && npm_cmd install --omit=dev --no-audit --no-fund --foreground-scripts)
  else
    return 1
  fi
}

if [[ "$FRESH_NPM" -eq 0 && -d "$PROJECT_DIR/engine/node_modules" ]]; then
  log "Copie des dépendances existantes..."
  cp -a "$PROJECT_DIR/engine/node_modules" "$PACKAGE_DIR/engine/node_modules"
else
  log "Installation des dépendances avec Node.js ${NODE_VERSION}..."
  install_engine_dependencies || die \
    "engine/package.json est absent et engine/node_modules n'est pas disponible."
fi

[[ -d "$PACKAGE_DIR/engine/node_modules" ]] \
  || die "Le dossier engine/node_modules n'a pas été préparé."

validate_sqlite_module() {
  (cd "$PACKAGE_DIR/engine" && "$NODE_BIN" - <<'NODE'
const Database = require('better-sqlite3');
const db = new Database(':memory:');
const row = db.prepare('SELECT 1 AS ok').get();
if (!row || row.ok !== 1) throw new Error('Test SQLite invalide');
db.close();
NODE
  ) >/dev/null 2>&1
}

if ! validate_sqlite_module; then
  warn "better-sqlite3 n'est pas compatible avec Node.js ${NODE_VERSION}."
  if [[ -f "$PACKAGE_DIR/engine/package.json" ]]; then
    log "Reconstruction de better-sqlite3 avec le runtime embarqué..."
    (cd "$PACKAGE_DIR/engine" && \
      npm_cmd rebuild better-sqlite3 --no-audit --no-fund --foreground-scripts) \
      || warn "La reconstruction ciblée a échoué."
  fi
fi

if ! validate_sqlite_module; then
  if [[ "$FRESH_NPM" -eq 0 && -f "$PACKAGE_DIR/engine/package.json" ]]; then
    warn "Nouvelle installation complète des dépendances..."
    rm -rf "$PACKAGE_DIR/engine/node_modules"
    install_engine_dependencies || true
  fi
fi

validate_sqlite_module || die \
  "better-sqlite3 reste inutilisable avec Node.js ${NODE_VERSION}. Installez build-essential et relancez avec --fresh-npm."
ok "better-sqlite3 fonctionne avec le runtime embarqué."

# ---------------------------------------------------------------------------
# Données : dossier vide ou instantané privé cohérent
# ---------------------------------------------------------------------------
mkdir -p "$PACKAGE_DIR/data"
if [[ "$WITH_DATA" -eq 1 ]]; then
  [[ -d "$PROJECT_DIR/data" ]] || die "--with-data demandé, mais data/ est absent."
  warn "Le paquet contiendra les comptes, messages et secrets enregistrés."

  if command -v rsync >/dev/null 2>&1; then
    rsync -a \
      --exclude index.db \
      --exclude index.db-wal \
      --exclude index.db-shm \
      --exclude '*.log' \
      "$PROJECT_DIR/data/" "$PACKAGE_DIR/data/"
  else
    cp -a "$PROJECT_DIR/data/." "$PACKAGE_DIR/data/"
    rm -f "$PACKAGE_DIR/data/index.db" \
          "$PACKAGE_DIR/data/index.db-wal" \
          "$PACKAGE_DIR/data/index.db-shm"
    find "$PACKAGE_DIR/data" -type f -name '*.log' -delete
  fi

  if [[ -f "$PROJECT_DIR/data/index.db" ]]; then
    log "Création d'un instantané cohérent de SQLite..."
    python3 - "$PROJECT_DIR/data/index.db" "$PACKAGE_DIR/data/index.db" <<'PY_SQLITE'
import re
import sqlite3
import sys
from pathlib import Path, PurePosixPath

source = Path(sys.argv[1])
target = Path(sys.argv[2])
target.parent.mkdir(parents=True, exist_ok=True)
if target.exists():
    target.unlink()

src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
dst = sqlite3.connect(target)
try:
    src.backup(dst)
    tables = {row[0] for row in dst.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'messages' in tables:
        columns = {row[1] for row in dst.execute('PRAGMA table_info(messages)')}
        required = {'id', 'account_id', 'folder', 'uid', 'eml_path'}
        if required.issubset(columns):
            rows = dst.execute(
                "SELECT id, account_id, folder, uid FROM messages "
                "WHERE eml_path IS NOT NULL AND eml_path <> ''"
            ).fetchall()
            for message_id, account_id, folder, uid in rows:
                safe_folder = re.sub(r'[^\w.-]', '_', str(folder or 'INBOX'), flags=re.ASCII)
                relative = PurePosixPath(
                    'mail', str(account_id or ''), safe_folder, f'{uid}.eml'
                ).as_posix()
                dst.execute('UPDATE messages SET eml_path=? WHERE id=?', (relative, message_id))
    dst.commit()
finally:
    dst.close()
    src.close()
PY_SQLITE
  else
    warn "Aucune base data/index.db à inclure."
  fi

  EML_COUNT="$(find "$PACKAGE_DIR/data/mail" -type f -name '*.eml' 2>/dev/null | wc -l | tr -d ' ')"
  ok "Messages locaux copiés : ${EML_COUNT:-0} fichier(s) .eml."
fi

# ---------------------------------------------------------------------------
# Lanceur autonome : chemin explicite vers le Node.js du paquet
# ---------------------------------------------------------------------------
cat > "$PACKAGE_DIR/libramail" <<'LAUNCHER'
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
NODE_BIN="$APP_DIR/runtime/node/bin/node"
ENGINE_FILE="$APP_DIR/engine/backend.js"
APP_BIN="$APP_DIR/libramail-app"
DATA_DIR="$APP_DIR/data"
LOG_FILE="$DATA_DIR/engine.log"

cd "$APP_DIR"
export WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"

[[ -x "$NODE_BIN" ]] || {
  printf 'Erreur : runtime Node.js embarqué introuvable : %s\n' "$NODE_BIN" >&2
  exit 1
}
[[ -f "$ENGINE_FILE" ]] || {
  printf 'Erreur : moteur LibraMail introuvable : %s\n' "$ENGINE_FILE" >&2
  exit 1
}
[[ -x "$APP_BIN" ]] || {
  printf 'Erreur : exécutable Neutralino introuvable : %s\n' "$APP_BIN" >&2
  exit 1
}

mkdir -p "$DATA_DIR"

port_is_open() {
  (exec 3<>/dev/tcp/127.0.0.1/47800) >/dev/null 2>&1
}

if port_is_open; then
  printf 'Erreur : le port 47800 est déjà utilisé. Une autre instance de LibraMail est probablement ouverte.\n' >&2
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
  if port_is_open; then
    break
  fi
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
chmod 0755 "$PACKAGE_DIR/libramail"

cat > "$PACKAGE_DIR/check_portable.sh" <<'CHECKER'
#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
NODE_BIN="$APP_DIR/runtime/node/bin/node"

printf 'Runtime embarqué : '
"$NODE_BIN" --version

"$NODE_BIN" --check "$APP_DIR/engine/backend.js"
(
  cd "$APP_DIR/engine"
  "$NODE_BIN" - <<'NODE'
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.prepare('SELECT 1').get();
db.close();
console.log('better-sqlite3 : OK');
NODE
)
printf 'Lanceur autonome : OK\n'
CHECKER
chmod 0755 "$PACKAGE_DIR/check_portable.sh"

cat > "$PACKAGE_DIR/README_LINUX.txt" <<EOF_README
LibraMail ${VERSION} — paquet autonome GNU/Linux ${PACKAGE_ARCH}

Lancement :
  ./libramail

Contrôle du paquet :
  ./check_portable.sh

Node.js :
  - version embarquée : ${NODE_VERSION}
  - exécutable utilisé : ./runtime/node/bin/node
  - aucune installation de Node.js ou npm n'est requise sur le poste cible.

Prérequis système :
  - une distribution GNU/Linux compatible avec les binaires fournis ;
  - WebKitGTK 4.1 pour l'interface Neutralino ;
  - zenity, yad ou kdialog recommandé pour les sélecteurs de fichiers.

Sur Debian / LMDE :
  sudo apt install libwebkit2gtk-4.1-0 zenity

Données :
  - dossier local : ./data
  - identifiant d'application : ${APPLICATION_ID}
  - données incluses pendant la construction : $([[ "$WITH_DATA" -eq 1 ]] && echo oui || echo non)

Le dossier LibraMail peut être déplacé en bloc. Ne déplacez pas uniquement le
fichier libramail : il dépend de libramail-app, runtime/, engine/ et data/.

Sécurité :
  Lorsque les données sont incluses, accounts.json et les sauvegardes peuvent
  contenir des identifiants de messagerie. Ne diffusez pas cette archive.
EOF_README

# ---------------------------------------------------------------------------
# Vérifications finales avec le runtime du paquet, jamais avec /usr/bin/node
# ---------------------------------------------------------------------------
log "Vérification du paquet autonome..."
PACKAGE_NODE="$PACKAGE_DIR/runtime/node/bin/node"
[[ -x "$PACKAGE_DIR/libramail" ]] || die "Lanceur absent."
[[ -x "$PACKAGE_DIR/libramail-app" ]] || die "Binaire Neutralino absent."
[[ -x "$PACKAGE_NODE" ]] || die "Runtime Node.js absent."
[[ -f "$PACKAGE_DIR/engine/backend.js" ]] || die "Moteur absent."

bash -n "$PACKAGE_DIR/libramail"
bash -n "$PACKAGE_DIR/check_portable.sh"

grep -Fq 'runtime/node/bin/node' "$PACKAGE_DIR/libramail" \
  || die "Le lanceur ne référence pas le runtime embarqué."
if grep -Eq '(^|[[:space:]])node[[:space:]]+.*backend\.js' "$PACKAGE_DIR/libramail"; then
  die "Le lanceur contient encore un appel au Node.js du système."
fi

while IFS= read -r -d '' js_file; do
  "$PACKAGE_NODE" --check "$js_file" >/dev/null
done < <(find "$PACKAGE_DIR/engine" -type f -name '*.js' \
  -not -path '*/node_modules/*' -print0)

(cd "$PACKAGE_DIR/engine" && "$PACKAGE_NODE" - <<'NODE'
const Database = require('better-sqlite3');
const db = new Database(':memory:');
const row = db.prepare('SELECT 42 AS value').get();
if (row.value !== 42) throw new Error('SQLite invalide');
db.close();
NODE
)

if command -v ldd >/dev/null 2>&1; then
  if ldd "$PACKAGE_NODE" 2>/dev/null | grep -q 'not found'; then
    ldd "$PACKAGE_NODE" >&2 || true
    die "Une bibliothèque système requise par Node.js est absente."
  fi
fi

ok "Le moteur utilise exclusivement Node.js ${NODE_VERSION} embarqué."

rm -rf "$OUTPUT_DIR/$PACKAGE_NAME"
cp -a "$PACKAGE_DIR" "$OUTPUT_DIR/$PACKAGE_NAME"

TAR_FILE="$OUTPUT_DIR/${PACKAGE_NAME}.tar.gz"
ZIP_FILE="$OUTPUT_DIR/${PACKAGE_NAME}.zip"
rm -f "$TAR_FILE" "$ZIP_FILE" "$TAR_FILE.sha256" "$ZIP_FILE.sha256"

log "Création de l'archive tar.gz..."
tar -C "$OUTPUT_DIR" -czf "$TAR_FILE" "$PACKAGE_NAME"

if command -v zip >/dev/null 2>&1; then
  log "Création de l'archive ZIP..."
  (cd "$OUTPUT_DIR" && zip -qr "$(basename "$ZIP_FILE")" "$PACKAGE_NAME")
else
  warn "zip est absent : seule l'archive tar.gz est créée."
fi

(cd "$OUTPUT_DIR" && sha256sum "$(basename "$TAR_FILE")" > "$(basename "$TAR_FILE").sha256")
if [[ -f "$ZIP_FILE" ]]; then
  (cd "$OUTPUT_DIR" && sha256sum "$(basename "$ZIP_FILE")" > "$(basename "$ZIP_FILE").sha256")
fi

PACKAGE_SIZE="$(du -sh "$OUTPUT_DIR/$PACKAGE_NAME" | awk '{print $1}')"
ok "Construction autonome terminée (${PACKAGE_SIZE})."
printf '\nDossier portable :\n  %s\n' "$OUTPUT_DIR/$PACKAGE_NAME"
printf 'Archives :\n  %s\n' "$TAR_FILE"
[[ -f "$ZIP_FILE" ]] && printf '  %s\n' "$ZIP_FILE"
printf '\nTest :\n  %s/check_portable.sh\n' "$OUTPUT_DIR/$PACKAGE_NAME"
printf 'Lancement :\n  %s/libramail\n' "$OUTPUT_DIR/$PACKAGE_NAME"
