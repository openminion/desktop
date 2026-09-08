# Desktop Commands and Focus Parity

Status: active
Last updated: 2026-09-08

Purpose: describe Desktop's working slash commands and the remaining daemon
contracts needed for the broader OpenMinion Focus command surface.

Desktop is the GUI representation of Focus/CLI. The current subset is an
integration gap, not a separate product command set. Names, arguments, defaults,
and runtime effects must follow Focus. The [Focus Parity Contract](focus-parity.md)
defines the canonical owners, known differences, daemon handoff, and acceptance.

## Using Commands

Type `/` in the composer, click its `/` button, or press Command+K (Ctrl+K
elsewhere). Use the arrow keys to select a command. Enter runs it; Tab completes
its name. Escape dismisses the menu. Opening the menu with the button or shortcut
preserves an existing draft and restores it when you dismiss or run a command.

Commands are local interactions. Unknown or unsupported slash commands produce
an explanation and are never submitted to the model. Prefix a message with `//`
to send a literal leading slash: `//path/to/file` sends `/path/to/file`.

## Supported Commands

| Command | Behavior |
| --- | --- |
| `/help` or `/` | Show the working Desktop command list. |
| `/new`, `/new session` | Create a saved task through the daemon. Requires connection and no active turn in the selected task. |
| `/sessions`, `/session` | Open a picker for saved tasks. Focus directory scoping still needs integration. |
| `/status` | Show connection, selected task, active agent, reported model, and turn status. |
| `/model` | Show the model facts reported by the daemon; changing models is not supported here yet. |
| `/copy` | Copy the latest visible assistant reply, including a currently streaming reply. Never fall back to user input or cleared replies. Focus tool-output copying still needs integration. Clipboard writes are capped at 1 MB. |
| `/clear`, `/cls` | Clear the visible chat while idle. Saved history remains in OpenMinion; selecting the task restores it. |
| `/quiet` | Hide tool activity cards while keeping approvals visible. |
| `/normal` | Restore tool activity cards. |

Files, screenshots, cancellation, task closing, and reconnection use their
existing GUI controls. Their former Desktop-only slash shortcuts were removed
to keep the command language aligned with Focus. `/resume` is not an alias for
`/sessions`: Focus filters prior sessions with messages in the current directory.
That operation is not connected yet.

Other than `/new session`, commands currently take no arguments. Model/provider
fields can say “Not reported” when the daemon session metadata omits them.

The composer remains editable during a turn so you can write a draft or run a
local command. Ordinary text is not queued or sent until the turn finishes and
you submit it yourself. Incoming response text is visible as it arrives.
Switching tasks within the same app keeps the running turn's response,
approval cards, and cancellation controls. App restart still requires richer
active-turn attachment/recovery support; saved completed conversations recover
from the daemon as before.

In UI preview, clipboard access is explicitly unavailable. The real application
provides the narrow clipboard-write bridge; neither surface reads the clipboard.

## Remaining Focus Parity

Focus's canonical command catalog is owned by OpenMinion's CLI presentation
layer. Its handlers operate on the CLI runtime. Desktop's versioned daemon
capabilities currently expose sessions, turns, approvals, media, and artifacts;
they do not expose the entire interactive CLI command surface.

| Focus command family | Required daemon capability before Desktop can implement it |
| --- | --- |
| `/agents`, model changes, `/effort` | List configured agents/models and explicitly update an admitted session's agent/model/effort. Return the effective settings; keep credentials daemon-owned. |
| `/tools`, `/mcp`, `/skills` | Read the selected agent's configured tools, MCP status, and skills through bounded structured queries. |
| `/permissions`, `/readonly` | Read and update session policy with canonical validation and visible effective policy. |
| `/context`, `/context-review`, `/compact` | Query the context owner and request supported session compaction. The files panel is not a substitute for context-budget inspection. |
| `/tokens`, `/cost` | Return durable session usage and supported cost accounting, with unavailable fields explicit. |
| `/memory`, `/graph`, `/telemetry`, `/trace`, `/overview` | Expose bounded, redacted owner queries over the authenticated Desktop contract. |
| `/participants`, `/invite`, `/kick`, `/activate`, `/routing` | Expose room membership and routing operations for admitted sessions. |
| `/goal`, `/project`, `/delegate`, `/tasks`, `/queue` | Expose the existing goal, project, delegation, task, and queue owners; do not create Desktop-owned execution queues. |
| `/init`, `/diff`, `/review`, `/undo`, `/browser` | Expose scoped workspace/browser operations and their existing permission and audit boundaries. |
| `/theme`, `/statusline`, tool detail commands, `/export`, `/editor`, `/exit` | Additional Desktop presentation or native interactions; terminal-specific behavior requires an explicit Desktop equivalent. |

These are pending integration requirements, not shipped methods. Their request
and response schemas must be agreed with the daemon owner before adding typed
main/preload methods. Do not execute arbitrary CLI strings or forward slash
commands as chat prompts to imitate missing behavior.

## Validation

Renderer tests cover command discovery, keyboard handling, draft preservation,
unsupported-command rejection, response streaming, and task switching. Main
and preload tests cover the bounded clipboard-write method. The macOS Electron
smoke checks the actual command menu and help panel with the sandboxed preload.
Real-daemon integration remains a separate tier described in
[Testing and Validation](testing-and-validation.md).
