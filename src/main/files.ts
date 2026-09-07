import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, normalize } from "node:path";
import { dialog, type OpenDialogOptions, type OpenDialogReturnValue } from "electron";
import type {
  ClientResult,
  ErrorV1,
  FileGrantV1,
  FileImportInput,
  FileImportValue,
  FileListInput,
  FileListValue,
  FilePickInput,
  FilePickValue,
  FileReleaseInput,
  FileReleaseValue,
} from "../shared/contracts.js";
import { mediaType, type MediaService } from "./media.js";

const LIVE_GRANTS_PER_SESSION = 16;
const LIVE_GRANTS_PER_CLIENT = 32;
const PENDING_PICKS_PER_CLIENT = 32;
const TOMBSTONES_PER_SESSION = 16;
const TOMBSTONES_PER_CLIENT = 32;
const ABSOLUTE_TTL_MS = 10 * 60_000;
const IDLE_TTL_MS = 5 * 60_000;
const TOMBSTONE_TTL_MS = 5 * 60_000;
const PAGE_LIMIT = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

type PickDialog = (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>;
type WritableSessionClient = {
  validateWritableSession(
    sessionId: string,
  ): Promise<ClientResult<{ sessionId: string; writable: true }>>;
};
type TombstoneReason = "released" | "expired";

type GrantRecord = {
  grantId: string;
  sessionId: string;
  generation: number;
  path: string;
  displayName: string;
  handle: FileHandle;
  device: number;
  inode: number;
  sizeBytes: number;
  mtimeMs: number;
  expiresAt: number;
  lastAccessAt: number;
  state: "active" | "revoked";
  expiryTimer: ReturnType<typeof setTimeout> | null;
  operations: Map<AbortController, Promise<void>>;
};

type GrantTombstone = {
  grantId: string;
  sessionId: string;
  reason: TombstoneReason;
  expiresAt: number;
  createdAt: number;
};

type AdmittedOperation = {
  controller: AbortController;
  finish: () => void;
};

export class FileGrantService {
  readonly #client: WritableSessionClient;
  readonly #media: MediaService;
  readonly #pickDialog: PickDialog;
  readonly #clock: () => number;
  readonly #grants = new Map<string, GrantRecord>();
  readonly #tombstones = new Map<string, GrantTombstone>();
  readonly #generations = new Map<string, number>();
  readonly #fenceErrors = new Map<string, "session_closed" | "session_turn_active">();
  readonly #pendingPicks = new Map<string, number>();
  #pendingPickCount = 0;
  #selectedSession: string | null = null;
  #closed = false;

  constructor(
    client: WritableSessionClient,
    media: MediaService,
    pickDialog: PickDialog = (options) => dialog.showOpenDialog(options),
    clock: () => number = Date.now,
  ) {
    this.#client = client;
    this.#media = media;
    this.#pickDialog = pickDialog;
    this.#clock = clock;
  }

  async pick(input: FilePickInput): Promise<ClientResult<FilePickValue>> {
    const value = validatePickInput(input);
    if (!value.ok) return value;
    if (value.value.kind === "directory") {
      return fail("unsupported_file", "Folder import requires native filesystem support.");
    }
    if (this.#closed) {
      return fail("runtime_unavailable", "The desktop runtime is unavailable.");
    }
    const generation = this.#beginPick(value.value.sessionId);
    if (generation === null) {
      return fail("grant_backpressure", "Too many file selections are active.");
    }
    try {
      const initial = await this.#validateSession(value.value.sessionId);
      if (!initial.ok) return initial;
      const initialFence = this.#sessionFenceError(value.value.sessionId, generation);
      if (initialFence) return initialFence;
      let selection: OpenDialogReturnValue;
      try {
        selection = await this.#pickDialog({ properties: ["openFile"] });
      } catch {
        const fenced = this.#sessionFenceError(value.value.sessionId, generation);
        return fenced ?? fail("picker_failed", "The file picker could not be opened.");
      }
      const afterDialog = this.#sessionFenceError(value.value.sessionId, generation);
      if (afterDialog) return afterDialog;
      const second = await this.#validateSession(value.value.sessionId);
      if (!second.ok) return second;
      if (selection.canceled || selection.filePaths.length === 0) {
        return success({ grant: null });
      }
      if (selection.filePaths.length !== 1) {
        return fail("invalid_request", "The file selection is invalid.");
      }

      const inspected = await inspectFile(selection.filePaths[0]);
      if (!inspected.ok) return inspected;
      const third = await this.#validateSession(value.value.sessionId);
      if (!third.ok) {
        await inspected.value.handle.close().catch(() => undefined);
        return third;
      }
      const finalFence = this.#sessionFenceError(value.value.sessionId, generation);
      if (finalFence) {
        await inspected.value.handle.close().catch(() => undefined);
        return finalFence;
      }
      this.#purge();
      if (!this.#canAdmit(value.value.sessionId)) {
        await inspected.value.handle.close().catch(() => undefined);
        return fail("grant_backpressure", "Too many file grants are active.");
      }
      const now = this.#clock();
      const grant: GrantRecord = {
        grantId: opaqueId(),
        sessionId: value.value.sessionId,
        generation,
        path: inspected.value.path,
        displayName: inspected.value.displayName,
        handle: inspected.value.handle,
        device: inspected.value.stat.dev,
        inode: inspected.value.stat.ino,
        sizeBytes: inspected.value.stat.size,
        mtimeMs: inspected.value.stat.mtimeMs,
        expiresAt: now + ABSOLUTE_TTL_MS,
        lastAccessAt: now,
        state: "active",
        expiryTimer: null,
        operations: new Map(),
      };
      this.#grants.set(grant.grantId, grant);
      this.#scheduleExpiry(grant);
      return success({ grant: grantValue(grant) });
    } finally {
      this.#endPick(value.value.sessionId);
    }
  }

  async list(input: FileListInput): Promise<ClientResult<FileListValue>> {
    const value = validateListInput(input);
    if (!value.ok) return value;
    const found = this.#lookup(value.value.sessionId, value.value.grantId);
    if (!found.ok) return found;
    return fail("invalid_request", "Explicit file grants cannot be listed.");
  }

  async import(input: FileImportInput): Promise<ClientResult<FileImportValue>> {
    const value = validateImportInput(input);
    if (!value.ok) return value;
    if (value.value.entryId !== undefined) {
      return fail("invalid_request", "Explicit file imports do not accept an entry ID.");
    }
    const found = this.#lookup(value.value.sessionId, value.value.grantId);
    if (!found.ok) return found;
    const grant = found.value;
    const validation = await this.#validateSession(grant.sessionId);
    if (!validation.ok) {
      await this.#revoke(grant, "released");
      return validation;
    }
    const admitted = this.#admitOperation(grant);
    if (!admitted.ok) return admitted;

    let handle: FileHandle | undefined;
    try {
      const identity = await verifyIdentity(grant.path, grant);
      const afterIdentity = this.#operationError(grant, admitted.value.controller);
      if (afterIdentity) return afterIdentity;
      if (!identity.ok) {
        void this.#revoke(grant, "released");
        return identity;
      }
      try {
        handle = await open(grant.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const afterOpen = this.#operationError(grant, admitted.value.controller);
        if (afterOpen) return afterOpen;
        const stat = await handle.stat();
        const afterStat = this.#operationError(grant, admitted.value.controller);
        if (afterStat) return afterStat;
        if (!stat.isFile() || !sameFile(stat, grant)) {
          void this.#revoke(grant, "released");
          return fail("grant_changed", "The selected file changed.");
        }
      } catch {
        const interrupted = this.#operationError(grant, admitted.value.controller);
        if (interrupted) return interrupted;
        void this.#revoke(grant, "released");
        return fail("file_unavailable", "The selected file is unavailable.");
      }

      let uploaded: Awaited<ReturnType<MediaService["uploadGrantedFile"]>>;
      try {
        uploaded = await this.#media.uploadGrantedFile({
          sessionId: grant.sessionId,
          name: grant.displayName,
          sizeBytes: grant.sizeBytes,
          device: grant.device,
          inode: grant.inode,
          handle,
          signal: admitted.value.controller.signal,
        });
      } catch {
        uploaded = fail("import_failed", "The selected file could not be imported.");
      }
      const interrupted = this.#operationError(grant, admitted.value.controller);
      if (interrupted) {
        if (uploaded.ok) {
          await this.#media
            .release({
              sessionId: grant.sessionId,
              mediaId: uploaded.value.mediaId,
            })
            .catch(() => undefined);
        }
        return interrupted;
      }
      if (!uploaded.ok) return uploaded;
      this.#touch(grant);
      return success({
        grantId: grant.grantId,
        entryId: null,
        attachment: uploaded.value,
      });
    } finally {
      await handle?.close().catch(() => undefined);
      this.#finishOperation(grant, admitted.value);
    }
  }

  async release(input: FileReleaseInput): Promise<ClientResult<FileReleaseValue>> {
    const value = validateReleaseInput(input);
    if (!value.ok) return value;
    this.#purge();
    const grant = this.#grants.get(value.value.grantId);
    if (grant) {
      if (grant.sessionId !== value.value.sessionId) {
        return fail("invalid_request", "The file grant request is invalid.");
      }
      await this.#revoke(grant, "released");
      return success({ grantId: value.value.grantId, released: true });
    }
    const tombstone = this.#tombstones.get(value.value.grantId);
    if (!tombstone) return fail("grant_not_found", "The file grant was not found.");
    if (tombstone.sessionId !== value.value.sessionId) {
      return fail("invalid_request", "The file grant request is invalid.");
    }
    if (tombstone.reason === "released") {
      return success({ grantId: value.value.grantId, released: true });
    }
    return fail("grant_expired", "The file grant expired.");
  }

  async activateSession(sessionId: string): Promise<void> {
    if (this.#selectedSession === sessionId) return;
    const previous = this.#selectedSession;
    this.#selectedSession = sessionId;
    this.#generations.set(sessionId, this.#generation(sessionId));
    this.#fenceErrors.delete(sessionId);
    if (previous) {
      await this.fenceSession(previous);
      this.#cleanupSessionState(previous);
    }
  }

  async fenceSession(
    sessionId: string,
    error: "session_closed" | "session_turn_active" = "session_closed",
  ): Promise<void> {
    if (!this.#tracksSession(sessionId)) return;
    this.#fenceErrors.set(sessionId, error);
    this.#generations.set(sessionId, this.#generation(sessionId) + 1);
    const matches = [...this.#grants.values()].filter((grant) => grant.sessionId === sessionId);
    await Promise.all(matches.map((grant) => this.#revoke(grant, "released")));
    this.#cleanupSessionState(sessionId);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const sessionId of new Set([
      ...this.#generations.keys(),
      ...this.#pendingPicks.keys(),
      ...[...this.#grants.values()].map((grant) => grant.sessionId),
    ])) {
      this.#generations.set(sessionId, this.#generation(sessionId) + 1);
    }
    await Promise.all([...this.#grants.values()].map((grant) => this.#revoke(grant, "released")));
    this.#selectedSession = null;
    this.#generations.clear();
    this.#fenceErrors.clear();
  }

  async #validateSession(
    sessionId: string,
  ): Promise<ClientResult<{ sessionId: string; writable: true }>> {
    if (this.#closed) {
      return fail("runtime_unavailable", "The desktop runtime is unavailable.");
    }
    try {
      const result = await this.#client.validateWritableSession(sessionId);
      if (result.ok) {
        if (result.value.sessionId !== sessionId || result.value.writable !== true) {
          return fail("runtime_unavailable", "The desktop runtime returned an invalid session.");
        }
        return result;
      }
      if (
        ["forbidden", "session_not_found", "session_closed", "session_turn_active"].includes(
          result.error.code,
        )
      ) {
        return fail(result.error.code, safeSessionMessage(result.error.code));
      }
      return fail("runtime_unavailable", "The desktop runtime is unavailable.");
    } catch {
      return fail("runtime_unavailable", "The desktop runtime is unavailable.");
    }
  }

  #beginPick(sessionId: string): number | null {
    if (this.#closed || this.#pendingPickCount >= PENDING_PICKS_PER_CLIENT) return null;
    this.#pendingPickCount += 1;
    this.#pendingPicks.set(sessionId, (this.#pendingPicks.get(sessionId) ?? 0) + 1);
    this.#generations.set(sessionId, this.#generation(sessionId));
    return this.#generation(sessionId);
  }

  #endPick(sessionId: string): void {
    const count = this.#pendingPicks.get(sessionId) ?? 0;
    this.#pendingPickCount = Math.max(0, this.#pendingPickCount - 1);
    if (count <= 1) this.#pendingPicks.delete(sessionId);
    else this.#pendingPicks.set(sessionId, count - 1);
    this.#cleanupSessionState(sessionId);
  }

  #admitOperation(grant: GrantRecord): ClientResult<AdmittedOperation> {
    const error = this.#grantError(grant);
    if (error) return error;
    const controller = new AbortController();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    grant.operations.set(controller, finished);
    return success({ controller, finish });
  }

  #finishOperation(grant: GrantRecord, operation: AdmittedOperation): void {
    grant.operations.delete(operation.controller);
    operation.finish();
  }

  #lookup(sessionId: string, grantId: string): ClientResult<GrantRecord> {
    this.#purge();
    const grant = this.#grants.get(grantId);
    if (grant) {
      if (grant.sessionId !== sessionId) {
        return fail("invalid_request", "The file grant request is invalid.");
      }
      const error = this.#grantError(grant);
      return error ?? success(grant);
    }
    const tombstone = this.#tombstones.get(grantId);
    if (!tombstone) return fail("grant_not_found", "The file grant was not found.");
    if (tombstone.sessionId !== sessionId) {
      return fail("invalid_request", "The file grant request is invalid.");
    }
    return fail(
      tombstone.reason === "expired" ? "grant_expired" : "grant_revoked",
      tombstone.reason === "expired" ? "The file grant expired." : "The file grant was revoked.",
    );
  }

  #grantError(grant: GrantRecord, controller?: AbortController): ClientResult<never> | null {
    const now = this.#clock();
    if (grant.expiresAt <= now || grant.lastAccessAt + IDLE_TTL_MS <= now) {
      void this.#revoke(grant, "expired");
      return fail("grant_expired", "The file grant expired.");
    }
    if (
      this.#closed ||
      controller?.signal.aborted ||
      grant.state !== "active" ||
      this.#grants.get(grant.grantId) !== grant ||
      this.#generation(grant.sessionId) !== grant.generation
    ) {
      const reason = this.#tombstones.get(grant.grantId)?.reason;
      return fail(
        reason === "expired" ? "grant_expired" : "grant_revoked",
        reason === "expired" ? "The file grant expired." : "The file grant was revoked.",
      );
    }
    return null;
  }

  #operationError(grant: GrantRecord, controller: AbortController): ClientResult<never> | null {
    return this.#grantError(grant, controller);
  }

  #sessionFenceError(sessionId: string, generation: number): ClientResult<never> | null {
    if (this.#closed) {
      return fail("runtime_unavailable", "The desktop runtime is unavailable.");
    }
    if (this.#generation(sessionId) !== generation) {
      const code = this.#fenceErrors.get(sessionId) ?? "session_closed";
      return fail(code, safeSessionMessage(code));
    }
    return null;
  }

  #generation(sessionId: string): number {
    return this.#generations.get(sessionId) ?? 0;
  }

  #tracksSession(sessionId: string): boolean {
    return (
      this.#selectedSession === sessionId ||
      this.#pendingPicks.has(sessionId) ||
      [...this.#grants.values()].some((grant) => grant.sessionId === sessionId)
    );
  }

  #cleanupSessionState(sessionId: string): void {
    if (!this.#tracksSession(sessionId)) {
      this.#generations.delete(sessionId);
      this.#fenceErrors.delete(sessionId);
    }
  }

  #canAdmit(sessionId: string): boolean {
    return (
      this.#grants.size < LIVE_GRANTS_PER_CLIENT &&
      [...this.#grants.values()].filter((grant) => grant.sessionId === sessionId).length <
        LIVE_GRANTS_PER_SESSION
    );
  }

  #touch(grant: GrantRecord): void {
    grant.lastAccessAt = this.#clock();
    this.#scheduleExpiry(grant);
  }

  #scheduleExpiry(grant: GrantRecord): void {
    if (grant.expiryTimer) clearTimeout(grant.expiryTimer);
    const deadline = Math.min(grant.expiresAt, grant.lastAccessAt + IDLE_TTL_MS);
    grant.expiryTimer = setTimeout(
      () => {
        void this.#revoke(grant, "expired");
      },
      Math.max(0, deadline - this.#clock()),
    );
  }

  #purge(): void {
    const now = this.#clock();
    for (const [id, tombstone] of this.#tombstones) {
      if (tombstone.expiresAt <= now) this.#tombstones.delete(id);
    }
    for (const grant of [...this.#grants.values()]) {
      if (grant.expiresAt <= now || grant.lastAccessAt + IDLE_TTL_MS <= now) {
        void this.#revoke(grant, "expired");
      }
    }
  }

  async #revoke(grant: GrantRecord, reason: TombstoneReason): Promise<void> {
    if (grant.state !== "active") {
      await Promise.allSettled(grant.operations.values());
      return;
    }
    grant.state = "revoked";
    this.#grants.delete(grant.grantId);
    if (grant.expiryTimer) {
      clearTimeout(grant.expiryTimer);
      grant.expiryTimer = null;
    }
    for (const controller of grant.operations.keys()) controller.abort();
    this.#addTombstone(grant, reason);
    await Promise.allSettled(grant.operations.values());
    await grant.handle.close().catch(() => undefined);
    this.#cleanupSessionState(grant.sessionId);
  }

  #addTombstone(grant: GrantRecord, reason: TombstoneReason): void {
    const now = this.#clock();
    this.#tombstones.set(grant.grantId, {
      grantId: grant.grantId,
      sessionId: grant.sessionId,
      reason,
      createdAt: now,
      expiresAt: Math.min(grant.expiresAt, now + TOMBSTONE_TTL_MS),
    });
    const ordered = [...this.#tombstones.values()].sort(
      (left, right) => left.createdAt - right.createdAt,
    );
    while (ordered.length > TOMBSTONES_PER_CLIENT) {
      this.#tombstones.delete(ordered.shift()!.grantId);
    }
    const session = ordered.filter((item) => item.sessionId === grant.sessionId);
    while (session.length > TOMBSTONES_PER_SESSION) {
      const removed = session.shift()!;
      this.#tombstones.delete(removed.grantId);
      const index = ordered.indexOf(removed);
      if (index >= 0) ordered.splice(index, 1);
    }
  }
}

async function inspectFile(path: string): Promise<
  ClientResult<{
    path: string;
    displayName: string;
    handle: FileHandle;
    stat: Stats;
  }>
> {
  let handle: FileHandle | undefined;
  try {
    if (normalize(path) !== path) {
      return fail("unsupported_file", "The selected file is not supported.");
    }
    const selected = await lstat(path);
    if (selected.isSymbolicLink()) {
      return fail("unsupported_file", "The selected file is not supported.");
    }
    const resolved = await realpath(path);
    const displayName = basename(resolved);
    if (!validName(displayName)) {
      return fail("unsupported_file", "The selected file is not supported.");
    }
    const initial = await lstat(resolved);
    if (
      initial.isSymbolicLink() ||
      !initial.isFile() ||
      initial.size < 1 ||
      initial.size > MAX_FILE_BYTES ||
      mediaType(displayName) === null
    ) {
      return fail("unsupported_file", "The selected file is not supported.");
    }
    handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      !sameFile(stat, {
        device: initial.dev,
        inode: initial.ino,
        sizeBytes: initial.size,
        mtimeMs: initial.mtimeMs,
      })
    ) {
      await handle.close();
      return fail("grant_changed", "The selected file changed.");
    }
    return success({ path: resolved, displayName, handle, stat });
  } catch {
    await handle?.close().catch(() => undefined);
    return fail("file_unavailable", "The selected file is unavailable.");
  }
}

async function verifyIdentity(
  path: string,
  expected: { device: number; inode: number; sizeBytes: number; mtimeMs: number },
): Promise<ClientResult<Stats>> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || !sameFile(stat, expected)) {
      return fail("grant_changed", "The selected file changed.");
    }
    return success(stat);
  } catch {
    return fail("file_unavailable", "The selected file is unavailable.");
  }
}

function sameFile(
  stat: Stats,
  expected: { device: number; inode: number; sizeBytes: number; mtimeMs: number },
): boolean {
  return (
    stat.dev === expected.device &&
    stat.ino === expected.inode &&
    stat.size === expected.sizeBytes &&
    stat.mtimeMs === expected.mtimeMs
  );
}

function grantValue(grant: GrantRecord): FileGrantV1 {
  return {
    schemaVersion: 1,
    grantId: grant.grantId,
    sessionId: grant.sessionId,
    kind: "file",
    displayName: grant.displayName,
    expiresAt: new Date(grant.expiresAt).toISOString(),
    canList: false,
    canImport: true,
  };
}

function validatePickInput(input: FilePickInput): ClientResult<FilePickInput> {
  if (
    !exactRecord(input, ["sessionId", "kind"]) ||
    !validSessionId(input.sessionId) ||
    (input.kind !== "file" && input.kind !== "directory")
  ) {
    return fail("invalid_request", "The file picker request is invalid.");
  }
  return success({ sessionId: input.sessionId, kind: input.kind });
}

function validateListInput(input: FileListInput): ClientResult<FileListInput> {
  if (
    !exactRecord(input, ["sessionId", "grantId"], ["cursor", "limit"]) ||
    !validSessionId(input.sessionId) ||
    !opaque(input.grantId) ||
    (input.cursor !== undefined && !opaque(input.cursor)) ||
    (input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > PAGE_LIMIT))
  ) {
    return fail("invalid_request", "The file list request is invalid.");
  }
  return success(input);
}

function validateImportInput(input: FileImportInput): ClientResult<FileImportInput> {
  if (
    !exactRecord(input, ["sessionId", "grantId"], ["entryId"]) ||
    !validSessionId(input.sessionId) ||
    !opaque(input.grantId) ||
    (input.entryId !== undefined && !opaque(input.entryId))
  ) {
    return fail("invalid_request", "The file import request is invalid.");
  }
  return success(input);
}

function validateReleaseInput(input: FileReleaseInput): ClientResult<FileReleaseInput> {
  if (
    !exactRecord(input, ["sessionId", "grantId"]) ||
    !validSessionId(input.sessionId) ||
    !opaque(input.grantId)
  ) {
    return fail("invalid_request", "The file release request is invalid.");
  }
  return success(input);
}

function exactRecord(
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function validSessionId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
  );
}

function opaque(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{48}$/.test(value);
}

function validName(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value) <= 256 &&
    !value.includes("\0") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    value !== "." &&
    value !== ".." &&
    value.normalize("NFC") === value
  );
}

function opaqueId(): string {
  return randomBytes(36).toString("base64url");
}

function safeSessionMessage(code: string): string {
  if (code === "session_not_found") return "The selected session was not found.";
  if (code === "session_closed") return "The selected session is closed.";
  if (code === "session_turn_active") return "The selected session has an active turn.";
  return "The selected session is not authorized.";
}

function success<T>(value: T): ClientResult<T> {
  return { ok: true, value };
}

function fail(code: string, message: string): { ok: false; error: ErrorV1 } {
  return {
    ok: false,
    error: { code, message, retryable: false, retryAfterMs: null },
  };
}
