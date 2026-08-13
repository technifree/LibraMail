#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"

usage() {
  cat <<'EOF'
Usage :
  ./release.sh X.Y.Z ["Notes françaises"] ["English notes"]

Exemple :
  ./release.sh 0.3.2 \
    "Correction de la synchronisation." \
    "Synchronisation fixes."
EOF
}

[[ $# -ge 1 ]] || { usage >&2; exit 2; }

VERSION="${1#v}"
NOTES_FR="${2:-Améliorations et corrections de LibraMail.}"
NOTES_EN="${3:-LibraMail improvements and fixes.}"
TAG="v$VERSION"
BRANCH="$(git branch --show-current)"
[[ -n "$BRANCH" ]] || BRANCH="master"

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

python3 tools/set_version.py "$VERSION"
./update_readme.sh

cat > .github/release-notes.md <<EOF
# LibraMail $VERSION

## Français

$NOTES_FR

## English

$NOTES_EN

### Downloads / Téléchargements

- Linux x86_64 portable package
- Windows x86_64 portable package
- SHA-256 checksums

Public packages contain no account, password or message data.
Les paquets publics ne contiennent aucun compte, mot de passe ou message.
EOF

./security_check.sh
python3 tools/check_version.py

git add VERSION README.md CHANGELOG.md neutralino.config.json \
  resources/index.html resources/js/app.js engine/backend.js \
  .github/release-notes.md 2>/dev/null || true
git add -u

git commit -m "Release LibraMail $VERSION"
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
