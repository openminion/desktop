import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatName, ClientResult } from "../shared/contracts.js";
import { failure } from "./openminion-client.js";

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
      if (version !== 0 && version !== 1) {
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
