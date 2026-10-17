# Support

## What is supported today

Current development support is limited to:

1. the local macOS source-development client described in [README.md](README.md),
   [API_COMPATIBILITY.md](API_COMPATIBILITY.md), and `docs/`,
2. managed lifecycle for the pinned public OpenMinion PyPI package,
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

1. the Desktop revision,
2. the OpenMinion revision,
3. operating-system version and architecture,
4. Node.js and npm versions,
5. reproduction steps, and
6. whether the failure occurred in development, an unsigned package, native
   capture, daemon integration, or provider-backed use.

Report security issues through [SECURITY.md](SECURITY.md), not a public issue.

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
- **No runtime update is offered:** only explicitly compatible records qualify.
  An empty feed is not permission to install an arbitrary runtime. See
  [Runtime Updates](docs/getting-started.md#runtime-updates).

Review diagnostic output before sharing it; omit keys, tokens, private prompts,
and personal paths. Use [Desktop Data](docs/getting-started.md#desktop-data) for
backup and migration behavior. The [readiness matrix](docs/certification-readiness-matrix.md)
separates tested chat/approval behavior from remaining integration and release gates.
