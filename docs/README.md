# OpenMinion Desktop Package Docs

Status: development alpha

Purpose: provide the package-local documentation root for the standalone
OpenMinion Desktop repository.

## Start Here

| If you want to... | Read |
| --- | --- |
| Set up and start the source-development app | [Getting Started](getting-started.md) |
| Use screenshots and understand the screen-context direction | [Screen Context](screen-context.md) |
| Understand repository and process ownership | [Source Tree Owner Map](source-tree-owner-map.md) |
| Follow implementation and simplicity rules | [Engineering Patterns](engineering-patterns.md) |
| Understand local hooks and hosted checks | [Code Quality Enforcement](code-quality-enforcement.md) |
| Run provider-free, package, native, or daemon proof | [Testing And Validation](testing-and-validation.md) |
| Check CLI/Focus coverage and remaining GUI workflows | [Focus Parity Contract](focus-parity.md) |
| Use the currently connected slash commands | [Desktop Commands](commands.md) |
| Review the composer polish and its acceptance evidence | [Composer Refinement](composer-refinement.md) |
| Prepare the private repository for public contributions | [Public Source Readiness](public-readiness.md) |
| Check which product claims are currently supported | [Certification Readiness Matrix](certification-readiness-matrix.md) |

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
