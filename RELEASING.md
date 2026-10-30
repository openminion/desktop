# OpenMinion Desktop Releasing

Status: unsigned development distribution enabled; stable distribution not enabled
Last updated: 2026-10-30

Purpose: define the unsigned development-package process and the additional
proof required before OpenMinion Desktop can enable stable distribution.

OpenMinion Desktop produces unsigned macOS, Windows, and Linux packages. These
packages are published as explicitly unsigned normal GitHub Releases in
`openminion/runtime`. There is no signing identity, notarization process,
Desktop updater, rollback contract, or clean-machine certification yet.

The manual `CI` workflow stages unsigned macOS, Windows, and Linux packages in
a private draft release. Transfer every package to a public development
Release, verify every public download, then run **Desktop source release**
from the same reviewed `main` revision with that runtime release tag. Delete the
private draft only after both public release records pass readback. This is
public development distribution, not platform certification or a stable Desktop
update.

The separate `Runtime qualification` workflow is not a Desktop distribution
release. It builds a real-version packaged Desktop on all supported hosts to
qualify exact immutable OpenMinion runtime bytes, then opens a reviewed evidence
PR. It never publishes the Desktop packages or changes the runtime feed.

## Source visibility and promotion

The source repository is public. [Public Source Readiness](docs/public-readiness.md)
records the visibility decision, completed launch evidence, and remaining
acceptance. Public source access does not authorize binary publication or close
the stable-distribution requirements below.

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

## Source tags and GitHub Releases

Desktop follows CLI's reviewed version, tag, and GitHub Release sequence, without
TestPyPI or PyPI publication. Keep `package.json` marked `private: true`; Desktop
is distributed as an application, not an npm package. Its separately managed
OpenMinion runtime can still come from PyPI.

For each new Desktop release:

1. Prepare the version and changelog through a feature PR to `dev`, then promote
   reviewed `dev` to `main`. Keep both package files and the README version in
   sync. Use the next patch version, such as `0.0.2`, for the next release after
   the existing `0.0.1` development packages.
2. Build from the reviewed `main` revision using the existing package workflow.
   Require the applicable checks and every claimed platform's package job to
   pass. Record the run's full source SHA; do not tag a newer branch tip merely
   because `main` moved while the build ran.
3. Publish and verify the development packages using the checklist below. The
   source SHA in `desktop-release.json` must be the same commit being tagged,
   and its application version must match `package.json` at that commit.
4. Dispatch **Desktop source release** from that exact `main` revision with the
   public `desktop-dev-v<desktop-version>-build.<number>` tag. The workflow
   verifies version, source commit, release status, asset names, sizes, and
   SHA-256 digests before creating the annotated `v<desktop-version>` tag.
5. Require the workflow to create and read back the Desktop GitHub Release with
   the bare version as its title (for example, tag `v0.0.2`, title `0.0.2`). It
   links the matching `openminion/runtime` downloads, attaches the package
   manifest and checksums, and marks the release as a **prerelease**. Never move
   or reuse a published version tag; a different application release needs a
   new version.
6. Verify the public tag resolves to the recorded build SHA and that the Desktop
   release links to the verified package release. Record both release URLs and
   the tag SHA in the release receipt.

The Desktop source tag and the existing
`desktop-dev-v<desktop-version>-build.<number>` download tag identify different
repositories. Link them through the exact source SHA in the package manifest;
do not replace the artifact repository's existing naming scheme. Temporary
`desktop-package-*` draft releases are transfer staging, not version releases.

The source-release workflow does not build or publish installers. It accepts
only an already-public unsigned runtime package Release whose manifest matches
its exact Desktop `main` revision. Packaging remains in the existing manual
`CI` workflow, and no Python package release workflow is needed.

A Desktop development release is complete only when both public records exist:

1. `openminion/runtime` has the verified unsigned package Release, and
2. `openminion/desktop` has the matching immutable source tag and prerelease.

If either record is unavailable, report the Desktop release as blocked rather
than silently omitting it from a broader release closeout.

## Release floor

Before treating a revision as a release candidate:

1. keep [README.md](README.md), [API_COMPATIBILITY.md](API_COMPATIBILITY.md),
   and `docs/` aligned with the actual application boundary,
2. run `npm ci`, `npm run ci-check`, and `npm run package` from a clean checkout,
3. run the permissioned native-capture test on macOS,
4. run fresh-install and daemon lifecycle integration against the exact
   bootstrap-pinned PyPI release; validate manifest discovery, preparation,
   activation, and reuse separately for every runtime-update claim,
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
5. publish a normal GitHub Release (`prerelease=false`) whose `-dev-` tag,
   manifest, and notes clearly say unsigned and not notarized, stable, or
   automatic-update eligible; use `latest=false` so Desktop does not replace
   the shared repository's latest CLI/runtime marker,
6. anonymously download every public asset and verify every digest, and
7. dispatch **Desktop source release** with the published runtime tag and verify
   its annotated source tag, prerelease status, metadata assets, and source SHA,
8. record both public release URLs, then
9. delete the private transfer draft only after public readback passes.

Do not add an unsigned Desktop development Release to any stable update
manifest or call it a supported Desktop release.

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

An unsigned public development Release is downloadable development evidence,
not a stable release candidate. Do not add a stable release workflow or
`.github/release.yml` until the distribution activation requirements have
owners and passing evidence.

The first complete source/package pair is Desktop
[`v0.0.1`](https://github.com/openminion/desktop/releases/tag/v0.0.1) with
unsigned package release
[`desktop-dev-v0.0.1-build.4`](https://github.com/openminion/runtime/releases/tag/desktop-dev-v0.0.1-build.4).
