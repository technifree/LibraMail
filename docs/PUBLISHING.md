# Publishing LibraMail with GitHub Actions

> **English** · [Français](#publication-de-libramail-avec-github-actions)

## One-time setup

Install and authenticate the GitHub CLI:

```bash
gh auth login
```

Copy this kit to the root of the LibraMail source tree, then run:

```bash
chmod +x github.sh *.sh
./github.sh check
./github.sh init
```

Defaults:

```text
Owner       technifree
Repository  LibraMail
Branch      master
Visibility  public
```

They can be overridden for the initial setup:

```bash
GITHUB_OWNER=my-account REPO_NAME=LibraMail VISIBILITY=private ./github.sh init
```

## Build without publishing

```bash
./github.sh build
```

The script starts `.github/workflows/build.yml`, waits for Linux and Windows,
then downloads both GitHub artifacts into `github-artifacts/`.

## Publish a release

```bash
./github.sh release 0.2.19
```

Optional bilingual notes:

```bash
./github.sh release 0.2.19 \
  "Correction de la synchronisation et amélioration des contacts." \
  "Synchronisation fixes and improved contacts."
```

The release command:

1. validates the repository and personal-data exclusions
2. updates all application version markers
3. updates the bilingual README date
4. creates a source commit
5. pushes the commit and tag
6. waits for GitHub Actions
7. publishes Linux and Windows archives in GitHub Releases

## Workflows

- `verify.yml`: source, version, JSON, JavaScript and SQLite dependency checks
- `build.yml`: manual portable Linux and Windows builds
- `release.yml`: tag-triggered builds and GitHub Release publication

Public workflows always call the build scripts **without `--with-data`**.

---

# Publication de LibraMail avec GitHub Actions

## Mise en place unique

Installez puis connectez GitHub CLI :

```bash
gh auth login
```

Copiez ce kit à la racine des sources LibraMail puis lancez :

```bash
chmod +x github.sh *.sh
./github.sh check
./github.sh init
```

Valeurs par défaut :

```text
Propriétaire  technifree
Dépôt         LibraMail
Branche       master
Visibilité    public
```

Elles peuvent être remplacées lors de l'initialisation :

```bash
GITHUB_OWNER=mon-compte REPO_NAME=LibraMail VISIBILITY=private ./github.sh init
```

## Compiler sans publier

```bash
./github.sh build
```

Le script déclenche `.github/workflows/build.yml`, attend les compilations Linux
et Windows, puis télécharge les artefacts dans `github-artifacts/`.

## Publier une version

```bash
./github.sh release 0.2.19
```

Avec des notes bilingues facultatives :

```bash
./github.sh release 0.2.19 \
  "Correction de la synchronisation et amélioration des contacts." \
  "Synchronisation fixes and improved contacts."
```

La commande :

1. vérifie le dépôt et l'absence de données personnelles suivies
2. synchronise tous les numéros de version
3. actualise la date du README bilingue
4. crée un commit source
5. pousse le commit et le tag
6. attend GitHub Actions
7. publie les archives Linux et Windows dans Releases

Les actions publiques appellent toujours les scripts de compilation **sans
`--with-data`**.
