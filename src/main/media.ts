import { dialog, type OpenDialogOptions, type OpenDialogReturnValue } from "electron";
import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import type {
  CaptureFrameV1,
  ClientResult,
  ErrorV1,
  MediaAttachmentV1,
  MediaPickInput,
  MediaPickValue,
  MediaReleaseInput,
  MediaReleaseValue,
} from "../shared/contracts.js";
import type { OpenMinionClient } from "./openminion-client.js";

const MAX_PICKED_FILES = 4;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MAX_CAPTURE_FRAME_BYTES = 2 * 1024 * 1024;

export type CapturedFrameUpload = {
  sessionId: string;
  frame: CaptureFrameV1;
  bytes: Buffer;
  signal: AbortSignal;
};

export type GrantedFileUpload = {
  sessionId: string;
  name: string;
  sizeBytes: number;
  device: number;
  inode: number;
  handle: FileHandle;
  signal: AbortSignal;
};

type PickDialog = (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>;

const MEDIA_TYPES = new Map<string, MediaAttachmentV1["mimeType"]>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain"],
  [".json", "application/json"],
]);

export class MediaService {
  readonly #client: OpenMinionClient;
  readonly #pickDialog: PickDialog;

  constructor(
    client: OpenMinionClient,
    pickDialog: PickDialog = (options) => dialog.showOpenDialog(options),
  ) {
    this.#client = client;
    this.#pickDialog = pickDialog;
  }

  async pick(input: MediaPickInput): Promise<ClientResult<MediaPickValue>> {
    const validated = validatePickInput(input);
    if (!validated.ok) {
      return validated;
    }
    const { sessionId, kind } = validated.value;
    let selection: OpenDialogReturnValue;
    try {
      selection = await this.#pickDialog({
        properties: ["openFile", "multiSelections"],
        filters: [
          kind === "image"
            ? { name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }
            : { name: "Files", extensions: ["pdf", "txt", "json"] },
        ],
      });
    } catch {
      return failure("media_unavailable", "The attachment picker could not be opened.");
    }
    if (selection.canceled || selection.filePaths.length === 0) {
      return { ok: true, value: { attachments: [] } };
    }
    if (selection.filePaths.length > MAX_PICKED_FILES) {
      return invalid("Select no more than four attachments.");
    }

    const attachments: MediaAttachmentV1[] = [];
    for (const path of selection.filePaths) {
      const uploaded = await this.#uploadPath(sessionId, kind, path);
      if (!uploaded.ok) {
        await Promise.allSettled(
          attachments.map((attachment) =>
            this.#client.releaseMedia({ sessionId, mediaId: attachment.mediaId }),
          ),
        );
        return uploaded;
      }
      attachments.push(uploaded.value);
    }
    return { ok: true, value: { attachments } };
  }

  release(input: MediaReleaseInput): Promise<ClientResult<MediaReleaseValue>> {
    return this.#client.releaseMedia(input);
  }

  uploadCapturedFrame(input: CapturedFrameUpload): Promise<ClientResult<MediaAttachmentV1>> {
    const bytes = input.bytes;
    if (
      input.signal.aborted ||
      input.frame.sessionId !== input.sessionId ||
      input.frame.encoding !== "image/jpeg" ||
      input.frame.sizeBytes !== bytes.length ||
      bytes.length < 1 ||
      bytes.length > MAX_CAPTURE_FRAME_BYTES ||
      !matchesMediaType(bytes, "image/jpeg") ||
      createHash("sha256").update(bytes).digest("hex") !== input.frame.contentHash
    ) {
      return Promise.resolve(
        failure("observation_frame_mismatch", "The selected frame changed before use."),
      );
    }
    return this.#client.uploadMedia({
      sessionId: input.sessionId,
      name: "observed-frame.jpg",
      mimeType: "image/jpeg",
      sizeBytes: bytes.length,
      stream: Readable.from(bytes),
      signal: input.signal,
    });
  }

  async uploadGrantedFile(input: GrantedFileUpload): Promise<ClientResult<MediaAttachmentV1>> {
    const mimeType = mediaType(input.name);
    if (!mimeType || !validDisplayName(input.name)) {
      return failure("unsupported_file", "The selected file type is not supported.");
    }
    try {
      const before = await input.handle.stat();
      if (
        input.signal.aborted ||
        !before.isFile() ||
        before.size !== input.sizeBytes ||
        before.dev !== input.device ||
        before.ino !== input.inode ||
        before.size < 1 ||
        before.size > MAX_MEDIA_BYTES
      ) {
        return failure("file_unavailable", "The selected file is no longer available.");
      }
      const bytes = await readGrantedBytes(input.handle, before.size, input.signal);
      if (!matchesMediaType(bytes, mimeType)) {
        return failure("unsupported_file", "The selected file content is not supported.");
      }
      const after = await input.handle.stat();
      if (
        input.signal.aborted ||
        after.size !== before.size ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mtimeMs !== before.mtimeMs
      ) {
        return failure("file_unavailable", "The selected file changed during import.");
      }
      const uploaded = await this.#client.uploadMedia({
        sessionId: input.sessionId,
        name: input.name,
        mimeType,
        sizeBytes: bytes.length,
        stream: Readable.from(bytes),
        signal: input.signal,
      });
      if (!uploaded.ok) {
        return failure("import_failed", "The selected file could not be imported.");
      }
      return uploaded;
    } catch {
      return failure("file_unavailable", "The selected file could not be read.");
    }
  }

  async #uploadPath(
    sessionId: string,
    kind: MediaPickInput["kind"],
    path: string,
  ): Promise<ClientResult<MediaAttachmentV1>> {
    const name = basename(path);
    const mimeType = MEDIA_TYPES.get(extname(name).toLowerCase());
    if (!mimeType || (kind === "image") !== mimeType.startsWith("image/")) {
      return invalid("The selected attachment type is not supported.");
    }
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, "r");
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_MEDIA_BYTES) {
        return invalid("The selected attachment size is not supported.");
      }
      return await this.#client.uploadMedia({
        sessionId,
        name,
        mimeType,
        sizeBytes: stat.size,
        stream: handle.createReadStream({ autoClose: false }),
      });
    } catch {
      return failure("media_unavailable", "The selected attachment could not be read.");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

export function mediaType(name: string): MediaAttachmentV1["mimeType"] | null {
  return MEDIA_TYPES.get(extname(name).toLowerCase()) ?? null;
}

function validDisplayName(name: string): boolean {
  return (
    name.length > 0 &&
    Buffer.byteLength(name) <= 256 &&
    !name.includes("\0") &&
    name.normalize("NFC") === name
  );
}

async function readGrantedBytes(
  handle: FileHandle,
  size: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    if (signal.aborted) {
      throw new Error("grant revoked");
    }
    const read = await handle.read(bytes, offset, size - offset, offset);
    if (read.bytesRead === 0) {
      throw new Error("short read");
    }
    offset += read.bytesRead;
  }
  return bytes;
}

function matchesMediaType(bytes: Buffer, mimeType: MediaAttachmentV1["mimeType"]): boolean {
  if (mimeType === "image/png") {
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/webp") {
    return (
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  if (mimeType === "application/pdf") {
    return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) {
      return false;
    }
    if (mimeType === "application/json") {
      JSON.parse(text);
    }
    return true;
  } catch {
    return false;
  }
}

function validatePickInput(input: MediaPickInput): ClientResult<MediaPickInput> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 2 ||
    typeof input.sessionId !== "string" ||
    !input.sessionId.trim() ||
    input.sessionId.length > 256 ||
    (input.kind !== "image" && input.kind !== "file")
  ) {
    return invalid("The attachment picker request is invalid.");
  }
  return {
    ok: true,
    value: { sessionId: input.sessionId.trim(), kind: input.kind },
  };
}

function invalid(message: string): { ok: false; error: ErrorV1 } {
  return failure("invalid_request", message);
}

function failure(code: string, message: string): { ok: false; error: ErrorV1 } {
  return {
    ok: false,
    error: { code, message, retryable: false, retryAfterMs: null },
  };
}
