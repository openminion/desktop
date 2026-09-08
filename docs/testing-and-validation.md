# OpenMinion Desktop Testing And Validation

Status: active
Last updated: 2026-09-08

Purpose: define the separate validation tiers for source quality, unsigned
packaging, native capture, and real OpenMinion daemon integration.

## Install Baseline

Desktop expects Node.js 24 and npm 11. Install the exact locked dependency set:

```bash
npm ci
```

## Normal Package Gate

```bash
npm run ci-check
```

This checks formatting, Biome lint, strict TypeScript, required public files,
documentation links, headings, lifecycle metadata and commands, the
provider-free Vitest suite, and the production build.

Run local hook parity separately:

```bash
npm run hooks:run
```

Hosted CI also runs actionlint against `.github/workflows/`.

## macOS Package Smoke

```bash
npm run package
```

This produces an unsigned development application. It does not prove signing,
notarization, installation, updating, rollback, or release readiness.

The command rejects an application archive containing repository-only files,
development dependencies, local `.openminion` state, source, or tests.

## Native Capture

Run from a macOS session with Screen Recording permission:

```bash
OPENMINION_ODC_NATIVE_CAPTURE=1 npm test -- tests/main/capture-native.test.ts
```

## Real Daemon Lifecycle

```bash
OPENMINION_EXECUTABLE=/path/to/openminion \
  npm test -- tests/main/backend-supervisor.test.ts
```

This test creates an isolated config and data root, initializes the config
through the ordinary CLI, starts the daemon, probes its machine-readable status,
and stops it. Use the pinned PyPI release or a source executable with the same
public lifecycle commands. This is lifecycle proof, not rich chat/session proof.

## Workspace Regression Checks

Run the actual sandboxed application startup check on macOS:

```bash
npm run electron-check
```

This launches built Electron main, both CommonJS preload bundles, and the
renderer through the real local protocol. It checks bridge availability,
sandbox settings, disconnected draft entry, popovers, and fluid composer
widths. It deliberately uses a missing daemon executable and never requests
native capture. Hosted macOS CI runs this in addition to the normal package
gate; importing TypeScript under a mocked Electron module cannot prove that
Electron can load the distributed preloads.

Use `npm run preview` for interactive component acceptance with explicit
sample data. The fixture exercises the same renderer, including task actions,
approvals and cancellation, attachments and file grants, output viewing and
detach/restore, screenshot selection and regions, pause/resume, guidance, and
watch controls. It does not certify the corresponding native/daemon behavior.

Test the built renderer in Electron at the minimum 760 × 560 window, the normal
1180 × 800 window, and a large 1600 × 1000 window. Exercise:

- empty tasks and conversations, a populated sidebar, and long task titles;
- long messages, long drafts, and bounded attachment chips;
- screenshot selection, local preview, explicit inclusion, and pause/resume;
- Context and Screenshot popovers, Escape/outside dismissal, and reachable
  close controls while scrolling;
- approval decisions, active turns, cancellation, denied capture permission,
daemon-running-without-chat-transport, connection failure, and recovery;
- Command/Ctrl+Enter, visible keyboard focus, and reduced motion;
- composer width growth as the window widens, and editable disconnected drafts.

Use synthetic data for layout screenshots. A fixture bridge verifies renderer
behavior without capturing the user's desktop or contacting a model provider.
Provider-backed frame delivery and guidance require a future transport-specific
acceptance tier; they are not implied by daemon lifecycle proof.

## Proof Boundary

Provider-free tests, unsigned packaging, native capture, real-daemon
integration, provider-backed behavior, and signed release acceptance are
different proof tiers. Do not present one tier as evidence for another.
