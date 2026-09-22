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
runtime. It provides chat, session history, approvals, attachments, artifacts,
and explicitly selected screen or window context while keeping agent execution,
credentials, policy, and durable session truth in the OpenMinion daemon.

The application is a development alpha. It currently expects a matching
OpenMinion development revision that provides the desktop daemon contract. As
of 2026-09-07, that command is not present on OpenMinion `main`. Signed
distribution, automatic updates, remote daemon operation, and native input
control are not available yet.

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
| Current platform | macOS development and unsigned packaging |
| Runtime | Node.js 24, npm 11, and Electron |
| Connects to | A matching desktop-capable OpenMinion development revision; not current OpenMinion `main` |
| Best fit | Local chat, session work, approvals, artifacts, and visible context |
| Not the claim | Signed release, remote operation, or autonomous native control |

## Common Commands

```bash
npm start
npm run ci-check
npm run hooks:run
npm run package
```

`npm start` runs the source-development app. `npm run package` builds and
inspects an unsigned local macOS application; it is not a public release.

## What OpenMinion Desktop Provides

- browse, create, reopen, and close local OpenMinion sessions
- chat with streaming progress and typed terminal outcomes
- cancel active turns and recover after renderer reload or daemon reconnect
- review tool progress and make one-time approval decisions
- attach bounded images and represent unsupported files safely
- inspect artifacts and tool-output summaries without exposing native paths
- select a screen or window for explicit observation and grounded guidance

## What OpenMinion Desktop Does Not Provide

- a second agent runtime, session store, policy engine, or provider layer
- direct model-provider configuration or credential storage in the renderer
- arbitrary renderer access to Node.js, the filesystem, shell, IPC, or network
- hidden screen capture, always-on observation, or unrestricted native input
- remote daemon attachment, hosted synchronization, or multi-device control
- signed, notarized, automatically updating public releases

## Requirements

- macOS for the current runnable application profile
- Node.js 24
- npm 11
- a matching desktop-capable local OpenMinion checkout or executable
- a nonblank OpenMinion `runtime.ipc_token`

The normal checks also run on Linux in CI, but Linux and Windows desktop
packages are not currently certified.

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

If the compatible `openminion` executable is not already on `PATH`, select it
explicitly:

```bash
OPENMINION_ODF_EXECUTABLE=/path/to/openminion npm start
```

The executable must provide `openminion daemon desktop-bootstrap`. The current
OpenMinion `main` branch does not yet provide that command.

macOS may request Screen Recording permission when observation is used. Denying
that permission keeps chat available and observation unavailable.

## How It Fits

| Component | Responsibility |
| --- | --- |
| OpenMinion | Agent execution, sessions, messages, tools, policy, credentials, artifacts, and durable state |
| Desktop main process | Daemon lifecycle, authenticated local communication, file grants, capture, and operating-system access |
| Desktop preload | Small typed bridge exposing fixed application operations |
| Desktop renderer | Chat, session navigation, approvals, artifacts, and visible capture controls |

Desktop starts or attaches to the existing local daemon through
`openminion daemon desktop-bootstrap`. The daemon remains authoritative, so the
CLI and Desktop can work with the same durable sessions without duplicating
runtime state.

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
local links, portable paths, and documented npm commands. Use `npm run package`
for the unsigned macOS packaging gate.

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
