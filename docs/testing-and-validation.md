# OpenMinion Desktop Testing And Validation

Status: active
Last updated: 2026-10-17

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

## Native Package Smoke

```bash
npm run make
```

This produces and inspects the current host's unsigned development artifacts:
DMG and ZIP on macOS, ZIP on Windows, and DEB and ZIP on Linux. Native packaging
automation uses the same command. It does not prove signing, notarization,
installation, updating, rollback, runtime certification, or release readiness.

The manual `CI` workflow accepts `packages: true` to run `npm run make` on
native macOS, Windows, and Linux runners when dispatched on the official
repository’s `main` branch. Other refs run quality checks only. It stages the outputs in a private
draft release for verification or transfer. That draft is not a public release
and should be deleted after its outputs are handled.

The command rejects an application archive containing repository-only files,
development dependencies, local `.openminion` state, source, or tests. It also
fails when a platform's expected artifact formats are missing.

## Desktop Storage

Runtime contract, verified source/paired-binary staging and launch-intent checks:

```bash
npm test -- tests/main/runtime-manifest.test.ts tests/main/runtime-installation.test.ts tests/main/backend-supervisor.test.ts tests/main/desktop-store.test.ts
```

The binary fixtures reject untrusted redirects and roll back the whole pair if
either executable fails verification. These fixtures are not public-feed or
native update certification. Run the real
managed PyPI first-install/reuse/owned-quit check separately after building:

```bash
node tests/electron/managed-install.mjs
node tests/electron/runtime-update.mjs
```

The supervisor suite also advances a test clock through the 24-hour check
interval: startup checks once, duplicate scheduling does not duplicate checks,
a newly offered version appears without installation/restart, and shutdown
removes the interval. That is deterministic scheduling proof, not a live
24-hour public-release observation. Standalone CLI update notices use PyPI;
Desktop's managed runtime checks use the GitHub manifest. Neither installs an
update automatically.

The private update harness uses main-only test fixtures and isolated roots to
stage its target beside the current managed installer pin, keep the old daemon usable, activate on
the next startup, retain an echo conversation and refuse interrupted-intent
restart. Its fixture bounds are not published compatibility certification;
it does not qualify a public feed or a packaged application. The default target
is the historical 0.0.20 fixture, not a current upgrade candidate. For a newer
release rehearsal, supply the exact authorized version through one of the
index flags below.

The optional `--testpypi-final` mode rehearses an exact final TestPyPI wheel
against the managed installer pin in isolated roots, resolving ordinary pip
dependencies from production PyPI. It uses a fixed TestPyPI metadata origin
and checks its wheel host; it never routes a TestPyPI record through the public
reader or publishes compatibility bounds. All seven private lifecycle phases
still run. Pass `--testpypi-final VERSION` with the exact final version under test;
public upgrade acceptance must later use the official production record and
exact shipped Desktop revision.

Use `--pypi-final VERSION` only after the target production version exists to replay
the same private phases against its official wheel. The two index flags are
mutually exclusive. Set `TMPDIR` to an absolute test scratch directory you own
so isolated native state and retained failure evidence remain there.

The seven phases are stage, hold, activate, reuse, controls, intent and recovery.
The hold phase reopens the old runtime with a prepared update paused and sends
a new reply in the retained chat before explicitly resuming. Controls pin the
verified active artifact, reject a changed digest, pause/discard a prepared
reference, resume without removing the pin, and send another same-chat reply.
Unit/bridge/renderer checks separately cover exact public-version selection,
unavailable/withdrawn targets, cancellation, startup pin/hold enforcement,
schema-two migration, untrusted IPC and launch-intent refusal. Private native
bounds are still not public packaged-app compatibility certification.

Python 3.11 is required. Windows uses `py -3.11` and `Scripts` executables;
POSIX uses `python3.11` and `bin`. Native Windows/Linux and real published-feed
update acceptance remain separate pending gates.

### Packaged Public Runtime Acceptance

Build the application first. Supply its actual executable and shipped Desktop
version, not the Electron runner version:

```bash
node tests/electron/packaged-runtime.mjs /absolute/path/to/packaged/OpenMinion 0.0.1
```

Use the native `.app/Contents/MacOS/OpenMinion` executable on macOS or packaged
`OpenMinion.exe` on Windows. Replace the example versions with the exact package
under acceptance. To test an update, append the exact target runtime version
as the third argument. It must be a newer, explicitly compatible public-feed
offer. Set `TMPDIR` to an absolute test scratch directory before running.
The harness launches an unmodified package, records its version and ASAR digest,
uses an isolated Desktop home, and removes executable overrides. It drives the
real UI through Electron's [main-process inspector](https://www.electronjs.org/docs/latest/tutorial/debugging-main-process),
enabled explicitly on loopback for this test only; do not weaken release fuses
to enable the test. Tests are excluded from the application archive.

Without a target, it requires successful startup/manual public checks with no
eligible offer, an echo reply and independent CLI transcript/owned-quit readback.
That is a no-update check, not upgrade certification. With a target, it requires
actual public discovery, UI Prepare update, continued old-runtime chat, normal
quit and next-startup activation, then a reply in the same canonical session
with independent CLI export. An empty feed or null compatibility cannot pass
the target mode. No network fixture or private compatibility bounds are used.
Failures retain their isolated root. Native results qualify only the tested
platform/package; Windows/Linux, recovery controls and signing/trust remain
separate acceptance gates.

After building, run the native migration and restart check:

```bash
node tests/electron/storage.mjs
```

It seeds legacy Electron browser storage in an isolated home, launches the real
bootstrap, and checks SQLite import, saved names after an app restart, reset
without stale-name resurrection, and reuse of existing runtime paths. It types a
draft into the real composer while the runtime is unavailable, waits for SQLite
readback, verifies it after process restart, clears it, and verifies a second
restart remains empty. It needs
no provider credentials. It also verifies the Verbose tool-display preference survives
process restart. Vitest covers schema-five Quiet/Normal migration to the three-mode
preference while retaining drafts, names and runtime settings. Native tool-output
smoke checks six-line preview, verbose/details controls, exact copy and disclosure
focus/scroll retention. The normal Vitest gate covers atomic rollback, invalid
bridge input, future schemas and corrupt-file preservation.

Disconnected-response tests use a controlled HTTP stream: known trace status,
replay cursors, duplicate suppression, retained response/cancellation outcome,
replayed approvals, replay gaps and missing traces. They verify that reconnection
never resubmits a prompt. This is deterministic transport evidence; it does not
prove recovery across app restart, daemon restart or a remote network outage.

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

Run the provider-free cross-surface delegation journey with one exact
OpenMinion executable and source revision:

```bash
OPENMINION_DELEGATION_E2E_EXECUTABLE=/path/to/openminion \
  npm run electron-check:delegation
```

The harness uses shared isolated home, data, config, working-directory, agent,
and session facts. It proves CLI start -> Desktop inspect and Desktop start ->
CLI inspect, task ownership, structural tree/timeline rendering, typed errors,
privacy, help discovery, focus behavior, and narrow/wide layout. It uses the
local echo provider only; it does not qualify a paid provider or remote peer.

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

Fixed populated renderer viewport assertions use a hidden native window to
avoid operating-system work-area clamps, then restore the visible app for
interaction tests. This is
exact renderer-layout proof, not visible-wide-screen acceptance on a small host.

The native smoke checks Settings navigation and dialog focus with mouse/keyboard
input at 760 × 560, 1180 × 800, and 1600 × 1000. It exercises the display-select
change handler through real preload/SQLite and reload, without a fake preference
store; this does not certify operating-system select-popup input. Runtime and
Chat display remain accessible when profiles cannot load. The renderer tests
cover failed preference saves and approval visibility in Quiet mode.

The onboarding test separately covers automatic first-launch setup, dismissing
setup without writing a profile, and required-key validation. It independently
runs the public CLI setup against a copy of the initial config, compares MiniMax
defaults and the saved model profiles with Desktop, then checks the first
configured chat, missing-key startup guidance, and subsequent model/key edits.
It also checks that changing Settings sections preserves unsaved profile values
and that closing Settings clears entered keys. Additional-profile coverage creates
a second agent through Settings, rejects duplicate IDs, retains the first agent's
credentials/history, and uses the new credential for new conversations.
It verifies that checked setup makes exactly one provider request and reports a
verified connection, stored config permissions remain private, and the first
chat makes its own request with the entered model and credential. It also creates a conversation with the ordinary CLI and
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

Run the request-bound approval proof against an OpenMinion source checkout:

```bash
PYTHONPATH=/path/to/openminion/src \
OPENMINION_APPROVAL_E2E_EXECUTABLE=/path/to/openminion \
npm run electron-check:approval
```

This starts an isolated daemon and controlled local provider, waits for the
approval card in built Electron, selects **Allow once**, verifies the exact
`file.write` result reaches the provider, and removes the temporary runtime on
success. It uses no paid provider or user profile.

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

This runs the real renderer with explicit preview data. It checks code-block
language headers, keyboard access and Copy feedback, plus the message copy icon,
local message time, hover and keyboard focus, stable layout at compact and normal
sizes, and clipboard-error feedback. Preview deliberately denies clipboard
access; successful copy and message-body selection are covered by renderer tests
and the real-daemon PyPI campaign. It makes no provider calls.

## Source-runtime command integration

Run `OPENMINION_EXECUTABLE=/absolute/path/to/openminion npm run electron-check:commands`
against the Core runtime being qualified. The native check creates an isolated
Desktop home, uses demo setup, and drives production renderer/preload/main with
real custom discovery/render/submission, expansion refusal, exposure
activate/status/deactivate, and scoped delegation list. It verifies exact prompt
text and that commands do not create extra assistant turns. Failed homes remain
for inspection; success removes them after stopping the owned daemon.

This is provider-free source integration evidence, not provider-live, delegation
inspection, published-wheel, installer, signing or complete Focus acceptance.
The managed runtime pin is not changed by this check.
