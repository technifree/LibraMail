#!/usr/bin/env bash
# ============================================================
# LibraMail — Installation initiale (À LANCER UNE SEULE FOIS)
# Nécessite : node >= 18 + npm, et une connexion internet.
# Après ce script, l'application est 100 % autonome et portable :
# toutes les bibliothèques sont rapatriées localement.
# ============================================================
set -e
cd "$(dirname "$0")"

echo "── 1/4 · Dépendances du moteur (imapflow, nodemailer, sqlite…)"
( cd engine && npm install --omit=dev )

echo "── 2/4 · Binaires Neutralino"
npx --yes @neutralinojs/neu@latest update

echo "── 3/4 · Bibliothèques front locales (FontAwesome, DOMPurify)"
mkdir -p resources/vendor/fontawesome
if [ ! -f resources/vendor/purify.min.js ]; then
  npm pack dompurify@3 --silent > /dev/null
  tar -xzf dompurify-3.*.tgz package/dist/purify.min.js
  mv package/dist/purify.min.js resources/vendor/purify.min.js
  rm -rf package dompurify-3.*.tgz
fi
if [ ! -d resources/vendor/fontawesome/css ]; then
  npm pack @fortawesome/fontawesome-free@6 --silent > /dev/null
  tar -xzf fortawesome-fontawesome-free-6.*.tgz
  mkdir -p resources/vendor/fontawesome
  cp -r package/css package/webfonts resources/vendor/fontawesome/
  rm -rf package fortawesome-fontawesome-free-6.*.tgz
fi

echo "── 4/4 · Node.js portable embarqué (pour la version distribuable)"
# En développement, le node du système suffit. Pour une clé USB :
# téléchargez le binaire depuis nodejs.org et placez-le dans bin/node
if [ ! -f bin/node ]; then
  cp "$(command -v node)" bin/node 2>/dev/null && echo "   node système copié dans bin/" \
    || echo "   (ignoré — placez un binaire node portable dans bin/ pour la distribution)"
fi

echo ""
echo "✓ Installation terminée. Lancez :  ./start.sh"
