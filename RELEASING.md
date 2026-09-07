# OpenMinion Desktop Releasing

Status: not yet enabled

OpenMinion Desktop currently proves an unsigned local macOS package only. There
is no public release workflow, signing identity, notarization process, updater,
rollback contract, or clean-machine certification yet.

Before enabling distribution:

1. run `npm ci` and `npm run ci-check` from a clean checkout,
2. run `npm run package` and the permissioned native-capture test on macOS,
3. run the real-daemon integration against the exact compatible OpenMinion
   revision,
4. add and validate signing, notarization, clean-machine installation, update,
   rollback, migration, and uninstall behavior,
5. update the readiness matrix and changelog to match the proven scope, and
6. publish only from a reviewed `main` revision through a dedicated workflow.

An unsigned local package is development evidence, not a release candidate.
