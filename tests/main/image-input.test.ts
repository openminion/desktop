import { createServer, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { CliClient } from "../../src/main/cli-client.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQv0AAAAASUVORK5CYII=",
  "base64",
);

async function fixture() {
  const requests: { method: string; path: string; body: Buffer }[] = [];
  let previewFails = false;
  let holdPreview = false;
  let supported = true;
  let finishTurn: (() => void) | undefined;
  let number = 0;
  const server = createServer(async (req, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const path = req.url!;
    requests.push({ method: req.method!, path, body });
    expect(req.headers["x-ipc-token"]).toBe("fixture-token");
    res.setHeader("Content-Type", "application/json");
    if (path === "/v1/health") {
      res.end(JSON.stringify({ ok: true, capabilities: supported ? ["turns.images.v1"] : [] }));
      return;
    }
    if (path === "/v1/turn/stream") {
      const turn = JSON.parse(body.toString());
      finishTurn = () => {
        res.setHeader("Content-Type", "text/event-stream");
        const event = (name: string, data: unknown) =>
          res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        event("meta", {
          session_id: turn.session_id,
          trace_id: turn.trace_id,
          request_id: "fixture",
          stream_schema_version: "openminion.turn-stream.v1",
        });
        event("response", { trace_id: turn.trace_id, final_text: "Image received", errors: [] });
        event("done", { trace_id: turn.trace_id, status: "complete" });
        res.end();
      };
      return;
    }
    if (req.method === "DELETE") {
      res.end('{"ok":true}');
      return;
    }
    if (req.method === "POST") {
      number++;
      res.statusCode = 201;
      res.end(
        JSON.stringify({
          ok: true,
          image: {
            ref: `image://00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
            size_bytes: png.length,
          },
        }),
      );
      return;
    }
    if (holdPreview) return;
    if (previewFails) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: { code: "invalid_image", message: "Preview unavailable", retryable: false },
        }),
      );
      return;
    }
    res.setHeader("Content-Type", "image/png");
    res.end(png);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const run = vi.fn(async (_exe: string, args: readonly string[]) => ({
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify(
      args[0] === "daemon"
        ? { reachable: true, host: "127.0.0.1", port: address.port }
        : { default_agent: "writer", runtime: { ipc_token: "fixture-token" } },
    ),
  }));
  const client = new CliClient(() => ({ executable: "openminion", args: [] }), run);
  const draft = await client.create({});
  if (!draft.ok) throw new Error("Draft failed");
  const sessionId = draft.value.sessionId;
  return {
    client,
    requests,
    sessionId,
    upload: (signal?: AbortSignal) =>
      client.uploadMedia({
        signal,
        sessionId,
        name: "selected.png",
        mimeType: "image/png",
        sizeBytes: png.length,
        stream: Readable.from(png),
      }),
    holdPreview: () => {
      holdPreview = true;
    },
    failPreview: () => {
      previewFails = true;
    },
    unsupported: () => {
      supported = false;
    },
    finish: () => finishTurn!(),
    admitted: () => Boolean(finishTurn),
  };
}

it("previews selected bytes, sends an image-only turn, and preserves accepted refs during removal", async () => {
  const test = await fixture();
  const upload = await test.upload();
  expect(upload.ok).toBe(true);
  if (!upload.ok) return;
  expect(upload.value.previewUrl).toBe(`data:image/png;base64,${png.toString("base64")}`);
  expect(JSON.stringify(upload.value)).not.toContain("image://");
  expect(test.requests.find((request) => request.method === "POST")!.body).toEqual(png);
  expect(test.requests.some((request) => request.path === "/v1/turn/stream")).toBe(false);
  const submitting = test.client.submit(
    { sessionId: test.sessionId, message: "", attachmentIds: [upload.value.mediaId] },
    vi.fn(),
  );
  await vi.waitFor(() => expect(test.admitted()).toBe(true));
  expect(
    await test.client.releaseMedia({ sessionId: test.sessionId, mediaId: upload.value.mediaId }),
  ).toMatchObject({ ok: false, error: { code: "session_turn_active" } });
  const turn = JSON.parse(
    test.requests.find((request) => request.path === "/v1/turn/stream")!.body.toString(),
  );
  expect(turn.image_refs).toEqual(["image://00000000-0000-4000-8000-000000000001"]);
  expect(turn.input_text).toBe("");
  test.finish();
  expect((await submitting).ok).toBe(true);
  expect(
    (await test.client.releaseMedia({ sessionId: test.sessionId, mediaId: upload.value.mediaId }))
      .ok,
  ).toBe(true);
  expect(test.requests.filter((request) => request.method === "DELETE")).toHaveLength(0);
});

it("revokes unsent images and rejects cross-session release", async () => {
  const test = await fixture();
  const image = await test.upload();
  if (!image.ok) throw new Error(image.error.message);
  expect(
    (await test.client.releaseMedia({ sessionId: "other", mediaId: image.value.mediaId })).ok,
  ).toBe(false);
  expect(
    (await test.client.releaseMedia({ sessionId: test.sessionId, mediaId: image.value.mediaId }))
      .ok,
  ).toBe(true);
  expect(test.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
});

it("cleans failed previews without consuming draft slots and blocks older runtimes before upload", async () => {
  const test = await fixture();
  test.failPreview();
  for (let i = 0; i < 5; i++) expect((await test.upload()).ok).toBe(false);
  expect(test.requests.filter((request) => request.method === "DELETE")).toHaveLength(5);
  test.unsupported();
  expect(await test.upload()).toMatchObject({
    ok: false,
    error: { code: "unsupported_operation" },
  });
  expect(test.requests.filter((request) => request.method === "POST")).toHaveLength(5);
});

it("cancels a pending preview and revokes its unsent image", async () => {
  const test = await fixture();
  test.holdPreview();
  const controller = new AbortController();
  const uploading = test.upload(controller.signal);
  await vi.waitFor(() =>
    expect(
      test.requests.some(
        (request) => request.method === "GET" && request.path.includes("/images/"),
      ),
    ).toBe(true),
  );
  controller.abort();
  expect((await uploading).ok).toBe(false);
  expect(test.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
});
