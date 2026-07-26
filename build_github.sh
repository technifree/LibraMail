#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"

command -v gh >/dev/null 2>&1 || { echo "gh est requis." >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Lancez : gh auth login" >&2; exit 1; }
git remote get-url origin >/dev/null 2>&1 || { echo "Dépôt GitHub non initialisé." >&2; exit 1; }

./security_check.sh
python3 tools/check_version.py

BRANCH="$(git branch --show-current)"
[[ -n "$BRANCH" ]] || BRANCH="master"
WORKFLOW="build.yml"
OUT_DIR="$ROOT/github-artifacts"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "[GitHub] Déclenchement des compilations Linux et Windows..."
gh workflow run "$WORKFLOW" --ref "$BRANCH"

RUN_ID=""
for _ in $(seq 1 30); do
  RUN_ID="$(gh run list --workflow "$WORKFLOW" --branch "$BRANCH" --event workflow_dispatch \
    --limit 10 --json databaseId,status,createdAt \
    --jq 'sort_by(.createdAt) | reverse | .[0].databaseId // empty')"
  [[ -n "$RUN_ID" ]] && break
  sleep 2
done
[[ -n "$RUN_ID" ]] || { echo "Impossible de retrouver le workflow déclenché." >&2; exit 1; }

echo "[GitHub] Suivi de l'exécution $RUN_ID..."
gh run watch "$RUN_ID" --exit-status

echo "[GitHub] Téléchargement des artefacts..."
gh run download "$RUN_ID" --dir "$OUT_DIR"

VERSION="$(python3 - <<'PY'
import json
from pathlib import Path
cfg = json.loads(Path('neutralino.config.json').read_text(encoding='utf-8'))
print(str(cfg.get('version', '')).strip())
PY
)"
[[ -n "$VERSION" ]] || { echo "Version introuvable dans neutralino.config.json." >&2; exit 1; }

echo "[GitHub] Vérification des artefacts LibraMail ${VERSION}..."
mapfile -t LINUX_TARS < <(find "$OUT_DIR" -type f -name "LibraMail-${VERSION}-linux-*.tar.gz" | sort)
mapfile -t WINDOWS_ZIPS < <(find "$OUT_DIR" -type f -name "LibraMail-${VERSION}-windows-*.zip" | sort)

if ((${#LINUX_TARS[@]} == 0)); then
  echo "Artefact Linux tar.gz LibraMail ${VERSION} introuvable." >&2
  exit 1
fi

if ((${#WINDOWS_ZIPS[@]} == 0)); then
  echo "Artefact Windows zip LibraMail ${VERSION} introuvable." >&2
  exit 1
fi

mapfile -t BAD_ARTIFACTS < <(
  find "$OUT_DIR" -type f \
    \( -name 'LibraMail-*.zip' -o -name 'LibraMail-*.tar.gz' -o -name 'LibraMail-*.zip.sha256' -o -name 'LibraMail-*.tar.gz.sha256' \) \
    ! -name "LibraMail-${VERSION}-*" | sort
)

if ((${#BAD_ARTIFACTS[@]} > 0)); then
  echo "Artefacts avec une mauvaise version détectés :" >&2
  printf '  - %s\n' "${BAD_ARTIFACTS[@]}" >&2
  exit 1
fi

echo "[GitHub] Artefacts ${VERSION} validés."

printf '\nArtefacts disponibles dans : %s\n' "$OUT_DIR"
find "$OUT_DIR" -maxdepth 4 -type f -printf '  - %P\n' | sort
