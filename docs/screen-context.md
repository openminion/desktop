# OpenMinion Desktop Screen Context

Status: current behavior and proposed direction
Last updated: 2026-11-18

Purpose: keep screen context a first-class part of the chat interface while
distinguishing today's screenshot workflow from future streaming and control.

## Current Interaction

The composer has a visible **Screenshot** action. It opens the screen/window
chooser without a permanent side panel. After starting a local preview, the
composer shows its thumbnail and source name. While previewing, the picker
hides its candidate grid and region editor; **Change source** returns to
selection.

Preview pixels remain local until you explicitly include a screenshot and send.
On runtimes advertising `turns.images.v1`, Desktop sends selected still images
through Core's authenticated session image API. Image-file attachments have
normalized previews and can be removed before sending. The limit is four still
PNG/JPEG/WebP images, 10 MiB each and 20 MiB combined; Core also limits decoded
pixels and removes image metadata. Unsent attachments are not restored after an
app restart.

Settings uses the Core profile's native or separate-reader image policy. Native
sends the question and images to the chat model. A separate reader sends text
findings to the chat model; the reader can use the same model or a different
configured connection. Model image support is explicitly declared, not inferred
from its name or claimed as live verified. Older runtimes disable image sending
without disabling text chat. Published-runtime and real-provider qualification
remain separate from source tests.

Automatic watch is a future opt-in mode for individual still frames on change
or at an interval. It is not implemented, continuous video, or native input.

OpenMinion owns model execution and durable artifacts. Desktop main owns
capture permissions, frame selection, bounds, and lifecycle. The renderer
displays those facts through the existing typed bridge.

## Phased Direction

| Phase | User experience | Status |
| --- | --- | --- |
| Manual screenshot | Choose a source, include one screenshot with a message, see what was sent | Source integration implemented behind `turns.images.v1`; released-runtime and native capture acceptance remain separate |
| Multiple screenshots | Freeze selected frames as removable, ordered attachments; compare before/after or several windows | Future work; existing image-file attachments are not a captured-screen sequence workflow |
| Streaming screen context | Explicit start/pause/stop, visible source and sharing state, configurable cadence and cost limits | Future work; current sending requires an explicit user action |
| Co-navigation | Observe and perform scoped actions together, with clear control ownership and an immediate stop | Future work; requires separate native-input authority, policy, audit, and acceptance |

Lower inference costs may make richer screen context practical, but must not
silently change consent or turn observation into control. These phases describe
direction, not implemented features or a release commitment.

## UI Rules Across Phases

- Keep the screen action beside the composer, independently of file settings.
- Distinguish local preview, selected images, sending, and automatic sharing.
- Extend the same context area with explicit image counts or sharing status
  when those capabilities exist. Until then, only local preview is shown;
  no control should imply active delivery.
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
