// Cross-compiles dlpcc-relay into bin/<platform>-<arch>/ so the package runs
// without a Go toolchain on the host. Set GO to use a go binary not on PATH,
// or DLPCC_TARGETS="linux-x64,win32-x64" to build a subset.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const targets = [
  ["linux", "x64"],
  ["linux", "arm64"],
  ["darwin", "x64"],
  ["darwin", "arm64"],
  ["win32", "x64"],
  ["win32", "arm64"],
];
const goos = { linux: "linux", darwin: "darwin", win32: "windows" };
const goarch = { x64: "amd64", arm64: "arm64" };

const only = process.env.DLPCC_TARGETS?.split(",").map((t) => t.trim());
const root = fileURLToPath(new URL("../", import.meta.url));
const binDir = new URL("../bin/", import.meta.url);

if (!only) rmSync(binDir, { recursive: true, force: true });

for (const [platform, arch] of targets) {
  const target = `${platform}-${arch}`;
  if (only && !only.includes(target)) continue;
  const dir = new URL(`${target}/`, binDir);
  mkdirSync(dir, { recursive: true });
  const out = fileURLToPath(new URL(platform === "win32" ? "dlpcc-relay.exe" : "dlpcc-relay", dir));
  console.log(`building ${target}`);
  execFileSync(process.env.GO ?? "go", ["build", "-trimpath", "-ldflags=-s -w", "-o", out, "./relay"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "0", GOOS: goos[platform], GOARCH: goarch[arch] },
  });
}
