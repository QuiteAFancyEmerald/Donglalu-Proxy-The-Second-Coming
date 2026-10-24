# Donglalu Proxy The Second Coming (DLPCC)

WebRTC that gets through the filter. DLPCC is a TURN relay that hides behind
your proxy site's HTTPS port, so game streaming, video calls and anything else
built on `RTCPeerConnection` keep working on networks that block UDP. Run it
next to your own unblocker and the media goes out over 443 like everything else.

Built for Scramjet/Wisp style proxies, where page traffic is already tunneled
but WebRTC isn't.

## Why this exists

Scramjet + Wisp handles `fetch`, XHR and WebSockets, because those go through
JavaScript the proxy can rewrite. `RTCPeerConnection` doesn't. Once a page
makes one, the browser's own network stack sends ICE/DTLS/SRTP over UDP
straight to the remote server. The proxy never sees those packets, the filter
blocks the UDP, and you get a black screen after signaling works fine.
GeForce NOW is the usual example.

Browsers already have a fallback for this: TURN over TLS. If the only ICE
server is a `turns:` URL on port 443 and the transport policy is `relay`, the
browser sends all media to that server inside a TLS connection, and the server
forwards it on as UDP from its side. DLPCC is that server, plus the pieces that
make it fit a proxy setup:

- **Same host, same cert.** nginx splits port 443 by peeking at the TLS
  handshake: page loads offer ALPN, the browser's TURN client doesn't. So
  `turns:example.com:443` works on every mirror with the certificate you
  already have. No `turn.` subdomains, no extra DNS records.
- **Any host.** Credentials and the TURN URL come from whatever hostname the
  visitor used, so one relay serves a pile of mirrors.
- **A client patch.** A small script wraps `RTCPeerConnection` in the proxied
  page so it uses the relay no matter what ICE servers the site asks for.
- **Short-lived credentials.** The relay never stores users. Your server signs
  a credential with a shared secret (the standard TURN REST scheme), the relay
  checks the signature and the expiry.

## Why not just use Wisp for this?

Wisp does have UDP streams, but the browser's WebRTC stack can't use them.
Its ICE agent only talks to TURN servers over UDP, TCP or TLS, and there's no
API to give it a WebSocket. Getting media through Wisp would mean rebuilding
WebRTC in JS/WASM. So the two run next to each other: same box, same port 443,
same hostnames, Wisp for page traffic and DLPCC for media.

## Pieces

```
cmd/dlpcc-relay/      the Go relay binary
internal/relay/       TURN server, credentials, peer filter, HTTP endpoints
web/client.js         the browser patch (embedded in the binary)
node/                 npm package for Node/TS apps
deploy/nginx/         stream config for 443 + an example site
deploy/systemd/       unit file and env example
```

## Setup with nginx

You need nginx with the stream and ssl_preread modules, Go 1.25+, a public
IPv4, and one certificate per mirror domain (which you already have if the
site is on HTTPS). A wildcard cert covering several mirrors works too.

**1. Build and install the relay**

```sh
go build -o dlpcc-relay ./cmd/dlpcc-relay
sudo install dlpcc-relay /usr/local/bin/
```

or `go install github.com/QuiteAFancyEmerald/DLPCC/cmd/dlpcc-relay@latest`.

**2. Configure it**

```sh
sudo mkdir -p /etc/dlpcc
sudo cp deploy/systemd/relay.env.example /etc/dlpcc/relay.env
sudo chmod 600 /etc/dlpcc/relay.env
openssl rand -hex 32   # put this in DLPCC_SECRET
```

Set `DLPCC_RELAY_IP` to the server's public IPv4. If you're behind a cloud
NAT, that's the public address and `DLPCC_RELAY_BIND` stays `0.0.0.0`.

**3. Open the firewall**

TCP 443 in, which you already have, and UDP `49152-65535` in and out for
relayed media. Don't expose 3478, 5349 or 8090; they're loopback only.

**4. Hand port 443 to the stream block**

Copy `deploy/nginx/dlpcc-stream.conf` to `/etc/nginx/` and include it at the
top level of `nginx.conf`, outside `http {}`. Then change every site that
currently has `listen 443 ssl` to:

```nginx
listen 127.0.0.1:8443 ssl proxy_protocol;
set_real_ip_from 127.0.0.1;
real_ip_header proxy_protocol;
```

`deploy/nginx/site-example.conf` shows a full site. If your cert directories
don't match the hostname (wildcards, multi-domain certs), add lines to the
`$dlpcc_cert_dir` map.

**5. Start it**

```sh
sudo cp deploy/systemd/dlpcc-relay.service /etc/systemd/system/
sudo systemctl enable --now dlpcc-relay
sudo nginx -t && sudo systemctl reload nginx
curl https://example.com/dlpcc/ice
```

That should return JSON with a `turns:example.com:443?transport=tcp` URL.

**6. Load the patch in proxied pages**

`/dlpcc/client.js` returns the patch with a fresh credential baked in. It
has to run inside the proxied page's window **before** the site's own
scripts, so it needs to go through your proxy's script injection, not into
your homepage. With Scramjet that means injecting it into rewritten HTML
ahead of the site's scripts; the details depend on your version. Since the
patch is served from your own origin rather than the proxied site's, make
sure the proxy doesn't rewrite its URL.

To check it's working, open `chrome://webrtc-internals` while streaming. The
selected candidate pair should be `relay` with protocol `tls`.

## Using it from Node (invisiproxy etc.)

```sh
cd node && npm install && npm run build
```

```ts
import { createServer } from "node:http";
import { createRelay } from "dlpcc";

const relay = createRelay({
  enabled: process.env.DLPCC_ENABLED !== "false",
  secret: process.env.DLPCC_SECRET!,
  relayIp: process.env.DLPCC_RELAY_IP,
  // spawn: false,  // if dlpcc-relay already runs under systemd
});
await relay.start();

const server = createServer((req, res) => {
  if (relay.routeRequest(req, res)) return; // /dlpcc/ice, /dlpcc/client.js
  // ...your app
});
server.on("upgrade", (req, socket, head) => {
  // wisp.routeRequest(req, socket, head) as usual
});
```

The wrapper spawns `dlpcc-relay` with your settings, restarts it if it
crashes, and mints credentials in-process, so the relay's own HTTP listener
is switched off. If you'd rather inline the patch when rendering HTML, use
`relay.clientScript(host)`. It's already escaped for a `<script>` tag.

With `enabled: false` nothing is spawned, `routeRequest` passes every
request through and `clientScript` returns an empty string, so you can leave
the call sites in place and turn the feature off from config.

You still need the nginx stream setup above. The Node app only serves the
endpoints; TURN traffic goes nginx → relay directly.

## Security

Anyone who can load the client script can read the credential out of it.
That's how browser TURN works, so assume visitors can use the relay as a UDP
forwarder until their credential expires. What keeps that under control:

- Private, loopback, link-local, CGNAT and multicast ranges are always
  blocked as relay targets, so the relay can't reach your internal network.
  The relay's own IP is blocked too.
- `DLPCC_ALLOW_PEERS` limits relaying to networks you choose, for example
  your streaming provider's published ranges. Tightest option if you only
  care about one service.
- Credentials expire (`DLPCC_TTL`, 12h by default) and each one can hold
  `DLPCC_MAX_ALLOCS_PER_USER` relays at once, with a global cap on top.
- Only hand out credentials to visitors you'd let use the proxy anyway. In
  Node that means putting `routeRequest` behind whatever session check you
  already have. In nginx, the example site rate-limits `/dlpcc/`.
- `DLPCC_HOSTS` stops credentials being issued for hostnames you don't own.

The secret never leaves the server. If it leaks, change it and restart; old
credentials stop working right away.

## Configuration

Every flag also reads `DLPCC_<NAME>` from the environment.

| Flag | Default | |
|---|---|---|
| `-secret` | | Signing secret. Required. |
| `-relay-ip` | | Public IPv4 for relay candidates. Required. |
| `-relay-bind` | `0.0.0.0` | Where relay sockets bind. |
| `-relay-ports` | `49152-65535` | UDP range for relay sockets. |
| `-turn-listen` | `127.0.0.1:3478` | Plain TCP TURN, fed by nginx. |
| `-http-listen` | `127.0.0.1:8090` | `/dlpcc/*` endpoints. Empty disables. |
| `-public-port` | `443` | Port in `turns:` URLs. |
| `-hosts` | any | Allowed hostnames, `*.example.com` ok. |
| `-ttl` | `12h` | Credential lifetime. |
| `-force-relay` | `true` | Send `iceTransportPolicy: relay`. |
| `-allow-peers` | | Only relay to these CIDRs. |
| `-deny-peers` | | Extra CIDRs to block. |
| `-max-allocs-per-user` | `8` | 0 for no limit. |
| `-max-allocs` | `1000` | 0 for no limit. |
| `-log-level` | `warn` | error, warn, info, debug, trace. |

## Known limits

- Routing on "no ALPN means TURN" is based on how Chrome and Firefox behave
  today. If a browser starts sending ALPN for TURN/TLS, those connections
  will hit the website instead. Turn on the stream log in
  `dlpcc-stream.conf` to see what's arriving.
- Filters that fingerprint TLS can still tell a long TURN session from
  normal browsing. This gets you past "block UDP" and "block known
  hosts", not every DPI box out there.
- Everything is relayed over TCP, so a bad connection hurts more than it
  would on UDP. Fine for most streaming, noticeable on lossy wifi.
- Long sessions need a credential that outlives them. The default 12h
  covers almost everything; raise `DLPCC_TTL` if not.
- Not tested end to end against GeForce NOW yet. The relay, credential
  flow and patch are tested; whether a given service accepts relay-only
  candidates is up to that service.

## Development

```sh
go test ./...
cd node && npm run build
```

## License

AGPL-3.0. See [LICENSE](LICENSE).
