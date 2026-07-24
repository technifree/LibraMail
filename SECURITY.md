# Security policy / Politique de sécurité

## Reporting a vulnerability / Signaler une vulnérabilité

Do not publish credentials, messages, backups or personal data in a public
issue. Contact the maintainer privately through the address listed on the
Technifree website.

Ne publiez jamais d'identifiants, de messages, de sauvegardes ou de données
personnelles dans une issue publique. Contactez le mainteneur en privé via
l'adresse indiquée sur le site Technifree.

## Sensitive files / Fichiers sensibles

The following must never be committed:

- `data/accounts.json`
- `data/index.db` and SQLite journal files
- `data/mail/`
- LibraMail backup ZIP files
- private builds created with `--with-data`
- certificates, tokens and environment files

Le script `security_check.sh` bloque ces chemins lorsqu'ils sont suivis par Git.
