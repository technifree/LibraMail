LibraMail — script de construction GNU/Linux

1. Copier build_linux.sh à la racine du projet LibraMail.
2. Le rendre exécutable :
     chmod +x build_linux.sh
3. Fermer LibraMail et lancer :
     ./build_linux.sh

Le résultat est créé dans :
  build/linux/

Options utiles :
  ./build_linux.sh --with-data
      Inclut le dossier data. À réserver à une archive privée, car les secrets
      des comptes peuvent y être présents.

  ./build_linux.sh --fresh-npm
      Réinstalle les dépendances Node de production au lieu de recopier celles
      déjà présentes dans engine/node_modules.

  ./build_linux.sh --embed-resources
      Produit un exécutable Neutralino avec les ressources intégrées.

Le paquet final contient :
  - le binaire Neutralino Linux de l'architecture courante ;
  - le moteur Node.js et ses dépendances ;
  - un lanceur ./libramail ;
  - un dossier data local ;
  - des archives ZIP et tar.gz avec sommes SHA-256.

Node.js reste requis sur la machine d'exécution, car le moteur de messagerie
est un processus Node distinct. Le script vérifie également better-sqlite3,
module natif qui aime rappeler qu'une application « portable » est toujours
portable jusqu'à la prochaine ABI.
