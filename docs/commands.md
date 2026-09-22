# Desktop Commands and Focus Parity

Status: active
Last updated: 2026-09-22

Purpose: describe Desktop's current local slash-command UI and the remaining
Desktop transport work needed for the broader OpenMinion Focus surface.

Desktop is the GUI representation of Focus/CLI. The current subset is an
integration gap, not a separate product command set. Names, arguments, defaults,
and runtime effects must follow Focus. The [Focus Parity Contract](focus-parity.md)
defines the canonical owners, known differences, daemon handoff, and acceptance.

## Using Commands

Type `/` in the composer, click its `/` button, or press Command+K (Ctrl+K
elsewhere). Use the arrow keys to select a command. Enter runs it; Tab completes
its name. Escape dismisses the menu. Opening the menu with the button or shortcut
preserves an existing draft and restores it when you dismiss or run a command.

Command results appear after the messages inside the conversation scroll area.
You can keep drafting while reading a result. Close it with its × button or press
Escape from the composer or result. Long results scroll with the chat, without a separate panel or fixed overlay. Picking
a different conversation dismisses the previous result.

Commands operate through Desktop presentation or fixed public OpenMinion operations. Unknown or unsupported slash commands produce
an explanation and are never submitted to the model. Prefix a message with `//`
to send a literal leading slash: `//path/to/file` sends `/path/to/file`.

## Supported Commands

| Command | Behavior |
| --- | --- |
| `/help` or `/` | Show the working Desktop command list. |
| `/new`, `/new session` | Create a local task draft; its first message creates the saved session. Requires connection and no active turn in the selected task. |
| `/close` | Close the selected conversation through the public CLI; new messages require an open conversation. |
| `/sessions`, `/session` | Open a picker for saved tasks. Focus directory scoping still needs integration. |
| `/tasks`, `/task` | List OpenMinion work for the selected conversation and its agent. Inspect a task by ID, use the returned Pause, Resume, and Cancel controls, or create scheduled work in the inline form. |
| `/agents`, `/agent` | Read the daemon's agent discovery list. An exact ID or display name filters the list; this does not change the session's agent. |
| `/tools`, `/tool` | Show the daemon's tool inventory and reported availability. Exposure changes are not connected. |
| `/skills` | List the OpenMinion skill catalog or inspect one exact skill ID through the public daemon API. Skill admission and mutation are not connected. |
| `/tokens` | Request the selected session's canonical durable token report. Pinned PyPI may report daemon-created sessions unavailable; no usage is fabricated. |
| `/export` | Save the selected conversation as Markdown through a native file chooser and the CLI transcript exporter. |
| `/status` | Show connection, selected task, active agent, reported model, and turn status. |
| `/model` | Show the model facts reported by the daemon; changing models is not supported here yet. |
| `/copy` | Copy the latest visible assistant reply, including a currently streaming reply. Never fall back to user input or cleared replies. Focus tool-output copying still needs integration. Clipboard writes are capped at 1 MB. |
| `/clear`, `/cls` | Clear the visible chat while idle. Saved history remains in OpenMinion; selecting the task restores it. |
| `/quiet` | Hide tool activity cards while keeping approvals visible; saved as a Desktop display preference. |
| `/normal` | Restore tool activity cards; saved as a Desktop display preference. |

Files, screenshots, cancellation, task closing, and reconnection use their
existing GUI controls. Their former Desktop-only slash shortcuts were removed
to keep the command language aligned with Focus. `/resume` is not an alias for
`/sessions`: Focus filters prior sessions with messages in the current directory.
That operation is not connected yet.

`/tasks <task-id>` inspects work. `/tasks pause <task-id>`,
`/tasks resume <task-id>`, and `/tasks cancel <task-id>` invoke the ordinary
CLI task operations. The `/task` alias accepts the same arguments. Work is the
runtime task inventory, which is distinct from the conversation sidebar.
Only actions returned by OpenMinion appear as buttons. Reads work during a chat;
changes wait for that conversation's active turn to finish. OpenMinion validates
each transition; Desktop does not infer task state or schedule ownership.
Pending approval decisions are counted but must still be resolved in Focus/CLI.
The inventory uses the public CLI's default limit of 50.

The `/tasks` panel includes **Schedule work**. Enter a name and instruction, then
choose a local date/time, an interval in minutes, or an advanced cron expression
and timezone. Creation invokes the ordinary CLI `schedule create` command with
the selected conversation and agent. The daemon must be running when work is
due. Creation authorizes that future execution. Invalid input stays in the form;
a successful creation with failed readback offers Refresh instead of another
Create action. Raw cron administration and schedule run/tick history remain
unconnected.

Assistant responses render Markdown, code blocks, lists and tables. Raw HTML is
literal text; embedded images do not load automatically. Clicking an HTTP(S)
link explicitly opens the system browser. Other URL schemes are unavailable.
Unchanged message elements stay mounted during status updates so text selection
and reading position can be retained.

Except for task commands, `/agents <exact-id-or-name>`, `/skills <skill-id>`, and `/new session`, commands currently take no arguments. Bare agent/tool/skill queries, token reports, and export remain available during a turn. Agent filtering waits for the turn to finish, matching Focus admission. Export includes only messages already saved by OpenMinion. Model/provider
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

Progress displays the daemon's label and detail text without inferring brain phases.
After 15 seconds without a new event, it shows the time since the last update
while preserving the conversation and stop control. Completion clears the live
status. Full tool activity and approval presentation remain separate gaps.

## Remaining Focus Parity

Focus's canonical command catalog is owned by OpenMinion's CLI presentation
layer. Its handlers operate on the CLI runtime. Desktop's CLI-backed client
connects text turns, saved sessions, task inventory/lifecycle controls,
agent/tool/skill inventories, token reports, and transcript export; approvals, media,
artifacts, and broader Focus commands remain pending.

| Focus command family | Required Desktop adaptation before it is connected |
| --- | --- |
| Model changes, `/effort` | Present configured model choices and explicitly update an admitted session's model/effort. Return the effective settings; keep credentials daemon-owned. |
| Tool exposure changes, `/mcp`, skill admission/mutation | Expose canonical tool-policy changes, live MCP status, and skill lifecycle controls. Bare `/tools` and skill list/detail are connected. |
| `/permissions`, `/readonly` | Read and update session policy with canonical validation and visible effective policy. |
| `/context`, `/context-review`, `/compact` | Query the context owner and request supported session compaction. The files panel is not a substitute for context-budget inspection. |
| `/cost` | Return live session usage and supported cost accounting. `/tokens` is connected to durable CLI accounting; it is not a live-cost substitute. |
| `/memory`, `/graph`, `/telemetry`, `/trace`, `/overview` | Expose bounded, redacted owner queries over the existing public interfaces. |
| `/participants`, `/invite`, `/kick`, `/activate`, `/routing` | Expose room membership and routing operations for admitted sessions. |
| `/goal`, `/project`, `/delegate`, `/queue` | Expose the existing goal, project, delegation, and queue owners; do not create Desktop-owned execution queues. |
| `/init`, `/diff`, `/review`, `/undo`, `/browser` | Expose scoped workspace/browser operations and their existing permission and audit boundaries. |
| `/theme`, `/statusline`, tool detail commands, `/editor`, `/exit` | Additional Desktop presentation or native interactions; terminal-specific behavior requires an explicit Desktop equivalent. |

These are pending integration requirements, not shipped methods. Desktop must
use fixed, validated public OpenMinion CLI or HTTP operations and keep executable
paths, roots, config, credentials, and generic process authority in main. Do not
execute arbitrary CLI strings or forward slash commands as chat prompts.

## Validation

Renderer tests cover command discovery, keyboard handling, draft preservation,
unsupported-command rejection, response streaming, and task switching. Main
and preload tests cover clipboard writes and fixed task controls, scope binding,
credential projection, invalid inputs, and concurrent operation admission. The
macOS Electron smoke checks the actual command menu and help panel with the
sandboxed preload. The installed-runtime test checks that Desktop's listed
command names and aliases exist in Focus; it does not prove complete menu,
argument, or effect parity. Real-daemon integration remains a separate tier
described in [Testing and Validation](testing-and-validation.md).
