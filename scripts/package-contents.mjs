// Verify that a packaged app contains only reviewed runtime files.

import { listPackage } from "@electron/asar";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const outputRoot = join(repositoryRoot, "out");
const applicationDirectory = readdirSync(outputRoot).find((entry) =>
  entry.startsWith("OpenMinion-"),
);

if (!applicationDirectory) {
  throw new Error("packaged OpenMinion application was not found");
}

const archive = join(
  outputRoot,
  applicationDirectory,
  "OpenMinion.app/Contents/Resources/app.asar",
);
if (!existsSync(archive)) {
  throw new Error(`packaged application archive was not found: ${archive}`);
}

const entries = listPackage(archive);
const allowedRoots = new Set(["dist", "LICENSE", "NOTICE", "package.json"]);
const unexpected = entries.filter((entry) => !allowedRoots.has(entry.split("/")[1]));
if (unexpected.length > 0) {
  throw new Error(`packaged application contains repository-only files:\n${unexpected.join("\n")}`);
}

const required = [
  "/dist/src/main/index.js",
  "/dist/src/preload/index.js",
  "/dist/src/renderer/app.js",
  "/dist/src/renderer/capture-worker.html",
  "/dist/src/renderer/capture-worker.js",
  "/dist/src/renderer/index.html",
  "/dist/src/renderer/styles.css",
  "/dist/src/renderer/logo.png",
  "/package.json",
];
const missing = required.filter((entry) => !entries.includes(entry));
if (missing.length > 0) {
  throw new Error(`packaged application is missing runtime files:\n${missing.join("\n")}`);
}

console.log(`Package contents verified: ${entries.length} runtime entries`);
