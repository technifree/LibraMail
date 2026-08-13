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
