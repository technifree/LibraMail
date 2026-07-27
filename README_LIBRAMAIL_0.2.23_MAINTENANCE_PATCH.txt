LibraMail 0.2.23 — patch de maintenance

Corrections incluses :
- affichage des étiquettes dans la liste des messages ;
- contraste des avatars/initiales et logos de comptes en thème clair ;
- export CSV des statistiques fiabilisé avec fallback téléchargement ;
- garde-fou sur les opérations lourdes pendant une relève en cours.

Contrôles conseillés après extraction :
  rm -rf build github-artifacts .build-linux-work .build-windows-work
  find . -name "resources.neu" -delete
  node --check resources/js/app.js
  node --check resources/js/maillist.js
  python3 -m json.tool resources/locales/fr.json >/dev/null
  python3 -m json.tool resources/locales/en.json >/dev/null
  python3 tools/check_version.py

Publication :
  git add -A
  git commit -m "Release LibraMail 0.2.23"
  git tag -f v0.2.23
  git push origin master
  git push origin -f v0.2.23
  ./build_github.sh
