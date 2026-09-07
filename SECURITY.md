# Security Policy

## Reporting a vulnerability

Do not open a public issue containing exploit details. Use a
[private GitHub security advisory](https://github.com/openminion/desktop/security/advisories/new).
If that channel is unavailable, request a private handoff without including the
exploit.

Include the affected Desktop and OpenMinion revisions, reproduction steps,
expected impact, and whether the issue crosses the renderer, preload, Electron
main, native capture, attachment, packaging, or daemon boundary.

## Scope

OpenMinion Desktop follows these rules:

1. report vulnerabilities privately first,
2. do not publish proof-of-exploit details before maintainers can assess and
   respond,
3. identify the affected process and permission boundary, and
4. distinguish package-owned behavior from operating-system, daemon,
   provider, or deployment-specific behavior.

## Application boundary

The OpenMinion daemon owns agent execution, sessions, policy, credentials, and
durable state. Electron main owns operating-system access and authenticated
daemon communication. Preload exposes a narrow fixed-purpose bridge. The
renderer is untrusted and sandboxed.

Captured media, attachment bytes, daemon credentials, native paths, raw tool
arguments, and tool results must not be exposed to the renderer unless a
reviewed contract explicitly requires and bounds that data.

## Dependency and integration note

Call out whether an issue depends on a specific OpenMinion revision, Electron
version, macOS permission, provider, or host configuration. That distinction
helps identify whether the issue belongs to Desktop, OpenMinion, the operating
system, or an external integration.
