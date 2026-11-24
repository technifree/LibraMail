# LibraMail 0.7.0 — Messageries et agendas connectés

Document technique de préparation, établi à partir de l'archive transmise sous le nom `v0.6.4.7z` le 24 novembre 2026. **Ce n'est pas une version 0.7.0 publiable.**

## 1. Audit de l'existant

- Le moteur IMAP/SMTP possède un socle OAuth2 (`engine/lib/mail_auth.js`) avec jeton d'accès éphémère, mais pas de flux de connexion Microsoft intégré ni de rafraîchissement des jetons pour les comptes de messagerie.
- Les connexions **Google Calendar OAuth2** disposent déjà du moteur de synchronisation (`calendar_google_sync.js`), d'écriture (`calendar_google_write.js`), d'une conservation sécurisée des jetons et de la gestion des conflits.
- Les abonnements **ICS** (`calendar_subscriptions.js`) sont des flux unidirectionnels et ne permettent pas de créer, modifier ou supprimer un événement sur le serveur source.
- L'UI Google Calendar demande historiquement un *Client ID* et un *Client secret* propres à l'utilisateur. Le *Client secret* n'est pourtant pas obligatoire avec un client OAuth2 natif et PKCE. La configuration d'un Client ID public par le projet doit être privilégiée.
- **Incohérence dans l'archive fournie :** `VERSION` et `neutralino.config.json` indiquent `0.6.2` alors que `engine/backend.js` déclare `APP_VERSION = '0.6.3'`, malgré le nom d'archive `v0.6.4.7z`. Ne pas lancer une publication avant rapprochement avec la branche Git et la vraie version distribuée.

## 2. Lot de préparation réalisé

1. Reconnaissance automatique des domaines Gmail, Googlemail, Hotmail, Outlook, Live et MSN ; sélection manuelle de Gmail, Microsoft ou autre fournisseur.
2. Préconfiguration Gmail IMAP (993/TLS) et SMTP (465/TLS) et aide en français/anglais pour la validation en deux étapes et le mot de passe d'application, avec lien direct vers Google.
3. Présentation correcte de la contrainte OAuth2 Microsoft ; interdiction d'ajouter par le formulaire historique un compte Outlook/Hotmail voué à échouer. Vérification complémentaire dans le backend lors de `accounts.add`.
4. Mention claire des limites des abonnements ICS et du calendrier Google de destination à choisir pour publier un événement.
5. Préfiguration facultative du Client ID public Google Calendar via `LIBRAMAIL_GOOGLE_CALENDAR_CLIENT_ID` ; champ de Client ID masqué s'il est géré par le projet ; plus d'obligation d'indiquer un *Client secret* dans l'interface Google Calendar.
6. Nouveau module d'authentification Microsoft **non encore relié aux comptes**, `engine/lib/mail_microsoft_oauth.js` : autorisation par code d'appareil, récupération des jetons, renouvellement, validations d'entrées et tests avec réponses simulées.

### Statut du lot

- **Fonctionnel dans l'interface** : assistance Gmail et avertissements ICS/Microsoft.
- **Infrastructure isolée** : module de jetons Microsoft testable avec un simulateur HTTP.
- **Non fonctionnel pour l'utilisateur final** : consultation/envoi des mails Microsoft, synchronisation bidirectionnelle Outlook/iCloud.
- **Google bidirectionnel** : déjà présent dans la base 0.6.4 pour les connexions Google OAuth2 correctement autorisées ; à requalifier en condition réelle.

## 3. Lot de développement Microsoft Mail

**Prérequis de déploiement** : enregistrer une **application publique** dans Microsoft Entra (clients mobiles et de bureau), supportant les comptes personnels et professionnels ; inclure les autorisations déléguées IMAP/SMTP et l'accès hors ligne. Un seul identifiant public doit être fourni par le projet LibraMail. Aucun utilisateur final ne doit être obligé de créer son propre Client ID.

Chantiers restants :

- Raccorder `mail_microsoft_oauth.js` à une session de connexion en mémoire, avec `deviceCode`/`userCode` affichés uniquement pendant l'autorisation, annulation, expiration et respect de `interval` et `slow_down`.
- Après autorisation, créer un compte de type `authentication: { type: 'oauth2', provider: 'microsoft' }` et stocker **uniquement** le refresh token dans le coffre système, jamais dans `accounts.json`, les exports, les journaux ni les sauvegardes.
- Alimenter l'authentification IMAP/SASL XOAUTH2 et SMTP/OAuth2 déjà prévue par `mail_auth.js`, rafraîchir avant expiration, à chaque démarrage et après une erreur 401, sans fuite de jeton ni relance automatique d'un envoi ambigu.
- Couvrir `sync`, IDLE, opérations sur dossiers, recherche, suppression, pièces jointes, drafts, envoi direct, envois différés, migration IMAP, verrouillage par mot de passe principal et import/export.
- Pour Microsoft 365, gérer distinctement les restrictions d'administrateur : IMAP ou SMTP AUTH peuvent être désactivés, même si OAuth2 est autorisé. Prévoir un adaptateur Microsoft Graph Mail pour les cas qui ne permettent pas IMAP/SMTP OAuth2.
- Ajouter tests de reprise après redémarrage, révocation de consentement, coffre indisponible, compte bloqué par politique de l'entreprise et rafraîchissements simultanés.

Références :
- https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth
- https://support.microsoft.com/fr-fr/outlook/pop-imap-and-smtp-settings-for-outlook-com
- https://learn.microsoft.com/en-us/entra/identity-platform/v2-supported-account-types

## 4. Lot agendas bidirectionnels

### Google

- Réutiliser les moteurs `calendar_google_*` existants ; faire une campagne de qualification réelle (création, modification, suppression, fuseaux, événements récurrents, conflits, perte et récupération de réseau).
- Simplifier l'interface : « Connecter Google », choix des calendriers, état des droits en lecture/écriture, choix du calendrier destination lors d'une création.
- Déployer, après enregistrement/vérification de l'application Google, un Client ID public embarqué ou configuré par le projet afin d'éviter la création d'identifiants OAuth par les utilisateurs.

### Microsoft Outlook / Microsoft 365

- Utiliser Microsoft Graph et les autorisations déléguées `Calendars.ReadWrite`, en réutilisant la connexion OAuth Microsoft lorsque les droits et la configuration le permettent.
- Gestion des calendriers et événements sélectionnés, droits d'écriture, création/modification/suppression, pagination et synchronisation incrémentale (delta par calendrier et plage de dates).
- Conserver `id`, `changeKey`/ETag, fuseau, calendrier d'origine et état du dernier échange pour prévenir les doublons et conflits.
- Prévoir une stratégie de résolution lorsque des modifications concurrentes surviennent : signaler, rafraîchir et demander arbitrage plutôt que supprimer ou écraser silencieusement.

Références :
- https://learn.microsoft.com/en-us/graph/api/calendar-post-events?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/delta-query-events?view=graph-rest-1.0

### Apple iCloud et CalDAV

- Ajouter un adaptateur CalDAV générique ; découverte des collections calendrier, PROPFIND/REPORT, ETag, GET/PUT/DELETE, synchronisation incrémentale quand le serveur le permet.
- Pour iCloud, guider l'utilisateur vers la procédure d'autorisation Apple compatible avec les applications tierces, notamment le mot de passe d'application lorsqu'il est requis. **Ne jamais demander le mot de passe principal de l'Apple Account.**
- Couvrir les fuseaux horaires, événements récurrents, événements journée entière, statuts lecture seule, pièces jointes/invitations non prises en charge explicitement, et les modifications concurrentes (`If-Match`/HTTP 412).
- Ne pas confondre une URL ICS publique/privée et l'URL CalDAV authentifiée. Un flux ICS importé ne devient pas automatiquement modifiable.

Référence : https://support.apple.com/fr-fr/102654

### Modèle transversal

Chaque événement doit posséder une origine explicite (`local`, `google`, `microsoft`, `caldav` ou `ics`) et une destination ; l'interface ne doit jamais laisser supposer qu'une création locale est synchronisée à distance. Prévoir un statut de synchronisation, des erreurs consultables, une file de modifications locales avec identifiants stables et une politique de conflits. Pour les abonnements ICS, rendre les modifications sur serveur impossibles.

## 5. Critères avant publication 0.7.0

- Gmail : connexion d'un utilisateur neuf grâce aux indications, sans renseigner à la main les serveurs.
- Outlook.com/Hotmail : connexion Microsoft réussie, lecture et envoi, redémarrage sans réautorisation systématique, renouvellement automatique du jeton, déconnexion propre.
- Microsoft 365 : validation avec un compte professionnel autorisé et message explicite si l'administrateur interdit IMAP, SMTP AUTH ou les permissions Graph.
- Google/Outlook/iCloud : création, édition, suppression dans LibraMail visibles sur le service distant, et inversement ; reprise après coupure réseau ; pas de doublons ; gestion des conflits testée.
- ICS : contenu consultable, lecture seule visible, aucune écriture distante faussement annoncée.
- Tests FR/EN, sauvegarde/restauration, coffre-fort/maître, Linux et Windows ; macOS à valider lorsque les environnements seront disponibles.
- Contrôle cohérence des versions et publication uniquement après réussite de tous les tests et vérification réelle sur des comptes de test.

**Stratégie de livraison proposée** : `dev-0.7.0`, lots tests/commits séparés : (A) assistance Gmail ; (B) Microsoft OAuth2 Mail ; (C) Google Calendar UX et qualification ; (D) Microsoft Graph Calendar ; (E) CalDAV/iCloud ; (F) intégration complète, non-régression et publication.
