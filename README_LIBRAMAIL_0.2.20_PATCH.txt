LibraMail 0.2.20 — correctif de présentation

Ce ZIP corrige la version 0.2.20 sans passer en 0.2.21.

Corrections incluses :
- Fenêtre « À propos » simplifiée : suppression des pavés séparés « Local avant tout » et « Moteur embarqué ».
- Ajout d’un pavé global unique regroupant les informations utiles : auteur, licence MIT, site, stockage local, moteur/interface.
- Mention de l’auteur : Vincent — technifree.com.
- Mention de la licence : MIT.
- Suppression du bouton « Voir les releases ».
- Bouton « Vérifier maintenant » rendu plus explicite : icône animée pendant la vérification et bouton temporairement désactivé.
- Conservation de la vérification de version discrète dans l’application.

Installation :
1. Extraire ce ZIP à la racine du projet LibraMail 0.2.20.
2. Accepter l’écrasement des fichiers.
3. Nettoyer les anciens artefacts :
   rm -rf build github-artifacts .build-linux-work .build-windows-work
   find . -name "resources.neu" -delete
4. Vérifier :
   node --check resources/js/app.js
   node --check engine/backend.js
   python3 tools/check_version.py
5. Committer et republier la 0.2.20 si nécessaire :
   git add -A
   git commit -m "Refine LibraMail 0.2.20 about dialog"
   git tag -f v0.2.20
   git push origin master
   git push origin -f v0.2.20
   ./build_github.sh
