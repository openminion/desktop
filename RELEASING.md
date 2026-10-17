# OpenMinion Desktop Releasing

Status: unsigned development distribution enabled; stable distribution not enabled
Last updated: 2026-10-17

Purpose: define the unsigned development-package process and the additional
proof required before OpenMinion Desktop can enable stable distribution.

OpenMinion Desktop produces unsigned macOS, Windows, and Linux packages. These
packages may be published as an explicitly unsigned development prerelease in
`openminion/runtime`. There is no signing identity, notarization process,
Desktop updater, rollback contract, or clean-machine certification yet.

The manual `CI` workflow stages unsigned macOS, Windows, and Linux packages in
a private draft release. Transfer every package to a public development
prerelease, verify every public download, then delete the private draft. This is
public development distribution, not platform certification or a stable
Desktop update.

The separate `Runtime qualification` workflow is not a Desktop distribution
release. It builds a real-version packaged Desktop on all supported hosts to
qualify exact immutable OpenMinion runtime bytes, then opens a reviewed evidence
PR. It never publishes the Desktop packages or changes the runtime feed.

## Source visibility and promotion

Opening the source repository is a separate maintainer decision from publishing
binaries. Complete [Public Source Readiness](docs/public-readiness.md) before
changing visibility; source changes alone do not authorize that change.

For a planned promotion, reconcile `dev` with current `main`, open a `dev` →
`main` PR, and review the complete diff and exact validation evidence. Require
both hosted Quality jobs and every other configured check before merging.
Record the merge revision; dispatch packaging only from that reviewed `main`
revision. Do not use a normal feature PR to bypass promotion. The generated
runtime-certification evidence PR below is a release-only exception targeting
`main`, and still requires review and passing checks.

Manual package staging and runtime qualification run only in the canonical
repository on `main`. A draft release hides its assets, but workflow logs can
be public once the source repository is public. Never put secrets in logs.

## Desktop version

Desktop starts at `0.0.1` and is versioned independently of the OpenMinion
runtime and Electron. `package.json` is the version source for the application
and its packages; keep `package-lock.json` in sync.

For the next patch release, run `npm version patch --no-git-tag-version`
(`0.0.1` → `0.0.2`), review the changelog, and commit both package files through
the normal PR process. Use `minor` or `major` for a deliberately reviewed larger
release. Bump once per planned release, not per commit. Do not reset to `0.0.0`
or reuse a version for different stable releases.

A version bump alone does not publish packages or establish signing, native
qualification, or runtime compatibility. Until publication, changes remain
under **Unreleased** in the changelog; date and label them when actually released.

## Release floor

Before treating a revision as a release candidate:

1. keep [README.md](README.md), [API_COMPATIBILITY.md](API_COMPATIBILITY.md),
   and `docs/` aligned with the actual application boundary,
2. run `npm ci`, `npm run ci-check`, and `npm run package` from a clean checkout,
3. run the permissioned native-capture test on macOS,
4. run installation and daemon lifecycle integration against the exact pinned
   PyPI release,
5. run separate rich chat/session transport and provider-backed acceptance when
   those surfaces are connected, and
6. update the readiness matrix and changelog with the exact proof obtained.

## Distribution activation

Before enabling stable distribution:

1. add and validate signing and notarization,
2. prove clean-machine Python discovery, managed installation, and first launch,
3. define and test update, rollback, migration, and uninstall behavior,
4. document supported macOS versions and architectures,
5. define artifact provenance and release-key ownership, and
6. publish only from a reviewed `main` revision through a dedicated workflow.

## Unsigned development release

Desktop and OpenMinion runtime versions are independent. For each reviewed
Desktop development release:

1. dispatch `CI` from Desktop `main` with `packages=true`,
2. require the quality job and macOS arm64, Linux x86_64, and Windows x86_64
   package jobs to pass,
3. transfer every staged DMG, DEB, or ZIP to
   `desktop-dev-v<desktop-version>-build.<number>` in `openminion/runtime`,
4. add `desktop-release.json` and `SHA256SUMS` with the exact Desktop source
   commit, package filenames, sizes, and SHA-256 digests,
5. publish the Release as a prerelease whose notes clearly say unsigned and not
   notarized, stable, or automatic-update eligible,
6. anonymously download every public asset and verify every digest, and
7. delete the private transfer draft only after public readback passes.

Do not add an unsigned Desktop prerelease to any stable update manifest or call
it a supported Desktop release.

## Runtime qualification evidence

Runtime compatibility is not inferred from a matching version or a successful
package build. Before OpenMinion can publish a source record with non-null
Desktop compatibility:

1. confirm the reviewed three-part Desktop version in `package.json` matches
   the packaged application being qualified,
2. qualify the exact packaged Desktop and official production OpenMinion wheel
   on `darwin-arm64`, `linux-x64`, and `win32-x64`,
3. record package and `app.asar` digests, exact source commits, compatibility
   bounds, verification IDs and the required lifecycle checks,
4. merge the canonical evidence file to `main` under
   `releases/runtime-certification/v1/qualification/<runtime-version>/<evidence-id>.json`,
5. dispatch OpenMinion's protected source-certification publication using the
   resulting full Desktop evidence commit, and
6. after that metadata PR is public, run the shipped packaged Desktop against
   the public feed for discovery, Prepare update, old-runtime reply, restart
   activation, same-chat reply and owned-daemon shutdown.

The qualification file enables a compatibility revision. It does not prove the
later public-feed E2E by itself. See
[`releases/runtime-certification/v1/README.md`](releases/runtime-certification/v1/README.md)
for the exact evidence contract.

For binary runtime qualification:

1. require the final immutable `openminion/runtime` Release to exist without a
   stable feed reference,
2. dispatch **Runtime qualification** with the exact release tag/ID and reviewed
   Desktop version,
3. require all three packaged-host jobs and the generated evidence PR checks,
4. merge the evidence PR to Desktop main,
5. pass that full commit and evidence ID to OpenMinion's protected
   **Runtime manifests** workflow, and
6. after the binary metadata PR is public, rerun `packaged-runtime.mjs` in
   public target mode on every claimed platform.

The qualification harness imports the packaged main-process installer directly
to stage the immutable Release. This is test-only main-process control: no feed
override, renderer authority or product test mode is added.

## Current boundary

An unsigned public prerelease is downloadable development evidence, not a
stable release candidate. Do not add a stable release workflow or
`.github/release.yml` until the distribution activation requirements have
owners and passing evidence.
