// 如果降雨数据变成雨 —— Three.js + 自定义 GLSL 实时粒子雨景
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ================= 数据：26 个时间点，00:00 → 24:00 ================= */
const N = 26;
const DAY_HOURS = 24;
const values = [
  2.1, 3.8, 9.9, 11.2, 11.9, 11.3, 8.7, 8.4, 4.1, 7.8,
  6.6, 3.4, 1.4, 5.6, 12.8, 12.4, 11.0, 6.7, 4.6, 7.4,
  5.9, 3.6, 2.2, 3.6, 6.6, 2.4,
];
const times = values.map((_, i) => (i * DAY_HOURS) / (N - 1)); // 小时
const fmt = (h) => {
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60);
  const pad = (n) => String(n).padStart(2, '0');
  return mm === 60 ? `${pad((hh + 1) % 24)}:00` : `${pad(hh)}:${pad(mm)}`;
};
const valueAt = (h) => {
  const t = THREE.MathUtils.clamp(h, 0, DAY_HOURS);
  const seg = (t / DAY_HOURS) * (N - 1);
  const i = Math.min(Math.floor(seg), N - 2);
  const f = seg - i;
  return THREE.MathUtils.lerp(values[i], values[i + 1], f);
};

/* ================= 渲染器与后期 ================= */
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x010205);

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 300);
camera.position.set(7.5, 1.6, 6.5);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.36, 0.35, 0.22);
composer.addPass(bloom);
composer.addPass(new OutputPass());

/* ================= 工具：文字精灵 ================= */
function makeLabel(text, { size = 42, color = 'rgba(128,136,146,0.8)', weight = 500, letterSpacing = 2 } = {}) {
  const pad = 12;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `${weight} ${size}px "PingFang SC","Microsoft YaHei",sans-serif`;
  ctx.font = font;
  const w = ctx.measureText(text).width + letterSpacing * text.length + pad * 2;
  c.width = Math.ceil(w);
  c.height = size + pad * 2;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  if (letterSpacing) {
    let x = pad;
    for (const ch of text) { ctx.fillText(ch, x, c.height / 2); x += ctx.measureText(ch).width + letterSpacing; }
  } else {
    ctx.fillText(text, pad, c.height / 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  return { sprite: sp, aspect: c.width / c.height };
}
function addLabel(text, x, y, z, h, opts) {
  const { sprite, aspect } = makeLabel(text, opts);
  sprite.scale.set(h * aspect, h, 1);
  sprite.position.set(x, y, z);
  scene.add(sprite);
  return sprite;
}

/* ================= 坐标轴 ================= */
{
  const axisMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.42 });
  const tickMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22 });

  const xPts = [new THREE.Vector3(-1.4, 0, 0), new THREE.Vector3(DAY_HOURS + 1.4, 0, 0)];
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(xPts), axisMat));

  const yTop = 13.9;
  scene.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, yTop, 0)]),
    axisMat
  ));

  // X 轴刻度 + 标签（每 2 小时）
  const tickVerts = [];
  for (let h = 0; h <= DAY_HOURS; h += 2) {
    tickVerts.push(new THREE.Vector3(h, 0, 0), new THREE.Vector3(h, -0.38, 0));
    addLabel(`${String(h).padStart(2, '0')}:00`, h, -0.95, 0, 0.4);
  }
  // Y 轴刻度 + 标签
  for (const v of [6.4, 12.8]) {
    tickVerts.push(new THREE.Vector3(0, v, 0), new THREE.Vector3(-0.38, v, 0));
    addLabel(v.toFixed(1), -1.05, v, 0, 0.4);
  }
  addLabel('毫米/小时', -1.4, 13.5, 0, 0.4);
  scene.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(tickVerts), tickMat
  ));
}

/* ================= 雨柱：GLSL 线段粒子 ================= */
const COL_R = 0.52;       // 雨柱横向抖动半径
const COL_SPREAD = 0.38;  // 外圈扩散比例：越大雨越分散
const colH = (v) => 0.55 + v * 0.92;

function buildRain() {
  const pos = [], data = [], ends = [];
  for (let c = 0; c < N; c++) {
    const v = values[c];
    if (v <= 0.05) continue;
    const cx = times[c];
    const h = colH(v);
    const base = 0.075 + 0.27 * (v / 12.8);         // 该列基础亮度
    const count = Math.round(55 + v * 115);
    // 高斯抖动
    const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
    for (let i = 0; i < count; i++) {
      // 部分雨滴在核心区内，部分向外围扩散，形成分散的雨幕
      const spread = Math.random() < 0.72 ? gauss() * COL_R : gauss() * (COL_R + COL_SPREAD * 2.2);
      const x = cx + spread;
      const z = gauss() * (COL_R + COL_SPREAD) * 1.1;
      const yN = Math.random();
      const speed = 0.55 + Math.random() * 0.5;      // 每秒循环次数
      const len = (0.35 + Math.random() * 0.85) * (0.5 + h / 13);
      const bright = base * (0.4 + Math.random() * 0.6);
      for (const e of [0, 1]) {
        pos.push(x, yN, z);
        data.push(speed, len, bright, h);
        ends.push(e);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aData', new THREE.Float32BufferAttribute(data, 4));
  g.setAttribute('aEnd', new THREE.Float32BufferAttribute(ends, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uPlayX: { value: 0 },
      uBoost: { value: 1.6 },
    },
    vertexShader: /* glsl */`
      uniform float uTime;
      uniform float uPlayX;
      uniform float uBoost;
      attribute vec4 aData; // speed, len, bright, colH
      attribute float aEnd;
      varying float vFade;
      void main() {
        float speed = aData.x, len = aData.y, bright = aData.z, colH = aData.w;
        float f = fract(position.y - uTime * speed);
        float yHead = f * colH;
        float y = mix(yHead, yHead - len, aEnd);
        float fade = smoothstep(0.0, 0.5, y) * smoothstep(colH, colH - 0.8, y);
        float dx = position.x - uPlayX;
        float boost = 1.0 + uBoost * exp(-dx * dx / 1.6);
        vec4 mv = modelViewMatrix * vec4(position.x, y, position.z, 1.0);
        vFade = fade * mix(1.0, 0.10, aEnd) * bright * boost * exp(-length(mv.xyz) * 0.011);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying float vFade;
      void main() {
        gl_FragColor = vec4(vec3(0.55, 0.68, 0.94) * vFade, 1.0);
      }`,
  });
  return new THREE.LineSegments(g, mat);
}
const rain = buildRain();
scene.add(rain);

/* ================= 地面溅落粒子 ================= */
function buildSplash() {
  const pos = [], data = [];
  for (let c = 0; c < N; c++) {
    const v = values[c];
    if (v <= 0.05) continue;
    const cx = times[c];
    const spread = 0.2 + v * 0.07;
    const count = Math.round(50 + v * 34);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spread + 0.05;
      const x = cx + Math.cos(a) * r;
      const z = Math.sin(a) * r * 1.4;
      const phase = Math.random() * Math.PI * 2;
      const spd = 1.5 + Math.random() * 3.5;
      const size = 0.32 + Math.random() * 0.75;
      const bright = (0.10 + 0.36 * (v / 12.8)) * (0.4 + Math.random() * 0.6);
      pos.push(x, 0, z);
      data.push(phase, spd, size, bright);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aData', new THREE.Float32BufferAttribute(data, 4));

  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uPlayX: { value: 0 }, uBoost: { value: 2.2 } },
    vertexShader: /* glsl */`
      uniform float uTime; uniform float uPlayX; uniform float uBoost;
      attribute vec4 aData; // phase, speed, size, bright
      varying float vA;
      void main() {
        float hop = abs(sin(uTime * aData.y + aData.x));
        vec3 p = vec3(position.x, hop * aData.z * 0.32, position.z);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float dx = position.x - uPlayX;
        float boost = 1.0 + uBoost * exp(-dx * dx / 2.2);
        vA = aData.w * (0.30 + 0.70 * hop) * boost * exp(-length(mv.xyz) * 0.012);
        gl_PointSize = aData.z * (62.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.08, d);
        gl_FragColor = vec4(vec3(0.58, 0.69, 0.9) * vA * a, 1.0);
      }`,
  });
  return new THREE.Points(g, mat);
}
const splash = buildSplash();
scene.add(splash);

/* ================= 地面光斑（雨越大越亮） ================= */
function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(210,225,255,0.45)');
  g.addColorStop(0.6, 'rgba(140,170,230,0.10)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
{
  const pos = [], data = [];
  for (let c = 0; c < N; c++) {
    const v = values[c];
    pos.push(times[c], 0.05, 0);
    data.push(0.55 + v * 0.17, Math.pow(v / 12.8, 1.7) * 0.16 + 0.012); // size, bright
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aData', new THREE.Float32BufferAttribute(data, 2));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTex: { value: glowTexture() }, uPlayX: { value: 0 }, uBoost: { value: 1.8 } },
    vertexShader: /* glsl */`
      uniform float uPlayX; uniform float uBoost;
      attribute vec2 aData; // size, bright
      varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float dx = position.x - uPlayX;
        vA = aData.y * (1.0 + uBoost * exp(-dx * dx / 3.0));
        gl_PointSize = aData.x * (420.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uTex;
      varying float vA;
      void main() {
        vec4 t = texture2D(uTex, gl_PointCoord);
        gl_FragColor = vec4(vec3(0.62, 0.74, 0.96) * t.rgb * vA, 1.0);
      }`,
  });
  const glow = new THREE.Points(g, mat);
  glow.frustumCulled = false;
  scene.add(glow);
}

/* ================= 播放头标记 ================= */
const playGroup = new THREE.Group();
{
  const mark = new THREE.Mesh(
    new THREE.PlaneGeometry(0.035, 1.7),
    new THREE.MeshBasicMaterial({ color: 0xdfe9ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  mark.position.y = 0.85;
  playGroup.add(mark);
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.05, 16),
    mark.material.clone()
  );
  dot.rotation.x = -Math.PI / 2;
  dot.position.y = 0.02;
  playGroup.add(dot);
  const glowMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 1.9),
    new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  glowMesh.rotation.x = -Math.PI / 2;
  glowMesh.position.set(0, 0.035, 0);
  playGroup.add(glowMesh);
  playGroup.userData.glow = glowMesh;
}
scene.add(playGroup);

/* ================= 空气中的浮尘 ================= */
{
  const count = 320;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = -2 + Math.random() * 28;
    pos[i * 3 + 1] = 0.2 + Math.random() * 10;
    pos[i * 3 + 2] = -6 + Math.random() * 12;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0x8fa4c4, size: 0.035, transparent: true, opacity: 0.35,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  scene.add(new THREE.Points(g, mat));
}

/* ================= 相机运镜 ================= */
const posCurve = new THREE.CatmullRomCurve3([
  new THREE.Vector3(7.5, 1.6, 6.5),
  new THREE.Vector3(11.0, 6.5, 17.0),
  new THREE.Vector3(13.5, 8.5, 24.0),
  new THREE.Vector3(19.0, 6.0, 21.0),
  new THREE.Vector3(21.5, 3.0, 12.0),
], true, 'centripetal');
const tgtCurve = new THREE.CatmullRomCurve3([
  new THREE.Vector3(8.5, 3.2, 0),
  new THREE.Vector3(10.0, 3.6, 0),
  new THREE.Vector3(11.5, 4.2, 0),
  new THREE.Vector3(16.5, 3.8, 0),
  new THREE.Vector3(17.0, 2.6, 0),
], true, 'centripetal');
const CAM_PERIOD = 46;

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 4;
controls.maxDistance = 60;
controls.maxPolarAngle = 1.48;

let manual = false, resumeAt = 0;
controls.addEventListener('start', () => { manual = true; });
controls.addEventListener('end', () => { resumeAt = performance.now() + 5000; });

/* ================= 面板 UI ================= */
const grid = document.getElementById('data-grid');
values.forEach((v, i) => {
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.innerHTML = `
    <span class="time">${fmt(times[i])}</span>
    <div class="val-row">
      <span class="val">${v.toFixed(1)}</span><span class="unit">mm/h</span>
    </div>
    <span class="edit">
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
        <path d="M1 3.2h6M10.2 3.2h.8M1 8.8h.8M5.4 8.8h5.6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
        <circle cx="8.6" cy="3.2" r="1.25" stroke="currentColor" stroke-width="1.1"/>
        <circle cx="3.2" cy="8.8" r="1.25" stroke="currentColor" stroke-width="1.1"/>
      </svg>
    </span>`;
  grid.appendChild(cell);
});
const cells = [...grid.children];

// 折线图
const svg = document.getElementById('rain-chart');
const CW = 224, CH = 92, PAD_L = 6, PAD_R = 6, PAD_T = 10, PAD_B = 16;
const cx = (h) => PAD_L + (h / DAY_HOURS) * (CW - PAD_L - PAD_R);
const cy = (v) => CH - PAD_B - (v / 13.8) * (CH - PAD_T - PAD_B);
{
  const pts = times.map((t, i) => `${cx(t)},${cy(values[i])}`).join(' ');
  let inner = `<polyline points="${pts}" fill="none" stroke="#dfe7ee" stroke-width="1.1"
    stroke-linejoin="round" opacity="0.85"/>`;
  times.forEach((t, i) => { inner += `<circle cx="${cx(t)}" cy="${cy(values[i])}" r="1.4" fill="#dfe7ee" opacity="0.85"/>`; });
  for (const h of [0, 6, 12, 18, 24]) {
    inner += `<text x="${cx(h)}" y="${CH - 4}" font-size="6.5" fill="#565d66"
      text-anchor="${h === 0 ? 'start' : h === 24 ? 'end' : 'middle'}"
      font-family="inherit">${String(h).padStart(2, '0')}:00</text>`;
  }
  inner += `<circle id="chart-marker" r="2.6" fill="#ffffff"/>
    <circle id="chart-halo" r="5.5" fill="none" stroke="#bcd2ff" stroke-width="0.8" opacity="0.7"/>`;
  svg.setAttribute('viewBox', `0 0 ${CW} ${CH}`);
  svg.innerHTML = inner;
}
const marker = document.getElementById('chart-marker');
const halo = document.getElementById('chart-halo');

const panel = document.getElementById('panel');
const toggle = document.getElementById('panel-toggle');
document.getElementById('panel-close').addEventListener('click', () => {
  panel.classList.add('hidden'); toggle.classList.add('show');
});
toggle.addEventListener('click', () => {
  panel.classList.remove('hidden'); toggle.classList.remove('show');
});

/* ================= 主循环 ================= */
const hudTime = document.getElementById('hud-time');
const hudValue = document.getElementById('hud-value');
const DAY_PERIOD = 64000;   // 一天回放时长 ms
const HOLD = 1400;          // 结尾停留

const clock = new THREE.Clock();
let dayT = 0;

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  // 播放头推进
  dayT += dt * 1000;
  const cycle = DAY_PERIOD + HOLD;
  const playMs = dayT % cycle;
  const playH = playMs <= DAY_PERIOD ? (playMs / DAY_PERIOD) * DAY_HOURS : DAY_HOURS;

  // 更新 shader uniforms
  for (const o of [rain, splash]) {
    o.material.uniforms.uTime.value = t;
    o.material.uniforms.uPlayX.value = playH;
  }

  // 播放头标记
  playGroup.position.x = playH;
  playGroup.userData.glow.material.opacity = 0.17 + 0.07 * Math.sin(t * 2.1);

  // HUD
  hudTime.textContent = fmt(playH);
  hudValue.textContent = valueAt(playH).toFixed(1);

  // 图表标记
  const mx = cx(playH), my = cy(valueAt(playH));
  marker.setAttribute('cx', mx); marker.setAttribute('cy', my);
  halo.setAttribute('cx', mx); halo.setAttribute('cy', my);

  // 表格高亮
  const active = Math.round((playH / DAY_HOURS) * (N - 1));
  cells.forEach((c, i) => c.classList.toggle('active', i === active));

  // 相机：手动拖拽后 5 秒无操作，平滑回归自动运镜
  if (manual && performance.now() > resumeAt) manual = false;
  if (!manual) {
    const k = 1 - Math.exp(-dt * 2.2);
    camera.position.lerp(posCurve.getPoint((t % CAM_PERIOD) / CAM_PERIOD), k);
    controls.target.lerp(tgtCurve.getPoint((t % CAM_PERIOD) / CAM_PERIOD), k);
  }
  controls.update();

  composer.render();
}
tick();

/* ================= 自适应 ================= */
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  bloom.setSize(innerWidth, innerHeight);
});
