import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatName, ClientResult, RuntimePin } from "../shared/contracts.js";
import { failure } from "./openminion-client.js";

export type InstalledRuntime = {
  source: "pypi" | "binary";
  version: string;
  executable: string;
  sha256: string;
  manifestUrl: string;
  desktopMinVersion: string;
  desktopMaxVersionExclusive: string;
};
export type RuntimeState = {
  source: "pypi" | "binary";
  channel: "stable";
  active: InstalledRuntime | null;
  pending: InstalledRuntime | null;
  previous: InstalledRuntime | null;
  launchIntent: InstalledRuntime | null;
  paused: boolean;
  pin: RuntimePin | null;
};

export class DesktopStore {
  private readonly database: DatabaseSync;
  readonly runtimeHome: string;
  readonly browserHome: string;

  constructor(root: string, legacyRoot?: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = join(root, "desktop.sqlite");
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    this.database = new DatabaseSync(path);
    try {
      const version = this.database.prepare("PRAGMA user_version").get()!.user_version;
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3) {
        throw new Error(
          "Desktop data was created by a newer version. Install the newer app to open it.",
        );
      }
      if (version === 0) {
        const runtimeHome =
          legacyRoot &&
          ["agents.json", "runtime", "data"].some((name) => existsSync(join(legacyRoot, name)))
            ? legacyRoot
            : root;
        const browserHome =
          legacyRoot && existsSync(join(legacyRoot, "Partitions"))
            ? legacyRoot
            : join(root, "browser");
        this.database.exec("BEGIN IMMEDIATE");
        this.database.exec(`
          CREATE TABLE installation (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            runtime_home TEXT NOT NULL,
            browser_home TEXT NOT NULL,
            names_imported INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE chat_names (
            session_id TEXT PRIMARY KEY,
            title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120)
          );
          PRAGMA user_version = 1;
        `);
        this.database
          .prepare("INSERT INTO installation (id, runtime_home, browser_home) VALUES (1, ?, ?)")
          .run(runtimeHome, browserHome);
        this.database.exec("COMMIT");
      }
      if (version === 0 || version === 1) {
        this.database.exec("BEGIN IMMEDIATE");
        this.database.exec("ALTER TABLE installation ADD COLUMN runtime_state TEXT");
        this.database.prepare("UPDATE installation SET runtime_state = ? WHERE id = 1").run(
          JSON.stringify({
            source: "pypi",
            channel: "stable",
            active: null,
            pending: null,
            previous: null,
            launchIntent: null,
          }),
        );
        this.database.exec("PRAGMA user_version = 2; COMMIT");
      }
      if (version < 3) {
        this.database.exec("BEGIN IMMEDIATE");
        this.writeRuntimeState({ ...this.runtimeState(), paused: false, pin: null });
        this.database.exec("PRAGMA user_version = 3; COMMIT");
      }
      const installation = this.database
        .prepare("SELECT runtime_home, browser_home FROM installation WHERE id = 1")
        .get()!;
      this.runtimeHome = installation.runtime_home as string;
      this.browserHome = installation.browser_home as string;
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  runtimeState(): RuntimeState {
    return JSON.parse(
      this.database.prepare("SELECT runtime_state FROM installation WHERE id = 1").get()!
        .runtime_state as string,
    ) as RuntimeState;
  }

  stageRuntime(candidate: InstalledRuntime): void {
    const state = this.runtimeState();
    if (state.launchIntent) throw new Error("runtime_recovery_required");
    this.assertRuntimeAllowed(candidate);
    this.writeRuntimeState({ ...state, pending: candidate });
  }

  beginRuntimeLaunch(): InstalledRuntime {
    const state = this.runtimeState();
    if (state.launchIntent) throw new Error("runtime_recovery_required");
    if (!state.pending) throw new Error("runtime_candidate_unavailable");
    this.assertRuntimeAllowed(state.pending);
    this.writeRuntimeState({ ...state, launchIntent: state.pending });
    return state.pending;
  }

  runtimeAllowed(candidate: RuntimePin): boolean {
    const { paused, pin } = this.runtimeState();
    return (
      !paused &&
      (!pin ||
        (candidate.source === pin.source &&
          candidate.version === pin.version &&
          candidate.manifestUrl === pin.manifestUrl &&
          candidate.sha256 === pin.sha256))
    );
  }

  assertRuntimeAllowed(candidate: RuntimePin): void {
    if (this.runtimeState().paused) throw new Error("runtime_updates_paused");
    if (!this.runtimeAllowed(candidate)) throw new Error("runtime_pin_mismatch");
  }

  setRuntimePolicy(paused: boolean, pin: RuntimePin | null): void {
    const state = this.runtimeState();
    if (state.launchIntent) throw new Error("runtime_recovery_required");
    this.writeRuntimeState({ ...state, paused, pin });
  }

  discardRuntime(): void {
    const state = this.runtimeState();
    if (state.launchIntent) throw new Error("runtime_recovery_required");
    this.writeRuntimeState({ ...state, pending: null });
  }

  completeRuntimeLaunch(): void {
    const state = this.runtimeState();
    if (!state.launchIntent) throw new Error("runtime_launch_intent_missing");
    this.writeRuntimeState({
      ...state,
      source: state.launchIntent.source,
      previous: state.active,
      active: state.launchIntent,
      pending: null,
      launchIntent: null,
    });
  }

  private writeRuntimeState(state: RuntimeState): void {
    this.database
      .prepare("UPDATE installation SET runtime_state = ? WHERE id = 1")
      .run(JSON.stringify(state));
  }

  load(input: unknown): ClientResult<ChatName[]> {
    if (!Array.isArray(input) || input.length > 10000 || !input.every((name) => validName(name))) {
      return failure("invalid_input", "Saved chat names are invalid.");
    }
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const imported = this.database
        .prepare("SELECT names_imported FROM installation WHERE id = 1")
        .get()!.names_imported;
      if (!imported) {
        const insert = this.database.prepare(
          "INSERT INTO chat_names (session_id, title) VALUES (?, ?) ON CONFLICT DO NOTHING",
        );
        for (const name of input) insert.run(name.sessionId, name.title);
        this.database.exec("UPDATE installation SET names_imported = 1 WHERE id = 1");
      }
      this.database.exec("COMMIT");
      return {
        ok: true,
        value: this.database
          .prepare("SELECT session_id AS sessionId, title FROM chat_names ORDER BY session_id")
          .all() as unknown as ChatName[],
      };
    } catch {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      return failure(
        "storage_unavailable",
        "Could not load saved chat names. Restart the app to try again.",
      );
    }
  }

  save(input: unknown): ClientResult<null> {
    if (!validName(input, true))
      return failure("invalid_input", "Enter a name between 1 and 120 characters.");
    try {
      if (input.title === null) {
        this.database.prepare("DELETE FROM chat_names WHERE session_id = ?").run(input.sessionId);
      } else {
        this.database
          .prepare(
            "INSERT INTO chat_names (session_id, title) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET title = excluded.title",
          )
          .run(input.sessionId, input.title.trim());
      }
      return { ok: true, value: null };
    } catch {
      return failure("storage_unavailable", "Could not save the name on this device. Try again.");
    }
  }

  close(): void {
    this.database.close();
  }
}

function validName(
  input: unknown,
  allowReset = false,
): input is { sessionId: string; title: string | null } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const name = input as Record<string, unknown>;
  return (
    Object.keys(name).length === 2 &&
    typeof name.sessionId === "string" &&
    name.sessionId.length > 0 &&
    name.sessionId.length <= 512 &&
    ((allowReset && name.title === null) ||
      (typeof name.title === "string" && name.title.trim().length > 0 && name.title.length <= 120))
  );
}
