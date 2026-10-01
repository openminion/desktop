<p align="center">
  <img src="https://www.openminion.com/brand/openminion-logo-transparent-v1.png" alt="OpenMinion logo" width="128" />
</p>

<h1 align="center">OpenMinion Desktop</h1>

<p align="center">
  <strong>A local desktop workspace for OpenMinion.</strong>
</p>

<p align="center">
  <a href="https://github.com/openminion/desktop">GitHub</a>
  · <a href="https://www.openminion.com">Website</a>
  · <a href="docs/README.md">Docs</a>
  · <a href="https://x.com/OpenMinion">X</a>
</p>

<p align="center">
  <a href="https://github.com/openminion/desktop/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/openminion/desktop/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="Node.js" src="https://img.shields.io/badge/node-24-339933">
  <img alt="Status" src="https://img.shields.io/badge/status-alpha-6B7280">
</p>

OpenMinion Desktop is the local graphical client for the OpenMinion agent
runtime. It provides text chat and session history, with preview UI for approvals,
attachments, artifacts, and screen context, while keeping agent execution,
credentials, policy, and durable session truth in the OpenMinion daemon.

The application is a development alpha. On first launch it creates an isolated
Python environment in the application data directory, installs the pinned
OpenMinion release from PyPI, creates a local demo config, and starts the
ordinary OpenMinion daemon. Saved conversations use its existing public CLI; text turns and cancellation
use its authenticated local API. Signed distribution, Desktop self-updates, remote daemon operation, and
native input control are not available yet.

## Read This First

1. Read [At a Glance](#at-a-glance) for the current product boundary.
2. Follow [Requirements](#requirements) and [Quick Start](#quick-start) to run
   the development app.
3. Read [How It Fits](#how-it-fits) to understand what stays in OpenMinion.
4. Read [Security Model](#security-model) before changing a process boundary.
5. Use the [package documentation](docs/README.md) for development and
   validation details.

## Trust and Brand Safety

- Official GitHub: <https://github.com/openminion/desktop>
- Official website: <https://www.openminion.com>
- Official X account: <https://x.com/OpenMinion>

OpenMinion has no official token, coin, NFT, airdrop, staking program,
treasury product, or investment offering. Any claim otherwise is unauthorized
and should be treated as a scam.

## At a Glance

| | |
| --- | --- |
| Application | OpenMinion Desktop |
| Current line | Development alpha |
| Current runtime profile | macOS development |
| Native package targets | macOS, Windows, and Linux |
| Runtime | Node.js 24, npm 11, and Electron |
| Managed core | Pinned `openminion==0.0.27` from PyPI |
| Best fit | Local chat, saved sessions, task controls, and visible-context preview |
| Not the claim | Signed release, remote operation, or autonomous native control |

## Common Commands

```bash
npm start
npm run ci-check
npm run hooks:run
npm run package
npm run make
```

`npm start` runs the source-development app. `npm run package` builds and
inspects the native application directory. `npm run make` also creates and
inspects the native unsigned artifacts: DMG and ZIP on macOS, ZIP on Windows,
and DEB and ZIP on Linux. These are development artifacts, not public releases.

## What OpenMinion Desktop Provides

- browse, reopen, and close local OpenMinion sessions; create them with a first message
- chat with streaming progress and typed terminal outcomes
- inspect OpenMinion work with `/tasks` and pause, resume, or cancel it through core controls
- cancel active turns and recover completed history after renderer reload or daemon restart
- preview approvals, attachments, artifacts, and screen context in the UI fixture
- select a screen or window for local preview when native permission is available
- install, version-check, start, monitor, and stop an app-owned OpenMinion daemon
- check compatible runtime metadata and explicitly prepare a verified PyPI or
  paired-binary runtime for startup-only activation; public binary publication
  and compatibility certification remain pending

## What OpenMinion Desktop Does Not Provide

- a second agent runtime, session store, policy engine, or provider layer
- direct model-provider configuration or credential storage in the renderer
- arbitrary renderer access to Node.js, the filesystem, shell, IPC, or network
- hidden screen capture, always-on observation, or unrestricted native input
- remote daemon attachment, hosted synchronization, or multi-device control
- signed, notarized, automatically updating public releases
- full Focus slash-command parity, connected approvals, attachment sending, or artifact browsing
- reattachment to an active turn after quitting the application

## Requirements

- macOS for the current runnable application profile
- Node.js 24
- npm 11
- Python 3.11 for the temporary PyPI-based runtime installation path
- network access on first launch or when the pinned OpenMinion version changes

Native packaging can produce unsigned artifacts on macOS, Windows, and Linux.
Windows and Linux runtime behavior is not yet certified.

## Quick Start

Install dependencies and run the provider-free checks:

```bash
npm ci
npm run hooks:install
npm run ci-check
```

Start the development app:

```bash
npm start
```

The first launch installs `openminion==0.0.27` under `~/.openminion/desktop`,
creates a private initial config, and starts an isolated daemon. A setup screen
offers OpenMinion's provider choices, including MiniMax, model and API-key fields,
profile import, or an explicit echo demo. Setup uses the ordinary CLI setup
command and restarts the daemon with the saved profile. By default, setup sends
one provider request and reports whether the connection was verified. Clear
**Test connection before continuing** to save without making that request.
Later launches reuse the environment when its installed version matches the pin.
Desktop chat names live in SQLite; existing installations retain their recorded
runtime locations. See [Desktop data](docs/getting-started.md#desktop-data) for
storage, migration, and backup behavior.

For source development, bypass the managed PyPI installation with an explicit
executable:

```bash
OPENMINION_EXECUTABLE=/path/to/openminion npm start
```

The override must provide the ordinary `config init` and `daemon
start/status/stop` commands. Desktop does not require a Desktop-specific command
inside OpenMinion.

macOS may request Screen Recording permission when observation is used. Denying
that permission keeps chat available and observation unavailable.

## How It Fits

| Component | Responsibility |
| --- | --- |
| OpenMinion | Agent execution, sessions, messages, tools, policy, credentials, artifacts, and durable state |
| Desktop main process | Desktop metadata, daemon lifecycle, authenticated local communication, file grants, capture, and operating-system access |
| Desktop preload | Small typed bridge exposing fixed application operations |
| Desktop renderer | Chat, session navigation, task controls, and local capture preview |

Desktop manages an isolated OpenMinion installation and daemon through the
ordinary CLI lifecycle commands. The daemon remains authoritative. A main-only
command context is available for the pending transport adapter without exposing
the executable, roots, config, or credentials to the renderer.

## Security Model

The renderer is treated as untrusted. It does not receive daemon credentials,
native file paths, attachment bytes, raw IPC, shell access, or a generic
network client. Electron main owns privileged operations and exposes only
fixed-purpose typed methods through preload.

Screen or window observation begins only after an explicit source selection.
Native input execution and remote operation remain outside the current product
boundary. See [SECURITY.md](SECURITY.md) for reporting and boundary details.

## Repository Map

```text
src/main/       Electron lifecycle, daemon communication, files, and capture
src/preload/    Narrow typed renderer bridge
src/renderer/   Desktop workspace and presentation
src/shared/     Cross-process contracts
tests/          Unit, integration, lifecycle, and security proof
scripts/        Build and repository validation commands
docs/           Package documentation
```

For owner-by-owner detail, read
[docs/source-tree-owner-map.md](docs/source-tree-owner-map.md).

## Development

Before contributing, read [CONTRIBUTING.md](CONTRIBUTING.md) and
[CODE_QUALITY.md](CODE_QUALITY.md).

```bash
npm ci
npm run hooks:install
npm run ci-check
```

Use focused tests while iterating. Run `npm run ci-check` before opening a pull
request. That command also verifies the required public repository files,
local links, portable paths, and documented npm commands. Use `npm run make`
for the native unsigned packaging gate.

## Docs and Release

- [docs/README.md](docs/README.md): package documentation map
- [docs/getting-started.md](docs/getting-started.md): development setup
- [docs/testing-and-validation.md](docs/testing-and-validation.md): validation inventory
- [docs/certification-readiness-matrix.md](docs/certification-readiness-matrix.md): current proof coverage
- [API_COMPATIBILITY.md](API_COMPATIBILITY.md): supported compatibility boundary
- [RELEASING.md](RELEASING.md): deferred release requirements
- [SUPPORT.md](SUPPORT.md): current support scope

## License and Brand-use Boundary

- Source code license: Apache-2.0
- Brand/trademark grant: none

The license grants rights to use, modify, and redistribute the code. It does
not grant rights to present a fork, clone, token, website, or social account as
the official OpenMinion project or imply affiliation or endorsement. See
[LICENSE](LICENSE) and [NOTICE](NOTICE).
