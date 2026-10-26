import { ManagedPlugin } from "@mercuryworkshop/scramjet-controller";
import type { Frame } from "@mercuryworkshop/scramjet-controller";

export type DlpccPluginOptions = {
  /** Read as each proxied window loads. Defaults to always on. */
  enabled?: () => boolean;
};

/**
 * Sends every RTCPeerConnection in the frame's proxied windows, nested frames
 * included, through the DLPCC relay. Needs /dlpcc/client.js loaded in the
 * page that runs the controller.
 */
export declare class DlpccPlugin extends ManagedPlugin {
  private options;
  constructor(options?: DlpccPluginOptions);
  install(frame: Frame): void;
}
