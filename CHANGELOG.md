# OpenMinion Desktop Changelog

Status: active
Last updated: 2026-09-08

Notable user-facing changes to OpenMinion Desktop are recorded here.

## Unreleased

- Added Settings for importing Focus/CLI profile JSON, editing agent model
  settings, selecting the default agent, and replacing or removing saved API
  keys. Applying changes preserves conversations and restarts the local daemon.
  Stored keys remain private and running Desktop chats block changes.

- Changed chat input to send with Enter and insert a new line with Shift+Enter.

- Refreshed daemon status when opening connection details so a stopped runtime
  exposes Reconnect while preserving the unsent draft.
- Prevented late cancellation replies from reopening a completed turn or
  changing another task's status.
- Expanded real-runtime GUI checks across task switching, commands, resizing,
  outage recovery, cancellation, provider failures, and recovery.

- Enabled sending directly from the empty workspace: the first message creates
  its task automatically, without requiring a separate New task click.

- Connected text chat and saved sessions to the pinned PyPI runtime through its
  ordinary CLI/API, with delivery acknowledgement, authenticated cancellation,
  and completed-history recovery.
- Labeled new tasks as local drafts until their first message and marked pending
  attachment, artifact, and screen-sending integrations unavailable.
- Added opt-in published-package CLI and production Electron conversation checks.

- Added a Desktop-owned first-run lifecycle that installs pinned
  `openminion==0.0.18` from PyPI, creates an isolated authenticated demo config,
  and uses the ordinary daemon start, status, and stop commands.
- Removed Desktop lifecycle dependence on the former Desktop-specific bootstrap
  and lease contract. Approval, media, and artifact transport remain pending.

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
- Documented the public PyPI lifecycle boundary and the separate pending chat
  transport boundary.

No signed or notarized desktop release has been published.
