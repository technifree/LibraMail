LibraMail 0.2.24 — brouillons, envois différés, liens et indésirables
=====================================================================

Correctifs de l’installateur
----------------------------
Cette archive révisée corrige deux fragilités du programme d’installation :

- la détection de la fin de setMessageSpamState() tolère désormais les lignes
  vides et les légers écarts de mise en forme ;
- la fonction send() de resources/js/app.js est maintenant repérée par sa
  signature et sa véritable accolade fermante, sans dépendre du commentaire ou
  de la fonction placée juste après.

Cela corrige notamment les erreurs :
- « backend/règle spam automatique : motif attendu 0 fois au lieu de 1 » ;
- « app/remplacement envoi : motif introuvable ou ambigu ».

Base attendue
-------------
Ce correctif s'applique à une arborescence source LibraMail 0.2.23.
Il met automatiquement la version du projet à 0.2.24.

Fonctions ajoutées et corrigées
-------------------------------

1. Brouillons locaux
   - bouton « Brouillon » dans la fenêtre de rédaction ;
   - prise en charge des nouveaux messages, réponses, réponses à tous et transferts ;
   - conservation des destinataires, du sujet, du texte, des options, de la citation,
     de la signature et des pièces jointes ;
   - entrée « Brouillons » avec compteur dans la barre latérale ;
   - modification, suppression et envoi ultérieur d'un brouillon.

2. Envois différés locaux
   - option « Envoyer plus tard » dans la fenêtre de rédaction ;
   - choix de la date et de l'heure ;
   - entrée « Envois différés » avec compteur dans la barre latérale ;
   - modification, annulation ou envoi immédiat ;
   - reprise des envois échoués ;
   - vérification automatique toutes les 30 secondes.

   Important : l'envoi différé est exécuté localement. LibraMail doit être ouvert
   à l'heure prévue. Si l'application est arrêtée, le message est envoyé au
   prochain démarrage, dès que le moteur et le compte SMTP sont disponibles.

3. Contenus distants et liens
   - les liens HTTP et HTTPS sont maintenant listés dans la fenêtre des contenus
     distants, au même titre que les images et feuilles de style ;
   - un lien reste inactif tant qu'il n'a pas été autorisé pour le message ;
   - après autorisation, son survol affiche l'adresse réelle dans la barre d'état ;
   - son ouverture passe toujours par la confirmation de sécurité existante ;
   - les scripts présents dans les messages restent interdits.

4. Déclarations manuelles d'indésirables
   - déclarer un message comme indésirable crée une règle locale exacte sur
     l'adresse de l'expéditeur ;
   - les prochains messages reçus de cette adresse sont donc classés localement
     comme indésirables ;
   - l'apprentissage bayésien existant est conservé ;
   - repasser un message en légitime retire uniquement la règle créée
     automatiquement et restaure une éventuelle règle antérieure.

5. Adresses collectées
   - les règles et adresses collectées sont chargées dès l'ouverture des paramètres ;
   - le volet « Adresses collectées dans les messages » est également rafraîchi
     explicitement lorsqu'il est déplié.

Stockage et portabilité
-----------------------
Les brouillons et envois différés sont conservés dans la base SQLite locale.
Les pièces jointes sont copiées dans data/outbox/ et leurs chemins sont enregistrés
relativement au dossier data/, afin de rester valides après un déplacement de
l'application ou une restauration sur un autre poste.

Installation
------------

1. Fermer LibraMail.
2. Extraire cette archive.
3. Ouvrir un terminal à la racine des sources LibraMail 0.2.23.
4. Lancer :

   chmod +x /chemin/vers/LibraMail_hotfix_0_2_24/apply_0_2_24.sh
   /chemin/vers/LibraMail_hotfix_0_2_24/apply_0_2_24.sh

Le script :
- contrôle la présence et la forme des fichiers attendus ;
- crée une sauvegarde locale .libramail-0.2.24-backup-AAAAmmjj-HHMMSS/ ;
- applique les changements ;
- vérifie la syntaxe JavaScript avec Node.js lorsqu'il est disponible ;
- restaure automatiquement les fichiers d'origine en cas d'échec ;
- ne supprime ni ne remplace le dossier data/.

Contrôles après installation
----------------------------

   ./github.sh check
   git status --short

Puis lancer LibraMail depuis les sources avant de publier la version.

Fichiers ajoutés
----------------
- engine/lib/outbox.js
- resources/js/outbox.js

Fichier remplacé
----------------
- resources/js/viewer.js

Fichiers modifiés automatiquement
---------------------------------
- engine/backend.js
- resources/js/app.js
- resources/index.html
- resources/css/app.css
- resources/locales/fr.json
- resources/locales/en.json
- neutralino.config.json
- VERSION
- README.md, s'il existe
- CHANGELOG.md, s'il existe

Validation effectuée avant livraison
------------------------------------
- syntaxe Python du programme d'installation ;
- syntaxe Bash du lanceur ;
- syntaxe JavaScript des trois nouveaux fichiers ;
- tests des transformations backend, interface et HTML sur des modèles ;
- test fonctionnel SQLite du stockage, des pièces jointes, du déplacement du
  dossier data/, du classement des brouillons, de la réservation atomique des
  envois et de leur suppression ;
- contrôle d'intégrité de l'archive ZIP.

Le fonctionnement complet avec Neutralino, un vrai serveur IMAP et un vrai serveur
SMTP doit naturellement être validé sur l'application installée. Les serveurs de
messagerie conservent encore ce privilège de produire des surprises que les tests
locaux n'ont pas commandées.
