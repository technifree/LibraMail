# LibraMail — macOS preview / Préversion macOS

**Status:** experimental. Do not publish this ZIP as an official LibraMail release until both architectures have passed CI and real-device testing.

**Statut :** expérimental. Ne publie pas ces ZIP comme version officielle avant la validation des deux architectures et des essais sur Mac.

## Intended targets / Plateformes prévues

- macOS Intel (`macos-15-intel`, x86_64), native Neutralino and Node.js, official imapsync Darwin x86_64 binary with repository-approved SHA-256.
- macOS Apple Silicon (`macos-15`, arm64), native Neutralino and Node.js, imapsync built from the pinned 2.314 source with PAR::Packer. If native packaging fails, the workflow fails rather than producing an incomplete app.
- Both outputs are unsigned/unnotarized `.app` bundles in ZIP archives, with native SQLite and no user data.

## One-time Intel imapsync verification / Empreinte Intel

Retrieve the upstream executable yourself and check its origin before approving the SHA-256:

```bash
curl -fL --retry 3 \
  https://imapsync.lamiral.info/dist2/imapsync_bin_Darwin_x86_64 \
  -o /tmp/imapsync_bin_Darwin_x86_64
shasum -a 256 /tmp/imapsync_bin_Darwin_x86_64
```

**From Linux**, use `sha256sum` instead of `shasum -a 256`.
Once verified, explicitly approve the checksum for CI (no binary is committed):

```bash
gh variable set IMAPSYNC_MACOS_X64_SHA256 \
  --repo technifree/LibraMail \
  --body "$(sha256sum /tmp/imapsync_bin_Darwin_x86_64 | awk '{print $1}')"
```

## Launch preview workflow / Lancer les tests

After committing and pushing the source changes to `master`:

```bash
gh workflow run macos-preview.yml --ref master
gh run list --workflow macos-preview.yml --limit 5
```

The pipeline will create a macOS artifact **only after** Node, the Neutralino app, native SQLite and an executable imapsync have passed the packaging checks. Artifacts are preview outputs, not GitHub Releases.

## Validation before official release

1. Verify the ZIP contains `LibraMail.app`, and launches from Finder on each architecture.
2. Check that `~/Library/Application Support/LibraMail/data` is writable and that no state is written into `/Applications/LibraMail.app`.
3. Verify a complete migration IMAP simulation (no deletion), and check that `imapsync` runs independently of Homebrew/CPAN on user machines.
4. Test mail read state and navigation, calendar, backups, clean exit, and reopened sessions.
5. Set up Developer ID signing and Apple notarization before distributing publicly; **do not** advise users to disable Gatekeeper globally.

A compiled artifact alone does not establish a production-ready macOS application.
