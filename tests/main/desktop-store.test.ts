import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopStore } from "../../src/main/desktop-store.js";

const roots: string[] = [];
const stores: DesktopStore[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "desktop-store-"));
  roots.push(path);
  return path;
}
function open(path: string, legacy?: string): DesktopStore {
  const store = new DesktopStore(path, legacy);
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Desktop SQLite storage", () => {
  it("keeps presentation preferences in Desktop SQLite across restarts", () => {
    const path = root();
    let store = open(path);
    expect(store.loadPresentation()).toEqual({ ok: true, value: { quietTools: false } });
    expect(store.savePresentation({ quietTools: true })).toEqual({ ok: true, value: null });
    expect(store.savePresentation({ quietTools: 1 })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    stores.pop()!.close();
    store = open(path);
    expect(store.loadPresentation()).toEqual({ ok: true, value: { quietTools: true } });
    const db = new DatabaseSync(join(path, "desktop.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(5);
      expect(
        db.prepare("SELECT quiet_tools FROM presentation WHERE id = 1").get()!.quiet_tools,
      ).toBe(1);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
        { name: "installation" },
        { name: "chat_names" },
        { name: "presentation" },
        { name: "chat_drafts" },
      ]);
    } finally {
      db.close();
    }
  });

  it("persists names and resets across app restarts without reimporting stale browser keys", () => {
    const path = root();
    let store = open(path);
    const legacy = [{ sessionId: "cli-tools:tools", title: "Planning" }];
    expect(store.runtimeHome).toBe(path);
    expect(store.browserHome).toBe(join(path, "browser"));
    expect(store.load(legacy)).toEqual({ ok: true, value: legacy });
    expect(store.save({ sessionId: "cli-tools:tools", title: "  Release  " }).ok).toBe(true);
    stores.pop()!.close();
    store = open(path);
    expect(store.load(legacy)).toEqual({
      ok: true,
      value: [{ sessionId: "cli-tools:tools", title: "Release" }],
    });
    expect(store.save({ sessionId: "cli-tools:tools", title: null }).ok).toBe(true);
    stores.pop()!.close();
    store = open(path);
    expect(store.load(legacy)).toEqual({ ok: true, value: [] });
    if (process.platform !== "win32")
      expect(statSync(join(path, "desktop.sqlite")).mode & 0o777).toBe(0o600);
  });

  it("records legacy runtime and browser locations without moving profiles or virtualenvs", () => {
    const path = root();
    const legacy = root();
    mkdirSync(join(legacy, "runtime"));
    mkdirSync(join(legacy, "Partitions"));
    writeFileSync(join(legacy, "agents.json"), "existing profile");
    let store = open(path, legacy);
    expect(store.runtimeHome).toBe(legacy);
    expect(store.browserHome).toBe(legacy);
    stores.pop()!.close();
    store = open(path, root());
    expect(store.runtimeHome).toBe(legacy);
    expect(store.browserHome).toBe(legacy);
    expect(readFileSync(join(legacy, "agents.json"), "utf8")).toBe("existing profile");
  });

  it("rejects invalid bridge input and keeps SQL-looking names as literal data", () => {
    const store = open(root());
    for (const input of [
      null,
      [],
      {},
      { sessionId: "", title: "Name" },
      { sessionId: "x", title: " " },
      { sessionId: "x", title: "x".repeat(121) },
      { sessionId: "x", title: "Name", path: "elsewhere" },
    ]) {
      expect(store.save(input).ok).toBe(false);
    }
    expect(
      store.load([
        { sessionId: "ok", title: "Name" },
        { sessionId: "bad", title: null },
      ]).ok,
    ).toBe(false);
    expect(store.load([])).toEqual({ ok: true, value: [] });
    const name = { sessionId: "session'; DROP TABLE chat_names; --", title: "Release 'one'" };
    expect(store.save(name).ok).toBe(true);
    expect(store.load([])).toEqual({ ok: true, value: [name] });
  });

  it("rolls back interrupted imports and reports write failures without losing saved names", () => {
    const path = root();
    const store = open(path);
    const db = new DatabaseSync(join(path, "desktop.sqlite"));
    try {
      db.exec(
        "CREATE TRIGGER reject_import BEFORE INSERT ON chat_names WHEN NEW.title = 'Rejected' BEGIN SELECT RAISE(ABORT, 'test interruption'); END;",
      );
      expect(
        store.load([
          { sessionId: "one", title: "First" },
          { sessionId: "two", title: "Rejected" },
        ]).ok,
      ).toBe(false);
      expect(db.prepare("SELECT count(*) AS count FROM chat_names").get()!.count).toBe(0);
      expect(db.prepare("SELECT names_imported FROM installation").get()!.names_imported).toBe(0);
      db.exec("DROP TRIGGER reject_import");
      expect(store.load([{ sessionId: "one", title: "First" }]).ok).toBe(true);
      db.exec("BEGIN EXCLUSIVE");
      expect(store.save({ sessionId: "one", title: "Blocked" })).toMatchObject({
        ok: false,
        error: { code: "storage_unavailable" },
      });
      db.exec("ROLLBACK");
      expect(store.load([])).toEqual({ ok: true, value: [{ sessionId: "one", title: "First" }] });
    } finally {
      db.close();
    }
  });

  it("restores unbound and session drafts exactly and persists explicit clearing", () => {
    const path = root();
    let store = open(path);
    const unbound = { sessionId: "", text: "  First line\nSecond line  " };
    const bound = { sessionId: "session'; DROP TABLE chat_drafts; --", text: "Session draft" };
    expect(store.saveDraft(unbound).ok).toBe(true);
    expect(store.saveDraft(bound).ok).toBe(true);
    stores.pop()!.close();
    store = open(path);
    expect(store.loadDrafts()).toEqual({ ok: true, value: [unbound, bound] });
    expect(store.saveDraft({ sessionId: "", text: "" }).ok).toBe(true);
    stores.pop()!.close();
    store = open(path);
    expect(store.loadDrafts()).toEqual({ ok: true, value: [bound] });
  });

  it("retains local session identity until promotion or explicit removal", () => {
    const path = root();
    let store = open(path);
    const session = {
      schemaVersion: 1 as const,
      sessionId: "local-session",
      title: "Planning",
      status: "idle" as const,
      createdAt: "2026-10-06T00:00:00Z",
      updatedAt: "2026-10-06T00:00:00Z",
      activeAgentId: null,
      model: { provider: null, modelId: null },
      projectId: null,
      eventCursor: "0",
    };
    store.rememberDraftSession(session);
    store.rememberDraftSession({ ...session, sessionId: "empty-local" });
    expect(store.saveDraft({ sessionId: session.sessionId, text: "Unsent" }).ok).toBe(true);
    stores.pop()!.close();
    store = open(path);
    expect(store.draftSessions()).toEqual([session, { ...session, sessionId: "empty-local" }]);
    store.removeDraft("empty-local");
    store.promoteDraftSession(session.sessionId);
    expect(store.draftSessions()).toEqual([]);
    expect(store.loadDrafts()).toEqual({
      ok: true,
      value: [{ sessionId: session.sessionId, text: "Unsent" }],
    });
    store.removeDraft(session.sessionId);
    store.rememberDraftSession({ ...session, sessionId: "closed-local" });
    store.removeDraft("closed-local");
    stores.pop()!.close();
    store = open(path);
    expect(store.draftSessions()).toEqual([]);
    expect(store.loadDrafts()).toEqual({ ok: true, value: [] });
  });

  it("atomically transfers an unbound draft and never restores accepted text after restart", () => {
    const path = root();
    let store = open(path);
    const session = {
      schemaVersion: 1 as const,
      sessionId: "local-transfer",
      title: "Planning",
      status: "idle" as const,
      createdAt: "2026-10-06T00:00:00Z",
      updatedAt: "2026-10-06T00:00:00Z",
      activeAgentId: null,
      model: { provider: null, modelId: null },
      projectId: null,
      eventCursor: "0",
    };
    expect(store.saveDraft({ sessionId: "", text: "A" }).ok).toBe(true);
    store.rememberDraftSession(session);
    const db = new DatabaseSync(join(path, "desktop.sqlite"));
    try {
      db.exec(
        "CREATE TRIGGER prevent_unbound_delete BEFORE DELETE ON chat_drafts WHEN OLD.session_id = '' BEGIN SELECT RAISE(ABORT, 'transfer rejected'); END",
      );
      expect(
        store.saveDraft({ sessionId: session.sessionId, text: "A", clearUnbound: true }),
      ).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
      expect(
        db.prepare("SELECT text FROM chat_drafts WHERE session_id = ?").get(session.sessionId),
      ).toEqual({ text: "" });
      stores.pop()!.close();
      store = open(path);
      expect(store.loadDrafts()).toEqual({ ok: true, value: [{ sessionId: "", text: "A" }] });
      expect(store.draftSessions()).toEqual([session]);
      db.exec("DROP TRIGGER prevent_unbound_delete");
      const saved = store.saveDraft({
        sessionId: session.sessionId,
        text: "A",
        clearUnbound: true,
      });
      if (!saved.ok) throw new Error(saved.error.message);
      expect(store.loadDrafts()).toEqual({
        ok: true,
        value: [{ sessionId: session.sessionId, text: "A" }],
      });
      expect(store.consumeDraft({ sessionId: session.sessionId, revision: saved.value })).toEqual({
        ok: true,
        value: null,
      });
      stores.pop()!.close();
      store = open(path);
      expect(store.loadDrafts()).toEqual({ ok: true, value: [] });
      expect(store.draftSessions()).toEqual([session]);
    } finally {
      db.close();
    }
  });

  it("consumes only the accepted revision even when newer text changes back to the same value", () => {
    const path = root();
    let store = open(path);
    const first = store.saveDraft({ sessionId: "one", text: "A" });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    expect(store.saveDraft({ sessionId: "one", text: "B" }).ok).toBe(true);
    const latest = store.saveDraft({ sessionId: "one", text: "A" });
    expect(latest.ok).toBe(true);
    if (!latest.ok) throw new Error(latest.error.message);
    expect(latest.value).not.toBe(first.value);
    expect(store.consumeDraft({ sessionId: "one", revision: first.value }).ok).toBe(true);
    expect(store.consumeDraft({ sessionId: "other", revision: latest.value }).ok).toBe(true);
    expect(store.loadDrafts()).toEqual({ ok: true, value: [{ sessionId: "one", text: "A" }] });
    expect(store.consumeDraft({ sessionId: "one", revision: latest.value }).ok).toBe(true);
    stores.pop()!.close();
    store = open(path);
    expect(store.loadDrafts()).toEqual({ ok: true, value: [] });
    expect(store.saveDraft({ sessionId: "one", text: "A" }).ok).toBe(true);
    expect(store.consumeDraft({ sessionId: "one", revision: latest.value }).ok).toBe(true);
    expect(store.loadDrafts()).toEqual({ ok: true, value: [{ sessionId: "one", text: "A" }] });
  });

  it("rejects malformed draft writes and consumption without changing saved text", () => {
    const store = open(root());
    expect(store.saveDraft({ sessionId: "", text: "Keep" }).ok).toBe(true);
    for (const input of [
      null,
      [],
      {},
      { sessionId: 1, text: "Draft" },
      { sessionId: "one", text: null },
      { sessionId: "x".repeat(257), text: "Draft" },
      { sessionId: "one", text: "x".repeat(250_001) },
      { sessionId: "one", text: "Draft", path: "elsewhere" },
      { sessionId: "one", text: "Draft", clearUnbound: false },
      { sessionId: "", text: "Draft", clearUnbound: true },
      { sessionId: "one", text: "Draft", clearUnbound: true, unknown: true },
    ]) {
      expect(store.saveDraft(input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
    for (const input of [
      null,
      [],
      {},
      { sessionId: 1, revision: "x".repeat(36) },
      { sessionId: "x".repeat(257), revision: "x".repeat(36) },
      { sessionId: "", revision: null },
      { sessionId: "", revision: "short" },
      { sessionId: "", revision: "x".repeat(37) },
      { sessionId: "", revision: "x".repeat(36), text: "Keep" },
    ]) {
      expect(store.consumeDraft(input)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(store.loadDrafts()).toEqual({ ok: true, value: [{ sessionId: "", text: "Keep" }] });
    expect(store.saveDraft({ sessionId: "x".repeat(256), text: "x".repeat(250_000) }).ok).toBe(
      true,
    );
  });

  it("reports draft read, save, and accepted-message cleanup failures without losing saved text", () => {
    const path = root();
    const store = open(path);
    const saved = store.saveDraft({ sessionId: "one", text: "Keep" });
    if (!saved.ok) throw new Error(saved.error.message);
    const db = new DatabaseSync(join(path, "desktop.sqlite"));
    try {
      db.exec("BEGIN EXCLUSIVE");
      expect(store.loadDrafts()).toMatchObject({
        ok: false,
        error: { code: "storage_unavailable" },
      });
      expect(store.saveDraft({ sessionId: "one", text: "New" })).toMatchObject({
        ok: false,
        error: { code: "storage_unavailable", message: expect.stringContaining("Draft not saved") },
      });
      expect(store.consumeDraft({ sessionId: "one", revision: saved.value })).toMatchObject({
        ok: false,
        error: { code: "storage_unavailable", message: expect.stringContaining("Do not resend") },
      });
      db.exec("ROLLBACK");
      expect(store.loadDrafts()).toEqual({ ok: true, value: [{ sessionId: "one", text: "Keep" }] });
      expect(store.consumeDraft({ sessionId: "one", revision: saved.value })).toEqual({
        ok: true,
        value: null,
      });
      expect(store.loadDrafts()).toEqual({ ok: true, value: [] });
    } finally {
      db.close();
    }
  });

  it("migrates schema four without changing names, presentation, or runtime state", () => {
    const path = root();
    let store = open(path);
    expect(store.save({ sessionId: "keep", title: "Existing" }).ok).toBe(true);
    expect(store.savePresentation({ quietTools: true }).ok).toBe(true);
    const before = store.runtimeState();
    stores.pop()!.close();
    const db = new DatabaseSync(join(path, "desktop.sqlite"));
    db.exec("DROP TABLE chat_drafts; PRAGMA user_version = 4");
    db.close();
    store = open(path);
    expect(store.runtimeState()).toEqual(before);
    expect(store.load([])).toEqual({ ok: true, value: [{ sessionId: "keep", title: "Existing" }] });
    expect(store.loadPresentation()).toEqual({ ok: true, value: { quietTools: true } });
    expect(store.loadDrafts()).toEqual({ ok: true, value: [] });
    expect(store.draftSessions()).toEqual([]);
  });

  it("preserves future schemas and corrupt files instead of replacing data", () => {
    const future = root();
    const db = new DatabaseSync(join(future, "desktop.sqlite"));
    db.exec(
      "PRAGMA user_version = 6; CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep');",
    );
    db.close();
    const before = readFileSync(join(future, "desktop.sqlite"));
    expect(() => open(future)).toThrow("newer version");
    expect(readFileSync(join(future, "desktop.sqlite"))).toEqual(before);
    const corrupt = root();
    writeFileSync(join(corrupt, "desktop.sqlite"), "not a database");
    expect(() => open(corrupt)).toThrow();
    expect(readFileSync(join(corrupt, "desktop.sqlite"), "utf8")).toBe("not a database");
  });

  it("preserves a durable launch intent after a crash instead of automatically downgrading", () => {
    const path = root();
    let store = open(path);
    const candidate = {
      source: "pypi" as const,
      version: "1.0.0",
      executable: "/private/runtime/python/bin/openminion",
      sha256: "a".repeat(64),
      manifestUrl: "immutable",
      desktopMinVersion: "0.0.0",
      desktopMaxVersionExclusive: "2.0.0",
    };
    store.stageRuntime(candidate);
    expect(store.runtimeState()).toMatchObject({
      source: "pypi",
      active: null,
      pending: candidate,
    });
    expect(store.beginRuntimeLaunch()).toEqual(candidate);
    stores.pop()!.close();
    store = open(path);
    expect(store.runtimeState().launchIntent).toEqual(candidate);
    expect(() => store.beginRuntimeLaunch()).toThrow("runtime_recovery_required");
    expect(() => store.stageRuntime(candidate)).toThrow("runtime_recovery_required");
    store.completeRuntimeLaunch();
    expect(store.runtimeState()).toMatchObject({
      active: candidate,
      pending: null,
      launchIntent: null,
      paused: false,
      pin: null,
    });
  });

  it("persists holds and exact identities, discards only pending state, and refuses launch-time edits", () => {
    const path = root();
    let store = open(path);
    const candidate = {
      source: "pypi" as const,
      version: "1.0.0",
      executable: "/private/runtime/openminion",
      sha256: "a".repeat(64),
      manifestUrl: "immutable",
      desktopMinVersion: "0.0.0",
      desktopMaxVersionExclusive: "2.0.0",
    };
    store.stageRuntime(candidate);
    store.setRuntimePolicy(true, candidate);
    stores.pop()!.close();
    store = open(path);
    expect(store.runtimeState()).toMatchObject({
      paused: true,
      pin: candidate,
      pending: candidate,
    });
    expect(() => store.beginRuntimeLaunch()).toThrow("runtime_updates_paused");
    store.discardRuntime();
    expect(store.runtimeState()).toMatchObject({ active: null, pending: null, paused: true });
    store.setRuntimePolicy(false, candidate);
    for (const change of [
      { version: "2.0.0" },
      { manifestUrl: "other-revision" },
      { sha256: "b".repeat(64) },
      { source: "binary" as const },
    ]) {
      expect(() => store.stageRuntime({ ...candidate, ...change })).toThrow("runtime_pin_mismatch");
    }
    store.stageRuntime(candidate);
    store.beginRuntimeLaunch();
    expect(() => store.discardRuntime()).toThrow("runtime_recovery_required");
    expect(() => store.setRuntimePolicy(true, null)).toThrow("runtime_recovery_required");
    store.completeRuntimeLaunch();
    store.discardRuntime();
    expect(store.runtimeState().active).toEqual(candidate);
    expect(() => store.setRuntimeSource("binary")).toThrow("runtime_pin_source_mismatch");
    store.setRuntimePolicy(false, null);
    store.setRuntimeSource("binary");
    expect(store.runtimeState()).toMatchObject({ source: "binary", active: candidate });
  });

  it("migrates schema two while retaining a prepared candidate and launch intent", () => {
    const path = root();
    const store = open(path);
    const before = store.runtimeState();
    stores.pop()!.close();
    const db = new DatabaseSync(join(path, "desktop.sqlite"));
    db.exec("DROP TABLE chat_drafts; DROP TABLE presentation; PRAGMA user_version = 2");
    const { paused, pin, ...legacy } = before;
    expect(paused).toBe(false);
    expect(pin).toBeNull();
    db.prepare("UPDATE installation SET runtime_state = ?").run(
      JSON.stringify({
        ...legacy,
        pending: { version: "keep" },
        launchIntent: { version: "recover" },
      }),
    );
    db.close();
    expect(open(path).runtimeState()).toMatchObject({
      paused: false,
      pin: null,
      pending: { version: "keep" },
      launchIntent: { version: "recover" },
    });
  });

  it("migrates schema three without changing names or runtime state", () => {
    const path = root();
    let store = open(path);
    expect(store.save({ sessionId: "keep", title: "Existing" }).ok).toBe(true);
    const before = store.runtimeState();
    stores.pop()!.close();
    const db = new DatabaseSync(join(path, "desktop.sqlite"));
    db.exec("DROP TABLE chat_drafts; DROP TABLE presentation; PRAGMA user_version = 3");
    db.close();
    store = open(path);
    expect(store.runtimeState()).toEqual(before);
    expect(store.load([])).toEqual({
      ok: true,
      value: [{ sessionId: "keep", title: "Existing" }],
    });
    expect(store.loadPresentation()).toEqual({ ok: true, value: { quietTools: false } });
  });

  it("migrates schema one without moving installations or upgrading the runtime", () => {
    const path = root();
    const db = new DatabaseSync(join(path, "desktop.sqlite"));
    db.exec(
      "CREATE TABLE installation (id INTEGER PRIMARY KEY, runtime_home TEXT, browser_home TEXT, names_imported INTEGER); CREATE TABLE chat_names (session_id TEXT PRIMARY KEY, title TEXT); PRAGMA user_version = 1",
    );
    db.prepare("INSERT INTO installation VALUES (1, ?, ?, 1)").run(path, join(path, "browser"));
    db.exec("INSERT INTO chat_names VALUES ('keep', 'Existing')");
    db.close();
    const store = open(path);
    expect(store.runtimeState()).toEqual({
      source: "pypi",
      channel: "stable",
      active: null,
      pending: null,
      previous: null,
      launchIntent: null,
      paused: false,
      pin: null,
    });
    expect(store.load([])).toEqual({ ok: true, value: [{ sessionId: "keep", title: "Existing" }] });
  });
});
