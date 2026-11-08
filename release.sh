#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"

usage() {
  cat <<'EOF'
Usage :
  ./release.sh X.Y.Z

La section X.Y.Z de CHANGELOG.md doit contenir :
  ## Français
  ## English

Exemple :
  ./release.sh 0.6.3
EOF
}

[[ $# -eq 1 ]] || { usage >&2; exit 2; }

VERSION="${1#v}"
TAG="v$VERSION"
BRANCH="$(git branch --show-current)"
[[ -n "$BRANCH" ]] || { echo "[PUBLICATION] Refus : exécuter depuis la branche master, pas depuis un HEAD détaché." >&2; exit 1; }
[[ "$BRANCH" == master ]] || {
  echo "[PUBLICATION] Refus : vous êtes sur '$BRANCH'. Fusionner dev-0.6.3 sur master avant ./github.sh release." >&2
  exit 1
}

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || {
  echo "Version invalide : $VERSION" >&2
  exit 2
}

for cmd in git gh python3; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Commande absente : $cmd" >&2; exit 1; }
done
gh auth status >/dev/null 2>&1 || { echo "Lancez : gh auth login" >&2; exit 1; }

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Le dépôt contient des modifications non validées :" >&2
  git status --short >&2
  echo "Validez ou annulez-les avant la publication." >&2
  exit 1
fi

git fetch --tags origin
git rev-parse "$TAG" >/dev/null 2>&1 && {
  echo "Le tag $TAG existe déjà." >&2
  exit 1
}

# Valider les notes avant toute modification locale et avant le moindre push.
python3 tools/generate_release_notes.py "$VERSION" --validate-only
python3 tools/set_version.py "$VERSION"
# La génération échoue si le CHANGELOG ne fournit pas FR et EN :
# aucune note générique et aucune traduction improvisée ne sont publiées.
python3 tools/generate_release_notes.py "$VERSION"

# Préflight complet AVANT de créer le commit/tag : sécurité, cohérence de
# version, syntaxe, JSON et toute la suite de tests avec le runtime local.
./github.sh check

git add VERSION README.md CHANGELOG.md neutralino.config.json \
  resources/index.html resources/js/app.js engine/backend.js \
  .github/release-notes.md 2>/dev/null || true
git add -u

if ! git diff --cached --quiet; then
  git commit -m "Release LibraMail $VERSION"
else
  echo "[GitHub] Aucun changement documentaire à valider ; création du tag sur le commit courant."
fi
git tag -a "$TAG" -m "LibraMail $VERSION"
git push origin "$BRANCH"
git push origin "$TAG"

echo "[GitHub] Attente du workflow de publication..."
RUN_ID=""
for _ in $(seq 1 45); do
  RUN_ID="$(gh run list --workflow release.yml --limit 30 \
    --json databaseId,headBranch,status,createdAt \
    --jq ".[] | select(.headBranch == \"$TAG\") | .databaseId" | head -n1)"
  [[ -n "$RUN_ID" ]] && break
  sleep 2
done
[[ -n "$RUN_ID" ]] || {
  echo "Le tag est poussé, mais le workflow n'a pas encore été retrouvé." >&2
  echo "Consultez l'onglet Actions du dépôt." >&2
  exit 1
}

gh run watch "$RUN_ID" --exit-status

REPO_URL="$(gh repo view --json url --jq .url)"
printf '\nPublication terminée : %s/releases/tag/%s\n' "$REPO_URL" "$TAG"
