# OpenMinion Desktop API Compatibility

Status: active
Last updated: 2026-09-07

Purpose: record the supported application and daemon compatibility posture for
OpenMinion Desktop.

## Supported application boundary

OpenMinion Desktop is an application, not a reusable JavaScript library. It has
no supported npm import surface.

Its supported user-facing boundary is the local application behavior described
in [README.md](README.md), [SUPPORT.md](SUPPORT.md), and `docs/`.

## Desktop-daemon protocol

The compatibility boundary is the versioned local contract between the desktop
main process and `openminion daemon desktop-bootstrap`. The daemon remains the
owner of sessions, messages, approvals, policy, artifacts, and agent execution.
The desktop owns presentation, local attachment grants, capture lifecycle, and
operating-system integration.

Protocol fields use explicit schemas and reject unsupported or malformed
payloads at the owning process boundary. A compatible OpenMinion daemon
revision is required; Desktop does not provide a fallback agent runtime.

## Current integration status

As of 2026-09-07, OpenMinion `main` does not expose
`openminion daemon desktop-bootstrap`. The current Desktop integration therefore
requires a matching desktop-capable development revision. Do not present an
ordinary OpenMinion `main` checkout as Desktop-compatible until that daemon
contract and its validation land there.

## Internal application surfaces

The preload API and the TypeScript modules under `src/` are internal application
surfaces. Changes to them must remain coupled to focused tests, but they are not
promised as third-party APIs.

## Compatibility posture

Current project stage: development alpha.

Compatibility expectations for the documented boundary are:

1. prefer additive protocol and user-facing changes,
2. call out removals or incompatible changes in [CHANGELOG.md](CHANGELOG.md),
3. keep Desktop and OpenMinion protocol changes validated together, and
4. run the real-daemon integration test against the intended OpenMinion
   revision before making a compatibility or release claim.
