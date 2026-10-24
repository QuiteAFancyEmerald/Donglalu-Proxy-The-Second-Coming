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
