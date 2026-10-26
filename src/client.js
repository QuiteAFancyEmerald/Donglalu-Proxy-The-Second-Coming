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

  // Scramjet's controller sends a proxied WebSocket's "open" and its frames
  // over different MessagePorts, so the server's first frame can arrive
  // before "open". Clients that subscribe in onopen (LiveKit, among others)
  // then miss it, and with it the signalling that sets up the call. This holds
  // early message and close events back until "open" has been dispatched.
  // Native WebSockets never deliver a frame before "open", so for them it
  // changes nothing. Safe to repeat.
  function fixWebSocket(win) {
    var Inner = win && win.WebSocket;
    if (!Inner || Inner.__dlpcc) return false;

    // Listeners can be handed a wrapped event that dispatchEvent rejects, so
    // held events are replayed as copies.
    function copy(e) {
      if (e.type === "close") {
        return new win.CloseEvent("close", { code: e.code, reason: e.reason, wasClean: e.wasClean });
      }
      return new win.MessageEvent("message", { data: e.data, origin: e.origin, lastEventId: e.lastEventId });
    }

    function gate(ws) {
      var opened = false;
      var held = [];
      var handlers = {};

      // The page's onmessage/onclose run from these listeners, which are the
      // first registered, so they can be held back with everything else.
      ["message", "close"].forEach(function (type) {
        Object.defineProperty(ws, "on" + type, {
          configurable: true,
          enumerable: true,
          get: function () { return handlers[type] || null; },
          set: function (fn) { handlers[type] = typeof fn === "function" ? fn : null; },
        });
        ws.addEventListener(type, function (e) {
          if (!opened) {
            e.stopImmediatePropagation();
            held.push(copy(e));
            return;
          }
          if (handlers[type]) handlers[type].call(ws, e);
        });
      });

      function release() {
        opened = true;
        // After the rest of the open dispatch, where clients attach handlers.
        Promise.resolve().then(function () {
          var events = held;
          held = [];
          events.forEach(function (e) { ws.dispatchEvent(e); });
        });
      }
      ws.addEventListener("open", release);
      // A failed connection never opens; let its close through.
      ws.addEventListener("error", function () {
        if (opened) return;
        held = held.filter(function (e) { return e.type === "close"; });
        release();
      });
    }

    function WebSocket() {
      var ws = Reflect.construct(Inner, arguments, new.target || WebSocket);
      gate(ws);
      return ws;
    }
    WebSocket.prototype = Inner.prototype;
    Object.setPrototypeOf(WebSocket, Inner);
    Object.defineProperty(WebSocket, "__dlpcc", { value: true });
    win.WebSocket = WebSocket;
    return true;
  }

  // Patch a window (or a same-origin frame's contentWindow). Safe to repeat.
  function patch(win) {
    fixWebSocket(win);
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
  Object.defineProperty(window, "__dlpcc", { value: { config: config, patch: patch, fixWebSocket: fixWebSocket } });
})(/*__DLPCC_CONFIG__*/null);
