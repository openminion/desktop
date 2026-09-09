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
      "PRAGMA user_version = 2; CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep');",
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
});
