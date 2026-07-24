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

printf '\nArtefacts disponibles dans : %s\n' "$OUT_DIR"
find "$OUT_DIR" -maxdepth 4 -type f -printf '  - %P\n' | sort
