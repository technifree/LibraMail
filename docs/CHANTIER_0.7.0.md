# LibraMail 0.7.0 — Messageries et agendas connectés

Document technique de préparation, établi à partir de l'archive transmise sous le nom `v0.6.4.7z` le 24 novembre 2026. **Ce n'est pas une version 0.7.0 publiable.**

## Périmètre révisé — après validation de la phase B

- La messagerie Outlook.com, Hotmail, Live et Microsoft 365 est retirée du périmètre 0.7.0 : aucun enregistrement Entra, abonnement Azure ni identifiant OAuth tiers. La détection et le refus explicite restent présents ; les comptes existants ne sont pas supprimés.
- Microsoft Graph Calendar est également reporté, car il dépend de la même inscription. Les calendriers Outlook publiés en ICS restent consultables en lecture seule.
- Le socle Microsoft isolé et ses tests restent dans l'historique technique ; il n'est pas activé. Les sections antérieures ci-dessous décrivent l'ancien périmètre, pas des engagements de livraison.
- Priorités : CalDAV/iCloud bidirectionnel, qualification réelle de Google Calendar, configuration Gmail et non-régression. Le filtrage rapide par expéditeur est ajouté au périmètre de livraison (phase F).

### Phase C1 — Socle CalDAV

- Client de transport indépendant, HTTPS, authentification Basic, PROPFIND/REPORT, lecture GET, création PUT avec If-None-Match, modification PUT et suppression DELETE avec ETag fort (If-Match).
- Aucune redirection automatique ni transmission des identifiants vers une autre origine ; délai et volume de réponse limités ; erreurs sans contenu brut ni secret.
- Tests simulés, aucun compte réel nécessaire. Aucun stockage de mots de passe, aucun raccordement à la base ni à l'interface à ce stade.
- Prochaine étape : analyse XML avec namespaces et protection contre les entités externes, découverte des collections, gestion contrôlée des redirections iCloud, coffre de secrets, puis synchronisation et interface. La compatibilité réelle iCloud/Nextcloud n'est pas encore acquise.
- Références : RFC 4791 (https://www.rfc-editor.org/rfc/rfc4791.html), Apple (https://support.apple.com/fr-fr/102654).

### Phase C2 — Découverte CalDAV (socle isolé)

- Découverte depuis une URL CalDAV explicite ou `/.well-known/caldav` (sans découverte DNS SRV pour ce lot), principal et collections d’agenda. Pour iCloud, point de départ `https://caldav.icloud.com/`.
- Analyse XML DAV/CalDAV limitée et consciente des namespaces, refus des DTD et entités non prédéfinies, prise en compte uniquement des propriétés renvoyées avec un statut 2xx. Les calendriers exclusivement VTODO sont ignorés.
- Redirections de découverte uniquement, même origine pour CalDAV générique ; pour le mode iCloud explicite, seuls les hôtes `caldav.icloud.com` et `pNN-caldav.icloud.com` (HTTPS, port standard) sont acceptés. Nombre de requêtes et redirections borné. Les méthodes d’écriture conservent la politique C1.
- Les privilèges de collection sont indicatifs : droits inconnus traités en lecture seule ; la modification effective reste soumise aux droits du serveur et aux ETags. Aucune modification distante pendant la découverte.
- Tests simulés ; aucun mot de passe persisté, aucun appel RPC, aucun assistant graphique. Le parseur XML est volontairement limité aux formes DAV usuelles ; la qualification sur de vrais serveurs iCloud et Nextcloud reste indispensable.
- Références : RFC 6764 (https://www.rfc-editor.org/rfc/rfc6764.html), RFC 3744 (https://www.rfc-editor.org/rfc/rfc3744.html).

### Phase C3 — Coffre des identifiants CalDAV (socle isolé)

- Réutilisation du trousseau système (`credential_store.js`), sans fichier de mots de passe ni nouveau mécanisme de chiffrement. Si le mot de passe principal est activé, le secret de service CalDAV bénéficie du même enveloppement AES-GCM `vault1:` et des migrations activation/désactivation/déverrouillage que les autres secrets.
- Plusieurs connexions identifiées par UUID v4 ; liaison du secret au fournisseur, à l’URL HTTPS initiale canonique et à l’identifiant utilisateur (empreinte SHA-256). Une modification de cette identité exige une saisie explicite du mot de passe. Les URL des collections découvertes ne doivent pas servir à changer cette liaison.
- Accès refusé lorsque LibraMail est verrouillé. Échec du trousseau ou contenu corrompu : refus sans repli sur disque, sans message natif contenant potentiellement un secret. Écriture vérifiée et tentative de retour arrière si échec.
- Limite conservatrice provisoire de 850 octets UTF-8 pour l’ensemble des entrées JSON, afin de garder une marge avec l’enveloppe AES-GCM et les limites des trousseaux Windows ; refus explicite si la capacité est dépassée. Le dernier retrait laisse une entrée vide vérifiée (`{}`). La capacité pourra être revue avant livraison si nécessaire.
- Les identifiants ne font pas partie des sauvegardes ZIP (trousseau externe au dossier de données). La restauration sur un autre poste nécessitera une nouvelle saisie. Le stockage des métadonnées, les opérations de connexion RPC, la sélection des collections et la synchronisation restent à intégrer ; aucune utilisation réelle depuis l’interface dans ce lot.
- Tests avec trousseau simulé et véritable module de mot de passe principal, y compris migrations, changement de mot de passe principal, verrouillage, rotation, retrait, liaison à l’identité et défaut d’écriture. Qualification du trousseau natif sur Linux, Windows et macOS à effectuer.

### Phase C4a — Lecture CalDAV et cache SQLite (socle isolé)

- Synchronisation explicite d’une collection déjà sélectionnée via REPORT, sans modification distante. Réutilisation de `syncCalendarRemoteEvents` (transaction SQLite par collection, identifiants distants, ETags, création/mise à jour/suppression du cache local). Aucun changement de schéma dans ce lot.
- Un instantané n’est appliqué qu’après validation complète : statut DAV, propriétés, ETags forts, absence de doublons, ressources directes de la collection, XML et données d’événement valides. Toute réponse partielle, erreur réseau ou événement non pris en charge laisse le cache intact. Une réponse complète vide retire les événements de cette seule collection.
- Prise en charge initiale des rendez-vous simples, journées entières et séries DAILY/WEEKLY de forme FREQ/COUNT[/INTERVAL] (366 occurrences maximum). Les fuseaux IANA sont projetés via le parseur existant et Intl ; dates non représentables refusées. Les séries complexes, exceptions, durées DURATION et fuseaux personnalisés restent à traiter. Ce lot est volontairement conservateur : un seul événement non supporté bloque l’instantané de sa collection.
- Liaison au coffre C3 et contrôle de l’identité de connexion avant et après le REPORT ; politique d’origine C2 pour les collections, aucun suivi de redirection pour les événements. Protection contre les synchronisations concurrentes d’une même collection. Diagnostics limités aux codes d’erreur ; dernière réussite conservée en cas d’échec.
- Tests simulés du moteur et test d’intégration SQLite avec base temporaire. Le stockage des métadonnées de connexion, les RPC, la synchronisation périodique et la qualification de vrais serveurs restent à intégrer en C4b et suivants ; aucun démarrage automatique ni nouvelle interface.

### Phase C4b — Raccordement au moteur (lecture seule)

- Métadonnées CalDAV dans SQLite (URL canonique et intervalle), migration additive des connexions existantes. Le mot de passe reste dans le coffre C3 et doit être ressaisi après restauration sur un autre poste.
- RPC authentifiées locales de découverte, ajout avec sélection explicite, configuration, renouvellement du mot de passe, synchronisation manuelle et retrait. Pas encore de formulaire graphique. La sélection est vérifiée par une nouvelle découverte avant enregistrement ; aucune écriture distante.
- Synchronisation au démarrage (après 5 s) puis contrôle toutes les minutes ; intervalle par compte de 5 à 1440 minutes, 15 par défaut. Les tentatives sont espacées, même après erreur, pour éviter le martèlement. Une seule opération CalDAV à la fois ; arrêt et annulation au verrouillage, à l'arrêt et lors des opérations de maintenance. Le cache est préservé après erreur, les statuts ne contiennent pas les messages bruts du serveur.
- Les écritures CalDAV sont explicitement bloquées dans les RPC de rendez-vous jusqu'à C5. Les rôles sont distincts des rôles Google. Les récurrences complexes restent une limite de C4a ; aucune qualification sur un serveur réel pour ce lot.
- Tests de cycle de vie simulé, annulation, isolation Google, validation et rollback ; test SQLite étendu pour les nouvelles métadonnées. Qualification du moteur complet et des trousseaux natifs à réaliser sur les installations cibles.

### Phase C5a — Écritures conditionnelles CalDAV (moteur)

- RPC locales dédiées `calendar.caldav.event.create/update/remove`, protégées par le verrou d’opération C4b. Les RPC historiques `calendar.save/remove` restent bloquées pour CalDAV jusqu’au raccordement UI. Aucun changement de schéma ni dépendance supplémentaire.
- Création avec UUID v4 stable fourni par l’appelant, UID iCalendar dérivé et PUT `If-None-Match: *`. En cas de réponse incertaine, ne pas renouveler cet UUID : resynchroniser avant une nouvelle tentative. Pas de file d’attente hors ligne ni de répétition automatique des mutations.
- Édition et suppression : ETag fort attendu par l’appelant, comparaison au cache puis GET de la ressource, PUT/DELETE avec `If-Match`. Suppression avec confirmation explicite. Contrôle du fournisseur, des droits, de la collection et de l’origine. Les séries et invitations, pièces jointes et autres ressources non représentables ne sont pas mutables dans ce lot.
- Réécriture des champs titre, dates, lieu et notes avec échappement iCalendar et pliage UTF-8. Conservation des UID, métadonnées non modifiées, fuseaux et alarmes existantes ; validation de l’aller-retour via le parseur avant envoi. Les événements à heure ambiguë qui ne peuvent être représentés sans perte sont refusés.
- Après PUT : GET de la représentation effective et de son ETag, validation avant mise à jour ciblée du cache SQLite. Après DELETE confirmé : retrait de cette seule ressource. Si le serveur a pu appliquer l’opération sans confirmation exploitable, signalement `WRITE_UNCERTAIN`, cache conservé sauf écriture locale déjà effectuée, et prochaine lecture de réconciliation. Conflit signalé sans écrasement ni nouvelle écriture automatique.
- Tests simulés du cycle complet, concurrence, annulation, lecture seule, idempotence du chemin de création, pertes réseau après PUT et réponses GET invalides. Les tests sur serveur réel et le raccordement graphique restent à faire. Les récurrences complexes continuent de limiter les instantanés C4a.

### Phase C5b — Raccordement des écritures au planning

- Le sélecteur de destination distingue Google et CalDAV/iCloud ; seuls les calendriers sélectionnés, actifs et autorisant l’écriture sont proposés pour les nouveaux rendez-vous. Les rendez-vous distants conservent leur calendrier d’origine ; aucune conversion locale implicite.
- Les commandes C5a sont utilisées directement, avec ETag mémorisé à l’ouverture, confirmation de suppression et UUID v4 conservé durant la saisie. Les champs non transmis (catégorie locale et pièces jointes) ne sont pas proposés pour CalDAV.
- Erreurs FR/EN explicites, formulaire conservé, aucune répétition automatique. En cas de conflit ou de résultat incertain, fermeture et actualisation manuelles avant toute nouvelle opération. Les protections du moteur sur les événements non représentables restent actives.
- Le bouton d’actualisation inclut les comptes CalDAV. Test du routage des écritures et du comportement de l’éditeur sur réponses RPC simulées. L’assistant de connexion et la qualification réelle restent à réaliser (C6/C7).


### Phase C6 — Assistant de configuration CalDAV / iCloud

- Sélecteur des quatre types de calendriers dans la fenêtre existante ; formulaires iCloud (serveur imposé) et CalDAV HTTPS, traductions FR/EN.
- Découverte sans persistance, choix des collections et couleurs initiales, enregistrement revalidé par le moteur ; première synchronisation distincte de la création du compte.
- Gestion locale des comptes : intervalle, activation, sélection, relève manuelle, remplacement du mot de passe et retrait confirmé (aucune suppression distante).
- Mot de passe effacé lors de la fermeture, du changement de fournisseur, du verrouillage ou après l’enregistrement ; réponses tardives de découverte ignorées.
- Pas de modification de schéma ni de dépendance ; changement d’identité/serveur et découverte des nouveaux calendriers après création nécessitent une évolution dédiée. Qualification iCloud et récurrences complexes encore ouvertes.

### Qualification réelle C6/C7 — état intermédiaire

- Authentification iCloud et découverte de quatre calendriers confirmées sur Linux. Correctifs successifs de compatibilité DAV, synchronisation partielle protégée, récurrences usuelles et affichage de la provenance des événements. Les quatre calendriers ont signalé une synchronisation réussie ; création distante depuis LibraMail confirmée par l'utilisateur.
- Un doublon apparent a été identifié dans SQLite : un événement CalDAV et une copie issue d'un ancien abonnement ICS au même calendrier. Aucun dédoublonnage automatique par titre/date ; prévoir un avertissement non bloquant dans l'assistant. Le retrait d'un abonnement ICS ne doit jamais modifier le serveur distant.
- Restent à qualifier : modifications et suppressions dans les deux sens, récurrences avec exceptions, reprise après coupure, et finalisation de la gestion des calendriers (couleurs, actualisation individuelle, redécouverte, libellés et diagnostics).

### Phase F — Filtrage rapide par expéditeur (à développer)

- Action directe sur l'expéditeur depuis la liste des messages ou la lecture ; conserver une action contextuelle et permettre l'extension explicite à tous les comptes.
- Filtrer sur l'adresse électronique réelle, pas sur le nom affiché ; recherche exacte sur les messages indexés, sans modifier les messages ni créer de règle automatique. Afficher le périmètre, le nombre de résultats et un moyen de quitter le filtre.
- Réutiliser la recherche existante et les opérations groupées avec confirmation ; la sélection globale doit respecter strictement le filtre et le périmètre, y compris les résultats non chargés. Aucun blocage ou suppression automatique.
- Tester les homonymes, adresses ressemblantes, comptes multiples, pagination, retour à la vue précédente, opérations groupées et traductions FR/EN. Qualification et non-régression avant publication 0.7.0.

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


## Phase B — Assistant de configuration des comptes

- Paramètres avancés repliés pour les nouveaux comptes Gmail standard et Microsoft ; ouverts pour les comptes existants et configurations manuelles.
- Champ de mot de passe Gmail unique (le champ IMAP existant est déplacé, pas dupliqué), espaces de présentation retirés lors de l’enregistrement standard. SMTP utilise le même mot de passe si son champ avancé est vide.
- Le mot de passe guidé est effacé en cas de changement d’adresse ou de configuration des serveurs ; les mots de passe sont masqués et effacés à la fermeture du dialogue.
- Sélection manuelle Microsoft pour les domaines professionnels, avec SMTP Office 365 ; aucune connexion Microsoft fictive ni sauvegarde d’un nouveau compte Microsoft avant raccordement OAuth2 (phase C).
- Le mode avancé conserve IMAP/POP3/SMTP, les options de compte et les mécanismes de validation existants.
