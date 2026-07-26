LibraMail 0.2.20 - correctif About + Windows quit

Correctif sans changement de version :
- fenêtre À propos réellement simplifiée : un seul pavé global ;
- auteur : Vincent — technifree.com ;
- licence : MIT ;
- suppression du bouton « Voir les releases » ;
- bouton « Vérifier maintenant » avec activité visible ;
- ajout de resources/favicon.ico et files/resources/favicon.ico ;
- neutralino.config.json pointe l’icône de fenêtre vers /resources/favicon.ico ;
- packaging/windows/libramail.ps1 ne laisse plus taskkill faire échouer la fermeture sous Windows.

Après extraction à la racine du projet :
  rm -rf build github-artifacts .build-linux-work .build-windows-work
  find . -name "resources.neu" -delete
  grep -R "Local avant tout\|Moteur embarqué\|Voir les releases" -n resources files/resources

La commande grep ci-dessus ne doit rien retourner.
