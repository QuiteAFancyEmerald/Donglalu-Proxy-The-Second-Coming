import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// A bianzhong rack: bronze bells on a lacquered beam. Click a bell to strike
// it; like the real ones, the centre and the side ring different notes.

// Outer profile of a unit bell, hanging from y = 0 down to the lip at y = -1.
const OUTER = [
  [0.5, -0.99],
  [0.49, -0.86],
  [0.44, -0.6],
  [0.39, -0.3],
  [0.35, -0.08],
  [0.31, 0],
];
const FLATTEN = 0.72; // bianzhong are almond shaped in section, not round
// Two tiers, pentatonic, largest bell lowest. The side strike sits a minor
// third up.
const TIERS = [
  { y: 1.25, sizes: [1.18, 1.08, 0.99, 0.9, 0.82, 0.74, 0.67], notes: [196, 220, 246.9, 293.7, 329.6, 392, 440] },
  { y: -0.95, sizes: [1.32, 1.24, 1.16, 1.08, 1.0], notes: [98, 110, 130.8, 146.8, 164.8] },
];

function radiusAt(y) {
  for (let i = 1; i < OUTER.length; i++) {
    const [r0, y0] = OUTER[i - 1];
    const [r1, y1] = OUTER[i];
    if (y <= y1) return r0 + ((y - y0) / (y1 - y0)) * (r1 - r0);
  }
  return OUTER[OUTER.length - 1][0];
}

function bellGeometry() {
  const inner = [
    [0, -0.06],
    [0.27, -0.08],
    [0.32, -0.35],
    [0.37, -0.65],
    [0.42, -0.92],
    [0.45, -1.0],
  ];
  const profile = [...inner, ...OUTER, [0, 0]].map(([r, y]) => new THREE.Vector2(r, y));
  const geo = new THREE.LatheGeometry(profile, 64);
  // Arch the lip up in the middle of each broad face, the shape that lets
  // one bell ring two notes.
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const s = Math.sin(Math.atan2(z, x));
    const t = THREE.MathUtils.clamp((-0.72 - y) / 0.28, 0, 1);
    pos.setY(i, y + 0.13 * s * s * t * t);
  }
  geo.computeVertexNormals();
  return geo;
}

function knobGeometry() {
  const parts = [];
  for (const face of [Math.PI / 2, -Math.PI / 2]) {
    for (const side of [-1, 1]) {
      for (const col of [0.36, 0.56, 0.76]) {
        for (const y of [-0.24, -0.38, -0.52]) {
          const a = face + side * col;
          const r = radiusAt(y) + 0.012;
          const cone = new THREE.ConeGeometry(0.034, 0.08, 10);
          cone.rotateZ(-Math.PI / 2); // point along +x
          cone.rotateY(-a);
          cone.translate(Math.cos(a) * r, y, Math.sin(a) * r);
          parts.push(cone);
        }
      }
    }
  }
  return mergeGeometries(parts);
}

function bandGeometry() {
  // The raised central band (zheng) on each face.
  const parts = [];
  for (const face of [Math.PI / 2, -Math.PI / 2]) {
    for (const y of [-0.16, -0.31, -0.46, -0.61]) {
      const r = radiusAt(y);
      const bar = new THREE.BoxGeometry(0.2, 0.025, 0.03);
      bar.rotateY(-face + Math.PI / 2);
      bar.translate(Math.cos(face) * r, y, Math.sin(face) * r);
      parts.push(bar);
    }
  }
  return mergeGeometries(parts);
}

class BellVoice {
  ctx;
  out;

  ensure() {
    if (this.ctx) return this.ctx.resume();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    const comp = this.ctx.createDynamicsCompressor();
    this.out = this.ctx.createGain();
    this.out.gain.value = 0.32;
    this.out.connect(comp).connect(this.ctx.destination);
  }

  strike(freq, force = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // Inharmonic partials with the high ones dying first: reads as bronze.
    const partials = [
      [0.5, 0.5, 4.5],
      [1, 1, 3.6],
      [2.01, 0.42, 2.2],
      [2.76, 0.3, 1.5],
      [3.91, 0.16, 0.9],
      [5.43, 0.1, 0.5],
    ];
    for (const [ratio, amp, decay] of partials) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.frequency.value = freq * ratio;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp * force, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.connect(g).connect(this.out);
      osc.start(t);
      osc.stop(t + decay + 0.05);
    }
  }
}

export function createBells(canvas, { reducedMotion = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  const look = new THREE.Vector3(0, -0.9, 0);

  const key = new THREE.DirectionalLight(0xfff1dc, 2.2);
  key.position.set(3, 5, 6);
  const rim = new THREE.DirectionalLight(0x49a9e8, 2.6);
  rim.position.set(-5, 2, -4);
  scene.add(key, rim, new THREE.AmbientLight(0xffffff, 0.15));

  const bronze = new THREE.MeshStandardMaterial({ color: 0xb98543, metalness: 0.92, roughness: 0.32, side: THREE.DoubleSide });
  const hoverBronze = bronze.clone();
  hoverBronze.emissive = new THREE.Color(0x49a9e8);
  hoverBronze.emissiveIntensity = 0.18;
  const darkBronze = new THREE.MeshStandardMaterial({ color: 0x7a4f22, metalness: 0.9, roughness: 0.4 });
  const lacquer = new THREE.MeshStandardMaterial({ color: 0xc8191f, metalness: 0.05, roughness: 0.38 });
  const ink = new THREE.MeshStandardMaterial({ color: 0x15151a, metalness: 0.3, roughness: 0.5 });

  // Rack: two beams on two posts, the top one's ends turned up.
  const rack = new THREE.Group();
  const span = 8.6;
  const beamY = TIERS[0].y;
  for (const tier of TIERS) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 0.24, 0.3), lacquer);
    beam.position.y = tier.y;
    rack.add(beam);
  }
  for (const side of [-1, 1]) {
    const end = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.18, 0.3), lacquer);
    end.position.set(side * (span / 2 + 0.25), beamY + 0.12, 0);
    end.rotation.z = side * 0.32;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 4.4, 20), ink);
    post.position.set(side * (span / 2 - 0.35), beamY - 2.1, 0);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 0.25, 24), lacquer);
    foot.position.set(side * (span / 2 - 0.35), beamY - 4.3, 0);
    rack.add(end, post, foot);
  }
  scene.add(rack);

  const bellGeo = bellGeometry();
  const knobGeo = knobGeometry();
  const bandGeo = bandGeometry();
  const loopGeo = new THREE.TorusGeometry(0.09, 0.028, 10, 24);
  const bells = [];
  for (const tier of TIERS) {
    // Pack the bells by size, then centre the row.
    const xs = [];
    let x = 0;
    for (const size of tier.sizes) {
      xs.push(x + size * 0.5);
      x += size * 0.98 + 0.12;
    }
    const shift = (xs[0] + xs[xs.length - 1]) / 2;
    tier.sizes.forEach((size, i) => hang(xs[i] - shift, tier.y - 0.12, size, tier.notes[i]));
  }

  function hang(x, y, size, note) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.34, 8), ink);
    cord.position.y = -0.17;
    const body = new THREE.Group();
    body.position.y = -0.34;
    body.scale.set(size, size, size * FLATTEN);
    const shell = new THREE.Mesh(bellGeo, bronze);
    shell.userData.index = bells.length;
    const knobs = new THREE.Mesh(knobGeo, darkBronze);
    const band = new THREE.Mesh(bandGeo, darkBronze);
    const loop = new THREE.Mesh(loopGeo, darkBronze);
    loop.position.y = 0.07;
    loop.rotation.y = Math.PI / 2;
    body.add(shell, knobs, band, loop);
    pivot.add(cord, body);
    scene.add(pivot);
    bells.push({ pivot, shell, size, note, angle: 0, vel: 0, roll: 0, rollVel: 0, phase: bells.length * 0.9 });
  }

  const voice = new BellVoice();
  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2(9, 9);
  const parallax = new THREE.Vector2();
  let hovered = -1;

  function pick(e) {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(pointer, camera);
    return ray.intersectObjects(bells.map((b) => b.shell))[0];
  }

  function strike(i, force = 1, side = 0) {
    const b = bells[i];
    b.vel += (reducedMotion ? 0.6 : 2.4) * force / b.size;
    b.rollVel += side * 1.2 * force;
    voice.strike(b.note * (Math.abs(side) > 0.45 ? 1.19 : 1), force);
  }

  function onMove(e) {
    const rect = canvas.getBoundingClientRect();
    parallax.set((e.clientX - rect.left) / rect.width - 0.5, (e.clientY - rect.top) / rect.height - 0.5);
    const hit = pick(e);
    hovered = hit ? hit.object.userData.index : -1;
    canvas.style.cursor = hovered >= 0 ? "pointer" : "";
  }

  function onDown(e) {
    const hit = pick(e);
    if (!hit) return;
    voice.ensure();
    const i = hit.object.userData.index;
    // Where across the face it was struck, -1 left edge to 1 right edge.
    const local = hit.object.worldToLocal(hit.point.clone());
    strike(i, 1, THREE.MathUtils.clamp(local.x / 0.45, -1, 1));
  }

  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerleave", () => {
    hovered = -1;
    parallax.set(0, 0);
  });

  function resize() {
    const { clientWidth: w, clientHeight: h } = canvas.parentElement;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Fit the whole rack (about 11 units wide) at any aspect.
    const halfTan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camera.position.z = Math.max(13, 11.4 / (2 * halfTan * camera.aspect));
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas.parentElement);
  resize();

  let active = true;
  let frame = 0;
  let last = performance.now();
  const camPos = new THREE.Vector3();
  function tick(now) {
    frame = requestAnimationFrame(tick);
    if (!active) return;
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    const t = now / 1000;
    for (const [i, b] of bells.entries()) {
      // Damped spring per bell, plus a slow breeze unless motion is reduced.
      const breeze = reducedMotion ? 0 : Math.sin(t * 0.7 + b.phase) * 0.018;
      b.vel += (-9 * (b.angle - breeze) - 1.1 * b.vel) * dt;
      b.angle += b.vel * dt;
      b.rollVel += (-14 * b.roll - 1.6 * b.rollVel) * dt;
      b.roll += b.rollVel * dt;
      b.pivot.rotation.x = b.angle;
      b.pivot.rotation.z = b.roll * 0.4;
      b.shell.material = i === hovered ? hoverBronze : bronze;
    }
    camPos.set(parallax.x * 1.6, 0.2 - parallax.y * 0.8, camera.position.z);
    camera.position.lerp(camPos, reducedMotion ? 1 : 0.05);
    camera.lookAt(look);
    renderer.render(scene, camera);
  }
  frame = requestAnimationFrame(tick);

  return {
    /** Run up the rack, low to high. */
    ringAll() {
      voice.ensure();
      const order = bells.map((b, i) => i).sort((a, b) => bells[a].note - bells[b].note);
      order.forEach((i, n) => setTimeout(() => strike(i, 0.7), n * 110));
    },
    /** Pause rendering while the page is covered. */
    setActive(on) {
      active = on;
      last = performance.now();
    },
    dispose() {
      cancelAnimationFrame(frame);
      ro.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      renderer.dispose();
      pmrem.dispose();
      voice.ctx?.close();
    },
  };
}
