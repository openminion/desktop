# OpenMinion Desktop Changelog

Status: active
Last updated: 2026-09-07

Notable user-facing changes to OpenMinion Desktop are recorded here.

## Unreleased

- Established Focus/CLI as Desktop's behavior contract and recorded the missing
  shared command integration. Full Focus parity is not implemented yet.
- Removed Desktop-only slash shortcuts for files, screenshots, cancellation,
  closing tasks, and reconnection; their existing GUI controls remain available.
- Stopped treating `/resume` as an alias for the different `/sessions` command.
  Help and model selection now explicitly identify incomplete integration.
- Prevented `/copy` from copying user input or replies hidden by `/clear`.

- Added a keyboard-accessible slash command menu for task navigation, status,
  copying, visible chat clearing, tool activity, context panels, and cancellation.
- Displayed incoming response text and preserved active-turn controls and
  pending approvals when switching tasks within the same app.
- Kept the composer editable during turns for local commands and unsent drafts.

- Kept unsent drafts with their tasks instead of carrying them into another
  task; creating another task starts with an empty composer.
- Showed the submitted message during an active turn and moved the timeline
  to that message when sending, while preserving draft text on rejection.
- Distinguished closed tasks in the sidebar and added full attachment
  tooltips and specific accessible removal labels.

- Fixed sandboxed preload loading so the real app connects its UI handlers
  instead of remaining on the initial Connecting screen.
- Waited for the supervisor's startup result instead of abandoning renderer
  connection checks after ten seconds.
- Added an explicit UI preview command with sample tasks and working controls
  for trying the renderer before daemon integration.
- Made the composer expand with the window and accept local drafts while
  disconnected; removed the inactive folder-import placeholder.
- Added a real Electron startup check to macOS CI covering both preloads,
  disconnected drafting, popovers, and composer resizing.

- Kept long task titles, attachment names, and approval details within the
  workspace at the minimum window size; added visible composer focus and
  persistent popover close controls.
- Preserved conversation reading position while editing a draft and cleared
  the previous conversation when loading another task.
- Distinguished local screenshot preview from inclusion in the next message
  and hid source-selection controls while a preview is active.
- Aligned real-daemon observation tests with reported provider token usage.

- Applied the OpenMinion logo to the packaged macOS app, development Dock icon,
  sidebar, and empty conversation state.
- Simplified the chat workspace with a restrained palette, consistent task
  navigation, an attachment menu, and dismissible context options.
- Made Screenshot a first-class composer action, with screen/window selection,
  a local preview, explicit one-image inclusion, and visible automatic-watch
  status. Documented the direction toward multiple captures and streaming.
- Added Command/Ctrl+Enter to send, an expanding composer, reduced-motion
  support, and clearer connection recovery at smaller window sizes.
- Added the secure Electron shell for the persistent OpenMinion daemon.
- Added local sessions and chat, bounded attachments, tool progress and
  approvals, artifact views, screen or window observation, and guide mode.
- Added package-owned formatting, lint, type, test, build, commit-policy, and
  unsigned macOS packaging checks.
- Added a package-owned public-surface check for required repository files,
  local documentation links, portable paths, and documented npm commands.
- Added hosted actionlint validation for GitHub Actions workflows.
- Aligned the README and public contributor, compatibility, security, support,
  quality, testing, and release guidance with the OpenMinion package family.
- Documented that the Desktop daemon contract has not yet landed on the current
  OpenMinion `main` line.

No signed or notarized desktop release has been published.
