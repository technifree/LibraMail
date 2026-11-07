# LibraMail 0.6.3 — lecture, notification des mises à jour et préparation macOS

## Correctif

L'ancienne version met à jour `seen` après un clic, mais une ligne de
conversation (même pour un seul message) conserve parfois `thread_unread=1`.
La liste virtuelle utilise `thread_unread` pour déterminer le style non lu :
point vert et texte gras persistent malgré la validation RPC.

Le correctif synchronise désormais les deux propriétés de la ligne et
invalide les caches des listes. Il couvre les messages simples ainsi que les
conversations de plusieurs messages. La préférence « 0 seconde » continue de
signifier « dès que le message est effectivement affiché », pas un simple
clic sur une case de sélection.

## Détection et téléchargement des nouvelles versions

La vérification de la dernière version publiée sur GitHub existait déjà, mais
l'indicateur pointait uniquement vers la fenêtre « À propos ». Il est désormais
intégré discrètement dans la barre supérieure. En cliquant sur l'indicateur,
ou sur « Nouvelle version disponible » dans la fenêtre « À propos », LibraMail
ouvre la page GitHub Releases spécifique au numéro de version détecté.
Le statut « LibraMail est à jour » est également cliquable : il ouvre la page
générale des téléchargements officiels, y compris si la version locale est
encore en développement. Le lien est construit sur le dépôt officiel
technifree/LibraMail ; aucune adresse arbitraire provenant de l'API n'est ouverte. La vérification est
silencieuse au démarrage et toutes les six heures si le programme reste ouvert.

## macOS

Un script de compilation native macOS et un workflow Actions **manuel** sont
ajoutés : Intel x86_64 et Apple Silicon arm64. Les deux exigent un imapsync
exécutable ; le programme ne distribue jamais silencieusement une édition
incomplète. Node.js et better-sqlite3 sont compilés/installés pour
l'architecture cible. Le dossier de données macOS est distinct de l'application
(`~/Library/Application Support/LibraMail`).

Le workflow macOS est expérimental. Aucun paquet Mac n'a encore été validé
physiquement et aucune signature/notarisation Apple n'est fournie : ne pas
publier comme version stable avant qualification sur les deux machines.

## Vérification

86 tests automatisés exécutés sous Linux avec le Node.js ABI 127 et les
dépendances du paquet précédent. Pas d'essai macOS réel ni d'essai IMAP
sur les comptes de l'utilisateur dans cet environnement.
