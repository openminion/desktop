# OpenMinion Desktop Package Docs

Status: development alpha

Purpose: provide the package-local documentation root for the standalone
OpenMinion Desktop repository.

## Use Desktop

| If you want to... | Read |
| --- | --- |
| Download a development build or run from source | [Root README](../README.md#install) |
| Complete first launch and choose a provider | [Getting Started](getting-started.md#first-run) |
| Manage profiles, model keys, and search-tool keys | [Agent Profiles and Keys](getting-started.md#agent-profiles-and-keys) |
| Inspect, verify, or edit an agent’s identity | [Identity settings](getting-started.md#edit-an-agents-identity) |
| Find, name, or resume a conversation | [Workspace Basics](getting-started.md#workspace-basics) and [Name a chat](getting-started.md#name-a-chat) |
| Queue a follow-up while a reply is running | [Queue a Follow-up](getting-started.md#queue-a-follow-up) |
| Use connected slash commands | [Desktop Commands](commands.md) |
| Understand saved credentials and external connections | [Privacy and Connections](getting-started.md#privacy-and-connections) |
| Export a saved conversation | [Export a conversation](getting-started.md#export-a-conversation) |
| Back up names, drafts, profiles, and conversation data | [Desktop Data](getting-started.md#desktop-data) |
| Inspect daemon status and logs | [Daemon Status And Logs](getting-started.md#daemon-status-and-logs) |
| Recover a disconnected response | [Recover A Response](getting-started.md#recover-a-response) |
| Preview a screen/window and understand capture limits | [Screen Context](screen-context.md) |

## Contribute

Start with [Contributing](../CONTRIBUTING.md). Ordinary changes target `dev`;
release promotion to `main` is a separate process.

| If you want to... | Read |
| --- | --- |
| Find the owner for a change | [Source Tree Owner Map](source-tree-owner-map.md) |
| Follow implementation and simplicity rules | [Engineering Patterns](engineering-patterns.md) |
| Understand local hooks and hosted checks | [Code Quality Enforcement](code-quality-enforcement.md) |
| Run source, package, native, or daemon checks | [Testing And Validation](testing-and-validation.md) |
| Compare implemented GUI behavior with Focus/CLI | [Focus Parity Contract](focus-parity.md) |
| Review composer behavior and acceptance evidence | [Composer Refinement](composer-refinement.md) |

## Maintain And Release

- [Releasing](../RELEASING.md): versioning, unsigned packages, and stable-release gates
- [Certification Readiness Matrix](certification-readiness-matrix.md): proof by surface
- [Public Source Readiness](public-readiness.md): private-to-public launch decisions
- [Changelog](../CHANGELOG.md): versioned changes

## Application Boundaries

- The root [README](../README.md) is the product and development overview.
- [API Compatibility](../API_COMPATIBILITY.md) defines the Desktop and
  OpenMinion protocol posture.
- [Security Policy](../SECURITY.md) defines private reporting and process
  boundaries.
- [Support](../SUPPORT.md) defines the current development support promise.
- [Releasing](../RELEASING.md) defines unsigned development distribution and the
  additional proof required for stable releases.

## Public Package Stance

This documentation describes source development and unsigned development
packages for macOS, Windows, and Linux. It does not claim a signed stable release,
certified Windows/Linux runtime behavior, remote daemon service, unrestricted
native input, or a second agent runtime.

Desktop lifecycle uses the pinned public PyPI package and ordinary OpenMinion
commands. Text chat and completed session history use the public CLI/API.
Request-bound allow-once and deny approvals use the authenticated local API
with a compatible OpenMinion runtime. See the
[readiness matrix](certification-readiness-matrix.md) for managed-runtime proof.
Media, artifacts, and full Focus parity remain incomplete; all further
integration must use existing public interfaces.

Historical planning packets and workspace-local trackers are not public
product guidance. Current behavior is defined by this repository, its public
docs, and the pinned OpenMinion public command surface.
