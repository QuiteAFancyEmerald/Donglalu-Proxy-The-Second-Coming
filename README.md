# Donglalu Proxy The Second Coming (DLPCC)

Keep WebRTC working behind the filter. DLPCC is a TURN relay that shares your
proxy site's HTTPS port, so game streaming, video calls and anything else built
on `RTCPeerConnection` keep running on networks that block UDP. The stream
leaves over 443 on the same hostname as the rest of your site.

Scramjet and Wisp tunnel `fetch`, XHR and WebSockets, but a page's
`RTCPeerConnection` sends its media over UDP straight from the browser, where
the proxy can't touch it. DLPCC rewrites every peer connection in proxied pages
to use one TURN server, `turns:<your host>:443`, with relay-only transport. The
browser then sends all media to that server inside TLS, and the relay forwards
it as UDP from your server.

## How it fits together

```
browser ──TLS :443──> nginx ─┬─ ALPN offered (page loads, wisp) ──> your Node app
                             └─ no ALPN (browser TURN client) ──> dlpcc-relay ──UDP──> e.g. GeForce NOW
```

- **nginx** peeks at each TLS ClientHello. Browsers offer ALPN for page loads;
  their TURN client doesn't. So both share 443 and your existing certificate,
  on every mirror, with no extra DNS records.
- **The Node wrapper** (`dlpcc` on npm) spawns the relay, signs short-lived
  TURN credentials for whichever hostname the visitor used, and serves the
  browser patch at `/dlpcc/client.js`.
- **The relay** is a Go TURN server shipped prebuilt in the package. It checks
  credentials against the shared secret and refuses to relay to private
  networks.
- **The patch** wraps `RTCPeerConnection` so every connection uses the relay,
  whatever ICE servers the site asks for.

## Layout

```
relay/    Go TURN relay (dlpcc-relay)
src/      Node wrapper and the browser patch (client.js)
nginx/    stream config for 443 and an example site
demo/     Chemical (Scramjet) proxy with DLPCC wired in
scripts/  cross-compiles the relay into bin/ for the npm package
test/     Node tests
```

## Using it

```sh
npm install dlpcc
```

```ts
import { createServer } from "node:http";
import { createRelay } from "dlpcc";

const relay = createRelay({
  secret: process.env.DLPCC_SECRET!, // openssl rand -hex 32
  relayIp: process.env.DLPCC_RELAY_IP, // the server's public IPv4
  hosts: ["example.com", "*.example2.com"],
});
await relay.start();

const server = createServer((req, res) => {
  if (relay.routeRequest(req, res)) return; // /dlpcc/ice, /dlpcc/client.js
  // ...your app
});
server.on("upgrade", (req, socket, head) => {
  // wisp as usual
});
process.on("SIGTERM", () => relay.stop());
```

The package ships `dlpcc-relay` for Linux, macOS and Windows on x64 and arm64,
so no Go toolchain is needed. The wrapper restarts the relay if it crashes.
With `enabled: false` nothing is spawned, `routeRequest` passes everything
through and `clientScript` returns `""`, so call sites can stay in place.

### Getting the patch into proxied pages

The patch has to run inside each proxied window **before** the site's own
scripts. Load `/dlpcc/client.js` in your proxy's own page (where the Scramjet
controller runs), then patch each proxied window as Scramjet creates it:

```js
import { ManagedPlugin } from "@mercuryworkshop/scramjet-controller";

export class DlpccPlugin extends ManagedPlugin {
  constructor() {
    super("dlpcc", []);
  }
  install(frame) {
    super.install(frame);
    // Fires from Scramjet's injected head script, before the site's scripts,
    // for nested frames too.
    this.tap(frame.hooks.init.post, (ctx) => window.__dlpcc?.patch(ctx.window));
  }
}

controller.createFrame(iframe, { plugins: [new DlpccPlugin()] });
```

To inline the patch instead of loading it by URL, use
`relay.clientScript(host)`. It's already escaped for a `<script>` tag.

To check it's working, open `chrome://webrtc-internals` during a call or
stream. The selected candidate pair should be `relay` with protocol `tls`.

### Options

| Option | Default | |
|---|---|---|
| `secret` | | Signs credentials; passed to the relay. Required when enabled. |
| `relayIp` | | Public IPv4 advertised for relayed media. Required to spawn. |
| `enabled` | `true` | Master switch. |
| `hosts` | any | Hostnames credentials are issued for. `*.example.com` ok. |
| `ttl` | `43200` | Credential lifetime in seconds. Must outlive a session. |
| `allowPeers` | any public | Only relay to these CIDRs, e.g. a provider's ranges. |
| `denyPeers` | | Extra CIDRs to block. |
| `maxAllocsPerUser` | `8` | Concurrent relays per credential, 0 for no limit. |
| `maxAllocs` | `1000` | Concurrent relays in total, 0 for no limit. |
| `relayPorts` | `49152-65535` | UDP range for relayed media. |
| `turnListen` | `127.0.0.1:3478` | Where nginx sends decrypted TURN. |
| `publicPort` | `443` | Port in the TURN URLs browsers get. |
| `tls` | `true` | `false` hands out `turn:` URLs straight to the relay, for testing without nginx. |
| `forceRelay` | `true` | Set `iceTransportPolicy: "relay"`. |
| `basePath` | `/dlpcc` | Prefix for `routeRequest`. |
| `spawn` | `true` | `false` in all but one process when several share a relay. |
| `binary` | bundled | Path to your own `dlpcc-relay` build. |
| `logLevel` | `warn` | error, warn, info, debug, trace. |

## nginx

You need nginx with the `stream` and `ssl_preread` modules (Debian and
Ubuntu's `nginx` package has them), a public IPv4, and the certificates your
sites already use.

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
3. Open UDP `49152-65535` in and out for relayed media. TCP 443 is already
   open. Keep 3478, 5349 and 8443 closed; they're loopback only.
4. `nginx -t && systemctl reload nginx`, start your app, then
   `curl https://example.com/dlpcc/ice` should return a
   `turns:example.com:443?transport=tcp` URL.

## Demo: Chemical + GeForce NOW

`demo/` is a [Chemical](https://chemicaljs.github.io/) proxy (Scramjet over
Wisp) with DLPCC wired in through the plugin above. It opens
`play.geforcenow.com`.

```sh
npm install && npm run build      # in the repo root, builds the wrapper
npm run build:bins                # needs Go 1.25+
cd demo && npm install
DLPCC_SECRET=$(openssl rand -hex 32) DLPCC_RELAY_IP=<public ip> npm start
```

On a server behind the nginx setup above, that's the real test: on a network
that blocks UDP, GeForce NOW should still stream, with the selected candidate
pair in `chrome://webrtc-internals` showing `relay` over `tls`.

To try it on your own machine without nginx, add `DLPCC_LOCAL=1` and open
`http://localhost:8080`. Browsers then reach the relay directly on
`turn:localhost:3478`. That doesn't get past a UDP block, since your machine
still needs UDP to reach the service. What it does show is whether a site
works with relay-only connections before you deploy.

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
- Only hand out credentials to visitors you'd let use the proxy anyway: put
  `routeRequest` behind your existing session check, and keep the nginx rate
  limit on `/dlpcc/`.
- `hosts` stops credentials being issued for hostnames you don't own.

The secret stays on the server and goes to the relay as an environment
variable, not an argument. If it leaks, change it and restart; old
credentials stop working right away.

## Known limits

- Routing on "no ALPN means TURN" matches how Chromium behaves today
  (checked with Chromium through `nginx/dlpcc-stream.conf`). If a browser
  starts sending ALPN for TURN over TLS, those connections will hit the
  website instead. The commented-out stream log in `dlpcc-stream.conf`
  shows what's arriving.
- Filters that fingerprint TLS can still tell a long TURN session from
  normal browsing. This gets you past "block UDP" and "block known hosts",
  not every DPI box.
- Everything is relayed over TCP, so a bad connection hurts more than it
  would on UDP. Fine for most streaming, noticeable on lossy wifi.
- Not yet tested against GeForce NOW itself; the demo is how to test it.
  Whether a service accepts relay-only candidates is up to that service.

## Development

```sh
npm install
npm run build:bins   # cross-compiles bin/<platform>-<arch>/, needs Go 1.25+
npm test             # go test ./relay, builds, then the Node tests
```

`npm pack` and `npm publish` run both builds. Set `GO` if `go` isn't on
PATH, or `DLPCC_TARGETS=linux-x64` to build one platform.

## License

AGPL-3.0. See [LICENSE](LICENSE).
