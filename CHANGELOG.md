# LibraMail 0.5.0 - 2026-09-07

LibraMail 0.5.0 améliore la fiabilité du courrier, enrichit fortement le planning, réorganise les paramètres et renforce la sécurité de l’API locale utilisée entre l’interface et le moteur.

## Sécurité locale

- Authentification de session pour l’API WebSocket locale du moteur LibraMail.
- Jeton éphémère renouvelé à chaque démarrage et conservé hors des données sauvegardées.
- Contrôle des origines et limitation stricte aux connexions locales autorisées.
- Limitation de la taille des requêtes WebSocket et refus des connexions non authentifiées.
- Améliorations de l’ergonomie et du comportement du mot de passe principal et du verrouillage.

## Planning

- Ajout de catégories de rendez-vous avec couleur et icône personnalisables.
- Gestion des pièces jointes dans les rendez-vous, stockées localement et intégrées aux sauvegardes complètes.
- Indicateur de pièce jointe dans les différentes vues du planning.
- Amélioration de l’affichage et de l’organisation des événements.

## Résumé au démarrage

- Nouveau résumé de la journée affichable au lancement de LibraMail.
- Affichage des messages non lus par compte, des rendez-vous du jour et de l’état de synchronisation.
- Mise à jour du résumé pendant la relève des comptes.
- Option activée par défaut, désactivable directement depuis le résumé ou dans les paramètres.

## Courrier et stabilité

- Renforcement de la stabilité des synchronisations IMAP et du cycle de relève.
- Indicateur de chargement plus clair pendant les opérations longues.
- Sélection globale étendue à l’ensemble de la vue courante, et pas uniquement aux lignes déjà chargées.
- Amélioration du classement de messages depuis la corbeille vers les dossiers locaux.
- Nettoyage du transport SMTP et de plusieurs chemins d’erreur associés.

## Paramètres et interface

- Réorganisation des paramètres en sections dédiées : Général, Courrier, Indésirables, Planning, Sécurité et Données & sauvegarde.
- Nouvelle section de réglages pour les indésirables.
- Intégration des catégories de planning dans les paramètres.
- Harmonisation de plusieurs messages, états de chargement et comportements d’interface.

## Linux et Windows

- Publication des archives portables Linux x86_64 et du paquet Debian amd64.
- Publication du paquet portable Windows x86_64.
- Les constructions Linux et Windows sont vérifiées séparément par GitHub Actions avant la publication de la release.

## Tests

- Ajout de tests ciblés pour les pièces jointes du planning, le résumé de démarrage et la sécurisation de l’API WebSocket locale.
- Maintien des contrôles de syntaxe JavaScript, JSON, sécurité du dépôt et cohérence des numéros de version.

# LibraMail 0.4.8 - 2026-08-29

LibraMail 0.4.8 renforce la sécurité locale, ajoute une action globale de lecture et introduit un paquet Debian natif en complément des archives portables.

## Mot de passe principal et verrouillage

- Ajout d’un mot de passe principal facultatif, désactivé par défaut.
- Possibilité de verrouiller manuellement LibraMail et de demander le mot de passe au démarrage.
- Lorsque l’application est verrouillée, le runtime métier n’est pas initialisé et les opérations sur les comptes et messages restent indisponibles.
- Les secrets de comptes et la clé maître du magasin local sont protégés par le coffre cryptographique du mot de passe principal.
- Le mot de passe principal peut être modifié ou désactivé depuis les paramètres.
- Le verrouillage ferme les accès à la base et au magasin local avant de revenir à l’écran de déverrouillage.

## Tout marquer comme lu

- Ajout d’une action « Tout marquer comme lu » pour la vue courante.
- L’opération traite tous les messages non lus correspondant à la vue, et pas seulement les lignes actuellement chargées.
- Prise en charge de la boîte unifiée, des comptes/dossiers, des dossiers locaux et des étiquettes.
- L’action est masquée pendant une recherche afin d’éviter de modifier involontairement toute la vue structurelle.
- Les lignes visibles et les compteurs sont mis à jour immédiatement sans reconstruction complète de la liste.
- Les erreurs IMAP partielles conservent les messages concernés en non-lu et provoquent une réconciliation ciblée.

## Paquet Debian

- Ajout de la génération d’un paquet `.deb` amd64 en plus des archives Linux portables.
- Installation du programme sous `/opt/libramail` avec lanceur `/usr/bin/libramail`.
- Ajout d’une entrée de menu et de l’icône système.
- Le runtime Node.js reste embarqué : aucune installation de Node.js système n’est nécessaire.
- Les données utilisateur d’une installation Debian sont stockées sous `$XDG_DATA_HOME/libramail` ou `~/.local/share/libramail`.
- Le mode portable conserve ses chemins historiques et reste compatible avec les installations existantes.
- Les données d’une version portable ne sont pas migrées automatiquement ; la sauvegarde/restauration complète reste la méthode recommandée.

## Construction et publication

- GitHub Actions construit désormais le portable Linux et le paquet Debian dans la même chaîne.
- Les fichiers `.deb` et leurs sommes SHA-256 sont ajoutés aux artefacts Linux et aux releases.
- Les permissions du paquet Debian sont normalisées et les fichiers de développement `.old`, `.bak` et `.orig` sont exclus.

## Tests

- Ajout de tests dédiés au mot de passe principal, au runtime verrouillé, à la protection des secrets, à l’interface de sécurité, à l’action globale « lu », aux chemins de données et au packaging Debian.
- Le paquet Debian a été installé et lancé avec un profil XDG isolé afin de vérifier qu’aucune donnée utilisateur n’est écrite sous `/opt/libramail`.

# LibraMail 0.4.7 - 2026-08-28

LibraMail 0.4.7 améliore la réactivité de l’interface et rétablit un lecteur de messages en fenêtre dédiée avec gestion des onglets.

## Étiquettes

- L’ajout ou le retrait d’une étiquette sur un message est visible immédiatement dans la liste.
- L’ajout ou le retrait d’une étiquette sur une discussion est propagé immédiatement aux messages déjà dépliés.
- La ligne racine de la discussion, les messages enfants affichés et l’état courant de la conversation restent synchronisés.
- L’étiquetage d’un message individuel reste indépendant de celui de l’ensemble de la discussion.

## Suppression de messages

- Un message supprimé disparaît immédiatement de la liste.
- Suppression du rafraîchissement complet et bloquant de toute la liste après chaque suppression.
- Les compteurs sont réconciliés en arrière-plan afin de limiter les opérations coûteuses.

## Lecteur modal et onglets

- Un simple clic conserve l’aperçu dans le volet de lecture.
- Un double-clic sur la ligne d’un message ouvre le lecteur dans une fenêtre modale dédiée.
- Le double-clic fonctionne sur toute la zone non interactive de la ligne, même lorsque la preview provoque un rerender.
- Le système d’onglets de lecture est réutilisé dans la fenêtre modale afin d’ouvrir plusieurs messages.
- L’onglet « Aperçu » est masqué dans la modale pour éviter d’afficher deux fois le même message.
- Fermer le dernier onglet de la modale ferme également la fenêtre et revient proprement à l’aperçu principal.

## Tests

- Ajout de tests dédiés au lecteur modal, au double-clic, aux étiquettes de discussions et à la suppression légère.
- Les tests de non-régression 0.4.6 restent applicables.

# LibraMail 0.4.6 - 2026-08-27

LibraMail 0.4.6 est une version corrective centrée sur la cohérence des vues, la sélection multiple, l’export EML et la réactivité de l’interface.

## Suppression et cohérence des vues

- Correction du rafraîchissement après suppression simple ou multiple de messages.
- Invalidation renforcée des caches afin d’éviter qu’un message supprimé ou déplacé vers la corbeille réapparaisse temporairement.
- Réinitialisation de la sélection multiple après suppression.
- Rafraîchissement immédiat des compteurs après les opérations de suppression.
- Meilleure cohérence des vues après suppression d’un dossier local, sans modifier le principe existant : supprimer un dossier local ne supprime pas les messages qu’il classe.

## Démarrage et arrêt sous Windows

- Conservation de l’historique des sessions dans `data/engine-startup.log` au lieu d’écraser le journal à chaque démarrage.
- Journal borné afin d’éviter une croissance illimitée.
- Amélioration de l’arrêt du moteur embarqué sous Windows.
- En cas d’échec de l’arrêt normal, utilisation d’un arrêt de secours ciblé exclusivement sur le PID du moteur lancé par LibraMail.
- Aucun arrêt global de processus `node.exe` n’est utilisé.

## Sélection multiple

- `Ctrl+A` sélectionne désormais tous les messages de la vue courante.
- Le raccourci conserve son comportement natif dans les champs de saisie, la recherche, les zones éditables et les fenêtres modales.
- Le bouton « Tout sélectionner » est repositionné au-dessus de la liste des messages pour être plus visible.

## Export EML multiple

- Ajout d’une action permettant d’exporter plusieurs messages sélectionnés au format `.eml`.
- Le dossier de destination est choisi une seule fois pour toute la sélection.
- Les conversations sélectionnées sont développées afin d’exporter les messages qu’elles contiennent.
- Les exports utilisent toujours le MIME brut stocké par LibraMail, sans reconstruction du message.
- Les fichiers existants ne sont jamais écrasés : un suffixe numérique est ajouté automatiquement en cas de doublon de nom.
- Ajout d’un sélecteur de dossier compatible Linux, Windows et macOS.

## Réactivité de l’interface

- Réduction des rafraîchissements complets lors de l’ajout ou du retrait d’étiquettes.
- Mise à jour ciblée des vues d’étiquette lorsque leur contenu change réellement.
- Mise à jour locale des actions multiples « lu/non lu » et « favori » sans reconstruction complète de la liste.
- Regroupement et différé de certains rafraîchissements de compteurs.
- Conservation du mécanisme optimiste existant pour le classement dans les dossiers locaux.

## Tests

- Ajout de tests dédiés au rafraîchissement après suppression.
- Ajout de tests du cycle de vie du moteur Windows.
- Ajout de tests pour `Ctrl+A` et l’export EML multiple.
- Ajout de tests de non-régression sur les optimisations des mutations courantes.
- Les tests existants d’import/export EML, dossiers locaux, IMAP IDLE, calendrier, interface et sécurité restent applicables.

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
