import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileGrantService } from "../../src/main/files.js";
import type { MediaAttachmentV1 } from "../../src/shared/contracts.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("FileGrantService", () => {
  it("keeps the native path in main and imports through the fixed media seam", async () => {
    const root = await temporaryRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "safe text");
    const client = writableClient();
    const uploadGrantedFile = vi.fn(async (input) => {
      expect(input).not.toHaveProperty("path");
      expect(input).toMatchObject({
        sessionId: "session-1",
        name: "notes.txt",
        sizeBytes: 9,
      });
      return { ok: true as const, value: attachment("notes.txt", 9) };
    });
    const media = { uploadGrantedFile, release: vi.fn() };
    const service = new FileGrantService(
      client,
      media as never,
      vi.fn().mockResolvedValue({ canceled: false, filePaths: [path] }),
    );

    const picked = await service.pick({ sessionId: "session-1", kind: "file" });
    expect(picked).toMatchObject({
      ok: true,
      value: {
        grant: {
          schemaVersion: 1,
          sessionId: "session-1",
          kind: "file",
          displayName: "notes.txt",
          canList: false,
          canImport: true,
        },
      },
    });
    const grantId = requireGrantId(picked);
    expect(grantId).toMatch(/^[A-Za-z0-9_-]{48}$/);
    expect(JSON.stringify(picked)).not.toContain(root);

    expect(await service.import({ sessionId: "session-1", grantId })).toEqual({
      ok: true,
      value: { grantId, entryId: null, attachment: attachment("notes.txt", 9) },
    });
    expect(uploadGrantedFile).toHaveBeenCalledOnce();
    expect(await service.release({ sessionId: "session-1", grantId })).toEqual({
      ok: true,
      value: { grantId, released: true },
    });
    expect(await service.release({ sessionId: "session-1", grantId })).toEqual({
      ok: true,
      value: { grantId, released: true },
    });
    expect(await service.import({ sessionId: "session-1", grantId })).toMatchObject({
      ok: false,
      error: { code: "grant_revoked", retryable: false, retryAfterMs: null },
    });
  });

  it("rejects directory selection before session, dialog, filesystem, or grant state", async () => {
    const client = writableClient();
    const picker = vi.fn();
    const service = new FileGrantService(client, mediaService() as never, picker);

    expect(await service.pick({ sessionId: "session-1", kind: "directory" })).toMatchObject({
      ok: false,
      error: { code: "unsupported_file", retryable: false, retryAfterMs: null },
    });
    expect(client.validateWritableSession).not.toHaveBeenCalled();
    expect(picker).not.toHaveBeenCalled();
    expect(
      await service.list({
        sessionId: "session-1",
        grantId: "g".repeat(48),
      }),
    ).toMatchObject({ ok: false, error: { code: "grant_not_found" } });
  });

  it("keeps the retained list contract unavailable for explicit file grants", async () => {
    const root = await temporaryRoot();
    const path = join(root, "listed.txt");
    await writeFile(path, "listed");
    const service = serviceFor(path);
    const grantId = requireGrantId(await service.pick({ sessionId: "session-1", kind: "file" }));

    expect(await service.list({ sessionId: "session-1", grantId })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
  });

  it("enforces the per-session and client grant caps", async () => {
    const root = await temporaryRoot();
    const path = join(root, "bounded.txt");
    await writeFile(path, "bounded");
    const service = serviceFor(path);
    for (let index = 0; index < 16; index += 1) {
      expect(await service.pick({ sessionId: "session-1", kind: "file" })).toMatchObject({
        ok: true,
        value: { grant: { kind: "file" } },
      });
    }
    expect(await service.pick({ sessionId: "session-1", kind: "file" })).toMatchObject({
      ok: false,
      error: { code: "grant_backpressure" },
    });
    for (let index = 0; index < 16; index += 1) {
      expect(await service.pick({ sessionId: "session-2", kind: "file" })).toMatchObject({
        ok: true,
        value: { grant: { kind: "file" } },
      });
    }
    expect(await service.pick({ sessionId: "session-3", kind: "file" })).toMatchObject({
      ok: false,
      error: { code: "grant_backpressure" },
    });
    await service.close();
  });

  it("rejects replacement of a directly selected file before import", async () => {
    const root = await temporaryRoot();
    const path = join(root, "selected.txt");
    await writeFile(path, "first");
    const service = serviceFor(path);
    const grantId = requireGrantId(await service.pick({ sessionId: "session-1", kind: "file" }));
    await rename(path, join(root, "original.txt"));
    await writeFile(path, "other");

    expect(await service.import({ sessionId: "session-1", grantId })).toMatchObject({
      ok: false,
      error: { code: "grant_changed" },
    });
  });

  it("lets a session fence win while the native picker is still open", async () => {
    const root = await temporaryRoot();
    const path = join(root, "held.txt");
    await writeFile(path, "held");
    let resolveDialog!: (value: { canceled: false; filePaths: string[] }) => void;
    const dialog = new Promise<{ canceled: false; filePaths: string[] }>((resolve) => {
      resolveDialog = resolve;
    });
    const picker = vi.fn(() => dialog);
    const service = new FileGrantService(writableClient(), mediaService() as never, picker);
    const pending = service.pick({ sessionId: "session-1", kind: "file" });
    await vi.waitFor(() => expect(picker).toHaveBeenCalledOnce());
    await service.fenceSession("session-1");
    resolveDialog({ canceled: false, filePaths: [path] });

    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: { code: "session_closed" } });
    expect(JSON.stringify(result)).not.toContain(path);
  });

  it("returns the active-turn error when turn admission wins an open picker", async () => {
    const root = await temporaryRoot();
    const path = join(root, "held.txt");
    await writeFile(path, "held");
    let resolveDialog!: (value: { canceled: false; filePaths: string[] }) => void;
    const picker = vi.fn(
      () =>
        new Promise<{ canceled: false; filePaths: string[] }>((resolve) => {
          resolveDialog = resolve;
        }),
    );
    const service = new FileGrantService(writableClient(), mediaService() as never, picker);
    const pending = service.pick({ sessionId: "session-1", kind: "file" });
    await vi.waitFor(() => expect(picker).toHaveBeenCalledOnce());
    await service.fenceSession("session-1", "session_turn_active");
    resolveDialog({ canceled: false, filePaths: [path] });

    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: { code: "session_turn_active" } });
    expect(JSON.stringify(result)).not.toContain("held.txt");
  });

  it("rechecks the final session generation before publishing an inspected grant", async () => {
    const root = await temporaryRoot();
    const path = join(root, "inspected.txt");
    await writeFile(path, "inspected");
    let finishFinal!: (value: { ok: true; value: { sessionId: string; writable: true } }) => void;
    const final = new Promise<{ ok: true; value: { sessionId: string; writable: true } }>(
      (resolve) => {
        finishFinal = resolve;
      },
    );
    const validateWritableSession = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { sessionId: "session-1", writable: true } })
      .mockResolvedValueOnce({ ok: true, value: { sessionId: "session-1", writable: true } })
      .mockReturnValueOnce(final);
    const service = new FileGrantService(
      { validateWritableSession },
      mediaService() as never,
      vi.fn().mockResolvedValue({ canceled: false, filePaths: [path] }),
    );
    const pending = service.pick({ sessionId: "session-1", kind: "file" });
    await vi.waitFor(() => expect(validateWritableSession).toHaveBeenCalledTimes(3));
    finishFinal({ ok: true, value: { sessionId: "session-1", writable: true } });
    const fenced = service.fenceSession("session-1");

    const result = await pending;
    await fenced;
    expect(result).toMatchObject({ ok: false, error: { code: "session_closed" } });
    expect(JSON.stringify(result)).not.toContain("inspected.txt");
  });

  it("aborts admitted import work and releases a commit that loses the fence", async () => {
    const root = await temporaryRoot();
    const path = join(root, "race.txt");
    await writeFile(path, "race");
    let finishUpload!: () => void;
    const uploadWait = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    let capturedSignal: AbortSignal | undefined;
    const release = vi.fn().mockResolvedValue({ ok: true, value: { released: true } });
    const media = {
      uploadGrantedFile: vi.fn(async (input) => {
        capturedSignal = input.signal;
        await uploadWait;
        return { ok: true as const, value: attachment("race.txt", 4) };
      }),
      release,
    };
    const service = new FileGrantService(
      writableClient(),
      media as never,
      vi.fn().mockResolvedValue({ canceled: false, filePaths: [path] }),
    );
    const grantId = requireGrantId(await service.pick({ sessionId: "session-1", kind: "file" }));
    const importing = service.import({ sessionId: "session-1", grantId });
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    const releasing = service.release({ sessionId: "session-1", grantId });
    expect(capturedSignal!.aborted).toBe(true);
    finishUpload();

    expect(await importing).toMatchObject({ ok: false, error: { code: "grant_revoked" } });
    expect(await releasing).toEqual({ ok: true, value: { grantId, released: true } });
    expect(release).toHaveBeenCalledWith({
      sessionId: "session-1",
      mediaId: "m".repeat(48),
    });
  });

  it("lets release win while import session validation is still pending", async () => {
    const root = await temporaryRoot();
    const path = join(root, "pre-admission.txt");
    await writeFile(path, "held");
    let finishValidation!: (value: {
      ok: true;
      value: { sessionId: string; writable: true };
    }) => void;
    const pendingValidation = new Promise<{
      ok: true;
      value: { sessionId: string; writable: true };
    }>((resolve) => {
      finishValidation = resolve;
    });
    const validateWritableSession = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { sessionId: "session-1", writable: true } })
      .mockResolvedValueOnce({ ok: true, value: { sessionId: "session-1", writable: true } })
      .mockResolvedValueOnce({ ok: true, value: { sessionId: "session-1", writable: true } })
      .mockReturnValueOnce(pendingValidation);
    const media = mediaService();
    const service = new FileGrantService(
      { validateWritableSession },
      media as never,
      vi.fn().mockResolvedValue({ canceled: false, filePaths: [path] }),
    );
    const grantId = requireGrantId(await service.pick({ sessionId: "session-1", kind: "file" }));
    const importing = service.import({ sessionId: "session-1", grantId });
    await vi.waitFor(() => expect(validateWritableSession).toHaveBeenCalledTimes(4));
    expect(await service.release({ sessionId: "session-1", grantId })).toEqual({
      ok: true,
      value: { grantId, released: true },
    });
    finishValidation({
      ok: true,
      value: { sessionId: "session-1", writable: true },
    });

    expect(await importing).toMatchObject({ ok: false, error: { code: "grant_revoked" } });
    expect(media.uploadGrantedFile).not.toHaveBeenCalled();
  });

  it("expires and compensates an import that is still uploading", async () => {
    const root = await temporaryRoot();
    const path = join(root, "expiring.txt");
    await writeFile(path, "held");
    let now = 1_000;
    let finishUpload!: () => void;
    const uploadWait = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    const release = vi.fn().mockResolvedValue({ ok: true, value: { released: true } });
    const media = {
      uploadGrantedFile: vi.fn(async () => {
        await uploadWait;
        return { ok: true as const, value: attachment("expiring.txt", 4) };
      }),
      release,
    };
    const service = new FileGrantService(
      writableClient(),
      media as never,
      vi.fn().mockResolvedValue({ canceled: false, filePaths: [path] }),
      () => now,
    );
    const grantId = requireGrantId(await service.pick({ sessionId: "session-1", kind: "file" }));
    const importing = service.import({ sessionId: "session-1", grantId });
    await vi.waitFor(() => expect(media.uploadGrantedFile).toHaveBeenCalledOnce());
    now += 5 * 60_000 + 1;
    finishUpload();

    expect(await importing).toMatchObject({ ok: false, error: { code: "grant_expired" } });
    expect(release).toHaveBeenCalledWith({
      sessionId: "session-1",
      mediaId: "m".repeat(48),
    });
  });

  it("enforces expiry, bounded admission, symlink rejection, and safe session errors", async () => {
    const root = await temporaryRoot();
    const path = join(root, "plain.txt");
    const link = join(root, "link.txt");
    await writeFile(path, "plain");
    await symlink(path, link);
    let now = 1_000;
    const service = new FileGrantService(
      writableClient(),
      mediaService() as never,
      vi
        .fn()
        .mockResolvedValueOnce({ canceled: false, filePaths: [link] })
        .mockResolvedValue({ canceled: false, filePaths: [path] }),
      () => now,
    );
    expect(await service.pick({ sessionId: "session-1", kind: "file" })).toMatchObject({
      ok: false,
      error: { code: "unsupported_file" },
    });
    const grantId = requireGrantId(await service.pick({ sessionId: "session-1", kind: "file" }));
    now += 10 * 60_000 + 1;
    expect(await service.import({ sessionId: "session-1", grantId })).toMatchObject({
      ok: false,
      error: { code: "grant_expired" },
    });

    const unavailable = new FileGrantService(
      {
        validateWritableSession: vi
          .fn()
          .mockResolvedValue({ ok: false, error: { code: "daemon_unavailable" } }),
      },
      mediaService() as never,
    );
    expect(await unavailable.pick({ sessionId: "session-1", kind: "file" })).toMatchObject({
      ok: false,
      error: { code: "runtime_unavailable", retryable: false, retryAfterMs: null },
    });
    expect(
      JSON.stringify(
        await service.list({ sessionId: "session-1", grantId: "bad", limit: 0 } as never),
      ),
    ).not.toContain(root);
  });

  it("returns a successful null grant on user cancellation", async () => {
    const picker = vi.fn().mockResolvedValue({ canceled: true, filePaths: [] });
    const service = new FileGrantService(writableClient(), mediaService() as never, picker);
    expect(await service.pick({ sessionId: "session-1", kind: "file" })).toEqual({
      ok: true,
      value: { grant: null },
    });
    expect(picker).toHaveBeenCalledWith({ properties: ["openFile"] });
  });

  it("normalizes malformed session proof and native picker rejection", async () => {
    const malformed = new FileGrantService(
      {
        validateWritableSession: vi
          .fn()
          .mockResolvedValue({ ok: true, value: { sessionId: "other", writable: true } }),
      },
      mediaService() as never,
    );
    expect(await malformed.pick({ sessionId: "session-1", kind: "file" })).toMatchObject({
      ok: false,
      error: { code: "runtime_unavailable", retryable: false, retryAfterMs: null },
    });
    const rejected = new FileGrantService(
      writableClient(),
      mediaService() as never,
      vi.fn().mockRejectedValue(new Error("native detail must not cross")),
    );
    const result = await rejected.pick({ sessionId: "session-1", kind: "file" });
    expect(result).toMatchObject({ ok: false, error: { code: "picker_failed" } });
    expect(JSON.stringify(result)).not.toContain("native detail");
  });
});

function writableClient() {
  const validateWritableSession = vi.fn(async (sessionId: string) => {
    return { ok: true as const, value: { sessionId, writable: true as const } };
  });
  return { validateWritableSession };
}

function mediaService() {
  return {
    uploadGrantedFile: vi.fn().mockResolvedValue({ ok: true, value: attachment("file.txt", 4) }),
    release: vi.fn().mockResolvedValue({ ok: true, value: { released: true } }),
  };
}

function serviceFor(path: string): FileGrantService {
  return new FileGrantService(
    writableClient(),
    mediaService() as never,
    vi.fn().mockResolvedValue({ canceled: false, filePaths: [path] }),
  );
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openminion-file-grants-"));
  roots.push(root);
  return root;
}

function requireGrantId(result: Awaited<ReturnType<FileGrantService["pick"]>>): string {
  if (!result.ok || !result.value.grant) throw new Error("expected grant");
  return result.value.grant.grantId;
}

function attachment(name: string, sizeBytes: number): MediaAttachmentV1 {
  return {
    schemaVersion: 1,
    mediaId: "m".repeat(48),
    sessionId: "session-1",
    name,
    mimeType: "text/plain",
    sizeBytes,
    kind: "file",
    turnCompatible: false,
    expiresAt: "2999-01-01T00:00:00Z",
  };
}
