# OpenMinion Desktop Testing And Validation

Status: active
Last updated: 2026-09-09

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

## Published Package Conversation

Use an isolated installation of the pinned PyPI package:

```bash
OPENMINION_PYPI_EXECUTABLE=/path/to/openminion npm test -- tests/main/cli-client.test.ts
npm run build
OPENMINION_PYPI_EXECUTABLE=/path/to/openminion npx electron tests/electron/pypi.mjs
OPENMINION_PYPI_EXECUTABLE=/path/to/openminion npx electron tests/electron/onboarding.mjs
```

These opt-in tests create private temporary config/data roots. The CLI/API test
uses echo and proves canonical history, a same-session follow-up after daemon
restart, and session closing.

The Electron test drives production main, preload, and renderer and covers:

- first send from an empty workspace, whitespace rejection, and real keyboard input;
- help and unsupported slash commands without creating a model turn;
- command names and aliases checked against the installed Focus catalog, with every canonical command tracked in the parity contract;
- agent/tool reports, canonical CLI token output, and native Markdown export/cancel without model turns;
- canonical task creation through the public CLI, Desktop task inventory, pause,
  resume and cancellation, and independent CLI verification of durable state;
- two conversations, task-local unsent drafts, and visible clearing without deleting history;
- populated layout at 760 × 560, 1180 × 800, and 1800 × 1000;
- daemon outage detection through connection details, reconnect with the draft intact,
  renderer reload, restored history, and closed-session send rejection;
- profile JSON import, model-key editing, private credential readback, responsive
  Settings, restart with preserved conversations, and rejection during active chat;
- cancellation requests while the real daemon is waiting on a local controlled provider,
  provider rejection, and a successful subsequent request.

The onboarding test separately covers automatic first-launch setup, dismissing
setup without writing a profile, and required-key validation. It independently
runs the public CLI setup against a copy of the initial config, compares MiniMax
defaults and the saved model profiles with Desktop, then checks the first
configured chat, missing-key startup guidance, and subsequent model/key edits.
It verifies that saving makes no provider request, stored config permissions
remain private, and the first chat uses the entered model and credential. It also creates a conversation with the ordinary CLI and
continues it in Desktop while preserving its saved channel and target. Local
chat naming covers cancel, save, reload, and reset, with unchanged canonical
session IDs, names, history, and provider request counts.

Set `OPENMINION_E2E_ARTIFACTS` to a scratch directory when running the onboarding
test to save screenshots of welcome, provider defaults, model entry, saved setup,
and the first reply. The simulation uses synthetic credentials and an isolated
runtime; it does not configure or modify the user's installed profiles. Choosing
MiniMax verifies CLI-owned setup defaults, not paid MiniMax authentication.

The provider fixture is a loopback HTTP server with a test credential, configured
only in the test's isolated runtime. It can hold or reject a request. These tests
stop their isolated daemon and remove their temporary config/data roots.
PyPI 0.0.18 can acknowledge cancellation and still complete an in-flight provider
request. The GUI test checks the recorded cancellation request and presents the
daemon's terminal outcome; it does not certify interruption of provider work.
These checks do not contact a paid provider, record the user's screen, or certify
approval/media delivery, full Focus command parity, or active-turn reattachment
across an application quit.

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
- Enter to send, Shift+Enter for a new line, visible keyboard focus, and reduced motion;
- composer width growth as the window widens, and editable disconnected drafts.

Use synthetic data for layout screenshots. A fixture bridge verifies renderer
behavior without capturing the user's desktop or contacting a model provider.
Provider-backed frame delivery and guidance require a future transport-specific
acceptance tier; they are not implied by daemon lifecycle proof.

## Proof Boundary

Provider-free tests, unsigned packaging, native capture, real-daemon
integration, provider-backed behavior, and signed release acceptance are
different proof tiers. Do not present one tier as evidence for another.
