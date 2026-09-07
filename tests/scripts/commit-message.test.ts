import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = fileURLToPath(new URL("../../scripts/commit-message.mjs", import.meta.url));

function validate(subject: string) {
  return spawnSync(process.execPath, [script, "--subject", subject], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

describe("commit message policy", () => {
  it.each([
    "feat: add desktop shell",
    "fix(renderer): preserve active session",
    "Merge branch 'dev'",
    'Revert "feat: add desktop shell"',
  ])("accepts %s", (subject) => {
    expect(validate(subject).status).toBe(0);
  });

  it.each(["update", "feature: add desktop shell", "feat: Add desktop shell"])(
    "rejects %s",
    (subject) => {
      const result = validate(subject);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("commit subject must use");
    },
  );

  it("validates the commit message file used by the Git hook", () => {
    const directory = mkdtempSync(join(tmpdir(), "openminion-desktop-commit-"));
    const messageFile = join(directory, "COMMIT_EDITMSG");

    try {
      writeFileSync(messageFile, "docs: align repository guidance\n\nDetails\n");
      const result = spawnSync(process.execPath, [script, messageFile], {
        cwd: repositoryRoot,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
