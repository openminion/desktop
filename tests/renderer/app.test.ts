import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  applyActivityEvent,
  applySubmitResult,
  applyTurnEvent,
  assistantBody,
  captureRegionFromPercentages,
  captureStatusCopy,
  commandMatches,
  formatDesktopTurnUsage,
  initialChatState,
  listArtifacts,
  listSessions,
  messageTime,
  mount as mountRenderer,
  observationStatusCopy,
  readArtifact,
  recoverActivity,
  recoverSession,
  statusView,
  waitingTime,
} from "../../src/renderer/app.js";
import { renderTasks } from "../../src/renderer/tasks.js";
import { renderMarkdown } from "../../src/renderer/markdown.js";
import { setupResultMessage } from "../../src/renderer/profiles.js";
import type {
  ArtifactCatalogItemV1,
  ApprovalDecisionV1,
  ApprovalEventV1,
  CaptureEventV1,
  CaptureStateV1,
  ClientResult,
  DaemonStatus,
  MediaAttachmentV1,
  NativeApi,
  ObservationFrameFactV1,
  ObservationStatusV1,
  SessionSummaryV1,
  TurnEventV1,
} from "../../src/shared/contracts.js";

function mount(api: NativeApi, root: Document): Promise<void> {
  api.chatNames ??= namesApi();
  api.reports ??= { read: async () => ({ ok: true, value: { kind: "commands", commands: [] } }) };
  api.drafts ??= {
    load: async () => ({ ok: true, value: [] }),
    save: async () => ({ ok: true, value: "00000000-0000-4000-8000-000000000001" }),
  };
  api.presentation ??= {
    load: async () => ({ ok: true, value: { toolDisplay: "normal" } }),
    save: async () => ({ ok: true, value: null }),
  };
  api.runtime ??= {
    status: async () => ({
      source: "pypi",
      selectedSource: "pypi",
      installedVersion: "0.0.19",
      availableVersion: null,
      phase: "unchecked",
      paused: false,
      pinnedVersion: null,
    }),
    check: async () => ({
      source: "pypi",
      selectedSource: "pypi",
      installedVersion: "0.0.19",
      availableVersion: null,
      phase: "current",
      paused: false,
      pinnedVersion: null,
    }),
    stage: async () => ({
      ok: true,
      value: {
        source: "pypi",
        selectedSource: "pypi",
        installedVersion: "0.0.19",
        availableVersion: null,
        phase: "current",
        paused: false,
        pinnedVersion: null,
      },
    }),
    control: vi.fn(),
  };
  return mountRenderer(api, root);
}

function namesApi(): NativeApi["chatNames"] {
  const names = new Map<string, string>();
  return {
    load: async (legacyNames) => {
      for (const { sessionId, title } of legacyNames)
        if (!names.has(sessionId)) names.set(sessionId, title);
      return {
        ok: true,
        value: [...names].map(([sessionId, title]) => ({ sessionId, title })),
      };
    },
    save: async ({ sessionId, title }) => {
      if (title === null) names.delete(sessionId);
      else names.set(sessionId, title);
      return { ok: true, value: null };
    },
  };
}

describe("renderer computer observation", () => {
  it("discovers session commands and sends only their canonical rendered prompt", async () => {
    const api = approvalRendererApi(vi.fn());
    api.sessions.events = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { events: [], nextCursor: null, hasMore: false } });
    const commands = [
      { name: "/summarize", description: "Summarize notes", usage: "/summarize <notes>" },
    ];
    api.reports = {
      read: vi.fn(async (input) =>
        input.kind === "commands"
          ? { ok: true as const, value: { kind: "commands" as const, commands } }
          : {
              ok: true as const,
              value: { kind: "command" as const, prompt: "/literal prompt\nKeep  two spaces" },
            },
      ),
    };
    vi.mocked(api.turns.submit).mockResolvedValue({
      ok: true,
      value: { sessionId: "session-1", traceId: "trace-1", requestId: "request-1" },
    });
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      page.element("composer").value = "/summarize first  second";
      page.element("composer-form").dispatch("submit");
      await vi.waitFor(() => expect(api.turns.submit).toHaveBeenCalledOnce());
      expect(api.reports.read).toHaveBeenCalledWith({
        kind: "command",
        sessionId: "session-1",
        commandName: "/summarize",
        arguments: "first  second",
      });
      expect(api.turns.submit).toHaveBeenCalledWith(
        expect.objectContaining({ message: "/literal prompt\nKeep  two spaces" }),
      );
      expect(commandMatches("/summ", commands).map((item) => item.name)).toEqual(["/summarize"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a custom-command draft when Core refuses local expansion", async () => {
    const api = approvalRendererApi(vi.fn());
    api.sessions.events = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { events: [], nextCursor: null, hasMore: false } });
    api.reports = {
      read: vi.fn(async (input) =>
        input.kind === "commands"
          ? {
              ok: true as const,
              value: {
                kind: "commands" as const,
                commands: [{ name: "/local", description: "Local", usage: "/local" }],
              },
            }
          : {
              ok: false as const,
              error: {
                code: "unsupported_custom_command_expansion",
                message: "This command requires terminal-local file or shell expansion.",
                retryable: false,
                retryAfterMs: null,
              },
            },
      ),
    };
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      page.element("composer").value = "/local";
      page.element("composer-form").dispatch("submit");
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.textContent).toBe(
          "This command requires terminal-local file or shell expansion.",
        ),
      );
      expect(page.element("composer").value).toBe("/local");
      expect(api.turns.submit).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not replace an edited draft with a delayed custom command", async () => {
    const api = approvalRendererApi(vi.fn());
    api.sessions.events = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { events: [], nextCursor: null, hasMore: false } });
    let finish!: (value: unknown) => void;
    api.reports = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          value: {
            kind: "commands",
            commands: [{ name: "/notes", description: "Notes", usage: "/notes" }],
          },
        })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        ),
    };
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      page.element("composer").value = "/notes";
      page.element("composer-form").dispatch("submit");
      await vi.waitFor(() => expect(api.reports.read).toHaveBeenCalledTimes(2));
      page.element("composer").value = "My revised draft";
      finish({ ok: true, value: { kind: "command", prompt: "Old expanded prompt" } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(page.element("composer").value).toBe("My revised draft");
      expect(api.turns.submit).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens a scoped tool form with approval unselected and submits only on user action", async () => {
    const api = approvalRendererApi(vi.fn());
    api.sessions.events = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { events: [], nextCursor: null, hasMore: false } });
    api.tools = {
      control: vi.fn().mockResolvedValue({ ok: true, value: { text: "Activated: web (audit-1)" } }),
    };
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      page.element("composer").value = "/tools activate web";
      page.element("composer-form").dispatch("submit");
      const form = page
        .element("command-result")
        .descendants()
        .find((item) => item.tagName === "form")!;
      expect(form).toBeDefined();
      const approval = form.descendants().find((item) => item.type === "checkbox")!;
      expect(approval.checked).toBe(false);
      expect(api.tools.control).not.toHaveBeenCalled();
      approval.checked = true;
      form.dispatch("submit");
      await vi.waitFor(() => expect(api.tools.control).toHaveBeenCalledOnce());
      expect(api.tools.control).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-1",
          action: "activate",
          profileId: "web",
          approved: true,
        }),
      );
      expect(api.turns.submit).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loads and saves quiet/normal as Desktop presentation preferences", async () => {
    const save = vi.fn<NativeApi["presentation"]["save"]>(async () => ({
      ok: true,
      value: null,
    }));
    const api = {
      app: { info: async () => ({ shellVersion: "test" }) },
      daemon: { status: async () => status({ state: "degraded" }) },
      turns: { subscribe: () => () => {} },
      presentation: {
        load: vi.fn(async () => ({ ok: true, value: { toolDisplay: "quiet" } })),
        save,
      },
    } as unknown as NativeApi;
    const page = new FixtureDocument();
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      await mount(api, page.asDocument());
      expect(api.presentation.load).toHaveBeenCalledOnce();
      expect(page.element("chat-display").value).toBe("quiet");
      page.element("composer").value = "/normal";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ toolDisplay: "normal" }));
      page.element("composer").value = "/quiet";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ toolDisplay: "quiet" }));
      await vi.waitFor(() => expect(page.element("chat-display").value).toBe("quiet"));
      for (const [command, expected] of [
        ["/verbose", "verbose"],
        ["/details", "normal"],
        ["/details toggle", "verbose"],
        ["/details off", "normal"],
        ["/details on", "verbose"],
        ["/details quiet", "quiet"],
        ["/details", "verbose"],
        ["/details normal", "normal"],
        ["/details full", "verbose"],
        ["/details concise", "normal"],
        ["/details details", "verbose"],
        ["/details verbose", "verbose"],
      ]) {
        save.mockClear();
        page.element("composer").value = command!;
        page.element("composer").dispatch("keydown", { key: "Enter" });
        await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ toolDisplay: expected }));
        await vi.waitFor(() => expect(page.element("chat-display").disabled).toBe(false));
        expect(page.element("chat-display").value).toBe(expected);
      }
      save.mockClear();
      for (const command of ["/details never", "/details on off", "/verbose extra"]) {
        page.element("composer").value = command;
        page.element("composer").dispatch("keydown", { key: "Enter" });
        await Promise.resolve();
        expect(save).not.toHaveBeenCalled();
        expect(page.element("chat-display").value).toBe("verbose");
      }
      page.element("chat-display").value = "normal";
      page.element("chat-display").dispatch("change");
      await vi.waitFor(() =>
        expect(page.element("chat-display-status").textContent).toBe("Saved."),
      );
      expect(page.element("chat-display").value).toBe("normal");
      save.mockResolvedValueOnce({
        ok: false,
        error: {
          code: "storage_error",
          message: "Could not save preference",
          retryable: false,
          retryAfterMs: null,
        },
      });
      page.element("chat-display").value = "quiet";
      page.element("chat-display").dispatch("change");
      await vi.waitFor(() =>
        expect(page.element("chat-display-status").textContent).toBe("Could not save preference"),
      );
      expect(page.element("chat-display").value).toBe("normal");
      expect(page.element("chat-display").disabled).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("projects paused/pinned preparation and dispatches narrow runtime controls", async () => {
    const page = new FixtureDocument();
    const current = {
      source: "pypi" as const,
      selectedSource: "pypi" as const,
      installedVersion: "0.0.21",
      availableVersion: "0.0.22",
      phase: "pending" as const,
      paused: true,
      pinnedVersion: "0.0.21",
    };
    const control = vi.fn<NativeApi["runtime"]["control"]>(async () => ({
      ok: true as const,
      value: current,
    }));
    const api = {
      app: { info: async () => ({ shellVersion: "test" }) },
      daemon: {
        status: async () => status({ state: "running", reachable: true }),
      },
      turns: { subscribe: () => () => {} },
      runtime: {
        status: async () => current,
        check: vi.fn(),
        stage: vi.fn(),
        control,
      },
    } as unknown as NativeApi;
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      await mount(api, page.asDocument());
      expect(page.element("runtime-update-status").textContent).toContain(
        "Upgrades are paused, including prepared updates",
      );
      expect(page.element("runtime-update-status").textContent).toContain("Pinned to 0.0.21");
      expect(page.element("installed-runtime-version").textContent).toBe("0.0.21");
      expect(page.element("daemon-version").textContent).toBe("Not reported");
      expect(page.element("protocol-version").textContent).toBe("Not reported");
      expect(page.element("shell-version").textContent).toBe("test");
      expect(page.element("pause-runtime-update").textContent).toBe("Resume upgrades");
      expect(page.element("stage-runtime-update").disabled).toBe(true);
      expect(page.element("discard-runtime-update").hidden).toBe(false);
      page.element("pause-runtime-update").click();
      page.element("discard-runtime-update").click();
      page.element("unpin-runtime").click();
      page.element("pin-installed-runtime").click();
      page.element("runtime-pin-version").value = " 0.0.22 ";
      page.element("pin-runtime-version").click();
      expect(control.mock.calls.map(([input]) => input)).toEqual([
        { action: "resume" },
        { action: "discard" },
        { action: "unpin" },
        { action: "pin-installed" },
        { action: "pin", version: "0.0.22" },
      ]);
      await Promise.resolve();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each(["available", "check_failed"] as const)(
    "refreshes automatic update completion while details stay open (%s)",
    async (phase) => {
      const page = new FixtureDocument();
      let current: Awaited<ReturnType<NativeApi["runtime"]["status"]>> = {
        source: "pypi",
        selectedSource: "pypi",
        installedVersion: "0.0.19",
        availableVersion: null,
        phase: "checking",
        paused: false,
        pinnedVersion: null,
      };
      const runtimeStatus = vi.fn(async () => current);
      const hide: Array<() => void> = [];
      const api = {
        app: { info: async () => ({ shellVersion: "test" }) },
        daemon: {
          status: async () => status({ state: "running", reachable: true }),
        },
        turns: { subscribe: () => () => {} },
        runtime: { status: runtimeStatus, check: vi.fn(), stage: vi.fn() },
      } as unknown as NativeApi;
      vi.useFakeTimers();
      vi.stubGlobal("window", {
        addEventListener(type: string, listener: () => void) {
          if (type === "pagehide") hide.push(listener);
        },
      });
      try {
        await mount(api, page.asDocument());
        page.element("connection-details").open = true;
        page.element("connection-details").dispatch("toggle");
        await vi.advanceTimersByTimeAsync(0);
        expect(page.element("check-runtime-update").disabled).toBe(true);
        expect(page.element("runtime-update-status").textContent).toContain(
          "Installed: OpenMinion 0.0.19 (pypi)",
        );
        expect(page.element("installed-runtime-version").textContent).toBe("0.0.19");
        current = {
          ...current,
          installedVersion: null,
          availableVersion: phase === "available" ? "1.0.0" : null,
          phase,
        };
        await vi.advanceTimersByTimeAsync(2_000);
        expect(page.element("installed-runtime-version").textContent).toBe("Not detected");
        expect(page.element("check-runtime-update").disabled).toBe(false);
        expect(page.element("runtime-update-status").textContent).toContain(
          phase === "available" ? "1.0.0 is available" : "Could not check",
        );
        expect(page.element("stage-runtime-update").hidden).toBe(phase !== "available");
        hide[0]!();
        const count = runtimeStatus.mock.calls.length;
        await vi.advanceTimersByTimeAsync(4_000);
        expect(runtimeStatus).toHaveBeenCalledTimes(count);
        expect(api.runtime.check).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    },
  );

  it("selects a future runtime source without relabeling the active runtime", async () => {
    const page = new FixtureDocument();
    const current = {
      source: "pypi" as const,
      selectedSource: "pypi" as const,
      installedVersion: "0.0.23",
      availableVersion: null,
      phase: "current" as const,
      paused: false,
      pinnedVersion: null,
    };
    const control = vi.fn<NativeApi["runtime"]["control"]>(async () => ({
      ok: true,
      value: { ...current, selectedSource: "binary" },
    }));
    const api = {
      app: { info: async () => ({ shellVersion: "test" }) },
      daemon: {
        status: async () => status({ state: "running", reachable: true }),
      },
      turns: { subscribe: () => () => {} },
      runtime: {
        status: async () => current,
        check: vi.fn(),
        stage: vi.fn(),
        control,
      },
    } as unknown as NativeApi;
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      await mount(api, page.asDocument());
      const source = page.element("runtime-update-source");
      source.value = "binary";
      source.dispatch("change");
      expect(control).toHaveBeenCalledWith({
        action: "source",
        source: "binary",
      });
      await Promise.resolve();
      expect(page.element("runtime-update-status").textContent).toContain(
        "Installed: OpenMinion 0.0.23 (pypi)",
      );
      expect(page.element("runtime-update-status").textContent).toContain(
        "Update source: native runtime",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("validates percentage regions and uses safe lifecycle copy", () => {
    expect(captureRegionFromPercentages(["10", "20", "40", "50"])).toEqual({
      xBps: 1000,
      yBps: 2000,
      widthBps: 4000,
      heightBps: 5000,
    });
    expect(captureRegionFromPercentages(["80", "0", "30", "100"])).toBeNull();
    expect(captureRegionFromPercentages(["0", "0", "0", "100"])).toBeNull();
    expect(captureRegionFromPercentages(["0", "0", "0.004", "100"])).toBeNull();
    expect(captureRegionFromPercentages(["99.995", "0", "0.005", "100"])).toBeNull();
    expect(captureStatusCopy(null, false)).toContain("Choose a session");
    expect(
      captureStatusCopy(
        captureState({
          state: "blocked",
          reason: "permission_denied",
          permission: "denied",
        }),
        true,
      ),
    ).toBe("Screen recording permission was denied.");
    expect(observationStatusCopy(null, false)).toContain("Choose a session");
    expect(
      observationStatusCopy(
        observationState({
          state: "waiting",
          watchEnabled: true,
          trigger: "changes",
        }),
        true,
      ),
    ).toContain("changed frame");
  });

  it("keeps the Computer panel labeled, local-only, and same-origin", () => {
    const html = readFileSync(new URL("../../src/renderer/index.html", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../../src/renderer/styles.css", import.meta.url), "utf8");
    expect(html).toContain('aria-label="OpenMinion workspace"');
    expect(html).toContain("Private agent workspace");
    expect(html).toContain("Local only");
    expect(html).toContain('class="composer-tools"');
    expect(html).toContain('class="composer-submit-actions"');
    expect(html).toContain('id="screen-share-panel"');
    expect(html).toContain('class="watch-settings"');
    expect(html).toContain('class="secondary-tool file-workspace"');
    expect(html).toContain('class="secondary-tool artifact-workspace"');
    expect(html).toContain('rows="2"');
    expect(html).toContain('class="source-toggle"');
    expect(html).toContain('<legend class="sr-only">Share source</legend>');
    expect(html).toContain('aria-label="Computer observation"');
    expect(html).toContain("img-src 'self'");
    expect(html).not.toMatch(/unsafe-inline|unsafe-eval|getDisplayMedia|Send to OpenMinion/);
    expect(html).toContain("Preview stays local");
    for (const id of [
      "capture-source-kind",
      "capture-region-x",
      "capture-region-y",
      "capture-region-width",
      "capture-region-height",
      "include-current-view",
      "observation-instruction",
      "observation-trigger",
    ])
      expect(html).toContain(`for="${id}"`);
    expect(html).toContain("On change");
    expect(html).toContain("Every 30 seconds");
    expect(html).toContain("Stop watch");
    expect(html).toContain(
      "Screenshot delivery, guidance, and Automatic watch are planned but not connected",
    );
    expect(html).not.toContain("share the latest frame with the AI");
    expect(html).not.toContain("may use model tokens");
    expect(html).toContain("Ask for guidance");
    expect(html).toContain("Advice only — you remain in control.");
    expect(html).toContain('id="guidance-card" class="guidance-card" role="status"');
    expect(html).toContain('<span id="guidance-state" class="capture-state">Current</span>');
    expect(styles).toContain("button:focus-visible");
    expect(styles).toContain("@media (max-width: 1120px)");
  });

  it("separates model connections from identity inspection and editing", () => {
    const html = readFileSync(new URL("../../src/renderer/index.html", import.meta.url), "utf8");
    expect(html).toContain("Models &amp; credentials");
    expect(html).toContain('id="settings-identity"');
    expect(html).toContain('id="identity-agent"');
    expect(html).toContain('id="identity-yaml"');
    expect(html).toContain('id="identity-reload"');
    expect(html).toContain('id="identity-verify"');
    expect(html).toContain('id="identity-save"');
    expect(html).toContain('id="identity-preview"');
  });
});

function status(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    state: "idle",
    reachable: false,
    daemonVersion: null,
    protocol: null,
    configId: null,
    capabilities: [],
    errorCode: null,
    ...overrides,
  };
}

describe("renderer status view", () => {
  it.each([
    [
      "verified",
      true,
      "Connection verified. New conversations use the default agent; existing conversations keep their agent.",
    ],
    [
      "not_requested",
      true,
      "Connection not tested. New conversations use the default agent; existing conversations keep their agent.",
    ],
    [
      "verified",
      false,
      "Connection verified. Settings were saved, but OpenMinion could not reconnect. Check the connection details.",
    ],
    [
      "not_requested",
      false,
      "Connection not tested. Settings were saved, but OpenMinion could not reconnect. Check the connection details.",
    ],
  ] as const)("reports %s setup when reachable=%s", (providerCheck, reachable, message) => {
    expect(setupResultMessage(providerCheck, reachable)).toBe(message);
  });

  it("omits unknown message times and uses the local weekday and time for saved messages", () => {
    expect(messageTime()).toBe("");
    expect(messageTime("invalid")).toBe("");
    const date = new Date(2026, 8, 13, 14, 2);
    expect(messageTime(date.toISOString())).toBe(
      date.toLocaleString(undefined, {
        weekday: "long",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  });
  it("copies each message body without its role or profile and reports failure", async () => {
    const copyText = vi.fn().mockResolvedValue({ ok: true, value: null });
    const api = {
      app: { info: async () => ({ shellVersion: "test" }), copyText },
      daemon: {
        status: async () =>
          status({
            state: "running",
            reachable: true,
            capabilities: ["turns.text"],
          }),
      },
      sessions: {
        list: async () => ({
          ok: true,
          value: {
            sessions: [sessionSummary()],
            nextCursor: null,
            hasMore: false,
          },
        }),
        load: async () => ({
          ok: true,
          value: {
            session: sessionSummary(),
            messages: [
              {
                ...message("question", "First line\nSecond line"),
                role: "user",
              },
              {
                ...message("reply", "minimax: **Answer**\n\n```python\nprint('hello')\n```"),
                profileName: "minimax",
              },
            ],
            nextMessageCursor: null,
            messagesHasMore: false,
          },
        }),
        events: async () => ({
          ok: true,
          value: { events: [], nextCursor: "0", hasMore: false },
        }),
      },
      turns: { subscribe: () => () => {} },
    } as unknown as NativeApi;
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      const buttons = page
        .element("timeline")
        .descendants()
        .filter((item) => item.title === "Copy message");
      expect(buttons).toHaveLength(2);
      const times = page
        .element("timeline")
        .descendants()
        .filter((item) => item.className === "message-time");
      expect(times).toHaveLength(2);
      expect(
        times.every(
          (item) => !item.hidden && item.textContent === messageTime("2026-08-19T00:00:01Z"),
        ),
      ).toBe(true);
      buttons[0]!.click();
      await vi.waitFor(() => expect(buttons[0]!.textContent).toBe("Copied"));
      expect(copyText).toHaveBeenLastCalledWith("First line\nSecond line");
      buttons[1]!.click();
      await vi.waitFor(() => expect(buttons[1]!.textContent).toBe("Copied"));
      expect(copyText).toHaveBeenLastCalledWith("**Answer**\n\n```python\nprint('hello')\n```");
      const codeCopy = page
        .element("timeline")
        .descendants()
        .find((item) => item.title === "Copy code")!;
      codeCopy.click();
      await vi.waitFor(() => expect(codeCopy.textContent).toBe("Copied"));
      expect(copyText).toHaveBeenLastCalledWith("print('hello')\n");
      await vi.waitFor(() => expect(buttons[1]!.disabled).toBe(false), {
        timeout: 2500,
      });
      expect(buttons[1]!.textContent).toBe("Copy");
      copyText.mockResolvedValueOnce({ ok: false });
      buttons[1]!.click();
      await vi.waitFor(() => expect(buttons[1]!.textContent).toBe("Copy failed"));
      copyText.mockRejectedValueOnce(new Error("Clipboard unavailable"));
      buttons[0]!.click();
      await vi.waitFor(() => expect(buttons[0]!.textContent).toBe("Copy failed"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("offers exact code separately from Markdown and keeps code and language labels literal", () => {
    const page = new FixtureDocument();
    const body = page.createElement("div");
    const copyCode = vi.fn<(code: string) => HTMLButtonElement>(
      () => page.createElement("button") as unknown as HTMLButtonElement,
    );
    renderMarkdown(
      page.asDocument(),
      body as unknown as HTMLElement,
      '```<img> extra metadata\n  <script>alert("x")</script>\n\n```\n\n    indented code\n\n`inline`',
      copyCode,
    );
    expect(copyCode.mock.calls.map(([code]) => code)).toEqual([
      '  <script>alert("x")</script>\n\n',
      "indented code\n",
    ]);
    const nodes = body.descendants();
    expect(nodes.filter((node) => node.tagName === "pre")).toHaveLength(2);
    expect(nodes.some((node) => node.tagName === "script" || node.tagName === "img")).toBe(false);
    expect(
      nodes
        .filter((node) => node.className === "code-header")
        .map((node) => node.children[0]!.textContent),
    ).toEqual(["<img>", "Code"]);
  });

  it("clears a sending draft immediately, preserves new typing, and keeps terminal errors after refresh", async () => {
    let finishSubmit!: (result: Awaited<ReturnType<NativeApi["turns"]["submit"]>>) => void;
    const submit = vi.fn<NativeApi["turns"]["submit"]>(
      () =>
        new Promise((resolve) => {
          finishSubmit = resolve;
        }),
    );
    let receive!: (event: TurnEventV1) => void;
    const load = vi.fn(async () => ({
      ok: true,
      value: {
        session: sessionSummary(),
        messages: [{ ...message("question", "Weather?"), role: "user" }],
        nextMessageCursor: null,
        messagesHasMore: false,
      },
    }));
    const api = {
      app: { info: async () => ({ shellVersion: "test" }) },
      daemon: {
        status: async () =>
          status({
            state: "running",
            reachable: true,
            capabilities: ["turns.text"],
          }),
      },
      sessions: {
        list: async () => ({
          ok: true,
          value: {
            sessions: [sessionSummary()],
            nextCursor: null,
            hasMore: false,
          },
        }),
        load,
        events: async () => ({
          ok: true,
          value: { events: [], nextCursor: "0", hasMore: false },
        }),
      },
      turns: {
        submit,
        subscribe: (listener: typeof receive) => {
          receive = listener;
          return () => {};
        },
      },
    } as unknown as NativeApi;
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      const composer = page.element("composer");
      const failure = {
        code: "turn_timeout",
        message: "Turn execution timed out after 45.00 seconds.",
        retryable: true,
        retryAfterMs: null,
      };
      for (const nextDraft of ["", "New draft"]) {
        composer.value = "Weather?";
        composer.dispatch("input");
        page.element("composer-form").dispatch("submit");
        await vi.waitFor(() => expect(composer.value).toBe(""));
        expect(page.sessionButtons()[0]!.children[0]!.hidden).toBe(false);
        composer.value = nextDraft;
        composer.dispatch("input");
        finishSubmit({ ok: false, error: failure });
        await vi.waitFor(() =>
          expect(page.element("chat-status").textContent).toBe(failure.message),
        );
        expect(composer.value).toBe(nextDraft || "Weather?");
        expect(page.sessionButtons()[0]!.children[0]!.hidden).toBe(true);
      }
      composer.value = "Weather?";
      composer.dispatch("input");
      page.element("composer-form").dispatch("submit");
      await vi.waitFor(() => expect(composer.value).toBe(""));
      // A deliberate repeat typed while sending is a new draft, even when its text matches.
      composer.value = "Weather?";
      composer.dispatch("input");
      finishSubmit({
        ok: true,
        value: {
          sessionId: "session-1",
          traceId: "trace-1",
          requestId: "request-1",
        },
      });
      await vi.waitFor(() => expect(page.element("chat-status").textContent).toBe("Working…"));
      expect(composer.value).toBe("Weather?");
      receive({
        schemaVersion: 1,
        kind: "error",
        sessionId: "session-1",
        traceId: "trace-1",
        error: failure,
      });
      receive({
        schemaVersion: 1,
        kind: "done",
        sessionId: "session-1",
        traceId: "trace-1",
        outcome: "error",
      });
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(page.element("send").disabled).toBe(false));
      expect(page.element("chat-status").textContent).toBe(failure.message);
      expect(page.element("chat-status").className).toContain("error");
      expect(page.element("chat-progress").hidden).toBe(false);
      expect(composer.value).toBe("Weather?");
      expect(submit).toHaveBeenCalledTimes(3);
      expect(page.sessionButtons()[0]!.children[0]!.hidden).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads, refreshes, copies and dismisses diagnostics while disconnected", async () => {
    const inspect = vi.fn<NativeApi["daemon"]["inspect"]>().mockResolvedValue({
      ok: true,
      value: { text: "<script>literal log entry</script>" },
    });
    const copyText = vi.fn().mockResolvedValue({ ok: true, value: null });
    const api = {
      app: { info: async () => ({ shellVersion: "test" }), copyText },
      daemon: {
        status: async () => status({ state: "degraded", reachable: false }),
        inspect,
      },
      turns: { subscribe: () => () => {} },
    } as unknown as NativeApi;
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      page.element("composer").value = "Keep my draft";
      page.element("show-daemon-logs").click();
      await vi.waitFor(() => expect(page.element("show-daemon-logs").disabled).toBe(false));
      expect(inspect).toHaveBeenCalledExactlyOnceWith("logs");
      const result = page.element("diagnostics-result");
      expect(page.element("diagnostics-dialog").open).toBe(true);
      expect(page.element("diagnostics-title").textContent).toBe("Daemon logs");
      expect(page.element("command-result").children).toHaveLength(0);
      expect(page.element("conversation").scrollIntoView).not.toHaveBeenCalled();
      expect(result.children.find((item) => item.tagName === "pre")?.textContent).toBe(
        "<script>literal log entry</script>",
      );
      result
        .descendants()
        .find((item) => item.textContent === "Copy")!
        .click();
      await vi.waitFor(() =>
        expect(copyText).toHaveBeenCalledWith("<script>literal log entry</script>"),
      );
      inspect.mockResolvedValueOnce({
        ok: false,
        error: {
          code: "diagnostics_unavailable",
          message: "Log unavailable",
          retryable: false,
          retryAfterMs: null,
        },
      });
      result
        .descendants()
        .find((item) => item.textContent === "Refresh")!
        .click();
      await vi.waitFor(() => expect(result.children[0]?.textContent).toBe("Log unavailable"));
      expect(result.descendants().some((item) => item.textContent === "Refresh")).toBe(true);
      expect(result.descendants().some((item) => item.textContent === "Copy")).toBe(false);
      let resolve!: (value: Awaited<ReturnType<NativeApi["daemon"]["inspect"]>>) => void;
      inspect.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      page.element("show-daemon-status").click();
      expect(page.element("show-daemon-logs").disabled).toBe(true);
      page.element("close-diagnostics").click();
      resolve({ ok: true, value: { text: "Late status" } });
      await vi.waitFor(() => expect(page.element("show-daemon-logs").disabled).toBe(false));
      expect(page.element("diagnostics-dialog").open).toBe(false);
      expect(page.element("settings-runtime-button").focus).toHaveBeenCalled();
      expect(result.descendants().some((item) => item.textContent === "Late status")).toBe(false);
      expect(page.element("composer").value).toBe("Keep my draft");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refreshes the session picker without replacing the chat and ignores failed or stale reads", async () => {
    const original = sessionSummary();
    const fresh = {
      ...original,
      sessionId: "external-session",
      title: original.title,
      channel: "cli",
      messageCount: 0,
      updatedLabel: "2m",
    };
    const list = vi.fn<NativeApi["sessions"]["list"]>().mockResolvedValue({
      ok: true,
      value: { sessions: [original], nextCursor: null, hasMore: false },
    });
    const load = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      ok: true,
      value: {
        session: sessionId === original.sessionId ? original : fresh,
        messages: [message("reply", "Saved reply")],
        nextMessageCursor: null,
        messagesHasMore: false,
      },
    }));
    const api = {
      app: { info: async () => ({ shellVersion: "test" }) },
      daemon: {
        status: async () =>
          status({ state: "running", reachable: true, capabilities: ["turns.text"] }),
      },
      sessions: {
        list,
        load,
        events: async () => ({ ok: true, value: { events: [], nextCursor: null, hasMore: false } }),
      },
      reports: { read: async () => ({ ok: true, value: { kind: "status", session: fresh } }) },
      turns: { subscribe: () => () => {} },
    } as unknown as NativeApi;
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      const command = (text: string) => {
        page.element("composer").value = text;
        page.element("composer").dispatch("keydown", { key: "Enter" });
      };
      list.mockResolvedValueOnce({
        ok: true,
        value: { sessions: [original], nextCursor: "next", hasMore: true },
      });
      list.mockResolvedValueOnce({
        ok: true,
        value: { sessions: [fresh], nextCursor: null, hasMore: false },
      });
      command("/sessions");
      await vi.waitFor(() => expect(page.element("command-result").children).toHaveLength(4));
      expect(list).toHaveBeenLastCalledWith({ cursor: "next", limit: 100 });
      expect(page.element("command-result").children[3]!.children[1]!.textContent).toBe(
        "external-session",
      );
      expect(page.element("command-result").children[3]!.children[2]!.textContent).toContain(
        "Channel: cli · Messages: 0 · Updated: 2m",
      );
      expect(page.element("command-result").children[2]!.getAttribute("aria-current")).toBe("true");
      expect(page.sessionButtons()).toHaveLength(1);
      expect(load).toHaveBeenCalledTimes(1);
      expect(page.findText()).toContain("Saved reply");
      const freshButton = page.element("command-result").children[3]!;
      list.mockResolvedValueOnce({
        ok: true,
        value: { sessions: [fresh], nextCursor: "next", hasMore: true },
      });
      list.mockResolvedValueOnce({
        ok: false,
        error: {
          code: "connection_lost",
          message: "Catalog unavailable",
          retryable: true,
          retryAfterMs: null,
        },
      });
      command("/sessions");
      await vi.waitFor(() =>
        expect(page.element("command-title").textContent).toBe("Conversations unavailable"),
      );
      expect(page.element("command-result").children).toHaveLength(2);
      expect(page.sessionButtons()).toHaveLength(1);
      expect(page.findText()).toContain("Saved reply");
      expect(load).toHaveBeenCalledTimes(1);
      for (const supersede of ["dismiss", "command", "selection", "repeat"]) {
        let finish!: (value: Awaited<ReturnType<NativeApi["sessions"]["list"]>>) => void;
        list.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
        command("/sessions");
        if (supersede === "dismiss")
          page.element("composer").dispatch("keydown", { key: "Escape" });
        else if (supersede === "command") command("/status");
        else if (supersede === "selection") freshButton.click();
        else command("/sessions");
        await new Promise((resolve) => setTimeout(resolve, 0));
        const title = page.element("command-title").textContent;
        const hidden = page.element("command-panel").hidden;
        finish({
          ok: false,
          error: {
            code: "connection_lost",
            message: "Stale failure",
            retryable: true,
            retryAfterMs: null,
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(page.element("command-title").textContent).toBe(title);
        expect(page.element("command-panel").hidden).toBe(hidden);
        expect(page.element("command-result").children[0]?.textContent).not.toBe("Stale failure");
      }
      expect(load).toHaveBeenLastCalledWith(
        expect.objectContaining({ sessionId: "external-session" }),
      );
      expect(page.sessionButtons()).toHaveLength(2);
      expect(page.sessionButtons()[1]!.className).toContain("selected");
      command("/status");
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.textContent).toContain(
          "Channel: cli\nMessages: 0",
        ),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("browses the complete stored skill catalog without losing drafts or accepting stale reports", async () => {
    const session = sessionSummary();
    const other = { ...session, sessionId: "other" };
    const read = vi.fn();
    const api = {
      app: {
        info: async () => ({ shellVersion: "test" }),
        copyText: vi.fn().mockResolvedValue({ ok: true, value: null }),
      },
      daemon: {
        status: async () =>
          status({ state: "running", reachable: true, capabilities: ["turns.text"] }),
      },
      sessions: {
        list: async () => ({
          ok: true,
          value: { sessions: [session, other], nextCursor: null, hasMore: false },
        }),
        load: async ({ sessionId }: { sessionId: string }) => ({
          ok: true,
          value: {
            session: sessionId === other.sessionId ? other : session,
            messages: [],
            nextMessageCursor: null,
            messagesHasMore: false,
          },
        }),
        events: async () => ({ ok: true, value: { events: [], nextCursor: null, hasMore: false } }),
      },
      reports: { read },
      turns: { subscribe: () => () => {} },
    } as unknown as NativeApi;
    read.mockResolvedValue({ ok: true, value: { kind: "commands", commands: [] } });
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      const skills = [...Array.from({ length: 24 }, (_, i) => `skill-${i}`), "--help"];
      const catalog = { ok: true, value: { kind: "skills", agentId: "fresh-agent", skills } };
      read.mockResolvedValue(catalog);
      page.element("composer").value = "/skills";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.children).toHaveLength(25),
      );
      expect(page.element("command-title").textContent).toBe("Stored skills for fresh-agent");
      page.element("conversation").scrollHeight = 1000;
      page.element("conversation").clientHeight = 400;
      page.element("conversation").dispatch("scroll");
      expect(page.element("jump-latest").hidden).toBe(true);
      expect(read).toHaveBeenLastCalledWith({ kind: "skills", sessionId: session.sessionId });
      page.element("command-result").children[1]!.click();
      await vi.waitFor(() =>
        expect(api.app.copyText).toHaveBeenCalledWith(
          `Stored skills for fresh-agent:\n${skills.join("\n")}`,
        ),
      );
      page.element("composer").value = "Keep my skill draft";
      page.element("composer").dispatch("input");
      read.mockResolvedValueOnce({
        ok: true,
        value: { kind: "skills", text: "Skill: Help reference" },
      });
      page.element("command-result").children[0]!.children[24]!.click();
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.textContent).toBe(
          "Skill: Help reference",
        ),
      );
      expect(read).toHaveBeenLastCalledWith({ kind: "skills", skillId: "--help" });
      expect(page.element("composer").value).toBe("Keep my skill draft");
      expect(page.element("command-title").textContent).toBe("Skill details");
      page.element("command-result").children[2]!.click();
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.children).toHaveLength(25),
      );
      expect(page.element("composer").value).toBe("Keep my skill draft");
      read.mockResolvedValueOnce({
        ok: false,
        error: {
          code: "report_unavailable",
          message: "Skill unavailable",
          retryable: false,
          retryAfterMs: null,
        },
      });
      page.element("command-result").children[0]!.children[24]!.click();
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.textContent).toBe("Skill unavailable"),
      );
      expect(page.element("command-result").children[2]?.textContent).toBe("Back to catalog");
      read.mockResolvedValueOnce({
        ok: true,
        value: { kind: "skills", agentId: "fresh-agent", skills: [] },
      });
      page.element("command-result").children[2]!.click();
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.textContent).toBe(
          "No stored skills for this agent.",
        ),
      );
      expect(page.element("composer").value).toBe("Keep my skill draft");
      let finishSkills!: (value: unknown) => void;
      for (const action of ["dismiss", "replace", "selection"]) {
        read.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishSkills = resolve;
            }),
        );
        page.element("composer").value = "/skills";
        page.element("composer").dispatch("keydown", { key: "Enter" });
        if (action === "dismiss") {
          page.element("close-command").click();
          expect(page.element("jump-latest").hidden).toBe(false);
        } else if (action === "replace") {
          page.element("composer").value = "/help";
          page.element("composer").dispatch("keydown", { key: "Enter" });
        } else {
          page.sessionButtons()[1]!.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        finishSkills(catalog);
        await Promise.resolve();
        expect(page.element("command-result").children[0]?.children).toHaveLength(0);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads fresh status without replacing chat and settles across same-session turn completion", async () => {
    const session = sessionSummary();
    const other = { ...session, sessionId: "other", title: "Other" };
    const fresh = {
      ...session,
      status: "paused" as const,
      channel: "cli",
      messageCount: 8,
      updatedAt: "2026-10-13T12:00:00Z",
    };
    const read = vi
      .fn<NativeApi["reports"]["read"]>()
      .mockResolvedValue({ ok: true, value: { kind: "status", session: fresh } });
    let receive!: (event: TurnEventV1) => void;
    const load = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      ok: true,
      value: {
        session: sessionId === session.sessionId ? session : other,
        messages: [message("reply", "Saved reply")],
        nextMessageCursor: null,
        messagesHasMore: false,
      },
    }));
    const api = {
      app: { info: async () => ({ shellVersion: "test" }) },
      daemon: {
        status: async () =>
          status({ state: "running", reachable: true, capabilities: ["turns.text"] }),
      },
      sessions: {
        list: async () => ({
          ok: true,
          value: { sessions: [session, other], nextCursor: null, hasMore: false },
        }),
        load,
        events: async () => ({ ok: true, value: { events: [], nextCursor: null, hasMore: false } }),
      },
      reports: { read },
      turns: {
        subscribe: (listener: typeof receive) => {
          receive = listener;
          return () => {};
        },
        submit: async () => ({
          ok: true,
          value: { sessionId: session.sessionId, traceId: "trace", requestId: "request" },
        }),
      },
    } as unknown as NativeApi;
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      const command = (text = "/status") => {
        page.element("composer").value = text;
        page.element("composer").dispatch("keydown", { key: "Enter" });
      };
      command();
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.textContent).toContain("State: paused"),
      );
      expect(read).toHaveBeenLastCalledWith({ kind: "status", sessionId: session.sessionId });
      expect(page.element("command-result").children[0]?.textContent).toContain(
        "Messages: 8\nUpdated: 2026-10-13T12:00:00Z",
      );
      expect(load).toHaveBeenCalledTimes(1);
      expect(page.sessionButtons()).toHaveLength(2);
      expect(page.findText()).toContain("Saved reply");
      for (const supersede of ["dismiss", "command", "repeat", "selection"]) {
        let finish!: (value: Awaited<ReturnType<NativeApi["reports"]["read"]>>) => void;
        read.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
        command();
        if (supersede === "dismiss") page.element("close-command").click();
        else if (supersede === "command") command("/model");
        else if (supersede === "repeat") command();
        else page.sessionButtons()[1]!.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const hidden = page.element("command-panel").hidden;
        const title = page.element("command-title").textContent;
        finish({
          ok: false,
          error: {
            code: "connection_lost",
            message: "Old failure",
            retryable: true,
            retryAfterMs: null,
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(page.element("command-panel").hidden).toBe(hidden);
        expect(page.element("command-title").textContent).toBe(title);
        expect(page.element("command-result").children[0]?.textContent).not.toBe("Old failure");
      }
      page.sessionButtons()[0]!.click();
      await vi.waitFor(() => expect(page.element("current-title").textContent).toBe(session.title));
      read.mockResolvedValueOnce({
        ok: false,
        error: {
          code: "connection_lost",
          message: "Status unavailable",
          retryable: true,
          retryAfterMs: null,
        },
      });
      command();
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.textContent).toBe("Status unavailable"),
      );
      expect(page.findText()).toContain("Saved reply");
      page.element("composer").value = "Request";
      page.element("composer").dispatch("input");
      page.element("composer-form").dispatch("submit");
      await vi.waitFor(() => expect(page.element("chat-status").textContent).toBe("Working…"));
      read.mockResolvedValueOnce({
        ok: true,
        value: { kind: "graph", text: "Graph readiness during turn" },
      });
      command("/graph status");
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.textContent).toBe(
          "Graph readiness during turn",
        ),
      );
      expect(read).toHaveBeenLastCalledWith({ kind: "graph", graphView: "status" });
      expect(page.element("chat-status").textContent).toBe("Working…");
      read.mockResolvedValueOnce({
        ok: true,
        value: { kind: "skills", agentId: "openminion", skills: ["read-only"] },
      });
      command("/skills");
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.children[0]?.textContent).toBe(
          "read-only",
        ),
      );
      expect(read).toHaveBeenLastCalledWith({ kind: "skills", sessionId: session.sessionId });
      expect(page.element("chat-status").textContent).toBe("Working…");

      let finish!: (value: Awaited<ReturnType<NativeApi["reports"]["read"]>>) => void;
      read.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      command();
      page.element("composer").value = "Keep drafting";
      page.element("composer").dispatch("input");
      const loads = load.mock.calls.length;
      receive({
        schemaVersion: 1,
        kind: "done",
        sessionId: session.sessionId,
        traceId: "trace",
        outcome: "complete",
      });
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(loads + 1));
      finish({ ok: true, value: { kind: "status", session: fresh } });
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.textContent).toContain("State: paused"),
      );
      expect(page.element("composer").value).toBe("Keep drafting");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("filters the paginated task catalog without changing selection or drafts", async () => {
    const sessions = [
      sessionSummary(),
      { ...sessionSummary(), sessionId: "session-2", title: "Other" },
      { ...sessionSummary(), sessionId: "SESSION-3", title: "Résumé [.*]" },
    ];
    const list = vi.fn(async ({ cursor }: { cursor?: string }) => {
      const index = Number(cursor ?? 0);
      return {
        ok: true,
        value: {
          sessions: [sessions[index]],
          nextCursor: index < 2 ? String(index + 1) : null,
          hasMore: index < 2,
        },
      };
    });
    const load = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      ok: true,
      value: {
        session: sessions.find((item) => item.sessionId === sessionId),
        messages: [message("reply", "Saved reply")],
        nextMessageCursor: null,
        messagesHasMore: false,
      },
    }));
    const api = {
      app: { info: async () => ({ shellVersion: "test" }) },
      daemon: {
        status: async () =>
          status({
            state: "running",
            reachable: true,
            capabilities: ["turns.text"],
          }),
      },
      sessions: {
        list,
        load,
        events: async () => ({
          ok: true,
          value: { events: [], nextCursor: null, hasMore: false },
        }),
      },
      turns: { subscribe: () => () => {} },
    } as unknown as NativeApi;
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      const search = page.element("session-search");
      page.element("composer").value = "Keep this draft";
      page.element("composer").dispatch("input");
      expect(list).toHaveBeenCalledTimes(3);
      for (const query of ["  RÉSUMÉ  ", "[.*]", "session-3"]) {
        search.value = query;
        search.dispatch("input");
        expect(page.sessionButtons().map((item) => item.textContent)).toEqual(["Résumé [.*]"]);
        expect(page.element("session-search-count").textContent).toBe("1 of 3 conversations");
        expect(page.element("current-title").textContent).toBe("Recovered chat");
        expect(page.element("composer").value).toBe("Keep this draft");
        expect(page.findText()).toContain("Saved reply");
        expect(load).toHaveBeenCalledTimes(1);
      }
      search.dispatch("keydown", { key: "Enter" });
      expect(load).toHaveBeenCalledTimes(1);
      page.element("show-commands").click();
      page.element("composer").value = "// literal slash draft";
      page.element("composer").dispatch("input");
      page.element("composer").dispatch("keydown", { key: "Escape" });
      expect(page.element("composer").value).toBe("// literal slash draft");
      page.element("composer").value = "Keep this draft";
      page.element("composer").dispatch("input");
      search.value = "no match";
      search.dispatch("input");
      expect(page.sessionButtons()).toHaveLength(0);
      expect(page.element("session-list").children[0]!.textContent).toBe(
        "No matching conversations. Try another name or session ID.",
      );
      expect(page.element("session-search-count").textContent).toBe("0 of 3 conversations");
      page.element("clear-session-search").click();
      expect(search.value).toBe("");
      expect(search.focus).toHaveBeenCalled();
      expect(page.sessionButtons()).toHaveLength(3);
      expect(page.sessionButtons()[0]!.className).toContain("selected");
      page.element("show-commands").click();
      page.element("composer").value = "Replacement draft";
      page.element("composer").dispatch("input");
      search.value = "SESSION-3";
      search.dispatch("input");
      page.sessionButtons()[0]!.click();
      await vi.waitFor(() => expect(page.element("current-title").textContent).toBe("Résumé [.*]"));
      expect(search.value).toBe("SESSION-3");
      search.dispatch("keydown", { key: "Escape", preventDefault: vi.fn() });
      expect(search.value).toBe("");
      expect(page.element("session-search-count").hidden).toBe(true);
      expect(page.sessionButtons()[2]!.className).toContain("selected");
      page.sessionButtons()[0]!.click();
      await vi.waitFor(() => expect(page.element("composer").value).toBe("Replacement draft"));
      expect(list).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps local chat names across reloads without changing canonical sessions", async () => {
    const sessions = [
      sessionSummary(),
      { ...sessionSummary(), sessionId: "session-2", title: "Other" },
    ];
    const load = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      ok: true,
      value: {
        session: sessions.find((item) => item.sessionId === sessionId),
        messages: [message("reply", "Saved reply")],
        nextMessageCursor: null,
        messagesHasMore: false,
      },
    }));
    const api = {
      app: { info: async () => ({ shellVersion: "test" }) },
      daemon: {
        status: async () =>
          status({
            state: "running",
            reachable: true,
            capabilities: ["turns.text"],
          }),
      },
      sessions: {
        list: async () => ({
          ok: true,
          value: { sessions, nextCursor: null, hasMore: false },
        }),
        load,
        events: async () => ({
          ok: true,
          value: { events: [], nextCursor: "0", hasMore: false },
        }),
      },
      turns: { subscribe: () => () => {} },
    } as unknown as NativeApi;
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      page.names.set("openminion.task-name:session-1", "Imported name");
      await mount(api, page.asDocument());
      expect(page.element("current-title").textContent).toBe("Imported name");
      expect(page.names.size).toBe(0);
      const loadsBeforeRename = load.mock.calls.length;
      page.element("composer").value = "Keep this draft";
      const other = page.sessionButtons()[1]!;
      other.dispatch("contextmenu");
      expect(page.element("session-context-menu").open).toBe(true);
      page.element("session-context-menu").dispatch("keydown", { key: "Escape" });
      expect(other.focus).toHaveBeenCalled();
      expect(page.element("session-context-menu").open).toBe(false);
      other.dispatch("keydown", { key: "F10", shiftKey: true });
      page.element("session-context-rename").click();
      expect(page.element("rename-session-id").textContent).toBe("session-2");
      expect(page.element("task-name").value).toBe("Other");
      page.element("task-name").value = "Background planning";
      page.element("rename-form").dispatch("submit");
      await vi.waitFor(() => expect(page.element("rename-dialog").open).toBe(false));
      expect(page.sessionButtons()[1]!.textContent).toBe("Background planning");
      expect(page.element("current-title").textContent).toBe("Imported name");
      expect(page.element("composer").value).toBe("Keep this draft");
      expect(load).toHaveBeenCalledTimes(loadsBeforeRename);
      page.sessionButtons()[1]!.dispatch("contextmenu");
      page.element("session-context-rename").click();
      page.element("rename-reset").click();
      await vi.waitFor(() => expect(page.element("rename-dialog").open).toBe(false));
      expect(page.sessionButtons()[1]!.textContent).toBe("Other");
      page.element("current-title").click();
      expect(page.element("rename-session-id").textContent).toBe("session-1");
      page.element("rename-cancel").click();
      expect(page.element("current-title").focus).toHaveBeenCalled();
      page.element("rename-session").click();
      expect(page.element("rename-session-id").textContent).toBe("session-1");
      page.element("task-name").value = "Discard this";
      page.element("rename-cancel").click();
      expect(page.names.size).toBe(0);
      page.element("rename-session").click();
      page.element("task-name").value = "   ";
      page.element("rename-form").dispatch("submit");
      expect(page.element("rename-error").textContent).toContain("Enter a name");
      page.element("task-name").value = "  Release planning  ";
      page.element("rename-form").dispatch("submit");
      await vi.waitFor(() =>
        expect(page.element("current-title").textContent).toBe("Release planning"),
      );
      expect(page.sessionButtons()[0]?.textContent).toBe("Release planning");
      expect(page.findText()).toContain("Saved reply");
      expect(sessions[0]?.title).toBe("Recovered chat");
      page.element("session-search").value = "release";
      page.element("session-search").dispatch("input");
      expect(page.sessionButtons().map((button) => button.textContent)).toEqual([
        "Release planning",
      ]);
      page.element("clear-session-search").click();
      page.sessionButtons()[1]!.click();
      await vi.waitFor(() => expect(page.element("current-title").textContent).toBe("Other"));
      expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "session-2" }));
      page.sessionButtons()[0]!.click();
      await vi.waitFor(() =>
        expect(page.element("current-title").textContent).toBe("Release planning"),
      );
      const reloaded = new FixtureDocument();
      for (const [key, value] of page.names) reloaded.names.set(key, value);
      await mount(api, reloaded.asDocument());
      expect(reloaded.element("current-title").textContent).toBe("Release planning");
      reloaded.element("rename-session").click();
      reloaded.element("task-name").value = "Unsaved name";
      const write = vi.spyOn(api.chatNames, "save").mockResolvedValue({
        ok: false,
        error: {
          code: "storage_unavailable",
          message: "Could not save the name on this device. Try again.",
          retryable: false,
          retryAfterMs: null,
        },
      });
      reloaded.element("rename-form").dispatch("submit");
      await vi.waitFor(() =>
        expect(reloaded.element("rename-error").textContent).toContain("Could not save"),
      );
      expect(reloaded.element("rename-dialog").open).toBe(true);
      expect(reloaded.element("current-title").textContent).toBe("Release planning");
      write.mockRestore();
      const persist = api.chatNames.save;
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const delayed = vi.spyOn(api.chatNames, "save").mockImplementation(async (input) => {
        await pending;
        return persist(input);
      });
      reloaded.element("task-name").value = "Saved late";
      reloaded.element("rename-form").dispatch("submit");
      reloaded.element("rename-cancel").click();
      reloaded.element("rename-session").click();
      reloaded.element("task-name").value = "New draft";
      finish();
      await vi.waitFor(() =>
        expect(reloaded.element("current-title").textContent).toBe("Saved late"),
      );
      expect(reloaded.element("rename-dialog").open).toBe(true);
      expect(reloaded.element("task-name").value).toBe("New draft");
      delayed.mockRestore();
      reloaded.element("session-search").value = "saved late";
      reloaded.element("session-search").dispatch("input");
      expect(reloaded.sessionButtons()).toHaveLength(1);
      reloaded.element("rename-reset").click();
      await vi.waitFor(() =>
        expect(reloaded.element("current-title").textContent).toBe("Recovered chat"),
      );
      expect(reloaded.sessionButtons()).toHaveLength(0);
      expect(reloaded.element("session-search").value).toBe("saved late");
      expect(reloaded.names.size).toBe(0);
      expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "session-1" }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("tracks two running sidebar sessions independently and clears a background completion", async () => {
    const sessions = [
      sessionSummary(),
      { ...sessionSummary(), sessionId: "session-2", title: "Other" },
    ];
    let catalog = [...sessions];
    let receive!: (event: TurnEventV1) => void;
    const api = {
      app: { info: async () => ({ shellVersion: "test" }) },
      daemon: {
        status: async () =>
          status({
            state: "running",
            reachable: true,
            capabilities: ["turns.text"],
          }),
      },
      sessions: {
        list: async () => ({
          ok: true,
          value: { sessions: catalog, nextCursor: null, hasMore: false },
        }),
        load: async ({ sessionId }: { sessionId: string }) => ({
          ok: true,
          value: {
            session: sessions.find((session) => session.sessionId === sessionId),
            messages: [],
            nextMessageCursor: null,
            messagesHasMore: false,
          },
        }),
        events: async () => ({
          ok: true,
          value: { events: [], nextCursor: null, hasMore: false },
        }),
      },
      turns: {
        subscribe: (listener: typeof receive) => {
          receive = listener;
          return () => {};
        },
        submit: async ({ sessionId }: { sessionId: string }) => ({
          ok: true,
          value: { sessionId, traceId: sessionId, requestId: sessionId },
        }),
      },
    } as unknown as NativeApi;
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      for (const index of [0, 1]) {
        page.sessionButtons()[index]!.click();
        await vi.waitFor(() => expect(page.element("send").hidden).toBe(false));
        page.element("composer").value = `Request ${index}`;
        page.element("composer").dispatch("input");
        await vi.waitFor(() => expect(page.element("send").disabled).toBe(false));
        page.element("composer-form").dispatch("submit");
        await vi.waitFor(() => expect(page.element("chat-status").textContent).toBe("Working…"));
      }
      expect(page.sessionButtons().map((button) => button.children[0]!.hidden)).toEqual([
        false,
        false,
      ]);
      page.element("session-search").value = "no match";
      page.element("session-search").dispatch("input");
      expect(page.sessionButtons()).toHaveLength(0);
      expect(page.element("chat-status").textContent).toBe("Working…");
      catalog = [sessions[1]!, sessions[0]!];
      receive({
        schemaVersion: 1,
        kind: "done",
        sessionId: "session-1",
        traceId: "session-1",
        outcome: "complete",
      });
      page.element("clear-session-search").click();
      expect(page.sessionButtons().map((button) => button.children[0]!.hidden)).toEqual([
        true,
        false,
      ]);
      await vi.waitFor(() => expect(page.sessionButtons()[0]!.textContent).toBe("Other"));
      expect(page.element("current-title").textContent).toBe("Other");
      expect(page.element("chat-status").textContent).toBe("Working…");
      receive({
        schemaVersion: 1,
        kind: "done",
        sessionId: "session-2",
        traceId: "session-2",
        outcome: "cancelled",
      });
      expect(page.sessionButtons().map((button) => button.children[0]!.hidden)).toEqual([
        true,
        true,
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["create", "close"] as const)(
    "keeps a successful local %s when an older catalog refresh resolves",
    async (operation) => {
      const session = sessionSummary();
      const newSession = { ...session, sessionId: "session-new", title: "New conversation" };
      let resolveList!: (value: unknown) => void;
      const oldCatalog = {
        ok: true,
        value: { sessions: [session], nextCursor: null, hasMore: false },
      };
      const list = vi
        .fn()
        .mockResolvedValueOnce(oldCatalog)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveList = resolve;
            }),
        );
      const ready = status({ state: "ready", reachable: true, protocol: 1 });
      const api = {
        app: { info: async () => ({ shellVersion: "test" }) },
        daemon: { status: async () => ready, retry: async () => ready },
        sessions: {
          list,
          create: async () => ({ ok: true, value: newSession }),
          close: async () => ({ ok: true, value: { ...session, status: "closed" } }),
          load: async ({ sessionId }: { sessionId: string }) => ({
            ok: true,
            value: {
              session: sessionId === newSession.sessionId ? newSession : session,
              messages: [],
              nextMessageCursor: null,
              messagesHasMore: false,
            },
          }),
          events: async () => ({
            ok: true,
            value: { events: [], nextCursor: null, hasMore: false },
          }),
        },
        turns: { subscribe: () => () => {} },
      } as unknown as NativeApi;
      vi.stubGlobal("window", { addEventListener: vi.fn() });
      try {
        const page = new FixtureDocument();
        await mount(api, page.asDocument());
        page.element("retry").click();
        await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
        page.element(operation === "create" ? "new-session" : "close-session").click();
        const expected =
          operation === "create"
            ? ["New conversation", "Recovered chat"]
            : ["Recovered chat · Closed"];
        await vi.waitFor(() =>
          expect(page.sessionButtons().map((button) => button.textContent)).toEqual(expected),
        );
        resolveList(oldCatalog);
        await vi.waitFor(() => expect(page.element("retry").disabled).toBe(false));
        expect(page.sessionButtons().map((button) => button.textContent)).toEqual(expected);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("creates the first task on send, preserves failed drafts, and admits one submission", async () => {
    const session = { ...sessionSummary(), isDraft: true };
    let resolveCreation!: (value: { ok: true; value: SessionSummaryV1 }) => void;
    const creation = new Promise<{ ok: true; value: SessionSummaryV1 }>((resolve) => {
      resolveCreation = resolve;
    });
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "daemon_unavailable",
          message: "Reconnect and try again.",
          retryable: true,
          retryAfterMs: null,
        },
      })
      .mockReturnValueOnce(creation);
    const submit = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        sessionId: session.sessionId,
        requestId: "request-1",
        traceId: "trace-1",
      },
    });
    const api = {
      app: { info: async () => ({ shellVersion: "test" }) },
      daemon: {
        status: async () =>
          status({
            state: "running",
            reachable: true,
            capabilities: ["turns.text"],
          }),
      },
      sessions: {
        create,
        list: async () => ({
          ok: true,
          value: { sessions: [], nextCursor: null, hasMore: false },
        }),
        load: async () => ({
          ok: true,
          value: {
            session,
            messages: [],
            nextMessageCursor: "0",
            messagesHasMore: false,
          },
        }),
        events: async () => ({
          ok: true,
          value: { events: [], nextCursor: "0", hasMore: false },
        }),
      },
      turns: { submit, subscribe: () => () => {} },
      media: { release: vi.fn() },
    } as unknown as NativeApi;
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      expect(page.element("send").disabled).toBe(true);
      page.element("session-search").value = "absent";
      page.element("session-search").dispatch("input");
      expect(page.element("session-list").children[0]!.textContent).toBe(
        "Your conversations will appear here.",
      );
      page.element("composer").value = "hi";
      page.element("composer").dispatch("input");
      expect(page.element("send").disabled).toBe(false);
      page.element("composer-form").dispatch("submit");
      await vi.waitFor(() =>
        expect(page.element("chat-status").textContent).toBe("Reconnect and try again."),
      );
      expect(page.element("composer").value).toBe("hi");
      expect(submit).not.toHaveBeenCalled();
      page.element("composer").dispatch("keydown", { key: "Enter" });
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
      expect(page.element("send").disabled).toBe(true);
      page.element("composer-form").dispatch("submit");
      page.element("new-session").click();
      page.element("composer").value = "Next draft";
      page.element("composer").dispatch("input");
      resolveCreation({ ok: true, value: session });
      await vi.waitFor(() =>
        expect(submit).toHaveBeenCalledWith({
          sessionId: session.sessionId,
          message: "hi",
        }),
      );
      expect(create).toHaveBeenCalledTimes(2);
      expect(submit).toHaveBeenCalledOnce();
      expect(page.element("composer").value).toBe("Next draft");
      expect(page.element("session-search").value).toBe("absent");
      expect(page.element("session-search-count").textContent).toBe("0 of 1 conversations");
      page.element("clear-session-search").click();
      expect(page.sessionButtons()).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["ready", "running"] as const)(
    "waits for chat readiness, recovers failures, and preserves drafts (%s)",
    async (state) => {
      let resolveStatus!: (value: DaemonStatus) => void;
      let resolveRetry!: (value: DaemonStatus) => void;
      const retry = vi.fn(
        () =>
          new Promise<DaemonStatus>((resolve) => {
            resolveRetry = resolve;
          }),
      );
      const create = vi.fn();
      const submit = vi.fn();
      const api = {
        app: { info: async () => ({ shellVersion: "test" }) },
        daemon: {
          status: () =>
            new Promise<DaemonStatus>((resolve) => {
              resolveStatus = resolve;
            }),
          retry,
        },
        sessions: {
          create,
          list: async () => ({
            ok: true,
            value: { sessions: [], nextCursor: null, hasMore: false },
          }),
        },
        turns: { submit, subscribe: () => () => {} },
      } as unknown as NativeApi;
      vi.stubGlobal("window", { addEventListener: vi.fn() });
      try {
        const page = new FixtureDocument();
        const mounted = mount(api, page.asDocument());
        await vi.waitFor(() => expect(page.element("new-session").disabled).toBe(true));
        expect(page.element("composer").disabled).toBe(false);
        expect(page.element("send").disabled).toBe(true);
        expect(page.element("chat-progress").hidden).toBe(true);
        resolveStatus(status({ state: "starting" }));
        await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
        expect(page.element("recovery").hidden).toBe(false);
        expect(page.element("readiness-title").textContent).toBe("Getting OpenMinion ready…");
        expect(page.element("readiness-actions").hidden).toBe(true);
        page.element("composer").value = "Preserve this draft";
        page.element("composer-form").dispatch("submit");
        expect(create).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
        resolveRetry(status({ state: "degraded" }));
        await mounted;
        expect(page.element("include-screenshot-control").hidden).toBe(true);
        expect(page.element("ask-guidance").hidden).toBe(true);
        expect(page.element("watch-settings").hidden).toBe(true);
        expect(page.element("readiness-title").textContent).toBe("Chat isn’t connected yet");
        expect(page.element("readiness-actions").hidden).toBe(false);
        expect(page.element("composer").disabled).toBe(false);
        expect(page.element("send").disabled).toBe(true);
        page.element("readiness-retry").click();
        expect(retry).toHaveBeenCalledTimes(2);
        expect(page.element("composer").disabled).toBe(false);
        expect(page.element("readiness-actions").hidden).toBe(true);
        resolveRetry(status({ state, reachable: true, capabilities: ["turns.text"] }));
        await vi.waitFor(() => expect(page.element("recovery").hidden).toBe(true));
        expect(page.element("composer").disabled).toBe(false);
        expect(page.element("send").disabled).toBe(false);
        expect(page.element("composer").value).toBe("Preserve this draft");
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("keeps drafts editable offline and preserves them when creating a connected task", async () => {
    const session = sessionSummary();
    const create = vi.fn().mockResolvedValue({ ok: true, value: session });
    const submit = vi.fn();
    const read = vi.fn().mockResolvedValue({
      ok: true,
      value: { kind: "tokens", text: "Canonical token report" },
    });
    const readIdentity = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        profiles: [
          {
            agentId: session.activeAgentId,
            displayName: "Writer",
            source: "yaml",
            editable: true,
            readOnlyReason: null,
            authoredYaml: "agent_id: writer\n",
            profileRevision: 2,
            profileVersion: "profile-v2",
            sourceSha256: "source-v2",
            validationOk: true,
            sourceStatus: "clean",
            verificationIssues: [],
            generatedStatus: "clean",
            generatedFiles: ["AGENT.md"],
            render: {
              text: "Mission: Write clearly.",
              purpose: "act",
              profileVersion: "profile-v2",
              renderVersion: "render-v1",
              includedFields: ["role.mission"],
              omittedFields: [],
            },
          },
        ],
      },
    });
    const reloadIdentity = vi.fn().mockImplementation(readIdentity);
    const api = {
      reports: { read },
      identity: { read: readIdentity, reload: reloadIdentity },
      app: {
        openLink: vi.fn().mockResolvedValue({ ok: true, value: null }),
        copyText: vi.fn().mockResolvedValue({ ok: true, value: null }),
        info: async () => ({ shellVersion: "test" }),
      },
      daemon: {
        status: async () => status({ state: "degraded" }),
        retry: async () => status({ state: "ready", reachable: true }),
      },
      sessions: {
        create,
        list: async () => ({
          ok: true,
          value: { sessions: [], nextCursor: null, hasMore: false },
        }),
        load: async () => ({
          ok: true,
          value: {
            session,
            messages: [{ ...message("user-1", "User input only"), role: "user" }],
            nextMessageCursor: "0",
            messagesHasMore: false,
          },
        }),
        events: async () => ({
          ok: true,
          value: { events: [], nextCursor: "0", hasMore: false },
        }),
      },
      turns: { submit, subscribe: () => () => {} },
      media: { release: vi.fn() },
    } as unknown as NativeApi;
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      expect(page.element("composer").disabled).toBe(false);
      expect(page.element("new-session").disabled).toBe(false);
      page.element("composer").value = "Keep this local draft";
      page.element("composer").dispatch("input");
      page.element("new-session").click();
      page.element("composer-form").dispatch("submit");
      expect(page.element("composer").focus).toHaveBeenCalledOnce();
      expect(create).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(page.element("send").disabled).toBe(true);
      page.element("show-connection").click();
      expect(page.element("connection-details").open).toBe(true);
      expect(page.element("retry").focus).toHaveBeenCalledOnce();
      expect(page.element("composer").value).toBe("Keep this local draft");
      page.element("retry").click();
      await vi.waitFor(() => expect(page.element("recovery").hidden).toBe(true));
      page.element("new-session").click();
      page.element("new-session").click();
      await vi.waitFor(() => expect(page.element("send").disabled).toBe(false));
      expect(create).toHaveBeenCalledTimes(1);
      expect(page.element("composer").value).toBe("Keep this local draft");
      await vi.waitFor(() => expect(page.findText()).toContain("User input only"));
      page.element("composer").value = "/tokens";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.textContent).toBe(
          "Canonical token report",
        ),
      );
      expect(read).toHaveBeenLastCalledWith({
        kind: "tokens",
        sessionId: session.sessionId,
      });
      read.mockResolvedValue({
        ok: true,
        value: {
          kind: "agents",
          activeAgentId: "writer",
          agents: [{ id: "writer", label: "Writer" }],
        },
      });
      page.element("composer").value = "/agent Writer";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.textContent).toContain("Writer"),
      );
      expect(page.element("command-result").children[0]?.textContent).toBe("● writer — Writer");
      expect(read).toHaveBeenLastCalledWith({
        kind: "agents",
        agentFilter: "Writer",
        sessionId: session.sessionId,
      });
      page.element("composer").value = "/identity";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.textContent).toContain(
          "Mission: Write clearly.",
        ),
      );
      page.element("composer").value = "/identity verify";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      await vi.waitFor(() =>
        expect(page.element("command-title").textContent).toBe("Identity verification"),
      );
      expect(page.element("command-result").children[0]?.textContent).toContain(
        "Verification: valid",
      );
      page.element("composer").value = "/identity reload";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      await vi.waitFor(() => expect(reloadIdentity).toHaveBeenCalledOnce());
      expect(page.element("command-title").textContent).toBe("Identity reloaded");
      page.element("composer").value = "/identity unknown";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      expect(page.element("command-title").textContent).toBe("Identity command");
      read.mockResolvedValueOnce({ ok: true, value: { kind: "skills", text: "Skill: Example" } });
      page.element("composer").value = "/skills example";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.textContent).toBe("Skill: Example"),
      );
      expect(read).toHaveBeenLastCalledWith({ kind: "skills", skillId: "example" });
      read.mockResolvedValue({
        ok: true,
        value: {
          kind: "learning",
          text: "Skill learning:\n  pending        1",
        },
      });
      page.element("composer").value = "/learning proposal-1";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.textContent).toContain("pending"),
      );
      expect(read).toHaveBeenLastCalledWith({
        kind: "learning",
        proposalId: "proposal-1",
      });
      read.mockResolvedValue({
        ok: true,
        value: { kind: "mcp", text: "MCP:\n  configured  local" },
      });
      page.element("composer").value = "/mcp";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.textContent).toContain("configured"),
      );
      expect(read).toHaveBeenLastCalledWith({
        kind: "mcp",
        sessionId: session.sessionId,
      });
      let finishReport!: (value: unknown) => void;
      read.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishReport = resolve;
          }),
      );
      page.element("composer").value = "/tool";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      page.element("composer").value = "/status";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      finishReport({
        ok: true,
        value: {
          kind: "tools",
          tools: [{ name: "old result", enabled: true }],
        },
      });
      await Promise.resolve();
      expect(page.element("command-title").textContent).toBe("Conversation status");
      expect(page.element("command-result").children[0]?.textContent).not.toContain("old result");
      page.element("composer").value = "/tools enable search";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      expect(page.element("command-title").textContent).toBe("Tool access");
      expect(read).toHaveBeenCalledTimes(7);
      read.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishReport = resolve;
          }),
      );
      page.element("composer").value = "/tools";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      expect(page.element("command-panel").hidden).toBe(false);
      page.element("close-command").click();
      finishReport({
        ok: true,
        value: { kind: "tools", tools: [{ name: "dismissed", enabled: true }] },
      });
      await Promise.resolve();
      expect(page.element("command-panel").hidden).toBe(true);
      page.element("composer").value = "/copy";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      expect(api.app.copyText).not.toHaveBeenCalled();
      expect(page.element("command-title").textContent).toBe("Copy");
      page.element("composer").value = "Keep drafting beside the result";
      page.element("composer").dispatch("input");
      expect(page.element("command-panel").hidden).toBe(false);
      page.element("composer").dispatch("keydown", { key: "Escape" });
      expect(page.element("command-panel").hidden).toBe(true);
      expect(page.element("composer").value).toBe("Keep drafting beside the result");
      page.element("composer").value = "Keep this local draft";
      page.element("show-commands").click();
      expect(page.element("command-menu").hidden).toBe(false);
      page.element("composer").dispatch("keydown", { key: "Escape" });
      expect(page.element("composer").value).toBe("Keep this local draft");
      page.element("composer").value = "/sta";
      page.element("composer").dispatch("input");
      expect(page.element("command-menu").children).toHaveLength(1);
      page.element("composer").dispatch("keydown", { key: "Enter" });
      expect(page.element("command-title").textContent).toBe("Conversation status");
      page.element("composer").value = "/permissions readonly";
      page.element("composer-form").dispatch("submit");
      await vi.waitFor(() =>
        expect(page.element("command-title").textContent).toBe("Command unavailable"),
      );
      expect(submit).not.toHaveBeenCalled();
      expect(page.element("composer").value).toBe("/permissions readonly");
      page.element("composer").value = "/model other-model";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      expect(page.element("command-title").textContent).toBe("Command arguments");
      page.element("composer").value = "/help";
      page.element("composer").dispatch("input");
      page.element("composer").dispatch("keydown", { key: "Tab" });
      expect(page.element("composer").value).toBe("/help ");
      page.element("composer").dispatch("keydown", { key: "Enter" });
      expect(page.element("command-title").textContent).toBe(
        "Focus commands — partial integration",
      );
      read.mockResolvedValue({ ok: true, value: { kind: "tools", text: "Tool exposure status" } });
      page.element("composer").value = "/tools status";
      page.element("composer").dispatch("input");
      page.element("composer").dispatch("keydown", { key: "Enter" });
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.textContent).toBe(
          "Tool exposure status",
        ),
      );
      expect(read).toHaveBeenLastCalledWith({
        kind: "tools",
        toolView: "status",
        sessionId: session.sessionId,
      });
      const reportsBeforeHelp = read.mock.calls.length;
      for (const value of ["/tasks --help", "/skills ?", "/agent --help", "/help tasks"]) {
        page.element("composer").value = value;
        page.element("composer").dispatch("input");
        page.element("composer").dispatch("keydown", { key: "Enter" });
        expect(page.element("command-title").textContent).toBe("Command help");
        expect(page.element("command-result").children[0]?.textContent).toContain("[");
      }
      expect(read).toHaveBeenCalledTimes(reportsBeforeHelp);
      page.element("command-result").children[1]!.click();
      await vi.waitFor(() =>
        expect(page.element("command-result").children[1]!.textContent).toBe("Copied"),
      );
      expect(api.app.copyText).toHaveBeenLastCalledWith(
        expect.stringContaining("/tasks pause|resume|cancel"),
      );
      vi.mocked(api.app.copyText).mockResolvedValueOnce({
        ok: false,
        error: {
          code: "clipboard_unavailable",
          message: "Clipboard unavailable",
          retryable: false,
          retryAfterMs: null,
        },
      });
      page.element("command-result").children[1]!.click();
      await vi.waitFor(() =>
        expect(page.element("command-result").children[1]!.textContent).toBe("Copy failed"),
      );
      vi.mocked(api.app.copyText).mockRejectedValueOnce(new Error("Clipboard unavailable"));
      page.element("command-result").children[1]!.click();
      await vi.waitFor(() =>
        expect(page.element("command-result").children[1]!.textContent).toBe("Copy failed"),
      );
      page.element("composer").value = "/help tasks extra";
      page.element("composer").dispatch("input");
      page.element("composer").dispatch("keydown", { key: "Enter" });
      expect(page.element("command-result").children[0]?.textContent).toContain(
        "/tasks extra is not connected",
      );
      page.element("composer").value = "/help graph";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      expect(page.element("command-title").textContent).toBe("Command help");
      expect(page.element("command-result").children[0]?.textContent).toContain(
        "/graph — Show graph help or check readiness",
      );
      read.mockResolvedValue({
        ok: true,
        value: { kind: "graph", text: "usage: openminion graph" },
      });
      page.element("composer").value = "/graph";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      expect(page.element("command-title").textContent).toBe("Graph help");
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.textContent).toBe(
          "usage: openminion graph",
        ),
      );
      expect(read).toHaveBeenLastCalledWith({ kind: "graph" });
      expect(page.element("command-result").children[2]!.textContent).toBe("Check readiness");
      page.element("composer").value = "Keep this unsent draft";
      page.element("composer").dispatch("input");
      read.mockResolvedValue({
        ok: true,
        value: { kind: "graph", text: "GraphFakos installed: no\nConfigured graph sources: none" },
      });
      page.element("command-result").children[2]!.click();
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.textContent).toContain(
          "GraphFakos installed: no",
        ),
      );
      expect(page.element("command-title").textContent).toBe("Graph status");
      expect(read).toHaveBeenLastCalledWith({ kind: "graph", graphView: "status" });
      expect(page.element("composer").value).toBe("Keep this unsent draft");
      expect(page.element("command-result").children).toHaveLength(2);
      const graphReads = read.mock.calls.length;
      for (const text of [
        "/graph query test",
        "/graph status extra",
        "/graph status --provider custom",
      ]) {
        page.element("composer").value = text;
        page.element("composer").dispatch("keydown", { key: "Enter" });
        expect(page.element("command-title").textContent).toBe("Graph commands");
      }
      expect(read).toHaveBeenCalledTimes(graphReads);
      read.mockResolvedValueOnce({
        ok: false,
        error: {
          code: "report_unavailable",
          message: "Graph unavailable",
          retryable: false,
          retryAfterMs: null,
        },
      });
      page.element("composer").value = "/graph status";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]?.textContent).toBe("Graph unavailable"),
      );
      read.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishReport = resolve;
          }),
      );
      page.element("composer").value = "/graph status";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      page.element("close-command").click();
      finishReport({ ok: true, value: { kind: "graph", text: "Late readiness" } });
      await Promise.resolve();
      expect(page.element("command-panel").hidden).toBe(true);
      page.element("composer").value = "/editor";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      expect(page.element("command-title").textContent).toBe("Desktop composer");
      for (const command of ["/files", "/screenshot", "/cancel", "/retry", "/resume"]) {
        page.element("composer").value = command;
        page.element("composer").dispatch("keydown", { key: "Enter" });
        await vi.waitFor(() =>
          expect(page.element("command-title").textContent).toBe("Command unavailable"),
        );
      }
      expect(submit).not.toHaveBeenCalled();
      page.element("composer").value = "Preserve during outage";
      page.element("composer").dispatch("input");
      api.daemon.status = async () => status({ state: "degraded" });
      page.element("show-connection").click();
      await vi.waitFor(() =>
        expect(page.element("connection-label").textContent).toBe("Not connected"),
      );
      expect(page.element("composer").value).toBe("Preserve during outage");
      expect(page.element("send").disabled).toBe(true);
      expect(page.element("retry").hidden).toBe(false);
      api.daemon.status = async () => status({ state: "running" });
      const startingPage = new FixtureDocument();
      await mount(api, startingPage.asDocument());
      expect(startingPage.element("connection-label").textContent).toBe("OpenMinion running");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows connected daemon state without exposing transport facts", () => {
    const view = statusView(status({ state: "ready", reachable: true, daemonVersion: "0.0.9" }));
    expect(view).toMatchObject({ tone: "ready", showRetry: false });
    expect(JSON.stringify(view)).not.toMatch(/token|host|port|path/i);
  });

  it("renders native delegation inspection with separate tree, session, and timeline navigation", async () => {
    const parent = sessionSummary();
    const child = { ...sessionSummary(), sessionId: "child-session", title: "Child review" };
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { sessions: [parent], nextCursor: null, hasMore: false },
      })
      .mockResolvedValue({
        ok: true,
        value: { sessions: [parent, child], nextCursor: null, hasMore: false },
      });
    const control = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        action: "inspect",
        status: "running",
        agentId: "reviewer",
        taskId: "task-1",
        a2aTraceId: "a2a-trace-1",
        content: null,
        tasks: [
          {
            taskId: "task-1",
            a2aTraceId: "a2a-trace-1",
            agentId: "reviewer",
            method: "delegate",
            state: "RUNNING",
            currentStep: "working",
            progress: 0.5,
            createdAt: "2026-10-07T00:00:00Z",
            updatedAt: "2026-10-07T00:00:01Z",
          },
        ],
        inspection: {
          support: "supported",
          authority: "session_task_owner",
          task: {
            taskId: "task-1",
            a2aTraceId: "a2a-trace-1",
            agentId: "reviewer",
            method: "delegate",
            state: "RUNNING",
            currentStep: "working",
            progress: 0.5,
            createdAt: "2026-10-07T00:00:00Z",
            updatedAt: "2026-10-07T00:00:01Z",
          },
          links: {
            invocationId: "invocation-1",
            sourceExecutionId: "execution-1",
            handoffId: "handoff-1",
          },
          timeline: [
            {
              timestamp: "2026-10-07T00:00:00Z",
              messageId: "message-1",
              a2aTraceId: "a2a-trace-1",
              fromAgent: "writer",
              toAgent: "reviewer",
              type: "job.start",
              method: "delegate",
              status: "JOB_QUEUED",
              taskId: "task-1",
              errorCode: null,
            },
          ],
          childSession: { status: "available", sessionId: "child-session" },
          rawContentStatus: "unavailable",
        },
      },
    });
    const api = {
      app: {
        info: async () => ({ shellVersion: "test" }),
        copyText: vi.fn().mockResolvedValue({ ok: true, value: null }),
      },
      daemon: { status: async () => status({ state: "ready", reachable: true }) },
      sessions: {
        list,
        load: async ({ sessionId }: { sessionId: string }) => ({
          ok: true,
          value: {
            session: sessionId === child.sessionId ? child : parent,
            messages: [],
            nextMessageCursor: "0",
            messagesHasMore: false,
          },
        }),
        events: async () => ({
          ok: true,
          value: { events: [], nextCursor: "0", hasMore: false },
        }),
      },
      delegation: { control },
      turns: { subscribe: () => () => {} },
      media: { release: vi.fn() },
    } as unknown as NativeApi;
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      page.element("composer").value = "/delegate inspect task-1";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      await vi.waitFor(() => expect(control).toHaveBeenCalledOnce());
      expect(control).toHaveBeenCalledWith({
        sessionId: parent.sessionId,
        action: "inspect",
        taskId: "task-1",
      });
      const content = page.element("command-result");
      expect(content.descendants().map((item) => item.textContent)).toEqual(
        expect.arrayContaining([
          "Delegation details",
          "reviewer · RUNNING",
          "Open child conversation",
          "Show protocol timeline",
        ]),
      );
      const tree = content.descendants().find((item) => item.className === "delegation-tree")!;
      expect(tree.getAttribute("role")).toBe("group");
      expect(tree.getAttribute("aria-label")).toBe("Delegation participants");
      const timeline = content
        .descendants()
        .find((item) => item.textContent === "Show protocol timeline")!;
      expect(timeline.getAttribute("aria-expanded")).toBe("false");
      timeline.click();
      expect(timeline.getAttribute("aria-expanded")).toBe("true");
      expect(
        content.descendants().find((item) => item.textContent === "A2A protocol timeline")!.focus,
      ).toHaveBeenCalledOnce();
      expect(content.descendants().map((item) => item.textContent)).toContain(
        "2026-10-07T00:00:00Z · job.start · JOB_QUEUED · writer → reviewer",
      );
      content
        .descendants()
        .find((item) => item.textContent === "Open child conversation")!
        .click();
      await vi.waitFor(() =>
        expect(page.element("current-title").textContent).toBe("Child review"),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("distinguishes a running runtime from a connected chat transport", () => {
    expect(
      statusView(status({ state: "running", reachable: true, daemonVersion: "0.0.18" })),
    ).toMatchObject({
      label: "OpenMinion running",
      tone: "pending",
      showRetry: false,
      showRecovery: true,
    });
  });

  it("connects text chat only when the running runtime exposes its adapter", () => {
    expect(
      statusView(
        status({
          state: "running",
          reachable: true,
          capabilities: ["turns.text"],
        }),
      ),
    ).toMatchObject({ label: "Connected", tone: "ready", showRecovery: false });
  });

  it.each([
    ["python_environment_failed", "Install Python 3.11 on this computer, then reconnect."],
    [
      "openminion_install_failed",
      "Open Connection details, then reconnect. Reinstall Desktop if the problem continues.",
    ],
    [
      "openminion_executable_unavailable",
      "Open Connection details, then reconnect. Reinstall Desktop if the problem continues.",
    ],
    [
      "runtime_root_unavailable",
      "Open Connection details, then reconnect. Reinstall Desktop if the problem continues.",
    ],
    [
      "openminion_version_mismatch",
      "Check Runtime settings for a compatible update, then reconnect.",
    ],
    ["runtime_incompatible", "Check Runtime settings for a compatible update, then reconnect."],
    [
      "runtime_recovery_required",
      "Open Connection details and restart Desktop. Runtime recovery needs review.",
    ],
    [
      "config_initialization_failed",
      "Check Connection details and the configured OpenMinion paths, then restart Desktop.",
    ],
    [
      "daemon_roots_unavailable",
      "Check Connection details and the configured OpenMinion paths, then restart Desktop.",
    ],
    [
      "daemon_ownership_unverified",
      "Stop the externally managed daemon, then reconnect from Desktop.",
    ],
    [
      "invalid_daemon_status",
      "Check Connection details, then reconnect the local OpenMinion daemon.",
    ],
    [
      "daemon_status_failed",
      "Check Connection details, then reconnect the local OpenMinion daemon.",
    ],
    ["daemon_unavailable", "Check Connection details, then reconnect the local OpenMinion daemon."],
    [
      "daemon_start_failed",
      "Check Connection details, then reconnect the local OpenMinion daemon.",
    ],
    [
      "runtime_health_failed",
      "Check Connection details, then reconnect the local OpenMinion daemon.",
    ],
    [
      "daemon_stop_failed",
      "Quit Desktop and any remaining OpenMinion process, then reopen Desktop.",
    ],
  ])("shows the available recovery action for %s", (errorCode, summary) => {
    expect(statusView(status({ state: "degraded", errorCode }))).toMatchObject({
      summary,
      tone: "degraded",
      showRetry: true,
      showRecovery: true,
    });
  });

  it.each([null, "future_error"])("keeps generic recovery for %s", (errorCode) => {
    expect(statusView(status({ state: "degraded", errorCode }))).toMatchObject({
      summary: "Reconnect to send messages.",
      tone: "degraded",
    });
  });

  it("recovers canonical messages and events without replaying a prompt", async () => {
    const session = sessionSummary();
    const api = {
      sessions: {
        load: vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            value: {
              session,
              messages: [message("message-1", "Recovered response")],
              nextMessageCursor: "message-one",
              messagesHasMore: true,
            },
          })
          .mockResolvedValueOnce({
            ok: true,
            value: {
              session,
              messages: [message("message-2", "Recovered follow-up")],
              nextMessageCursor: "message-two",
              messagesHasMore: false,
            },
          }),
        events: vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            value: {
              events: [eventValue("event-one", "running")],
              nextCursor: "event-one",
              hasMore: true,
            },
          })
          .mockResolvedValueOnce({
            ok: true,
            value: {
              events: [eventValue("event-two", "completed")],
              nextCursor: "event-two",
              hasMore: false,
            },
          }),
      },
      turns: { submit: vi.fn() },
    } as unknown as NativeApi;

    const recovered = await recoverSession(api, session.sessionId);

    expect(recovered).toMatchObject({
      session,
      messages: [{ body: "Recovered response" }, { body: "Recovered follow-up" }],
      events: [{ state: "running" }, { state: "completed" }],
    });
    expect(api.sessions.load).toHaveBeenNthCalledWith(1, {
      sessionId: session.sessionId,
      messageLimit: 200,
    });
    expect(api.sessions.load).toHaveBeenNthCalledWith(2, {
      sessionId: session.sessionId,
      messageAfter: "message-one",
      messageLimit: 200,
    });
    expect(api.sessions.events).toHaveBeenNthCalledWith(1, {
      sessionId: session.sessionId,
      after: "event-zero",
      limit: 200,
    });
    expect(api.sessions.events).toHaveBeenNthCalledWith(2, {
      sessionId: session.sessionId,
      after: "event-one",
      limit: 200,
    });
    expect(api.turns.submit).not.toHaveBeenCalled();
  });

  it("loads every session page and fails closed on a stalled cursor", async () => {
    const first = sessionSummary();
    const second = { ...sessionSummary(), sessionId: "session-2" };
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { sessions: [first], nextCursor: "page-two", hasMore: true },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { sessions: [second], nextCursor: null, hasMore: false },
      });
    const api = { sessions: { list } } as unknown as NativeApi;

    expect(await listSessions(api)).toEqual([first, second]);
    expect(list).toHaveBeenNthCalledWith(1, { limit: 100 });
    expect(list).toHaveBeenNthCalledWith(2, { cursor: "page-two", limit: 100 });

    list.mockReset().mockResolvedValue({
      ok: true,
      value: { sessions: [first], nextCursor: "same", hasMore: true },
    });
    expect(await listSessions(api)).toMatchObject({ code: "cursor_stalled" });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("loads bounded artifact scan/content pages and rejects stalled cursors", async () => {
    const item = artifactCatalogItem();
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { artifacts: [], nextCursor: "A".repeat(48), complete: false },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { artifacts: [item], nextCursor: null, complete: true },
      });
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          schemaVersion: 1,
          artifactId: item.artifactId,
          sessionId: item.sessionId,
          contentKind: "diff",
          text: "--- [PATH REDACTED]\n",
          complete: false,
          nextCursor: "B".repeat(48),
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          schemaVersion: 1,
          artifactId: item.artifactId,
          sessionId: item.sessionId,
          contentKind: "diff",
          text: "+++ [PATH REDACTED]\n@@ -1 +1 @@\n-old\n+new\n",
          complete: true,
          nextCursor: null,
        },
      });
    const api = { artifacts: { list, read } } as unknown as NativeApi;

    expect(await listArtifacts(api, item.sessionId)).toEqual([item]);
    expect(await readArtifact(api, item)).toMatchObject({
      item,
      contentKind: "diff",
      text: expect.stringContaining("+new"),
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      sessionId: item.sessionId,
      cursor: "A".repeat(48),
      limit: 100,
    });
    expect(read).toHaveBeenNthCalledWith(2, {
      sessionId: item.sessionId,
      artifactId: item.artifactId,
      cursor: "B".repeat(48),
      limitBytes: 64 * 1024,
    });

    list.mockReset().mockResolvedValue({
      ok: true,
      value: {
        artifacts: Array.from({ length: 257 }, () => item),
        nextCursor: null,
        complete: true,
      },
    });
    expect(await listArtifacts(api, item.sessionId)).toMatchObject({
      code: "invalid_daemon_response",
    });

    list
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          artifacts: [item],
          nextCursor: "A".repeat(48),
          complete: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { artifacts: [item], nextCursor: null, complete: true },
      });
    expect(await listArtifacts(api, item.sessionId)).toMatchObject({
      code: "invalid_daemon_response",
    });

    list.mockReset().mockResolvedValue({
      ok: true,
      value: { artifacts: [item, item], nextCursor: null, complete: true },
    });
    expect(await listArtifacts(api, item.sessionId)).toMatchObject({
      code: "invalid_daemon_response",
    });

    read.mockReset().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        artifactId: item.artifactId,
        sessionId: item.sessionId,
        contentKind: "text",
        text: "mismatched kind",
        complete: true,
        nextCursor: null,
      },
    });
    expect(await readArtifact(api, item)).toMatchObject({
      code: "invalid_daemon_response",
    });
  });

  it("renders safe artifact states and uses fixed read and detach methods", async () => {
    const session = sessionSummary();
    const active = artifactCatalogItem();
    const detached = {
      ...active,
      state: "detached" as const,
      actions: ["read", "restore"] as const,
    };
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { artifacts: [active], nextCursor: null, complete: true },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { artifacts: [detached], nextCursor: null, complete: true },
      });
    const read = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        artifactId: active.artifactId,
        sessionId: active.sessionId,
        contentKind: "diff",
        text: "--- [PATH REDACTED]\n+++ [PATH REDACTED]\n@@ -1 +1 @@\n-<old>\n+<new>",
        complete: true,
        nextCursor: null,
      },
    });
    const detach = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        artifactId: active.artifactId,
        sessionId: active.sessionId,
        state: "detached",
        outcome: "applied",
      },
    });
    const api = {
      app: {
        openLink: vi.fn().mockResolvedValue({ ok: true, value: null }),
        copyText: vi.fn().mockResolvedValue({ ok: true, value: null }),
        info: vi.fn().mockResolvedValue({ shellVersion: "0.0.0" }),
      },
      daemon: {
        status: vi.fn().mockResolvedValue(
          status({
            state: "ready",
            reachable: true,
            daemonVersion: "0.0.9",
            protocol: 1,
          }),
        ),
        retry: vi.fn(),
      },
      sessions: {
        list: vi.fn().mockResolvedValue({
          ok: true,
          value: { sessions: [session], nextCursor: null, hasMore: false },
        }),
        load: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            session,
            messages: [],
            nextMessageCursor: "message-zero",
            messagesHasMore: false,
          },
        }),
        events: vi.fn().mockResolvedValue({
          ok: true,
          value: { events: [], nextCursor: "event-zero", hasMore: false },
        }),
        create: vi.fn(),
        close: vi.fn(),
      },
      turns: {
        submit: vi.fn(),
        cancel: vi.fn(),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
      },
      approvals: { decide: vi.fn() },
      artifacts: { list, read, detach, restore: vi.fn() },
      media: { pick: vi.fn(), release: vi.fn() },
    } as unknown as NativeApi;
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      await vi.waitFor(() => expect(page.artifactText()).toContain("report.txt"));
      const view = page.artifactButtons().find((button) => button.textContent === "View")!;
      view.click();
      await vi.waitFor(() =>
        expect(page.element("artifact-content").textContent).toContain("+<new>"),
      );
      expect(page.element("artifact-content").textContent).toContain("[PATH REDACTED]");
      read.mockResolvedValueOnce({
        ok: false,
        error: {
          code: "artifact_missing",
          message: "The artifact content is no longer available.",
          retryable: false,
          retryAfterMs: null,
        },
      });
      page
        .artifactButtons()
        .find((button) => button.textContent === "View")!
        .click();
      await vi.waitFor(() =>
        expect(page.element("artifact-status").textContent).toBe(
          "The artifact content is no longer available.",
        ),
      );
      expect(page.element("artifact-detail").hidden).toBe(true);
      const detachButton = page
        .artifactButtons()
        .find((button) => button.textContent === "Detach")!;
      detachButton.click();
      await vi.waitFor(() =>
        expect(detach).toHaveBeenCalledWith({
          sessionId: active.sessionId,
          artifactId: active.artifactId,
        }),
      );
      await vi.waitFor(() => expect(page.artifactText()).toContain("Attachment · detached · 72 B"));
      expect(JSON.stringify(page.artifactText())).not.toMatch(
        /artifact:\/\/|sha256|token|endpoint|\/v1\/|\/private/i,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("moves only an exact reported speaker prefix out of an answer", () => {
    expect(assistantBody("minimax-m2-7: 391", "minimax-m2-7")).toBe("391");
    expect(
      assistantBody("minimax-m2-7: Note: keep this\nminimax-m2-7: quoted", "minimax-m2-7"),
    ).toBe("Note: keep this\nminimax-m2-7: quoted");
    expect(assistantBody("Note: keep this", "minimax-m2-7")).toBe("Note: keep this");
    expect(assistantBody("other-profile: keep this", "minimax-m2-7")).toBe(
      "other-profile: keep this",
    );
    expect(assistantBody("minimax-m2-7: keep this")).toBe("minimax-m2-7: keep this");
  });

  it("formats the four completed-turn usage modes without inventing missing usage", () => {
    const usage = {
      usageAvailable: true,
      inputTokens: 5700,
      outputTokens: 603,
      totalTokens: 6303,
      llmCalls: 4,
      durationMs: 26000,
      costUsd: null,
      costSource: "unavailable" as const,
    };
    expect(formatDesktopTurnUsage(usage, "off")).toBe("26s");
    expect(formatDesktopTurnUsage(usage, "total")).toBe("26s · 6.3k tokens");
    expect(formatDesktopTurnUsage(usage, "input_output")).toBe("26s · 5.7k in · 603 out");
    expect(formatDesktopTurnUsage(usage, "input_output_calls")).toBe(
      "26s · 5.7k in · 603 out · 4 calls",
    );
    expect(formatDesktopTurnUsage(undefined, "total")).toBe("");
  });

  it("keeps each saved speaker in the header and copies the displayed reply", async () => {
    const session = {
      ...sessionSummary(),
      turnUsageDisplay: "input_output_calls" as const,
    };
    const history = [
      { ...message("user", "writer: a user quote"), role: "user" as const },
      {
        ...message("reply", "writer: Answer: with punctuation"),
        profileName: "writer",
        usage: {
          usageAvailable: true,
          inputTokens: 5700,
          outputTokens: 603,
          totalTokens: 6303,
          llmCalls: 4,
          durationMs: 26000,
          costUsd: null,
          costSource: "unavailable" as const,
        },
      },
    ];
    const api = {
      app: {
        info: vi.fn().mockResolvedValue({ shellVersion: "0.0.0" }),
        openLink: vi.fn().mockResolvedValue({ ok: true, value: null }),
        copyText: vi.fn().mockResolvedValue({ ok: true, value: null }),
      },
      daemon: {
        status: vi.fn().mockResolvedValue(status({ state: "ready", reachable: true, protocol: 1 })),
        retry: vi.fn(),
      },
      sessions: {
        list: vi.fn().mockResolvedValue({
          ok: true,
          value: { sessions: [session], nextCursor: null, hasMore: false },
        }),
        load: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            session,
            messages: history,
            nextMessageCursor: "2",
            messagesHasMore: false,
          },
        }),
        events: vi.fn().mockResolvedValue({
          ok: true,
          value: { events: [], nextCursor: "0", hasMore: false },
        }),
      },
      turns: { subscribe: vi.fn().mockReturnValue(vi.fn()) },
    } as unknown as NativeApi;
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      expect(page.findText()).toContain("writer");
      expect(page.findText()).toContain("Answer: with punctuation");
      expect(page.findText()).toContain("writer: a user quote");
      expect(page.findText()).not.toContain("writer: Answer: with punctuation");
      expect(page.findText()).toContain("26s · 5.7k in · 603 out · 4 calls");
      expect(page.element("chat-status").textContent).toBe("");
      page.element("composer").value = "/copy";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      await vi.waitFor(() =>
        expect(api.app.copyText).toHaveBeenCalledWith("Answer: with punctuation"),
      );
      expect(history[1]!.body).toBe("writer: Answer: with punctuation");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("copies tool output in stream order, keeps truncation visible, and does not invent reloaded output", async () => {
    const session = sessionSummary();
    let receive!: (event: TurnEventV1) => void;
    const history = [message("old", "Old reply")];
    const copyText = vi.fn().mockResolvedValue({ ok: true, value: null });
    const api = {
      app: { info: async () => ({ shellVersion: "test" }), copyText },
      daemon: { status: async () => status({ state: "ready", reachable: true, protocol: 1 }) },
      sessions: {
        list: async () => ({
          ok: true,
          value: { sessions: [session], nextCursor: null, hasMore: false },
        }),
        load: async () => ({
          ok: true,
          value: { session, messages: history, nextMessageCursor: null, messagesHasMore: false },
        }),
        events: async () => ({ ok: true, value: { events: [], nextCursor: null, hasMore: false } }),
      },
      turns: {
        subscribe: (listener: typeof receive) => {
          receive = listener;
          return () => {};
        },
        submit: async () => ({
          ok: true,
          value: { sessionId: session.sessionId, traceId: "trace-1", requestId: "request-1" },
        }),
      },
    } as unknown as NativeApi;
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      page.element("composer").value = "Run a tool";
      page.element("composer").dispatch("input");
      page.element("composer-form").dispatch("submit");
      await vi.waitFor(() => expect(page.element("chat-status").textContent).toBe("Working…"));
      const tool = {
        schemaVersion: 1 as const,
        kind: "tool" as const,
        phase: "completed" as const,
        sessionId: session.sessionId,
        traceId: "trace-1",
        toolName: "exec.run",
        callId: "call-1",
        state: "ok",
        ok: true,
        durationMs: 10,
        exitCode: 0,
        createdAt: "2026-10-05T00:00:02Z",
        content: "  output\nsecond line\nthird\nfourth\nfifth\nsixth\nseventh\n",
        truncated: true,
      };
      receive(tool);
      expect(page.findText()).toContain("call-1 · ok · 10 ms · Output truncated");
      const output = page
        .element("timeline")
        .descendants()
        .find((item) => item.className === "tool-output")!;
      expect(
        page
          .element("timeline")
          .descendants()
          .find((item) => item.className === "tool-preview")!.textContent,
      ).toBe("  output\nsecond line\nthird\nfourth\nfifth\nsixth");
      for (const [command, expanded] of [
        ["/verbose", true],
        ["/details off", false],
      ] as const) {
        page.element("composer").value = command;
        page.element("composer").dispatch("keydown", { key: "Enter" });
        await vi.waitFor(() => expect(output.open).toBe(expanded));
        expect(page.element("timeline").descendants()).toContain(output);
      }
      expect(output.tagName).toBe("details");
      expect(output.open).toBe(false);
      expect(output.children[0]!.tagName).toBe("summary");
      expect(output.children[0]!.textContent).toBe("Show available output");
      expect(output.children[1]!.tagName).toBe("pre");
      expect(output.children[1]!.textContent).toBe(tool.content);
      expect(page.findText()).toContain(
        "OpenMinion reported truncated output. Only the supplied text is available.",
      );
      output.open = true;
      output.children[0]!.focus();
      output.children[1]!.scrollTop = 37;
      const copy = page.findButtons().find((button) => button.textContent === "Copy output")!;
      copy.click();
      await vi.waitFor(() => expect(copyText).toHaveBeenLastCalledWith(tool.content));
      expect(copy.textContent).toBe("Copied");
      copyText.mockRejectedValueOnce(new Error("Clipboard unavailable"));
      copy.click();
      await vi.waitFor(() => expect(copy.textContent).toBe("Copy failed"));
      const copyLatest = () => {
        page.element("composer").value = "/copy";
        page.element("composer").dispatch("keydown", { key: "Enter" });
      };
      copyLatest();
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]!.textContent).toBe(
          "Copied to clipboard.",
        ),
      );
      expect(copyText).toHaveBeenLastCalledWith(tool.content);
      copyText.mockRejectedValueOnce(new Error("Clipboard unavailable"));
      copyLatest();
      await vi.waitFor(() =>
        expect(page.element("command-result").children[0]!.textContent).toBe("Copy failed"),
      );
      output.children[0]!.focus();
      receive({
        schemaVersion: 1,
        kind: "progress",
        progressKind: "text",
        sessionId: session.sessionId,
        traceId: "trace-1",
        text: "First reply continued",
        createdAt: "2026-10-05T00:00:03Z",
      });
      expect(page.element("timeline").descendants()).toContain(output);
      expect(output.open).toBe(true);
      expect(output.children[1]!.scrollTop).toBe(37);
      expect(page.activeElement).toBe(output.children[0]);
      copyLatest();
      await vi.waitFor(() => expect(copyText).toHaveBeenLastCalledWith("First reply continued"));
      receive({
        ...tool,
        callId: "call-2",
        content: undefined,
        truncated: undefined,
        createdAt: "2026-10-05T00:00:04Z",
      });
      expect(page.findText()).toContain("Output is unavailable for this event.");
      receive({ ...tool, callId: "call-empty", content: "", truncated: false });
      expect(page.findText()).toContain("No output.");
      copyLatest();
      await vi.waitFor(() => expect(copyText).toHaveBeenLastCalledWith("First reply continued"));
      history.push({ ...message("new", "Saved final reply"), createdAt: "2026-10-05T00:00:05Z" });
      receive({
        schemaVersion: 1,
        kind: "done",
        sessionId: session.sessionId,
        traceId: "trace-1",
        outcome: "complete",
      });
      await vi.waitFor(() => expect(page.findText()).toContain("Saved final reply"));
      copyLatest();
      await vi.waitFor(() => expect(copyText).toHaveBeenLastCalledWith("Saved final reply"));
      // A fresh renderer has no live tool content and must not recreate it from status.
      const reloaded = new FixtureDocument();
      await mount(api, reloaded.asDocument());
      expect(reloaded.findButtons().some((button) => button.textContent === "Copy output")).toBe(
        false,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("tracks one active trace through progress, response, and terminal state", () => {
    expect(waitingTime(1000, 1000)).toBe("0s");
    expect(waitingTime(1000, 62500)).toBe("1m 01s");
    const submitting = {
      ...initialChatState(),
      sessionId: "session-1",
      active: true,
    };
    const startedEvent = {
      schemaVersion: 1 as const,
      kind: "started" as const,
      requestId: "request-1",
      traceId: "trace-1",
      sessionId: "session-1",
    };
    const started = applyTurnEvent(submitting, startedEvent);
    expect(started).toMatchObject({
      active: true,
      sessionId: "session-1",
      traceId: "trace-1",
    });
    const progress = applyTurnEvent(started, {
      schemaVersion: 1,
      kind: "progress",
      progressKind: "status",
      sessionId: "session-1",
      traceId: "trace-1",
      statusKey: "working",
      label: "Thinking",
      detailText: "Checking available context",
      createdAt: "2026-08-19T00:00:01Z",
    });
    expect(progress.label).toBe("Thinking");
    expect(progress.detail).toBe("Checking available context");
    expect(progress.lastUpdateAt).toEqual(expect.any(Number));
    const stopping = {
      ...started,
      stopRequested: true,
      label: "Stop requested…",
    };
    expect(
      applyTurnEvent(stopping, {
        schemaVersion: 1,
        kind: "progress",
        progressKind: "text",
        sessionId: "session-1",
        traceId: "trace-1",
        text: "Late reply",
        createdAt: "2026-09-08T00:00:00Z",
      }),
    ).toEqual(stopping);
    const response = applyTurnEvent(progress, {
      schemaVersion: 1,
      kind: "response",
      sessionId: "session-1",
      traceId: "trace-1",
      finalText: "Done",
      errors: [],
      usage: {
        usageAvailable: false,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        llmCalls: null,
        durationMs: null,
        costUsd: null,
        costSource: "unavailable",
      },
    });
    const done = applyTurnEvent(response, {
      schemaVersion: 1,
      kind: "done",
      sessionId: "session-1",
      traceId: "trace-1",
      outcome: "complete",
    });
    expect(done).toMatchObject({
      active: false,
      traceId: null,
      terminalTraceId: "trace-1",
      label: "",
      detail: "",
      lastUpdateAt: null,
    });
    expect(
      applyTurnEvent(
        {
          ...started,
          error: {
            code: "provider_error",
            message: "Reconnect and try again.",
            retryable: true,
            retryAfterMs: null,
          },
        },
        {
          schemaVersion: 1,
          kind: "done",
          sessionId: "session-1",
          traceId: "trace-1",
          outcome: "error",
        },
      ).label,
    ).toBe("Reconnect and try again.");
    expect(
      applyTurnEvent(started, {
        schemaVersion: 1,
        kind: "done",
        sessionId: "session-1",
        traceId: "trace-1",
        outcome: "cancelled",
      }).label,
    ).toBe("Stopped.");
    expect(
      applySubmitResult(done, {
        requestId: "request-1",
        traceId: "trace-1",
        sessionId: "session-1",
      }),
    ).toEqual(done);
    expect(
      applyTurnEvent(started, {
        schemaVersion: 1,
        kind: "done",
        sessionId: "session-1",
        traceId: "stale-trace",
        outcome: "complete",
      }),
    ).toEqual(started);
    expect(
      applyTurnEvent({ ...initialChatState(), sessionId: "session-1" }, startedEvent),
    ).toMatchObject({ active: false, traceId: null });
  });

  it("recovers one approval and tool card from canonical safe facts", () => {
    const requested = {
      ...eventValue("event-one", "pending"),
      eventType: "approval.requested",
      facts: {
        approval_id: "approval-1",
        tool_name: "workspace.write",
        consent_preview: 'workspace.write(path="notes.txt", text="[bounded]")',
        requested_at: "2026-08-19T00:00:02Z",
        expires_at: "2026-08-19T00:01:02Z",
        outcome: "pending",
      },
    };
    const resolved = {
      ...eventValue("event-two", "terminal"),
      eventType: "approval.resolved",
      facts: {
        approval_id: "approval-1",
        tool_name: "workspace.write",
        consent_preview: 'workspace.write(path="notes.txt", text="[bounded]")',
        decision: "deny",
        outcome: "denied",
        resolved_at: "2026-08-19T00:00:03Z",
      },
    };
    const completed = {
      ...eventValue("event-three", "completed"),
      eventType: "tool.completed",
      facts: {
        call_id: "call-2",
        tool_name: "workspace.search",
        ok: true,
        duration_ms: 9,
      },
    };

    const activity = recoverActivity("session-1", [requested, resolved, completed]);

    expect(activity).toEqual([
      expect.objectContaining({
        kind: "approval",
        approvalId: "approval-1",
        consentPreview: 'workspace.write(path="notes.txt", text="[bounded]")',
        decision: "deny",
        outcome: "denied",
      }),
      expect.objectContaining({
        kind: "tool",
        phase: "completed",
        toolName: "workspace.search",
        durationMs: 9,
      }),
    ]);
    expect(JSON.stringify(activity)).not.toMatch(/secret|argument.*value|\/private/i);
  });

  it("replaces live approval state without losing the consent preview", () => {
    const requested = {
      schemaVersion: 1 as const,
      kind: "approval" as const,
      phase: "requested" as const,
      sessionId: "session-1",
      traceId: "trace-1",
      approvalId: "approval-1",
      toolName: "workspace.write",
      consentPreview: 'workspace.write(path="notes.txt")',
      requestedAt: "2026-08-19T00:00:02Z",
      expiresAt: "2026-08-19T00:01:02Z",
      decision: null,
      outcome: "pending" as const,
      resolvedAt: null,
    } as unknown as ApprovalEventV1;
    const resolved = {
      ...requested,
      phase: "resolved" as const,
      consentPreview: "",
      requestedAt: null,
      expiresAt: null,
      decision: "allow_once" as const,
      outcome: "applied" as const,
      resolvedAt: "2026-08-19T00:00:03Z",
    } as ApprovalEventV1;

    expect(applyActivityEvent([requested], resolved)).toEqual([
      expect.objectContaining({
        phase: "resolved",
        consentPreview: 'workspace.write(path="notes.txt")',
        decision: "allow_once",
        outcome: "applied",
      }),
    ]);
    const settled = applyActivityEvent([requested], resolved);
    expect(applyActivityEvent(settled, requested)).toEqual(settled);
  });

  it.each([false, true])("restores approvals without replay (quiet=%s)", async (quietTools) => {
    const session = sessionSummary();
    const submit = vi.fn();
    let finishDecision: ((value: unknown) => void) | undefined;
    const decision = new Promise((resolve) => {
      finishDecision = resolve;
    });
    const decide = vi.fn().mockReturnValue(decision);
    const events = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          events: [approvalEvent("requested")],
          nextCursor: "event-one",
          hasMore: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          events: [approvalEvent("requested")],
          nextCursor: "event-one",
          hasMore: true,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          events: [approvalEvent("resolved")],
          nextCursor: "event-two",
          hasMore: false,
        },
      });
    const api = {
      app: {
        openLink: vi.fn().mockResolvedValue({ ok: true, value: null }),
        copyText: vi.fn().mockResolvedValue({ ok: true, value: null }),
        info: vi.fn().mockResolvedValue({ shellVersion: "0.0.0" }),
      },
      daemon: {
        status: vi.fn().mockResolvedValue(
          status({
            state: "ready",
            reachable: true,
            daemonVersion: "0.0.9",
            protocol: 1,
          }),
        ),
        retry: vi.fn(),
      },
      sessions: {
        list: vi.fn().mockResolvedValue({
          ok: true,
          value: { sessions: [session], nextCursor: null, hasMore: false },
        }),
        load: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            session,
            messages: [],
            nextMessageCursor: "message-zero",
            messagesHasMore: false,
          },
        }),
        events,
        create: vi.fn(),
        close: vi.fn(),
      },
      turns: {
        submit,
        cancel: vi.fn(),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
      },
      presentation: {
        load: async () => ({ ok: true, value: { toolDisplay: quietTools ? "quiet" : "normal" } }),
        save: vi.fn(),
      },
      approvals: { decide },
      media: { pick: vi.fn(), release: vi.fn() },
    } as unknown as NativeApi;

    const pagehide = vi.fn();
    vi.stubGlobal("window", { addEventListener: pagehide });
    try {
      const firstDocument = new FixtureDocument();
      await mount(api, firstDocument.asDocument());
      const timeline = firstDocument.element("conversation");
      timeline.scrollHeight = 1600;
      timeline.clientHeight = 400;
      timeline.scrollTop = 200;
      firstDocument.element("composer").dispatch("input");
      expect(timeline.scrollTop).toBe(200);
      timeline.dispatch("scroll");
      expect(firstDocument.element("jump-latest").hidden).toBe(false);
      firstDocument.element("jump-latest").click();
      expect(timeline.scrollTop).toBe(1600);
      expect(firstDocument.element("jump-latest").hidden).toBe(true);
      expect(firstDocument.element("composer").focus).toHaveBeenCalled();
      timeline.scrollTop = 1200;
      firstDocument.element("composer").dispatch("input");
      expect(timeline.scrollTop).toBe(1600);
      const pendingButtons = firstDocument.findButtons();
      const pendingCard = firstDocument
        .element("timeline")
        .descendants()
        .find((item) => item.className.includes("approval-card"))!;
      expect(pendingCard.getAttribute("aria-label")).toBe("Approval for workspace.write");
      expect(firstDocument.element("cancel").hidden).toBe(false);
      expect(firstDocument.element("send").disabled).toBe(true);
      expect(firstDocument.sessionButtons()[0]?.title).toContain("Needs approval");
      expect(firstDocument.findText()).toContain(
        'workspace.write(path="notes.txt", text="[bounded]")',
      );
      expect(pendingButtons.map((button) => button.textContent)).toEqual(["Deny", "Allow once"]);
      expect(pendingButtons.every((button) => !button.disabled)).toBe(true);
      pendingButtons[1]!.click();
      expect(firstDocument.findButtons().every((button) => button.disabled)).toBe(true);
      expect(decide).toHaveBeenCalledWith({
        sessionId: "session-1",
        traceId: "trace-1",
        approvalId: "approval-1",
        decision: "allow_once",
      });

      const beforeReload = {
        submits: submit.mock.calls.length,
        decisions: decide.mock.calls.length,
      };
      const reloadedDocument = new FixtureDocument();
      await mount(api, reloadedDocument.asDocument());
      expect(reloadedDocument.findButtons()).toEqual([]);
      expect(reloadedDocument.findText()).toEqual(
        expect.arrayContaining([
          "Approval · workspace.write",
          "Resolved · applied",
          'workspace.write(path="notes.txt", text="[bounded]")',
        ]),
      );
      expect({
        submits: submit.mock.calls.length,
        decisions: decide.mock.calls.length,
      }).toEqual(beforeReload);
      expect(events).toHaveBeenNthCalledWith(1, {
        sessionId: "session-1",
        after: "event-zero",
        limit: 200,
      });
      expect(events).toHaveBeenNthCalledWith(2, {
        sessionId: "session-1",
        after: "event-zero",
        limit: 200,
      });
      expect(events).toHaveBeenNthCalledWith(3, {
        sessionId: "session-1",
        after: "event-one",
        limit: 200,
      });
      expect(pagehide.mock.calls.filter(([type]) => type === "pagehide")).toHaveLength(2);
      expect(JSON.stringify(reloadedDocument.findText())).not.toMatch(
        /secret|argument.*value|\/private/i,
      );
    } finally {
      finishDecision?.({
        ok: true,
        value: {
          schemaVersion: 1,
          approvalId: "approval-1",
          sessionId: "session-1",
          traceId: "trace-1",
          decision: "allow_once",
          outcome: "applied",
          resolvedAt: "2026-08-19T00:00:03Z",
        },
      });
      vi.unstubAllGlobals();
    }
  });

  it("disables approval actions while Stop is settling", async () => {
    let finishCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    const decide = vi.fn();
    const api = approvalRendererApi(decide);
    api.turns.cancel = vi.fn<NativeApi["turns"]["cancel"]>(async () => {
      await cancellation;
      return {
        ok: true,
        value: {
          sessionId: "session-1",
          traceId: "trace-1",
          runId: "trace-1",
          state: "requested",
          terminal: false,
        },
      };
    });
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      page.element("cancel").click();
      const actions = page.findButtons();
      expect(actions.every((button) => button.disabled)).toBe(true);
      expect(page.findText()).toContain("Cancelling turn…");
      actions.find((button) => button.textContent === "Allow once")!.click();
      expect(decide).not.toHaveBeenCalled();
    } finally {
      finishCancellation();
      vi.unstubAllGlobals();
    }
  });

  it("keeps an in-flight decision disabled across conversation switches", async () => {
    let finishDecision: ((value: unknown) => void) | undefined;
    const decide = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        finishDecision = resolve;
      }),
    );
    const sessions = [
      sessionSummary(),
      { ...sessionSummary(), sessionId: "session-2", title: "Other conversation" },
    ];
    const api = approvalRendererApi(decide, sessions);
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      page
        .findButtons()
        .find((button) => button.textContent === "Allow once")!
        .click();
      expect(page.findButtons().every((button) => button.disabled)).toBe(true);

      page
        .sessionButtons()
        .find((button) => button.textContent === "Other conversation")!
        .click();
      await vi.waitFor(() =>
        expect(page.element("current-title").textContent).toBe("Other conversation"),
      );
      expect(
        page.sessionButtons().find((button) => button.textContent === "Recovered chat")?.title,
      ).toContain("Needs approval");
      page
        .sessionButtons()
        .find((button) => button.textContent === "Recovered chat")!
        .click();
      await vi.waitFor(() =>
        expect(page.element("current-title").textContent).toBe("Recovered chat"),
      );
      expect(page.findButtons().every((button) => button.disabled)).toBe(true);
      expect(decide).toHaveBeenCalledOnce();
      finishDecision?.({
        ok: true,
        value: {
          schemaVersion: 1,
          approvalId: "approval-1",
          sessionId: "session-1",
          traceId: "trace-1",
          decision: "allow_once",
          outcome: "applied",
          resolvedAt: "2026-08-19T00:00:03Z",
        },
      });
      finishDecision = undefined;
      let resolvedCard!: FixtureElement;
      await vi.waitFor(() => {
        resolvedCard = page
          .element("timeline")
          .descendants()
          .find((item) => item.className.includes("approval-card"))!;
        expect(resolvedCard.focus).toHaveBeenCalledOnce();
      });
      expect(page.findButtons()).toEqual([]);
      const resolutionStatus = resolvedCard.children.find((item) =>
        item.className.includes("activity-details"),
      )!;
      expect(resolutionStatus.getAttribute("role")).toBe("status");
      expect(page.sessionButtons()[0]?.title).not.toContain("Needs approval");
    } finally {
      finishDecision?.({
        ok: true,
        value: {
          schemaVersion: 1,
          approvalId: "approval-1",
          sessionId: "session-1",
          traceId: "trace-1",
          decision: "allow_once",
          outcome: "applied",
          resolvedAt: "2026-08-19T00:00:03Z",
        },
      });
      vi.unstubAllGlobals();
    }
  });

  it.each([
    {
      retryable: true,
      message: "Could not send the decision. Try again.",
      expected: "Decision not sent · Could not send the decision. Try again.",
      actions: 2,
    },
    {
      retryable: false,
      message: "This approval has expired.",
      expected: "Approval closed · This approval has expired.",
      actions: 0,
    },
  ])(
    "settles rejected decisions deterministically (retryable=$retryable)",
    async ({ retryable, message, expected, actions }) => {
      const decide = retryable
        ? vi.fn().mockRejectedValue(new Error("IPC disconnected"))
        : vi.fn().mockResolvedValue({
            ok: false,
            error: {
              code: "approval_expired",
              message,
              retryable: false,
              retryAfterMs: null,
            },
          });
      const api = approvalRendererApi(decide);
      vi.stubGlobal("window", { addEventListener: vi.fn() });
      try {
        const page = new FixtureDocument();
        await mount(api, page.asDocument());
        page
          .findButtons()
          .find((button) => button.textContent === "Allow once")!
          .click();
        await vi.waitFor(() => expect(page.findText()).toContain(expected));
        expect(page.findButtons()).toHaveLength(actions);
        if (retryable) {
          expect(page.findButtons()[0]?.focus).toHaveBeenCalledOnce();
          expect(page.findButtons().every((button) => !button.disabled)).toBe(true);
          expect(page.sessionButtons()[0]?.title).toContain("Needs approval");
        } else {
          expect(page.sessionButtons()[0]?.title).not.toContain("Needs approval");
        }
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("keeps a newer stream resolution when a delayed decision request fails", async () => {
    let finishDecision!: (value: ClientResult<ApprovalDecisionV1>) => void;
    const decide = vi.fn().mockReturnValue(
      new Promise<ClientResult<ApprovalDecisionV1>>((resolve) => {
        finishDecision = resolve;
      }),
    );
    const api = approvalRendererApi(decide);
    let turnListener: ((event: TurnEventV1) => void) | null = null;
    api.turns.subscribe = vi.fn((listener) => {
      turnListener = listener;
      return vi.fn();
    });
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      page
        .findButtons()
        .find((button) => button.textContent === "Allow once")!
        .click();

      turnListener!({
        schemaVersion: 1,
        kind: "approval",
        phase: "resolved",
        sessionId: "session-1",
        traceId: "trace-1",
        approvalId: "approval-1",
        toolName: "workspace.write",
        consentPreview: 'workspace.write(path="notes.txt", text="[bounded]")',
        requestedAt: null,
        expiresAt: null,
        decision: null,
        outcome: "expired",
        resolvedAt: "2026-08-19T00:00:03Z",
      });
      finishDecision({
        ok: false,
        error: {
          code: "approval_transport_failed",
          message: "Could not send the decision. Try again.",
          retryable: true,
          retryAfterMs: null,
        },
      });

      await vi.waitFor(() => expect(page.findText()).toContain("Resolved · expired"));
      const resolvedCard = page
        .element("timeline")
        .descendants()
        .find((item) => item.className.includes("approval-card"))!;
      expect(resolvedCard.focus).toHaveBeenCalledOnce();
      expect(
        resolvedCard.children
          .find((item) => item.className.includes("activity-details"))
          ?.getAttribute("role"),
      ).toBe("status");
      expect(page.findText()).not.toContain(
        "Decision not sent · Could not send the decision. Try again.",
      );
      expect(page.findButtons()).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("moves focus from an expired approval action to the resolved card", async () => {
    const api = approvalRendererApi(vi.fn());
    let turnListener: ((event: TurnEventV1) => void) | null = null;
    api.turns.subscribe = vi.fn((listener) => {
      turnListener = listener;
      return vi.fn();
    });
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      page
        .findButtons()
        .find((button) => button.textContent === "Deny")!
        .focus();

      turnListener!({
        schemaVersion: 1,
        kind: "approval",
        phase: "resolved",
        sessionId: "session-1",
        traceId: "trace-1",
        approvalId: "approval-1",
        toolName: "workspace.write",
        consentPreview: 'workspace.write(path="notes.txt", text="[bounded]")',
        requestedAt: null,
        expiresAt: null,
        decision: null,
        outcome: "expired",
        resolvedAt: "2026-08-19T00:00:03Z",
      });

      const resolvedCard = page
        .element("timeline")
        .descendants()
        .find((item) => item.className.includes("approval-card"))!;
      expect(resolvedCard.focus).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("marks a background approval without stealing focus", async () => {
    const sessions = [
      sessionSummary(),
      { ...sessionSummary(), sessionId: "session-2", title: "Other conversation" },
    ];
    const api = approvalRendererApi(vi.fn(), sessions);
    let turnListener: ((event: TurnEventV1) => void) | null = null;
    api.sessions!.events = vi.fn().mockResolvedValue({
      ok: true,
      value: { events: [], nextCursor: "event-zero", hasMore: false },
    });
    api.turns.subscribe = vi.fn((listener) => {
      turnListener = listener;
      return vi.fn();
    });
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      const focusCalls = page.element("composer").focus.mock.calls.length;
      const focusedSession = page
        .sessionButtons()
        .find((button) => button.textContent === "Recovered chat")!;
      focusedSession.focus();
      const backgroundApproval: ApprovalEventV1 = {
        schemaVersion: 1,
        kind: "approval",
        phase: "requested",
        sessionId: "session-2",
        traceId: "trace-2",
        approvalId: "approval-2",
        toolName: "exec.run",
        consentPreview: 'exec.run(command="npm test")',
        requestedAt: "2026-08-19T00:00:02Z",
        expiresAt: "2026-08-19T00:01:02Z",
        decision: null,
        outcome: "pending",
        resolvedAt: null,
      };

      turnListener!(backgroundApproval);

      expect(page.element("composer").focus).toHaveBeenCalledTimes(focusCalls);
      expect(page.findButtons()).toEqual([]);
      expect(
        page.sessionButtons().find((button) => button.textContent === "Other conversation")?.title,
      ).toContain("Needs approval");
      expect(page.element("approval-notice").textContent).toBe(
        "Other conversation needs approval for exec.run.",
      );
      expect(
        page.sessionButtons().find((button) => button.textContent === "Recovered chat")?.focus,
      ).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders bounded attachment chips and clears them without replay", async () => {
    const session = {
      ...sessionSummary(),
      turnUsageDisplay: "input_output_calls" as const,
    };
    const secondSession = {
      ...sessionSummary(),
      sessionId: "session-2",
      title: "Other",
    };
    const image = mediaAttachment("a", "pixel.png", "image/png", true);
    const file = mediaAttachment("b", "notes.txt", "text/plain", false);
    const later = mediaAttachment("c", "later.webp", "image/webp", true);
    const pagehideMedia = mediaAttachment("d", "pagehide.png", "image/png", true, "session-2");
    const retryMedia = mediaAttachment("e", "retry.png", "image/png", true);
    const closeMedia = mediaAttachment("f", "close.png", "image/png", true);
    const pick = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { attachments: [image] } })
      .mockResolvedValueOnce({ ok: true, value: { attachments: [file] } })
      .mockResolvedValueOnce({ ok: true, value: { attachments: [later] } })
      .mockResolvedValueOnce({
        ok: true,
        value: { attachments: [pagehideMedia] },
      })
      .mockResolvedValueOnce({ ok: true, value: { attachments: [retryMedia] } })
      .mockResolvedValueOnce({
        ok: true,
        value: { attachments: [closeMedia] },
      });
    const release = vi.fn().mockResolvedValue({
      ok: true,
      value: { mediaId: "b".repeat(48), released: true },
    });
    const submit = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          requestId: "request-1",
          traceId: "trace-1",
          sessionId: "session-1",
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "media_backpressure",
          message: "Try again later.",
          retryable: true,
          retryAfterMs: 1000,
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "submission_ambiguous",
          message: "Check session history before retrying",
          retryable: false,
          retryAfterMs: null,
        },
      });
    const turnSubscription: {
      listener: ((event: TurnEventV1) => void) | null;
    } = {
      listener: null,
    };
    const api = {
      app: {
        openLink: vi.fn().mockResolvedValue({ ok: true, value: null }),
        copyText: vi.fn().mockResolvedValue({ ok: true, value: null }),
        info: vi.fn().mockResolvedValue({ shellVersion: "0.0.0" }),
      },
      daemon: {
        status: vi.fn().mockResolvedValue(
          status({
            state: "ready",
            reachable: true,
            daemonVersion: "0.0.9",
            protocol: 1,
          }),
        ),
        retry: vi.fn(),
      },
      sessions: {
        list: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            sessions: [session, secondSession],
            nextCursor: null,
            hasMore: false,
          },
        }),
        load: vi.fn(async ({ sessionId }) => ({
          ok: true,
          value: {
            session: sessionId === "session-2" ? secondSession : session,
            messages: [message("history-1", `History for ${sessionId}`)],
            nextMessageCursor: "message-zero",
            messagesHasMore: false,
          },
        })),
        events: vi.fn().mockResolvedValue({
          ok: true,
          value: { events: [], nextCursor: "event-zero", hasMore: false },
        }),
        create: vi.fn(),
        close: vi.fn().mockResolvedValue({
          ok: true,
          value: { ...session, status: "closed" },
        }),
      },
      turns: {
        submit,
        cancel: vi.fn(),
        subscribe: vi.fn((listener) => {
          turnSubscription.listener = listener;
          return vi.fn();
        }),
      },
      approvals: { decide: vi.fn() },
      media: { pick, release },
    } as unknown as NativeApi;
    const pagehide: Array<() => void> = [];
    vi.stubGlobal("window", {
      addEventListener(type: string, listener: () => void) {
        if (type === "pagehide") {
          pagehide.push(listener);
        }
      },
    });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      page.element("attach-image").click();
      await vi.waitFor(() =>
        expect(page.attachmentText()).toContain("pixel.png · 1 KB · image/png"),
      );
      page.element("attach-file").click();
      await vi.waitFor(() => expect(page.attachmentText()).toContain("Not supported in chat yet"));
      page.element("composer").value = "Describe this image";
      page.element("composer").dispatch("input");
      expect(page.element("send").disabled).toBe(true);
      page.element("composer").dispatch("keydown", { key: "Enter", metaKey: true });
      expect(submit).not.toHaveBeenCalled();

      page.attachmentButtons()[1]!.click();
      expect(release).toHaveBeenCalledWith({
        sessionId: "session-1",
        mediaId: file.mediaId,
      });
      expect(page.element("send").disabled).toBe(false);
      page.element("composer").dispatch("keydown", { key: "Enter", shiftKey: true });
      page.element("composer").dispatch("keydown", {
        key: "Enter",
        metaKey: true,
        isComposing: true,
      });
      expect(submit).not.toHaveBeenCalled();
      page.element("composer").dispatch("keydown", { key: "Enter" });
      page.element("composer").dispatch("keydown", { key: "Enter", ctrlKey: true });
      await vi.waitFor(() =>
        expect(submit).toHaveBeenCalledWith({
          sessionId: "session-1",
          message: "Describe this image",
          draftRevision: "00000000-0000-4000-8000-000000000001",
          attachmentIds: [image.mediaId],
        }),
      );
      await vi.waitFor(() => expect(page.attachmentText()).toEqual([]));
      expect(submit).toHaveBeenCalledTimes(1);
      expect(page.findText()).toContain("Describe this image");
      const runningSpinner = page.sessionButtons()[0]!.children[0]!;
      expect(runningSpinner.hidden).toBe(false);
      expect(page.sessionButtons()[1]!.children[0]!.hidden).toBe(true);
      turnSubscription.listener?.({
        schemaVersion: 1,
        kind: "done",
        sessionId: "session-1",
        traceId: "stale-trace",
        outcome: "complete",
      });
      expect(runningSpinner.hidden).toBe(false);
      turnSubscription.listener?.({
        schemaVersion: 1,
        kind: "progress",
        progressKind: "status",
        sessionId: "session-1",
        traceId: "trace-1",
        statusKey: "context",
        label: "Reading context",
        detailText: "Loading the selected conversation",
        createdAt: "2026-09-08T00:00:00Z",
      });
      expect(page.sessionButtons()[0]!.children[0]).toBe(runningSpinner);
      expect(runningSpinner.hidden).toBe(false);
      expect(page.element("chat-detail").textContent).toBe("Loading the selected conversation");
      expect(page.element("chat-detail").hidden).toBe(false);
      const progressIndex = page
        .element("timeline")
        .children.indexOf(page.element("chat-progress"));
      expect(progressIndex).toBeGreaterThan(0);
      expect(page.element("timeline").children[progressIndex - 1]?.className).toBe("message user");
      expect(page.element("chat-progress").hidden).toBe(false);

      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16_000);
      page.element("composer").dispatch("input");
      expect(page.element("chat-update").textContent).toBe("Last update 16s ago");
      clock.mockRestore();
      turnSubscription.listener?.({
        schemaVersion: 1,
        kind: "progress",
        progressKind: "text",
        sessionId: "session-1",
        traceId: "trace-1",
        text: "First ",
        createdAt: "2026-09-08T00:00:00Z",
      });
      expect(page.element("chat-detail").hidden).toBe(true);
      expect(page.element("chat-update").hidden).toBe(true);
      turnSubscription.listener?.({
        schemaVersion: 1,
        kind: "progress",
        progressKind: "text",
        sessionId: "session-1",
        traceId: "trace-1",
        text: "chunk",
        createdAt: "2026-09-08T00:00:01Z",
      });
      expect(page.findText()).toContain("First chunk");
      page.sessionButtons()[1]!.click();
      await vi.waitFor(() => expect(page.element("current-title").textContent).toBe("Other"));
      expect(page.sessionButtons()[0]!.children[0]!.hidden).toBe(false);
      expect(page.sessionButtons()[1]!.children[0]!.hidden).toBe(true);
      page.sessionButtons()[0]!.click();
      expect(page.findText()).toContain("Describe this image");
      await vi.waitFor(() => expect(page.element("chat-detail").hidden).toBe(true));
      expect(page.findText()).toContain("First chunk");
      turnSubscription.listener?.({
        schemaVersion: 1,
        kind: "response",
        sessionId: "session-1",
        traceId: "trace-1",
        finalText: "First chunk",
        errors: [],
        usage: {
          usageAvailable: true,
          inputTokens: 5700,
          outputTokens: 603,
          totalTokens: 6303,
          llmCalls: 4,
          durationMs: 26000,
          costUsd: null,
          costSource: "unavailable",
        },
      });
      expect(page.findText()).toContain("26s · 5.7k in · 603 out · 4 calls");
      page.element("composer").value = "Draft during the active turn";
      page.element("composer").dispatch("input");
      page.sessionButtons()[1]!.click();
      await vi.waitFor(() => expect(page.element("chat-status").textContent).toBe(""));
      page.sessionButtons()[0]!.click();
      await vi.waitFor(() => expect(page.element("cancel").disabled).toBe(false));
      expect(page.element("cancel").hidden).toBe(false);
      expect(page.findText()).toContain("First chunk");
      expect(page.element("composer").value).toBe("Draft during the active turn");
      page.element("composer").value = "/copy";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      await vi.waitFor(() => expect(api.app.copyText).toHaveBeenCalledWith("First chunk"));
      let finishCancellation!: () => void;
      const cancellation = new Promise<void>((resolve) => {
        finishCancellation = resolve;
      });
      api.turns.cancel = vi.fn<NativeApi["turns"]["cancel"]>(async () => {
        await cancellation;
        return {
          ok: true,
          value: {
            sessionId: "session-1",
            traceId: "trace-1",
            runId: "trace-1",
            state: "requested",
            terminal: false,
          },
        };
      });
      page.element("cancel").click();
      page.element("composer").dispatch("input");
      expect(page.element("cancel").disabled).toBe(true);
      expect(page.element("send").hidden).toBe(true);
      expect(page.element("chat-status").textContent).toBe("Requesting stop…");
      expect(page.sessionButtons()[0]!.children[0]!.hidden).toBe(false);
      page.element("cancel").click();
      expect(api.turns.cancel).toHaveBeenCalledTimes(1);
      let finishHistoryRefresh!: () => void;
      const historyRefresh = new Promise<void>((resolve) => {
        finishHistoryRefresh = resolve;
      });
      const load = vi.mocked(api.sessions.load).getMockImplementation()!;
      vi.mocked(api.sessions.load).mockImplementationOnce(async (input) => {
        await historyRefresh;
        return load(input);
      });
      const composerFocusCalls = page.element("composer").focus.mock.calls.length;
      page.element("cancel").focus();
      turnSubscription.listener?.({
        schemaVersion: 1,
        kind: "done",
        sessionId: "session-1",
        traceId: "trace-1",
        outcome: "complete",
      });
      expect(page.element("composer").focus).toHaveBeenCalledTimes(composerFocusCalls + 1);
      expect(page.findText()).toContain("History for session-1");
      expect(page.findText()).toContain("First chunk");
      expect(page.findText()).not.toContain("What would you like to work on?");
      expect(page.element("chat-status").textContent).not.toBe("Loading conversation…");
      expect(page.element("chat-status").textContent).toBe("Finishing…");
      expect(page.sessionButtons()[0]!.children[0]!.hidden).toBe(true);
      page.element("composer").value = "Draft while history refreshes";
      page.element("composer").dispatch("input");
      expect(page.element("send").disabled).toBe(true);
      page.element("composer").dispatch("keydown", { key: "Enter" });
      expect(submit).toHaveBeenCalledTimes(1);
      finishHistoryRefresh();
      await vi.waitFor(() => expect(page.element("send").disabled).toBe(false));
      expect(page.element("composer").value).toBe("Draft while history refreshes");
      expect(page.findText().filter((text) => text === "History for session-1")).toHaveLength(1);
      expect(page.findText()).not.toContain("First chunk");
      await vi.waitFor(() => expect(page.element("attach-image").disabled).toBe(false));
      await vi.waitFor(() => expect(page.element("chat-status").textContent).toBe(""));
      finishCancellation();
      await vi.mocked(api.turns.cancel).mock.results[0]!.value;
      expect(page.element("cancel").hidden).toBe(true);
      expect(page.element("send").hidden).toBe(false);
      expect(page.element("chat-elapsed").textContent).toBe("");
      expect(page.element("chat-progress").hidden).toBe(true);
      expect(page.element("chat-status").textContent).toBe("");

      vi.mocked(api.sessions.load).mockResolvedValueOnce({
        ok: false,
        error: {
          code: "history_unavailable",
          message: "Could not refresh history.",
          retryable: true,
          retryAfterMs: null,
        },
      });
      page.sessionButtons()[0]!.click();
      await vi.waitFor(() =>
        expect(page.element("chat-status").textContent).toBe("Could not refresh history."),
      );
      expect(page.findText()).toContain("History for session-1");
      expect(page.findText()).not.toContain("What would you like to work on?");

      page.element("composer").value = "/clear";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      expect(page.findText()).not.toContain("History for session-1");
      page.element("composer").value = "/copy";
      page.element("composer").dispatch("keydown", { key: "Enter" });
      expect(api.app.copyText).toHaveBeenCalledTimes(1);
      page.sessionButtons()[0]!.click();
      await vi.waitFor(() => expect(page.findText()).toContain("History for session-1"));

      page.element("composer").value = "Next";
      page.element("composer").dispatch("input");
      page.element("attach-image").click();
      await vi.waitFor(() =>
        expect(page.attachmentText()).toContain("later.webp · 1 KB · image/webp"),
      );
      expect(page.findText()).toContain("History for session-1");
      page.sessionButtons()[1]!.click();
      expect(page.findText()).not.toContain("History for session-1");
      expect(page.findText()).not.toContain("What would you like to work on?");
      await vi.waitFor(() =>
        expect(release).toHaveBeenCalledWith({
          sessionId: "session-1",
          mediaId: later.mediaId,
        }),
      );
      await vi.waitFor(() => expect(page.element("current-title").textContent).toBe("Other"));
      expect(page.element("composer").value).toBe("");
      page.element("composer").value = "Other task draft";
      page.element("composer").dispatch("input");
      page.sessionButtons()[0]!.click();
      await vi.waitFor(() => expect(page.element("chat-status").textContent).toBe(""));
      expect(page.element("composer").value).toBe("Next");
      page.sessionButtons()[1]!.click();
      await vi.waitFor(() => expect(page.element("chat-status").textContent).toBe(""));
      expect(page.element("composer").value).toBe("Other task draft");
      page.element("attach-image").click();
      await vi.waitFor(() =>
        expect(page.attachmentText()).toContain("pagehide.png · 1 KB · image/png"),
      );
      pagehide[0]!();
      expect(release).toHaveBeenCalledWith({
        sessionId: "session-2",
        mediaId: pagehideMedia.mediaId,
      });

      const callsBeforeReload = {
        picks: pick.mock.calls.length,
        submits: submit.mock.calls.length,
      };
      const reloaded = new FixtureDocument();
      await mount(api, reloaded.asDocument());
      expect(reloaded.attachmentText()).toEqual([]);
      expect({
        picks: pick.mock.calls.length,
        submits: submit.mock.calls.length,
      }).toEqual(callsBeforeReload);
      reloaded.element("attach-image").click();
      await vi.waitFor(() =>
        expect(reloaded.attachmentText()).toContain("retry.png · 1 KB · image/png"),
      );
      reloaded.element("composer").value = "Retry safely";
      reloaded.element("composer").dispatch("input");
      reloaded.element("composer-form").dispatch("submit");
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
      expect(reloaded.attachmentText()).toContain("retry.png · 1 KB · image/png");
      expect(reloaded.element("chat-status").textContent).toBe("Try again later.");
      expect(reloaded.element("composer").value).toBe("Retry safely");
      expect(reloaded.findText()).not.toContain("Retry safely");
      reloaded.element("composer-form").dispatch("submit");
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(3));
      expect(reloaded.attachmentText()).toEqual([]);
      expect(reloaded.element("chat-status").textContent).toBe(
        "Check session history before retrying",
      );
      reloaded.element("attach-image").click();
      await vi.waitFor(() =>
        expect(reloaded.attachmentText()).toContain("close.png · 1 KB · image/png"),
      );
      reloaded.element("session-search").value = "SESSION-1";
      reloaded.element("session-search").dispatch("input");
      reloaded.element("close-session").click();
      await vi.waitFor(() =>
        expect(release).toHaveBeenCalledWith({
          sessionId: "session-1",
          mediaId: closeMedia.mediaId,
        }),
      );
      expect(reloaded.attachmentText()).toEqual([]);
      expect(reloaded.element("artifact-list").children).toEqual([]);
      expect(reloaded.element("artifact-status").textContent).toBe("This session is closed.");
      expect(reloaded.element("refresh-artifacts").disabled).toBe(true);
      expect(reloaded.sessionButtons()[0]!.textContent).toContain(" · Closed");
      expect(reloaded.element("session-search").value).toBe("SESSION-1");
      expect(reloaded.sessionButtons()).toHaveLength(1);
      expect(JSON.stringify(reloaded.attachmentText())).not.toMatch(
        /artifact|sha256|token|endpoint|\/v1\/|\/private/i,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses only opaque explicit-file grants and keeps folders unavailable", async () => {
    const session = sessionSummary();
    const secondSession = {
      ...sessionSummary(),
      sessionId: "session-2",
      title: "Other",
    };
    const fileGrant = {
      schemaVersion: 1 as const,
      grantId: "g".repeat(48),
      sessionId: "session-1",
      kind: "file" as const,
      displayName: "notes.txt",
      expiresAt: "2999-01-01T00:00:00Z",
      canList: false,
      canImport: true,
    };
    const pick = vi.fn().mockResolvedValue({ ok: true, value: { grant: fileGrant } });
    const list = vi.fn();
    let finishImport!: (value: unknown) => void;
    const importPending = new Promise((resolve) => {
      finishImport = resolve;
    });
    const importFile = vi.fn().mockReturnValue(importPending);
    let finishMediaPick!: (value: unknown) => void;
    const mediaPickPending = new Promise((resolve) => {
      finishMediaPick = resolve;
    });
    const mediaPick = vi.fn().mockReturnValue(mediaPickPending);
    const mediaRelease = vi.fn();
    let finishGrantRelease!: (value: unknown) => void;
    const grantReleasePending = new Promise((resolve) => {
      finishGrantRelease = resolve;
    });
    const release = vi
      .fn()
      .mockReturnValueOnce(grantReleasePending)
      .mockResolvedValue({ ok: true, value: { released: true } });
    const api = {
      app: {
        openLink: vi.fn().mockResolvedValue({ ok: true, value: null }),
        copyText: vi.fn().mockResolvedValue({ ok: true, value: null }),
        info: vi.fn().mockResolvedValue({ shellVersion: "0.0.0" }),
      },
      daemon: {
        status: vi.fn().mockResolvedValue(status({ state: "ready", reachable: true, protocol: 1 })),
        retry: vi.fn(),
      },
      sessions: {
        list: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            sessions: [session, secondSession],
            nextCursor: null,
            hasMore: false,
          },
        }),
        load: vi.fn(async ({ sessionId }) => ({
          ok: true,
          value: {
            session: sessionId === "session-2" ? secondSession : session,
            messages: [],
            nextMessageCursor: "message-zero",
            messagesHasMore: false,
          },
        })),
        events: vi.fn().mockResolvedValue({
          ok: true,
          value: { events: [], nextCursor: "event-zero", hasMore: false },
        }),
        create: vi.fn(),
        close: vi.fn(),
      },
      turns: {
        submit: vi.fn(),
        cancel: vi.fn(),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
      },
      approvals: { decide: vi.fn() },
      files: { pick, list, import: importFile, release },
      media: { pick: mediaPick, release: mediaRelease },
    } as unknown as NativeApi;
    const pagehide: Array<() => void> = [];
    vi.stubGlobal("window", {
      addEventListener(type: string, listener: () => void) {
        if (type === "pagehide") pagehide.push(listener);
      },
    });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      expect(pick).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
      page.element("choose-file").click();
      await vi.waitFor(() => expect(page.fileText()).toContain("notes.txt"));
      expect(JSON.stringify(page.fileText())).not.toMatch(/\/Users|token|endpoint|inode|device/i);
      page
        .fileButtons()
        .find((button) => button.textContent === "Import")!
        .click();
      await vi.waitFor(() => expect(importFile).toHaveBeenCalledOnce());
      page.element("attach-image").click();
      expect(mediaPick).not.toHaveBeenCalled();
      finishImport({
        ok: true,
        value: {
          grantId: fileGrant.grantId,
          entryId: null,
          attachment: mediaAttachment("i", "notes.txt", "text/plain", false),
        },
      });
      await vi.waitFor(() =>
        expect(page.attachmentText()).toContain("notes.txt · 1 KB · text/plain"),
      );
      page.attachmentButtons()[0]!.click();
      page.element("attach-image").click();
      await vi.waitFor(() => expect(mediaPick).toHaveBeenCalledOnce());
      page
        .fileButtons()
        .find((button) => button.textContent === "Import")!
        .click();
      expect(importFile).toHaveBeenCalledOnce();
      finishMediaPick({
        ok: true,
        value: {
          attachments: [mediaAttachment("z", "pixel.png", "image/png", true)],
        },
      });
      await vi.waitFor(() =>
        expect(page.attachmentText()).toContain("pixel.png · 1 KB · image/png"),
      );
      page
        .fileButtons()
        .find((button) => button.textContent === "Release")!
        .click();
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
      page.sessionButtons()[1]!.click();
      await vi.waitFor(() => expect(page.element("current-title").textContent).toBe("Other"));
      finishGrantRelease({
        ok: true,
        value: { grantId: fileGrant.grantId, released: true },
      });
      await vi.waitFor(() =>
        expect(page.element("file-status").textContent).toBe("Choose a local file to import."),
      );
      pagehide[0]!();
      expect(release).toHaveBeenCalledWith({
        sessionId: "session-1",
        grantId: fileGrant.grantId,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows explicit current-view and watch controls with bounded public facts", async () => {
    const session = sessionSummary();
    const secondSession = {
      ...session,
      sessionId: "session-2",
      title: "Other",
    };
    const frameId = "b".repeat(48);
    const frame = {
      schemaVersion: 1 as const,
      kind: "frame" as const,
      captureId: "a".repeat(48),
      frameId,
      sessionId: session.sessionId,
      sourceKind: "display" as const,
      parentSourceKind: "display" as const,
      width: 800,
      height: 600,
      scaleFactor: 2,
      capturedAt: "2026-08-22T00:00:00Z",
      expiresAt: "2999-01-01T00:00:00Z",
      contentHash: "d".repeat(64),
      encoding: "image/jpeg" as const,
      sizeBytes: 2048,
      previewUrl: `openminion://app/capture/frames/${frameId}`,
    };
    let captureListener: ((value: CaptureEventV1) => void) | null = null;
    let observationListener: ((value: ObservationStatusV1) => void) | null = null;
    let turnListener: ((value: TurnEventV1) => void) | null = null;
    const ready = observationState({ sessionId: session.sessionId });
    const waiting = observationState({
      sessionId: session.sessionId,
      state: "waiting",
      watchEnabled: true,
      trigger: "changes",
    });
    const configure = vi.fn().mockResolvedValue({ ok: true, value: waiting });
    const stopObservation = vi.fn().mockResolvedValue({ ok: true, value: ready });
    const mismatchResult = {
      ok: true as const,
      value: {
        requestId: "request-result",
        traceId: "trace-mismatch",
        sessionId: session.sessionId,
      },
    };
    let finishMismatch = () => {};
    const mismatchPromise = new Promise<typeof mismatchResult>((resolve) => {
      finishMismatch = () => resolve(mismatchResult);
    });
    const submit = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          requestId: "request-1",
          traceId: "trace-1",
          sessionId: session.sessionId,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          requestId: "request-guide",
          traceId: "trace-guide",
          sessionId: session.sessionId,
        },
      })
      .mockReturnValueOnce(mismatchPromise);
    const mediaPick = vi.fn();
    const api = {
      app: {
        openLink: vi.fn().mockResolvedValue({ ok: true, value: null }),
        copyText: vi.fn().mockResolvedValue({ ok: true, value: null }),
        info: vi.fn().mockResolvedValue({ shellVersion: "0.0.0" }),
      },
      daemon: {
        status: vi.fn().mockResolvedValue(status({ state: "ready", reachable: true, protocol: 1 })),
        retry: vi.fn(),
      },
      sessions: {
        list: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            sessions: [session, secondSession],
            nextCursor: null,
            hasMore: false,
          },
        }),
        load: vi.fn(async ({ sessionId }) => ({
          ok: true,
          value: {
            session: sessionId === secondSession.sessionId ? secondSession : session,
            messages: [],
            nextMessageCursor: "message-zero",
            messagesHasMore: false,
          },
        })),
        events: vi.fn().mockResolvedValue({
          ok: true,
          value: { events: [], nextCursor: "event-zero", hasMore: false },
        }),
        create: vi.fn(),
        close: vi.fn(),
      },
      turns: {
        submit,
        cancel: vi.fn(),
        subscribe: vi.fn((listener) => {
          turnListener = listener;
          return vi.fn();
        }),
      },
      approvals: { decide: vi.fn() },
      media: { pick: mediaPick, release: vi.fn() },
      capture: {
        status: vi.fn().mockResolvedValue({
          ok: true,
          value: captureState({
            state: "observing",
            sessionId: session.sessionId,
            captureId: frame.captureId,
            sourceKind: "display",
            parentSourceKind: "display",
            sourceLabel: "Display 1",
          }),
        }),
        sources: vi.fn(),
        start: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        stop: vi.fn(),
        subscribe: vi.fn((listener) => {
          captureListener = listener;
          return vi.fn();
        }),
      },
      observation: {
        status: vi.fn().mockResolvedValue({ ok: true, value: ready }),
        configure,
        stop: stopObservation,
        subscribe: vi.fn((listener) => {
          observationListener = listener;
          return vi.fn();
        }),
      },
    } as unknown as NativeApi;
    const pagehide: Array<() => void> = [];
    vi.stubGlobal("window", {
      addEventListener(type: string, listener: () => void) {
        if (type === "pagehide") pagehide.push(listener);
      },
    });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      captureListener!(frame);
      const completeGuidance = async (
        message: string,
        requestId: string,
        traceId: string,
        selectedFrame: typeof frame,
      ) => {
        const callsBefore = submit.mock.calls.length;
        submit.mockResolvedValueOnce({
          ok: true,
          value: { requestId, traceId, sessionId: session.sessionId },
        });
        captureListener!(selectedFrame);
        page.element("composer").value = message;
        page.element("composer").dispatch("input");
        await vi.waitFor(() => expect(page.element("ask-guidance").disabled).toBe(false));
        page.element("ask-guidance").click();
        await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(callsBefore + 1));
        await vi.waitFor(() => expect(page.element("composer").value).toBe(""));
        turnListener!({
          schemaVersion: 1,
          kind: "started",
          requestId,
          sessionId: session.sessionId,
          traceId,
        });
        const sentFrame = observationFrame(selectedFrame, "user_send", traceId);
        observationListener!(
          observationState({
            sessionId: session.sessionId,
            state: "inferencing",
            currentReason: "user_send",
            selectedFrame: sentFrame,
            sentFrame,
          }),
        );
        turnListener!({
          schemaVersion: 1,
          kind: "response",
          sessionId: session.sessionId,
          traceId,
          finalText: `Guidance for ${message}`,
          errors: [],
          usage: {
            usageAvailable: false,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            llmCalls: null,
            durationMs: null,
            costUsd: null,
            costSource: "unavailable",
          },
        });
        turnListener!({
          schemaVersion: 1,
          kind: "done",
          sessionId: session.sessionId,
          traceId,
          outcome: "complete",
        });
        await vi.waitFor(() => expect(page.element("guidance-card").hidden).toBe(false));
      };
      expect(page.element("include-current-view").disabled).toBe(false);
      expect(page.element("include-screenshot-control").hidden).toBe(false);
      expect(page.element("screen-context-status").textContent).toContain("Local preview only");
      page.element("composer").value = "What is visible?";
      page.element("include-current-view").checked = true;
      page.element("composer").dispatch("input");
      expect(page.element("screen-context-status").textContent).toContain(
        "Included with next message",
      );
      page.element("composer-form").dispatch("submit");
      await vi.waitFor(() =>
        expect(submit).toHaveBeenCalledWith({
          sessionId: session.sessionId,
          message: "What is visible?",
          draftRevision: "00000000-0000-4000-8000-000000000001",
          observation: { includeCurrentView: true },
        }),
      );
      await vi.waitFor(() => expect(page.element("composer").value).toBe(""));
      expect(page.element("include-current-view").checked).toBe(false);
      turnListener!({
        schemaVersion: 1,
        kind: "done",
        sessionId: session.sessionId,
        traceId: "trace-1",
        outcome: "complete",
      });
      await vi.waitFor(() => expect(page.element("composer").disabled).toBe(false));

      page.element("composer").value = "Show me the safest next step";
      page.element("composer").dispatch("input");
      await vi.waitFor(() => expect(page.element("ask-guidance").disabled).toBe(false));
      expect(page.element("ask-guidance").disabled).toBe(false);
      page.element("ask-guidance").click();
      await vi.waitFor(() =>
        expect(submit).toHaveBeenLastCalledWith({
          sessionId: session.sessionId,
          message: "Show me the safest next step",
          draftRevision: "00000000-0000-4000-8000-000000000001",
          observation: { includeCurrentView: true },
        }),
      );
      await vi.waitFor(() => expect(page.element("composer").value).toBe(""));
      turnListener!({
        schemaVersion: 1,
        kind: "started",
        requestId: "request-guide",
        sessionId: session.sessionId,
        traceId: "trace-guide",
      });
      const guidanceFrame = observationFrame(frame, "user_send", "trace-guide");
      observationListener!(
        observationState({
          sessionId: session.sessionId,
          state: "inferencing",
          currentReason: "user_send",
          selectedFrame: guidanceFrame,
          sentFrame: guidanceFrame,
        }),
      );
      turnListener!({
        schemaVersion: 1,
        kind: "response",
        sessionId: session.sessionId,
        traceId: "trace-guide",
        finalText: "<button data-action='click'>Open the diff</button>",
        errors: [],
        usage: {
          usageAvailable: false,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          llmCalls: null,
          durationMs: null,
          costUsd: null,
          costSource: "unavailable",
        },
      });
      expect(page.element("guidance-card").hidden).toBe(true);
      turnListener!({
        schemaVersion: 1,
        kind: "done",
        sessionId: session.sessionId,
        traceId: "trace-guide",
        outcome: "complete",
      });
      await vi.waitFor(() => expect(page.element("guidance-card").hidden).toBe(false));
      expect(page.element("guidance-state").textContent).toBe("Current");
      expect(page.element("guidance-preview").src).toBe(frame.previewUrl);
      expect(page.element("guidance-text").textContent).toBe(
        "<button data-action='click'>Open the diff</button>",
      );
      expect(
        page
          .element("guidance-card")
          .descendants()
          .filter((item) => item.tagName === "button"),
      ).toEqual([]);
      expect(page.element("guidance-facts").textContent).toContain("sent");
      await vi.waitFor(() => expect(page.element("current-title").textContent).toBe(session.title));
      expect(page.element("guidance-card").hidden).toBe(false);
      turnListener!({
        schemaVersion: 1,
        kind: "done",
        sessionId: session.sessionId,
        traceId: "trace-guide",
        outcome: "complete",
      });
      expect(page.element("guidance-text").textContent).toBe(
        "<button data-action='click'>Open the diff</button>",
      );
      const newerFrame = {
        ...frame,
        frameId: "e".repeat(48),
        contentHash: "f".repeat(64),
        previewUrl: `openminion://app/capture/frames/${"e".repeat(48)}`,
      };
      captureListener!(newerFrame);
      expect(page.element("guidance-state").textContent).toBe("Stale");
      expect(page.element("guidance-status").textContent).toContain("newer frame");
      expect(page.element("guidance-preview").src).toBe("");
      captureListener!(frame);

      mediaPick.mockResolvedValueOnce({
        ok: true,
        value: {
          attachments: [mediaAttachment("a", "notes.txt", "text/plain", false)],
        },
      });
      page.element("attach-file").click();
      await vi.waitFor(() =>
        expect(page.attachmentText()).toContain("notes.txt · 1 KB · text/plain"),
      );
      page.element("composer").value = "Do not send unsupported media";
      page.element("composer").dispatch("input");
      expect(page.element("ask-guidance").disabled).toBe(true);
      page.element("ask-guidance").click();
      expect(submit).toHaveBeenCalledTimes(2);
      page.attachmentButtons()[0]!.click();

      mediaPick.mockResolvedValueOnce({
        ok: true,
        value: {
          attachments: ["1", "2", "3", "4"].map((id) =>
            mediaAttachment(id, `${id}.png`, "image/png", true),
          ),
        },
      });
      page.element("attach-image").click();
      await vi.waitFor(() => expect(page.attachmentButtons()).toHaveLength(4));
      expect(page.element("ask-guidance").disabled).toBe(true);
      page.element("ask-guidance").click();
      expect(submit).toHaveBeenCalledTimes(2);
      for (const button of page.attachmentButtons()) button.click();

      page.element("composer").value = "Reject mismatched identity";
      page.element("composer").dispatch("input");
      page.element("ask-guidance").click();
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(3));
      turnListener!({
        schemaVersion: 1,
        kind: "started",
        requestId: "request-event",
        sessionId: session.sessionId,
        traceId: "trace-mismatch",
      });
      finishMismatch();
      await vi.waitFor(() => expect(page.element("composer").value).toBe(""));
      const mismatchFrame = observationFrame(frame, "user_send", "trace-mismatch");
      observationListener!(
        observationState({
          sessionId: session.sessionId,
          state: "inferencing",
          currentReason: "user_send",
          selectedFrame: mismatchFrame,
          sentFrame: mismatchFrame,
        }),
      );
      turnListener!({
        schemaVersion: 1,
        kind: "response",
        sessionId: session.sessionId,
        traceId: "trace-mismatch",
        finalText: "This must not become guidance.",
        errors: [],
        usage: {
          usageAvailable: false,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          llmCalls: null,
          durationMs: null,
          costUsd: null,
          costSource: "unavailable",
        },
      });
      turnListener!({
        schemaVersion: 1,
        kind: "done",
        sessionId: session.sessionId,
        traceId: "trace-mismatch",
        outcome: "complete",
      });
      expect(page.element("guidance-card").hidden).toBe(true);

      await completeGuidance("Source change lifecycle", "request-source", "trace-source", frame);
      captureListener!({
        schemaVersion: 1,
        kind: "state",
        value: captureState({
          state: "observing",
          sessionId: session.sessionId,
          captureId: "b".repeat(48),
          sourceKind: "window",
          parentSourceKind: "window",
          sourceLabel: "Window 2",
        }),
      });
      expect(page.element("guidance-state").textContent).toBe("Stale");
      expect(page.element("guidance-status").textContent).toContain("source changed");

      const observingState = captureState({
        state: "observing",
        sessionId: session.sessionId,
        captureId: frame.captureId,
        sourceKind: "display",
        parentSourceKind: "display",
        sourceLabel: "Display 1",
      });
      captureListener!({
        schemaVersion: 1,
        kind: "state",
        value: observingState,
      });
      await completeGuidance("Pause lifecycle", "request-pause", "trace-pause", frame);
      captureListener!({
        schemaVersion: 1,
        kind: "state",
        value: { ...observingState, state: "paused", reason: "user_paused" },
      });
      expect(page.element("guidance-state").textContent).toBe("Stale");
      expect(page.element("guidance-status").textContent).toContain("no longer active");

      captureListener!({
        schemaVersion: 1,
        kind: "state",
        value: observingState,
      });
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-22T12:00:00Z"));
      const expiringFrame = {
        ...frame,
        frameId: "9".repeat(48),
        contentHash: "8".repeat(64),
        capturedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
        previewUrl: `openminion://app/capture/frames/${"9".repeat(48)}`,
      };
      await completeGuidance("Expiry lifecycle", "request-expiry", "trace-expiry", expiringFrame);
      expect(page.element("guidance-state").textContent).toBe("Current");
      await vi.advanceTimersByTimeAsync(1_001);
      expect(page.element("guidance-state").textContent).toBe("Stale");
      expect(page.element("guidance-status").textContent).toContain("frame expired");
      expect(page.element("guidance-preview").src).toBe("");
      vi.useRealTimers();

      captureListener!({
        schemaVersion: 1,
        kind: "state",
        value: observingState,
      });
      captureListener!(frame);

      page.element("observation-instruction").value = "Tell me when the build finishes";
      page.element("observation-instruction").dispatch("input");
      await vi.waitFor(() => expect(page.element("start-observation").disabled).toBe(false));
      page.element("start-observation").click();
      await vi.waitFor(() =>
        expect(configure).toHaveBeenCalledWith({
          sessionId: session.sessionId,
          instruction: "Tell me when the build finishes",
          trigger: "changes",
        }),
      );
      expect(page.element("observation-status").textContent).toContain("changed frame");
      const sent = observationFrame(frame, "watch", "trace-2");
      observationListener!(
        observationState({
          sessionId: session.sessionId,
          state: "inferencing",
          watchEnabled: true,
          trigger: "changes",
          currentReason: "watch",
          selectedFrame: sent,
          sentFrame: sent,
          counters: {
            ...ready.counters,
            captureFrames: 2,
            captureBytes: 4096,
            selectedFrames: 1,
            sentFrames: 1,
            uploadedBytes: 2048,
            inferencesStarted: 1,
          },
          rates: { ...ready.rates, capturedFrames: 2, inferencesStarted: 1 },
          usage: {
            usageAvailable: true,
            inputTokens: 5,
            outputTokens: 3,
            totalTokens: 8,
            llmCalls: 1,
            durationMs: 20,
            costUsd: null,
            costSource: "unavailable",
          },
        }),
      );
      expect(page.element("observation-sent-preview").src).toContain(frameId);
      expect(page.element("observation-sent-facts").textContent).toContain("preview expires in");
      expect(page.findText()).toContain("You · Automatic observation");
      expect(page.findText()).toContain("Reason: watch");
      expect(
        page
          .element("timeline")
          .descendants()
          .find((item) => item.tagName === "img")?.src,
      ).toBe(frame.previewUrl);
      expect(page.element("observation-counters").textContent).toContain("2/min");
      expect(page.element("observation-usage").textContent).toContain("5 input + 3 output");
      expect(
        JSON.stringify([
          page.element("observation-status").textContent,
          page.element("observation-selected-facts").textContent,
          page.element("observation-sent-facts").textContent,
          page.element("observation-counters").textContent,
          page.element("observation-usage").textContent,
        ]),
      ).not.toMatch(/mediaId|credential|endpoint|secret|\/Users\/|instruction/i);
      page.element("stop-observation").click();
      await vi.waitFor(() => expect(stopObservation).toHaveBeenCalledOnce());
      page.element("observation-instruction").value = "Private session instruction";
      page.element("include-current-view").checked = true;
      page.sessionButtons()[1]!.click();
      await vi.waitFor(() => expect(page.element("current-title").textContent).toBe("Other"));
      expect(page.element("observation-instruction").value).toBe("");
      expect(page.element("observation-trigger").value).toBe("changes");
      expect(page.element("include-current-view").checked).toBe(false);
      expect(page.element("observation-sent-preview").src).toBe("");
      expect(page.element("guidance-card").hidden).toBe(true);
      pagehide[0]!();
      expect(stopObservation).toHaveBeenCalledTimes(2);
      const reloaded = new FixtureDocument();
      await mount(api, reloaded.asDocument());
      expect(reloaded.element("guidance-card").hidden).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("observes a selected source locally without submitting a turn", async () => {
    const session = sessionSummary();
    const secondSession = {
      ...session,
      sessionId: "session-2",
      title: "Other",
    };
    const candidateId = "c".repeat(48);
    const captureId = "a".repeat(48);
    let captureListener: ((event: unknown) => void) | null = null;
    const idle = captureState({ sessionId: session.sessionId });
    const selecting = captureState({
      state: "selecting",
      sessionId: session.sessionId,
    });
    const denied = captureState({
      state: "blocked",
      reason: "permission_denied",
      permission: "denied",
      sessionId: session.sessionId,
    });
    const observing = captureState({
      state: "observing",
      reason: "user_started",
      captureId,
      sessionId: session.sessionId,
      sourceKind: "region",
      parentSourceKind: "display",
      sourceLabel: "Display 1",
      startedAt: "2026-08-21T00:00:00Z",
    });
    const statusCapture = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: idle })
      .mockResolvedValueOnce({ ok: true, value: selecting })
      .mockResolvedValueOnce({
        ok: true,
        value: captureState({ sessionId: secondSession.sessionId }),
      })
      .mockResolvedValueOnce({ ok: true, value: idle })
      .mockResolvedValue({ ok: true, value: denied });
    const sourceResult = {
      ok: true,
      value: {
        schemaVersion: 1,
        permission: "granted",
        candidates: [
          {
            schemaVersion: 1,
            candidateId,
            sourceKind: "display",
            label: "Display 1",
            previewUrl: `openminion://app/capture/candidates/${candidateId}`,
            previewWidth: 640,
            previewHeight: 360,
            scaleFactor: 2,
          },
        ],
        truncated: false,
        expiresAt: "2026-08-21T00:00:30Z",
      },
    };
    let resolveStaleSources!: (value: typeof sourceResult) => void;
    const staleSources = new Promise<typeof sourceResult>((resolve) => {
      resolveStaleSources = resolve;
    });
    const sources = vi
      .fn()
      .mockResolvedValueOnce(sourceResult)
      .mockResolvedValueOnce(sourceResult)
      .mockResolvedValueOnce(sourceResult)
      .mockReturnValueOnce(staleSources)
      .mockResolvedValue({
        ok: false,
        error: {
          code: "capture_permission_denied",
          message: "Screen recording permission was denied.",
          retryable: false,
          retryAfterMs: null,
        },
      });
    const start = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: observing })
      .mockResolvedValueOnce({ ok: true, value: observing })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "capture_source_expired",
          message: "The source selection expired. Choose it again.",
          retryable: true,
          retryAfterMs: null,
        },
      });
    const pause = vi.fn().mockResolvedValue({
      ok: true,
      value: captureState({
        ...observing,
        state: "paused",
        reason: "user_paused",
      }),
    });
    const resume = vi.fn().mockResolvedValue({
      ok: true,
      value: captureState({ ...observing, reason: "user_resumed" }),
    });
    const stop = vi.fn().mockResolvedValue({ ok: true, value: idle });
    const submit = vi.fn();
    let finishClose!: (value: unknown) => void;
    const closePending = new Promise((resolve) => {
      finishClose = resolve;
    });
    const close = vi
      .fn()
      .mockReturnValueOnce(closePending)
      .mockResolvedValueOnce({
        ok: true,
        value: { ...session, status: "closed" },
      });
    const api = {
      app: {
        openLink: vi.fn().mockResolvedValue({ ok: true, value: null }),
        copyText: vi.fn().mockResolvedValue({ ok: true, value: null }),
        info: vi.fn().mockResolvedValue({ shellVersion: "0.0.0" }),
      },
      daemon: {
        status: vi.fn().mockResolvedValue(status({ state: "ready", reachable: true, protocol: 1 })),
        retry: vi.fn(),
      },
      sessions: {
        list: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            sessions: [session, secondSession],
            nextCursor: null,
            hasMore: false,
          },
        }),
        load: vi.fn(async ({ sessionId }) => ({
          ok: true,
          value: {
            session: sessionId === secondSession.sessionId ? secondSession : session,
            messages: [],
            nextMessageCursor: "message-zero",
            messagesHasMore: false,
          },
        })),
        events: vi.fn().mockResolvedValue({
          ok: true,
          value: { events: [], nextCursor: "event-zero", hasMore: false },
        }),
        create: vi.fn(),
        close,
      },
      turns: {
        submit,
        cancel: vi.fn(),
        subscribe: vi.fn().mockReturnValue(vi.fn()),
      },
      approvals: { decide: vi.fn() },
      media: { pick: vi.fn(), release: vi.fn() },
      capture: {
        status: statusCapture,
        sources,
        start,
        pause,
        resume,
        stop,
        subscribe: vi.fn((listener) => {
          captureListener = listener;
          return vi.fn();
        }),
      },
    } as unknown as NativeApi;
    const pagehide: Array<() => void> = [];
    vi.stubGlobal("window", {
      addEventListener(type: string, listener: () => void) {
        if (type === "pagehide") pagehide.push(listener);
      },
    });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      expect(page.element("capture-status").textContent).toContain("Ready to observe");
      page.element("capture-window").click();
      expect(page.element("capture-source-kind").value).toBe("window");
      page.element("observe-computer").click();
      await vi.waitFor(() => expect(page.captureButtons()).toHaveLength(1));
      expect(sources).toHaveBeenNthCalledWith(1, {
        sessionId: session.sessionId,
        sourceKind: "window",
      });
      page.captureButtons()[0]!.click();
      page.element("capture-region-enabled").checked = true;
      page.element("capture-region-x").value = "75";
      page.element("capture-region-width").value = "50";
      page.element("capture-region-x").dispatch("input");
      expect(page.element("start-capture").disabled).toBe(true);
      page.element("capture-region-x").value = "10";
      page.element("capture-region-y").value = "20";
      page.element("capture-region-width").value = "40";
      page.element("capture-region-height").value = "50";
      page.element("capture-region-x").dispatch("input");
      expect(page.element("start-capture").disabled).toBe(false);
      page.element("start-capture").click();
      await vi.waitFor(() =>
        expect(start).toHaveBeenCalledWith({
          sessionId: session.sessionId,
          candidateId,
          region: { xBps: 1000, yBps: 2000, widthBps: 4000, heightBps: 5000 },
        }),
      );
      captureListener!({
        schemaVersion: 1,
        kind: "frame",
        captureId,
        frameId: "b".repeat(48),
        sessionId: session.sessionId,
        sourceKind: "region",
        parentSourceKind: "display",
        width: 800,
        height: 600,
        scaleFactor: 2,
        capturedAt: new Date().toISOString(),
        expiresAt: "2999-01-01T00:00:00Z",
        contentHash: "d".repeat(64),
        encoding: "image/jpeg",
        sizeBytes: 2048,
        previewUrl: `openminion://app/capture/frames/${"b".repeat(48)}`,
      });
      expect(page.element("capture-preview").src).toContain("/capture/frames/");
      expect(page.element("screen-context-summary").hidden).toBe(false);
      expect(page.element("capture-candidates").hidden).toBe(true);
      expect(page.element("capture-region-controls").hidden).toBe(true);
      expect(page.element("screen-context-preview").src).toBe(page.element("capture-preview").src);
      expect(page.element("capture-facts").textContent).toContain("800 × 600");
      page.element("pause-capture").click();
      await vi.waitFor(() => expect(page.element("capture-preview").src).toBe(""));
      expect(page.element("screen-context-preview").hidden).toBe(true);
      expect(page.element("screen-context-preview").src).toBe("");
      expect(page.element("include-current-view").checked).toBe(false);
      page.element("resume-capture").click();
      await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
      page.element("stop-capture").click();
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(page.element("screen-context-summary").hidden).toBe(true));
      page.element("observe-computer").click();
      await vi.waitFor(() => expect(sources).toHaveBeenCalledTimes(2));
      page.captureButtons()[0]!.click();
      page.element("start-capture").click();
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
      page.element("change-capture").click();
      await vi.waitFor(() => expect(sources).toHaveBeenCalledTimes(3));
      expect(stop).toHaveBeenCalledTimes(2);
      page.captureButtons()[0]!.click();
      page.element("start-capture").click();
      await vi.waitFor(() =>
        expect(page.element("capture-status").textContent).toContain("expired"),
      );
      expect(page.captureButtons()).toHaveLength(0);
      expect(page.element("capture-region-controls").hidden).toBe(true);
      page.element("observe-computer").click();
      await vi.waitFor(() => expect(sources).toHaveBeenCalledTimes(4));
      page.sessionButtons()[1]!.click();
      resolveStaleSources(sourceResult);
      await vi.waitFor(() => expect(page.element("current-title").textContent).toBe("Other"));
      expect(page.element("capture-preview").src).toBe("");
      expect(page.captureButtons()).toHaveLength(0);
      captureListener!({
        schemaVersion: 1,
        kind: "frame",
        captureId,
        frameId: "e".repeat(48),
        sessionId: session.sessionId,
        sourceKind: "display",
        parentSourceKind: "display",
        width: 640,
        height: 360,
        scaleFactor: 2,
        capturedAt: new Date().toISOString(),
        expiresAt: "2999-01-01T00:00:00Z",
        contentHash: "f".repeat(64),
        encoding: "image/jpeg",
        sizeBytes: 1024,
        previewUrl: `openminion://app/capture/frames/${"e".repeat(48)}`,
      });
      expect(page.element("capture-preview").src).toBe("");
      await vi.waitFor(() => expect(page.element("close-session").disabled).toBe(false));
      page.element("close-session").click();
      await vi.waitFor(() =>
        expect(close).toHaveBeenCalledWith({
          sessionId: secondSession.sessionId,
        }),
      );
      page.sessionButtons()[0]!.click();
      finishClose({ ok: true, value: { ...secondSession, status: "closed" } });
      await vi.waitFor(() => expect(page.element("current-title").textContent).toBe(session.title));
      await vi.waitFor(() => expect(page.element("observe-computer").disabled).toBe(false));
      statusCapture.mockReset().mockResolvedValue({ ok: true, value: denied });
      page.element("observe-computer").click();
      await vi.waitFor(() => expect(sources).toHaveBeenCalledTimes(5));
      await vi.waitFor(() => expect(page.element("capture-state").textContent).toBe("Blocked"));
      expect(page.element("capture-status").textContent).toBe(
        "Screen recording permission was denied.",
      );
      page.element("close-session").click();
      await vi.waitFor(() => expect(page.element("observe-computer").disabled).toBe(true));
      expect(page.element("capture-status").textContent).toContain("Choose a session");
      expect(submit).not.toHaveBeenCalled();
      expect(
        JSON.stringify([
          page.element("capture-status").textContent,
          page.element("capture-facts").textContent,
        ]),
      ).not.toMatch(/contentHash|nativeSource|screen:|token|endpoint|bytes/i);
      pagehide[0]!();
      expect(stop).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("scheduled task parity", () => {
  it("manages durable tasks while execution readiness is degraded", async () => {
    const control = vi.fn<NativeApi["tasks"]["control"]>(async () => ({
      ok: true,
      value: {
        scheduler: {
          state: "unreachable",
          hostedBy: "daemon",
          reason: "daemon_unreachable",
          lastHeartbeatAt: null,
          checkCommand: "openminion service status cron",
        },
        tasks: [
          {
            id: "task-1",
            title: "Review pull requests",
            status: "active",
            kind: "scheduled_recurring",
            schedule: "every:1800000ms",
            dueAt: "2026-09-30T12:00:00Z",
            operatorState: "running",
            resumeAction: "continue",
            sessionTarget: "isolated",
            validActions: ["pause", "cancel"],
            recentRuns: [
              {
                runId: "run-2",
                state: "failed",
                summary: null,
                attempts: 2,
                dueAt: "2026-09-30T11:29:00Z",
                availableAt: "2026-09-30T11:30:00Z",
                startedAt: "2026-09-30T11:30:00Z",
                finishedAt: "2026-09-30T11:31:00Z",
                isolatedSessionId: "result-session-2",
                error: {
                  code: "PROVIDER_UNAVAILABLE",
                  message: "Provider unavailable",
                },
                delivery: {
                  state: "not_requested",
                  mode: "none",
                  targets: [],
                  error: null,
                },
                deliveryTargets: [],
              },
              {
                runId: "run-1",
                state: "finished",
                summary: "Two pull requests reviewed",
                attempts: 1,
                dueAt: "2026-09-30T10:59:00Z",
                availableAt: "2026-09-30T11:00:00Z",
                startedAt: "2026-09-30T11:00:00Z",
                finishedAt: "2026-09-30T11:01:00Z",
                isolatedSessionId: "result-session-1",
                error: null,
                delivery: {
                  state: "failed",
                  mode: "announce",
                  targets: ["announce:last"],
                  error: {
                    code: "DELIVERY_FAILED",
                    message: "Destination unavailable",
                  },
                },
                deliveryTargets: [],
              },
            ],
          },
        ],
        pendingActions: [
          {
            decisionId: "decision-1",
            taskId: "task-1",
            reason: "Write access required",
            tool: "file.write",
          },
        ],
      },
    }));
    const session = sessionSummary();
    const stopped = status({ state: "stopped", reachable: false });
    const api = {
      app: { info: async () => ({ shellVersion: "test" }) },
      daemon: { status: async () => stopped, retry: async () => stopped },
      sessions: {
        list: async () => ({
          ok: true,
          value: { sessions: [session], nextCursor: null, hasMore: false },
        }),
        load: async () => ({
          ok: true,
          value: {
            session,
            messages: [],
            nextMessageCursor: null,
            messagesHasMore: false,
          },
        }),
        events: async () => ({
          ok: true,
          value: { events: [], nextCursor: null, hasMore: false },
        }),
      },
      tasks: { control },
      turns: { subscribe: () => () => {} },
    } as unknown as NativeApi;
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      page.element("composer").value = "/tasks";
      page.element("composer").dispatch("input");
      page.element("composer").dispatch("keydown", { key: "Enter" });
      await vi.waitFor(() =>
        expect(control).toHaveBeenCalledWith({
          sessionId: session.sessionId,
          action: "list",
        }),
      );
      const result = page.element("command-result");
      const text = result.descendants().map((item) => item.textContent);
      expect(text.join("\n")).toContain("Scheduler: unreachable");
      expect(text.join("\n")).toContain("Saved schedules remain manageable");
      expect(text).toEqual(
        expect.arrayContaining([
          "Details",
          "Resolve this approval in Focus.",
          expect.stringContaining("Result session: result-session-1"),
          expect.stringContaining("Available: 2026-09-30T11:00:00Z"),
          expect.stringContaining("Execution error: PROVIDER_UNAVAILABLE: Provider unavailable"),
          expect.stringContaining("Delivery: failed"),
          expect.stringContaining("Destination unavailable"),
        ]),
      );
      result
        .descendants()
        .find((item) => item.textContent === "Details")!
        .click();
      await vi.waitFor(() =>
        expect(control).toHaveBeenCalledWith({
          sessionId: session.sessionId,
          action: "show",
          taskId: "task-1",
        }),
      );
      expect(text).not.toEqual(expect.arrayContaining(["Allow", "Deny"]));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not invent degraded scheduler state for a general task inventory", () => {
    const page = new FixtureDocument();
    const container = page.createElement("div");
    renderTasks(
      page.asDocument(),
      container as unknown as HTMLElement,
      { tasks: [], pendingActions: [], scheduler: null },
      false,
      vi.fn(),
      vi.fn(),
    );
    const text = container
      .descendants()
      .map((item) => item.textContent)
      .join("\n");
    expect(text).not.toContain("Scheduler:");
    expect(text).not.toContain("degraded");
    expect(text).toContain("Schedule work");
  });

  it("keeps conversation copy distinct from scheduled task copy", () => {
    const html = readFileSync(new URL("../../src/renderer/index.html", import.meta.url), "utf8");
    const app = readFileSync(new URL("../../src/renderer/app.ts", import.meta.url), "utf8");
    for (const text of [
      "New task",
      "Search tasks",
      "Clear task search",
      "Your tasks will appear here.",
      "No matching tasks",
      "Choose or create a task",
      "Task actions",
      "Close task",
      "Task context",
      "Artifacts from this task",
      "Create or choose an open task",
      "Send a message to start this task",
      "Start a new task",
    ]) {
      expect(`${html}\n${app}`).not.toContain(text);
    }
    expect(html).toContain("New conversation");
    expect(html).toContain("Search conversations");
    expect(html).toContain('aria-label="Conversations"');
    expect(html).toContain('aria-label="Conversation outputs"');
    expect(`${html}\n${app}`).toContain("Scheduled work");
  });
});

class FixtureElement {
  focus = vi.fn();
  select = vi.fn();
  showModal = vi.fn(() => {
    this.open = true;
  });
  close = vi.fn(() => {
    this.open = false;
    this.dispatch("close");
  });
  scrollIntoView = vi.fn();
  removeAttribute = vi.fn();
  showPopover = vi.fn(() => {
    this.open = true;
  });
  hidePopover = vi.fn(() => {
    this.open = false;
  });
  matches(selector: string): boolean {
    return selector === ":popover-open" && this.open;
  }
  textContent = "";
  className = "";
  hidden = false;
  disabled = false;
  checked = false;
  open = false;
  value = "";
  src = "";
  alt = "";
  title = "";
  type = "";
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  children: FixtureElement[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event: FixtureEvent) => void>>();

  constructor(readonly tagName: string) {}

  querySelector(tag: string): FixtureElement | null {
    return this.descendants().find((item) => item !== this && item.tagName === tag) ?? null;
  }

  contains(element: FixtureElement | null): boolean {
    return element !== null && this.descendants().includes(element);
  }
  append(...children: FixtureElement[]): void {
    this.children.push(...children);
  }
  get lastElementChild(): FixtureElement | null {
    return this.children.at(-1) ?? null;
  }
  insertBefore(next: FixtureElement, previous: FixtureElement | null): void {
    this.children = this.children.filter((child) => child !== next);
    const index = previous === null ? this.children.length : this.children.indexOf(previous);
    this.children.splice(index, 0, next);
  }
  moveBefore(next: FixtureElement, previous: FixtureElement | null): void {
    this.insertBefore(next, previous);
  }
  removeChild(child: FixtureElement): void {
    this.children.splice(this.children.indexOf(child), 1);
  }
  replaceChildren(...children: FixtureElement[]): void {
    this.children = children;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: (event: FixtureEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) {
      listener({ preventDefault() {} });
    }
  }

  dispatch(type: string, event: Partial<KeyboardEvent> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ preventDefault() {}, ...event });
    }
  }

  descendants(): FixtureElement[] {
    return [this, ...this.children.flatMap((child) => child.descendants())];
  }
}

interface FixtureEvent {
  preventDefault(): void;
}

class FixtureDocument {
  readonly names = new Map<string, string>();
  readonly defaultView = {
    localStorage: {
      key: (index: number) => [...this.names.keys()][index] ?? null,
      getItem: (key: string) => this.names.get(key) ?? null,
      setItem: (key: string, value: string) => {
        this.names.set(key, value);
      },
      removeItem: (key: string) => {
        this.names.delete(key);
      },
    },
  };
  private static readonly requiredIds = [
    "chat-display",
    "chat-display-status",
    "settings-runtime-button",
    "status-dot",
    "status-summary",
    "retry",
    "show-connection",
    "diagnostics-dialog",
    "diagnostics-title",
    "diagnostics-result",
    "close-diagnostics",
    "show-daemon-status",
    "show-daemon-logs",
    "runtime-update-status",
    "runtime-update-source",
    "check-runtime-update",
    "stage-runtime-update",
    "pause-runtime-update",
    "discard-runtime-update",
    "pin-installed-runtime",
    "unpin-runtime",
    "runtime-pin-version",
    "pin-runtime-version",
    "connection-details",
    "recovery",
    "readiness-title",
    "readiness-summary",
    "readiness-actions",
    "readiness-retry",
    "readiness-settings",
    "installed-runtime-version",
    "daemon-version",
    "protocol-version",
    "shell-version",
    "connection-label",
    "session-list",
    "approval-notice",
    "session-search",
    "clear-session-search",
    "session-search-count",
    "new-session",
    "close-session",
    "current-title",
    "session-context-menu",
    "session-context-rename",
    "rename-session",
    "rename-dialog",
    "rename-form",
    "task-name",
    "rename-session-id",
    "rename-error",
    "rename-cancel",
    "rename-reset",
    "timeline",
    "conversation",
    "chat-progress",
    "reconnect-turn",
    "draft-status",
    "jump-latest",
    "chat-status",
    "chat-detail",
    "chat-update",
    "chat-elapsed",
    "composer-hint",
    "composer-form",
    "composer",
    "show-commands",
    "command-menu",
    "command-panel",
    "close-command",
    "command-title",
    "command-result",
    "context-panel",
    "screen-panel",
    "send",
    "cancel",
    "ask-guidance",
    "watch-settings",
    "guidance-card",
    "guidance-state",
    "guidance-preview",
    "guidance-facts",
    "guidance-text",
    "guidance-status",
    "attachments",
    "include-current-view",
    "include-screenshot-control",
    "screen-context-summary",
    "screen-context-name",
    "screen-context-status",
    "screen-context-preview",
    "attach-image",
    "attach-file",
    "refresh-artifacts",
    "artifact-status",
    "artifact-list",
    "artifact-detail",
    "artifact-detail-title",
    "artifact-content",
    "close-artifact",
    "choose-file",
    "file-status",
    "file-grant-list",
    "capture-state",
    "capture-status",
    "capture-source-kind",
    "capture-entire-screen",
    "capture-window",
    "observe-computer",
    "capture-candidates",
    "capture-region-controls",
    "capture-region-enabled",
    "capture-region-x",
    "capture-region-y",
    "capture-region-width",
    "capture-region-height",
    "capture-region-stage",
    "capture-region-image",
    "capture-region-overlay",
    "start-capture",
    "capture-live",
    "capture-preview",
    "capture-facts",
    "pause-capture",
    "resume-capture",
    "change-capture",
    "stop-capture",
    "observation-state",
    "observation-instruction",
    "observation-trigger",
    "start-observation",
    "stop-observation",
    "observation-status",
    "observation-selected",
    "observation-selected-preview",
    "observation-selected-facts",
    "observation-sent",
    "observation-sent-preview",
    "observation-sent-facts",
    "observation-counters",
    "observation-usage",
  ] as const;

  private readonly elements: Map<string, FixtureElement> = new Map(
    FixtureDocument.requiredIds.map((id) => [id, new FixtureElement("div")]),
  );
  activeElement: FixtureElement | null = null;

  constructor() {
    Object.defineProperty(this.defaultView.localStorage, "length", {
      get: () => this.names.size,
    });
    this.element("capture-source-kind").value = "display";
    this.element("capture-region-width").value = "100";
    this.element("capture-region-height").value = "100";
    this.element("capture-region-x").value = "0";
    this.element("capture-region-y").value = "0";
    this.element("observation-trigger").value = "changes";
    for (const element of this.elements.values()) this.trackFocus(element);
  }

  addEventListener = vi.fn();

  getElementById(id: string): FixtureElement | null {
    return this.elements.get(id) ?? null;
  }

  createElement(tagName: string): FixtureElement {
    return this.trackFocus(new FixtureElement(tagName));
  }
  asDocument(): Document {
    return this as unknown as Document;
  }

  findButtons(): FixtureElement[] {
    return this.timeline()
      .descendants()
      .filter((item) => item.tagName === "button");
  }

  findText(): string[] {
    return this.timeline()
      .descendants()
      .map((item) => item.textContent)
      .filter(Boolean);
  }

  element(id: string): FixtureElement {
    return this.elements.get(id)!;
  }

  attachmentButtons(): FixtureElement[] {
    return this.element("attachments")
      .descendants()
      .filter((item) => item.tagName === "button");
  }

  sessionButtons(): FixtureElement[] {
    return this.element("session-list")
      .descendants()
      .filter((item) => item.tagName === "button");
  }

  private trackFocus(element: FixtureElement): FixtureElement {
    element.focus = vi.fn(() => {
      this.activeElement = element;
    });
    return element;
  }

  attachmentText(): string[] {
    return this.element("attachments")
      .descendants()
      .map((item) => item.textContent)
      .filter(Boolean);
  }

  artifactButtons(): FixtureElement[] {
    return this.element("artifact-list")
      .descendants()
      .filter((item) => item.tagName === "button");
  }

  artifactText(): string[] {
    return this.element("artifact-list")
      .descendants()
      .map((item) => item.textContent)
      .filter(Boolean);
  }

  fileButtons(): FixtureElement[] {
    return this.element("file-grant-list")
      .descendants()
      .filter((item) => item.tagName === "button");
  }

  fileText(): string[] {
    return this.element("file-grant-list")
      .descendants()
      .map((item) => item.textContent)
      .filter(Boolean);
  }

  captureButtons(): FixtureElement[] {
    return this.element("capture-candidates")
      .descendants()
      .filter((item) => item.tagName === "button");
  }

  private timeline(): FixtureElement {
    return this.elements.get("timeline")!;
  }
}

function message(id: string, body: string) {
  return {
    schemaVersion: 1 as const,
    id,
    sessionId: "session-1",
    role: "assistant" as const,
    body,
    createdAt: "2026-08-19T00:00:01Z",
  };
}

function eventValue(cursor: string, state: string) {
  return {
    schemaVersion: 1 as const,
    eventType: `run.${state}`,
    cursor,
    createdAt: "2026-08-19T00:00:02Z",
    runId: "run-1",
    traceId: "trace-1",
    state,
    facts: {},
  };
}

function approvalEvent(phase: "requested" | "resolved") {
  const requested = phase === "requested";
  return {
    schemaVersion: 1 as const,
    eventType: `approval.${phase}`,
    cursor: requested ? "event-one" : "event-two",
    createdAt: requested ? "2026-08-19T00:00:02Z" : "2026-08-19T00:00:03Z",
    runId: null,
    traceId: "trace-1",
    state: requested ? "pending" : "terminal",
    facts: requested
      ? {
          approval_id: "approval-1",
          tool_name: "workspace.write",
          consent_preview: 'workspace.write(path="notes.txt", text="[bounded]")',
          requested_at: "2026-08-19T00:00:02Z",
          expires_at: "2026-08-19T00:01:02Z",
          outcome: "pending",
        }
      : {
          approval_id: "approval-1",
          tool_name: "workspace.write",
          consent_preview: 'workspace.write(path="notes.txt", text="[bounded]")',
          decision: "allow_once",
          outcome: "applied",
          resolved_at: "2026-08-19T00:00:03Z",
        },
  };
}

function approvalRendererApi(
  decide: ReturnType<typeof vi.fn>,
  sessions: SessionSummaryV1[] = [sessionSummary()],
): NativeApi {
  return {
    app: {
      openLink: vi.fn().mockResolvedValue({ ok: true, value: null }),
      copyText: vi.fn().mockResolvedValue({ ok: true, value: null }),
      info: vi.fn().mockResolvedValue({ shellVersion: "0.0.0" }),
    },
    daemon: {
      status: vi
        .fn()
        .mockResolvedValue(
          status({ state: "ready", reachable: true, daemonVersion: "0.0.9", protocol: 1 }),
        ),
      retry: vi.fn(),
    },
    sessions: {
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: { sessions, nextCursor: null, hasMore: false },
      }),
      load: vi.fn(async ({ sessionId }) => ({
        ok: true,
        value: {
          session: sessions.find((session) => session.sessionId === sessionId)!,
          messages: [],
          nextMessageCursor: "message-zero",
          messagesHasMore: false,
        },
      })),
      events: vi.fn(async ({ sessionId }) => ({
        ok: true,
        value: {
          events: sessionId === "session-1" ? [approvalEvent("requested")] : [],
          nextCursor: sessionId === "session-1" ? "event-one" : "event-zero",
          hasMore: false,
        },
      })),
      create: vi.fn(),
      close: vi.fn(),
    },
    turns: {
      submit: vi.fn(),
      cancel: vi.fn(),
      subscribe: vi.fn().mockReturnValue(vi.fn()),
    },
    approvals: { decide },
    media: { pick: vi.fn(), release: vi.fn() },
  } as unknown as NativeApi;
}

function sessionSummary(): SessionSummaryV1 {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    title: "Recovered chat",
    status: "active",
    createdAt: "2026-08-19T00:00:00Z",
    updatedAt: "2026-08-19T00:00:00Z",
    activeAgentId: "openminion",
    model: { provider: null, modelId: null },
    projectId: null,
    eventCursor: "event-zero",
  };
}

function captureState(overrides: Partial<CaptureStateV1> = {}): CaptureStateV1 {
  return {
    schemaVersion: 1,
    state: "idle",
    reason: "ready",
    permission: "granted",
    captureId: null,
    sessionId: null,
    sourceKind: null,
    parentSourceKind: null,
    sourceLabel: null,
    scaleFactor: null,
    startedAt: null,
    pausedAt: null,
    capturedFrames: 0,
    droppedFrames: 0,
    retainedBytes: 0,
    lastFrameAt: null,
    ...overrides,
  };
}

function observationState(overrides: Partial<ObservationStatusV1> = {}): ObservationStatusV1 {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    watchEnabled: false,
    trigger: null,
    state: "ready",
    currentReason: null,
    selectedFrame: null,
    sentFrame: null,
    counters: {
      schemaVersion: 1,
      captureFrames: 0,
      captureBytes: 0,
      selectedFrames: 0,
      sentFrames: 0,
      uploadedBytes: 0,
      skippedUnchanged: 0,
      skippedBusy: 0,
      replacedPending: 0,
      inferencesStarted: 0,
      inferencesCompleted: 0,
      inferencesFailed: 0,
      inferencesCancelled: 0,
    },
    rates: {
      schemaVersion: 1,
      windowMs: 60_000,
      capturedFrames: 0,
      inferencesStarted: 0,
      sampledAt: "2026-08-22T00:00:00Z",
    },
    usage: {
      usageAvailable: false,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      llmCalls: null,
      durationMs: null,
      costUsd: null,
      costSource: "unavailable",
    },
    lastError: null,
    updatedAt: "2026-08-22T00:00:00Z",
    ...overrides,
  };
}

function observationFrame(
  frame: {
    frameId: string;
    contentHash: string;
    width: number;
    height: number;
    capturedAt: string;
    expiresAt: string;
    previewUrl: string;
  },
  reason: ObservationFrameFactV1["reason"],
  traceId: string,
): ObservationFrameFactV1 {
  return {
    schemaVersion: 1,
    frameId: frame.frameId,
    contentHash: frame.contentHash,
    width: frame.width,
    height: frame.height,
    capturedAt: frame.capturedAt,
    expiresAt: frame.expiresAt,
    previewUrl: frame.previewUrl,
    reason,
    selectedAt: "2026-08-22T00:00:01Z",
    sentAt: "2026-08-22T00:00:02Z",
    traceId,
  };
}

function mediaAttachment(
  seed: string,
  name: string,
  mimeType: MediaAttachmentV1["mimeType"],
  turnCompatible: boolean,
  sessionId = "session-1",
): MediaAttachmentV1 {
  return {
    schemaVersion: 1,
    mediaId: seed.repeat(48),
    sessionId,
    name,
    mimeType,
    sizeBytes: 1024,
    kind: turnCompatible ? "image" : "file",
    turnCompatible,
    expiresAt: "2999-01-01T00:00:00Z",
  };
}

function artifactCatalogItem(): ArtifactCatalogItemV1 {
  return {
    schemaVersion: 1,
    artifactId: "A".repeat(48),
    sessionId: "session-1",
    kind: "artifact",
    displayName: "report.txt",
    mimeType: "text/plain",
    sizeBytes: 72,
    createdAt: "2026-08-20T00:00:00Z",
    source: "attachment",
    state: "active",
    contentKind: "diff",
    occurrenceCount: 1,
    toolName: null,
    toolStatus: null,
    summary: null,
    actions: ["detach", "read"],
  };
}

describe("command discovery", () => {
  it("matches canonical names and aliases without hiding argument usage", () => {
    expect(commandMatches("/task pause task-1").map((item) => item.name)).toEqual(["/tasks"]);
    expect(commandMatches("/cls").map((item) => item.name)).toEqual(["/clear"]);
    expect(commandMatches("/skills ").map((item) => item.name)).toEqual(["/skills"]);
    expect(commandMatches("//literal")).toEqual([]);
  });
});

describe("command picker keyboard access", () => {
  it("lets Shift+Tab leave suggestions without completion or restoring an older draft", async () => {
    const api = {
      app: { info: async () => ({ shellVersion: "test" }) },
      daemon: { status: async () => status({ state: "degraded" }) },
      turns: { subscribe: () => () => {} },
    } as unknown as NativeApi;
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      const composer = page.element("composer");
      composer.value = "Original draft";
      composer.dispatch("input");
      page.element("show-commands").click();
      composer.value = "/task pause task-1";
      composer.dispatch("input");
      expect(page.element("command-menu").hidden).toBe(false);
      expect(page.element("command-menu").children.length).toBe(1);
      expect(page.element("command-menu").children[0]!.getAttribute("tabindex")).toBe("-1");
      const preventDefault = vi.fn();
      composer.dispatch("keydown", { key: "Tab", shiftKey: true, preventDefault });
      expect(preventDefault).not.toHaveBeenCalled();
      expect(page.element("command-menu").hidden).toBe(true);
      expect(composer.value).toBe("/task pause task-1");
      expect(composer.removeAttribute).toHaveBeenCalledWith("aria-activedescendant");
      expect(page.element("show-commands").getAttribute("aria-expanded")).toBe("false");
      composer.dispatch("keydown", { key: "Escape" });
      expect(composer.value).toBe("/task pause task-1");

      composer.dispatch("input");
      composer.dispatch("keydown", { key: "Tab", preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(composer.value).toBe("/tasks pause task-1");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("describes composer shortcuts without relying on the hidden visual hint", () => {
    const html = readFileSync(new URL("../../src/renderer/index.html", import.meta.url), "utf8");
    expect(html).toContain('aria-describedby="composer-keyboard-help"');
    expect(html).toContain('id="composer-keyboard-help" class="sr-only"');
    expect(html).toContain("Shift+Tab to leave suggestions.");
  });
});

describe("saved drafts and disconnected responses", () => {
  function apiForDrafts(sessions = [sessionSummary()]): NativeApi {
    const api = approvalRendererApi(vi.fn(), sessions);
    vi.mocked(api.sessions.events).mockResolvedValue({
      ok: true,
      value: { events: [], nextCursor: "event-zero", hasMore: false },
    });
    return api;
  }

  it("blocks sending until a failed unbound-draft transfer cleanup succeeds", async () => {
    const api = apiForDrafts();
    vi.mocked(api.sessions.list).mockResolvedValue({
      ok: true,
      value: { sessions: [], nextCursor: null, hasMore: false },
    });
    vi.mocked(api.sessions.create).mockResolvedValue({ ok: true, value: sessionSummary() });
    api.drafts = {
      load: async () => ({ ok: true, value: [{ sessionId: "", text: "Original draft" }] }),
      save: vi.fn(async ({ clearUnbound }) =>
        clearUnbound
          ? {
              ok: false as const,
              error: {
                code: "storage_unavailable",
                message: "Draft cleanup failed. Keep this window open.",
                retryable: false,
                retryAfterMs: null,
              },
            }
          : { ok: true as const, value: "00000000-0000-4000-8000-000000000001" },
      ),
    };
    vi.mocked(api.turns.submit).mockResolvedValue({
      ok: false,
      error: { code: "rejected", message: "Not accepted.", retryable: false, retryAfterMs: null },
    });
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      page.element("composer-form").dispatch("submit");
      await vi.waitFor(() =>
        expect(page.element("draft-status").textContent).toBe(
          "Draft cleanup failed. Keep this window open.",
        ),
      );
      expect(page.element("draft-status").hidden).toBe(false);
      expect(page.element("composer").value).toBe("Original draft");
      expect(api.turns.submit).not.toHaveBeenCalled();
      page.element("composer-form").dispatch("submit");
      await vi.waitFor(() => expect(api.drafts.save).toHaveBeenCalledTimes(2));
      expect(api.turns.submit).not.toHaveBeenCalled();
      vi.mocked(api.drafts.save).mockResolvedValue({
        ok: true,
        value: "00000000-0000-4000-8000-000000000001",
      });
      page.element("composer-form").dispatch("submit");
      await vi.waitFor(() => expect(api.turns.submit).toHaveBeenCalledOnce());
      expect(page.element("draft-status").hidden).toBe(true);
      expect(page.element("composer").value).toBe("Original draft");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("restores independent session drafts and keeps unbound startup text out of existing chats", async () => {
    const sessions = [
      sessionSummary(),
      { ...sessionSummary(), sessionId: "session-2", title: "Second" },
    ];
    const api = apiForDrafts(sessions);
    const saved = new Map([
      ["", "Unbound draft"],
      ["session-1", "First draft"],
      ["session-2", "Second draft"],
    ]);
    api.drafts = {
      load: async () => ({
        ok: true,
        value: [...saved].map(([sessionId, text]) => ({ sessionId, text })),
      }),
      save: vi.fn(async ({ sessionId, text }) => {
        saved.set(sessionId, text);
        return { ok: true as const, value: "00000000-0000-4000-8000-000000000001" };
      }),
    };
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      expect(page.element("current-title").textContent).toBe("New conversation");
      expect(page.element("composer").value).toBe("Unbound draft");
      page.sessionButtons()[0]!.click();
      await vi.waitFor(() =>
        expect(page.element("current-title").textContent).toBe("Recovered chat"),
      );
      expect(page.element("composer").value).toBe("First draft");
      page.element("composer").value = "Edited first";
      page.element("composer").dispatch("input");
      page.sessionButtons()[1]!.click();
      await vi.waitFor(() => expect(page.element("current-title").textContent).toBe("Second"));
      expect(page.element("composer").value).toBe("Second draft");
      const reloaded = new FixtureDocument();
      await mount(api, reloaded.asDocument());
      expect(reloaded.element("composer").value).toBe("Unbound draft");
      reloaded.sessionButtons()[0]!.click();
      await vi.waitFor(() => expect(reloaded.element("composer").value).toBe("Edited first"));
      expect(api.turns.submit).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows save failure without losing text or submitting, and fences repeated sends during a save", async () => {
    const api = apiForDrafts();
    const failure = {
      ok: false as const,
      error: {
        code: "storage_unavailable",
        message: "Draft not saved. Keep this window open.",
        retryable: false,
        retryAfterMs: null,
      },
    };
    let finishSave!: (result: ClientResult<string>) => void;
    api.drafts = {
      load: async () => ({ ok: true, value: [] }),
      save: vi
        .fn()
        .mockResolvedValueOnce(failure)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishSave = resolve;
            }),
        ),
    };
    vi.mocked(api.turns.submit).mockResolvedValue({
      ok: false,
      error: {
        code: "request_rejected",
        message: "Not accepted.",
        retryable: false,
        retryAfterMs: null,
      },
    });
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      page.element("composer").value = "Keep this";
      page.element("composer-form").dispatch("submit");
      await vi.waitFor(() => expect(page.element("draft-status").hidden).toBe(false));
      expect(page.element("composer").value).toBe("Keep this");
      expect(api.turns.submit).not.toHaveBeenCalled();
      page.element("composer-form").dispatch("submit");
      await vi.waitFor(() => expect(api.drafts.save).toHaveBeenCalledTimes(2));
      page.element("composer-form").dispatch("submit");
      await Promise.resolve();
      expect(api.drafts.save).toHaveBeenCalledTimes(2);
      expect(page.element("send").disabled).toBe(true);
      finishSave({ ok: true, value: "00000000-0000-4000-8000-000000000001" });
      await vi.waitFor(() => expect(api.turns.submit).toHaveBeenCalledOnce());
      expect(page.element("composer").value).toBe("Keep this");
      expect(page.element("draft-status").hidden).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reconnects explicitly without clearing new drafts or text, and reads history when a turn is no longer retained", async () => {
    const api = apiForDrafts();
    let listener!: (event: TurnEventV1) => void;
    vi.mocked(api.turns.subscribe).mockImplementation((next) => {
      listener = next;
      return () => {};
    });
    vi.mocked(api.turns.submit).mockResolvedValue({
      ok: true,
      value: { sessionId: "session-1", traceId: "trace-1", requestId: "request-1" },
    });
    const error = {
      code: "stream_disconnected",
      message: "Response disconnected. Reconnect to continue.",
      retryable: true,
      retryAfterMs: null,
    };
    api.turns.reconnect = vi.fn(async () => {
      listener({
        schemaVersion: 1,
        kind: "connection",
        sessionId: "session-1",
        traceId: "trace-1",
        state: "reconnected",
        error: null,
      });
      return {
        ok: true as const,
        value: { sessionId: "session-1", traceId: "trace-1", requestId: "request-1" },
      };
    });
    let onHide = () => {};
    vi.stubGlobal("window", {
      addEventListener: (_name: string, callback: () => void) => {
        onHide = callback;
      },
    });
    try {
      const page = new FixtureDocument();
      await mount(api, page.asDocument());
      page.element("composer").value = "First request";
      page.element("composer-form").dispatch("submit");
      await vi.waitFor(() => expect(api.turns.submit).toHaveBeenCalledOnce());
      listener({
        schemaVersion: 1,
        kind: "progress",
        progressKind: "text",
        sessionId: "session-1",
        traceId: "trace-1",
        text: "Partial response",
        createdAt: "2026-10-06T00:00:00Z",
      });
      page.element("composer").value = "Next draft";
      page.element("composer").dispatch("input");
      listener({
        schemaVersion: 1,
        kind: "connection",
        sessionId: "session-1",
        traceId: "trace-1",
        state: "disconnected",
        error,
      });
      expect(page.element("reconnect-turn").hidden).toBe(false);
      expect(page.element("reconnect-turn").disabled).toBe(false);
      expect(api.turns.reconnect).not.toHaveBeenCalled();
      page.element("reconnect-turn").click();
      await vi.waitFor(() => expect(page.element("reconnect-turn").hidden).toBe(true));
      expect(api.turns.reconnect).toHaveBeenCalledWith({
        sessionId: "session-1",
        traceId: "trace-1",
      });
      expect(page.findText()).toContain("Partial response");
      expect(page.element("composer").value).toBe("Next draft");
      expect(api.turns.submit).toHaveBeenCalledOnce();
      listener({
        schemaVersion: 1,
        kind: "connection",
        sessionId: "session-1",
        traceId: "trace-1",
        state: "unavailable",
        error: {
          ...error,
          code: "trace_not_found",
          message: "Turn is no longer retained. Check conversation history.",
          retryable: false,
        },
      });
      await vi.waitFor(() => expect(api.sessions.load).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(page.element("cancel").hidden).toBe(true));
      expect(page.element("chat-status").textContent).toBe(
        "Turn is no longer retained. Check conversation history.",
      );
      expect(page.element("composer").value).toBe("Next draft");
      expect(api.turns.submit).toHaveBeenCalledOnce();
      onHide();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
