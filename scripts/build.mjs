// Build runtime JavaScript and copy the renderer's static assets.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const outputRoot = join(repositoryRoot, "dist");
const rendererOutput = join(outputRoot, "src/renderer");

rmSync(outputRoot, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [join(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
  { cwd: repositoryRoot, stdio: "inherit" },
);

// Sandboxed Electron preloads require a single CommonJS file, including shared contracts.
await build({
  entryPoints: ["src/preload/index.ts", "src/preload/capture.ts"],
  absWorkingDir: repositoryRoot,
  outdir: join(outputRoot, "src/preload"),
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  target: "node24",
});
for (const name of ["index", "capture"]) {
  rmSync(join(outputRoot, `src/preload/${name}.js`));
}

mkdirSync(rendererOutput, { recursive: true });
for (const asset of ["capture-worker.html", "index.html", "styles.css"]) {
  copyFileSync(join(repositoryRoot, "src/renderer", asset), join(rendererOutput, asset));
}
copyFileSync(join(repositoryRoot, "assets/icon.png"), join(rendererOutput, "logo.png"));
