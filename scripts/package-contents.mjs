// Verify that a packaged app contains only reviewed runtime files.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listPackage } from "@electron/asar";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const outputRoot = join(repositoryRoot, "out");
const applicationDirectories = readdirSync(outputRoot).filter((entry) =>
  /^OpenMinion-(darwin|linux|win32)-/.test(entry),
);

if (applicationDirectories.length === 0) {
  throw new Error("packaged OpenMinion application was not found");
}

const allowedRoots = new Set(["dist", "LICENSE", "NOTICE", "package.json"]);
const required = [
  "/LICENSE",
  "/NOTICE",
  "/dist/src/main/bootstrap.js",
  "/dist/src/main/desktop-store.js",
  "/dist/src/main/index.js",
  "/dist/src/preload/index.cjs",
  "/dist/src/preload/capture.cjs",
  "/dist/src/renderer/app.js",
  "/dist/src/renderer/capture-worker.html",
  "/dist/src/renderer/capture-worker.js",
  "/dist/src/renderer/index.html",
  "/dist/src/renderer/styles.css",
  "/dist/src/renderer/logo.png",
  "/package.json",
];

for (const applicationDirectory of applicationDirectories) {
  const platform = applicationDirectory.split("-")[1];
  const archive = join(
    outputRoot,
    applicationDirectory,
    platform === "darwin" ? "OpenMinion.app/Contents/Resources/app.asar" : "resources/app.asar",
  );
  if (!existsSync(archive)) {
    throw new Error(`packaged application archive was not found: ${archive}`);
  }

  const entries = listPackage(archive).map((entry) => entry.replaceAll("\\", "/"));
  const unexpected = entries.filter((entry) => !allowedRoots.has(entry.split("/")[1]));
  if (unexpected.length > 0) {
    throw new Error(
      `packaged application contains repository-only files:\n${unexpected.join("\n")}`,
    );
  }

  const missing = required.filter((entry) => !entries.includes(entry));
  if (missing.length > 0) {
    throw new Error(`packaged application is missing runtime files:\n${missing.join("\n")}`);
  }

  console.log(`Package contents verified: ${applicationDirectory} (${entries.length} entries)`);
}

if (process.argv.includes("--artifacts")) {
  const platform = process.platform;
  const requiredExtensions = {
    darwin: [".dmg", ".zip"],
    linux: [".deb", ".zip"],
    win32: [".zip"],
  }[platform];
  const artifacts = listFiles(join(outputRoot, "make"));
  const missingArtifacts = requiredExtensions.filter(
    (extension) => !artifacts.some((artifact) => artifact.endsWith(extension)),
  );
  if (missingArtifacts.length > 0) {
    throw new Error(`missing ${platform} artifacts: ${missingArtifacts.join(", ")}`);
  }
  console.log(`Make artifacts verified: ${requiredExtensions.join(", ")}`);
}

function listFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}
