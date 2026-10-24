import { ManagedPlugin } from "@mercuryworkshop/scramjet-controller";

// Patches RTCPeerConnection in every proxied window, nested frames included.
// init.post fires from Scramjet's injected head script, so this runs before
// any of the site's own scripts. window.__dlpcc comes from /dlpcc/client.js.
export class DlpccPlugin extends ManagedPlugin {
  constructor() {
    super("dlpcc", []);
  }

  install(frame) {
    super.install(frame);
    this.tap(frame.hooks.init.post, (ctx) => {
      window.__dlpcc?.patch(ctx.window);
    });
  }
}
