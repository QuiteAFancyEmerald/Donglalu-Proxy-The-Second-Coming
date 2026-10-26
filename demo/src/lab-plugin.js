import { ManagedPlugin } from "@mercuryworkshop/scramjet-controller";

// Demo only. Wraps RTCPeerConnection in proxied windows (outside DLPCC's own
// patch, so it sees what the site asked for) to:
//  - simulate a network that drops UDP: connections must be relay-only, through
//    TURN over TCP or TLS. No UDP leaves the browser, which is what DLPCC's
//    relay provides and what a UDP-blocking filter leaves you with.
//  - hand every connection to onConnection, for the live monitor.
export class LabPlugin extends ManagedPlugin {
  constructor({ blockUdp = () => false, onConnection = () => {} } = {}) {
    super("dlpcc-lab", []);
    this.blockUdp = blockUdp;
    this.onConnection = onConnection;
  }

  install(frame) {
    super.install(frame);
    this.tap(frame.hooks.init.post, (ctx) => this.wrap(ctx.window));
  }

  wrap(win) {
    const Inner = win?.RTCPeerConnection;
    if (!Inner || Inner.__dlpccLab) return;
    const lab = this;
    function RTCPeerConnection(conf, ...rest) {
      const pc = Reflect.construct(Inner, [lab.blockUdp() ? tcpOnly(conf) : conf, ...rest], new.target || RTCPeerConnection);
      lab.onConnection(pc);
      return pc;
    }
    RTCPeerConnection.prototype = Inner.prototype;
    Object.setPrototypeOf(RTCPeerConnection, Inner);
    Object.defineProperty(RTCPeerConnection, "__dlpccLab", { value: true });

    // Sites like LiveKit hand over their ICE servers later, here. Wraps
    // DLPCC's own setConfiguration patch when that's installed.
    const setConfiguration = Inner.prototype.setConfiguration;
    if (setConfiguration) {
      Inner.prototype.setConfiguration = function (conf) {
        return setConfiguration.call(this, lab.blockUdp() ? tcpOnly(conf) : conf);
      };
    }
    win.RTCPeerConnection = RTCPeerConnection;
    if (win.webkitRTCPeerConnection) win.webkitRTCPeerConnection = RTCPeerConnection;
  }
}

// Relay-only, and only through TURN servers reached over TCP or TLS.
function tcpOnly(conf) {
  const iceServers = (conf?.iceServers ?? [])
    .map((s) => ({ ...s, urls: [].concat(s.urls ?? s.url ?? []).filter((u) => /^turns:|^turn:.*transport=tcp/i.test(u)) }))
    .filter((s) => s.urls.length);
  return { ...conf, iceServers, iceTransportPolicy: "relay" };
}

// One line per connection for the monitor: state, the path media takes and
// how much has moved.
export async function describe(pc) {
  const stats = await pc.getStats();
  let pair;
  stats.forEach((r) => {
    if (r.type === "transport" && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
  });
  pair ??= [...stats.values()].find((r) => r.type === "candidate-pair" && r.nominated && r.state === "succeeded");
  const local = pair && stats.get(pair.localCandidateId);
  const remote = pair && stats.get(pair.remoteCandidateId);
  // A relayed candidate shows up as prflx when the far side sees the relay
  // from behind NAT. Its url still names the TURN server it came from.
  const relayed = local && (local.candidateType === "relay" || /^turns?:/.test(local.url ?? ""));
  return {
    state: pc.connectionState ?? pc.iceConnectionState,
    path: local ? `${relayed ? "relay" : local.candidateType} / ${local.relayProtocol ?? local.protocol}` : null,
    turn: relayed ? local.url : null,
    remote: remote ? `${remote.address ?? "?"}:${remote.port}` : null,
    received: pair?.bytesReceived ?? 0,
    sent: pair?.bytesSent ?? 0,
    rtt: pair?.currentRoundTripTime,
  };
}
