# Support

## What is supported today

Current development support is limited to:

1. the local macOS source-development client described in [README.md](README.md),
   [API_COMPATIBILITY.md](API_COMPATIBILITY.md), and `docs/`,
2. a matching desktop-capable OpenMinion development revision,
3. Node.js 24 and npm 11 development environments,
4. provider-free quality checks on Linux and macOS, and
5. unsigned macOS package construction plus explicit opt-in native and daemon
   integration tests.

## Not covered by the current support promise

The following surfaces are not supported yet:

1. signed or notarized distribution,
2. automatic updates, migration, rollback, or uninstall guarantees,
3. remote daemon attachment or hosted synchronization,
4. Windows or Linux desktop packages,
5. unrestricted native input control, and
6. provider behavior, outages, pricing, or model-quality guarantees.

## Getting help

For a non-security bug, use the repository
[issue tracker](https://github.com/openminion/desktop/issues) and include:

1. the Desktop revision,
2. the OpenMinion revision,
3. macOS version and architecture,
4. Node.js and npm versions,
5. reproduction steps, and
6. whether the failure occurred in development, an unsigned package, native
   capture, daemon integration, or provider-backed use.

Report security issues through [SECURITY.md](SECURITY.md), not a public issue.

As of 2026-09-07, the required `desktop-bootstrap` daemon command is not part of
OpenMinion `main`; that branch is not currently in the supported Desktop
combination.
