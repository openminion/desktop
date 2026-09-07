# Security policy

## Reporting a vulnerability

Do not open a public issue containing exploit details. Contact the OpenMinion
maintainers through a
[private GitHub security advisory](https://github.com/openminion/desktop/security/advisories/new).
If that channel is unavailable, request a private handoff without including the
exploit.

Include the affected revision, reproduction steps, expected impact, and whether the
issue crosses the renderer, preload, Electron main, native capture, attachment, or
OpenMinion daemon boundary.

## Security boundary

The OpenMinion daemon owns agent execution, sessions, policy, and credentials.
Electron main owns operating-system access and validated daemon communication. The
renderer is untrusted and must remain sandboxed behind the narrow preload contract.

Captured media, attachment bytes, daemon credentials, raw tool arguments, and tool
results must not be exposed to the renderer unless a reviewed contract explicitly
requires and bounds that data.
