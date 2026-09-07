// Keep public repository files, links, and documented commands synchronized.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageMetadata = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
const requiredFiles = [
  ".github/dependabot.yml",
  ".github/pull_request_template.md",
  ".github/workflows/ci.yml",
  ".githooks/commit-msg",
  ".githooks/pre-commit",
  ".nvmrc",
  "API_COMPATIBILITY.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CODE_QUALITY.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "RELEASING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "docs/README.md",
  "docs/certification-readiness-matrix.md",
  "docs/code-quality-enforcement.md",
  "docs/engineering-patterns.md",
  "docs/getting-started.md",
  "docs/source-tree-owner-map.md",
  "docs/testing-and-validation.md",
];
const expectedHeadings = new Map([
  ["API_COMPATIBILITY.md", "# OpenMinion Desktop API Compatibility"],
  ["CHANGELOG.md", "# OpenMinion Desktop Changelog"],
  ["CODE_OF_CONDUCT.md", "# Code of Conduct"],
  ["CODE_QUALITY.md", "# OpenMinion Desktop Code Quality and Hygiene"],
  ["CONTRIBUTING.md", "# Contributing to OpenMinion Desktop"],
  ["RELEASING.md", "# OpenMinion Desktop Releasing"],
  ["SECURITY.md", "# Security Policy"],
  ["SUPPORT.md", "# Support"],
  ["docs/README.md", "# OpenMinion Desktop Package Docs"],
  ["docs/certification-readiness-matrix.md", "# OpenMinion Desktop Certification Readiness Matrix"],
  ["docs/code-quality-enforcement.md", "# OpenMinion Desktop Code Quality Enforcement"],
  ["docs/engineering-patterns.md", "# OpenMinion Desktop Engineering Patterns"],
  ["docs/getting-started.md", "# OpenMinion Desktop Getting Started"],
  ["docs/source-tree-owner-map.md", "# OpenMinion Desktop Source Tree Owner Map"],
  ["docs/testing-and-validation.md", "# OpenMinion Desktop Testing And Validation"],
]);
const lifecycleFiles = new Set([
  "API_COMPATIBILITY.md",
  "CHANGELOG.md",
  "RELEASING.md",
  "docs/certification-readiness-matrix.md",
  "docs/code-quality-enforcement.md",
  "docs/engineering-patterns.md",
  "docs/getting-started.md",
  "docs/source-tree-owner-map.md",
  "docs/testing-and-validation.md",
]);

const failures = [];
for (const file of requiredFiles) {
  if (!existsSync(join(repositoryRoot, file))) {
    failures.push(`missing required public surface: ${file}`);
  }
}

const markdownFiles = [
  ...requiredFiles.filter((file) => file.endsWith(".md")),
  ...readdirSync(join(repositoryRoot, "docs"))
    .filter((file) => file.endsWith(".md"))
    .map((file) => `docs/${file}`),
];

for (const file of new Set(markdownFiles)) {
  const absoluteFile = join(repositoryRoot, file);
  if (!existsSync(absoluteFile)) {
    continue;
  }

  const content = readFileSync(absoluteFile, "utf8");
  const expectedHeading = expectedHeadings.get(file);
  if (expectedHeading && !content.startsWith(`${expectedHeading}\n`)) {
    failures.push(`unexpected public document heading in ${file}: expected ${expectedHeading}`);
  }
  if (
    lifecycleFiles.has(file) &&
    (!content.includes("\nStatus: ") || !content.includes("\nLast updated: "))
  ) {
    failures.push(`missing lifecycle metadata in public documentation: ${file}`);
  }
  if (/\/Users\/|[A-Za-z]:\\\\Users\\\\/.test(content)) {
    failures.push(`machine-local path in public documentation: ${file}`);
  }

  for (const match of content.matchAll(/(?:!?)\[[^\]]*\]\(([^)]+)\)/g)) {
    validateLink(file, match[1]);
  }
  for (const match of content.matchAll(/<(?:a|img)\b[^>]*(?:href|src)="([^"]+)"/g)) {
    validateLink(file, match[1]);
  }
  for (const match of content.matchAll(/\bnpm run ([a-zA-Z0-9:_-]+)/g)) {
    if (!packageMetadata.scripts?.[match[1]]) {
      failures.push(`unknown npm script in ${file}: ${match[1]}`);
    }
  }
}

function validateLink(sourceFile, link) {
  const target = link.trim().split(/\s+/, 1)[0];
  if (/^(?:[a-z]+:|#)/i.test(target)) {
    return;
  }

  const relativePath = decodeURIComponent(target.split(/[?#]/, 1)[0]);
  if (!relativePath) {
    return;
  }

  const absoluteTarget = resolve(repositoryRoot, dirname(sourceFile), relativePath);
  if (!existsSync(absoluteTarget)) {
    failures.push(`broken local link in ${sourceFile}: ${link}`);
  }
}

if (failures.length > 0) {
  throw new Error(`public surface validation failed:\n${failures.join("\n")}`);
}

console.log(`Public surface verified: ${new Set(markdownFiles).size} Markdown files`);
