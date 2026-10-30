import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { test } from "node:test";
import { createRelay, hasBundledBinary } from "../dist/index.js";

const secret = "test-secret";

test("iceConfig points at the visitor's host", () => {
  const relay = createRelay({ secret, spawn: false });
  const ice = relay.iceConfig("Mirror.Example.com:8080");
  assert.deepEqual(ice.iceServers[0].urls, ["turns:mirror.example.com:443?transport=tcp"]);
  assert.equal(ice.iceTransportPolicy, "relay");
  const [expires] = ice.iceServers[0].username.split(":");
  assert.equal(Number(expires), ice.expires);
  assert.ok(ice.expires > Date.now() / 1000 + 11 * 3600);
});

test("publicHost replaces the visitor's host in TURN URLs", () => {
  const relay = createRelay({ secret, spawn: false, publicHost: "turn.example.com" });
  assert.deepEqual(relay.iceConfig("mirror.example.com").iceServers[0].urls, ["turns:turn.example.com:443?transport=tcp"]);
  // One TURN name per mirror.
  const perMirror = createRelay({ secret, spawn: false, publicHost: (host) => "turn." + host.replace(/^www\./, "") });
  assert.deepEqual(perMirror.iceConfig("www.mirror2.net").iceServers[0].urls, ["turns:turn.mirror2.net:443?transport=tcp"]);
});

test("hosts allowlist and invalid hosts", () => {
  const relay = createRelay({ secret, spawn: false, hosts: ["*.example.com", "example2.com"] });
  assert.ok(relay.iceConfig("a.example.com"));
  assert.ok(relay.iceConfig("example2.com"));
  assert.equal(relay.iceConfig("example.com"), null);
  assert.equal(relay.iceConfig("badexample.com"), null);
  assert.equal(createRelay({ secret, spawn: false }).iceConfig('evil"host'), null);
});

test("disabled relay does nothing", () => {
  const relay = createRelay({ enabled: false, secret: "" });
  assert.equal(relay.iceConfig("example.com"), null);
  assert.equal(relay.clientScript("example.com"), "");
});

test("clientScript fills in the config and is safe to inline", () => {
  const script = createRelay({ secret, spawn: false }).clientScript("example.com");
  assert.ok(script.includes("turns:example.com:443"));
  assert.ok(!script.includes("__DLPCC_CONFIG__"));
  assert.ok(!/<\/script/i.test(script));
});

test("routeRequest serves /dlpcc/* and passes everything else", async (t) => {
  const relay = createRelay({ secret, spawn: false, hosts: ["example.com"] });
  const server = createServer((req, res) => {
    if (!relay.routeRequest(req, res)) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());

  const get = (path, headers) =>
    new Promise((resolve, reject) => {
      request({ host: "127.0.0.1", port: server.address().port, path, headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
        .on("error", reject)
        .end();
    });

  const ice = await get("/dlpcc/ice", { "x-forwarded-host": "example.com" });
  assert.equal(ice.status, 200);
  assert.equal(JSON.parse(ice.body).iceServers[0].urls[0], "turns:example.com:443?transport=tcp");
  assert.equal((await get("/dlpcc/client.js", { host: "example.com" })).status, 200);
  assert.equal((await get("/dlpcc/ice", { host: "other.com" })).status, 403);
  assert.equal((await get("/", { host: "example.com" })).status, 404);
});

// The real handoff: the wrapper signs a credential, the Go relay it spawned
// has to accept it.
test("spawned relay accepts the wrapper's credentials", { skip: !hasBundledBinary && "no bundled binary, run npm run build:bins" }, async (t) => {
  const port = await freePort();
  const relay = createRelay({ secret, relayIp: "127.0.0.1", turnListen: `127.0.0.1:${port}`, relayPorts: "50000-50100" });
  await relay.start();
  t.after(() => relay.stop());

  const { username, credential } = relay.iceConfig("example.com").iceServers[0];
  assert.equal(await allocate(port, username, credential), "ok");
  // pion answers a bad MESSAGE-INTEGRITY with 400 rather than 401.
  assert.match(await allocate(port, username, "wrong"), /^error 4/);
});

test("parses the hosts browsers send", () => {
  const relay = createRelay({ secret, spawn: false });
  assert.equal(relay.iceConfig("example.com.").iceServers[0].urls[0], "turns:example.com:443?transport=tcp");
  assert.equal(relay.iceConfig("[::1]:8080").iceServers[0].urls[0], "turns:[::1]:443?transport=tcp");
  assert.equal(relay.iceConfig("127.0.0.1").iceServers[0].urls[0], "turns:127.0.0.1:443?transport=tcp");
  assert.equal(relay.iceConfig("example.com:99999"), null);
  assert.equal(relay.iceConfig("a b.com"), null);
});

test("a spawning relay makes up its own secret", () => {
  assert.ok(createRelay().iceConfig("example.com"));
  assert.throws(() => createRelay({ spawn: false }), /secret is required/);
});

test("attached relay hands out the visitor's own port and scheme", () => {
  const relay = createRelay({ secret, spawn: false }).attach(createServer());
  const req = (host, encrypted) => ({ headers: { host }, socket: { encrypted } });
  assert.equal(relay.iceConfig(req("localhost:8080")).iceServers[0].urls[0], "turn:localhost:8080?transport=tcp");
  assert.equal(relay.iceConfig(req("example.com", false)).iceServers[0].urls[0], "turn:example.com:80?transport=tcp");
  assert.equal(relay.iceConfig(req("example.com", true)).iceServers[0].urls[0], "turns:example.com:443?transport=tcp");
  assert.equal(relay.iceConfig(req("example.com:8443", true)).iceServers[0].urls[0], "turns:example.com:8443?transport=tcp");
  const pinned = createRelay({ secret, spawn: false, tls: true, publicPort: 443 }).attach(createServer());
  assert.equal(pinned.iceConfig(req("localhost:8080")).iceServers[0].urls[0], "turns:localhost:443?transport=tcp");
});

// No nginx: TURN, plain requests and websocket upgrades all share the app's port.
test("attach shares the server's port with the relay", { skip: !hasBundledBinary && "no bundled binary, run npm run build:bins" }, async (t) => {
  const turnPort = await freePort();
  const relay = createRelay({ secret, relayIp: "127.0.0.1", turnListen: `127.0.0.1:${turnPort}`, relayPorts: "50101-50200" });
  const server = createServer((req, res) => {
    if (!relay.routeRequest(req, res)) res.end("app");
  });
  server.on("upgrade", (req, socket) => {
    socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  relay.attach(server);
  await relay.start();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.after(() => {
    server.close();
    return relay.stop();
  });

  const get = (path) =>
    new Promise((resolve, reject) => {
      request({ host: "127.0.0.1", port, path, headers: { host: `localhost:${port}` } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      })
        .on("error", reject)
        .end();
    });
  assert.equal(await get("/"), "app");
  const ice = JSON.parse(await get("/dlpcc/ice"));
  assert.equal(ice.iceServers[0].urls[0], `turn:localhost:${port}?transport=tcp`);

  const upgraded = await new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, headers: { Connection: "Upgrade", Upgrade: "websocket" } })
      .on("upgrade", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode);
      })
      .on("error", reject)
      .end();
  });
  assert.equal(upgraded, 101);

  const { username, credential } = ice.iceServers[0];
  assert.equal(await allocate(port, username, credential), "ok");
  assert.match(await allocate(port, username, "wrong"), /^error 4/);
  // The app keeps working after TURN traffic went through the same port.
  assert.equal(await get("/"), "app");
});

test("two attached relays on one machine each get their own listener", { skip: !hasBundledBinary && "no bundled binary, run npm run build:bins" }, async (t) => {
  const apps = [];
  for (const relayPorts of ["50201-50250", "50251-50300"]) {
    const relay = createRelay({ secret: randomBytes(16).toString("hex"), relayIp: "127.0.0.1", relayPorts });
    const server = createServer((req, res) => relay.routeRequest(req, res) || res.end());
    relay.attach(server);
    await relay.start();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => {
      server.close();
      return relay.stop();
    });
    apps.push({ relay, port: server.address().port });
  }
  // Each app's credentials work on its own port, so neither reached the other's relay.
  for (const { relay, port } of apps) {
    const { username, credential } = relay.iceConfig(`localhost:${port}`).iceServers[0];
    assert.equal(await allocate(port, username, credential), "ok");
  }
});

test("start rejects when the relay can't listen", { skip: !hasBundledBinary && "no bundled binary, run npm run build:bins" }, async (t) => {
  const taken = createTcpServer().listen(0, "127.0.0.1");
  await new Promise((r) => taken.once("listening", r));
  t.after(() => taken.close());
  const relay = createRelay({ secret, relayIp: "127.0.0.1", turnListen: `127.0.0.1:${taken.address().port}` });
  await assert.rejects(relay.start(), /exited before listening/);
});

// Minimal req/res pair for calling routeRequest directly, with a chosen
// source IP: enough for the endpoints and the rate limiter, no sockets.
function fakeReq(ip, host = "example.com", path = "/dlpcc/ice") {
  return { method: "GET", url: path, headers: { host }, socket: { remoteAddress: ip } };
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body = "") {
      this.body = body;
    },
  };
}

test("rate limits the dlpcc endpoints per client IP", () => {
  const relay = createRelay({ secret, spawn: false, hosts: ["example.com"], rateLimit: 60, rateLimitBurst: 3 });
  const get = (ip) => {
    const res = fakeRes();
    assert.equal(relay.routeRequest(fakeReq(ip), res), true);
    return res;
  };
  for (let i = 0; i < 3; i++) assert.equal(get("198.51.100.1").statusCode, 200);
  const held = get("198.51.100.1");
  assert.equal(held.statusCode, 429);
  assert.ok(Number(held.headers["Retry-After"]) >= 1);
  assert.equal(JSON.parse(held.body).error, "rate_limited");
  // A different client has its own bucket.
  assert.equal(get("198.51.100.2").statusCode, 200);
});

test("the limiter prefers req.ip over the socket address", () => {
  const relay = createRelay({ secret, spawn: false, hosts: ["example.com"], rateLimit: 60, rateLimitBurst: 1 });
  // Express sets req.ip once its trust proxy is configured; the wrapper keys
  // buckets on it so visitors behind a reverse proxy are limited individually.
  const withIp = (ip) => ({ ...fakeReq("127.0.0.1"), ip });
  const first = fakeRes();
  relay.routeRequest(withIp("203.0.113.9"), first);
  assert.equal(first.statusCode, 200);
  const held = fakeRes();
  relay.routeRequest(withIp("203.0.113.9"), held);
  assert.equal(held.statusCode, 429);
  const other = fakeRes();
  relay.routeRequest(withIp("203.0.113.10"), other);
  assert.equal(other.statusCode, 200);
  const socket = fakeRes();
  relay.routeRequest(fakeReq("192.0.2.7"), socket);
  assert.equal(socket.statusCode, 200); // without req.ip, the socket is the key
});

test("rateLimit 0 turns the limiter off", () => {
  const relay = createRelay({ secret, spawn: false, hosts: ["example.com"], rateLimit: 0 });
  for (let i = 0; i < 25; i++) {
    const res = fakeRes();
    assert.equal(relay.routeRequest(fakeReq("198.51.100.1"), res), true);
    assert.equal(res.statusCode, 200);
  }
});

test("rateLimitGlobal caps minting across all clients", () => {
  const relay = createRelay({ secret, spawn: false, hosts: ["example.com"], rateLimit: 0, rateLimitGlobal: 2 });
  const get = (ip) => {
    const res = fakeRes();
    relay.routeRequest(fakeReq(ip), res);
    return res;
  };
  assert.equal(get("198.51.100.1").statusCode, 200);
  assert.equal(get("198.51.100.2").statusCode, 200);
  assert.equal(get("198.51.100.3").statusCode, 429);
});

test("DLPCC_* environment variables configure the wrapper", (t) => {
  process.env.DLPCC_HOSTS = "env.example.com";
  process.env.DLPCC_RATE_LIMIT = "30";
  process.env.DLPCC_RATE_LIMIT_BURST = "1";
  t.after(() => {
    delete process.env.DLPCC_HOSTS;
    delete process.env.DLPCC_RATE_LIMIT;
    delete process.env.DLPCC_RATE_LIMIT_BURST;
  });
  const relay = createRelay({ secret, spawn: false });
  assert.ok(relay.iceConfig("env.example.com"));
  assert.equal(relay.iceConfig("example.com"), null);
  const first = fakeRes();
  relay.routeRequest(fakeReq("198.51.100.1", "env.example.com"), first);
  assert.equal(first.statusCode, 200);
  const held = fakeRes();
  relay.routeRequest(fakeReq("198.51.100.1", "env.example.com"), held);
  assert.equal(held.statusCode, 429); // the env set a burst of one
});

test("explicit options beat the environment", (t) => {
  process.env.DLPCC_RATE_LIMIT = "1";
  process.env.DLPCC_RATE_LIMIT_BURST = "1";
  t.after(() => {
    delete process.env.DLPCC_RATE_LIMIT;
    delete process.env.DLPCC_RATE_LIMIT_BURST;
  });
  const relay = createRelay({ secret, spawn: false, hosts: ["example.com"], rateLimit: 0 });
  for (let i = 0; i < 25; i++) {
    const res = fakeRes();
    relay.routeRequest(fakeReq("198.51.100.1"), res);
    assert.equal(res.statusCode, 200);
  }
});

function freePort() {
  return new Promise((resolve) => {
    const srv = createTcpServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Minimal TURN Allocate over TCP (RFC 5766): an unauthenticated request to
// get the realm and nonce, then a signed one.
async function allocate(port, username, password) {
  const sock = await connectRetry(port);
  try {
    const first = await roundTrip(sock, buildAllocate());
    const attrs = parseAttrs(first);
    const realm = attrs.get(0x0014);
    const nonce = attrs.get(0x0015);
    const key = createHash("md5").update(`${username}:${realm}:${password}`).digest();
    const res = await roundTrip(sock, buildAllocate({ username, realm, nonce, key }));
    const type = res.readUInt16BE(0);
    if (type === 0x0103) return "ok";
    const err = parseAttrs(res).get(0x0009, true);
    return `error ${err[2] * 100 + err[3]}`;
  } finally {
    sock.destroy();
  }
}

async function connectRetry(port) {
  for (let i = 0; ; i++) {
    try {
      return await new Promise((resolve, reject) => {
        const s = connect(port, "127.0.0.1", () => resolve(s)).once("error", reject);
      });
    } catch (err) {
      if (i > 40) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

function attr(type, value) {
  const pad = (4 - (value.length % 4)) % 4;
  const head = Buffer.alloc(4);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(value.length, 2);
  return Buffer.concat([head, value, Buffer.alloc(pad)]);
}

function buildAllocate(auth) {
  const body = [attr(0x0019, Buffer.from([17, 0, 0, 0]))]; // REQUESTED-TRANSPORT: UDP
  if (auth) {
    body.push(attr(0x0006, Buffer.from(auth.username)), attr(0x0014, Buffer.from(auth.realm)), attr(0x0015, Buffer.from(auth.nonce)));
  }
  const header = Buffer.alloc(20);
  header.writeUInt16BE(0x0003, 0);
  header.writeUInt32BE(0x2112a442, 4);
  randomBytes(12).copy(header, 8);
  let msg = Buffer.concat([header, ...body]);
  if (auth) {
    // MESSAGE-INTEGRITY covers the message with the length already counting it.
    msg.writeUInt16BE(msg.length - 20 + 24, 2);
    msg = Buffer.concat([msg, attr(0x0008, createHmac("sha1", auth.key).update(msg).digest())]);
  }
  msg.writeUInt16BE(msg.length - 20, 2);
  return msg;
}

function roundTrip(sock, msg) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 20 && buf.length >= 20 + buf.readUInt16BE(2)) {
        sock.off("data", onData);
        resolve(buf.subarray(0, 20 + buf.readUInt16BE(2)));
      }
    };
    sock.on("data", onData).once("error", reject);
    sock.once("close", () => reject(new Error("connection closed")));
    sock.write(msg);
  });
}

function parseAttrs(msg) {
  const out = new Map();
  for (let off = 20; off + 4 <= msg.length; ) {
    const type = msg.readUInt16BE(off);
    const len = msg.readUInt16BE(off + 2);
    out.set(type, msg.subarray(off + 4, off + 4 + len));
    off += 4 + len + ((4 - (len % 4)) % 4);
  }
  return { get: (type, raw) => (raw ? out.get(type) : out.get(type)?.toString()) };
}
