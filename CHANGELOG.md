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
