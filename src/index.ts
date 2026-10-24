import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { binPath, clientPath, hasBundledBinary } from "./path.js";

export { binPath, clientPath, hasBundledBinary };

export interface RelayOptions {
  /** Master switch. When false nothing is spawned, routeRequest() passes and clientScript() returns "". */
  enabled?: boolean;
  /** Signs TURN credentials. Passed to the relay so it can check them. `openssl rand -hex 32`. */
  secret: string;
  /** Spawn the relay. Set false in every process but one when several share a relay (cluster workers). Default true. */
  spawn?: boolean;
  /** Path to the dlpcc-relay binary. Default is the prebuilt one for this platform, else "dlpcc-relay" from PATH. */
  binary?: string;
  /** Public IPv4 of the box, advertised for relayed media. Required when spawning. */
  relayIp?: string;
  /** UDP range for relay sockets. Default "49152-65535". */
  relayPorts?: string;
  /** Plain TCP TURN listener nginx forwards to. Default "127.0.0.1:3478". */
  turnListen?: string;
  /** Port put in TURN URLs. Default 443. */
  publicPort?: number;
  /**
   * Hand out turns: URLs (TLS, through nginx). Set false to point browsers
   * straight at the relay with turn:, for local testing without nginx; then
   * publicPort should be turnListen's port. Default true.
   */
  tls?: boolean;
  /** Credential lifetime in seconds. Default 12 hours. */
  ttl?: number;
  /** Force iceTransportPolicy "relay". Default true. */
  forceRelay?: boolean;
  /** Allowed hostnames, "*.example.com" wildcards ok. Empty allows any host. */
  hosts?: string[];
  /** Path prefix for routeRequest(). Default "/dlpcc". */
  basePath?: string;
  /** Only relay to these CIDRs, e.g. your streaming provider's ranges. Default: any public address. */
  allowPeers?: string[];
  /** Extra CIDRs to block on top of the built-in private ranges. */
  denyPeers?: string[];
  /** Concurrent relays per credential, 0 for no limit. Default 8. */
  maxAllocsPerUser?: number;
  /** Concurrent relays in total, 0 for no limit. Default 1000. */
  maxAllocs?: number;
  /** Relay log level: error, warn, info, debug, trace. Default "warn". */
  logLevel?: string;
}

export interface IceServer {
  urls: string[];
  username: string;
  credential: string;
}

export interface IceConfig {
  iceServers: IceServer[];
  iceTransportPolicy?: "relay";
  expires: number;
}

const PLACEHOLDER = "/*__DLPCC_CONFIG__*/null";
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

let clientSource: string | undefined;
function loadClient(): string {
  return (clientSource ??= readFileSync(clientPath, "utf8"));
}

export class Relay {
  readonly enabled: boolean;
  private readonly opts: RelayOptions;
  private child?: ChildProcess;
  private stopping = false;
  private backoff = 1000;

  constructor(opts: RelayOptions) {
    this.opts = opts;
    this.enabled = opts.enabled ?? true;
    if (this.enabled && !opts.secret) throw new Error("dlpcc: secret is required");
  }

  /** Spawns the relay (if enabled and spawn !== false). Resolves once the process has started. */
  async start(): Promise<void> {
    if (!this.enabled || this.opts.spawn === false || this.child) return;
    if (!this.opts.relayIp) throw new Error("dlpcc: relayIp is required to spawn the relay");
    if (!this.opts.binary && hasBundledBinary && process.platform !== "win32") {
      // npm doesn't keep the exec bit on binaries built on Windows.
      chmodSync(binPath, 0o755);
    }
    this.stopping = false;
    await this.launch();
  }

  /** Stops the child process, if any. */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
  }

  /** Fresh credentials pointing at host, or null when disabled / host not allowed. */
  iceConfig(host: string | undefined): IceConfig | null {
    const name = this.normalizeHost(host);
    if (!this.enabled || !name) return null;

    const expires = Math.floor(Date.now() / 1000) + (this.opts.ttl ?? 12 * 3600);
    const username = `${expires}:${randomBytes(8).toString("hex")}`;
    const credential = createHmac("sha1", this.opts.secret).update(username).digest("base64");
    const config: IceConfig = {
      iceServers: [{ urls: [`${this.opts.tls === false ? "turn" : "turns"}:${name}:${this.opts.publicPort ?? 443}?transport=tcp`], username, credential }],
      expires,
    };
    if (this.opts.forceRelay ?? true) config.iceTransportPolicy = "relay";
    return config;
  }

  /** The browser patch with credentials baked in, safe to inline in a <script> tag. "" when disabled. */
  clientScript(host: string | undefined): string {
    const config = this.iceConfig(host);
    if (!config) return "";
    const json = JSON.stringify(config).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
    return loadClient().replace(PLACEHOLDER, json);
  }

  /**
   * Serves {basePath}/ice and {basePath}/client.js. Returns true if it handled
   * the request, so it slots in next to wisp's routeRequest.
   */
  routeRequest(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.enabled || req.method !== "GET" || !req.url) return false;
    const base = this.opts.basePath ?? "/dlpcc";
    const path = req.url.split("?")[0];
    if (path !== `${base}/ice` && path !== `${base}/client.js`) return false;

    const forwarded = req.headers["x-forwarded-host"];
    const host = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0] ?? req.headers.host;
    res.setHeader("Cache-Control", "no-store");

    if (path.endsWith("/ice")) {
      const config = this.iceConfig(host);
      if (!config) return deny(res);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(config));
    } else {
      const script = this.clientScript(host);
      if (!script) return deny(res);
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      res.end(script);
    }
    return true;
  }

  private normalizeHost(raw: string | undefined): string | null {
    if (!raw) return null;
    const host = raw.trim().toLowerCase().replace(/:\d+$/, "");
    if (!HOST_PATTERN.test(host)) return null;
    const hosts = this.opts.hosts ?? [];
    if (hosts.length === 0) return host;
    const ok = hosts.some((h) => h === host || (h.startsWith("*.") && host.endsWith(h.slice(1))));
    return ok ? host : null;
  }

  private launch(): Promise<void> {
    const o = this.opts;
    const child = spawn(o.binary ?? (hasBundledBinary ? binPath : "dlpcc-relay"), [], {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        DLPCC_SECRET: o.secret,
        DLPCC_RELAY_IP: o.relayIp,
        DLPCC_RELAY_PORTS: o.relayPorts ?? "49152-65535",
        DLPCC_TURN_LISTEN: o.turnListen ?? "127.0.0.1:3478",
        DLPCC_ALLOW_PEERS: o.allowPeers?.join(",") ?? "",
        DLPCC_DENY_PEERS: o.denyPeers?.join(",") ?? "",
        DLPCC_MAX_ALLOCS_PER_USER: String(o.maxAllocsPerUser ?? 8),
        DLPCC_MAX_ALLOCS: String(o.maxAllocs ?? 1000),
        DLPCC_LOG_LEVEL: o.logLevel ?? "warn",
      },
    });
    this.child = child;

    child.on("exit", (code, signal) => {
      this.child = undefined;
      if (this.stopping) return;
      console.error(`dlpcc: relay exited (${signal ?? code}), restarting in ${this.backoff}ms`);
      setTimeout(() => {
        if (!this.stopping) this.launch().catch((err) => console.error("dlpcc:", err));
      }, this.backoff).unref();
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });

    return new Promise((resolve, reject) => {
      child.once("spawn", () => {
        this.backoff = 1000;
        resolve();
      });
      child.once("error", reject);
    });
  }
}

function deny(res: ServerResponse): true {
  res.statusCode = 403;
  res.end("unknown host");
  return true;
}

export function createRelay(opts: RelayOptions): Relay {
  return new Relay(opts);
}
