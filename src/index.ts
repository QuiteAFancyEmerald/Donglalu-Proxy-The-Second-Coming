import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { chmodSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect, createServer as createNetServer, type AddressInfo, type Server, type Socket } from "node:net";
import { Server as TlsServer, type TLSSocket } from "node:tls";
import { binPath, clientPath, hasBundledBinary } from "./path.js";

export { binPath, clientPath, hasBundledBinary };

export interface RelayOptions {
  /** Master switch. When false nothing is spawned, routeRequest() passes and clientScript() returns "". */
  enabled?: boolean;
  /**
   * Signs TURN credentials. Passed to the relay so it can check them. `openssl rand -hex 32`.
   * Optional when this process spawns the relay: a random one is made per run.
   */
  secret?: string;
  /** Spawn the relay. Set false in every process but one when several share a relay (cluster workers). Default true. */
  spawn?: boolean;
  /** Path to the dlpcc-relay binary. Default is the prebuilt one for this platform, else "dlpcc-relay" from PATH. */
  binary?: string;
  /** IPv4 advertised for relayed media. Default: the address of the interface with the default route. */
  relayIp?: string;
  /** UDP range for relay sockets. Default "49152-65535". */
  relayPorts?: string;
  /** Plain TCP TURN listener that nginx or attach() forwards to. Default "127.0.0.1:3478". */
  turnListen?: string;
  /**
   * Host put in TURN URLs instead of the one the visitor used. Only for sites
   * behind Cloudflare or another CDN that passes nothing but HTTP: point a
   * DNS-only name such as "turn.example.com" straight at the server. A
   * function gets the visitor's host, for one TURN name per mirror.
   */
  publicHost?: string | ((host: string) => string);
  /** Port put in TURN URLs. Default 443, or the visitor's port once attach()ed. */
  publicPort?: number;
  /**
   * Hand out turns: (TLS) rather than turn: URLs. Default true behind nginx;
   * once attach()ed, whether the visitor's connection is TLS.
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
  /**
   * Lift the built-in block on private, loopback and the relay's own
   * addresses. For testing on one machine or a LAN only: anyone with a
   * credential can then reach your network. Default false.
   */
  allowPrivatePeers?: boolean;
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
const IPV6_PATTERN = /^\[[0-9a-f:.]+\]$/;

let clientSource: string | undefined;
function loadClient(): string {
  return (clientSource ??= readFileSync(clientPath, "utf8"));
}

export class Relay {
  readonly enabled: boolean;
  private readonly opts: RelayOptions;
  private readonly secret: string;
  private child?: ChildProcess;
  private relayIp?: string;
  private turnListen: string;
  private attached = false;
  private stopping = false;
  // start() reports a first launch that fails instead of retrying it.
  private starting = false;
  private backoff = 1000;

  constructor(opts: RelayOptions = {}) {
    this.opts = opts;
    this.enabled = opts.enabled ?? true;
    if (this.enabled && !opts.secret && opts.spawn === false) {
      throw new Error("dlpcc: secret is required when the relay is spawned elsewhere");
    }
    // A relay this process spawns can share a secret made up on the spot.
    this.secret = opts.secret || randomBytes(32).toString("hex");
    this.turnListen = opts.turnListen ?? "127.0.0.1:3478";
  }

  /**
   * Spawns the relay (if enabled and spawn !== false). Resolves once it's
   * listening; rejects if it exits first. Call attach() before this.
   */
  async start(): Promise<void> {
    if (!this.enabled || this.opts.spawn === false || this.child) return;
    this.relayIp ??= this.opts.relayIp || (await detectRelayIp());
    // Once attach()ed only this process talks to the listener, so any free
    // port does, and two apps on one machine don't fight over 3478.
    if (this.attached && !this.opts.turnListen) this.turnListen = `127.0.0.1:${await freePort()}`;
    if (!this.opts.binary && hasBundledBinary && process.platform !== "win32") {
      // npm doesn't keep the exec bit on binaries built on Windows.
      chmodSync(binPath, 0o755);
    }
    this.stopping = false;
    this.starting = true;
    const ok = await this.launch();
    this.starting = false;
    if (!ok) {
      this.stopping = true;
      throw new Error(`dlpcc: relay exited before listening on ${this.turnListen}; see its log above`);
    }
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

  /**
   * Shares server's port with the relay, so no nginx is needed: connections
   * that open with a STUN message go to the relay, everything else to the
   * server as usual. Works on http and https servers; on https the check runs
   * after TLS, so browsers get turns: on the same port and certificate.
   */
  attach(server: Server): this {
    if (!this.enabled || this.attached) return this;
    this.attached = true;
    // https hands its request handling decrypted sockets on "secureConnection".
    const event = server instanceof TlsServer ? "secureConnection" : "connection";
    const relay = this;
    const emit = server.emit as (this: Server, name: string | symbol, ...args: unknown[]) => boolean;
    server.emit = function (this: Server, name: string | symbol, ...args: unknown[]) {
      if (name !== event) return emit.call(this, name, ...args);
      const socket = args[0] as Socket;
      sniff(socket, (turn) => {
        if (turn) relay.pipe(socket);
        else {
          emit.call(server, event, socket);
          socket.resume();
        }
      });
      return true;
    } as Server["emit"];
    return this;
  }

  /**
   * Fresh credentials for whoever made req (or for a bare host name), or null
   * when disabled / host not allowed.
   */
  iceConfig(target: IncomingMessage | string | undefined): IceConfig | null {
    const { host, secure } = typeof target === "object" ? describe(target) : { host: target, secure: false };
    const parsed = this.parseHost(host);
    if (!this.enabled || !parsed) return null;

    const tls = this.opts.tls ?? (this.attached ? secure : true);
    const port = this.opts.publicPort ?? (this.attached ? parsed.port ?? (tls ? 443 : 80) : 443);
    const expires = Math.floor(Date.now() / 1000) + (this.opts.ttl ?? 12 * 3600);
    const publicHost = this.opts.publicHost;
    const turnHost = typeof publicHost === "function" ? publicHost(parsed.name) : (publicHost ?? parsed.name);
    const username = `${expires}:${randomBytes(8).toString("hex")}`;
    const credential = createHmac("sha1", this.secret).update(username).digest("base64");
    const config: IceConfig = {
      iceServers: [{ urls: [`${tls ? "turns" : "turn"}:${turnHost}:${port}?transport=tcp`], username, credential }],
      expires,
    };
    if (this.opts.forceRelay ?? true) config.iceTransportPolicy = "relay";
    return config;
  }

  /** The browser patch with credentials baked in, safe to inline in a <script> tag. "" when disabled. */
  clientScript(target: IncomingMessage | string | undefined): string {
    const config = this.iceConfig(target);
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

    res.setHeader("Cache-Control", "no-store");
    if (path.endsWith("/ice")) {
      const config = this.iceConfig(req);
      if (!config) return deny(res);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(config));
    } else {
      const script = this.clientScript(req);
      if (!script) return deny(res);
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      res.end(script);
    }
    return true;
  }

  private parseHost(raw: string | undefined): { name: string; port?: number } | null {
    if (!raw) return null;
    const match = /^(.*?)(?::(\d{1,5}))?$/.exec(raw.trim().toLowerCase());
    const name = match?.[1].replace(/\.$/, "") ?? "";
    const port = match?.[2] ? Number(match[2]) : undefined;
    if (!(HOST_PATTERN.test(name) || IPV6_PATTERN.test(name)) || (port !== undefined && (port < 1 || port > 65535))) {
      return null;
    }
    const hosts = this.opts.hosts ?? [];
    if (hosts.length && !hosts.some((h) => h === name || (h.startsWith("*.") && name.endsWith(h.slice(1))))) {
      return null;
    }
    return { name, port };
  }

  // Hands an attach()ed connection to the relay's TURN listener.
  private pipe(socket: Socket): void {
    const [host, port] = splitHostPort(this.turnListen);
    const upstream = connect(port, host);
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    socket.setNoDelay(true);
    upstream.setNoDelay(true);
    socket.on("error", close).on("close", close);
    upstream.on("error", close).on("close", close);
    socket.pipe(upstream).pipe(socket);
  }

  // Resolves false if the relay exits before it's listening.
  private launch(): Promise<boolean> {
    const o = this.opts;
    const child = spawn(o.binary ?? (hasBundledBinary ? binPath : "dlpcc-relay"), [], {
      stdio: ["ignore", "inherit", "pipe"],
      env: {
        ...process.env,
        DLPCC_SECRET: this.secret,
        DLPCC_RELAY_IP: this.relayIp,
        DLPCC_RELAY_PORTS: o.relayPorts ?? "49152-65535",
        DLPCC_TURN_LISTEN: this.turnListen,
        DLPCC_ALLOW_PEERS: o.allowPeers?.join(",") ?? "",
        DLPCC_DENY_PEERS: o.denyPeers?.join(",") ?? "",
        DLPCC_ALLOW_PRIVATE_PEERS: String(o.allowPrivatePeers ?? false),
        DLPCC_MAX_ALLOCS_PER_USER: String(o.maxAllocsPerUser ?? 8),
        DLPCC_MAX_ALLOCS: String(o.maxAllocs ?? 1000),
        DLPCC_LOG_LEVEL: o.logLevel ?? "warn",
      },
    });
    this.child = child;

    child.on("exit", (code, signal) => {
      this.child = undefined;
      if (this.stopping || this.starting) return;
      console.error(`dlpcc: relay exited (${signal ?? code}), restarting in ${this.backoff}ms`);
      setTimeout(() => {
        if (!this.stopping) this.launch().catch((err) => console.error("dlpcc:", err));
      }, this.backoff).unref();
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });

    // The relay logs "turn on" once its listener is bound. Probing the port
    // instead could reach some other process that already holds it.
    return new Promise<boolean>((resolve, reject) => {
      let seen = "";
      let ready = false;
      child.stderr!.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk);
        if (ready) return;
        seen += chunk;
        if (seen.includes("dlpcc-relay: turn on ")) {
          ready = true;
          this.backoff = 1000;
          resolve(true);
        }
      });
      child.once("error", reject);
      child.once("exit", () => resolve(false));
    });
  }
}

// A loopback port nothing is listening on right now.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

// The host the visitor typed and whether they reached us over TLS.
function describe(req: IncomingMessage): { host?: string; secure: boolean } {
  const forwarded = req.headers["x-forwarded-host"];
  const host = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0] ?? req.headers.host;
  return { host, secure: !!(req.socket as TLSSocket).encrypted };
}

// Waits for a connection's first bytes, then puts them back. STUN messages
// (and so TURN) start with two zero bits; HTTP starts with a letter.
function sniff(socket: Socket, done: (turn: boolean) => void): void {
  const ignore = () => {};
  socket.on("error", ignore);
  socket.setTimeout(30_000, () => socket.destroy());
  socket.once("data", (chunk: Buffer) => {
    socket.pause();
    socket.setTimeout(0);
    socket.off("error", ignore);
    socket.unshift(chunk);
    done(chunk[0] < 0x40);
  });
}

function splitHostPort(addr: string): [string, number] {
  const i = addr.lastIndexOf(":");
  return [addr.slice(0, i).replace(/^\[|\]$/g, "") || "127.0.0.1", Number(addr.slice(i + 1))];
}

// The local address outbound traffic leaves from. A UDP connect() picks the
// route without sending anything.
function detectRelayIp(): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createSocket("udp4");
    sock.once("error", (err) => {
      sock.close();
      reject(new Error(`dlpcc: couldn't detect relayIp, set it: ${err.message}`));
    });
    sock.connect(53, "1.1.1.1", () => {
      const { address } = sock.address();
      sock.close();
      resolve(address);
    });
  });
}

function deny(res: ServerResponse): true {
  res.statusCode = 403;
  res.end("unknown host");
  return true;
}

export function createRelay(opts?: RelayOptions): Relay {
  return new Relay(opts);
}
