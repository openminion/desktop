# Desktop Commands and Focus Parity

Status: active
Last updated: 2026-10-28

Purpose: describe Desktop's current local slash-command UI and the remaining
Desktop transport work needed for the broader OpenMinion Focus surface.

Desktop is the GUI representation of Focus/CLI. The current subset is an
integration gap, not a separate product command set. Names, arguments, defaults,
and runtime effects must follow Focus. The [Focus Parity Contract](focus-parity.md)
defines the canonical owners, known differences, daemon handoff, and acceptance.
Terminal scripting modes, pipes, shell composition, completion and
invocation-only flags remain CLI-only after their user-visible effects are
mapped; their syntax is not duplicated as Desktop controls.

References to pinned `0.0.29` behavior below describe the fresh-install baseline
or version-specific evidence. An activated runtime update or developer override
can expose different capabilities; check **Settings → Runtime → Technical details**
for the installed version. See [Runtime Updates](getting-started.md#runtime-updates).

## Using Commands

Type `/` in the composer, click its `/` button, or press Command+K (Ctrl+K
elsewhere). Use the arrow keys to select a command. Enter runs it; Tab completes
its name. Escape dismisses the menu. Opening the menu with the button or shortcut
preserves an existing draft and restores it when you dismiss or run a command.
Replacing the command with ordinary text replaces that saved draft. Usage hints
remain visible while entering arguments; choosing a match keeps those arguments.
Use `/help <command>`, `/<command> --help`, or `/<command> ?` for local help
without running the command.

Command results appear after the messages inside the conversation scroll area.
You can copy a text result or error and keep drafting while reading it. Close it with its × button or press
Escape from the composer or result. Long results scroll with the chat, without a separate panel or fixed overlay. Picking
a different conversation dismisses the previous result.

Commands operate through Desktop presentation or fixed public OpenMinion operations. Unknown or unsupported slash commands produce
an explanation and are never submitted to the model. Prefix a message with `//`
to send a literal leading slash: `//path/to/file` sends `/path/to/file`.

## Supported Commands

| Command                 | Behavior                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/help` or `/`          | Show the working Desktop command list. Add a connected command name to show its Desktop help.                                                                                                                             |
| `/new`, `/new session`  | Create a local task draft; its first message creates the saved session. Requires connection and no active turn in the selected task.                                                                                      |
| `/close`                | Close the selected conversation through the public CLI; new messages require an open conversation.                                                                                                                        |
| `/sessions`, `/session` | Open a picker for saved tasks. Focus directory scoping still needs integration.                                                                                                                                           |
| `/tasks`, `/task`       | List OpenMinion work for the selected conversation and its agent. Inspect a task by ID, use the returned Pause, Resume, and Cancel controls, or create scheduled work in the inline form.                                 |
| `/delegate`             | Start sync or background delegated work, list recent delegations, and inspect or control one task through the selected conversation's agent/session scope. Inspection renders a structural tree and separate A2A protocol timeline. |
| `/agents`, `/agent`     | Read the daemon's agent list and mark the conversation's current agent. An exact ID or display name filters the list; this does not switch agents.                                                                                           |
| `/tools`, `/tool`       | Show exposure status for the selected session, matching Focus. `list` shows the tool inventory. `activate [profile]` and `deactivate [profile]` open scoped forms backed by Core tool exposure operations.                                                                                                                           |
| `/mcp`                  | Read MCP servers and tool counts for the conversation's current agent. Without a conversation, use the daemon's default capability report.                                                                                                      |
| `/skills`               | Browse stored global and selected-agent skills from OpenMinion (global only without a conversation); select an entry or use `/skills <skill-id>` to inspect it. Skill admission and mutation are not connected.                                                                            |
| `/learning`             | Show the skill-learning suggestion summary or inspect one exact proposal ID through the public daemon API. Review and apply remain operator CLI actions.                                                                  |
| `/identity`             | Show the selected conversation agent's canonical identity. Add `verify` to inspect source/render status or `reload` to restart the app-owned daemon and refresh cached identity policy.                                  |
| `/tokens`               | Request the selected session's canonical durable token report. Pinned PyPI may report daemon-created sessions unavailable; no usage is fabricated.                                                                        |
| `/export`               | Save the selected conversation as Markdown through a native file chooser and the CLI transcript exporter.                                                                                                                 |
| `/status`               | Show connection, selected task, active agent, reported model, and turn status.                                                                                                                                            |
| `/model`                | Read the selected conversation’s current agent, provider, and model from the daemon; changing models is not supported here yet.                                                                                                                                   |
| `/copy`                 | Copy the newest available assistant reply or runtime-supplied completed tool output. Never fall back to user input or cleared replies. Unavailable raw output is not reconstructed; clipboard writes are capped at 1 MB. |
| `/clear`, `/cls`        | Clear the visible chat while idle. Saved history remains in OpenMinion; selecting the task restores it.                                                                                                                   |
| `/quiet`                | Hide tool activity cards while keeping approvals visible; saved as a Desktop display preference.                                                                                                                          |
| `/normal`               | Show the first six lines of supplied tool output, with a disclosure for more; saved as a Desktop display preference.                                                                                                                                                       |
| `/verbose` | Expand all available tool output. Missing or truncated runtime content is not reconstructed. |
| `/details [on\|off\|quiet\|toggle]` | Toggle verbose/normal or select a mode. Uses Focus aliases: verbose/full/details → on; normal/concise → off. |
| `/graph`                | Show installed CLI help. `/graph status` or **Check readiness** reads actual graph readiness using this installation's configuration. Querying, refreshing and launching a viewer remain unconnected.                                                                                    |
| `/editor`               | Show the native Desktop composer shortcuts. Current-source external-editor draft composition is not connected in the pinned 0.0.29 runtime.                                                                               |

`/sessions` refreshes the saved conversation list from OpenMinion. Each entry
shows its friendly name and full session ID, along with the reported agent,
channel, message count and update age. Selecting an entry opens it and adds it
to the sidebar if needed. Missing metadata is shown as not reported. `/status`
reads the selected saved conversation's current state, channel, message count
and update time from OpenMinion without reloading the chat. Both commands require
a selected saved conversation. `/model` uses the same fresh read for its
agent, provider, and model; failed reads show the error instead of cached facts.
Provider and model remain not reported when unavailable; these reports do not
include Focus's complete live runtime status.

Tool display is saved for this Desktop installation and applies across conversations. Manual disclosure changes survive unrelated chat updates; changing the display mode resets disclosures to that mode. Quiet always keeps approvals visible.

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
With a compatible source runtime, pending tool approvals can be allowed once or
denied from their request-bound card. Task lifecycle controls remain separate
and do not grant or deny them.
The inventory uses the public CLI's default limit of 50.

`/delegate <agent> <instruction>` waits for a result; explicit `sync` does the
same, while `async` starts a background task. Instruction spaces and line breaks
are preserved. `/delegate list [1-200]` shows recent work and accepts a decimal
integer limit. Malformed task commands show usage without starting delegated work.
Focus's `review`, `accept`, `reject`, and `--child-permission-mode` forms are not
connected in Desktop yet; Desktop reports that limit without executing them.
Use `/delegate inspect <task-id>` for the structural parent/child tree and A2A
protocol timeline. Status, result, and cancel use the same task ID. Resume explains that Core cannot resume delegated jobs; it does not issue a pretend resume operation. Desktop invokes fixed CLI operations in
trusted main with the selected conversation's exact agent and session; the
renderer cannot supply executable paths, roots, configuration, or arbitrary
commands. The safe timeline excludes prompts, tool content, credentials, and
removed error prose. A recorded child conversation is a separate link, not a
reconstructed transcript.

Every delegation action requires its installed CLI command to advertise both
`--parent-agent-id` and `--session-id`. An unavailable scoped contract produces
an update explanation before an operation is sent. Scope is never silently
dropped. Delegation inspection additionally requires `agent delegate-inspect`. That command is not in the pinned PyPI `0.0.29` runtime. The native
delegation inspection journey belongs to its corresponding Core source worktree;
published-runtime inspection remains pending the core change and release.

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

The skill catalog follows the conversation’s current agent, including its configured default. It lists stored records; Focus configured-only entries and eligibility filtering are not yet represented.

Except for task and delegation commands, `/identity verify`, `/identity reload`,
`/details [on|off|quiet|toggle]`, `/agents <exact-id-or-name>`, `/skills <skill-id>`, `/learning <proposal-id>`, `/help <connected-command>`, `/tools status`, `/tools list`, `/tools activate [profile]`, `/tools deactivate [profile]`, `/graph status`, and `/new session`, commands currently take no arguments. Bare agent/tool/skill/learning queries, token reports, graph help/status, and export remain available during a turn. Agent filtering and tool queries with arguments wait for the turn to finish, matching Focus admission. Command-specific help remains available. Export includes only messages already saved by OpenMinion. Model/provider
fields can say “Not reported” when the daemon session metadata omits them.

The composer remains editable during a turn so you can queue ordinary text or
run a local command. Enter admits ordinary text to OpenMinion's shared **Up
next** queue; Shift+Enter keeps editing. The queue can be reordered or trimmed,
and **Stop and run next** requests canonical cancellation before starting its
head. Attachments remain drafts until the active turn finishes. Incoming
response text is visible as it arrives.
Switching tasks within the same app keeps the running turn's response,
approval cards, and cancellation controls. App restart still requires richer
active-turn attachment/recovery support; saved completed conversations recover
from the daemon as before.

In UI preview, clipboard access is explicitly unavailable. The real application
provides the narrow clipboard-write bridge; neither surface reads the clipboard.

Progress displays the daemon's label and detail text without inferring brain phases.
After 15 seconds without a new event, it shows the time since the last update
while preserving the conversation and stop control. Completion clears the live
status. Completed tool cards offer Copy output when the runtime supplies content
and identify reported truncation. Missing output is not recovered from assistant
text or invented after restart. Tool activity and request-bound approval cards
use the same live turn stream. Received output expands inline; Focus `/expand`
block selection and unavailable historical output remain separate gaps.

## Remaining Focus Parity

Focus's canonical command catalog is owned by OpenMinion's CLI presentation
layer. Its handlers operate on the CLI runtime. Desktop's CLI-backed client
connects text turns, saved sessions, task inventory/lifecycle controls,
agent/tool/skill inventories, skill-learning proposal reads, token reports, and
transcript export. Compatible runtimes also connect request-bound tool
approvals; see the [readiness matrix](certification-readiness-matrix.md) for
managed-runtime evidence. Media, artifacts, and
broader Focus commands remain pending.

| Focus command family                                                                                    | Required Desktop adaptation before it is connected                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model changes, `/effort`                                                                                | Present configured model choices and explicitly update an admitted session's model/effort. Return the effective settings; keep credentials daemon-owned.                                                                                                     |
| Richer tool policy, MCP lifecycle/browse/authentication, skill admission/mutation                    | Expose canonical tool-policy changes, richer live MCP status and operations, and skill lifecycle controls. `/tools` reports and exposure activation/deactivation, `/mcp`, skill list/detail, and learning proposal reads are connected slices; proposal review and apply remain in the operator CLI. |
| `/permissions`, `/readonly`                                                                             | Read and update session policy with canonical validation and visible effective policy.                                                                                                                                                                       |
| `/context`, `/context-review`, `/compact`                                                               | Query the context owner and request supported session compaction. The files panel is not a substitute for context-budget inspection.                                                                                                                         |
| `/cost`                                                                                                 | Return live session usage and supported cost accounting. `/tokens` is connected to durable CLI accounting; it is not a live-cost substitute.                                                                                                                 |
| `/memory`, `/telemetry`, `/trace`, `/overview`                                                          | Expose bounded, redacted owner queries over the existing public interfaces. `/graph status` runs the CLI readiness report suggested by Focus; other graph workflows remain pending.                                                                              |
| `/room`, `/handoff`, `/message`, `/start`, `/participants`, `/invite`, `/kick`, `/activate`, `/routing` | Expose room membership, handoff, messaging, start, and routing operations for admitted sessions.                                                                                                                                                             |
| `/goal`, `/project`, `/queue`                                                                           | Expose goal/project commands and optional queue command presentation; composer queue controls already consume the Core queue.                                                                                                                                 |
| `/init`, `/diff`, `/review`, `/undo`, `/browser`                                                        | Expose scoped workspace/browser operations and their existing permission and audit boundaries.                                                                                                                                                               |
| `/theme`, `/statusline`, `/expand`, `/editor`, `/exit`, `/quit`                 | Additional Desktop presentation or native interactions. Current Focus `/editor` composes an unsent draft through an external editor; Desktop shortcut guidance alone is not equivalent.                                                                      |

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
sandboxed preload. `npm run electron-check:delegation` proves bidirectional
CLI/Desktop delegation against one real provider-free daemon and shared
isolated roots. The installed-runtime test checks that Desktop's listed
command names and aliases exist in Focus; it does not prove complete menu,
argument, or effect parity. Real-daemon integration remains a separate tier
described in [Testing and Validation](testing-and-validation.md).

## Custom commands and tool access

For saved conversations, the slash picker discovers Core's bundled, user, and
project custom commands. Core renders arguments before Desktop submits the exact
returned prompt through ordinary chat. Editing the draft or switching
conversations during rendering abandons that result. Local file and shell
expansion stay unavailable through the public render contract; errors preserve
the command draft. A new, unsent conversation has no Core session to discover
commands for yet. Send its first message before using custom commands.

Tool activation forms pass the selected conversation plus optional target/task
scope, credential scope names, dependencies, expiry, reason and attribution to
Core. Approval starts unchecked and changes only when selected explicitly. The
form accepts names, never API-key values. Core decides whether activation is
allowed. Deactivation uses the same profile and optional target/task scope.
The form opens without changing access; submit it to apply the operation.
Focus's inline option syntax is represented by these fields, not a second
shell parser. Installed-runtime errors are shown without adding a fallback.
