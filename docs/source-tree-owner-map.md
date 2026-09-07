# Source tree owner map

| Path | Owner |
| --- | --- |
| `src/main/` | Electron lifecycle, daemon supervision, privileged OS access, media, files, security, and protocol routing |
| `src/preload/` | Narrow typed bridge from the sandboxed renderer to Electron main |
| `src/renderer/` | Chat workspace, presentation, interaction state, and capture controls |
| `src/shared/` | Contracts used on more than one desktop process boundary |
| `tests/` | Focused contract, lifecycle, integration, and negative-path proof |
| `scripts/` | Repository policy commands used by hooks and CI |
| `.githooks/` | Local pre-commit and commit-message entrypoints |
| `.github/` | Hosted checks and dependency update policy |

The OpenMinion daemon remains outside this repository and owns agent runtime,
sessions, credentials, policy decisions, and durable execution truth. Do not
create a second copy of those owners in the desktop application.
