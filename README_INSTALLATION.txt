LIBRAMAIL — KIT GITHUB PRÊT À L'EMPLOI
======================================

Ce dossier est une surcouche à copier à la racine du projet LibraMail.

1. Fermer LibraMail.
2. Sauvegarder le projet.
3. Copier tout le contenu de ce dossier à la racine du projet.
4. Ne jamais copier ni envoyer le dossier data/ sur GitHub.
5. Rendre les scripts exécutables :

   chmod +x github.sh setup_github.sh release.sh build_github.sh
   chmod +x security_check.sh update_readme.sh build_linux.sh

6. Contrôler le projet :

   ./github.sh check

7. Créer le dépôt technifree/LibraMail et pousser les sources :

   ./github.sh init

8. Demander à GitHub de compiler Linux et Windows :

   ./github.sh build

9. Publier une version :

   ./github.sh release 0.2.23

Le script de publication met à jour les numéros de version, crée le commit,
pousse le tag et attend la publication GitHub contenant les deux archives.

Prérequis locaux :
- git
- GitHub CLI « gh », connecté avec « gh auth login »
- python3
- accès au compte GitHub technifree

Les compilations GitHub sont publiques et VIERGES. Elles n'utilisent jamais
--with-data. La version personnelle avec comptes et messages reste locale.
