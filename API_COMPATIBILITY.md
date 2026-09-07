# OpenMinion Desktop API Compatibility

Status: alpha

OpenMinion Desktop is an application, not a reusable JavaScript library. It has
no supported npm import surface.

The compatibility boundary is the versioned local contract between the desktop
main process and `openminion daemon desktop-bootstrap`. The daemon remains the
owner of sessions, messages, approvals, policy, artifacts, and agent execution.
The desktop owns presentation, local attachment grants, capture lifecycle, and
operating-system integration.

The preload API and the TypeScript modules under `src/` are internal application
surfaces. Changes to them must remain coupled to focused tests, but they are not
promised as third-party APIs. Contract removals or incompatible daemon protocol
changes must be called out in [CHANGELOG.md](CHANGELOG.md) and validated with the
real-daemon integration test before release.
