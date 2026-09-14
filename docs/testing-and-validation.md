# OpenMinion Desktop Testing And Validation

Status: active
Last updated: 2026-09-13

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

## Desktop Storage

After building, run the native migration and restart check:

```bash
node tests/electron/storage.mjs
```

It seeds legacy Electron browser storage in an isolated home, launches the real
bootstrap, and checks SQLite import, saved names after an app restart, reset
without stale-name resurrection, and reuse of existing runtime paths. It needs
no provider credentials. The normal Vitest gate covers atomic rollback, invalid
bridge input, future schemas and corrupt-file preservation.

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
env -u OPENMINION_EXECUTABLE -u OPENMINION_PYPI_EXECUTABLE \
  node tests/electron/managed-install.mjs
OPENMINION_PYPI_EXECUTABLE=/path/to/openminion npm test -- tests/main/cli-client.test.ts
npm run build
OPENMINION_PYPI_EXECUTABLE=/path/to/openminion npx electron tests/electron/pypi.mjs
OPENMINION_PYPI_EXECUTABLE=/path/to/openminion npx electron tests/electron/onboarding.mjs
```

The managed-install check uses no executable override: Desktop creates its
private Python environment, installs the exact pin, starts the ordinary daemon,
quits through the normal application lifecycle, verifies the daemon stopped,
then relaunches the same root to prove the installed runtime is reused. The
other opt-in tests use an isolated package executable and all
checks create private temporary config/data roots. The CLI/API test
uses echo and proves canonical history, a same-session follow-up after daemon
restart, and session closing.

The Electron test drives production main, preload, and renderer and covers:

- separate modal daemon status/logs with CLI readback, Refresh/Copy, Close/Escape, compact sidebar buttons, bounded output scrolling and unchanged chat/draft at three window sizes;
- first send from an empty workspace, whitespace rejection, real keyboard input, and immediate composer clearing while the daemon works;
- help and unsupported slash commands without creating a model turn;
- active turn status and elapsed time directly below the request, with the composer stationary and completed progress hidden;
- command results inside the conversation scroll area at narrow and wide sizes, with long results scrolling with messages and leaving the composer in place;
- command names and aliases checked against the installed Focus catalog, with every canonical command tracked in the parity contract;
- agent/tool reports, canonical CLI token output, and native Markdown export/cancel without model turns;
- schedule creation through the GUI with canonical CLI readback, plus task creation through the public CLI, Desktop task inventory, pause,
  resume and cancellation, and independent CLI verification of durable state;
- safe Markdown/code/table rendering, explicit HTTP(S) link opening, and stable message DOM/text selection;
- `/close` with independent CLI confirmation;
- two conversations, task-local unsent drafts, and visible clearing without deleting history;
- populated layout at 760 × 560, 1180 × 800, and 1800 × 1000, preserving the reading position while drafting and returning to the bottom with Jump to latest;
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
PyPI 0.0.19 can acknowledge cancellation and still complete an in-flight provider
request. The GUI test checks the recorded cancellation request and presents the
daemon's terminal outcome; it does not certify interruption of provider work.
These checks do not contact a paid provider, record the user's screen, or certify
approval/media delivery, full Focus command parity, or active-turn reattachment
across an application quit.

## Opt-in Live Provider

Only run this after the user authorizes provider calls with the selected profile:

```bash
OPENMINION_PYPI_EXECUTABLE=/path/to/openminion \
  OPENMINION_E2E_PROFILE=/path/to/authorized-profile.json \
  OPENMINION_E2E_ARTIFACTS=/path/to/scratch/screenshots \
  npx electron tests/electron/live-profile.mjs
```

This launches production Electron in a disposable home, imports the selected
profile through Settings, sends two ordinary model requests, reloads the renderer
between them, checks conversation recall and independently verifies the CLI
transcript and agent. The source profile is read but not changed. The native
file chooser result is supplied by the harness; all Settings and chat handlers
are real. No paid-provider endpoint is replaced by a fixture. Two short calls
can incur provider charges. Keys are never printed or included in screenshots.
The temporary configuration and daemon are removed on exit. This test proves
chat continuity for the selected profile, not tool execution or full parity.

## Workspace Regression Checks

Run the actual sandboxed application startup check on macOS:

```bash
npm run electron-check
```

This launches built Electron main, both CommonJS preload bundles, and the
renderer through the real local protocol. It checks bridge availability,
sandbox settings, disconnected draft entry, popovers, and fluid composer
widths. It also checks that slash suggestions stay inside the composer without
covering conversation messages or text input at all three window sizes, and
that the labeled chat actions do not overlap the title. It deliberately uses a missing daemon executable and never requests
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

The published-runtime GUI harness also compares a completed reply's duration
and token footer to its public CLI transcript, reloads the renderer, and checks
that the same footer is restored. Main-process tests cover both the current
`stats` export and PyPI 0.0.19's `metadata.run_stats_json` representation.


## Message Action UI Check

```bash
npm run build
node_modules/.bin/electron tests/electron/message-actions.mjs
```

This runs the real renderer with explicit preview data. It checks the copy icon,
local message time, hover and keyboard focus, stable layout at compact and normal
sizes, and clipboard-error feedback. Preview deliberately denies clipboard
access; successful copy and message-body selection are covered by renderer tests
and the real-daemon PyPI campaign. It makes no provider calls.
