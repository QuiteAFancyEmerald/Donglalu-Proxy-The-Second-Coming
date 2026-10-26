<script>
  // A bianzhong (編鐘) bell: hanging loop, flared body with the arched lip and
  // two rows of knobs (mei). The body is currentColor, the knobs --bell-knob.
  let { size = 24, title = undefined } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 64 64"
  role={title ? "img" : undefined}
  aria-hidden={title ? undefined : "true"}
>
  {#if title}<title>{title}</title>{/if}
  <path d="M26 13V9a6 6 0 0 1 12 0v4" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" />
  <path d="M19 12H45Q48 32 55 56Q32 46 9 56Q16 32 19 12Z" fill="currentColor" />
  <g fill="var(--bell-knob, #0c0c0f)">
    <rect x="30" y="16" width="4" height="22" rx="2" />
    <circle cx="23.5" cy="22" r="2.4" />
    <circle cx="24.5" cy="30" r="2.4" />
    <circle cx="40.5" cy="22" r="2.4" />
    <circle cx="39.5" cy="30" r="2.4" />
  </g>
</svg>
