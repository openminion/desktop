# OpenMinion Desktop Package Docs

Status: development alpha

Purpose: provide the package-local documentation root for the standalone
OpenMinion Desktop repository.

## Start Here

| If you want to... | Read |
| --- | --- |
| Set up and start the source-development app | [Getting Started](getting-started.md) |
| Understand repository and process ownership | [Source Tree Owner Map](source-tree-owner-map.md) |
| Follow implementation and simplicity rules | [Engineering Patterns](engineering-patterns.md) |
| Understand local hooks and hosted checks | [Code Quality Enforcement](code-quality-enforcement.md) |
| Run provider-free, package, native, or daemon proof | [Testing And Validation](testing-and-validation.md) |
| Check which product claims are currently supported | [Certification Readiness Matrix](certification-readiness-matrix.md) |

## Application Boundaries

- The root [README](../README.md) is the product and development overview.
- [API Compatibility](../API_COMPATIBILITY.md) defines the Desktop and
  OpenMinion protocol posture.
- [Security Policy](../SECURITY.md) defines private reporting and process
  boundaries.
- [Support](../SUPPORT.md) defines the current development support promise.
- [Releasing](../RELEASING.md) defines the proof required before distribution
  can be enabled.

## Public Package Stance

This documentation describes source-development and unsigned local packaging.
It does not claim a signed release, remote daemon service, Windows or Linux
desktop package, unrestricted native input, or a second agent runtime.

As of 2026-09-07, the required Desktop bootstrap contract has not landed on
OpenMinion `main`; use only the explicitly matched development revision.

Historical planning packets and workspace-local trackers are not public
product guidance. Current behavior is defined by this repository, its public
docs, and the compatible OpenMinion daemon contract.
