# LibraMail 0.4.5 - 2026-08-25

LibraMail 0.4.5 est une version corrective centrée sur Windows et les échanges de messages au format EML.

## Démarrage Windows

- Le délai d’attente du moteur embarqué passe de 12 à 30 secondes.
- Une dernière vérification WebSocket est effectuée avant de déclarer un échec de démarrage.
- En cas d’échec réel, LibraMail tente désormais d’arrêter proprement le processus `node.exe` qu’il a lancé.
- Le journal `data/engine-startup.log` est rendu plus exploitable sous Windows.

## Import EML

- Ajout d’un diagnostic détaillé par étape lors d’un échec d’import : validation, lecture, détection de doublon, parsing, snippet, base de données, stockage, indexation ou classement.
- Création de `data/eml-import.log` après chaque import afin de faciliter les retours de test et le diagnostic sous Windows.
- Affichage de la première erreur directement dans l’interface.
- Rafraîchissement immédiat des compteurs de dossiers locaux après import.
- Invalidation renforcée du cache et des préchargements afin d’éviter l’affichage d’un ancien état après import.

## Export EML

- Ajout d’une action « Exporter .eml » dans le lecteur de message.
- Le message est exporté depuis son MIME brut stocké par LibraMail, sans reconstruction par le parseur.
- Les en-têtes, le `Message-ID`, les parties texte/HTML et les pièces jointes sont donc conservés tels qu’ils sont enregistrés.
- Le nom de fichier proposé est basé sur l’objet du message et nettoyé pour rester compatible avec Windows, Linux et macOS.
- L’extension `.eml` est ajoutée automatiquement si nécessaire.

## Tests

- Ajout de tests dédiés au démarrage Windows, au diagnostic EML, au rafraîchissement post-import et à l’export EML.
- Les tests existants de dossiers locaux, sauvegarde/restauration, import EML, IMAP IDLE, calendrier et interface restent validés.

# LibraMail 0.4.4 - 2026-08-23

LibraMail 0.4.4 étend l'organisation locale des messages, améliore la gestion des pièces jointes et renforce la robustesse des relèves IMAP.

## Dossiers locaux

- Ajout de dossiers locaux indépendants des comptes de messagerie.
- Classement de messages dans des dossiers locaux sans déplacement côté serveur IMAP.
- Arborescence multi-niveaux avec sous-dossiers de profondeur libre.
- Compteurs récursifs : un dossier parent affiche le total de toute sa branche.
- Déplacement des messages vers un dossier local par glisser-déposer.
- Déplacement d'un dossier local complet dans l'arborescence par glisser-déposer.
- Retour d'un dossier à la racine par glisser-déposer.
- Protection contre les cycles et les déplacements créant des doublons entre dossiers frères.
- Autorisation de noms identiques dans des branches différentes.
- Navigation accélérée entre dossiers locaux grâce au cache, à la révalidation différée et au préchargement des dossiers voisins.
- Sauvegarde et restauration de la hiérarchie et des affectations de messages.

## Import EML

- Possibilité de choisir directement un dossier local lors de l'import de messages EML.
- Les messages importés restent stockés localement et chiffrés.
- Les doublons détectés lors de l'import ne sont pas reclassés automatiquement.

## Pièces jointes

- Ouverture directe d'une pièce jointe avec l'application associée du système.
- Conservation de l'action « Enregistrer sous ».
- Blocage de l'ouverture directe pour les extensions potentiellement dangereuses ; l'enregistrement reste disponible.
- Correction de l'indicateur de pièce jointe dans la liste des messages afin qu'il reste visible au survol.

## Interface

- Les dates des anciens messages affichent désormais l'année.
- Mise en évidence et organisation améliorées autour des dossiers locaux.
- Correction du comportement responsive du volet Planning afin d'éviter les textes et boutons tronqués sur les fenêtres étroites.

## IMAP

- Ajout de limites de temps sur les différentes phases de synchronisation IMAP.
- Interruption et reconnexion contrôlées lorsqu'une opération IMAP reste bloquée.
- Meilleure récupération après arrêt ou perte de connexion.
- Gestion locale des erreurs réseau des connexions IDLE persistantes (`ETIMEDOUT`, `ECONNRESET`, etc.).
- Reconnexion automatique d'une connexion IDLE interrompue sans remontée en erreur non interceptée.

## Tests et robustesse

- Ajout de tests dédiés à l'arborescence, aux compteurs récursifs, à l'unicité des noms par parent, au déplacement des dossiers, à la navigation locale, à la sauvegarde/restauration et au comportement responsive.
- Ajout d'un test spécifique de récupération des connexions IMAP IDLE.

# LibraMail 0.4.3 - 2026-08-21

LibraMail 0.4.3 est une version corrective qui rétablit le glisser-déposer des pièces jointes dans la fenêtre de rédaction.

## Corrections

- Correction du glisser-déposer des fichiers dans un nouveau message ou une réponse.
- Les fichiers déposés sont désormais ajoutés comme véritables pièces jointes.
- Un fichier PDF déposé n'est plus ouvert directement dans LibraMail.
- Les chemins locaux `file://` ne sont plus insérés dans le corps du message.
- Prise en charge des fichiers PDF, ZIP, images, documents et autres types de fichiers.
- Prise en charge du dépôt simultané de plusieurs fichiers.

## Technique

- Mise à jour de Neutralino vers la version 6.8.0.
- Utilisation du mécanisme natif `filesDropped`.
- Activation de `emitDropEvents` afin que le WebView n'interprète plus directement les fichiers déposés.

---


# LibraMail 0.4.2 - 2026-08-21

LibraMail 0.4.2 améliore la gestion de la relève du courrier et ajoute une nouvelle fonction d'import de messages au format EML.

## Nouveautés

### Import de messages EML

LibraMail peut désormais importer un ou plusieurs messages `.eml` provenant d'un autre logiciel de messagerie ou d'une archive existante.

- Import de plusieurs fichiers en une seule opération.
- Choix du compte de destination.
- Détection automatique des messages reçus ou envoyés.
- Possibilité de forcer le classement en « Reçus » ou « Envoyés ».
- Détection des messages déjà présents afin d'éviter les doublons.
- Gestion normale des messages importés dans LibraMail.

Les messages importés restent entièrement locaux : aucune copie n'est envoyée vers le serveur IMAP ou POP3.

Ils sont stockés dans le magasin chiffré de LibraMail et restent isolés de la synchronisation avec le serveur de messagerie.

## Relève du courrier

Cette version apporte également plusieurs corrections au moteur de relève :

- amélioration de l'arrêt d'une relève en cours ;
- correction des relèves pouvant rester actives après un arrêt ;
- amélioration de la réactivité du moteur lors des opérations longues ;
- réduction de l'impact d'une relève lente ou bloquée sur les autres opérations de LibraMail.

## Stockage et sécurité

Les messages EML importés utilisent le même stockage local chiffré que les messages récupérés normalement par LibraMail.

Aucun fichier EML importé n'est conservé en clair dans le répertoire de données de l'application.

## [0.3.7] - 2026-08-15

### Sécurité et Windows
- Correction du démarrage du moteur embarqué sous Windows avec `--use-system-ca` et détection explicite du runtime.
- Ajout de `data/engine-startup.log` pour diagnostiquer un moteur Windows qui ne démarre pas.
- Les mots de passe IMAP/SMTP sont désormais stockés dans le coffre-fort système via `@napi-rs/keyring` et ne sont plus conservés en clair dans `accounts.json` après migration réussie.
- Migration automatique et prudente des anciens mots de passe : le texte en clair n’est supprimé qu’après écriture et relecture réussies dans le coffre-fort.
- Les nouvelles sauvegardes LibraMail excluent les mots de passe des comptes.

## [0.3.6] - 2026-08-15

### Windows / TLS
- le moteur Node.js embarqué utilise désormais également le magasin de certificats approuvés par Windows ;
- amélioration de la compatibilité IMAP/SMTP avec les antivirus réalisant une inspection TLS, les proxys d'entreprise et les PKI locales ;
- la validation TLS reste active : aucun contournement de type `rejectUnauthorized: false` n'est utilisé.

## [0.3.5] - 2026-08-15

### Windows
- Suppression du lanceur `LibraMail.vbs` et des lanceurs PowerShell/CMD distribués.
- Lancement direct de LibraMail via `LibraMail.exe`.
- Démarrage et arrêt automatiques du moteur Node.js embarqué.
- Intégration des ressources de l'interface directement dans l'exécutable Windows.
- Simplification du paquet portable Windows afin de limiter les faux positifs antivirus liés aux scripts de lancement.

## [0.3.3] - 2026-08-13

### Calendrier / Planning
- Ajout direct au planning des invitations ICS reçues par e-mail.
- Détection des invitations `text/calendar`, même sans pièce jointe `.ics` explicite.
- Mémorisation des invitations déjà ajoutées au planning et possibilité de les actualiser.
- Possibilité de modifier un abonnement calendrier existant : nom, URL, calendrier associé et couleur.
- La couleur choisie dans LibraMail devient prioritaire sur celle éventuellement fournie par le calendrier distant.
- Réapplication de la couleur choisie aux événements déjà synchronisés.
- Amélioration de la confirmation lors de la suppression d'un abonnement calendrier.
- Ajout d'un indicateur visuel de la couleur de chaque abonnement.

### Corrections
- Divers ajustements de l'intégration du planning et des abonnements calendriers.

## [0.3.2] - 2026-08-13

### Ajouté
- abonnements de calendriers Internet via URL `https://` ou `webcal://`, synchronisés en lecture seule au démarrage puis périodiquement ;
- gestion des abonnements (ajout, actualisation, suppression) depuis le planning ;
- volet planning rétractable sur la page principale avec rendez-vous du jour et prochains événements ;
- indicateur sur l’icône Planning lorsqu’un prochain rendez-vous existe.

### Amélioré
- les événements supprimés d’un calendrier Internet disparaissent lors de la synchronisation ;
- les abonnements utilisent ETag/Last-Modified lorsqu’ils sont fournis par le serveur distant ;
- les calendriers `webcal://` sont normalisés automatiquement en HTTPS.

## [0.3.1] - 2026-08-13

- Import de calendriers iCalendar (`.ics`, `.ical`, `.vcs`) et CSV depuis le planning.
- Prise en charge des rendez-vous récurrents iCalendar usuels, des journées entières, fuseaux horaires et exceptions courantes.
- Réimport sans doublon des événements identifiés : les occurrences déjà importées sont mises à jour.
- Ajout des vues Mois, Semaine, Semaine de travail (lundi à vendredi) et Année.
- Vue semaine horaire avec création rapide d’un rendez-vous par double-clic dans une tranche.
- Cohérence automatique entre début et fin : la date de fin ne peut plus précéder la date de début et l’heure de fin est recalée si nécessaire.
- Possibilité de déposer directement un fichier de calendrier sur le planning pour l’importer.

## [0.3.0] - 2026-08-13

- Ajout d’un planning local intégré à LibraMail.
- Vue mensuelle avec navigation, sélection d’une journée et affichage des rendez-vous.
- Création, modification et suppression des rendez-vous, avec journée entière ou horaires, lieu et notes.
- Association facultative d’un rendez-vous à un compte mail et reprise de sa couleur.
- Stockage des rendez-vous dans SQLite : ils sont inclus dans la sauvegarde complète LibraMail.
- Interface du planning disponible en français et en anglais.

## 0.2.24 — 30 juillet 2026

## 0.2.25 — 1 août 2026

- La restauration depuis la corbeille traite toute la conversation et est disponible directement dans la liste des messages.

- Restauration d’un message ou d’une sélection depuis la corbeille vers la boîte de réception.
- Réorganisation des règles anti-spam en groupes distincts : adresses et domaines bloqués ou autorisés.
- Recherche dans les règles anti-spam et compteurs par catégorie.
- Ajout de l’autorisation complète d’un domaine depuis les adresses collectées.
- Retrait automatique des adresses collectées déjà couvertes par une règle d’adresse ou de domaine.

- Gestion locale des brouillons, y compris les réponses et transferts.
- Programmation d’un envoi à une date et une heure définies.
- Affichage et autorisation distincte des liens dans les contenus distants.
- Confirmation sécurisée avant ouverture des liens autorisés.
- Création automatique d’une règle de blocage pour les expéditeurs déclarés manuellement comme indésirables.
- Correction de l’ouverture de la liste des adresses collectées.

## [0.2.23] - 2026-07-27

- Restauration de l’affichage des étiquettes dans la liste des messages.
- Amélioration du contraste des avatars et logos de comptes en thème clair.
- Correction de l’export CSV des statistiques avec solution de repli par téléchargement.
- Blocage propre des opérations lourdes pendant une relève pour éviter les ralentissements et conflits.

## [0.2.22] - 2026-07-27

- Gestion enrichie des indésirables : règles d’adresses/domaines bloqués ou autorisés, expéditeurs collectés et application aux messages existants.
- Icônes des comptes renforcées : logo personnalisé réellement sauvegardé et détection de fournisseurs étendue.
- Icônes d’expéditeurs : avatar de contact, fournisseur reconnu ou favicon de domaine mis en cache localement quand c’est possible.

# Changelog

## [0.2.21] - 2026-07-27

- Reprise depuis la base stable 0.2.19.
- Ajout d’une fenêtre À propos simplifiée : auteur Vincent / technifree.com, licence MIT, stockage local, moteur intégré.
- Ajout d’une vérification de version et d’un avertissement discret si une nouvelle release existe.
- Ajout d’une jauge dédiée aux opérations longues de nettoyage.
- Correction des sauvegardes/imports bloqués par les nettoyages automatiques.
- Correction du lanceur Windows et des journaux moteur.
- Ajout d’icônes automatiques et de logos personnalisés par compte.

All notable changes to LibraMail are documented here.

## [0.2.18] - 2026-07-24

### Added

- Portable Linux and Windows packaging with an embedded Node.js runtime
- Multi-account provider icons and custom account images
- Incremental IMAP synchronisation and cancellable activity
- Complete ZIP backup and restore
- Contacts, groups, avatars and trusted senders
- Reply all, Bcc, read receipts and delivery status requests
- Secure external-link confirmation
- Bilingual French and English interface

### Notes

Public packages never contain the local `data/` directory.
