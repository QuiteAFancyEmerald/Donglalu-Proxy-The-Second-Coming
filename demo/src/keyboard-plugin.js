import { ManagedPlugin } from "@mercuryworkshop/scramjet-controller";

// Keyboard Lock (navigator.keyboard.lock) only works in the top window, and a
// proxied page runs in an iframe. So a fullscreen game like GeForce NOW can't
// keep Escape for itself: every tap leaves fullscreen instead of reaching the
// game. This forwards the proxied page's lock and unlock to the top window,
// and holds Escape in any proxied fullscreen, so a tap goes to the page and
// leaving takes Chrome's "press and hold Esc", as it would unproxied.
export class KeyboardLockPlugin extends ManagedPlugin {
  constructor() {
    super("keyboard-lock", []);
    this.siteLocked = false;
  }

  install(frame) {
    super.install(frame);
    this.tap(frame.hooks.init.post, (ctx) => this.forward(ctx.window));
    document.addEventListener("fullscreenchange", () => {
      const keyboard = navigator.keyboard;
      if (!keyboard) return;
      if (!document.fullscreenElement) {
        this.siteLocked = false;
        keyboard.unlock();
      } else if (!this.siteLocked) {
        // The site didn't ask for a lock of its own; hold Escape anyway.
        keyboard.lock(["Escape"]).catch(() => {});
      }
    });
  }

  forward(win) {
    const inner = win?.navigator?.keyboard;
    const top = navigator.keyboard;
    if (!inner || !top || inner === top) return;
    const plugin = this;
    Object.defineProperties(inner, {
      lock: {
        configurable: true,
        value(keys) {
          plugin.siteLocked = true;
          return top.lock(keys);
        },
      },
      unlock: {
        configurable: true,
        value() {
          plugin.siteLocked = false;
          top.unlock();
        },
      },
    });
  }
}
