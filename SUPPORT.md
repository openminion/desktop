# Support

## Supported today

The current development baseline covers the local macOS desktop client running
against a compatible local OpenMinion daemon. The repository supports Node.js
24, npm 11, provider-free checks, unsigned package construction, and explicit
opt-in native and daemon integration tests.

## Not yet supported

Signed distribution, notarization, automatic updates, remote daemon attachment,
Windows and Linux certification, and unrestricted native input are not part of
the current support promise.

When reporting a problem, include the desktop revision, macOS and architecture,
Node and npm versions, OpenMinion revision, reproduction steps, and whether the
failure occurred in development, an unsigned package, native capture, or daemon
integration. Report security issues through [SECURITY.md](SECURITY.md).
Non-security bugs can be reported through the repository's
[issue tracker](https://github.com/openminion/desktop/issues).
