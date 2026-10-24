/* DLPCC client: sends every RTCPeerConnection's media through the DLPCC TURN
 * relay (TURN over TLS on 443) instead of direct UDP. It must run inside the
 * proxied page's window before the page's own scripts create a connection. */
(function (config) {
  "use strict";
  if (!config || !config.iceServers || typeof window === "undefined") return;

  function rewrite(conf) {
    var out = Object.assign({}, conf || {});
    out.iceServers = config.iceServers;
    if (config.iceTransportPolicy) out.iceTransportPolicy = config.iceTransportPolicy;
    return out;
  }

  // Patch a window (or a same-origin frame's contentWindow). Safe to repeat.
  function patch(win) {
    var Native = win && win.RTCPeerConnection;
    if (!Native || Native.__dlpcc) return false;

    function RTCPeerConnection(conf) {
      var args = Array.prototype.slice.call(arguments);
      args[0] = rewrite(conf);
      return Reflect.construct(Native, args, new.target || RTCPeerConnection);
    }
    RTCPeerConnection.prototype = Native.prototype;
    Object.setPrototypeOf(RTCPeerConnection, Native);
    Object.defineProperty(RTCPeerConnection, "__dlpcc", { value: true });

    var setConfiguration = Native.prototype.setConfiguration;
    if (setConfiguration) {
      Native.prototype.setConfiguration = function (conf) {
        return setConfiguration.call(this, rewrite(conf));
      };
    }

    win.RTCPeerConnection = RTCPeerConnection;
    if (win.webkitRTCPeerConnection) win.webkitRTCPeerConnection = RTCPeerConnection;
    return true;
  }

  patch(window);
  Object.defineProperty(window, "__dlpcc", { value: { config: config, patch: patch } });
})(/*__DLPCC_CONFIG__*/null);
