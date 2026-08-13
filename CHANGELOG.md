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
