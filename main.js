// 如果降雨数据变成雨 —— Three.js + WebGL + 自定义 GLSL 实时粒子雨景
// 雨幕 = 三层 GPU 实例化拉伸雨丝；雨脊高度 = 数据折线本身。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ═══════════════════ 1. 数据：26 个时间点，00:00 → 24:00 ═══════════════════ */
const N = 26;
const DAY_HOURS = 24;
const values = [
  2.1, 3.8, 9.9, 11.2, 11.9, 11.3, 8.7, 8.4, 4.1, 7.8,
  6.6, 3.4, 1.4, 5.6, 12.8, 12.4, 11.0, 6.7, 4.6, 7.4,
  5.9, 3.6, 2.2, 3.6, 6.6, 2.4,
];
const times = values.map((_, i) => (i * DAY_HOURS) / (N - 1)); // 小时
const VMAX = Math.max(...values);   // 12.8：全部归一化的分母
const STEP = times[1] - times[0];   // 0.96：相邻观测点的 x 间距
const AXIS_TOP = 13.9;              // y 轴顶端，略高于 VMAX

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
  return THREE.MathUtils.lerp(values[i], values[i + 1], seg - i);
};

/* ═══════════════════ 2. 空间与风的常量 ═══════════════════ */
const X0 = -1.8;                // 雨幕左边界：越过 00:00 一点，避免边缘断幕
const X1 = DAY_HOURS + 1.8;     // 雨幕右边界
const SPAN = X1 - X0;

// 三层雨。bright = 目标亮度比 近:中:远 = 1 : 0.55 : 0.22
// hMode: ridge=柱高跟着数据折线走（承载可读性）/ full=全高（前景大气）/ mix=折半（背景雾）
// px = 雨丝像素宽度（不是世界单位，随距离自动换算），soft = 伪散焦程度 0..1
// lowmix 只留 30% 全高：远景太高的话会把雨脊轮廓整条洗掉
const LAYERS = [
  { share: 0.022, zMin: 2.6, zMax: 8.4, hMode: 'full', spd: 1.30, len: 1.25, px: [2.4, 4.8], bright: 0.85, wind: 1.00, soft: 1.00 },
  { share: 0.638, zMin: -2.2, zMax: 2.2, hMode: 'ridge', spd: 1.00, len: 1.00, px: [1.30, 2.40], bright: 0.55, wind: 0.62, soft: 0.12 },
  { share: 0.340, zMin: -17.0, zMax: -4.2, hMode: 'lowmix', spd: 0.72, len: 0.86, px: [1.10, 1.85], bright: 0.15, wind: 0.25, soft: 0.34 },
];

const TILT_DEG = 6.2;                                            // 恒定风倾角
const TILT_TAN = Math.tan(TILT_DEG * Math.PI / 180);
const WIND_DIR = new THREE.Vector2(0.965, 0.262).normalize();     // 世界 XZ 风向：朝画面右前
const FOG_D = 0.026;                                              // FogExp2 密度，自定义着色器共用
const BG_COL = 0x02040a;
const RAIN_GAIN = 0.0142;   // 雨滴总亮度：20 万颗加性叠加，单颗必须极轻才糊不成白墙
const LEN_K = 0.0044;      // 拖尾系数：len = LEN_K·speed²，等效快门时间

/* ═══════════════════ 3. 质量档（移动端自动降级） ═══════════════════ */
const COARSE = matchMedia('(pointer: coarse)').matches;
const MOBILE = COARSE || Math.min(innerWidth, innerHeight) < 720;
// 用一次性探针判断是不是核显/软件渲染：集显上后期链的填充率是主要瓶颈，先降档再跑
const LOW_GPU = (() => {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const r = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : (gl ? gl.getParameter(gl.RENDERER) : ''));
    const lost = !gl || /swiftshader|llvmpipe|software|basic render/i.test(r);
    if (gl.getExtension('WEBGL_lose_context')) gl.getExtension('WEBGL_lose_context').loseContext();
    return lost || /intel.*(uhd|hd graphics|iris)/i.test(r);
  } catch { return false; }
})();
const Q = MOBILE
  ? { rain: 78000, splash: 9000, focus: false, dpr: 1.0, bloomScale: 0.5, gain: 1.15 }
  : LOW_GPU
    ? { rain: 130000, splash: 18000, focus: true, dpr: 1.0, bloomScale: 0.5, gain: 1.0 }
    : { rain: 165000, splash: 22000, focus: true, dpr: 1.5, bloomScale: 0.6, gain: 1.0 };
const RAIN_MIN = 40000;   // 性能调节器下限：再低就读不出连续雨幕

/* ═══════════════════ 4. 渲染器 / 场景 / 相机 ═══════════════════ */
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, Q.dpr));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;     // 旧值 0.85 把雨压得太暗；软肩已保证高光不削顶

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x01030a);
scene.fog = new THREE.FogExp2(BG_COL, FOG_D);

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 320);
camera.position.set(4.0, 0.7, 8.0);

const _dbs = new THREE.Vector2();
const pxScale = () => {                  // 世界→像素系数，用来把雨丝宽度精确写成"像素"
  renderer.getDrawingBufferSize(_dbs);
  return _dbs.y / (2 * Math.tan((camera.fov * Math.PI / 180) / 2));
};

/* ═══════════════════ 5. GLSL 公共片段 ═══════════════════ */
const GLSL_NOISE = /* glsl */`
  float hash21(vec2 p){
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i),                 hash21(i + vec2(1.0, 0.0)), u.x),
               mix(hash21(i + vec2(0.0,1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // 势场取旋度 => 无散度水平扰动：阵风不会把雨幕向外炸开
  vec2 curl2D(vec2 p){
    const float e = 0.12;
    float a = vnoise(p + vec2(0.0,  e));
    float b = vnoise(p - vec2(0.0,  e));
    float c = vnoise(p + vec2( e, 0.0));
    float d = vnoise(p - vec2( e, 0.0));
    return vec2(a - b, -(c - d)) / (2.0 * e);
  }
  float extinction(float d, float fogD){          // 加性粒子的大气消光 = 直接乘掉亮度
    float f = d * fogD;
    return exp(-f * f);
  }
`;

/* ═══════════════════ 6. 数据 → 视觉映射 ═══════════════════ */
const speedAt = (v) => 9 + 0.55 * v;                 // v → 落速（世界单位/秒）
const colSigma = (v) => 0.35 + 0.055 * v;            // v → 列宽
function lambdaAt(x) {
  const v = valueAt(x);
  const nearest = Math.round(THREE.MathUtils.clamp(x, 0, DAY_HOURS) / STEP) * STEP;
  const d = x - nearest;
  const s = colSigma(v) * 1.35;
  const bump = Math.exp(-(d * d) / (2 * s * s));
  // 密度 ∝ v^0.75（小雨不消失、大雨不糊死）；柱心密、柱间由相邻两列插值填充
  return Math.pow(v / VMAX, 0.75) * (0.60 + 0.40 * bump);   // 落差收窄：柱间也有雨，才连成幕而不是一根根柱子
}
const ridgeAt = (x) => valueAt(x);                   // 雨脊高度 = 数据本身（1 mm/h = 1 世界单位）

const rnd = () => Math.random();
const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2.0) / 1.2;   // 近似正态，用于中景 z 向厚度

/* ═══════════════════ 7. 雨幕：实例化拉伸雨丝 ═══════════════════ */
// 每滴属性打包（共 12 float）：
//   aDrop   = (x, z, phase, colIndex)
//   aMotion = (speed, len, pxWidth, bright)
//   aMeta   = (val, windWeight, H, soft)
// layer 不再单独占位——它已被离线折进 pxWidth / bright / H / soft 四个常数里。
function buildRainCurtain() {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);

  const cap = Q.rain;
  const aDrop = new Float32Array(cap * 4);
  const aMotion = new Float32Array(cap * 4);
  const aMeta = new Float32Array(cap * 4);
  const splashSrc = [];   // 从中景滴里抽一部分，做与雨滴同相位的溅射

  let n = 0;
  for (let li = 0; li < LAYERS.length; li++) {
    const L = LAYERS[li];
    const stop = Math.min(cap, n + Math.floor(cap * L.share));
    let guard = 0;
    while (n < stop && guard < stop * 40 + 4000) {
      guard++;
      const x = X0 + rnd() * SPAN;
      if (rnd() > lambdaAt(x)) continue;            // 拒绝采样：密度场直接决定实例分布
      const v = valueAt(x);
      const spd = speedAt(v) * L.spd * (0.88 + rnd() * 0.26);
      let len = (LEN_K + rnd() * 0.0006) * spd * spd * L.len;   // 拖尾 ∝ speed²
      const ridge = ridgeAt(x);
      const H = L.hMode === 'ridge' ? ridge : L.hMode === 'full' ? AXIS_TOP : ridge * 0.70 + AXIS_TOP * 0.30;
      len = Math.min(len, H * 0.82);
      const px = L.px[0] + rnd() * (L.px[1] - L.px[0]);
      const bright = RAIN_GAIN * (0.55 + 1.15 * Math.pow(v / VMAX, 0.5)) * L.bright * (0.55 + rnd() * 0.75);
      const z = li === 1
        ? THREE.MathUtils.clamp(gauss() * 0.95, L.zMin, L.zMax)
        : L.zMin + rnd() * (L.zMax - L.zMin);

      const i4 = n * 4;
      aDrop[i4] = x; aDrop[i4 + 1] = z; aDrop[i4 + 2] = rnd(); aDrop[i4 + 3] = x / STEP;
      aMotion[i4] = spd; aMotion[i4 + 1] = len; aMotion[i4 + 2] = px; aMotion[i4 + 3] = bright;
      aMeta[i4] = v; aMeta[i4 + 1] = L.wind; aMeta[i4 + 2] = H; aMeta[i4 + 3] = L.soft;

      if (li === 1 && rnd() < 0.055 + 0.021 * v) splashSrc.push(x, z, aDrop[i4 + 2], spd, H, v);
      n++;
    }
  }

  geo.setAttribute('aDrop', new THREE.InstancedBufferAttribute(aDrop, 4));
  geo.setAttribute('aMotion', new THREE.InstancedBufferAttribute(aMotion, 4));
  geo.setAttribute('aMeta', new THREE.InstancedBufferAttribute(aMeta, 4));
  geo.instanceCount = n;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(DAY_HOURS / 2, AXIS_TOP / 2, 0), 70);

  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,   // billboard 的绕序会随相机越过雨丝轴向时翻转，任何一侧都不能被剔除
    uniforms: {
      uTime: { value: 0 },
      uPlayX: { value: 0 },
      uBoost: { value: 1.15 },     // 播放头邻域提亮（旧的 1.6 太宽，糊成一片）
      uSigma: { value: 1.1 },      // 高斯半径²：越小光带越窄越利落
      uPxScale: { value: 1400 },
      uWindDir: { value: WIND_DIR },
      uTilt: { value: TILT_TAN },
      uFogD: { value: FOG_D },
      uGain: { value: Q.gain },
    },
    vertexShader: GLSL_NOISE + /* glsl */`
      uniform float uTime, uPlayX, uBoost, uSigma, uPxScale, uTilt, uFogD, uGain;
      uniform vec2 uWindDir;
      attribute vec4 aDrop;
      attribute vec4 aMotion;
      attribute vec4 aMeta;
      varying vec2 vUv;
      varying vec3 vTint;
      varying float vA;
      varying float vSoft;

      void main(){
        float x = aDrop.x, z = aDrop.y, phase = aDrop.z, colIdx = aDrop.w;
        float speed = aMotion.x, len = aMotion.y, pxw = aMotion.z, bright = aMotion.w;
        float val = aMeta.x, windW = aMeta.y, H = aMeta.z;
        vSoft = aMeta.w;

        // 下落循环：p=0 在柱顶，p=1 恰好触地
        float p = fract(phase + uTime * speed / H);
        float y = H * (1.0 - p);

        // 顶部淡入用固定世界高度：短柱只淡 15% 会一帧闪完（硬 pop）
        float appear = 1.0 - smoothstep(H - clamp(H * 0.14, 0.32, 1.30), H, y);   // 雨脊上沿要利落，轮廓才读得出折线

        // 尾端贴地即被压短，所以永远看得到雨打在地面上，而不是悬空消失
        float tailLen = min(len, y);
        float land = pow(clamp(y / max(len, 0.001), 0.0, 1.0), 0.6);

        // 风：恒定倾角位移 + 低频 curl 阵风；近景权重高 => 视差强
        float fall = H - y;
        vec2 curl = curl2D(vec2(x * 0.35 + colIdx * 0.37, uTime * 0.15 + z * 0.22));
        vec2 xz = vec2(x, z) + uWindDir * (fall * uTilt) * windW + curl * (0.42 * windW);

        vec3 head = vec3(xz.x, y, xz.y);
        vec3 vd = normalize(vec3(uWindDir.x * uTilt * windW, -1.0, uWindDir.y * uTilt * windW));
        vec3 tail = head + vd * tailLen;

        // 色温随强度：小雨深青蓝，大雨近白
        vTint = mix(vec3(0.35, 0.55, 1.00), vec3(0.85, 0.93, 1.00), smoothstep(3.2, 11.5, val));

        float dx = x - uPlayX;
        float boost = 1.0 + uBoost * exp(-dx * dx / uSigma);
        vTint = mix(vTint, vec3(1.0, 0.66, 0.34), 0.26 * (boost - 1.0) / uBoost);

        vec3 toCam = head - cameraPosition;
        float dist = length(toCam);
        vec3 side = cross(vd, toCam);
        float sl = length(side);
        side = sl > 1e-5 ? side / sl : vec3(1.0, 0.0, 0.0);

        float tPar = 0.5 - position.y;                       // 0 = 头部，1 = 尾部
        float wWorld = (pxw * dist / uPxScale) * (1.0 + vSoft * 0.6);
        vec3 world = mix(head, tail, tPar)
                   + side * (position.x * wWorld * 2.0 + tPar * tPar * 0.06 * windW);  // 后者 = 雨丝略弯

        vA = bright * appear * land * boost * extinction(dist, uFogD) * uGain;
        vUv = vec2(position.x + 0.5, tPar);
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec2 vUv;
      varying vec3 vTint;
      varying float vA;
      varying float vSoft;
      void main(){
        float lx = abs(vUv.x - 0.5) * 2.0;
        float ty = vUv.y;
        // 横向一律用高斯：quad 只有 2–3px 宽时 smoothstep 会糊成一根硬边砖块
        float core = exp(-lx * lx * 2.2);
        float fade = mix(pow(1.0 - ty, 1.35), 0.35 + 0.65 * pow(1.0 - ty, 1.1), vSoft);
        float prof = core * fade;
        float hot = prof * prof * prof * prof;                 // 高光芯推到 >1，交给 bloom 捡
        vec3 c = vTint * (prof * 0.55 + hot * 0.50) + vec3(1.0, 0.97, 0.94) * hot * 0.26;
        gl_FragColor = vec4(c * vA, 1.0);
      }`,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  return { mesh, geo, mat, total: n, splashSrc };
}

/* ═══════════════════ 8. 落地溅射 + 涟漪（与雨滴同相位） ═══════════════════ */
function buildSplash(src) {
  const count = Math.min(Q.splash, Math.floor(src.length / 6));
  const aS = new Float32Array(count * 4);   // x, z, phase, 周期 T
  const aR = new Float32Array(count * 4);   // rmax, bright, val, rand
  for (let i = 0; i < count; i++) {
    const s = i * 6;
    const x = src[s], z = src[s + 1], phase = src[s + 2], spd = src[s + 3], H = src[s + 4], v = src[s + 5];
    aS[i * 4] = x; aS[i * 4 + 1] = z; aS[i * 4 + 2] = phase; aS[i * 4 + 3] = H / spd;  // 同一个 T => 落地时刻对齐
    aR[i * 4] = 0.16 + 0.055 * v;                // 涟漪半径 ∝ 雨量
    aR[i * 4 + 1] = (0.002 + 0.0055 * Math.pow(v / VMAX, 0.8)) * (0.5 + rnd() * 0.8);
    aR[i * 4 + 2] = v;
    aR[i * 4 + 3] = rnd();
  }

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 2, 1, 0, 3, 2]);               // 地面环从上方看需要反向绕序
  geo.setAttribute('aS', new THREE.InstancedBufferAttribute(aS, 4));
  geo.setAttribute('aR', new THREE.InstancedBufferAttribute(aR, 4));
  geo.instanceCount = count;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(DAY_HOURS / 2, 0, 0), 40);

  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 }, uPlayX: { value: 0 }, uBoost: { value: 1.5 },
      uSigma: { value: 1.1 }, uFogD: { value: FOG_D }, uGain: { value: Q.gain },
    },
    vertexShader: GLSL_NOISE + /* glsl */`
      uniform float uTime, uPlayX, uBoost, uSigma, uFogD, uGain;
      attribute vec4 aS;
      attribute vec4 aR;
      varying vec2 vUv;
      varying vec3 vTint;
      varying float vA;
      varying float vThin;
      void main(){
        // 与雨滴同一个 fract 相位：p 刚回绕 = 刚刚落地
        float p = fract(aS.z + uTime / aS.w);
        float life = clamp(p / 0.40, 0.0, 1.0);          // 环只活 40% 个下落周期
        float r = aR.x * (0.14 + 0.86 * pow(life, 0.62)) * (1.0 + 0.35 * aR.w);
        float fade = pow(1.0 - life, 1.75);
        float crown = pow(1.0 - clamp(p / 0.05, 0.0, 1.0), 3.0);   // 触地瞬间的一下闪光

        float dx = aS.x - uPlayX;
        float boost = 1.0 + uBoost * exp(-dx * dx / uSigma);
        vec2 drift = vec2(0.965, 0.262) * (life * 0.35);  // 顺着风向偏移
        vec3 wp = vec3(aS.x + drift.x + position.x * r, 0.010 + 0.02 * aR.w, aS.y + drift.y + position.z * r);
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        vTint = mix(vec3(0.36, 0.56, 1.00), vec3(0.86, 0.93, 1.00), smoothstep(3.2, 11.5, aR.z));
        vA = aR.y * (fade + crown * 0.9) * boost * extinction(-mv.z, uFogD) * uGain;
        vThin = 0.10 + 0.16 * life;                      // 环越扩越细
        vUv = uv;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec2 vUv;
      varying vec3 vTint;
      varying float vA;
      varying float vThin;
      void main(){
        vec2 q = (vUv - 0.5) * 2.0;
        float d = length(q);
        float ring = exp(-pow((d - 0.90) / vThin, 2.0));
        float inner = exp(-d * d * 3.0) * 0.16;
        gl_FragColor = vec4(vTint * (ring + inner) * vA, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  return { mesh, geo, mat, total: count };
}

/* ═══════════════════ 9. 假体积光晕（密度场驱动，不做真实体积渲染） ═══════════════════ */
function buildGlow() {
  const COLS = 79;                    // 沿 x 每 ~0.33 小时一个光晕，保证雨幕连续
  const aP = new Float32Array(COLS * 4);   // x, 中心 y, 半宽, 半高
  const aC = new Float32Array(COLS * 4);   // alpha, 暖度, val, rand
  for (let i = 0; i < COLS; i++) {
    const x = X0 + (i / (COLS - 1)) * SPAN;
    const v = valueAt(x);
    const shaft = THREE.MathUtils.smoothstep(v, 4.0, 12.0);   // 只在雨最密处起晕
    aP[i * 4] = x; aP[i * 4 + 1] = v * 0.52;
    aP[i * 4 + 2] = 0.90 + colSigma(v) * 2.6;
    aP[i * 4 + 3] = v * 0.90 + 0.9;
    aC[i * 4] = 0.0020 + 0.009 * shaft + 0.0025 * (v / VMAX);   // 光晕只是"空气里有光"，不能变成白柱
    aC[i * 4 + 1] = shaft * shaft * 0.5;                       // 暖度只给最密的几根脊
    aC[i * 4 + 2] = v;
    aC[i * 4 + 3] = rnd();
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute('aP', new THREE.InstancedBufferAttribute(aP, 4));
  geo.setAttribute('aC', new THREE.InstancedBufferAttribute(aC, 4));
  geo.instanceCount = COLS;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(DAY_HOURS / 2, 6, 0), 40);

  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uPlayX: { value: 0 }, uFogD: { value: FOG_D } },
    vertexShader: GLSL_NOISE + /* glsl */`
      uniform float uTime, uPlayX, uFogD;
      attribute vec4 aP;
      attribute vec4 aC;
      varying vec2 vUv;
      varying float vA;
      varying float vWarm;
      void main(){
        vec3 wp = vec3(aP.x, aP.y, -1.6);
        vec3 toCam = wp - cameraPosition;
        vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
        vec3 up = normalize(cross(toCam, right));
        float breathe = 1.0 + 0.09 * sin(uTime * 0.42 + aC.w * 6.2832);
        wp += right * (position.x * aP.z * 2.0 * breathe) + up * (position.y * aP.w * 2.0 * breathe);
        float dx = aP.x - uPlayX;
        vA = aC.x * (1.0 + 0.85 * exp(-dx * dx / 2.4)) * extinction(length(toCam), uFogD);
        vWarm = aC.y;
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec2 vUv;
      varying float vA;
      varying float vWarm;
      void main(){
        vec2 q = (vUv - 0.5) * 2.0;
        vec2 o = q - vec2(-0.24, 0.30);            // 主光从左上：高斯核朝左上偏
        float core = exp(-dot(q, q) * 2.4);
        float lean = exp(-dot(o, o) * 1.15);
        vec3 c = mix(vec3(0.30, 0.46, 0.86), vec3(1.0, 0.60, 0.30), vWarm);
        gl_FragColor = vec4(c * (core * 0.55 + core * lean * 0.9) * vA, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return { mesh, mat };
}

/* ═══════════════════ 10. 湿润地面（解析镜面反射雨幕光场） ═══════════════════ */
// 1D 光场纹理：R = 锐利的 v(x)/AXIS_TOP，G = 抹平的 v(x)/AXIS_TOP（湿沥青的反射天然糊）
function profileTexture() {
  const W = 512;
  const data = new Uint8Array(W * 4);
  const blur = (x) => {
    let s = 0, w = 0;
    for (let k = -3; k <= 3; k++) {
      const g = Math.exp(-((k * 0.34) * (k * 0.34)) / 0.5);
      s += valueAt(x + k * 0.34) * g; w += g;
    }
    return s / w;
  };
  for (let i = 0; i < W; i++) {
    const x = X0 + (i / (W - 1)) * SPAN;
    data[i * 4] = Math.round(255 * THREE.MathUtils.clamp(valueAt(x) / AXIS_TOP, 0, 1));
    data[i * 4 + 1] = Math.round(255 * THREE.MathUtils.clamp(blur(x) / AXIS_TOP, 0, 1));
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, W, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

function buildFloor() {
  const geo = new THREE.PlaneGeometry(200, 140, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uProf: { value: profileTexture() },
      uTime: { value: 0 }, uPlayX: { value: 0 }, uFogD: { value: FOG_D },
      uSpan: { value: new THREE.Vector2(X0, SPAN) },
      uTop: { value: AXIS_TOP },
      uFogCol: { value: HORIZON },   // 与背景地平线同色 => 天地无接缝
    },
    vertexShader: /* glsl */`
      varying vec3 vW;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: GLSL_NOISE + /* glsl */`
      precision highp float;
      uniform sampler2D uProf;
      uniform float uTime, uFogD, uTop, uPlayX;
      uniform vec2 uSpan;
      uniform vec3 uFogCol;
      varying vec3 vW;

      // 把整片雨近似成 z=0 平面上的一张发光场 G(x, y)
      float field(float x, float y, float blur){
        float u = clamp((x - uSpan.x) / uSpan.y, 0.0, 1.0);
        float a = texture2D(uProf, vec2(u, 0.5)).r;
        float b = texture2D(uProf, vec2(u, 0.5)).g;
        float v = mix(a, b, blur) * uTop;
        float ridge = max(v, 0.02);
        float under = 1.0 - smoothstep(ridge * 0.72, ridge, y);
        return (v / uTop) * under * (0.35 + 0.65 * pow(1.0 - clamp(y / ridge, 0.0, 1.0), 1.35));
      }

      void main(){
        vec3 dir = normalize(vW - cameraPosition);
        float dist = length(vW - cameraPosition);

        // 镜面反射：视线打在地面后按法线翻折，与雨幕平面 z=0 求交
        vec3 rd = vec3(dir.x, -dir.y, dir.z);
        float t = rd.z < -1e-4 ? (-vW.z / rd.z) : -1.0;
        float g = 0.0;
        if (t > 0.0) {
          vec3 hit = vW + rd * t;
          float yr = clamp(hit.y, 0.0, uTop);
          float reflBlur = clamp(0.50 + yr * 0.22, 0.0, 1.0);
          float spread = 0.26 + yr * 0.12;                 // 越高越糊 => 三点采样
          g = field(hit.x, yr, reflBlur) * 0.55
            + field(hit.x + spread, yr, reflBlur) * 0.225
            + field(hit.x - spread, yr, reflBlur) * 0.225;
        }
        // 湿斑：低频噪声决定哪里积水，干处几乎不反射
        float wet = smoothstep(0.34, 0.80, vnoise(vW.xz * 0.16) * 0.68 + vnoise(vW.xz * 0.62) * 0.32);
        float fres = pow(1.0 - clamp(-dir.y, 0.0, 1.0), 3.2);
        float sheen = g * (0.0014 + 0.013 * wet * (0.25 + fres * 0.85));   // 反射只比雨幕本身暗一档

        float key = exp(-pow((vW.x - 6.0) / 16.0, 2.0)) * exp(-pow((vW.z + 9.0) / 13.0, 2.0));
        float grain = vnoise(vW.xz * 7.0) * 0.5 + vnoise(vW.xz * 23.0) * 0.5;

        vec3 col = vec3(0.0035, 0.0058, 0.0115) * (0.55 + 0.75 * grain)
                 + vec3(0.004, 0.006, 0.012) * key * (0.30 + 0.70 * wet)
                 + vec3(0.42, 0.60, 1.00) * sheen;
        // 播放头脚下一汪暖光
        float pd = abs(vW.x - uPlayX);
        col += vec3(1.0, 0.58, 0.26) * exp(-pd * pd * 0.9) * exp(-abs(vW.z) * 0.30) * 0.006;

        col = mix(col, uFogCol, 1.0 - extinction(dist, uFogD));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(DAY_HOURS / 2, 0, -14);
  mesh.renderOrder = -5;
  return { mesh, mat };
}

/* ═══════════════════ 11. 背景渐变（给雨脊一个可读的暗底） ═══════════════════ */
// 地平线色 = 雾色提亮一档；地面远处也雾化成同一个颜色 => 天地接缝彻底消失
const HORIZON = new THREE.Color(BG_COL).multiplyScalar(3.8);
const ZENITH = new THREE.Color(BG_COL).multiplyScalar(0.45);
function buildBackdrop() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uHor: { value: HORIZON }, uZen: { value: ZENITH } },
    vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform vec3 uHor, uZen;
      varying vec3 vP;
      void main(){
        float h = clamp(vP.y / 150.0, 0.0, 1.0);
        float band = exp(-pow(h / 0.11, 2.0)) * 0.50;      // 地平线上的一条冷光带，勾出雨脊
        gl_FragColor = vec4(mix(uHor, uZen, smoothstep(0.0, 0.34, h)) + uHor * band, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(150, 24, 16), mat);
  mesh.renderOrder = -10;
  return mesh;
}

/* ═══════════════════ 12. 坐标轴与标注 ═══════════════════ */
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
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, fog: false });
  return { sprite: new THREE.Sprite(mat), aspect: c.width / c.height };
}
function addLabel(text, x, y, z, h, opts) {
  const { sprite, aspect } = makeLabel(text, opts);
  sprite.scale.set(h * aspect, h, 1);
  sprite.position.set(x, y, z);
  sprite.renderOrder = 60;                 // 标注是坐标轴，不是场景物件 => 永远浮在雨幕上
  scene.add(sprite);
  return sprite;
}
{
  const axisMat = new THREE.LineBasicMaterial({ color: 0xbcd0ee, transparent: true, opacity: 0.26, fog: false, depthWrite: false });
  const tickMat = new THREE.LineBasicMaterial({ color: 0x9fb6d8, transparent: true, opacity: 0.14, fog: false, depthWrite: false });
  scene.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-1.4, 0, 0), new THREE.Vector3(DAY_HOURS + 1.4, 0, 0)]), axisMat));
  scene.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, AXIS_TOP, 0)]), axisMat));
  const tickVerts = [];
  for (let h = 0; h <= DAY_HOURS; h += 2) {
    tickVerts.push(new THREE.Vector3(h, 0, 0), new THREE.Vector3(h, -0.34, 0));
    addLabel(`${String(h).padStart(2, '0')}:00`, h, -0.86, 0.6, 0.34);
  }
  for (const v of [6.4, 12.8]) {
    tickVerts.push(new THREE.Vector3(0, v, 0), new THREE.Vector3(-0.34, v, 0));
    addLabel(v.toFixed(1), -1.05, v, 0.6, 0.34);
  }
  addLabel('毫米/小时', -1.45, AXIS_TOP - 0.35, 0.6, 0.34);
  scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(tickVerts), tickMat));
}

/* ═══════════════════ 13. 播放头：绕 Y 朝向相机的光刃 + 贴地光池 ═══════════════════ */
const playGroup = new THREE.Group();
const bladeMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  uniforms: { uInt: { value: 1 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform float uInt;
    varying vec2 vUv;
    void main(){
      float x = (vUv.x - 0.5) * 2.0;
      float core = exp(-x * x * 30.0);
      float halo = exp(-x * x * 3.4);
      float vert = smoothstep(1.0, 0.72, vUv.y) * smoothstep(0.0, 0.10, vUv.y);
      vec3 c = mix(vec3(1.0, 0.63, 0.32), vec3(0.80, 0.90, 1.00), 0.5);
      // 光刃只是"标尺"，亮度必须低于雨幕本体，否则会把整幅画冲白
      gl_FragColor = vec4(c * (core * 0.11 + halo * 0.030) * vert * uInt, 1.0);
    }`,
});
// 播放头水汪必须是高斯衰减：之前用 MeshBasicMaterial 铺一块均匀色，边缘就是一条硬矩形
const playPoolMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  uniforms: { uInt: { value: 0.05 }, uWarm: { value: 0.55 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform float uInt, uWarm;
    varying vec2 vUv;
    void main(){
      vec2 q = (vUv - 0.5) * 2.0;
      float g = exp(-dot(q, q) * 2.4);
      vec3 c = mix(vec3(0.40, 0.56, 0.92), vec3(1.0, 0.62, 0.32), uWarm);
      gl_FragColor = vec4(c * g * g * uInt, 1.0);
    }`,
});
{
  const blade = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bladeMat);
  blade.scale.set(1.0, 6.0, 1);
  blade.position.y = 3.0;
  blade.renderOrder = 8;
  playGroup.add(blade);

  const pool = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), playPoolMat);
  pool.rotation.x = -Math.PI / 2;
  pool.scale.set(2.8, 6.4, 1);
  pool.position.y = 0.015;
  pool.renderOrder = 3;
  playGroup.add(pool);

  const tick = new THREE.Mesh(
    new THREE.PlaneGeometry(0.04, 0.5),
    new THREE.MeshBasicMaterial({ color: 0xffd9b8, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false })
  );
  tick.position.y = 0.25;
  tick.renderOrder = 62;
  playGroup.add(tick);

  playGroup.userData = { blade, pool, tick };
}
scene.add(playGroup);

/* ═══════════════════ 14. 空气中的浮尘 ═══════════════════ */
const dustMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uTime: { value: 0 }, uFogD: { value: FOG_D }, uPxScale: { value: 1400 } },
  vertexShader: GLSL_NOISE + /* glsl */`
    uniform float uTime, uFogD, uPxScale;
    attribute vec3 aData;
    varying float vA;
    void main(){
      vec3 p = position;
      p.x += sin(uTime * 0.11 + aData.x * 6.2832) * 1.4 + uTime * 0.10;
      p.y += sin(uTime * 0.07 + aData.x * 3.11) * 0.5;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      vA = aData.z * extinction(-mv.z, uFogD);
      gl_PointSize = clamp(aData.y * (uPxScale * 0.004 / max(-mv.z, 0.2)), 1.0, 7.0);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    precision highp float;
    varying float vA;
    void main(){
      float d = length(gl_PointCoord - 0.5);
      gl_FragColor = vec4(vec3(0.55, 0.68, 0.95) * exp(-d * d * 7.0) * vA, 1.0);
    }`,
});
{
  const count = MOBILE ? 420 : 1100;
  const pos = new Float32Array(count * 3);
  const dat = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = X0 + rnd() * SPAN;
    pos[i * 3 + 1] = 0.15 + Math.pow(rnd(), 1.6) * 11;
    pos[i * 3 + 2] = -12 + rnd() * 18;
    dat[i * 3] = rnd(); dat[i * 3 + 1] = 0.5 + rnd() * 1.6; dat[i * 3 + 2] = 0.004 + rnd() * 0.010;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aData', new THREE.BufferAttribute(dat, 3));
  const pts = new THREE.Points(g, dustMat);
  pts.frustumCulled = false;
  pts.renderOrder = 7;
  scene.add(pts);
}

/* ═══════════════════ 15. 组装场景 ═══════════════════ */
scene.add(buildBackdrop());
const floor = buildFloor(); scene.add(floor.mesh);
const glow = buildGlow(); scene.add(glow.mesh);
const curtain = buildRainCurtain(); scene.add(curtain.mesh);
const splash = buildSplash(curtain.splashSrc); scene.add(splash.mesh);

/* ═══════════════════ 16. 后期链 ═══════════════════ */
// 注意：这里不能开 samples(MSAA)。HalfFloat + 多重采样离屏缓冲在部分集显/ANGLE 驱动上
// 会得到不完整的帧缓冲，整条后期链直接输出全黑；雨丝本身是软边，MSAA 收益也极小。
const rt = new THREE.WebGLRenderTarget(
  innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio(),
  { type: THREE.HalfFloatType }
);
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));

// 近景虚化做在粒子级（LAYERS[0].soft + px 2.4–6.2px）；这里只补一层亮部柔焦/光渗
const focusPass = new ShaderPass({
  name: 'SoftFocus',
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uKey: { value: 0.72 },     // 只对超过阈值的亮部渗开，暗部保持干净
    uAmt: { value: 0.30 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uKey, uAmt;
    varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 5; i++){
        float a = float(i) * 2.399963;                 // 黄金角螺旋 5 抽头
        vec2 o = vec2(cos(a), sin(a)) * uTexel * (1.0 + float(i) * 0.9) * 2.2;
        acc += texture2D(tDiffuse, vUv + o).rgb;
      }
      float k = smoothstep(uKey, uKey + 0.9, max(max(c.r, c.g), c.b));
      gl_FragColor = vec4(c.rgb + (acc / 5.0) * k * uAmt, c.a);
    }`,
});
focusPass.enabled = Q.focus;
composer.addPass(focusPass);

const bloom = new UnrealBloomPass(
  new THREE.Vector2(innerWidth * Q.bloomScale, innerHeight * Q.bloomScale),
  0.46, 0.85, 0.50          // strength, radius, threshold —— 低阈值大半径：把硬高光匀开，而不是只点亮
);
composer.addPass(bloom);

// 暗角 + 细颗粒 + 极轻色差 + lift/gamma 调色（替代 CSS 的 #grain 全屏抖动）
const gradePass = new ShaderPass({
  name: 'Grade',
  uniforms: {
    tDiffuse: { value: null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uVig: { value: 0.46 },
    uGrain: { value: 0.020 },
    uCA: { value: 0.40 },     // 画面边缘的最大色差像素数
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uRes;
    uniform float uTime, uVig, uGrain, uCA;
    varying vec2 vUv;
    float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c) * 2.0;
      vec2 ca = c * (uCA * uRes.y / uRes) * (0.35 + r2 * 2.0) * 0.0016;
      vec3 col = vec3(
        texture2D(tDiffuse, vUv + ca).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv - ca).b
      );
      col = max(col, 0.0);
      col *= vec3(0.985, 1.0, 1.045);          // 轻微冷偏
      col += vec3(0.0035, 0.0055, 0.0115);     // 冷色 lift：保住暗部不死黑
      col = pow(col, vec3(1.0, 0.985, 0.975));
      col = col / (1.0 + col * 0.24);            // 高光软肩：加性叠加的平顶白会被压成滚降，边缘不再刀切
      col *= 1.0 - uVig * smoothstep(0.28, 1.02, r2);
      col += (h21(vUv * uRes + fract(uTime) * 137.0) - 0.5) * uGrain * (0.35 + 0.65 * (1.0 - length(col)));
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }`,
});
composer.addPass(gradePass);
composer.addPass(new OutputPass());

/* ═══════════════════ 17. 镜头段落（时间轴驱动，不再每帧 lerp 追点） ═══════════════════ */
// wide = 手持幅度权重：贴地近景小、拉远全景大
const SHOTS = [
  { dur: 8.5, wide: 0.22, p0: [3.0, 0.50, 7.4], p1: [9.4, 0.72, 8.6], t0: [7.0, 1.5, -0.3], t1: [12.6, 2.1, -0.5] },
  { dur: 8.0, wide: 0.55, p0: [9.4, 0.72, 8.6], p1: [3.4, 5.6, 18.2], t0: [12.6, 2.1, -0.5], t1: [11.4, 5.0, -0.2] },
  { dur: 7.5, wide: 0.30, p0: [3.4, 5.6, 18.2], p1: [13.9, 3.1, 6.4], t0: [11.4, 5.0, -0.2], t1: [14.4, 8.6, -0.4] },
  { dur: 7.0, wide: 0.26, p0: [13.9, 3.1, 6.4], p1: [17.6, 2.0, 4.9], t0: [14.4, 8.6, -0.4], t1: [15.6, 3.6, -0.3] },
  { dur: 8.0, wide: 1.00, p0: [17.6, 2.0, 4.9], p1: [3.0, 0.50, 7.4], t0: [15.6, 3.6, -0.3], t1: [7.0, 1.5, -0.3] },
];
const SHOT_LOOP = SHOTS.reduce((a, s) => a + s.dur, 0);   // 39s 一轮：贴地 → 抬升 → 推近 → 拉远
const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const lerp3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

function shotPose(time) {
  let t = time % SHOT_LOOP;
  let i = 0;
  while (i < SHOTS.length - 1 && t > SHOTS[i].dur) { t -= SHOTS[i].dur; i++; }
  const s = SHOTS[i];
  const u = easeInOutCubic(THREE.MathUtils.clamp(t / s.dur, 0, 1));
  return { p: lerp3(s.p0, s.p1, u), t: lerp3(s.t0, s.t1, u), wide: s.wide };
}

// 1D value noise：手持感用它，比 sin 叠加更像真人呼吸
const NOISE_TABLE = new Float32Array(256).map(() => Math.random() * 2 - 1);
function noise1(x) {
  const i = Math.floor(x), f = x - i;
  const a = NOISE_TABLE[i & 255], b = NOISE_TABLE[(i + 1) & 255];
  return a + (b - a) * (f * f * (3 - 2 * f));
}

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 1.2;
controls.maxDistance = 70;
controls.maxPolarAngle = 1.565;   // 留够余量：1.52 会把贴地机位强行拽起来，和段落机位打架

let manual = false, resumeAt = 0, blendFrom = null, blendStart = 0;
const BLEND_WAIT = 4000;    // 松手后停 4 秒
const BLEND_DUR = 2500;     // 再用 2.5 秒缓动并回段落机位，绝不硬切
controls.addEventListener('start', () => { manual = true; });
controls.addEventListener('end', () => {
  manual = false;
  resumeAt = performance.now() + BLEND_WAIT;
  blendStart = resumeAt;
  blendFrom = { p: camera.position.clone(), t: controls.target.clone() };
});

/* ═══════════════════ 18. 面板 UI（信息结构原样保留） ═══════════════════ */
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

/* ═══════════════════ 19. 主循环 ═══════════════════ */
const hudTime = document.getElementById('hud-time');
const hudValue = document.getElementById('hud-value');
const DAY_PERIOD = 64000;
const HOLD = 1400;

const clock = new THREE.Clock();
let dayT = 0;
let animT = 0;                 // 唯一的时间源：雨、镜头、手持感都读它，方便 QA 定格
let paused = false;
let camLock = null;            // QA 用：锁死机位以核对雨脊轮廓，null = 自动运镜
let lastHud = '';
let panelOpacity = 1;
let panelRect = null, rectAt = 0;

let emaMs = 16.7, tuneAt = 0, rainScale = 1, countLock = null;   // 性能调节器：只动 instanceCount
let resScale = 1;                          // 第二阶段：composer 内部分辨率倍率

const _v = new THREE.Vector3();
function screenOf(x, y) {
  _v.set(x, y, 0).project(camera);
  return { sx: (_v.x * 0.5 + 0.5) * innerWidth, sy: (-_v.y * 0.5 + 0.5) * innerHeight, vis: _v.z < 1 && _v.z > -1 };
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = animT;
  const now = performance.now();

  if (!paused) {
    animT += dt;
    dayT += dt * 1000;
  }
  const cycle = DAY_PERIOD + HOLD;
  const playMs = dayT % cycle;
  const playH = playMs <= DAY_PERIOD ? (playMs / DAY_PERIOD) * DAY_HOURS : DAY_HOURS;
  const pv = valueAt(playH);

  const ps = pxScale();
  for (const m of [curtain.mat, splash.mat, floor.mat, glow.mat, dustMat]) {
    if (m.uniforms.uTime) m.uniforms.uTime.value = t;
    if (m.uniforms.uPlayX) m.uniforms.uPlayX.value = playH;
    if (m.uniforms.uPxScale) m.uniforms.uPxScale.value = ps;
  }
  gradePass.uniforms.uTime.value = t;
  // 雨越密辉光越强（小幅摆动，不当万能药用）
  bloom.strength = 0.40 + 0.26 * Math.pow(pv / VMAX, 1.4);

  playGroup.position.x = playH;
  const yaw = Math.atan2(camera.position.x - playH, camera.position.z);
  playGroup.userData.blade.rotation.y = yaw;
  playGroup.userData.tick.rotation.y = yaw;
  // 光刃高度跟着当前雨量走，和雨脊贴在一起，不再是一根顶到天的白杆
  const bladeH = pv * 1.06 + 0.45;
  playGroup.userData.blade.scale.set(1.0, bladeH, 1);
  playGroup.userData.blade.position.y = bladeH / 2;
  const pulse = 0.86 + 0.14 * Math.sin(t * 1.7);
  playPoolMat.uniforms.uInt.value = (0.010 + 0.024 * Math.pow(pv / VMAX, 0.9)) * pulse;
  bladeMat.uniforms.uInt.value = 0.75 + 0.25 * pulse;

  hudTime.textContent = fmt(playH);
  const txt = pv.toFixed(1);
  if (txt !== lastHud) {
    lastHud = txt;
    hudValue.textContent = txt;
    hudValue.classList.remove('pulse');
    void hudValue.offsetWidth;
    hudValue.classList.add('pulse');
  }

  const mx = cx(playH), my = cy(pv);
  marker.setAttribute('cx', mx); marker.setAttribute('cy', my);
  halo.setAttribute('cx', mx); halo.setAttribute('cy', my);
  const active = Math.round((playH / DAY_HOURS) * (N - 1));
  cells.forEach((c, i) => c.classList.toggle('active', i === active));

  // 面板自动避让：最亮的雨脊压到面板上时降到 0.85
  if (now > rectAt) { rectAt = now + 400; panelRect = panel.getBoundingClientRect(); }
  if (panelRect && !panel.classList.contains('hidden')) {
    let overlap = false;
    for (let i = 0; i < N; i++) {
      if (values[i] < 7) continue;
      const s = screenOf(times[i], values[i]);
      if (s.vis && s.sx >= panelRect.left - 30 && s.sx <= panelRect.right + 30 &&
          s.sy >= panelRect.top && s.sy <= panelRect.bottom) { overlap = true; break; }
    }
    panelOpacity += ((overlap ? 0.85 : 1) - panelOpacity) * Math.min(1, dt * 3);
    panel.style.opacity = panelOpacity.toFixed(3);
  }

  // 相机：段落插值直接赋值；用户按住时完全交给 OrbitControls
  const pose = shotPose(t);
  const hn = t * 0.25;
  if (camLock) {
    camera.position.set(camLock.p[0], camLock.p[1], camLock.p[2]);
    controls.target.set(camLock.t[0], camLock.t[1], camLock.t[2]);
  } else if (!manual) {
    let p = pose.p, tg = pose.t;
    if (blendFrom) {
      const w = THREE.MathUtils.smoothstep(now - blendStart, 0, BLEND_DUR);
      if (now < blendStart) { p = blendFrom.p.toArray(); tg = blendFrom.t.toArray(); }
      else {
        p = lerp3(blendFrom.p.toArray(), pose.p, w);
        tg = lerp3(blendFrom.t.toArray(), pose.t, w);
        if (w >= 1) blendFrom = null;
      }
    }
    const amp = 0.15 * (0.45 + pose.wide) * (blendFrom ? 0.35 : 1);
    camera.position.set(
      p[0] + noise1(hn) * amp,
      p[1] + noise1(hn + 41.3) * amp * 0.7,
      p[2] + noise1(hn + 87.1) * amp
    );
    controls.target.set(tg[0] + noise1(hn + 13.7) * amp * 0.35, tg[1], tg[2]);
  }
  controls.update();
  if (!camLock) camera.rotateZ(noise1(t * 0.19 + 5.5) * 0.00175 * (0.4 + pose.wide));   // ≈ ±0.1° roll

  // 性能调节器：实例是随机序生成的，截断 = 均匀变稀
  emaMs += (dt * 1000 - emaMs) * 0.06;
  if (countLock === null && now > tuneAt) {
    tuneAt = now + 500;
    if (emaMs > 20.5 && rainScale > RAIN_MIN / curtain.total) rainScale *= 0.93;
    else if (emaMs < 14.2 && rainScale < 1) rainScale = Math.min(1, rainScale * 1.04);
    const k = Math.max(RAIN_MIN, Math.floor(curtain.total * rainScale));
    curtain.geo.instanceCount = k;
    splash.geo.instanceCount = Math.min(splash.total, Math.floor(k * (splash.total / curtain.total)));
    // 粒子已经触底还是慢 => 瓶颈在填充率，降内部分辨率（OutputPass 会自动放大到画布）
    if (emaMs > 22 && k <= RAIN_MIN) resScale = Math.max(0.6, resScale * 0.9);
    else if (emaMs < 13 && resScale < 1) resScale = Math.min(1, resScale * 1.05);
    if (resScale < 0.98) composer.setSize(innerWidth * resScale, innerHeight * resScale);
    if (resScale < 0.78 && focusPass.enabled) focusPass.enabled = false;   // 柔焦是化开硬光的那一环，能留就留
  }

  composer.render();
}
tick();

/* ═══════════════════ 20. 自适应 ═══════════════════ */
function syncPostSizes() {
  const pr = renderer.getPixelRatio();
  gradePass.uniforms.uRes.value.set(innerWidth * pr, innerHeight * pr);
  focusPass.uniforms.uTexel.value.set(1 / (innerWidth * pr), 1 / (innerHeight * pr));
}
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio, Q.dpr));
  renderer.setSize(innerWidth, innerHeight);
  resScale = 1; focusPass.enabled = Q.focus;      // 换窗口尺寸后重新从满分辨率开始自适应
  composer.setSize(innerWidth, innerHeight);
  bloom.setSize(innerWidth * Q.bloomScale, innerHeight * Q.bloomScale);
  syncPostSizes();
});
syncPostSizes();

/* ═══════════════════ 21. QA 钩子（只为定格核对与取帧率，不参与渲染逻辑） ═══════════════════ */
window.__rainDebug = {
  pause: (b) => { paused = !!b; },
  setHour: (h) => { dayT = (h / DAY_HOURS) * DAY_PERIOD; },
  setTime: (s) => { animT = s; },
  setCount: (n) => { countLock = n; curtain.geo.instanceCount = n; splash.geo.instanceCount = Math.min(splash.total, n); },
  setGain: (g) => { curtain.mat.uniforms.uGain.value = g; },
  lockCam: (p, t) => { camLock = p ? { p, t } : null; },
  show: (w, b) => { ({ rain: curtain.mesh, splash: splash.mesh, glow: glow.mesh, floor: floor.mesh })[w].visible = !!b; },
  hist: () => {                       // 26 个时间桶里的实例数，用来核对密度场是否跟着数据走
    const a = curtain.geo.attributes.aDrop.array, n = curtain.geo.instanceCount, h = new Array(N).fill(0);
    for (let i = 0; i < n; i++) h[Math.min(N - 1, Math.max(0, Math.floor((a[i * 4] / 24) * N)))]++;
    return h;
  },
  stats: () => ({
    rain: curtain.total, splash: splash.total, mobile: MOBILE,
    drawnRain: curtain.geo.instanceCount, frameMs: +emaMs.toFixed(2), bloom: +bloom.strength.toFixed(3),
    resScale: +resScale.toFixed(2), lowGpu: LOW_GPU, focus: focusPass.enabled,
  }),
};
