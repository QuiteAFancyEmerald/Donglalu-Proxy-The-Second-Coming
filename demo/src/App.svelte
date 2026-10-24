<script>
  import Chemical from "chemicaljs/Chemical";

  let chemical = $state();
  let ready = $state(false);
  let iframe;
  let frame;
  let url = $state("https://play.geforcenow.com/");
  const relay = window.__dlpcc?.config.iceServers[0].urls[0];

  async function onready() {
    // Scramjet's controller only loads once Chemical is ready.
    const { DlpccPlugin } = await import("./dlpcc-plugin.js");
    frame = chemical.createFrame(iframe, {
      plugins: [new DlpccPlugin(), new chemical.plugins.UrlWatcherPlugin((u) => (url = u))],
    });
    frame.go(url);
  }

  function go(e) {
    e.preventDefault();
    if (!frame) return;
    frame.go(/^https?:\/\//.test(url) ? url : "https://" + url);
  }
</script>

<Chemical bind:this={chemical} bind:ready {onready} />

<header>
  <form onsubmit={go}>
    <input bind:value={url} spellcheck="false" aria-label="URL" />
    <button disabled={!ready}>Go</button>
  </form>
  <span class:off={!relay} title="WebRTC in proxied pages is sent through this TURN server">
    {relay ? `relay: ${relay}` : "relay off"}
  </span>
</header>
<iframe bind:this={iframe} title="proxied page"></iframe>

<style>
  :global(html, body) {
    margin: 0;
    height: 100%;
    background: #111;
    color: #eee;
    font: 14px system-ui, sans-serif;
  }
  :global(#app) {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  header {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 8px 12px;
  }
  form {
    display: flex;
    flex: 1;
    gap: 6px;
  }
  input {
    flex: 1;
    padding: 6px 10px;
    border: 1px solid #333;
    border-radius: 6px;
    background: #1b1b1b;
    color: inherit;
  }
  button {
    padding: 6px 14px;
    border: 0;
    border-radius: 6px;
    background: #76b900;
    color: #000;
  }
  span {
    color: #76b900;
    font-size: 12px;
    white-space: nowrap;
  }
  span.off {
    color: #c55;
  }
  iframe {
    flex: 1;
    border: 0;
    background: #fff;
  }
</style>
