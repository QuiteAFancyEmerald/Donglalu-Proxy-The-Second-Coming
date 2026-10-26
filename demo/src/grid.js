import * as THREE from "three";

// The page backdrop: a Tron-style grid in the avatar's colours. Light cycles
// race across it in red and sky blue, a neon skyline lines the road, and two
// blocky heads hang over the horizon. The camera glides forward forever.

const INK = 0x0c0c0f;
const RED = new THREE.Color(0xe0262e);
const SKY = new THREE.Color(0x49a9e8);
const CELL = 4; // grid spacing; the cycles turn on these lines
const MAJOR = CELL * 5;
const SPEED = 7; // camera, units per second
const FAR = 150; // everything has faded to black by here
const LANES = 26; // cycles stay within this many units of the camera's x
const TRAIL = 40; // trail length in units
const MAX_POINTS = 32;
const WALL = 2.2; // light wall height

const GRID_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const GRID_FRAG = /* glsl */ `
  uniform vec3 minor;
  uniform vec3 major;
  varying vec3 vWorld;
  float lines(vec2 p, float cell, float width) {
    vec2 q = p / cell;
    vec2 d = abs(fract(q - 0.5) - 0.5) / fwidth(q);
    return 1.0 - min(min(d.x, d.y) / width, 1.0);
  }
  void main() {
    vec2 p = vWorld.xz;
    float fade = 1.0 - smoothstep(${(FAR * 0.3).toFixed(1)}, ${FAR.toFixed(1)}, distance(cameraPosition.xz, p));
    // A soft halo round the major lines reads as glow without a bloom pass.
    vec2 g = abs(fract(p / ${MAJOR.toFixed(1)} - 0.5) - 0.5) * ${MAJOR.toFixed(1)};
    float halo = exp(-min(g.x, g.y) * 1.8) * 0.4;
    vec3 col = minor * lines(p, ${CELL.toFixed(1)}, 1.0) * 0.7 + major * (lines(p, ${MAJOR.toFixed(1)}, 1.6) + halo);
    gl_FragColor = vec4(col * fade, 1.0);
  }
`;
const TRAIL_VERT = /* glsl */ `
  attribute float top;
  attribute float age;
  varying float vTop;
  varying float vAge;
  varying float vDist;
  void main() {
    vTop = top;
    vAge = age;
    vDist = distance(cameraPosition.xz, position.xz);
    gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  }
`;
const TRAIL_FRAG = /* glsl */ `
  uniform vec3 color;
  varying float vTop;
  varying float vAge;
  varying float vDist;
  void main() {
    float edge = 0.4 + 1.2 * pow(vTop, 4.0); // bright rim along the top
    float fade = (1.0 - vAge) * (1.0 - smoothstep(${(FAR * 0.3).toFixed(1)}, ${FAR.toFixed(1)}, vDist));
    gl_FragColor = vec4(color * edge * fade, 1.0);
  }
`;
const HORIZON_FRAG = /* glsl */ `
  uniform vec3 glow;
  uniform vec3 line;
  varying vec2 vUv;
  void main() {
    float y = vUv.y;
    vec3 col = glow * exp(-y * 7.0) * 0.55 + line * exp(-y * 90.0) * 0.8;
    gl_FragColor = vec4(col, 1.0);
  }
`;

// Faces drawn as 16x16 pixel art. "." is the head's skin.
const GRIN_FACE = [
  "................",
  "................",
  "................",
  "...XX......XX...",
  "..XXXX....XXXX..",
  "................",
  "................",
  "................",
  "..X..........X..",
  "..XXXXXXXXXXXX..",
  "..X.X.X.X.X.XX..",
  "...X.X.X.X.X.X..",
  "....XXXXXXXX....",
  "................",
  "................",
  "................",
];
const KING_FACE = [
  ".X..X...X..X..X.",
  "XXXXXXXXXXXXXXXX",
  "XXXXXXXXXXXXXXXX",
  "................",
  "RRRRRRRRRRRRRRRR",
  "RXXXXXRRRRXXXXXR",
  "RRRRRRRRRRRRRRRR",
  "................",
  "................",
  "................",
  "....X......X....",
  ".....XWWWWX.....",
  "......XXXX......",
  "................",
  "................",
  "................",
];

function pixelTexture(rows, skin) {
  const px = 8;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 16 * px;
  const g = canvas.getContext("2d");
  const palette = { ".": skin, X: "#0c0c0f", R: "#e0262e", W: "#f4f1ea" };
  rows.forEach((row, y) =>
    [...row].forEach((c, x) => {
      g.fillStyle = palette[c];
      g.fillRect(x * px, y * px, px, px);
    }),
  );
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createGrid(canvas, { reducedMotion = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setClearColor(INK);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(INK, FAR * 0.35, FAR);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, FAR * 1.2);
  camera.position.set(0, 2.4, 0);
  const disposables = [];
  const keep = (x) => (disposables.push(x), x);

  // Floor: one big plane that follows the camera; the shader draws the
  // lines in world space, so they stay put while the plane moves.
  const floor = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(FAR * 2.6, FAR * 2.6)).rotateX(-Math.PI / 2),
    keep(new THREE.ShaderMaterial({ vertexShader: GRID_VERT, fragmentShader: GRID_FRAG, uniforms: { minor: { value: RED }, major: { value: SKY } } })),
  );
  scene.add(floor);

  const horizon = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(FAR * 4, 60).translate(0, 30, 0)), // bottom edge on the floor
    keep(
      new THREE.ShaderMaterial({
        vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader: HORIZON_FRAG,
        uniforms: { glow: { value: RED }, line: { value: SKY } },
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    ),
  );
  scene.add(horizon);

  // Skyline: dark blocks with neon edges either side of the road, recycled
  // from behind the camera to the far end.
  const block = keep(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
  const blockEdges = keep(new THREE.EdgesGeometry(block));
  const blockFill = keep(new THREE.MeshBasicMaterial({ color: 0x111116 }));
  const edgeRed = keep(new THREE.LineBasicMaterial({ color: RED }));
  const edgeSky = keep(new THREE.LineBasicMaterial({ color: SKY }));
  const towers = [];
  function placeTower(t, z) {
    const side = Math.random() < 0.5 ? -1 : 1;
    t.position.set(camera.position.x + side * (20 + Math.random() * 46), 0, z);
    t.scale.set(3 + Math.random() * 6, 5 + Math.random() ** 2 * 26, 3 + Math.random() * 6);
  }
  for (let i = 0; i < 30; i++) {
    const t = new THREE.Group();
    t.add(new THREE.Mesh(block, blockFill), new THREE.LineSegments(blockEdges, i % 3 ? edgeRed : edgeSky));
    placeTower(t, -Math.random() * FAR);
    towers.push(t);
    scene.add(t);
  }

  // Light cycles. Each runs along grid lines, sometimes turning at an
  // intersection, and drags a wall of light behind it.
  const index = [];
  for (let i = 0; i < MAX_POINTS - 1; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const topAttr = new Float32Array(MAX_POINTS * 2).map((_, i) => i % 2);
  const bikeGeo = keep(new THREE.BoxGeometry(0.7, 0.8, 2.2).translate(0, 0.45, 0));
  const cycles = [];
  for (let i = 0; i < 8; i++) {
    const color = i % 2 ? SKY : RED;
    const geo = keep(new THREE.BufferGeometry());
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 6), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("top", new THREE.BufferAttribute(topAttr, 1));
    geo.setAttribute("age", new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 2), 1).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(index);
    const wall = new THREE.Mesh(
      geo,
      keep(
        new THREE.ShaderMaterial({
          vertexShader: TRAIL_VERT,
          fragmentShader: TRAIL_FRAG,
          uniforms: { color: { value: color } },
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
          side: THREE.DoubleSide,
        }),
      ),
    );
    wall.frustumCulled = false;
    const bike = new THREE.Mesh(bikeGeo, keep(new THREE.MeshBasicMaterial({ color })));
    scene.add(wall, bike);
    const c = { wall, bike, pos: new THREE.Vector3(), dir: new THREE.Vector3(), speed: 0, points: [] };
    spawn(c, true);
    cycles.push(c);
  }

  function snap(v) {
    return Math.round(v / CELL) * CELL;
  }
  function spawn(c, anywhere) {
    const ahead = anywhere ? 14 + Math.random() * 40 : 18 + Math.random() * 26;
    c.pos.set(snap(camera.position.x + (Math.random() * 2 - 1) * LANES * 0.8), 0, snap(camera.position.z - ahead));
    const r = Math.random();
    c.dir.set(r < 0.3 ? 1 : r < 0.6 ? -1 : 0, 0, r < 0.6 ? 0 : -1);
    if (!c.dir.lengthSq()) c.dir.set(0, 0, -1);
    c.speed = 9 + Math.random() * 5; // just ahead of the camera, so they stay in view
    c.points = [c.pos.clone(), c.pos.clone()];
  }
  function turn(c) {
    // Turn left or right, but head back towards the road when straying.
    // Never towards the camera: they'd fill the screen as they passed.
    const dx = c.pos.x - camera.position.x;
    if (c.dir.x !== 0) c.dir.set(0, 0, -1);
    else c.dir.set(Math.abs(dx) > LANES * 0.6 ? -Math.sign(dx) : Math.random() < 0.5 ? -1 : 1, 0, 0);
    // The head point becomes the corner; a new head carries on from it.
    c.points[c.points.length - 1].copy(c.pos);
    c.points.push(c.pos.clone());
    if (c.points.length >= MAX_POINTS) c.points.shift();
  }
  function moveCycle(c, dt) {
    let step = c.speed * dt;
    const axis = c.dir.x !== 0 ? "x" : "z";
    while (step > 0) {
      const sign = c.dir[axis];
      const here = c.pos[axis];
      // Distance to the next grid line along the way we're going.
      const next = sign > 0 ? Math.floor(here / CELL + 1e-6) * CELL + CELL : Math.ceil(here / CELL - 1e-6) * CELL - CELL;
      const gap = Math.abs(next - here);
      if (gap > step) {
        c.pos[axis] += sign * step;
        break;
      }
      c.pos[axis] = next;
      step -= gap;
      const stray = Math.abs(c.pos.x - camera.position.x) > LANES;
      if (Math.random() < 0.18 || (stray && axis === "x")) {
        turn(c);
        return moveCycle(c, step / c.speed);
      }
    }
    c.points[c.points.length - 1].copy(c.pos);
    trim(c);
  }
  // Shortens the trail from the tail end to TRAIL units.
  function trim(c) {
    let total = 0;
    for (let i = c.points.length - 1; i > 0; i--) {
      const seg = c.points[i].distanceTo(c.points[i - 1]);
      if (total + seg > TRAIL) {
        c.points[i - 1].lerp(c.points[i], 1 - (TRAIL - total) / seg);
        c.points.splice(0, i - 1);
        return;
      }
      total += seg;
    }
  }
  function drawCycle(c) {
    const pos = c.wall.geometry.attributes.position;
    const age = c.wall.geometry.attributes.age;
    const n = c.points.length;
    let along = 0;
    for (let k = 0; k < n; k++) {
      const p = c.points[n - 1 - k];
      if (k) along += p.distanceTo(c.points[n - k]);
      pos.setXYZ(k * 2, p.x, 0, p.z);
      pos.setXYZ(k * 2 + 1, p.x, WALL, p.z);
      age.setX(k * 2, along / TRAIL);
      age.setX(k * 2 + 1, along / TRAIL);
    }
    pos.needsUpdate = age.needsUpdate = true;
    c.wall.geometry.setDrawRange(0, (n - 1) * 6);
    c.bike.position.copy(c.pos);
    c.bike.rotation.y = Math.atan2(c.dir.x, c.dir.z);
  }

  // Two blocky heads over the horizon: a grinning white block, and the
  // avatar with his red visor, shades, spiky hair and winged headphones.
  function head(face, skin, edge) {
    const g = new THREE.Group();
    // No fog: they hang in the sky, past where the road fades out.
    const plain = keep(new THREE.MeshBasicMaterial({ color: skin, fog: false }));
    const front = keep(new THREE.MeshBasicMaterial({ map: keep(pixelTexture(face, skin)), fog: false }));
    const cube = keep(new THREE.BoxGeometry(1, 1, 1));
    g.add(new THREE.Mesh(cube, [plain, plain, plain, plain, front, plain]));
    g.add(new THREE.LineSegments(keep(new THREE.EdgesGeometry(cube)), keep(new THREE.LineBasicMaterial({ color: edge, fog: false }))));
    return g;
  }
  const grin = head(GRIN_FACE, "#f4f1ea", SKY);
  const king = head(KING_FACE, "#f2cfb1", RED);
  const black = keep(new THREE.MeshBasicMaterial({ color: INK, fog: false }));
  const white = keep(new THREE.MeshBasicMaterial({ color: 0xf4f1ea, fog: false }));
  const spike = keep(new THREE.ConeGeometry(0.09, 0.32, 4));
  for (let i = 0; i < 7; i++) {
    const s = new THREE.Mesh(spike, black);
    s.position.set(-0.42 + i * 0.14, 0.6, 0.05 - (i % 2) * 0.2);
    s.rotation.z = (3 - i) * 0.12;
    king.add(s);
  }
  const wing = keep(new THREE.BoxGeometry(0.06, 0.5, 0.16));
  for (const side of [-1, 1]) {
    for (let j = 0; j < 3; j++) {
      const w = new THREE.Mesh(wing, white);
      w.position.set(side * 0.56, 0.38 + j * 0.1, -0.05 - j * 0.12);
      w.rotation.x = -0.5 - j * 0.25;
      king.add(w);
    }
  }
  grin.scale.setScalar(7);
  king.scale.setScalar(7.5);
  scene.add(grin, king);

  let pointerX = 0;
  const onPointer = (e) => (pointerX = e.clientX / innerWidth - 0.5);
  addEventListener("pointermove", onPointer);

  let dirty = true;
  function resize() {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    // Narrow screens see less sideways, so widen the view a little.
    camera.fov = camera.aspect < 0.8 ? 72 : 60;
    camera.updateProjectionMatrix();
    dirty = true;
  }
  addEventListener("resize", resize);
  resize();

  const look = new THREE.Vector3();
  function update(t, dt) {
    camera.position.z -= SPEED * dt;
    camera.position.x += (Math.sin(t * 0.11) * 4 + pointerX * 3 - camera.position.x) * Math.min(dt * 2, 1);
    look.set(camera.position.x * 0.6, 3.2, camera.position.z - 30);
    camera.lookAt(look);
    const cz = camera.position.z;

    floor.position.set(camera.position.x, 0, cz);
    horizon.position.set(camera.position.x, 0, cz - FAR * 0.97);
    for (const tw of towers) if (tw.position.z > cz + 10) placeTower(tw, cz - FAR + Math.random() * 20);
    for (const c of cycles) {
      moveCycle(c, dt);
      if (c.pos.z > cz - 10 || c.pos.z < cz - 70 || Math.abs(c.pos.x - camera.position.x) > LANES * 1.6) spawn(c, false);
      drawCycle(c);
    }
    // They drift slowly like blimps, on opposite swings, over the right half
    // of the sky: the page's text is on the left.
    const swing = Math.sin(t * 0.045);
    grin.position.set(camera.position.x + 14 - swing * 14, 40 + Math.sin(t * 0.8) * 0.8, cz - 80);
    grin.rotation.set(Math.sin(t * 0.5) * 0.08, swing * 0.5 + Math.sin(t * 0.3) * 0.15, 0);
    king.position.set(camera.position.x + 26 + swing * 14, 43 + Math.sin(t * 0.7 + 2) * 0.8, cz - 88);
    king.rotation.set(Math.sin(t * 0.45 + 1) * 0.08, -swing * 0.5 + Math.sin(t * 0.27 + 1) * 0.15, 0);
  }

  // Reduced motion: lay some trails down, then hold still.
  if (reducedMotion) {
    for (let i = 0; i < 120; i++) update(i / 30, 1 / 30);
  }

  let active = true;
  let frame = 0;
  let last = performance.now();
  function tick(now) {
    frame = requestAnimationFrame(tick);
    if (!active) return;
    const dt = Math.min((now - last) / 1000, 1 / 20);
    last = now;
    if (!reducedMotion) update(now / 1000, dt);
    else if (!dirty) return;
    renderer.render(scene, camera);
    dirty = false;
  }
  frame = requestAnimationFrame(tick);

  return {
    /** Pause rendering while the page is covered. */
    setActive(on) {
      active = on;
      last = performance.now();
      dirty = true;
    },
    dispose() {
      cancelAnimationFrame(frame);
      removeEventListener("resize", resize);
      removeEventListener("pointermove", onPointer);
      for (const d of disposables) d.dispose();
      renderer.dispose();
    },
  };
}
