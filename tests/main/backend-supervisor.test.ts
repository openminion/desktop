import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonSupervisor } from "../../src/main/backend-supervisor.js";
import { DESKTOP_CAPABILITIES, type DesktopClientReady } from "../../src/shared/contracts.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

describe("DaemonSupervisor", () => {
  it("advertises the exact atomic desktop capability set", () => {
    expect([...DESKTOP_CAPABILITIES]).toEqual([
      "daemon.health",
      "daemon.ready",
      "client.capabilities",
      "client.lease.renew",
      "client.lease.revoke",
      "sessions.list",
      "sessions.create",
      "sessions.load",
      "sessions.close",
      "sessions.events",
      "turns.submit",
      "turns.cancel",
      "turns.tool_progress",
      "approvals.decide",
      "media.upload",
      "media.read",
      "media.release",
      "artifacts.catalog.v1",
      "artifacts.content.v1",
      "artifacts.detach_restore.v1",
      "tool_outputs.read.v1",
    ]);
  });

  it("bootstraps through fd 3, keeps credentials private, and revokes on exit", async () => {
    const daemon = await daemonFixture();
    const root = await temporaryRoot();
    const argumentsPath = join(root, "arguments.json");
    const executable = await bootstrapExecutable(root, daemon.readiness, undefined, argumentsPath);
    const supervisor = new DaemonSupervisor({
      openminionExecutable: executable,
      configPath: join(root, "config.json"),
      homeRoot: join(root, "home"),
      dataRoot: join(root, "data"),
    });

    const started = await supervisor.start();
    expect(started).toMatchObject({
      state: "ready",
      reachable: true,
      capabilities: [...DESKTOP_CAPABILITIES],
    });
    expect(JSON.stringify(started)).not.toContain(daemon.readiness.client_token);
    expect(JSON.stringify(started)).not.toContain(daemon.readiness.host);
    const argumentsSeen = JSON.parse(await readFile(argumentsPath, "utf-8"));
    expect(argumentsSeen).toEqual([
      "--home-root",
      join(root, "home"),
      "--data-root",
      join(root, "data"),
      "--config",
      join(root, "config.json"),
      "daemon",
      "desktop-bootstrap",
      "--fd",
      "3",
    ]);
    expect(JSON.stringify(argumentsSeen)).not.toContain(daemon.readiness.client_token);
    expect(await supervisor.status()).toMatchObject({ state: "ready" });
    expect(daemon.requests).toContain("GET /v1/client/capabilities");
    expect(daemon.requests).toContain("GET /v1/health");
    expect(daemon.tokens.every((token) => token === daemon.readiness.client_token)).toBe(true);

    expect(await supervisor.stop()).toEqual({ revoked: true });
    expect(supervisor.snapshot().state).toBe("stopped");
    expect(daemon.requests).toContain("DELETE /v1/client/leases/current");
    expect(daemon.server.listening).toBe(true);
  });

  it("fails closed for malformed and late readiness", async () => {
    const root = await temporaryRoot();
    const malformed = await executableWithSource(
      root,
      'require("node:fs").writeSync(3, "{bad\\n");',
    );
    const malformedSupervisor = new DaemonSupervisor({
      openminionExecutable: malformed,
    });
    expect(await malformedSupervisor.start()).toMatchObject({
      state: "degraded",
      reachable: false,
      errorCode: "malformed_readiness_record",
    });
    await malformedSupervisor.stop();

    const late = await executableWithSource(root, "setTimeout(() => {}, 10000);", "late.cjs");
    const lateSupervisor = new DaemonSupervisor({
      openminionExecutable: late,
      startupTimeoutMs: 20,
    });
    expect(await lateSupervisor.start()).toMatchObject({
      state: "degraded",
      errorCode: "bootstrap_timeout",
    });
    await lateSupervisor.stop();
  });

  it("performs only one bounded rebootstrap during one daemon outage", async () => {
    const daemon = await daemonFixture();
    const root = await temporaryRoot();
    const countPath = join(root, "launches.txt");
    const executable = await bootstrapExecutable(root, daemon.readiness, countPath);
    const supervisor = new DaemonSupervisor({ openminionExecutable: executable });
    expect((await supervisor.start()).state).toBe("ready");
    daemon.healthOkay = false;

    expect((await supervisor.status()).state).toBe("ready");
    expect((await supervisor.status()).state).toBe("degraded");
    expect((await readFile(countPath, "utf-8")).trim().split("\n")).toHaveLength(2);
    await supervisor.stop();
  });

  it("validates and applies a successful lease renewal", async () => {
    const daemon = await daemonFixture();
    daemon.readiness.expires_at = new Date(Date.now() + 60_200).toISOString();
    const root = await temporaryRoot();
    const executable = await bootstrapExecutable(root, daemon.readiness);
    const supervisor = new DaemonSupervisor({ openminionExecutable: executable });

    expect((await supervisor.start()).state).toBe("ready");
    await expect
      .poll(() => daemon.requests.includes("POST /v1/client/leases/renew"), {
        timeout: 2_500,
      })
      .toBe(true);
    expect(supervisor.snapshot().state).toBe("ready");
    await supervisor.stop();
  });

  it("fails closed on malformed renewed timestamp types", async () => {
    const daemon = await daemonFixture();
    daemon.readiness.expires_at = new Date(Date.now() + 60_200).toISOString();
    daemon.renewalValid = false;
    const root = await temporaryRoot();
    const executable = await bootstrapExecutable(root, daemon.readiness);
    const supervisor = new DaemonSupervisor({ openminionExecutable: executable });

    expect((await supervisor.start()).state).toBe("ready");
    await expect.poll(() => supervisor.snapshot().state, { timeout: 3_000 }).toBe("degraded");
    expect(supervisor.snapshot().errorCode).toBe("lease_renewal_failed");
    await supervisor.stop();
  });
});

async function daemonFixture(): Promise<{
  server: Server;
  readiness: DesktopClientReady;
  requests: string[];
  tokens: string[];
  healthOkay: boolean;
  renewalValid: boolean;
}> {
  const requests: string[] = [];
  const tokens: string[] = [];
  const fixture = {
    server: createServer(),
    readiness: {} as DesktopClientReady,
    requests,
    tokens,
    healthOkay: true,
    renewalValid: true,
  };
  fixture.server.on("request", (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    tokens.push(String(request.headers["x-openminion-client-token"] ?? ""));
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/client/capabilities") {
      response.end(
        JSON.stringify({
          ok: true,
          daemon_version: fixture.readiness.daemon_version,
          config_id: fixture.readiness.config_id,
          protocol_min: 1,
          protocol_max: 1,
          protocol: 1,
          capabilities: [...DESKTOP_CAPABILITIES],
        }),
      );
      return;
    }
    if (request.url === "/v1/health") {
      response.statusCode = fixture.healthOkay ? 200 : 403;
      response.end(JSON.stringify({ ok: fixture.healthOkay }));
      return;
    }
    if (request.url === "/v1/client/leases/renew") {
      const issuedAt = new Date();
      response.end(
        JSON.stringify({
          ok: true,
          lease: {
            client_id: fixture.readiness.client_id,
            protocol: 1,
            issued_at: fixture.renewalValid ? issuedAt.toISOString() : 2026,
            expires_at: fixture.renewalValid
              ? new Date(issuedAt.getTime() + 43_200_000).toISOString()
              : 2999,
            config_id: fixture.readiness.config_id,
            capabilities: [...DESKTOP_CAPABILITIES],
          },
        }),
      );
      return;
    }
    if (request.url === "/v1/client/leases/current") {
      response.end(JSON.stringify({ ok: true, revoked: true }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false }));
  });
  await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  const port = (fixture.server.address() as AddressInfo).port;
  fixture.readiness = {
    schema_version: 1,
    event: "desktop.client.ready",
    host: "127.0.0.1",
    port,
    protocol_min: 1,
    protocol_max: 1,
    daemon_version: "0.0.9",
    config_id: "a".repeat(64),
    client_id: "client-1",
    client_token: "secret-" + "x".repeat(43),
    expires_at: "2999-08-16T12:00:00Z",
  };
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        fixture.server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  return fixture;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openminion-desktop-test-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function bootstrapExecutable(
  root: string,
  readiness: DesktopClientReady,
  countPath?: string,
  argumentsPath?: string,
): Promise<string> {
  const count = countPath ? `fs.appendFileSync(${JSON.stringify(countPath)}, "1\\n");` : "";
  const argumentsRecord = argumentsPath
    ? `fs.writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)));`
    : "";
  return executableWithSource(
    root,
    `const fs = require("node:fs"); ${count} ${argumentsRecord} fs.writeSync(3, ${JSON.stringify(JSON.stringify(readiness) + "\n")});`,
  );
}

async function executableWithSource(
  root: string,
  source: string,
  name = "bootstrap.cjs",
): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`, "utf-8");
  await chmod(path, 0o755);
  return path;
}
