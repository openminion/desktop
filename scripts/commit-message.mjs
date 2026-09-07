// Validate commit subjects for local hooks and hosted CI.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const conventional =
  /^(feat|fix|docs|refactor|test|chore|style|build)(\([a-z0-9][a-z0-9-]*\))?: [a-z0-9].+$/;

function validate(subject) {
  if (
    !conventional.test(subject) &&
    !subject.startsWith("Merge ") &&
    !subject.startsWith('Revert "')
  ) {
    console.error(`invalid commit subject: ${subject}`);
    console.error("commit subject must use: <type>(<optional-scope>): <summary>");
    process.exitCode = 1;
  }
}

const [input, value] = process.argv.slice(2);

if (input === "--subject" && value) {
  validate(value.trim());
} else if (input === "--git-head") {
  validate(execFileSync("git", ["log", "-1", "--format=%s"], { encoding: "utf8" }).trim());
} else if (input === "--range" && value) {
  const subjects = execFileSync("git", ["log", "--reverse", "--format=%s", value], {
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean);
  for (const subject of subjects) {
    validate(subject.trim());
  }
} else if (input && !input.startsWith("--")) {
  validate(readFileSync(input, "utf8").split(/\r?\n/, 1)[0].trim());
} else {
  console.error("provide a commit message file, --subject, --git-head, or --range");
  process.exitCode = 2;
}
