import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaService } from "../../src/main/media.js";
import type { CaptureFrameV1, MediaAttachmentV1 } from "../../src/shared/contracts.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("MediaService", () => {
  it("opens one selected file once and streams it through the fixed client", async () => {
    const root = await temporaryRoot();
    const path = join(root, "pixel.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(path, bytes);
    const uploadMedia = vi.fn(async (input) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks)).toEqual(bytes);
      expect(input).toMatchObject({
        sessionId: "session-1",
        name: "pixel.png",
        mimeType: "image/png",
        sizeBytes: bytes.length,
      });
      return { ok: true as const, value: media("a", "pixel.png", bytes.length) };
    });
    const client = { uploadMedia, releaseMedia: vi.fn() };
    const service = new MediaService(
      client as never,
      vi.fn().mockResolvedValue({ canceled: false, filePaths: [path] }),
    );

    expect(await service.pick({ sessionId: "session-1", kind: "image" })).toEqual({
      ok: true,
      value: { attachments: [media("a", "pixel.png", bytes.length)] },
    });
    expect(uploadMedia).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(await service.pick({ sessionId: "session-1", kind: "bad" } as never)),
    ).not.toContain(path);
  });

  it("releases every earlier upload when a sequential pick fails", async () => {
    const root = await temporaryRoot();
    const first = join(root, "first.png");
    const second = join(root, "second.png");
    await writeFile(first, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(second, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const uploadMedia = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: media("b", "first.png", 4) })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "unsupported_media_type",
          message: "Unsupported.",
          retryable: false,
          retryAfterMs: null,
        },
      });
    const releaseMedia = vi.fn().mockResolvedValue({
      ok: true,
      value: { mediaId: "b".repeat(48), released: true },
    });
    const service = new MediaService(
      { uploadMedia, releaseMedia } as never,
      vi.fn().mockResolvedValue({ canceled: false, filePaths: [first, second] }),
    );

    expect(await service.pick({ sessionId: "session-1", kind: "image" })).toMatchObject({
      ok: false,
      error: { code: "unsupported_media_type" },
    });
    expect(releaseMedia).toHaveBeenCalledWith({
      sessionId: "session-1",
      mediaId: "b".repeat(48),
    });
  });

  it("returns an empty selection on cancel and rejects more than four paths", async () => {
    const client = { uploadMedia: vi.fn(), releaseMedia: vi.fn() };
    const cancelled = new MediaService(
      client as never,
      vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
    );
    expect(await cancelled.pick({ sessionId: "session-1", kind: "file" })).toEqual({
      ok: true,
      value: { attachments: [] },
    });
    const excessive = new MediaService(
      client as never,
      vi.fn().mockResolvedValue({
        canceled: false,
        filePaths: ["1", "2", "3", "4", "5"],
      }),
    );
    expect(await excessive.pick({ sessionId: "session-1", kind: "image" })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(client.uploadMedia).not.toHaveBeenCalled();
  });

  it("validates granted bytes and identity before the fixed upload", async () => {
    const root = await temporaryRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "granted text");
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat();
      const uploadMedia = vi.fn().mockResolvedValue({
        ok: true,
        value: {
          ...media("g", "notes.txt", stat.size),
          mimeType: "text/plain",
          kind: "file",
          turnCompatible: false,
        },
      });
      const service = new MediaService({ uploadMedia, releaseMedia: vi.fn() } as never);
      expect(
        await service.uploadGrantedFile({
          sessionId: "session-1",
          name: "notes.txt",
          sizeBytes: stat.size,
          device: stat.dev,
          inode: stat.ino,
          handle,
          signal: new AbortController().signal,
        }),
      ).toMatchObject({ ok: true, value: { name: "notes.txt" } });
      expect(uploadMedia).toHaveBeenCalledOnce();
      expect(uploadMedia.mock.calls[0]![0]).not.toHaveProperty("path");

      expect(
        await service.uploadGrantedFile({
          sessionId: "session-1",
          name: "report.pdf",
          sizeBytes: stat.size,
          device: stat.dev,
          inode: stat.ino,
          handle,
          signal: new AbortController().signal,
        }),
      ).toMatchObject({ ok: false, error: { code: "unsupported_file" } });
      expect(uploadMedia).toHaveBeenCalledOnce();
    } finally {
      await handle.close();
    }
  });

  it("uploads only a matching bounded JPEG capture frame", async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const frame = captureFrame(bytes);
    const uploadMedia = vi.fn(async (input) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks)).toEqual(bytes);
      expect(input).toMatchObject({
        sessionId: "session-1",
        name: "observed-frame.jpg",
        mimeType: "image/jpeg",
        sizeBytes: bytes.length,
      });
      return {
        ok: true as const,
        value: {
          ...media("o", "observed-frame.jpg", bytes.length),
          mimeType: "image/jpeg" as const,
        },
      };
    });
    const service = new MediaService({ uploadMedia, releaseMedia: vi.fn() } as never);
    expect(
      await service.uploadCapturedFrame({
        sessionId: "session-1",
        frame,
        bytes,
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ ok: true, value: { name: "observed-frame.jpg" } });
    expect(uploadMedia).toHaveBeenCalledOnce();

    expect(
      await service.uploadCapturedFrame({
        sessionId: "session-1",
        frame: { ...frame, sizeBytes: frame.sizeBytes + 1 },
        bytes,
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ ok: false, error: { code: "observation_frame_mismatch" } });
    expect(
      await service.uploadCapturedFrame({
        sessionId: "session-1",
        frame,
        bytes: Buffer.from("not-jpeg"),
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ ok: false, error: { code: "observation_frame_mismatch" } });
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await service.uploadCapturedFrame({
        sessionId: "session-1",
        frame,
        bytes,
        signal: aborted.signal,
      }),
    ).toMatchObject({ ok: false, error: { code: "observation_frame_mismatch" } });
    expect(uploadMedia).toHaveBeenCalledOnce();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openminion-media-"));
  roots.push(root);
  return root;
}

function media(seed: string, name: string, sizeBytes: number): MediaAttachmentV1 {
  return {
    schemaVersion: 1,
    mediaId: seed.repeat(48),
    sessionId: "session-1",
    name,
    mimeType: "image/png",
    sizeBytes,
    kind: "image",
    turnCompatible: true,
    expiresAt: "2999-01-01T00:00:00Z",
  };
}

function captureFrame(bytes: Buffer): CaptureFrameV1 {
  return {
    schemaVersion: 1,
    kind: "frame",
    captureId: "c".repeat(48),
    frameId: "f".repeat(48),
    sessionId: "session-1",
    sourceKind: "display",
    parentSourceKind: "display",
    width: 800,
    height: 600,
    scaleFactor: 2,
    capturedAt: "2026-08-22T00:00:00.000Z",
    expiresAt: "2026-08-22T00:00:30.000Z",
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    encoding: "image/jpeg",
    sizeBytes: bytes.length,
    previewUrl: `openminion://app/capture/frames/${"f".repeat(48)}`,
  };
}
