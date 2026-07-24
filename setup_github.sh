#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"

OWNER="${GITHUB_OWNER:-technifree}"
REPO="${REPO_NAME:-LibraMail}"
VISIBILITY="${VISIBILITY:-public}"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-master}"
DESCRIPTION="${REPO_DESCRIPTION:-LibraMail — lightweight local-first multi-account email client}"
HOMEPAGE="${REPO_HOMEPAGE:-https://technifree.com}"

case "$VISIBILITY" in public|private|internal) ;; *)
  echo "VISIBILITY doit valoir public, private ou internal." >&2
  exit 2
esac

for cmd in git gh python3; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Commande requise absente : $cmd" >&2
    exit 1
  }
done

gh auth status >/dev/null 2>&1 || {
  echo "GitHub CLI n'est pas connecté. Lancez : gh auth login" >&2
  exit 1
}

[[ -f neutralino.config.json && -d resources && -d engine ]] || {
  echo "Ce script doit être placé à la racine de LibraMail." >&2
  exit 1
}

if [[ ! -d .git ]]; then
  git init
fi

git checkout -B "$DEFAULT_BRANCH"

# Adapte les liens du README lorsque le propriétaire ou le dépôt est personnalisé.
python3 - "$OWNER" "$REPO" <<'PY'
from pathlib import Path
import re
import sys

path = Path("README.md")
text = path.read_text(encoding="utf-8")
text = re.sub(r"github\.com/[^/\s)]+/LibraMail", f"github.com/{sys.argv[1]}/{sys.argv[2]}", text)
path.write_text(text, encoding="utf-8")
PY

chmod +x github.sh setup_github.sh release.sh build_github.sh \
  security_check.sh update_readme.sh build_linux.sh tools/*.py

./security_check.sh
python3 tools/check_version.py

mkdir -p data
touch data/.gitkeep

git add .
./security_check.sh

if git diff --cached --quiet; then
  echo "[Git] Aucun nouveau fichier à valider."
else
  git commit -m "Initial publication of LibraMail $(cat VERSION)"
fi

FULL_REPO="$OWNER/$REPO"

if gh repo view "$FULL_REPO" >/dev/null 2>&1; then
  echo "[GitHub] Le dépôt $FULL_REPO existe déjà."
  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "https://github.com/$FULL_REPO.git"
  else
    git remote add origin "https://github.com/$FULL_REPO.git"
  fi
else
  echo "[GitHub] Création du dépôt $FULL_REPO ($VISIBILITY)..."
  gh repo create "$FULL_REPO" "--$VISIBILITY" \
    --source=. --remote=origin \
    --description "$DESCRIPTION"
fi

git push -u origin "$DEFAULT_BRANCH"

gh repo edit "$FULL_REPO" \
  --description "$DESCRIPTION" \
  --homepage "$HOMEPAGE" \
  --enable-issues \
  --enable-wiki=false \
  --default-branch "$DEFAULT_BRANCH" || true

gh repo edit "$FULL_REPO" \
  --add-topic email \
  --add-topic imap \
  --add-topic smtp \
  --add-topic neutralinojs \
  --add-topic sqlite \
  --add-topic javascript \
  --add-topic linux \
  --add-topic windows \
  --add-topic privacy || true

printf '\nDépôt prêt : https://github.com/%s\n' "$FULL_REPO"
printf 'Compilation GitHub : ./github.sh build\n'
printf 'Publication : ./github.sh release %s\n' "$(cat VERSION)"
