import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const name = platform() === "win32" ? "dlpcc-relay.exe" : "dlpcc-relay";

/** The prebuilt relay for this platform, shipped in bin/<platform>-<arch>/. */
export const binPath = fileURLToPath(new URL(`bin/${platform()}-${arch()}/${name}`, root));

/** The browser patch, before credentials are filled in. */
export const clientPath = fileURLToPath(new URL("src/client.js", root));

/** True when a prebuilt relay exists for this platform. */
export const hasBundledBinary = existsSync(binPath);
