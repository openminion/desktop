# Composer Refinement

Status: implemented and reviewed
Last updated: 2026-09-08

Purpose: record the bounded composer refinement and its visual and interaction
acceptance, while preserving OpenMinion's visible screenshot controls.

## Specification

The slash control should align with neighboring controls instead of appearing
as a large text glyph. Keep a quiet desktop workspace, consistent toolbar hit
areas, readable command names and descriptions, and a compact connection notice
that leads directly to existing recovery controls.

Keep Screenshot visible next to attachments. Local preview, explicit screenshot
inclusion, source and region selection, pause/resume/stop, guidance and automatic
watch retain their existing owners and behavior. Commands keep their existing
Focus names, keyboard behavior and draft restoration. No new command, capture
authority, daemon retry policy or runtime abstraction belongs in this change.

## Work Tracking

| Item | State | Acceptance |
| --- | --- | --- |
| Composer and command menu | done | Centered slash/attachment/send icons, clear selected command, no overlap at supported sizes |
| Connection notice | done | Compact notice opens sidebar recovery, focuses retry and preserves draft; troubleshooting remains available |
| Screenshot and interaction regression | done | Real renderer with sample data exercises source/region, inclusion, pause/resume/stop, guidance/watch and ordinary task flows |
| Independent review and package checks | done | Final changed-file review, provider-free package gate and sandboxed Electron smoke pass |

## Validation Boundary

Use the actual renderer at 760 × 560, 1180 × 800 and a large window. Check
empty/disconnected, command menu and active screenshot states visually. Use
synthetic fixtures for captured content; this pass does not certify native
Screen Recording permission, live providers or daemon reconnection.

Keep evidence under the workspace temporary-artifact directory. Product code
changes are limited to renderer HTML/CSS and presentation event handling;
regressions extend the existing renderer and Electron test owners.

## Validation Results

On September 8, using Node.js 24.19.0 and npm 11.12.1:

- `npm run ci-check`: formatting, lint, types, public surface and build passed;
  172 tests passed and five explicit native/daemon integration cases skipped.
- `npm run electron-check`: actual main, sandboxed preload and renderer passed
  disconnected draft, recovery navigation, command keyboard behavior, popovers
  and composer/icon geometry checks at 760 × 560, 1180 × 800 and 1800 × 1000.
- The existing preview fixture was bundled and exercised in Electron: empty
  task, command browsing/Escape draft restore, attachment/removal, window-region
  selection, local preview, pause/resume, automatic watch start/stop, explicit
  screenshot submission/reset, approval deny/allow, guidance, long drafts at
  three sizes, cancellation and stopping capture passed. Seven synthetic-state
  screenshots and three disconnected-state screenshots were visually reviewed.
- `npm run package`: unsigned macOS arm64 package built; the runtime archive
  boundary check passed with 30 entries.
- Two independent reviewers passed the final source and visual/evidence review.
  The initial review also checked capture and command invariants before edits.

The first package run exposed a test fixture missing the new recovery element
IDs. Updating the existing main-process fixture resolved it; no production
fallback or additional dependency was added.

The bounded post-authoring pass covered renderer HTML/CSS and presentation,
the two existing renderer/main test fixtures, Electron smoke, this record and
the docs index. No daemon, preload, capture, observation or provider owner was
changed. The connection notice improves recovery navigation; it does not repair
a missing or incompatible daemon. Native capture, live model outcomes and signed
distribution are not claimed by these results.

The additional workspace cross-check ran in the separate OpenMinion checkout:
`.venv/bin/python3.11 -m ruff check .` passed; `make lint` failed its services
type-error budget at 364 findings against a baseline of 363. No Python code was
changed by this renderer refinement, and concurrent backend work was preserved.
This does not invalidate the passing Desktop package gates or establish a clean
whole-workspace gate.

## Connection Panel Follow-up

September 8 follow-up: the expanded sidebar should contain one short connection
status, a useful explanation and a compact Reconnect action. Put runtime,
protocol, version and troubleshooting in collapsed Technical details. Preserve
keyboard focus, connection state truth and draft-safe retry ownership. Remove
the duplicate status heading rather than hide another copy.

Completed and independently reviewed. The final source passed `npm run ci-check`
(172 tests passed, five explicit integration cases skipped). `npm run
electron-check` passed the real sandboxed app and draft-safe recovery checks;
`npm run package` rebuilt the unsigned arm64 app and verified 30 runtime entries.
The actual disconnected renderer was inspected at 1180 × 800 and 760 × 560,
with both collapsed and expanded diagnostics. Reconnect remains reachable;
keyboard focus stays visible, and the panel scrolls without displacing the
composer. An independent source and visual reviewer found no material blocker.
The bounded post-authoring pass removed the old heading from HTML, renderer and
all fixtures, and kept presentation in the existing owners. No new behavior
framework or capture authority was introduced.

The repeated OpenMinion workspace checks produced the same separate result:
Ruff passed; `make lint` remained blocked at services 364 against baseline 363.
The Desktop gates above passed independently.

## Sending and Reading Follow-up

September 13: clear the composer when a message is submitted, leaving it focused
for the next draft. If task creation is still finishing, preserve text typed
during that wait. A rejected submission restores the original draft only when
no newer draft exists; an accepted submission never clears newly typed text,
even if it repeats the submitted text. Sending remains unavailable during active
work; this change adds no prompt queue or automatic retry.

Keep a terminal turn's exact error and error styling while refreshing canonical
history immediately after completion. This is current-view feedback, not a new
durable error store. Reload and session switching still use the runtime's
available history.

Show Jump to latest when the reader is more than 48 pixels above the bottom of
the conversation. It scrolls to the end and focuses the composer without
changing the draft. Scroll, resize and chat updates refresh its visibility;
the slash menu takes precedence when open. Reading earlier messages does not
force a scroll to the latest reply.

Validation is recorded in the Desktop parity execution record. Existing
Enter/Shift+Enter, Stop, copy, Markdown, inline command results and responsive
composer checks remain part of the package and native GUI suites. Full CLI/Focus
parity, backend timeout tuning, guaranteed provider cancellation, prompt queues,
and active-turn recovery after quitting remain separate work.

## Command Controls Without Overlap

September 13 follow-up: slash suggestions expand inside the composer, above
the text input, and have their own bounded scroll area. They occupy layout space
instead of covering conversation messages. Keyboard selection and Escape draft
restoration keep the same command owner. Chat actions use explicit Close task
and Dismiss labels instead of ambiguous × glyphs; their existing actions remain
unchanged.

Native startup coverage checks menu, input, conversation and title/action bounds
at 760 × 560, 1180 × 800 and 1800 × 1000, plus arrow navigation and draft
restoration. This layout iteration changes no daemon or CLI behavior.

## Daemon Diagnostics Dialog

September 13 correction: Daemon status and View logs open a separate native
dialog; they are application diagnostics, not conversation command results.
The output scrolls within the dialog while Refresh, Copy and Close remain
reachable. Escape dismisses it using native dialog behavior. Closing during a
read prevents its late result from reopening the dialog. Ordinary slash-command
results keep their conversation placement.

The two sidebar diagnostic buttons use 12px text, 4px vertical padding and a
30px minimum height. Dialog actions share that compact sizing. This preserves
the existing fixed public CLI read operations and adds no runtime authority.
