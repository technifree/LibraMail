#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"

red=$'\033[1;31m'
green=$'\033[1;32m'
yellow=$'\033[1;33m'
reset=$'\033[0m'

fail() { printf '%s[SECURITE] %s%s\n' "$red" "$*" "$reset" >&2; exit 1; }
ok()   { printf '%s[SECURITE] %s%s\n' "$green" "$*" "$reset"; }
warn() { printf '%s[SECURITE] %s%s\n' "$yellow" "$*" "$reset" >&2; }

[[ -f .gitignore ]] || fail ".gitignore est absent."

patterns='(^|/)(data/(accounts\.json|config\.json|index\.db|mail/)|backups/|node_modules/|build/|dist/|\.cache/)|\.(eml|mbox|pst|pfx|p12|pem|key|db|sqlite)(-|$)|\.libramail-backup\.zip$'

check_list() {
  local label="$1"
  local content="$2"
  local bad
  bad="$(printf '%s\n' "$content" | grep -E "$patterns" || true)"
  [[ -z "$bad" ]] || {
    printf '%s\n' "$bad" >&2
    fail "$label contient des fichiers privés ou générés."
  }
}

IS_GIT=0
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  IS_GIT=1
  check_list "L'index Git" "$(git ls-files)"
  check_list "Les changements préparés" "$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)"

  ignored_tracked="$(git ls-files -ci --exclude-standard 2>/dev/null || true)"
  if [[ -n "$ignored_tracked" ]]; then
    printf '%s\n' "$ignored_tracked" >&2
    fail "Des fichiers désormais ignorés sont encore suivis par Git. Utilisez git rm --cached."
  fi
else
  warn "Le dossier n'est pas encore un dépôt Git : contrôle de l'arborescence uniquement."
  grep -Eq '^/data/\*$' .gitignore \
    || fail ".gitignore ne protège pas l'ensemble du dossier data/."
fi

for private in data/accounts.json data/index.db data/mail; do
  if [[ -e "$private" && "$IS_GIT" -eq 1 ]]; then
    git check-ignore -q "$private" 2>/dev/null \
      || fail "$private existe mais n'est pas protégé par .gitignore."
  fi
done

ok "Aucune donnée personnelle ou compilation interdite n'est suivie."
