# Donglalu Proxy The Second Coming (DLPCC)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/QuiteAFancyEmerald/Donglalu-Proxy-The-Second-Coming?quickstart=1)

Try the demo in a Codespace: see [Demo](#demo) for how to open it.

Keep WebRTC working behind the filter. DLPCC is a TURN relay that shares your
site's own port, so game streaming, voice and video calls, and anything else
built on `RTCPeerConnection` keep running on networks that block UDP. The
media leaves over the same host and port as the rest of your site, inside TLS
when the site is on https.

### This project is recommended for self-hosted instances NOT major web proxy sites. Keep this private as it can be abused and is not secure at all.

It comes in two layers:

- **The relay and Node wrapper** work for any project. A prebuilt Go TURN
  server, spawned and supervised by a small Node package that signs
  short-lived credentials and puts TURN on your HTTP server's port. Point your
  own `RTCPeerConnection`s at it and you have self-hosted TURN with no extra
  ports, DNS records or coturn config.
- **The Scramjet plugin** is for web proxies. Scramjet and Wisp tunnel
  `fetch`, XHR and WebSockets, but a proxied page's `RTCPeerConnection` sends
  its media over UDP straight from the browser, where the proxy can't touch
  it. `DlpccPlugin` patches every proxied page so its peer connections use
  the relay, relay-only, whatever ICE servers the site asks for. GeForce NOW,
  Discord voice and the like then work wherever the proxy itself loads.

## How it fits together

```
browser ──https :443──> your Node server ─┬─ starts with HTTP ──> your app (pages, wisp, ...)
                                          └─ starts with STUN ──> dlpcc-relay ──UDP──> e.g. GeForce NOW
```

- **`relay.attach(server)`** looks at the first bytes of each connection to
  your server. TURN messages go to the relay; everything else carries on to
  your app untouched. On an https server this happens after TLS, so browsers
  get `turns:` on your existing port and certificate.
- **The relay** is a Go TURN server shipped prebuilt in the package for
  Linux, macOS and Windows on x64 and arm64, so no Go toolchain is needed. It
  checks credentials against a shared secret and refuses to relay to private
  networks. The wrapper restarts it if it crashes.
- **`relay.routeRequest`** serves `/dlpcc/ice` (fresh credentials as JSON)
  and `/dlpcc/client.js` (the browser patch with credentials baked in).
- **The patch** (`client.js`) wraps `RTCPeerConnection` in a window so every
  connection uses the relay. The Scramjet plugin applies it to each proxied
  window before the site's own scripts run.

If something else already owns 443 (nginx in front of several sites, say),
nginx can do the split instead; see [nginx](#nginx-optional).

## Layout

```
relay/    Go TURN relay (dlpcc-relay)
src/      Node wrapper, the browser patch (client.js), the Scramjet plugin (scramjet.js)
nginx/    optional stream config for sharing 443 through nginx
demo/     Chemical (Scramjet alpha) proxy with DLPCC wired in
scripts/  cross-compiles the relay into bin/ for the npm package
test/     Node tests
```

## Server setup

```sh
npm install dlpcc
```

```ts
import { createServer } from "node:http"; // or node:https, Express, Fastify's server...
import { createRelay } from "dlpcc";

const relay = createRelay(); // no config needed; see below for production

const server = createServer((req, res) => {
  if (relay.routeRequest(req, res)) return; // /dlpcc/ice, /dlpcc/client.js
  // ...your app
});
server.on("upgrade", (req, socket, head) => {
  // wisp, websockets, as usual
});

relay.attach(server); // before start()
await relay.start(); // resolves once the relay is listening; throws if it can't
server.listen(8080);
process.on("SIGTERM", () => relay.stop());
```

That's the whole server side. With no options it works out of the box: the
secret is made up per run, the relay's public address is detected from the
default route, and TURN URLs use whatever host and port the visitor reached
you on. There's no domain to configure: a visitor on `example.com` gets
`turns:example.com:443`, one on a mirror gets the mirror's name, and new
mirrors work as soon as they point at the server.

Each visitor gets their own short-lived credential, so any number of people
can use the relay at once (up to `maxAllocs` relayed connections in total).
All their media passes through your server, so bandwidth is what to size
for: a game stream is roughly 15 to 50 Mbps per player.

For production:

- `relayIp`: the server's **public** IPv4, if the detected address is a
  private one (behind NAT, in a container). Remote peers send media there.
- `secret`: needed when several processes hand out credentials for one relay
  (cluster workers, several app servers). Use `openssl rand -hex 32`, and
  `spawn: false` in every process but the one that runs the relay.
- Open UDP `49152-65535` (or your `relayPorts`) in and out for relayed media.
  Nothing else: TURN rides your existing port.

With Express, `app.use((req, res, next) => relay.routeRequest(req, res) || next())`,
and attach to the `http.Server` you create for the app before it starts
listening.

### Behind Cloudflare or another CDN

A CDN only forwards web traffic, so the browser's TURN connection to your
site's name stops at the CDN. Keep the site proxied as it is, and add a
**DNS-only** (grey cloud) name for TURN that points straight at the server.
The proxy page stays on `example.com`; only the media goes to
`turn.example.com`. The browser connects to that name directly, with no
cross-origin rules involved, and the relay accepts the credentials
`example.com` handed out because they're signed with the same secret.

One domain:

```ts
const relay = createRelay({
  publicHost: "turn.example.com", // DNS only, pointing at this server
  relayIp: "203.0.113.7", // the server's public IPv4
});
```

Several mirror domains, each with its own `turn.` name, so visitors get the
one for the domain they're on (`www.mirror2.net` gets `turn.mirror2.net`):

```ts
const relay = createRelay({
  publicHost: (host) => "turn." + host.replace(/^www\./, ""),
  relayIp: "203.0.113.7",
});
```

For each TURN name:

- Add the DNS-only record and a normal certificate for it (Let's Encrypt is
  fine; a CDN origin certificate isn't trusted by browsers).
- Get its TLS to the relay. With `attach()`, your Node server must answer TLS
  for the name. If nginx owns 443, use the [nginx](#nginx-optional) stream
  config and route by name only (see the comment on its no-ALPN line); its
  `turn.` rule and per-name certificate lookup cover every mirror.

The DNS-only name reveals the server's IP. To keep the site's origin
hidden, run the relay on a separate server: `spawn: false` and a shared
`secret` in the site's Node, and `turn.` pointing at the relay's box.

## Using it in your own WebRTC app

Fetch credentials from your server and pass them to the peer connection:

```js
const ice = await (await fetch("/dlpcc/ice")).json();
const pc = new RTCPeerConnection(ice); // { iceServers, iceTransportPolicy: "relay" }
```

Check `res.ok` before using it: past `rateLimit` the endpoint answers 429 with
a `Retry-After` header, and a peer connection built from that body just fails
to connect.

Or mint them server side with `relay.iceConfig(req)` and send them along with
your own signalling. `forceRelay: false` drops `iceTransportPolicy: "relay"`,
so peers that can reach each other directly still do, and the relay is only
the fallback.

If you can't change the code that creates the connections, load
`/dlpcc/client.js` with a plain `<script>` before it runs; it patches
`RTCPeerConnection` in that window.

## Using it in a Scramjet proxy

For sites built on the Scramjet alpha (`@mercuryworkshop/scramjet` 2.0.x with
`@mercuryworkshop/scramjet-controller`). `DlpccPlugin` is a `ManagedPlugin`
like the ones in `@mercuryworkshop/scramjet-utils`, so it goes in the same
`plugins` list.

1. Do the [server setup](#server-setup) on the server that serves your proxy
   and Wisp.
2. Load the patch in your proxy page, alongside Scramjet and the controller:
   ```html
   <script src="/dlpcc/client.js"></script>
   <script src="/scramjet/scramjet.js"></script>
   <script src="/controller/controller.api.js"></script>
   ```
3. Add the plugin to each frame. Like `scramjet-utils`, import it after the
   controller has loaded:
   ```js
   import { DlpccPlugin } from "dlpcc/scramjet";

   const frame = controller.createFrame(iframe, {
     plugins: [
       new DlpccPlugin({ enabled: () => settings.webrtcRelay }),
       // ...your other plugins
     ],
   });
   ```
   Without a bundler, map the imports instead:
   ```html
   <script type="importmap">
     { "imports": {
         "@mercuryworkshop/scramjet-controller": "/controller/controller-external.mjs",
         "dlpcc/scramjet": "/path/to/dlpcc/src/scramjet.js" } }
   </script>
   ```

`enabled` is read as each proxied page loads, so it can back a user setting:
toggling it applies from the next page load. Nested frames are covered too.

The plugin also works around a Scramjet bug, with the relay on or off: the
controller can deliver a proxied WebSocket's first message before its `open`
event, and clients that subscribe in `onopen` (LiveKit, and with it a lot of
calling apps) miss it and never finish signalling.

To check it's working, open `chrome://webrtc-internals` during a call or
stream. Every local candidate should be a `relay` one, or a `prflx` one whose
URL is your TURN server.

## Options

Every option can also be set by environment variable, named like the relay's own: `DLPCC_` plus the option in SNAKE_CASE (`rateLimit` → `DLPCC_RATE_LIMIT`), lists comma separated, booleans `1`/`true`/`0`/`false`. Options passed to `createRelay()` win over the environment, which wins over the defaults below.

| Option | Default | |
|---|---|---|
| `enabled` | `true` | Master switch. When false nothing is spawned, `routeRequest` passes everything through and `clientScript` returns `""`, so call sites can stay. |
| `secret` | random per run | Signs credentials; passed to the relay. Required with `spawn: false`. |
| `relayIp` | detected | Public IPv4 advertised for relayed media. |
| `hosts` | any | Only issue credentials when the visitor used one of these hostnames. `*.example.com` ok. Rarely needed. |
| `ttl` | `43200` | Credential lifetime in seconds. Must outlive a session. |
| `rateLimit` | `30` | Requests per minute per client IP on the dlpcc endpoints, 429 past the burst. 0 disables. |
| `rateLimitBurst` | `10` | How many requests one client IP may spend at once. |
| `rateLimitGlobal` | off | Requests per minute across all visitors combined. Its burst is one minute's worth. 0 disables. |
| `forceRelay` | `true` | Set `iceTransportPolicy: "relay"`. |
| `allowPeers` | any public | Only relay to these CIDRs, e.g. a provider's ranges. |
| `denyPeers` | | Extra CIDRs to block. |
| `allowPrivatePeers` | `false` | Lift the private-network block. Testing only. |
| `maxAllocsPerUser` | `8` | Concurrent relays per credential, 0 for no limit. |
| `maxAllocs` | `1000` | Concurrent relays in total, 0 for no limit. |
| `relayPorts` | `49152-65535` | UDP range for relayed media. |
| `turnListen` | a free port once attached, else `127.0.0.1:3478` | The relay's own TCP listener on loopback. Only matters with nginx. |
| `publicHost` | visitor's host | Host in TURN URLs. Only for sites behind a CDN; see above. |
| `publicPort` | visitor's port | Port in the TURN URLs browsers get (`443` without `attach`). |
| `tls` | visitor's scheme | `turns:` or `turn:` URLs (`turns:` without `attach`). |
| `basePath` | `/dlpcc` | Prefix for `routeRequest`. |
| `spawn` | `true` | `false` in all but one process when several share a relay. |
| `binary` | bundled | Path to your own `dlpcc-relay` build. |
| `logLevel` | `warn` | error, warn, info, debug, trace. |

## nginx (optional)

Use this instead of `attach()` when nginx already owns 443 for several sites
and you'd rather not route TLS through Node. nginx peeks at each TLS
ClientHello: browsers offer ALPN for page loads and their TURN client
doesn't, so both share 443 and your existing certificates. You need nginx
with the `stream` and `ssl_preread` modules (Debian and Ubuntu's `nginx`
package has them) and a public IPv4.

1. Copy `nginx/dlpcc-stream.conf` to `/etc/nginx/` and include it at the top
   level of `nginx.conf`, outside `http {}`. If your cert directories aren't
   named after the hostname (wildcards, multi-domain certs), add lines to
   its `$dlpcc_cert_dir` map.
2. Change every site that has `listen 443 ssl` to the following.
   `nginx/site-example.conf` shows a full site, including a rate limit on
   `/dlpcc/`.
   ```nginx
   listen 127.0.0.1:8443 ssl proxy_protocol;
   set_real_ip_from 127.0.0.1;
   real_ip_header proxy_protocol;
   ```
3. Don't call `relay.attach()`. The relay then listens on `127.0.0.1:3478`,
   where the stream config sends TURN.
4. Open UDP `49152-65535` in and out for relayed media. Keep 3478, 5349 and
   8443 closed; they're loopback only.
5. `nginx -t && systemctl reload nginx`, start your app, then
   `curl https://example.com/dlpcc/ice` should return a
   `turns:example.com:443?transport=tcp` URL.

## Demo

`demo/` is a [Chemical](https://chemicaljs.github.io/) proxy (Scramjet alpha
over Wisp) with `DlpccPlugin` wired in, plus a lab plugin for testing:

```sh
npm install && npm run build      # in the repo root, builds the wrapper
npm run build:bins                # the relay for this machine; needs Go 1.25+
cd demo && npm install && npm start
```

Open `http://localhost:8080`. **Block UDP** makes proxied pages behave as on
a network that drops UDP (only TURN over TCP or TLS gets through), and
**DLPCC** switches the plugin on and off so you can compare. The live monitor
shows each connection's path. Try the data channel test with Block UDP on: it
fails with DLPCC off and connects through the relay with it on.

Environment: `PORT`; `TLS_CERT` and `TLS_KEY` for https, and with it `turns:`
on the same port; and `DLPCC_NGINX=1` when nginx owns 443. Every other
option is a `DLPCC_*` variable (see [Options](#options)): `DLPCC_SECRET`,
`DLPCC_RELAY_IP`, `DLPCC_HOSTS`, `DLPCC_LOG_LEVEL`,
`DLPCC_ALLOW_PRIVATE_PEERS=1` and so on. The demo also runs stricter than
the library defaults, so a public instance can't be farmed as a free relay:
minting is capped at 120 requests/min across all visitors (30/min per IP),
and at most 100 connections relay at once. Tune those with
`DLPCC_RATE_LIMIT`, `DLPCC_RATE_LIMIT_BURST`, `DLPCC_RATE_LIMIT_GLOBAL` and
`DLPCC_MAX_ALLOCS`. On your own machine your connection still needs UDP to reach
the service, so the real test is the demo on a server, opened from a network
that blocks UDP.

### In a Codespace

The button at the top creates a Codespace that builds everything and starts
the demo on port 8080; the first start takes a few minutes. Then open it on
**localhost**, not the `app.github.dev` link:

- In VS Code desktop (**Open in VS Code** from the Codespace), port 8080 is
  forwarded to your machine; open `http://localhost:8080`.
- From a terminal: `gh codespace ports forward 8080:8080`, then open
  `http://localhost:8080`.

The `app.github.dev` link loads the page and proxies sites, but it only
passes HTTP, so the browser's TURN connection can't reach the relay through
it; the page says so if you open it that way. Forwarding to localhost
carries plain TCP, which TURN needs.

This is also a real test of the bypass: your browser only talks TCP to
GitHub, and the relay sends the UDP from the Codespace. So it works from a
network that blocks UDP, with GitHub's cloud as the server.

## Deploy with Docker

The Docker image builds and runs the included demo app and its Go relay.
Build it from the repository root:

```sh
docker build -t dlpcc-demo .
docker run --name dlpcc-demo --restart unless-stopped --network host \
  -e DLPCC_RELAY_IP=YOUR_SERVER_PUBLIC_IPV4 \
  -e DLPCC_SECRET=YOUR_LONG_RANDOM_SECRET \
  dlpcc-demo
```

Use `--network host` on Linux. Publishing the whole UDP range with `-p`
makes Docker start a proxy per port, which is slow and memory hungry. If you
can't use host networking, narrow the range with `DLPCC_RELAY_PORTS` and
publish only that, for example
`-e DLPCC_RELAY_PORTS=50000-50100 -p 8080:8080 -p 50000-50100:50000-50100/udp`.

Set `DLPCC_RELAY_IP` to the server's public IPv4 address; a container usually
detects its private interface address instead. Keep `DLPCC_SECRET` private
and use a different random value for each deployment. Since the image runs
the demo, `/dlpcc/` is rate limited out of the box — 30 requests/min per
client IP, 120/min across all visitors, and at most 100 concurrent relays —
so a public instance can't be farmed; the `DLPCC_*` variables tune all of
it. Visit
`http://YOUR_SERVER:8080`, or put the container behind a TLS-terminating
reverse proxy and forward website traffic to port 8080. For TURN over TLS,
the relay also needs the public TLS connection (for example, TLS passthrough
to the container or a certificate configured with `TLS_CERT` and `TLS_KEY`);
a regular HTTP reverse proxy alone cannot forward TURN.

For Oracle Cloud, allow inbound TCP 8080 and UDP ports 49152-65535 in both the
instance firewall and the VCN security rules. Restrict TCP 8080 to your
reverse proxy or use a TLS proxy in front of it. The same UDP range must be
reachable on the public IP for browser TURN media to work. Some managed
container platforms (including plans that only expose HTTP/TCP) do not allow
publishing that UDP range; the web app may load there, but TURN will not work
unless the platform supports it.

## Security

Anyone who can load the client script can read the credential out of it.
That's how browser TURN works, so assume visitors can use the relay as a UDP
forwarder until their credential expires. What keeps that in check:

- Private, loopback, link-local, CGNAT and multicast ranges are always
  blocked as relay targets, as is the relay's own IP, so it can't reach your
  internal network.
- `allowPeers` limits relaying to networks you choose. It's the tightest
  option if you only care about one service.
- Credentials expire (`ttl`) and each holds at most `maxAllocsPerUser`
  relays, with `maxAllocs` as a global cap.
- Only hand out credentials to visitors you'd let use the site anyway: put
  `routeRequest` behind your existing session check. `/dlpcc/` is rate
  limited out of the box (`rateLimit`, 30/min per client IP, burst 10,
  a 429 with `Retry-After` past that). Behind a reverse proxy, set your
  framework's trust proxy so the limit applies per visitor instead of to the
  proxy itself (Express: `app.set("trust proxy", 1)`), and keep the
  `limit_req` in `nginx/site-example.conf` as a second layer. The buckets
  live in the Node process, so cluster workers each keep their own, and a
  visitor who can rotate addresses walks past the per-IP one — on a public
  box, `rateLimitGlobal` is the setting that still holds.
- `hosts` stops credentials being issued for hostnames you don't own.

The secret stays on the server and goes to the relay as an environment
variable, not an argument. If it leaks, change it and restart; old
credentials stop working right away.

## Known limits

- With nginx, routing on "no ALPN means TURN" matches how Chromium behaves
  today. If a browser starts sending ALPN for TURN over TLS, those
  connections will hit the website instead. The commented-out stream log in
  `dlpcc-stream.conf` shows what's arriving. `attach()` doesn't depend on
  this: it looks at the bytes after TLS.
- Filters that fingerprint TLS can still tell a long TURN session from
  normal browsing. This gets you past "block UDP" and "block known hosts",
  not every DPI box.
- Everything is relayed over TCP, so a bad connection hurts more than it
  would on UDP. Fine for most streaming, noticeable on lossy wifi.
- Tested end to end with WebRTC data channels and LiveKit rooms (real
  media to LiveKit Cloud) through Scramjet. GeForce NOW and Discord voice
  need accounts and haven't been run through it yet. Whether a service
  accepts relay-only candidates is up to that service.

## Development

```sh
npm install
npm run build:bins   # cross-compiles bin/<platform>-<arch>/, needs Go 1.25+
npm test             # go test ./relay, builds, then the Node tests
```

`npm pack` and `npm publish` run both builds. Set `GO` if `go` isn't on
PATH, or `DLPCC_TARGETS=linux-x64` to build one platform.

CI (`.github/workflows/build.yml`) runs the tests and builds every binary on
each push and pull request; they're downloadable as the `dlpcc-relay`
artifact. Pushing a `v*` tag that matches `package.json`'s version publishes
to npm — with trusted publishing, so there's no token: on npmjs.com, add
this repository, the `build.yml` workflow and the `release` environment as
the package's trusted publisher (the package has to exist for that, so the
first publish is a manual `npm publish`) — and attaches the binaries to a
GitHub release.

## License

AGPL-3.0. See [LICENSE](LICENSE).
