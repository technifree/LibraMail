# LibraMail 0.6.3 — lecture, notification des mises à jour et distribution macOS expérimentale

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

Les compilations natives macOS et leurs tests d’exécution ont été validés
par GitHub Actions pour Intel x86_64 et Apple Silicon arm64. Les deux exigent un imapsync
exécutable ; le programme ne distribue jamais silencieusement une édition
incomplète. Node.js et better-sqlite3 sont compilés/installés pour
l'architecture cible. Le dossier de données macOS est distinct de l'application
(`~/Library/Application Support/LibraMail`).

Les paquets macOS sont destinés à une distribution **expérimentale**.
Les essais graphiques sur Mac physique restent à réaliser ; aucune signature
ni notarisation Apple n’est fournie. Ne pas les présenter comme stables.

## Vérification

87 tests automatisés exécutés localement sous Linux. Les compilations et
tests d’exécution macOS ont réussi sur les deux architectures dans GitHub
Actions ; essais graphiques sur Mac physique et essais IMAP réels non réalisés.
