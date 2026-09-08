# OpenMinion Desktop API Compatibility

Status: active
Last updated: 2026-09-08

Purpose: record the supported application and daemon compatibility posture for
OpenMinion Desktop.

## Supported application boundary

OpenMinion Desktop is an application, not a reusable JavaScript library. It has
no supported npm import surface.

Its supported user-facing boundary is the local application behavior described
in [README.md](README.md), [SUPPORT.md](SUPPORT.md), and `docs/`.

## Desktop-daemon boundary

The Desktop main process owns installation and lifecycle. It currently installs
the pinned `openminion==0.0.18` PyPI package into app-managed storage and calls
the ordinary `config init` and `daemon start/status/stop` commands. OpenMinion
remains the owner of sessions, messages, approvals, policy, artifacts, and agent
execution. Desktop owns presentation, local attachment grants, capture
lifecycle, and operating-system integration.

Desktop does not require or add a Desktop-specific command, bootstrap endpoint,
or lease protocol in OpenMinion. The main process keeps the managed executable,
runtime roots, and configuration path outside the renderer boundary.

## Current integration status

Lifecycle integration works with the public PyPI `0.0.18` command surface and
has real-daemon start/status/stop proof. Rich chat, session, approval, media, and
artifact transport is not connected in this lifecycle slice. It must be adapted
to existing public OpenMinion interfaces without restoring Desktop-only code in
the OpenMinion package.

## Internal application surfaces

The preload API and the TypeScript modules under `src/` are internal application
surfaces. Changes to them must remain coupled to focused tests, but they are not
promised as third-party APIs.

## Compatibility posture

Current project stage: development alpha.

Compatibility expectations for the documented boundary are:

1. prefer additive protocol and user-facing changes,
2. call out removals or incompatible changes in [CHANGELOG.md](CHANGELOG.md),
3. test Desktop lifecycle changes against the pinned public package,
4. validate later transport work against the existing public interface it uses,
   and
5. do not describe lifecycle proof as chat or provider-backed proof.
