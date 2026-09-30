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
      expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(4);
      expect(
        db.prepare("SELECT quiet_tools FROM presentation WHERE id = 1").get()!.quiet_tools,
      ).toBe(1);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
        { name: "installation" },
        { name: "chat_names" },
        { name: "presentation" },
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

  it("preserves future schemas and corrupt files instead of replacing data", () => {
    const future = root();
    const db = new DatabaseSync(join(future, "desktop.sqlite"));
    db.exec(
      "PRAGMA user_version = 5; CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep');",
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
    db.exec("DROP TABLE presentation; PRAGMA user_version = 2");
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
    db.exec("DROP TABLE presentation; PRAGMA user_version = 3");
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
