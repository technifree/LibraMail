Correctif LibraMail 0.2.20 — démarrage Windows

Ce correctif ne change pas la version applicative : elle reste en 0.2.20.

Cause corrigée :
- la version Windows pouvait embarquer resources/index.html qui référence js/i18n.js, js/maillist.js et js/viewer.js,
  mais ces fichiers n'étaient pas présents dans resources/js/ dans le patch précédent ;
- résultat : interface partiellement affichée, textes absents, status.disconnected, moteur non joint par le front.

Après extraction à la racine du projet :
  rm -rf build github-artifacts .build-linux-work .build-windows-work
  find . -name "resources.neu" -delete
  grep -R "Local avant tout\|Moteur embarqué\|Voir les releases" -n resources files/resources
  ls resources/js/i18n.js resources/js/maillist.js resources/js/viewer.js

Puis :
  git add -A
  git commit -m "Fix LibraMail 0.2.20 Windows startup resources"
  git tag -f v0.2.20
  git push origin master
  git push origin -f v0.2.20
  ./build_github.sh

Si resources/js/neutralino.js est absent dans le dépôt, lancer aussi :
  npx @neutralinojs/neu update

ou vérifier que le workflow le régénère avant le build.
