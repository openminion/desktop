import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const readme = readFileSync(join(repositoryRoot, "README.md"), "utf8");
let directory: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "openminion-public-surface-"));
  const files = readdirSync(repositoryRoot).filter((file) => file.endsWith(".md"));
  for (const file of [
    ...files,
    ".github",
    ".githooks",
    ".nvmrc",
    "assets",
    "docs",
    "scripts",
    "releases",
    "package.json",
    "LICENSE",
    "NOTICE",
  ]) {
    cpSync(join(repositoryRoot, file), join(directory, file), { recursive: true });
  }
});

afterAll(() => rmSync(directory, { recursive: true }));

describe("public documentation paths", () => {
  it.each([
    [String.raw`C:\Users\Example\desktop`, false],
    [String.raw`C:\\Users\\Example\\desktop`, false],
    ["/Users/Example/desktop", false],
    ["/absolute/path/to/desktop", true],
    [String.raw`.\OpenMinion-win32-x64-0.0.3.zip`, true],
  ])("checks %s", (path, allowed) => {
    writeFileSync(join(directory, "README.md"), `${readme}\nExample: ${path}\n`);
    const result = spawnSync(process.execPath, [join(directory, "scripts/public-surface.mjs")], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(allowed ? 0 : 1);
    if (!allowed) {
      expect(result.stderr).toContain("machine-local path in public documentation: README.md");
    }
  });
});
