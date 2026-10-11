# Focus Parity Contract

Status: active
Last updated: 2026-10-06

Purpose: define Desktop as the GUI representation of OpenMinion Focus/CLI and
record the integration required to make their behavior match.

## Product Contract

Focus/CLI is authoritative for shared semantic capabilities. Desktop must expose
the same supported outcomes, canonical names and aliases where commands are
shown, defaults, session scope, busy-turn rules, permissions, and durable
effects. Buttons, pickers, panels and composer commands may present those
capabilities differently. Stdin/pipe composition, scripting output modes, shell
completion, invocation-only flags and terminal rendering remain terminal-only
only after profile, session, directory, theme and every other visible effect has
a Desktop or shared-state disposition.
Missing shared functionality is unfinished integration, not an intentional
Desktop variant.

The canonical OpenMinion owners are:

- `src/openminion/cli/presentation/slash_commands.py`: catalog, aliases, help,
  and busy-turn classification.
- `src/openminion/cli/interactive/terminal/shell/actions.py`: Focus dispatch.
- `src/openminion/cli/interactive/terminal/shell/sessions.py`: new sessions,
  resume filtering, and room operations.
- `src/openminion/cli/interactive/terminal/shell/slash_output.py` and
  `src/openminion/cli/interactive/terminal/transcript.py`: transcript operations.

Inspect the actual handlers as well as the catalog: a help entry alone does not
prove an operation works in Focus. Current Focus `/editor` opens an external
editor and loads the returned text as an unsent draft; the pinned 0.0.29 Desktop
runtime and Desktop's shortcut guidance do not provide that behavior yet.
Preserve explicit renderer availability where Focus and the rich CLI renderer
differ.

## Current Differences

This is a source assessment, not end-to-end parity certification. The current
Desktop installs and runs ordinary OpenMinion and connects text turns, saved
history, skill catalog/detail reads, and skill-learning proposal reads through
its public CLI/API. The broader Focus command surface, approvals,
media, and artifacts still require Desktop integration.

| Surface                  | Current Desktop gap                                                                                                               | Required outcome                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Catalog and help         | A small static renderer list with argument hints, alias matching and local command help                                                                                                      | Discover canonical names, aliases, usage, availability, and descriptions through fixed public OpenMinion operations |
| Arguments and busy state | `/tasks` supports inspection and pause/resume/cancel arguments; tool status/list and selected read filters are connected; other commands mostly reject arguments | Use the same parser and command admission as Focus, including bare queries during a turn                            |
| `/new`, `/sessions`      | Saved-task creation and selection exist; Focus directory scope is not established                                                 | Preserve working directory, selected agent, session scope, and canonical creation/binding defaults                  |
| `/resume`                | Not connected; the incorrect `/sessions` alias was removed                                                                        | Present prior sessions with messages in the current directory, then bind and load history                           |
| `/model`                 | Reports session metadata only                                                                                                     | Present configured choices and perform canonical model selection; return effective settings                         |
| `/status`                | Reports connection and partial session metadata                                                                                   | Include canonical agent, model, session, and working-directory facts                                                |
| `/clear`, `/copy`        | Visible chat clearing and newest assistant/runtime-supplied tool copying exist; missing raw tool content is not reconstructed                                      | Match Focus transcript clearing and latest copyable agent/tool output; never copy user input as a fallback          |
| Tool presentation        | `/quiet` and `/normal` toggle summary cards                                                                                       | Match quiet, normal truncation, verbose, details, and expansion using canonical tool content                        |
| Type-ahead               | Drafts remain unsent during a turn                                                                                                | Match Focus queue admission, inspection, and control through the runtime owner                                      |
| Recovery                 | Running turns survive task switches in one app                                                                                    | Reattach to the same running turn and pending approvals after restart                                               |

The GUI's Context/files panel is not Focus's context-budget report. Screen
capture remains a GUI input method. Files, screenshots, cancellation, task
closing, and reconnection keep their existing buttons; they do not introduce
additional slash names.

## Desktop Integration Handoff

The integration belongs in Desktop. Main receives a read-only command context
from the lifecycle owner and may invoke only fixed, validated ordinary CLI or
HTTP operations. Preload exposes narrow typed results, and the renderer presents
them. Executable paths, runtime roots, configuration, credentials, and generic
subprocess authority remain in main.

Do not restore Desktop-specific commands, routes, leases, or bootstrap code in
OpenMinion. Do not run arbitrary renderer-provided command strings, start a
second interactive terminal, or copy OpenMinion business logic into TypeScript.
Terminal-only actions such as clearing, copying, or exiting map to explicit GUI
actions with the same user intent. A catalog entry is never proof of execution
support.

All canonical command families need coverage:

| Commands and aliases                                                                                    | Existing behavior to expose or present                                                                                                                              |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/help`, `/`                                                                                            | Canonical catalog and help                                                                                                                                          |
| `/new`, `/new session`, `/sessions`, `/session`, `/resume`                                              | Directory-scoped session creation, inventory, binding, and history                                                                                                  |
| `/room`, `/handoff`, `/message`, `/start`, `/participants`, `/invite`, `/kick`, `/activate`, `/routing` | Room membership, handoff, messaging, start, and routing                                                                                                             |
| `/agents`, `/agent`, `/model`, `/effort`                                                                | Agent inspection/selection, configured model choices, effective effort                                                                                              |
| `/delegate`, `/goal`, `/project`, `/tasks`, `/task`, `/queue`                                           | Delegation start/list/inspection and task controls are connected slices; goal, project, and prompt-queue owners remain pending                                       |
| `/tools`, `/tool`, `/mcp`, `/skills`, `/learning`                                                       | Configured tool, server, skill, and learning-proposal inventory and supported changes                                                                               |
| `/permissions`, `/readonly`                                                                             | Canonical policy queries, updates, and effective mode                                                                                                               |
| `/context`, `/context-review`, `/compact`, `/cost`, `/tokens`                                           | Context evidence, supported compaction, live/durable usage, available cost                                                                                          |
| `/memory`, `/telemetry`, `/trace`, `/overview`                                                          | Owner reports and supported operations, with renderer availability preserved; `/graph` guidance is connected while graph workflows remain pending                   |
| `/init`, `/browser`, `/undo`, `/diff`, `/review`                                                        | Existing workspace/browser operations with policy and audit boundaries                                                                                              |
| `/clear`, `/cls`, `/copy`, `/quiet`, `/normal`, `/verbose`, `/details`, `/expand`                       | Canonical transcript content and presentation semantics                                                                                                             |
| `/status`, `/theme`, `/statusline`, `/export`, `/editor`, `/exit`, `/quit`                              | Status, presentation preferences, external-editor draft composition, and exit intent; the current Desktop `/editor` guidance is not yet equivalent to current Focus |

## Connected Setup And Session Identity

First-launch onboarding reads the installed CLI's `setup --list-providers`
catalog and invokes fixed `setup --no-chat` arguments against a private candidate
config. Core owns provider defaults and profile construction. Desktop validates
and applies that config through its existing Settings lifecycle. A checked
setup adds the CLI's `--check-provider` flag and reports the typed verification
outcome; unchecked setup does not make a provider request. Existing
configured agents use Settings or profile import. Settings also reuses that setup
flow to add an agent with a distinct ID and model credential, preserving existing
agents and shared tool keys. This does not implement the full CLI multi-model
setup surface.

Saved-session sends read `sessions show --json` and retain its agent, channel,
and target. Desktop continues CLI-created conversations without rebinding them
to the identity used for new GUI sessions. Working-directory scope and the
broader `/resume` picker remain separate gaps.

Desktop Settings and `/identity`, `/identity verify`, and `/identity reload`
read the same OpenMinion identity files through fixed CLI operations under the
Desktop-owned config and data roots. Show and verify report the active
conversation's agent identity. Reload restarts the app-owned daemon before it
rereads the profile so runtime policy and tool constraints are refreshed; an
external daemon remains under its operator's lifecycle. Desktop does not copy
identity state into SQLite or expose a generic command bridge. The ordinary CLI
keeps its separate config and data roots unless the operator explicitly points
both interfaces at the same installation.

## Connected Task Controls

On pinned PyPI 0.0.29, `/tasks` and `/task` use fixed `tasks list/show/pause/resume/cancel`
CLI calls. Main derives agent scope from the selected canonical session and passes
its session ID. Focus's task report and these CLI commands share OpenMinion's task
surface; Desktop does not copy lifecycle transitions, task ownership, or scheduler
logic. The CLI retains its default inventory limit of 50. GUI buttons come from
returned `valid_actions`; core validates them again on execution.

The renderer receives task presentation fields and scoped pending-approval facts.
When paired with a compatible source runtime, tool approval cards resolve the
exact active request through the authenticated approval-resume route, not
through task lifecycle commands.
Task changes are fenced against active Desktop turns and Settings updates. Reads
remain available during a turn. The inline form creates scheduled work using fixed `schedule create` arguments:
name, instruction, one-time ISO timestamp, interval in minutes, or cron expression
with timezone. It carries the same session and agent scope, then reads back the
canonical task list. Core owns schedule validation and execution. Pending
decisions, non-scheduled task creation and richer run-history inspection still
need integration.

Pinned PyPI 0.0.29 includes `/close`; Desktop routes that command to its
existing canonical Close operation. `/resume` remains unavailable because the
current saved-task picker does not establish Focus directory and non-empty
history filtering. Broader catalog discovery remains a gap.

## Connected Reports And Export

On pinned PyPI 0.0.29, `/agents` (`/agent`) reads `GET /v1/agents`, backed by
Focus's agent-discovery owner. An exact ID or display name filters the returned
list; Desktop does not interpret it as agent selection. `/tools` (`/tool`)
shows Core exposure status by default; `/tools list` reads `GET /v1/tools`,
the daemon's live inventory. Activate/deactivate forms use the existing
authenticated exposure routes with explicit selected conversation scope. These narrow bridges return
only public status facts. Exposure options are entered in the activation/deactivation
forms; inline CLI option syntax is not parsed by Desktop. Source integration
is qualified separately from the managed runtime pin. Filtering an agent waits
for an active turn to finish; bare queries
remain available.

Bare `/mcp` reads the selected agent's existing runtime capability report and
shows configured/exposed server names plus MCP tool counts. It does not replace
Focus's richer live server details, browse/authentication flows, or lifecycle
operations; those remain pending.

`/skills` and `/skills <exact-id>` read the public `GET /v1/skills` catalog and
`GET /v1/skills/{id}` detail routes in the pinned runtime. The renderer receives
only the report text, not arbitrary HTTP or process access. Skill lifecycle
operations and configured-only skill entries remain unconnected.

Desktop also keeps the public `/learning` read surface even though current
Focus omits that renderer command. It reads suggestion status/inbox and exact
proposal detail through the public daemon API; review and apply remain operator
CLI actions. This explicit renderer-only read exception is tested rather than
silently treated as Focus command parity.

`/tokens` invokes `status tokens --session-id` and displays the canonical report
without recalculating usage. Live acceptance found that pinned PyPI returns
"Session was not found" for a daemon-created session which `sessions show` and
transcript export can read. Desktop reports token usage unavailable in this case;
resolving this runtime reporting failure remains a core limitation. `/export` turns Focus's export-command guidance into
a native save dialog backed by `export transcript --format md`. Both read saved
session state, including during a running turn. Export destinations stay in main.

Detailed status events now reach the renderer. The UI displays the runtime label,
detail, elapsed turn time, and time since the last event after a quiet interval.
It does not infer tool execution, model thinking, or progress percentages.

Focus model/effort selection, permissions, rooms, prompt queues, and live context
operate on interactive-runtime state. The pinned public CLI/daemon surface does
not provide a general Focus command dispatcher. Separate CLI reports or config
changes cannot stand in for those session operations.

The pinned 0.0.29 package contains public session turn-input queue,
approval-resume, trace stream attachment, and runtime capability routes. Desktop
now qualifies and consumes the request-bound approval semantics in source-runtime
proof. Known-trace response recovery uses status and replay attachment in the
current Desktop process, with explicit user action and no prompt resubmission.
A missing retained trace triggers canonical history readback, not an invented
terminal outcome. App-restart discovery and other workflows still require their own proof before being called connected. An approval grant alone does not
prove the original pending action resumed. Missing public semantics require an
explicit generic-owner dependency; Desktop must not import private Python runtime
code, start another interactive session, or duplicate those owners.

## Full GUI Workflow Scope

Parity covers every public semantic CLI/Focus capability, not every parser leaf
or terminal mechanic. Each capability needs a native GUI workflow, composer
workflow, shared-state mapping, presentation equivalent, version-unavailable
record, confirmed-gap record, or reviewed terminal-only disposition. Guided and
Advanced GUI workflows must cover applicable configuration, services,
channels/pairings, schedules, projects/delegation, extensions, memory, identity,
graphs, diagnostics, data maintenance and operator utilities. Preserve canonical
effects while presenting friendly labels and controls; an instruction to switch
to CLI does not complete a Desktop-supported workflow.

The 2026-09-12 assessment recorded 44 CLI command families and 243 leaf paths.
The paired 0.0.29 runtime has 56 built-in Focus commands. Desktop advertises 23
built-ins with partial semantics.
Bundled/user/project custom commands and shell intent add separate qualification
requirements. These counts are a dated source inventory, not execution proof.
Every static and dynamic GUI control needs an effective action, scope/error
behavior and actual Electron acceptance.

## Acceptance

Compare Focus and Desktop against the same daemon revision, configuration,
working directory, provider fixture, and equivalent isolated session state.
Do not use the locally installed CLI version as a substitute for the matched
daemon revision.

For every Desktop-supported semantic capability, cover valid and invalid input,
disconnected state, busy-turn behavior, permission decisions, and effective
state changes. Exercise pickers and other interactive continuations, not only
bare read-only forms. Assert catalog drift so additions require a disposition
instead of silently disappearing. Compare semantic results and durable effects
rather than terminal formatting.

Use actual Electron plus the daemon for GUI acceptance, including keyboard
entry, narrow-window controls, cancellation, task switching, and restart
recovery. Keep provider-free, live-provider, native-permission, and release
proof separate as defined in [Testing and Validation](testing-and-validation.md).

Full parity remains open until these checks pass. The current command subset
is documented in [Desktop Commands and Focus Parity](commands.md).

## October 11 scoped contract update

Custom command discovery and argument rendering now consume the existing
session-scoped Core routes. Returned prompts go through ordinary turn submission
without a second slash interpretation. Terminal-local expansion is rejected by
Core and fresh local drafts have no discoverable session yet.

Delegation verifies the exact installed command's parent-agent/session flags
before execution. Current Core source adds those flags to existing handlers;
inspection still requires its separate Core command. Resume remains unsupported.
Neither change updates the managed 0.0.29 runtime pin or establishes published
runtime compatibility. Queue draining, persisted model/policy selection,
workspace-aware resume and cold-start active-turn recovery remain open.
