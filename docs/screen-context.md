# OpenMinion Desktop Screen Context

Status: current behavior and proposed direction
Last updated: 2026-09-08

Purpose: keep screen context a first-class part of the chat interface while
distinguishing today's screenshot workflow from future streaming and control.

## Current Interaction

The composer has a visible **Screenshot** action. It opens the screen/window
chooser without a permanent side panel. After starting a local preview, the
composer shows its thumbnail and source name. While previewing, the picker
hides its candidate grid and region editor; **Change source** returns to
selection.

Preview pixels remain local in the current app. The visible inclusion,
guidance, and **Automatic watch** controls are disabled because screenshot
delivery is not connected to OpenMinion or a model. The preview is not a
frozen attachment or a permanent screenshot timeline. Pausing, stopping, or
changing tasks clears its transient state.

Automatic watch is a future opt-in mode for individual still frames on change
or at an interval. It is not implemented, continuous video, or native input.

OpenMinion owns model execution and durable artifacts. Desktop main owns
capture permissions, frame selection, bounds, and lifecycle. The renderer
displays those facts through the existing typed bridge.

## Phased Direction

| Phase | User experience | Status |
| --- | --- | --- |
| Manual screenshot | Choose a source, include one screenshot with a message, see what was sent | UI and local preview implemented; sending awaits a public screenshot/media delivery path and native acceptance |
| Multiple screenshots | Freeze selected frames as removable, ordered attachments; compare before/after or several windows | Future work; existing image-file attachments are not a captured-screen sequence workflow |
| Streaming screen context | Explicit start/pause/stop, visible source and sharing state, configurable cadence and cost limits | Future work; the current app provides local preview only |
| Co-navigation | Observe and perform scoped actions together, with clear control ownership and an immediate stop | Future work; requires separate native-input authority, policy, audit, and acceptance |

Lower inference costs may make richer screen context practical, but must not
silently change consent or turn observation into control. These phases describe
direction, not implemented features or a release commitment.

## UI Rules Across Phases

- Keep the screen action beside the composer, independently of file settings.
- Distinguish local preview, selected images, sending, and automatic sharing.
- Extend the same context area with explicit image counts or sharing status
  when those capabilities exist. Any earlier preview control stays disabled and
  clearly labeled as planned without implying active delivery.
- Keep source selection, removal, pause, and stop reachable without resizing
  the conversation into a fixed right panel.
- Keep the message, attachments, and send controls aligned from the supported
  minimum window to large windows. Long titles truncate, controls wrap, and
  previews or guidance scroll within bounded areas.
- Validate resizing with empty and populated chats, screenshots, long drafts,
  attachments, guidance, permission errors, and open option panels.

## Acceptance Boundary

Renderer fixtures establish layout and interaction behavior only. Native
permission testing, actual sent-frame verification, model-backed work, and
future streaming/control each need their own integration proof. See
[Testing And Validation](testing-and-validation.md).
