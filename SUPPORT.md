# Support

## What is supported today

Current development support is limited to:

1. the local macOS source-development client described in [README.md](README.md),
   [API_COMPATIBILITY.md](API_COMPATIBILITY.md), and `docs/`,
2. managed lifecycle with a pinned PyPI bootstrap and compatible manifest-based
   updates, as described in [Runtime Updates](docs/getting-started.md#runtime-updates),
3. Node.js 24, npm 11, and Python 3.11 development environments,
4. provider-free quality checks on Linux and macOS, and
5. unsigned macOS, Windows, and Linux package construction, with macOS native
   and daemon acceptance checked separately.

## Not covered by the current support promise

The following surfaces are not supported yet:

1. signed or notarized distribution,
2. Desktop self-updates, general data rollback, or uninstall guarantees,
3. remote daemon attachment or hosted synchronization,
4. certified Windows or Linux desktop runtime behavior,
5. unrestricted native input control, and
6. provider behavior, outages, pricing, or model-quality guarantees.

## Getting help

For a non-security bug, use the repository
[issue tracker](https://github.com/openminion/desktop/issues) and include:

1. the Desktop version and release tag, or source commit,
2. the installed runtime version and daemon version when reported,
3. operating-system version and architecture,
4. Node.js and npm versions for source development only,
5. reproduction steps, and
6. whether the failure occurred in development, an unsigned package, native
   capture, daemon integration, or provider-backed use.

Report security issues through [SECURITY.md](SECURITY.md), not a public issue.

## Find versions for a report

Open **Settings → Runtime → Technical details** for **Installed runtime**,
**Daemon version**, **Protocol**, and **Electron**. If a field says **Not reported**
or **Not detected**, report that rather than guessing. Electron is the shell
version, not the Desktop application version.

For a downloaded app, include its release tag and original package filename;
these identify the Desktop build even when the app cannot start. Its
`desktop-release.json` records the source revision. For source development,
include `git rev-parse HEAD` and the version in `package.json`.
Do not substitute an unrelated system-wide CLI version for Desktop's managed runtime.

## Choose a development download

The [current development release](https://github.com/openminion/runtime/releases/tag/desktop-dev-v0.0.1-build.4)
contains these packages. Its matching
[Desktop source release](https://github.com/openminion/desktop/releases/tag/v0.0.1)
records the immutable source tag and package metadata. Include both release
identifiers in a report. Choose by operating system and processor, not just by
the `0.0.1` application version; the runtime release tag identifies the
particular package build.

| Computer | Package | Current acceptance |
| --- | --- | --- |
| Mac with Apple Silicon | `OpenMinion-0.0.1-arm64.dmg` | Unsigned, not notarized; macOS development acceptance only |
| Windows with an x64 processor | `OpenMinion-win32-x64-0.0.1.zip` | Development package; runtime certification pending |
| Debian-based Linux on x64 | `openminion-desktop_0.0.1_amd64.deb` | Development package; runtime certification pending |
| Linux on x64, ZIP distribution | `OpenMinion-linux-x64-0.0.1.zip` | Development package; runtime certification pending |

An Apple Silicon ZIP (`OpenMinion-darwin-arm64-0.0.1.zip`) is also available.
This release has no Intel Mac, Windows ARM, or Linux ARM package. Building from
source does not establish support for those platforms.

Verify the download below before opening it. On macOS, open the DMG and copy
**OpenMinion.app** into **Applications**, then open that copy. For a ZIP, extract
the entire archive before launching the app; keep its accompanying files
together. Install a DEB with your distribution's package installer. An operating
system may block these unsigned builds; they are not a signed stable installer.
Follow [First Launch](README.md#first-launch) once the application opens.

## Verify a development download

Download the package for your platform and `SHA256SUMS` from the same official
[Desktop release](README.md#install). Compute the package's SHA-256 digest:

```bash
# macOS; replace the example with the exact downloaded filename
shasum -a 256 OpenMinion-0.0.1-arm64.dmg
```

On Linux, use `sha256sum` with the downloaded filename. On Windows PowerShell:

```powershell
Get-FileHash .\OpenMinion-win32-x64-0.0.1.zip -Algorithm SHA256
```

Compare the full digest with the entry for that exact filename in `SHA256SUMS`.
A mismatch means the download must not be used. Checksums verify matching release
bytes; they do not make an unsigned package signed or certify its platform.
You do not need to install Node.js or npm to use a packaged app. The current
managed runtime installation still requires Python 3.11 and network access.

## Troubleshooting

- **First launch is still installing:** verify Python 3.11 and network access.
  Open **Settings → Runtime** for status; use **Daemon status** and **View logs**
  for the installed runtime’s diagnostics.
- **A provider or search tool rejects a key:** open **Settings → Models & credentials**.
  Model keys and search-tool keys are separate. A saved key is not proof of
  authentication or quota; see [Agent Profiles and Keys](docs/getting-started.md#agent-profiles-and-keys).
- **A response disconnects:** use **Reconnect response** when offered. This
  attaches the known response without resending your message. Restart discovery
  remains unsupported; see [Workspace Basics](docs/getting-started.md#workspace-basics).
- **Identity is empty or unavailable:** open **Settings → Identity** and use
  **Try again**. If an upgrade is required, use the offered **Runtime settings**
  shortcut. See [Identity settings](docs/getting-started.md#edit-an-agents-identity)
  for draft verification and the existing CLI setup boundary.
- **A fresh install uses 0.0.29:** this is the current bootstrap pin. First
  installation does not select the latest runtime from the manifest. Use
  **Settings → Runtime → Check updates** to look for a compatible update.
- **No runtime update is offered:** only explicitly compatible records qualify.
  An empty feed is not permission to install an arbitrary runtime. See
  [Runtime Updates](docs/getting-started.md#runtime-updates).

Review diagnostic output before sharing it; omit keys, tokens, private prompts,
and personal paths. Use [Desktop Data](docs/getting-started.md#desktop-data) for
backup and migration behavior. The [readiness matrix](docs/certification-readiness-matrix.md)
separates tested chat/approval behavior from remaining integration and release gates.
