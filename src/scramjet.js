/* DLPCC plugin for the Scramjet controller, written like the plugins in
 * @mercuryworkshop/scramjet-utils. Load the controller before importing it,
 * and /dlpcc/client.js in the same page, which provides window.__dlpcc.
 *
 *   import { DlpccPlugin } from "dlpcc/scramjet";
 *   controller.createFrame(iframe, {
 *     plugins: [new DlpccPlugin({ enabled: () => settings.webrtcRelay })],
 *   });
 */
import { ManagedPlugin } from "@mercuryworkshop/scramjet-controller";

/**
 * Sends every RTCPeerConnection in the frame's proxied windows, nested frames
 * included, through the DLPCC relay. enabled is read as each window loads,
 * so a settings toggle applies from the next page load.
 */
export class DlpccPlugin extends ManagedPlugin {
  constructor(options = {}) {
    super("dlpcc", []);
    this.options = options;
  }

  install(frame) {
    super.install(frame);
    // init.post fires from Scramjet's injected head script, ahead of the
    // site's own scripts.
    this.tap(frame.hooks.init.post, (ctx) => {
      const dlpcc = window.__dlpcc;
      if (!dlpcc) return;
      // Fixes a Scramjet WebSocket bug that breaks signalling, so it stays
      // on with the relay switched off.
      dlpcc.fixWebSocket(ctx.window);
      if (this.options.enabled?.() ?? true) dlpcc.patch(ctx.window);
    });
  }
}
