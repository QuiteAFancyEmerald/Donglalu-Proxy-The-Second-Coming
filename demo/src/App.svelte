<script>
  import Chemical from "chemicaljs/Chemical";
  import { onMount } from "svelte";
  import Bell from "./Bell.svelte";

  let chemical = $state();
  let ready = $state(false);
  let browsing = $state(false);
  // The lab: simulate a UDP-blocking network, and switch DLPCC off to compare.
  let blockUdp = $state(true);
  let dlpccOn = $state(true);
  let connections = $state([]);
  let url = $state("https://play.geforcenow.com/");
  // How Scramjet reaches Wisp. Remembered per browser; epoxy is Chemical's default.
  const TRANSPORTS = [
    { id: "epoxy", label: "Epoxy" },
    { id: "libcurl", label: "libcurl" },
  ];
  let transport = $state(savedTransport());
  let iframe;
  let canvas;
  let backdrop;
  let frame;
  let bells;
  let grid;
  let tracked = [];
  let describe;
  const relay = window.__dlpcc?.config.iceServers[0].urls[0];
  // Codespaces' app.github.dev links pass HTTP only, so TURN can't reach the
  // relay through them; forwarding the port to localhost works.
  const githubDev = location.hostname.endsWith(".app.github.dev");

  const quick = [
    { label: "GeForce NOW", url: "https://play.geforcenow.com/" },
    { label: "Data channel test", url: "https://webrtc.github.io/samples/src/content/datachannel/basic/" },
    { label: "Trickle ICE", url: "https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/" },
  ];

  const features = [
    {
      title: "One port",
      body: "TURN rides the same port as this page. Any host, any mirror, no nginx required: the relay answers wherever the site does.",
    },
    {
      title: "Relay only",
      body: "Every RTCPeerConnection in a proxied page is pointed at the relay with iceTransportPolicy “relay”, so no media tries UDP from the browser.",
    },
    {
      title: "Scramjet plugin",
      body: "A ManagedPlugin patches each proxied window before the site's scripts run, nested frames included. Scramjet handles the page, DLPCC the call.",
    },
  ];

  onMount(() => {
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let disposed = false;
    // three.js is the heaviest part of the page, so it loads on its own.
    import("./bells.js").then(({ createBells }) => {
      if (!disposed) bells = createBells(canvas, { reducedMotion });
    });
    import("./grid.js").then(({ createGrid }) => {
      if (!disposed) grid = createGrid(backdrop, { reducedMotion });
    });
    return () => {
      disposed = true;
      bells?.dispose();
      grid?.dispose();
    };
  });

  async function onready() {
    // Scramjet's controller only loads once Chemical is ready.
    const { DlpccPlugin } = await import("dlpcc/scramjet");
    const lab = await import("./lab-plugin.js");
    const { KeyboardLockPlugin } = await import("./keyboard-plugin.js");
    describe = lab.describe;
    frame = chemical.createFrame(iframe, {
      plugins: [
        new DlpccPlugin({ enabled: () => dlpccOn }),
        new KeyboardLockPlugin(),
        // After the DLPCC plugin, so it wraps the patched constructor and sees what the site asked for.
        new lab.LabPlugin({ blockUdp: () => blockUdp, onConnection: (pc) => tracked.push(pc) }),
        new chemical.plugins.UrlWatcherPlugin((u) => (url = u)),
      ],
    });
  }

  // For the e2e script in the README: the raw connections behind the monitor.
  window.__dlpccDemo = { connections: () => tracked, transport: () => frame?.controller.transport?.constructor.name };

  // Poll the proxied page's connections while it's open.
  $effect(() => {
    if (!browsing) return;
    const id = setInterval(async () => {
      tracked = tracked.filter((pc) => pc.connectionState !== "closed");
      connections = await Promise.all(tracked.map((pc) => describe(pc).catch(() => ({ state: "gone" }))));
    }, 1000);
    return () => clearInterval(id);
  });

  // The patches apply as a window starts, so changing the lab reloads the page.
  function setLab(fn) {
    fn();
    if (browsing) open(url);
  }

  function savedTransport() {
    try {
      const t = localStorage.getItem("dlpcc-demo-transport");
      if (TRANSPORTS.some((x) => x.id === t)) return t;
    } catch {}
    return "epoxy";
  }

  // Chemical swaps the transport in the background; once the controller has
  // the new one, reload the open page so all of it goes through that one.
  function setTransport(t) {
    if (t === transport) return;
    try {
      localStorage.setItem("dlpcc-demo-transport", t);
    } catch {}
    const before = frame?.controller.transport;
    transport = t;
    if (!browsing || !before) return;
    const started = Date.now();
    const wait = setInterval(() => {
      if (frame.controller.transport !== before || Date.now() - started > 15000) {
        clearInterval(wait);
        if (browsing) open(url);
      }
    }, 100);
  }

  const verdict = $derived.by(() => {
    if (!connections.length) return { tone: "idle", text: "No WebRTC on this page yet" };
    const live = connections.find((c) => c.state === "connected");
    if (live) {
      // DLPCC's TURN URLs name this page's own host; a site's own TURN server doesn't.
      const ours = live.turn?.includes(location.host);
      const text = !live.turn
        ? `Connected (${live.path ?? "direct"})`
        : ours
          ? `Connected through the relay (${live.path})`
          : `Connected through the site's own TURN (${live.path})`;
      return { tone: "ok", text };
    }
    // Relay-only with no TCP TURN server has nowhere to go: say so rather than wait for ICE to time out.
    if (blockUdp && !dlpccOn) return { tone: "bad", text: "Blocked: no UDP and no relay" };
    if (connections.some((c) => c.state === "failed")) return { tone: "bad", text: "Connection failed" };
    return { tone: "wait", text: "Connecting…" };
  });

  function size(n) {
    return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} kB`;
  }

  function open(target) {
    if (!frame) return;
    url = /^https?:\/\//.test(target) ? target : "https://" + target;
    tracked = [];
    connections = [];
    frame.go(url);
    bells?.ringAll();
    browsing = true;
    bells?.setActive(false);
    grid?.setActive(false);
  }

  function home() {
    browsing = false;
    bells?.setActive(true);
    grid?.setActive(true);
  }

  function submit(e) {
    e.preventDefault();
    open(url);
  }
</script>

<Chemical bind:this={chemical} bind:ready {transport} {onready} />

{#snippet status()}
  <span class="status" class:off={!relay} title="WebRTC in proxied pages goes through this TURN server">
    {#if relay}
      <span class="dot" aria-hidden="true"></span>{relay}
    {:else}
      <span class="minus" aria-hidden="true"></span>relay off
    {/if}
  </span>
{/snippet}

{#snippet labToggles()}
  <div class="lab" role="group" aria-label="Lab">
    <button type="button" class="toggle" aria-pressed={blockUdp} onclick={() => setLab(() => (blockUdp = !blockUdp))}>
      <span class="sw" aria-hidden="true"></span>Block UDP
    </button>
    <button
      type="button"
      class="toggle"
      aria-pressed={dlpccOn && !!relay}
      disabled={!relay}
      onclick={() => setLab(() => (dlpccOn = !dlpccOn))}
    >
      <span class="sw" aria-hidden="true"></span>DLPCC
    </button>
    <div class="transport" role="radiogroup" aria-label="Wisp transport">
      {#each TRANSPORTS as t}
        <button type="button" role="radio" aria-checked={transport === t.id} onclick={() => setTransport(t.id)}>{t.label}</button>
      {/each}
    </div>
  </div>
{/snippet}

<canvas class="backdrop" bind:this={backdrop} aria-hidden="true"></canvas>
<div class="veil" aria-hidden="true"></div>

<div class="page" inert={browsing}>
  <header class="top">
    <a class="brand" href="/" aria-label="DLPCC home">
      <span class="badge"><Bell size={26} /></span>
      <span class="word">DLPCC</span>
      <span class="dong" lang="zh">咚</span>
    </a>
    {@render status()}
  </header>

  {#if githubDev}
    <p class="notice">
      <strong>Open this on localhost for WebRTC.</strong> This github.dev link only carries HTTP, so calls and streams
      can't reach the relay through it. Use VS Code desktop's port forwarding, or run
      <code>gh codespace ports forward 8080:8080</code>, then open <code>http://localhost:8080</code>.
    </p>
  {/if}

  <main class="hero">
    <div class="stage">
      <div class="sun" aria-hidden="true"></div>
      <canvas bind:this={canvas} aria-label="A rack of bronze bells. Click one to strike it."></canvas>
    </div>

    <div class="copy">
      <p class="name">Donglalu Proxy <span>The Second Coming</span></p>
      <p class="eyebrow">WebRTC relay for Scramjet</p>
      <h1>Keep the stream <em>ringing</em>.</h1>
      <p class="lede">
        When a network blocks UDP, WebRTC goes quiet: game streams stall and calls never connect. DLPCC sends every peer
        connection in a proxied page through a TURN relay on this same port.
      </p>

      <form onsubmit={submit}>
        <label class="sr" for="url">Address</label>
        <input id="url" bind:value={url} spellcheck="false" autocomplete="off" placeholder="https://" />
        <button disabled={!ready}>
          <Bell size={18} />
          {ready ? "Go" : "Loading"}
        </button>
      </form>

      <div class="labrow">
        {@render labToggles()}
        <p>
          <strong>Block UDP</strong> makes proxied pages behave as on a network that drops UDP: only TURN over TCP gets
          through. Open the data channel test with DLPCC off, then on.
        </p>
      </div>

      <ul class="quick">
        {#each quick as q}
          <li><button type="button" disabled={!ready} onclick={() => open(q.url)}>{q.label}</button></li>
        {/each}
      </ul>
    </div>
  </main>

  <section class="features" aria-label="How it works">
    {#each features as f, i}
      <article>
        <span class="icon"><Bell size={22} /></span>
        <span class="num">0{i + 1}</span>
        <h2>{f.title}</h2>
        <p>{f.body}</p>
      </article>
    {/each}
  </section>

  <footer>
    <span>Donglalu Proxy The Second Coming · AGPL-3.0</span>
    <span>Check <code>chrome://webrtc-internals</code>: the selected pair should be <code>relay</code>.</span>
  </footer>
</div>

<div class="browser" class:open={browsing} aria-hidden={!browsing} inert={!browsing}>
  <div class="bar">
    <button class="back" type="button" onclick={home} aria-label="Back to start">
      <span class="badge small"><Bell size={18} /></span>
    </button>
    <form onsubmit={submit}>
      <label class="sr" for="url2">Address</label>
      <input id="url2" bind:value={url} spellcheck="false" autocomplete="off" />
      <button disabled={!ready}>Go</button>
    </form>
    {@render labToggles()}
    {@render status()}
  </div>
  <div class="view">
    <iframe bind:this={iframe} title="Proxied page"></iframe>
    <aside class="monitor" aria-live="polite">
      <header class="m-head">
        <span class="badge tiny"><Bell size={14} /></span>
        <span class="verdict {verdict.tone}">{verdict.text}</span>
      </header>
      {#if connections.length}
        <ul>
          {#each connections as c}
            <li>
              <span class="state {c.state}">{c.state}</span>
              <span class="path">{c.path ?? "no path yet"}</span>
              {#if c.received || c.sent}
                <span class="bytes">
                  ↓ {size(c.received)} · ↑ {size(c.sent)}{c.rtt ? ` · ${Math.round(c.rtt * 1000)} ms` : ""}
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </aside>
  </div>
</div>

<style>
  :global(:root) {
    --ink: #0c0c0f;
    --ink-2: #16161b;
    --line: #2a2a31;
    --paper: #f4f1ea;
    --muted: #a3a1a8;
    --red: #e0262e;
    --red-deep: #9c1419;
    --sky: #49a9e8;
    --sky-deep: #1f6fae;
    color-scheme: dark;
  }
  :global(html, body) {
    margin: 0;
    height: 100%;
    background: var(--ink);
    color: var(--paper);
    font: 16px/1.55 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
  }
  :global(*, *::before, *::after) {
    box-sizing: border-box;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }

  .page {
    /* Content stops growing at 1280px and centres; the backdrop still
       fills the screen. */
    --gutter: max(clamp(16px, 4vw, 48px), calc((100% - 1280px) / 2));
    position: relative;
    z-index: 1;
    min-height: 100%;
    overflow-x: hidden;
  }
  /* The Tron grid sits behind everything; the veil darkens the side the
     copy is on so it stays readable over the moving lines. */
  canvas.backdrop {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 0;
  }
  .veil {
    position: fixed;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    background:
      linear-gradient(90deg, color-mix(in srgb, var(--ink) 88%, transparent) 0%, color-mix(in srgb, var(--ink) 55%, transparent) 42%, transparent 70%),
      linear-gradient(180deg, color-mix(in srgb, var(--ink) 60%, transparent) 0%, transparent 18%);
  }

  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 18px var(--gutter);
    position: relative;
    z-index: 2;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    color: inherit;
    text-decoration: none;
  }
  /* The avatar's look: a sky disc ringed in black, red on top. */
  .badge {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: var(--sky);
    color: var(--red);
    box-shadow: 0 0 0 3px var(--ink), 0 0 0 5px var(--red);
  }
  .badge.small {
    width: 34px;
    height: 34px;
    box-shadow: 0 0 0 2px var(--ink), 0 0 0 4px var(--red);
  }
  .word {
    font-weight: 900;
    font-size: 22px;
    letter-spacing: 0.08em;
  }
  .dong {
    color: var(--red);
    font-weight: 700;
    font-size: 20px;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 6px 12px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--ink-2);
    font: 12px ui-monospace, "Cascadia Code", Consolas, monospace;
    color: var(--sky);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status.off {
    color: var(--red);
  }
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--sky);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--sky) 30%, transparent);
  }
  /* The red minus badge from the avatar, for a relay that's off. */
  .minus {
    flex: none;
    position: relative;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--red);
  }
  .minus::after {
    content: "";
    position: absolute;
    inset: 6px 3px;
    border-radius: 1px;
    background: var(--paper);
  }

  .hero {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
    align-items: center;
    gap: clamp(16px, 3vw, 40px);
    padding: 0 var(--gutter);
    min-height: min(720px, calc(100vh - 80px));
  }
  .copy {
    grid-row: 1;
    grid-column: 1;
    max-width: 560px;
  }
  .stage {
    grid-row: 1;
    grid-column: 2;
    position: relative;
    aspect-ratio: 1.1;
    min-height: 320px;
  }
  .sun {
    position: absolute;
    inset: 6% 10%;
    border-radius: 50%;
    background: radial-gradient(circle at 38% 32%, #7cc4f2, var(--sky) 45%, var(--sky-deep));
    box-shadow: 0 0 0 10px var(--ink), 0 0 0 14px var(--red), 0 30px 120px -20px color-mix(in srgb, var(--sky) 55%, transparent);
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    touch-action: manipulation;
  }

  .notice {
    margin: 0 var(--gutter) 8px;
    padding: 12px 16px;
    border: 1px solid var(--sky);
    border-radius: 14px;
    background: color-mix(in srgb, var(--sky) 12%, var(--ink));
    font-size: 14px;
  }
  .notice code {
    color: var(--sky);
  }
  .name {
    margin: 0 0 10px;
    font-size: clamp(18px, 2vw, 24px);
    font-weight: 800;
    letter-spacing: -0.01em;
    line-height: 1.2;
  }
  .name span {
    color: var(--red);
    font-style: italic;
  }
  .eyebrow {
    margin: 0 0 12px;
    color: var(--sky);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }
  h1 {
    margin: 0;
    font-size: clamp(40px, 6.4vw, 84px);
    line-height: 0.98;
    font-weight: 900;
    letter-spacing: -0.03em;
    text-wrap: balance;
  }
  h1 em {
    font-style: normal;
    color: var(--red);
  }
  .lede {
    margin: 20px 0 28px;
    color: var(--muted);
    font-size: 18px;
    max-width: 48ch;
  }

  form {
    display: flex;
    gap: 8px;
    min-width: 0;
  }
  input {
    flex: 1;
    min-width: 0;
    padding: 14px 16px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--ink-2);
    color: inherit;
    font: inherit;
  }
  input:focus-visible,
  button:focus-visible {
    outline: 2px solid var(--sky);
    outline-offset: 2px;
  }
  form button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 0 22px;
    border: 0;
    border-radius: 12px;
    background: var(--red);
    color: var(--paper);
    font: inherit;
    font-weight: 800;
    cursor: pointer;
  }
  form button:hover:not(:disabled) {
    background: var(--red-deep);
  }
  button:disabled {
    opacity: 0.55;
    cursor: progress;
  }

  .quick {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 16px 0 0;
    padding: 0;
    list-style: none;
  }
  .quick button {
    padding: 7px 14px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: transparent;
    color: var(--paper);
    font: inherit;
    font-size: 14px;
    cursor: pointer;
  }
  .quick button:hover:not(:disabled) {
    border-color: var(--sky);
    color: var(--sky);
  }

  .features {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
    padding: 48px var(--gutter) 32px;
  }
  article {
    position: relative;
    padding: 24px;
    border: 1px solid var(--line);
    border-radius: 18px;
    background: linear-gradient(180deg, color-mix(in srgb, var(--ink-2) 86%, transparent), color-mix(in srgb, var(--ink) 92%, transparent));
    backdrop-filter: blur(6px);
  }
  .icon {
    display: inline-grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--red) 16%, transparent);
    color: var(--red);
  }
  .num {
    position: absolute;
    top: 24px;
    right: 24px;
    color: var(--line);
    font-weight: 900;
    font-size: 28px;
  }
  article h2 {
    margin: 16px 0 6px;
    font-size: 20px;
  }
  article p {
    margin: 0;
    color: var(--muted);
    font-size: 15px;
  }

  footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 8px 24px;
    padding: 24px var(--gutter) 32px;
    color: var(--muted);
    font-size: 13px;
  }
  code {
    color: var(--sky);
  }

  .browser {
    position: fixed;
    inset: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    background: var(--ink);
    /* Kept laid out while hidden, so Scramjet's frame exists from the start. */
    visibility: hidden;
    transform: translateY(24px);
    opacity: 0;
    transition: opacity 0.25s, transform 0.25s, visibility 0s 0.25s;
  }
  .browser.open {
    visibility: visible;
    transform: none;
    opacity: 1;
    transition: opacity 0.25s, transform 0.25s;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border-bottom: 2px solid var(--red);
  }
  .bar form {
    flex: 1;
  }
  .bar input {
    padding: 8px 12px;
    border-radius: 10px;
  }
  .bar form button {
    padding: 0 16px;
    border-radius: 10px;
  }
  .back {
    padding: 4px;
    border: 0;
    border-radius: 50%;
    background: none;
    cursor: pointer;
  }
  .view {
    position: relative;
    flex: 1;
    display: flex;
    min-height: 0;
  }
  iframe {
    flex: 1;
    width: 100%;
    border: 0;
    background: #fff;
  }

  .lab {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    flex: none;
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px 6px 6px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--ink-2);
    color: var(--muted);
    font: inherit;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
  }
  .sw {
    position: relative;
    width: 30px;
    height: 18px;
    border-radius: 999px;
    background: var(--line);
    transition: background 0.15s;
  }
  .sw::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--paper);
    transition: transform 0.15s;
  }
  .toggle[aria-pressed="true"] {
    color: var(--paper);
  }
  .toggle[aria-pressed="true"] .sw {
    background: var(--sky);
  }
  .toggle:first-child[aria-pressed="true"] .sw {
    background: var(--red);
  }
  .toggle[aria-pressed="true"] .sw::after {
    transform: translateX(12px);
  }
  .transport {
    display: inline-flex;
    padding: 3px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--ink-2);
  }
  .transport button {
    padding: 4px 10px;
    border: 0;
    border-radius: 999px;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }
  .transport button[aria-checked="true"] {
    background: var(--sky);
    color: var(--ink);
  }
  .transport button:focus-visible {
    outline: 2px solid var(--sky);
    outline-offset: 2px;
  }
  .labrow {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: 18px;
    padding: 12px 14px;
    border: 1px dashed var(--line);
    border-radius: 14px;
  }
  .labrow p {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.45;
  }
  .labrow strong {
    color: var(--paper);
  }

  .monitor {
    position: absolute;
    right: 12px;
    bottom: 12px;
    width: min(340px, calc(100% - 24px));
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: color-mix(in srgb, var(--ink) 92%, transparent);
    backdrop-filter: blur(8px);
    box-shadow: 0 12px 40px rgb(0 0 0 / 0.45);
    font-size: 13px;
  }
  .m-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .badge.tiny {
    flex: none;
    width: 24px;
    height: 24px;
    box-shadow: 0 0 0 2px var(--ink), 0 0 0 3px var(--red);
  }
  .verdict {
    font-weight: 700;
  }
  .verdict.ok {
    color: var(--sky);
  }
  .verdict.bad {
    color: var(--red);
  }
  .verdict.idle,
  .verdict.wait {
    color: var(--muted);
  }
  .monitor ul {
    display: grid;
    gap: 6px;
    margin: 10px 0 0;
    padding: 10px 0 0;
    border-top: 1px solid var(--line);
    list-style: none;
  }
  .monitor li {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    font: 12px ui-monospace, "Cascadia Code", Consolas, monospace;
  }
  .state {
    font-weight: 700;
    color: var(--muted);
  }
  .state.connected {
    color: var(--sky);
  }
  .state.failed {
    color: var(--red);
  }
  .path {
    color: var(--paper);
  }
  .bytes {
    width: 100%;
    color: var(--muted);
  }

  @media (max-width: 860px) {
    /* Stacked: the copy is under the bells, so darken from below. */
    .veil {
      background: linear-gradient(180deg, color-mix(in srgb, var(--ink) 35%, transparent) 0%, color-mix(in srgb, var(--ink) 82%, transparent) 45%);
    }
    .hero {
      grid-template-columns: minmax(0, 1fr);
      min-height: 0;
      padding-bottom: 8px;
    }
    .stage {
      grid-row: 1;
      grid-column: 1;
      min-height: 260px;
      aspect-ratio: 1.35;
    }
    .copy {
      grid-row: 2;
    }
    .features {
      grid-template-columns: minmax(0, 1fr);
      padding-top: 32px;
    }
  }
  @media (max-width: 560px) {
    .top .status {
      max-width: 46vw;
    }
    .bar .status,
    .bar .lab {
      display: none;
    }
    .labrow {
      flex-direction: column;
      align-items: flex-start;
    }
    .word {
      font-size: 18px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .browser,
    .browser.open {
      transition: none;
    }
  }
</style>
