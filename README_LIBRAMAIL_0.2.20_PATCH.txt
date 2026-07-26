LibraMail 0.2.20 - correctif applicatif

Structure du ZIP : chemins relatifs à la racine du projet.
Il faut extraire/copier ces fichiers à la racine du dépôt LibraMail.

Contenu principal :
- neutralino.config.json et VERSION : version 0.2.20
- resources/ : interface Neutralino, logo, icône, styles, modale À propos, jauge d'opérations longues, avertissement de version
- files/resources/ : miroir de resources/ si le dépôt conserve ce dossier
- engine/backend.js : endpoints et progression des opérations longues
- README, CHANGELOG et notes GitHub : documentation 0.2.20

Après copie :
  rm -rf build github-artifacts .build-linux-work .build-windows-work
  find . -name "resources.neu" -delete
  python3 tools/check_version.py
  git status --short
  git add -A
  git commit -m "Release LibraMail 0.2.20"
  git tag -f v0.2.20
  git push origin master
  git push origin -f v0.2.20
  ./build_github.sh
