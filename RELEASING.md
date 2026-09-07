# OpenMinion Desktop Releasing

Status: not yet enabled
Last updated: 2026-09-07

Purpose: define the proof required before OpenMinion Desktop can enable public
distribution.

OpenMinion Desktop currently proves an unsigned local macOS package only. There
is no public release workflow, signing identity, notarization process, updater,
rollback contract, or clean-machine certification yet.

## Release floor

Before treating a revision as a release candidate:

1. keep [README.md](README.md), [API_COMPATIBILITY.md](API_COMPATIBILITY.md),
   and `docs/` aligned with the actual application boundary,
2. run `npm ci`, `npm run ci-check`, and `npm run package` from a clean checkout,
3. run the permissioned native-capture test on macOS,
4. run real-daemon integration against the exact compatible OpenMinion
   revision, and
5. require the Desktop daemon contract to be present on the intended
   OpenMinion release line, and
6. update the readiness matrix and changelog with the exact proof obtained.

## Distribution activation

Before enabling public distribution:

1. add and validate signing and notarization,
2. prove clean-machine installation and first launch,
3. define and test update, rollback, migration, and uninstall behavior,
4. document supported macOS versions and architectures,
5. define artifact provenance and release-key ownership, and
6. publish only from a reviewed `main` revision through a dedicated workflow.

## Current boundary

An unsigned local package is development evidence, not a release candidate.
Do not add a release workflow or `.github/release.yml` until the distribution
activation requirements have owners and passing evidence.
