# LibraMail 0.4.8

## Français

LibraMail 0.4.8 renforce la sécurité locale, ajoute une action globale « Tout marquer comme lu » et fournit désormais un paquet Debian natif en plus des distributions portables.

### Mot de passe principal

- Le mot de passe principal est facultatif et désactivé par défaut.
- LibraMail peut être verrouillé manuellement et demander le mot de passe au démarrage.
- Tant que l’application est verrouillée, les comptes, messages et opérations métier ne sont pas initialisés.
- Les secrets de comptes et la clé maître du magasin local sont protégés par le coffre cryptographique associé au mot de passe principal.
- Le mot de passe peut être modifié ou désactivé depuis les paramètres.

### Tout marquer comme lu

- Une nouvelle action permet de marquer comme lus tous les messages de la vue courante.
- Elle agit sur l’ensemble des messages correspondants, y compris ceux qui ne sont pas encore chargés à l’écran.
- La boîte unifiée, les dossiers de compte, les dossiers locaux et les étiquettes sont pris en charge.
- L’action est masquée lorsqu’une recherche est active.
- L’interface met à jour les lignes visibles et les compteurs sans rafraîchir toute la liste.

### Debian / Linux

- Un paquet `libramail_0.4.8_amd64.deb` est désormais généré automatiquement.
- Le programme est installé sous `/opt/libramail` et lancé via `/usr/bin/libramail`.
- Une entrée de menu et une icône système sont installées.
- Node.js reste embarqué dans LibraMail.
- Les données utilisateur sont conservées sous `$XDG_DATA_HOME/libramail` ou `~/.local/share/libramail`.
- Le mode portable conserve son fonctionnement historique.
- Pour migrer les données d’un portable vers le paquet Debian, utilisez de préférence la sauvegarde/restauration complète de LibraMail.

### Construction

- GitHub Actions publie désormais les archives Linux portables, le paquet Debian et leurs sommes SHA-256.
- Le packaging exclut les reliquats de développement et normalise les permissions des fichiers installés.

---

## English

LibraMail 0.4.8 strengthens local security, adds a global “Mark all as read” action, and now provides a native Debian package alongside the portable distributions.

### Master password

- The master password is optional and disabled by default.
- LibraMail can be locked manually and can require the password at startup.
- While locked, accounts, messages, and business operations are not initialized.
- Account secrets and the local mail-store master key are protected by the cryptographic vault associated with the master password.
- The master password can be changed or disabled from Settings.

### Mark all as read

- A new action marks every unread message matching the current view as read.
- It applies to all matching messages, not only rows currently loaded on screen.
- Unified inbox, account folders, local folders, and labels are supported.
- The action is hidden while a search is active.
- Visible rows and counters are updated without rebuilding the entire message list.

### Debian / Linux

- A `libramail_0.4.8_amd64.deb` package is now generated automatically.
- The application is installed under `/opt/libramail` and launched through `/usr/bin/libramail`.
- A desktop-menu entry and system icon are installed.
- Node.js remains bundled with LibraMail.
- User data is stored under `$XDG_DATA_HOME/libramail` or `~/.local/share/libramail`.
- Portable mode keeps its historical behavior.
- To migrate portable data to the Debian package, using LibraMail’s complete backup/restore feature is recommended.

### Build and release

- GitHub Actions now publishes the portable Linux archives, Debian package, and SHA-256 checksums.
- Packaging excludes development leftovers and normalizes installed-file permissions.
