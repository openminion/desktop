# OpenMinion Desktop Releasing

Status: not yet enabled
Last updated: 2026-09-30

Purpose: define the proof required before OpenMinion Desktop can enable public
distribution.

OpenMinion Desktop currently proves an unsigned local macOS package only. There
is no public release workflow, signing identity, notarization process, updater,
rollback contract, or clean-machine certification yet.

The manual `CI` workflow can stage unsigned macOS, Windows, and Linux packages
in a private draft release. This is a development handoff only, not public
distribution or platform certification. Delete the draft after verification or
transfer.

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

Before enabling public distribution:

1. add and validate signing and notarization,
2. prove clean-machine Python discovery, managed installation, and first launch,
3. define and test update, rollback, migration, and uninstall behavior,
4. document supported macOS versions and architectures,
5. define artifact provenance and release-key ownership, and
6. publish only from a reviewed `main` revision through a dedicated workflow.

## Runtime qualification evidence

Runtime compatibility is not inferred from a matching version or a successful
package build. Before OpenMinion can publish a source record with non-null
Desktop compatibility:

1. replace the development-only `0.0.0` package version with the reviewed
   three-part Desktop release version,
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

## Current boundary

An unsigned local package is development evidence, not a release candidate.
Do not add a release workflow or `.github/release.yml` until the distribution
activation requirements have owners and passing evidence.
