// Optional live layer (front B10, LOCAL TEST ONLY): the city seen through the windows of the 360 tour comes from Google
// Photorealistic 3D Tiles (Map Tiles API), rendered with a three.js camera standing where the panorama was taken.
//
// Rules from the Google terms (briefing pacote-google-3d-tiles.md): Google logo + aggregated attribution on screen, say
// "Cidade: Google", no storing of tiles (only the in-memory renderer cache), no extraction, Google's mesh is never hidden or
// clipped (our model is only drawn OVER it). Everything here is optional: no key / any error / quota hit / trial ended =>
// `iniciarGoogle()` resolves false and the tour keeps its current look, with no message to the visitor.
//
// The key is NEVER in a file: it is read from window.__G3D_KEY (injected by the test harness) or ?gkey= on the URL.
import * as THREE from 'three';
import { capacidade } from './capacidade.js';
import { smooth, fatorDia, fatorLuzesNoite } from './luz-curva.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const V = '3d-tiles-renderer@0.5.3'; // pinned
const CDN = `https://cdn.jsdelivr.net/npm/${V}/build/`;
const DRACO = 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/libs/draco/gltf/';
const LOGO = 'https://maps.gstatic.com/mapfiles/api-3/images/google_white5_hdpi.png';

// detail level: ?gerr=<px> sets the 360 target, the outside view uses 1.25x
// detail per device tier (src/capacidade.js): 8 px = Google's finest on computers and top phones, 24/28 on mid phones
const ERRO_360 = (typeof location !== 'undefined' && +new URLSearchParams(location.search).get('gerr')) || capacidade().erro360;
// ON by default (07/10); ?google3d=0 turns it off. Key: test harness (window.__G3D_KEY) or ?gkey=, else src/g3d-chave.js,
// which only exists in the PUBLISHED copy (written by prepara_pages.py from the referrer-restricted site key)
// radius (m) of Google's city around the camera: tiles farther than this are neither loaded nor drawn (?graio= to test)
const RAIO = (typeof location !== 'undefined' && +new URLSearchParams(location.search).get('graio')) || 20000;
// 08/10 PHOTO MODE for the 360 on mid phones (Victor's M21s: mushy city, a loading bar on every turn, sluggish): the window
// view is shot ONCE per point into a cube (one face at a time, finer detail than live), then only that picture is shown.
// ?gfoto=1 forces it (tests), ?gfoto=0 turns it off.
const QS_FOTO = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('gfoto') : null;
export const MODO_FOTO = QS_FOTO === '1' || (QS_FOTO !== '0' && (capacidade().movel || capacidade().nivel !== 'topo')); // every phone (Victor 08/10); computers stay live
const ERRO_FOTO = +(typeof location !== 'undefined' && new URLSearchParams(location.search).get('gferr')) || (capacidade().nivel === 'topo' ? 6 : 14); // mid phones: half the detail, much faster (Victor 08/10: 'demora uma eternidade') // finest Google detail for the picture, every device (it is shot once); ?gferr= tests
const FOTO_LADO = capacidade().nivel === 'topo' ? 2048 : 1536; // px per 90 deg face (mid phones 1536: M21s crashed with 2048 + 3072 layers)
const FOTO_LADO_W = capacidade().nivel === 'topo' ? 2048 : 1024; // night-windows picture (lit dots only)
const FOTO_MIN = +(typeof location !== 'undefined' && new URLSearchParams(location.search).get('gfmin')) || 99999; // smallest region the splitter goes down to (?gfmin=128 tests)
const FOTO_MB = (+(typeof location !== 'undefined' && new URLSearchParams(location.search).get('gfmb')) || (capacidade().nivel === 'topo' ? (capacidade().movel ? 900 : 1500) : capacidade().tilesMB)) * 1048576; // mid phones: no raise (M21s crashed at 420, 08/10)
const FOTO_N = +(typeof location !== 'undefined' && new URLSearchParams(location.search).get('gfn')) || (capacidade().nivel === 'topo' ? 4 : 2); // regions per face side (mid phones: 2x2 at the lower detail)
export const desligadoPorUrl = () => /[?&]google3d=0/.test(location.search);
async function chaveDaPagina() {
  const k = window.__G3D_KEY || new URLSearchParams(location.search).get('gkey');
  if (k) return k;
  try { return (await import('./g3d-chave.js')).CHAVE || ''; } catch (e) { return ''; }
}

// ---------------------------------------------------------------- geodesy (double precision, plain JS numbers)
const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F);
export function ecef(latDeg, lonDeg, h) {
  const la = (latDeg * Math.PI) / 180, lo = (lonDeg * Math.PI) / 180;
  const N = A / Math.sqrt(1 - E2 * Math.sin(la) ** 2);
  return [(N + h) * Math.cos(la) * Math.cos(lo), (N + h) * Math.cos(la) * Math.sin(lo), (N * (1 - E2) + h) * Math.sin(la)];
}
// ECEF -> local frame L (x east, y up, z = -north), origin at the eye (+ optional eye offset in ENU metres)
export function matrizLocal(lat, lon, h, [dE = 0, dN = 0, dU = 0] = []) {
  const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
  const e = [-Math.sin(lo), Math.cos(lo), 0];
  const n = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
  const u = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  const P = ecef(lat, lon, h);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const Pe = dot(e, P), Pn = dot(n, P), Pu = dot(u, P);
  const m = new THREE.Matrix4();
  m.set(e[0], e[1], e[2], -Pe - dE,
    u[0], u[1], u[2], -Pu - dU,
    -n[0], -n[1], -n[2], Pn + dN,
    0, 0, 0, 1);
  return m;
}

// time-of-day light of Google's photo city, applied in every tile shader from shared uniforms (never per material)
const LUZ_GLSL = `
  {
    vec3 cB = outgoingLight;
    outgoingLight = cB * uLuz;
    // street lights (same map as our city: R sodium, G LED, B terrain height), on what is near street level
    if (uNoiteG > 0.001 && uTerrExt > 0.0) {
      vec2 rq = (vB5.xz + uTerrExt) / (2.0 * uTerrExt);
      if (all(greaterThan(rq, vec2(0.0))) && all(lessThan(rq, vec2(1.0)))) {
        vec3 lz = texture2D(uTerr, rq).rgb;
        float hrua = vB5.y - (lz.b * 60.0 - 20.0);
        outgoingLight += uNoiteG * (lz.r * vec3(1.0, 0.56, 0.22) + lz.g * vec3(1.0, 0.82, 0.6)) * cB * 1.6 * (1.0 - smoothstep(1.0, 10.0, hrua));
      }
    }
    if (uNoiteG > 0.001) {
      vec3 nB = normalize(cross(dFdx(vB5), dFdy(vB5)));
      bool verde = cB.g > cB.r * 1.08 && cB.g > cB.b * 1.04;
      if (!verde && abs(nB.y) < 0.5 && vB5.y > 3.5) {
        vec3 tg = normalize(vec3(-nB.z, 0.0, nB.x));
        float sF = dot(vB5, tg);
        vec2 cel = vec2(floor(sF / 3.1), floor(vB5.y / 2.85));
        vec2 f = vec2(fract(sF / 3.1), fract(vB5.y / 2.85));
        float jan = smoothstep(0.22, 0.27, f.x) * (1.0 - smoothstep(0.73, 0.78, f.x)) * smoothstep(0.36, 0.41, f.y) * (1.0 - smoothstep(0.80, 0.85, f.y));
        float id = g3dH21(cel + floor(nB.xz * 3.0) * 17.0 + floor(vB5.xz / 40.0) * 3.1);
        float acesa = step(id, uFracG) * jan;
        float lum = dot(cB, vec3(0.2126, 0.7152, 0.0722));
        float vidro = 1.0 - smoothstep(0.18, 0.5, lum);
        vec3 quente = mix(vec3(1.0, 0.72, 0.42), vec3(0.95, 0.9, 0.82), step(0.82, g3dH21(cel + 7.0)));
        float forca = 0.12 + 0.88 * pow(g3dH21(cel + 3.0), 2.2);
        outgoingLight += uNoiteG * acesa * mix(0.5, 1.0, vidro) * quente * forca * 0.85;
      }
    }
  }`;
// building ghosts: same rule as entorno.js (whole building between camera and tower, or around the camera, is not drawn).
// The building of a Google fragment = the footprint texel under it (5 taps, 2.5 m apart: Google's walls a bit outside our
// footprints still go with their building). Ground + lower 5 m always stay (street slope).
const FANT_GLSL = `
uniform sampler2D uMapaP; uniform vec4 uMapaR; uniform vec3 uCamB5; uniform vec3 uAlvoB5; uniform sampler2D uTerr; uniform float uTerrExt;
bool g3dSome(vec4 c) {
  if (c.a < 0.5) return false;
  vec2 a = uCamB5.xz, b = uAlvoB5.xz, ab = b - a;
  float t = clamp(dot(c.xy - a, ab) / max(dot(ab, ab), 1e-3), 0.0, 1.0);
  float d = length(c.xy - (a + ab * t));
  // only buildings that really stand on the line of sight to the tower (Victor 07/10: they vanished too early). c.z = the
  // building's radius; the tower is ~12 m wide
  bool entre = t > 0.05 && t < 0.93 && d < c.z * 0.8 + 6.0 && length(c.xy - b) > 20.0;
  bool naCamera = length(c.xy - a) < c.z * 0.8 + 2.0;
  return entre || naCamera;
}
bool g3dFantasma(vec3 p) {
  if (uMapaR.w < 0.5) return false;
  // keep the ground: 1.2 m above the real terrain (our city's street map), or 5 m where there is no terrain data
  float chao = 3.8;
  if (uTerrExt > 0.0) { vec2 rq = (p.xz + uTerrExt) / (2.0 * uTerrExt); if (all(greaterThan(rq, vec2(0.0))) && all(lessThan(rq, vec2(1.0)))) chao = texture2D(uTerr, rq).b * 60.0 - 20.0; }
  if (p.y < chao + 1.2) return false;
  vec2 uv = vec2((p.x - uMapaR.x) * uMapaR.z, 1.0 - (p.z - uMapaR.y) * uMapaR.z), e = vec2(2.5 * uMapaR.z, 0.0); // map camera up = -z: v 0 at z max
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return false;
  return g3dSome(texture2D(uMapaP, uv)) || g3dSome(texture2D(uMapaP, uv + e.xy)) || g3dSome(texture2D(uMapaP, uv - e.xy))
      || g3dSome(texture2D(uMapaP, uv + e.yx)) || g3dSome(texture2D(uMapaP, uv - e.yx));
}
`;
// same curve as our city (entorno.js gradeEntorno): base grade by sun elevation + window lights at night
export function luzDaCidade(el) {
  const e = Number.isFinite(el) ? el : -20;
  const k = 0.04 + 0.96 * fatorDia(e), azul = smooth(-14, -3, e) * (1 - smooth(-2, 8, e)), noite = 1 - smooth(-14, -4, e);
  const base = [1, 1, 1].map((v, i) => { let x = v; x += ([0.90, 0.95, 1.06][i] - x) * azul * 0.6; x += ([0.62, 0.74, 1.05][i] - x) * noite; return x * k; });
  return { base, luzes: fatorLuzesNoite(e) * (1 - smooth(-7, 0, e)) };
}
// ---------------------------------------------------------------- shared session (ONE root tileset request per page load)
let sessao = null;
export const STATUS = { estado: 'parado', erro: null, raiz: 0, bytes: 0, tiles: 0 };
if (typeof window !== 'undefined') window.__g3d = STATUS;

export function iniciarGoogle() {
  if (sessao) return sessao;
  sessao = (async () => {
    const chave = await chaveDaPagina();
    if (!chave || desligadoPorUrl()) { STATUS.estado = 'sem-chave'; return null; }
    if (!capacidade().google) { STATUS.estado = 'aparelho-leve'; return null; } // weak phone: our city only
    STATUS.estado = 'carregando';
    try {
      const [{ TilesRenderer }, { GoogleCloudAuthPlugin }] = await Promise.all([import(`${CDN}index.js`), import(`${CDN}index.core-plugins.js`)]);
      const tiles = new TilesRenderer();
      tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: chave, autoRefreshToken: true, logoUrl: LOGO, useRecommendedSettings: false }));
      const draco = new DRACOLoader(); draco.setDecoderPath(DRACO);
      const gltf = new GLTFLoader(tiles.manager); gltf.setDRACOLoader(draco);
      tiles.manager.addHandler(/\.gltf$/, gltf);
      tiles.errorTarget = 8;                      // detail: close, narrow views (each view sets its own below)
      if (tiles.downloadQueue) tiles.downloadQueue.maxJobs = 30; if (tiles.parseQueue) tiles.parseQueue.maxJobs = capacidade().parse; // fewer parses per frame on phones: less stutter while loading
      // 07/10: at 300 MB the cache was FULL (315 MB) and the renderer refused every finer tile -> coarse city. The full-detail
      // view needs more; ?gmb=<MB> overrides for measuring. Same on phones (high-end target): no coarsening.
      // budget by device: phones report navigator.deviceMemory (GB, capped at 8); measured 07/10: outside view ~600 MB of tiles
      const movel = capacidade().movel;
      const mb = +new URLSearchParams(location.search).get('gmb') || capacidade().tilesMB;
      tiles.lruCache.maxBytesSize = mb * 1048576;
      // keep EVERYTHING already downloaded until the device budget is nearly full (Victor 07/10: turning away and back made
      // the city reload); only then the least recently seen tiles go
      tiles.lruCache.minBytesSize = Math.round(mb * 0.95) * 1048576;
      tiles.autoDisableRendererCulling = true;
      const escena = new THREE.Scene(); escena.add(tiles.group);
      const s = { tiles, escena, TilesRenderer, dono: null, cor: [1, 1, 1] };
      // ONE tiles set serves two views (outside scene and 360 window). Whoever draws takes it: its scene, its frame, ONLY its
      // camera (a forgotten camera keeps loading tiles for a view nobody sees) and its detail target.
      s.tomar = (quem, pai, matriz, cam, erro) => {
        if (s.dono !== quem) {
          if (s.dono && s.dono.restauraCache) s.dono.restauraCache(); // the 360 photo freed the tiles: the next view gets its budget back
          s._recFeito = false; if (s.recorte) s.recorte.mapaR.value.w = 0; // building ghosts only in the outside view (cena3d turns them on)
          for (const c of [...tiles.cameras]) tiles.deleteCamera(c);
          tiles.setCamera(cam);
          const g = tiles.group; if (g.parent !== pai) { g.parent?.remove(g); pai.add(g); }
          s.dono = quem;
        }
        const g = tiles.group; g.matrixAutoUpdate = false;
        if (!g.matrix.equals(matriz)) { g.matrix.copy(matriz); g.matrixWorldNeedsUpdate = true; if (s.atualizaRecorte) s.atualizaRecorte(); }
        else if (s.dono === quem && s.recorte && s.recorte.ecefParaB5 && !s._recFeito) { s._recFeito = true; s.atualizaRecorte(); }
        tiles.errorTarget = erro;
      };
      // Memory (07/10, Victor's Android crashed "Ah, nao!"): tiles keep a CPU copy besides the GPU one. Dropping it was
      // tried and REVERTED: the outside view and the 360 draw the same tiles with two different WebGL contexts, and the second
      // one still needs the data ('Unsupported buffer data format'). Memory is held by the per-device budget (src/capacidade.js).
      // Clip box of OUR tower (B5 frame): Google's own mesh of the building is not drawn inside it, in both views. One set
      // of shared uniforms; uParaB5 = (ECEF -> B5) x inverse(current group world matrix), refreshed when a view takes the tiles.
      // + ghost box: uRet = screen rectangle (drawing-buffer px) of our tower, uProf = its nearest view depth; Google's
      // fragments inside the rectangle and nearer than the tower are dropped (x0 > x1 = off, e.g. in the 360)
      s.recorte = { liga: { value: 0 }, min: { value: new THREE.Vector3() }, max: { value: new THREE.Vector3() }, paraB5: { value: new THREE.Matrix4() }, ecefParaB5: null,
        ret: { value: new THREE.Vector4(1, 1, 0, 0) }, prof: { value: 0 },
        luz: { value: new THREE.Vector3(1, 1, 1) }, noite: { value: 0 }, frac: { value: 0.25 },
        mapa: { value: null }, mapaR: { value: new THREE.Vector4(0, 0, 0, 0) }, camB5: { value: new THREE.Vector3() }, alvoB5: { value: new THREE.Vector3() },
        terr: { value: null }, terrExt: { value: 0 } };
      const shaderRecorte = (sh) => {
        sh.uniforms.uRecLiga = s.recorte.liga; sh.uniforms.uRecMin = s.recorte.min; sh.uniforms.uRecMax = s.recorte.max; sh.uniforms.uParaB5 = s.recorte.paraB5;
        sh.uniforms.uRet = s.recorte.ret; sh.uniforms.uProf = s.recorte.prof;
        sh.uniforms.uLuz = s.recorte.luz; sh.uniforms.uNoiteG = s.recorte.noite; sh.uniforms.uFracG = s.recorte.frac;
        sh.uniforms.uMapaP = s.recorte.mapa; sh.uniforms.uMapaR = s.recorte.mapaR; sh.uniforms.uCamB5 = s.recorte.camB5; sh.uniforms.uAlvoB5 = s.recorte.alvoB5;
        sh.uniforms.uTerr = s.recorte.terr; sh.uniforms.uTerrExt = s.recorte.terrExt;
        sh.vertexShader = 'uniform mat4 uParaB5;\nvarying vec3 vB5;\nvarying float vProf;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nvB5 = (uParaB5 * modelMatrix * vec4(transformed, 1.0)).xyz;\nvProf = -mvPosition.z;');
        sh.fragmentShader = 'uniform float uRecLiga;\nuniform vec3 uRecMin;\nuniform vec3 uRecMax;\nuniform vec4 uRet;\nuniform float uProf;\nvarying vec3 vB5;\nvarying float vProf;\n'
          + 'uniform vec3 uLuz;\nuniform float uNoiteG;\nuniform float uFracG;\nfloat g3dH21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }\n'
          + FANT_GLSL
          + sh.fragmentShader.replace('#include <opaque_fragment>', LUZ_GLSL + '\n#include <opaque_fragment>').replace('void main() {',
          'void main() {\n  if (uRecLiga > 0.5 && all(greaterThan(vB5, uRecMin)) && all(lessThan(vB5, uRecMax))) discard;\n  if (g3dFantasma(vB5)) discard;');
      };
      s.shaderRecorte = shaderRecorte;
      const recortar = (o) => {
        if (!o.isMesh || !o.material || o.material.__recorte) return;
        const m = o.material; m.__recorte = true;
        m.onBeforeCompile = shaderRecorte;
        m.customProgramCacheKey = () => 'g3d-recorte';
        m.needsUpdate = true;
      };
      tiles.addEventListener('load-model', (ev) => ev.scene.traverse(recortar));
      // outside view: tiles also on layer 3 (the shadow-overlay pass of cena3d.js) and able to receive the sun's shadow map
      tiles.addEventListener('load-model', (ev) => ev.scene.traverse((o) => { if (o.isMesh) { o.layers.enable(3); o.receiveShadow = true; o.castShadow = false; } }));
      s.atualizaRecorte = () => {
        if (!s.recorte.ecefParaB5) return;
        tiles.group.updateMatrixWorld(true);
        s.recorte.paraB5.value.copy(s.recorte.ecefParaB5).multiply(new THREE.Matrix4().copy(tiles.group.matrixWorld).invert());
      };
      // time of day for ALL tiles (shared uniforms; per-material colour left stale tints on cached tiles = patches)
      s.pintar = () => {};
      s.definirLuz = (el) => { const L = luzDaCidade(el); s.recorte.luz.value.set(L.base[0], L.base[1], L.base[2]); s.recorte.noite.value = L.luzes; };
      await new Promise((ok, falha) => {
        const t = setTimeout(() => falha(new Error('timeout da raiz')), 20000);
        const aoRaiz = () => { clearTimeout(t); STATUS.raiz++; tiles.removeEventListener('load-root-tileset', aoRaiz); ok(); };
        tiles.addEventListener('load-root-tileset', aoRaiz);
        const aoErro = (ev) => { clearTimeout(t); tiles.removeEventListener('load-error', aoErro); falha(ev.error || new Error('load-error')); };
        tiles.addEventListener('load-error', aoErro);
        // the root json is only requested on the first update() with a camera
        const cam = new THREE.PerspectiveCamera(60, 1, 1, 1000); cam.updateMatrixWorld();
        tiles.setCamera(cam); tiles.setResolution(cam, 256, 256); tiles.update();
        s._camInicial = cam;
      });
      tiles.deleteCamera(s._camInicial);
      tiles.addEventListener('load-error', (ev) => { STATUS.erro = String(ev.error && ev.error.message || ev.error).slice(0, 160); });
      STATUS.estado = 'pronto';
      return s;
    } catch (e) {
      STATUS.estado = 'falhou'; STATUS.erro = String(e && e.message || e).slice(0, 160);
      return null;
    }
  })();
  return sessao;
}

// ---------------------------------------------------------------- a view: camera at the eye, tiles rendered to a target
// ref = { lat, lon, h (ellipsoid metres), rumo (bearing of the pano centre, deg), ajuste: { enu:[e,n,u], rumo:dDeg } }
export class VistaGoogle {
  constructor(renderer, s, ref, aoMudar) {
    this.r = renderer; this.s = s; this.ref = ref; this.aoMudar = aoMudar || (() => {});
    this.cam = new THREE.PerspectiveCamera(60, 1, 3, 20000);
    // tiles are SELECTED with a camera cropped to the window on screen (setViewOffset): nothing behind the walls is
    // downloaded, same pixel density inside the window. Drawing still uses the full camera.
    this.camSel = new THREE.PerspectiveCamera(60, 1, 3, RAIO);
    this.dirs = null; this.mascaraFonte = null;
    this.rt = null; this.ativo = true; this.ocioso = 0; this.larg = 0; this.alt = 0; this.escala = 1;
    this.alvoDir = new THREE.Vector3(0, 0, -1);
    this.ligaNaCena();
    this._aoCarregar = () => this.acordar();
    for (const ev of ['load-model', 'tiles-load-end', 'needs-update', 'tile-visibility-change']) s.tiles.addEventListener(ev, this._aoCarregar);
    this.credito = this.montaCredito();
  }
  ligaNaCena() {
    const { lat, lon, h, ajuste } = this.ref;
    this.matriz = matrizLocal(lat, lon, h, (ajuste && ajuste.enu) || []);
  }
  // scene-frame view direction (X=-v, Y=h, Z=u as in tour360.js) -> local frame L
  dirParaL(dx, dy, dz) {
    const f = -dx, r = -dz;
    const b = ((this.ref.rumo + ((this.ref.ajuste && this.ref.ajuste.rumo) || 0)) * Math.PI) / 180;
    const E = Math.sin(b) * f + Math.sin(b + Math.PI / 2) * r, N = Math.cos(b) * f + Math.cos(b + Math.PI / 2) * r;
    return new THREE.Vector3(E, dy, -N);
  }
  tamanho(w, h, escala) {
    this.larg = Math.max(2, Math.round(w * escala)); this.alt = Math.max(2, Math.round(h * escala)); this.escala = escala;
    if (this.rt && (this.rt.width !== this.larg || this.rt.height !== this.alt)) { this.rt.dispose(); this.rt = null; }
    if (!this.rt) {
      const gl = this.r.getContext();
      const half = this.r.capabilities.isWebGL2 && (gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
      this.rt = new THREE.WebGLRenderTarget(this.larg, this.alt, { type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: true, generateMipmaps: false, samples: 0 });
      this.rt.texture.colorSpace = half ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
      this.rt.texture.minFilter = this.rt.texture.magFilter = THREE.LinearFilter;
    }
    this.resW = w; this.resH = h; // REAL drawing-buffer size (dpr included), not the scaled target
  }
  // window mask (pano equirect, bitmap row 0 = v 0 as loaded by render-mix) -> list of scene-frame directions where it is open
  definirMascara(img) {
    if (!img || img === this.mascaraFonte) return;
    this.mascaraFonte = img;
    const W = 256, H = 128, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H).data, out = [];
    for (let r = 0; r < H; r++) for (let k = 0; k < W; k++) {
      if (px[(r * W + k) * 4] < 64) continue;
      const phi = ((k + 0.5) / W) * 2 * Math.PI, th = Math.PI * (1 - (r + 0.5) / H); // SphereGeometry uv, x mirrored (scale -1)
      out.push(Math.cos(phi) * Math.sin(th), Math.cos(th), Math.sin(phi) * Math.sin(th));
    }
    this.dirs = new Float32Array(out);
  }
  // NDC box of the open window as seen by `camera` (scene frame), with a small margin; null = no window on screen
  janelaNaTela(camera) {
    const d = this.dirs; if (!d) return { x0: -1, y0: -1, x1: 1, y1: 1 };
    const m = camera.matrixWorldInverse.elements, p = camera.projectionMatrix.elements;
    let x0 = 2, y0 = 2, x1 = -2, y1 = -2, n = 0;
    for (let i = 0; i < d.length; i += 3) {
      const x = d[i], y = d[i + 1], z = d[i + 2];
      const vx = m[0] * x + m[4] * y + m[8] * z, vy = m[1] * x + m[5] * y + m[9] * z, vz = m[2] * x + m[6] * y + m[10] * z;
      if (vz > -0.05) continue; // behind the camera
      const w = -vz, sx = (p[0] * vx + p[8] * vz) / w, sy = (p[5] * vy + p[9] * vz) / w;
      if (sx < -1.2 || sx > 1.2 || sy < -1.2 || sy > 1.2) continue;
      n++; if (sx < x0) x0 = sx; if (sx > x1) x1 = sx; if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
    }
    if (!n) return null;
    const mg = 0.06, cl = (v) => Math.max(-1, Math.min(1, v));
    return { x0: cl(x0 - mg), y0: cl(y0 - mg), x1: cl(x1 + mg), y1: cl(y1 + mg) };
  }
  // point the camera and draw the tiles into the target. dir = scene-frame direction; janela = NDC box to load tiles for
  desenha(dir, fov, aspect, janela, soCarregar = false) {
    if (!this.rt) return;
    const d = this.dirParaL(dir.x, dir.y, dir.z);
    this.cam.position.set(0, 0, 0); this.cam.up.set(0, 1, 0);
    this.cam.fov = fov; this.cam.aspect = aspect; this.cam.updateProjectionMatrix();
    this.cam.lookAt(d); this.cam.updateMatrixWorld(true);
    if (this.s.dono !== this) this.s.pintar([1, 1, 1]); // the 360 applies its own gain in the overlay shader
    const j = janela || { x0: -1, y0: -1, x1: 1, y1: 1 }, cs = this.camSel, W = this.resW, H = this.resH;
    const px = Math.floor(((j.x0 + 1) / 2) * W), py = Math.floor(((1 - j.y1) / 2) * H);
    const pw = Math.max(2, Math.ceil(((j.x1 - j.x0) / 2) * W)), ph = Math.max(2, Math.ceil(((j.y1 - j.y0) / 2) * H));
    cs.position.copy(this.cam.position); cs.quaternion.copy(this.cam.quaternion); cs.up.copy(this.cam.up);
    cs.fov = fov; cs.aspect = aspect; cs.setViewOffset(W, H, px, py, pw, ph); cs.updateProjectionMatrix(); cs.updateMatrixWorld(true);
    this.janela = { px, py, pw, ph };
    this.s.tomar(this, this.s.escena, this.matriz, cs, ERRO_360);
    this.s.tiles.setResolution(cs, pw, ph); // same pixel density as the full screen (offset narrows the projection)
    this.s.escena.updateMatrixWorld(true);
    this.s.tiles.update();
    if (soCarregar) { const st = this.s.tiles.stats; if (st.queued + st.downloading + st.parsing > 0 || this.s.tiles.loadProgress < 1) this.acordar(); return; }
    const r = this.r, cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    const rtAnt = r.getRenderTarget();
    r.setRenderTarget(this.rt); r.setClearColor(0x000000, 0); r.clear(); r.render(this.s.escena, this.cam);
    r.setRenderTarget(rtAnt); r.setClearColor(cc, ca);
    const st = this.s.tiles.stats; STATUS.tiles = st ? (st.visible || 0) : 0;
    if (st && (st.queued + st.downloading + st.parsing > 0 || this.s.tiles.loadProgress < 1)) this.acordar();
    this.atualizaCredito();
  }
  // ---- photo mode (08/10): which of the 6 axis directions (90 deg faces) see the open window, in the local frame
  facesDaJanela() {
    const out = [], d = this.dirs, v = new THREE.Vector3();
    for (let i = 0; i < 6; i++) {
      const cam = this.foto.cams[i]; let n = 0;
      if (d) for (let k = 0; k < d.length; k += 3) {
        v.copy(this.dirParaL(d[k], d[k + 1], d[k + 2])).multiplyScalar(100).project(cam);
        if (v.z < 1 && v.z > -1 && Math.abs(v.x) <= 1.02 && Math.abs(v.y) <= 1.02) n++;
      } else n = 1;
      if (n) out.push([i, n]);
    }
    return out.sort((a, b) => b[1] - a[1]).slice(0, 4).map((x) => x[0]); // the overlay samples up to 4 faces
  }
  passoFoto() {
    if (!this.foto) {
      const eixos = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], ups = [[0, 1, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, 1, 0]];
      const cams = eixos.map((e, i) => { const c = new THREE.PerspectiveCamera(90, 1, 3, RAIO); c.up.set(...ups[i]); c.lookAt(...e); c.updateMatrixWorld(true); return c; });
      this.foto = { cams, alvos: [], chave: null, faces: [], i: 0, reg: 0, t0: 0, feito: false, prog: 0, mats: [] };
    }
    const F = this.foto, ref = this.ref, agora = performance.now();
    // one picture per UNIT (tour360 sets unidadeChave); points of the unit reuse it and only add faces they need
    const chave = this.unidadeChave || [ref.lat, ref.lon, ref.h, ref.rumo].join('|');
    const alvo = (lado) => { const c = new THREE.WebGLRenderTarget(lado, lado, { type: THREE.UnsignedByteType, generateMipmaps: false, depthBuffer: true });
      c.texture.colorSpace = THREE.SRGBColorSpace; c.texture.minFilter = c.texture.magFilter = THREE.LinearFilter; return c; };
    if (chave === F.chave && this.dirs !== F.dirsVistos) { // another point of the same unit: shoot only the missing window faces
      F.dirsVistos = this.dirs;
      const falta = this.facesDaJanela().filter((f) => !F.faces.includes(f)).slice(0, 4 - F.faces.length);
      if (falta.length) {
        if (F.feito) { F.i = F.faces.length; F.reg = 0; F.fila = null; F.t0 = agora; F.feito = false; this.restauraCache(); const c = this.s.tiles.lruCache; this._guardaCache(); c.minBytesSize = 0; c.unloadPercent = 1; c.maxBytesSize = Math.max(c.maxBytesSize, FOTO_MB); try { localStorage.setItem('tabela3d-foto-ativa', String(Date.now())); } catch (e) { /* ignore */ } }
        for (const f of falta) { F.faces.push(f); F.alvos.push({ A: alvo(FOTO_LADO), W: alvo(FOTO_LADO_W) }); F.mats.push(new THREE.Matrix4().multiplyMatrices(F.cams[f].projectionMatrix, F.cams[f].matrixWorldInverse)); }
      }
    }
    if (chave !== F.chave) { // new unit: a new picture (our render's city stays in the window meanwhile)
      F.chave = chave; F.dirsVistos = this.dirs; F.matriz = this.matriz.clone(); F.faces = this.facesDaJanela(); F.i = 0; F.reg = 0; F.t0 = agora; F.feito = false; F.log = []; F.fila = null;
      // two 2D targets per window face: A = city with neutral light, W = only the lit night windows. The tile shader is linear
      // in (uLuz, uNoiteG): any hour = A x base(hour) + W x lights(hour) in the overlay, no re-shoot when the time changes
      for (const a of F.alvos) { a.A.dispose(); a.W.dispose(); }
      F.alvos = F.faces.map(() => ({ A: alvo(FOTO_LADO), W: alvo(FOTO_LADO_W) }));
      F.mats = F.faces.map((f) => new THREE.Matrix4().multiplyMatrices(F.cams[f].projectionMatrix, F.cams[f].matrixWorldInverse));
      F.limpos = new Set();
      try { localStorage.setItem('tabela3d-foto-ativa', String(Date.now())); } catch (e) { /* private mode */ } // crash guard (capacidade.js)
      if (!window.__g3dSaida) { window.__g3dSaida = true; addEventListener('pagehide', () => { try { localStorage.removeItem('tabela3d-foto-ativa'); } catch (e) { /* ignore */ } }); } // closing the page is not a crash
      this.pronto = false; this.restauraCache();
      { const c = this.s.tiles.lruCache; this._guardaCache(); c.minBytesSize = 0; c.unloadPercent = 1; c.maxBytesSize = Math.max(c.maxBytesSize, FOTO_MB); } // shooting: bigger budget, shot regions dropped at once
    }
    if (F.feito || !F.faces.length) { if (!F.faces.length && !F.feito) { F.feito = true; } return; }
    const N = FOTO_N, L = FOTO_LADO;
    if (!F.fila) { F.fila = []; for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) F.fila.push([(k * L) / N, (j * L) / N, L / N]); F.feitosF = 0; }
    const [x, y, w] = F.fila[0];
    const t = this.s.tiles, base = F.cams[F.faces[F.i]];
    if (!F.sel) F.sel = new THREE.PerspectiveCamera(90, 1, 3, RAIO);
    const cam = F.sel; cam.quaternion.copy(base.quaternion); cam.position.set(0, 0, 0); cam.up.copy(base.up);
    cam.setViewOffset(L, L, x, y, w, w); cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
    this.s.tomar(this, this.s.escena, F.matriz || this.matriz, cam, ERRO_FOTO); // the unit's first point
    if (t.cameras.length !== 1 || t.cameras[0] !== cam) { for (const c of [...t.cameras]) t.deleteCamera(c); t.setCamera(cam); }
    t.setResolution(cam, w, w);
    this.s.escena.updateMatrixWorld(true);
    t.update();
    const st = t.stats, pend = st.queued + st.downloading + st.parsing, tempo = agora - F.t0;
    F.prog = (F.i + Math.min(0.99, F.feitosF / (L * L))) / F.faces.length; // share of this face's area already shot
    // only when this region is COMPLETE (queue empty for 3 frames); a full budget or a stuck queue gives up much later
    F.quietos = pend === 0 && (t.loadProgress === undefined || t.loadProgress >= 1) ? (F.quietos || 0) + 1 : 0;
    const cheio = t.lruCache.isFull();
    if (cheio && w > FOTO_MIN && tempo > 300) { // this region needs more than the budget: split it in 4 and shoot the pieces (off by default: too slow on mid phones, 08/10)
      F.fila.shift(); const h = w / 2; F.fila.unshift([x, y, h], [x + h, y, h], [x, y + h, h], [x + h, y + h, h]);
      const c = t.lruCache, mx = c.maxBytesSize; for (const k of [...t.cameras]) t.deleteCamera(k); c.maxBytesSize = 1; t.update(); c.maxBytesSize = mx;
      F.t0 = agora; F.quietos = 0; this.acordar(); return;
    }
    if ((F.quietos >= 3 && tempo > 200) || (cheio && pend === 0 && tempo > 12000) || tempo > 60000) {
      F.quietos = 0; F.log.push({ f: F.faces[F.i], r: F.reg, ms: Math.round(tempo), cheio: t.lruCache.isFull(), mb: Math.round(t.lruCache.cachedBytes / 1048576), vis: st.visible });
      const r = this.r, cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha(), ant = r.getRenderTarget(), al = F.alvos[F.i];
      const R = this.s.recorte, luz0 = R.luz.value.clone(), noite0 = R.noite.value;
      r.setClearColor(0x000000, 0);
      const pinta = (rt, lado) => {
        const k = lado / L, vx = Math.round(x * k), vy = Math.round((L - y - w) * k), vw = Math.round(w * k);
        if (!F.limpos.has(rt)) { F.limpos.add(rt); rt.scissorTest = false; rt.viewport.set(0, 0, lado, lado); r.setRenderTarget(rt); r.clear(); }
        rt.viewport.set(vx, vy, vw, vw); rt.scissor.set(vx, vy, vw, vw); rt.scissorTest = true;
        r.setRenderTarget(rt); r.clear(); r.render(this.s.escena, cam);
        rt.scissorTest = false; rt.viewport.set(0, 0, lado, lado);
      };
      R.luz.value.set(1, 1, 1); R.noite.value = 0; pinta(al.A, FOTO_LADO);
      R.luz.value.set(0, 0, 0); R.noite.value = 1; pinta(al.W, FOTO_LADO_W);
      R.luz.value.copy(luz0); R.noite.value = noite0;
      r.setRenderTarget(ant); r.setClearColor(cc, ca);
      this.atualizaCredito();
      // flush: every tile of the region just shot leaves memory now (the LRU kept them: the budget filled region after region)
      { const c = t.lruCache, mx = c.maxBytesSize; if (c.cachedBytes > mx * 0.7) { for (const k of [...t.cameras]) t.deleteCamera(k); c.maxBytesSize = 1; t.update(); c.maxBytesSize = mx; } } // flush only when nearly full (08/10: on 4G the full flush re-downloaded shared tiles every region)
      F.fila.shift(); F.feitosF += w * w; F.reg++; F.t0 = agora;
      if (!F.fila.length) { F.fila = null; F.reg = 0; F.i++; }
      if (F.i >= F.faces.length) { F.feito = true; cam.clearViewOffset(); if (!this.pronto) { this.pronto = true; this.tPronto = agora; } STATUS.tiles = st.visible || 0; if (capacidade().nivel === 'topo') this.restauraCache(); else this.soltaCache(); try { localStorage.removeItem('tabela3d-foto-ativa'); } catch (e) { /* ignore */ } }
    }
    this.acordar();
  }
  // mid phones: once the picture is taken the 3D tiles leave the GPU (they were most of its memory; Victor 08/10: "se a gente
  // diminuir o consumo de memoria do google 3d da pra aumentar a resolucao do resto"). A new point loads them again (HTTP cache).
  _guardaCache() { const c = this.s.tiles.lruCache; if (!this._cache0) this._cache0 = { min: c.minBytesSize, max: c.maxBytesSize, pct: c.unloadPercent }; }
  soltaCache() {
    if (capacidade().nivel === 'topo') return;
    const t = this.s.tiles, c = t.lruCache;
    this._guardaCache();
    for (const k of [...t.cameras]) t.deleteCamera(k);
    c.minBytesSize = 0; c.maxBytesSize = 1; c.unloadPercent = 1;
    t.update();
    this._solto = true;
  }
  restauraCache() {
    if (!this._cache0) return;
    const c = this.s.tiles.lruCache; c.minBytesSize = this._cache0.min; c.maxBytesSize = this._cache0.max; c.unloadPercent = this._cache0.pct;
    this._solto = false;
  }
  progressoFoto(ver) {
    const el = this.carga, F = this.foto; if (!el || !F) return;
    const mostra = ver && !F.feito;
    if (el.hidden === mostra) el.hidden = !mostra;
    if (mostra) el.querySelector('b').style.width = Math.round(4 + 96 * F.prog) + '%';
  }
  // Discreet progress (Victor 07/10): while the window is on screen and tiles are still arriving, a thin bar fills with the
  // share of this batch already loaded; it hides ~1 s after the queue empties. Coarse tiles are already drawn meanwhile.
  // 0..1 opacity of the Google overlay (fade 0.8 s after it is ready)
  opacidade() { return this.pronto ? Math.min(1, (performance.now() - this.tPronto) / 800) : 0; }
  progresso(janelaNaTela) {
    const st = this.s.tiles.stats, pend = st.queued + st.downloading + st.parsing, el = this.carga;
    if (!el) return;
    const barra = el.querySelector('b');
    if (pend > 0) {
      if (!this._lote) this._lote = { base: st.loaded, p: 0 };
      const feitos = Math.max(0, st.loaded - this._lote.base);
      this._lote.p = Math.max(this._lote.p, feitos / (feitos + pend));
      clearTimeout(this._some); this._some = 0;
    }
    // our render's city (inside the panorama) stays in the window until Google's view is COMPLETE (Victor 07/10: no melted
    // blobs on screen); then Google fades in and stays for this point, even if a new area starts loading
    if (!this.pronto && st.visible > 0 && (pend === 0 || (this._lote && this._lote.p >= 0.85) || this.s.tiles.lruCache.isFull())) { this.pronto = true; this.tPronto = performance.now(); }
    if (pend === 0) {
      // done: fill the bar, then hide it a moment later (the page may not render again, so a timer does it)
      if (this._lote && !this._some) { barra.style.width = '100%'; this._some = setTimeout(() => { el.hidden = true; this._lote = null; this._some = 0; }, 900); }
      return;
    }
    const ver = !!janelaNaTela;
    if (el.hidden === ver) el.hidden = !ver;
    if (ver) barra.style.width = Math.round(4 + 96 * this._lote.p) + '%';
  }
  // keeps asking for frames while tiles are still arriving, then stops (no idle GPU work)
  acordar() {
    this.ocioso = 0;
    if (this._laco || !this.ativo) return;
    const passo = () => {
      this._laco = 0;
      if (!this.ativo) return;
      const t = this.s.tiles, st = t.stats || {};
      const ocupado = (st.queued || 0) + (st.downloading || 0) + (st.parsing || 0) > 0 || (t.loadProgress !== undefined && t.loadProgress < 1);
      this.aoMudar();
      this.ocioso = ocupado ? 0 : this.ocioso + 1;
      if (this.ocioso < 30 && !this._laco) this._laco = requestAnimationFrame(passo); // desenha() may already have re-armed it
    };
    this._laco = requestAnimationFrame(passo);
  }
  montaCredito() {
    const d = document.createElement('div');
    d.className = 't360-g3d';
    d.innerHTML = '<img alt="Google" src="' + LOGO + '" height="12" referrerpolicy="no-referrer"><span class="g3d-attr"></span>';
    // discreet progress, a separate element (tour360 places it on the left, the credit sits small on the right)
    this.carga = document.createElement('div'); this.carga.className = 't360-g3d-carga'; this.carga.hidden = true;
    this.carga.innerHTML = '<span>Montando a vista real da cidade</span><i><b></b></i>';
    return d;
  }
  atualizaCredito() {
    const out = []; this.s.tiles.getAttributions(out);
    const txt = out.filter((a) => a.type === 'string' && a.value).map((a) => a.value).join(' · ');
    const el = this.credito.querySelector('.g3d-attr');
    if (el && el.textContent !== txt) el.textContent = txt;
  }
  liberar() {
    this.ativo = false;
    if (this._laco) cancelAnimationFrame(this._laco);
    for (const ev of ['load-model', 'tiles-load-end', 'needs-update', 'tile-visibility-change']) this.s.tiles.removeEventListener(ev, this._aoCarregar);
    if (this.s.dono === this) { for (const c of [...this.s.tiles.cameras]) this.s.tiles.deleteCamera(c); this.s.dono = null; }
    if (this.rt) this.rt.dispose();
    if (this.foto) { for (const a of this.foto.alvos) { a.A.dispose(); a.W.dispose(); } this.foto = null; }
    try { localStorage.removeItem('tabela3d-foto-ativa'); } catch (e) { /* ignore */ } // leaving the 360 mid-photo is not a crash
    this.restauraCache();
    this.credito.remove(); if (this.carga) this.carga.remove();
  }
}

// ---------------------------------------------------------------- compositing sphere: Google colour where the pano's `fora` mask is white
const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tG;
uniform sampler2D tM;
uniform vec2 res;
uniform vec3 ganho;
uniform float forca;
uniform vec3 ceuTopo;
uniform vec3 ceuHoriz;
uniform sampler2D fA0; uniform sampler2D fA1; uniform sampler2D fA2; uniform sampler2D fA3;
uniform sampler2D fW0; uniform sampler2D fW1; uniform sampler2D fW2; uniform sampler2D fW3;
uniform mat4 fM[4];
uniform float nF;
uniform float nOk;
uniform vec3 luzBase;
uniform float luzesN;
uniform float usaCubo;
uniform float rumoB;
void main(){
  float m = texture2D(tM, vUv).r;
  vec4 g;
  if (usaCubo > 0.5) { // photo mode: view direction of this sphere texel (scene frame, x mirrored) -> local frame of the shot
    float phi = vUv.x * 6.28318530718, th = 3.14159265359 * (1.0 - vUv.y);
    vec3 d = vec3(cos(phi) * sin(th), cos(th), sin(phi) * sin(th));
    float f = -d.x, r = -d.z;
    vec3 L = vec3(sin(rumoB) * f + cos(rumoB) * r, d.y, -(cos(rumoB) * f - sin(rumoB) * r));
    g = vec4(0.0); bool achou = false;
    for (int k = 0; k < 4; k++) {
      if (float(k) >= nOk) break;
      vec4 c = fM[k] * vec4(L, 1.0);
      if (c.w <= 0.0) continue;
      vec2 q = c.xy / c.w;
      if (abs(q.x) > 1.0 || abs(q.y) > 1.0) continue;
      vec2 uv = q * 0.5 + 0.5; vec4 a; vec3 w;
      if (k == 0) { a = texture2D(fA0, uv); w = texture2D(fW0, uv).rgb; }
      else if (k == 1) { a = texture2D(fA1, uv); w = texture2D(fW1, uv).rgb; }
      else if (k == 2) { a = texture2D(fA2, uv); w = texture2D(fW2, uv).rgb; }
      else { a = texture2D(fA3, uv); w = texture2D(fW3, uv).rgb; }
      g = vec4(a.rgb * luzBase + w * luzesN, a.a); achou = true;
      break;
    }
    if (!achou) { gl_FragColor = vec4(0.0); return; } // face not shot yet: our render's city stays
  } else g = texture2D(tG, gl_FragCoord.xy / res);
  // sky where Google drew nothing (equirect: v 0.5 = horizon, 1 = zenith)
  vec3 ceu = mix(ceuHoriz, ceuTopo, smoothstep(0.5, 0.78, vUv.y));
  gl_FragColor = vec4(mix(ceu, g.rgb * ganho, g.a), m * forca);
  #include <colorspace_fragment>
}`;
export function materialSobreposicao() {
  return new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false,
    uniforms: { tG: { value: null }, tM: { value: null }, res: { value: new THREE.Vector2(1, 1) }, ganho: { value: new THREE.Vector3(1, 1, 1) }, forca: { value: 1 }, fA0: { value: null }, fA1: { value: null }, fA2: { value: null }, fA3: { value: null }, fW0: { value: null }, fW1: { value: null }, fW2: { value: null }, fW3: { value: null },
      fM: { value: [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()] }, nF: { value: 0 }, nOk: { value: 0 }, luzBase: { value: new THREE.Vector3(1, 1, 1) }, luzesN: { value: 0 }, usaCubo: { value: 0 }, rumoB: { value: 0 },
      ceuTopo: { value: new THREE.Vector3(0.12, 0.27, 0.6) }, ceuHoriz: { value: new THREE.Vector3(0.55, 0.66, 0.8) } },
  });
}
// sky colours (linear) for the window by sun elevation: day blue, warm horizon around sunrise/sunset, dark night
export function ceuParaSol(el) {
  const e = Number.isFinite(el) ? el : -20;
  const dia = smooth(-2, 10, e), crep = smooth(-8, 0, e) * (1 - smooth(4, 14, e));
  const L = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
  let topo = L([0.008, 0.012, 0.03], [0.12, 0.27, 0.6], dia), horiz = L([0.02, 0.025, 0.05], [0.55, 0.66, 0.8], dia);
  topo = L(topo, [0.16, 0.2, 0.42], crep * 0.5); horiz = L(horiz, [0.85, 0.6, 0.42], crep * 0.45);
  return { topo, horiz };
}
// daylight baked in the tiles -> dusk / night: darker + bluer, following the same smooth elevation ramp as render-mix.js
export function ganhoParaSol(el, { dia = 1.35, noite = 0.14 } = {}) {
  const t = Math.min(1, Math.max(0, ((Number.isFinite(el) ? el : -12) + 4) / 14)), k = t * t * (3 - 2 * t);
  const tint = [0.55 + 0.45 * k, 0.68 + 0.32 * k, 1.0];
  const g = noite + (dia - noite) * k;
  return tint.map((x) => x * g);
}

// ---------------------------------------------------------------- Phase 2: Google tiles as the city of the OUTSIDE view (cena3d.js)
// ref = { lat, lon, h, rumoX }: geodetic position of the B5 plan origin (sidewalk NW corner, y = 0) and bearing of +x (deg).
// Scene frame of cena3d = B5 frame (x along +x, y up, z along +x + 90 deg). Our tower is NOT touched or hidden by this; only
// the old city (B7 + B9 bake) is hidden once Google's tiles are actually visible, and shown again on any failure.
export async function ligarGoogleCena({ scene, camera, renderer, ref, aoMudar, esconder = [], mostrar = () => {}, recorte = null }) {
  const s = await iniciarGoogle();
  if (!s) return null;
  const { tiles } = s; if (typeof window !== 'undefined') window.__g3dTiles = tiles;
  const la = (ref.lat * Math.PI) / 180, lo = (ref.lon * Math.PI) / 180, b = (ref.rumoX * Math.PI) / 180;
  const e = [-Math.sin(lo), Math.cos(lo), 0];
  const n = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
  const u = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  const ax = [0, 1, 2].map((i) => Math.sin(b) * e[i] + Math.cos(b) * n[i]);               // scene +x in ECEF
  const az = [0, 1, 2].map((i) => Math.sin(b + Math.PI / 2) * e[i] + Math.cos(b + Math.PI / 2) * n[i]); // scene +z
  const P = ecef(ref.lat, ref.lon, ref.h), dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const m = new THREE.Matrix4();
  m.set(ax[0], ax[1], ax[2], -dot(ax, P), u[0], u[1], u[2], -dot(u, P), az[0], az[1], az[2], -dot(az, P), 0, 0, 0, 1);
  const g = tiles.group; g.renderOrder = -1;
  // our tower's box in the B5 frame (= this scene's frame): Google's mesh of the same building is hidden inside it
  if (recorte && !/[?&]recorte=0/.test(location.search)) {
    s.recorte.min.value.copy(recorte.min); s.recorte.max.value.copy(recorte.max); s.recorte.ecefParaB5 = m.clone(); s.recorte.liga.value = 1;
    s._recFeito = false; if (s.atualizaRecorte) s.atualizaRecorte();
  }
  let ganhoCena = [1, 1, 1];
  const tam = new THREE.Vector2(), camSelFora = new THREE.PerspectiveCamera();
  let falhou = false, mostrando = false;
  const cred = document.createElement('div'); cred.className = 'g3d-cena'; // not t360-g3d: the 360's CSS (bottom:78px) stretched it
  // compact credit in a corner (Victor 07/10: it took too much space): Google logo + data attribution, one line, top right
  cred.style.cssText = 'position:absolute;right:8px;top:104px;z-index:5;display:flex;gap:5px;align-items:center;max-width:62%;padding:2px 6px;border-radius:6px;background:rgba(0,0,0,.45);color:#fff;font:9px/1.2 system-ui,sans-serif;pointer-events:none;white-space:nowrap;overflow:hidden';
  cred.innerHTML = '<img alt="Google" src="' + LOGO + '" height="11" style="display:block;flex:none"><span class="g3d-attr" style="opacity:.85;overflow:hidden;text-overflow:ellipsis"></span>';
  cred.hidden = true; // only while Google's city is on screen
  renderer.domElement.parentElement.appendChild(cred);
  // our city stays until Google's first view is complete; meanwhile a discreet bar (top left, under the buttons)
  const carga = document.createElement('div');
  carga.style.cssText = 'position:absolute;left:10px;top:132px;z-index:5;display:flex;flex-direction:column;gap:3px;padding:4px 8px;border-radius:7px;background:rgba(0,0,0,.45);color:#fff;font:10px/1.2 system-ui,sans-serif;pointer-events:none;width:150px';
  carga.innerHTML = '<span>Montando a cidade real</span><i style="display:block;height:2px;border-radius:2px;background:rgba(255,255,255,.25);overflow:hidden"><b style="display:block;height:100%;width:4%;background:#fff;transition:width .4s ease"></b></i>';
  renderer.domElement.parentElement.appendChild(carga);
  let lote0 = null, pMax = 0;
  const aoCarregar = () => aoMudar && aoMudar();
  for (const ev of ['load-model', 'tiles-load-end', 'needs-update']) tiles.addEventListener(ev, aoCarregar);
  const out = [];
  // The page renders on demand: if nothing asks for a frame, tiles.update() never runs and refinement stalls at the coarse
  // level. Any frame that finds pending work keeps asking for frames until the queues are empty for a while.
  let laco = 0, quieto = 0;
  const pendente = () => { const st = tiles.stats; return st.queued + st.downloading + st.parsing > 0 || tiles.loadProgress < 1; };
  const bombear = () => {
    quieto = 0; if (laco || falhou) return;
    const passo = () => { laco = 0; if (falhou) return; aoMudar && aoMudar(); quieto = pendente() ? 0 : quieto + 1; if (quieto < 30 && !laco) laco = requestAnimationFrame(passo); };
    laco = requestAnimationFrame(passo);
  };
  const api = {
    tiles, perf: { n: 0, ms: 0 }, get mostrando() { return mostrando && !falhou; },
    // call once per frame before renderer.render()
    // congelado = the camera is flying into a unit (the 360 opens right after): draw what is loaded, download nothing
    antes(congelado = false) {
      if (falhou || congelado) return;
      try {
        const t0 = performance.now();
        if (s.dono && s.dono !== api && s.dono.ativo) return; // the 360 window owns the tiles while it is open
        if (s.dono !== api) { s.tomar(api, scene, m, camSelFora, ERRO_360 * 1.25); s.pintar(ganhoCena); }
        // tiles are selected only for the part of the screen above the unit card (phone bottom sheet): the city hidden
        // under the card is not downloaded and does not take the memory the prefetch of the unit's window needs
        renderer.getDrawingBufferSize(tam); camera.updateMatrixWorld(true);
        const card = document.getElementById('card'), rc = card && !card.hidden ? card.getBoundingClientRect() : null;
        const fr = rc && rc.width > innerWidth * 0.8 && rc.top > innerHeight * 0.3 ? Math.min(1, rc.top / innerHeight + 0.05) : 1;
        camSelFora.copy(camera, false); camSelFora.far = Math.min(camSelFora.far, RAIO);
        if (fr < 1) camSelFora.setViewOffset(tam.x, tam.y, 0, 0, tam.x, Math.round(tam.y * fr)); else camSelFora.clearViewOffset();
        camSelFora.updateProjectionMatrix(); camSelFora.updateMatrixWorld(true);
        tiles.setResolution(camSelFora, tam.x, Math.round(tam.y * fr)); tiles.update();
        out.length = 0; tiles.getAttributions(out);
        const txt = out.filter((a) => a.type === 'string' && a.value).map((a) => a.value).join(' · ');
        const el = cred.querySelector('.g3d-attr'); if (el.textContent !== txt) el.textContent = txt;
        const st = tiles.stats, pend = st.queued + st.downloading + st.parsing;
        if (!mostrando) {
          if (lote0 == null) lote0 = st.loaded;
          const feitos = st.loaded - lote0; pMax = Math.max(pMax, pend > 0 ? feitos / (feitos + pend) : 0);
          carga.querySelector('b').style.width = Math.round(4 + 96 * pMax) + '%';
          // Google replaces our city when its view is 85% there, complete, or when this device's memory budget is full
          // (on mid phones the budget fills before 'complete': it never switched - Victor 07/10 21h50)
          if (st.visible > 8 && (pend === 0 || pMax >= 0.85 || tiles.lruCache.isFull())) { mostrando = true; carga.remove(); cred.hidden = !!api.noite; }
        }
        if (api.preFoto) { // photo prefetch: next region when the queue is empty (or after 15 s); done after the last one
          const P = api.preFoto; P.q = pend === 0 ? P.q + 1 : 0;
          if ((P.q >= 3 && performance.now() - P.t0 > 300) || performance.now() - P.t0 > 15000) {
            P.reg++; P.t0 = performance.now(); P.q = 0;
            if (P.reg >= FOTO_N * FOTO_N) { api.pararPreCarga(); } else api.passoPreFoto();
          }
          bombear();
        }
        if (pendente()) bombear();
        api.perf.n++; api.perf.ms += performance.now() - t0;
        if (STATUS.erro && /403|429|quota|key|denied|permission/i.test(STATUS.erro)) throw new Error(STATUS.erro);
      } catch (err) { api.desligar(err); }
    },
    // Prefetch (Victor 07/10): when a unit's card opens, start downloading the city as seen from inside that unit, so the
    // 360 window is ready (or nearly) when the client goes in. A second camera at the unit's eye (point meio, B5 frame =
    // this scene frame) looking out through the facade, wide enough for the whole window, at the 360's pixel density.
    // The 360 taking the tiles deletes it; closing the card removes it.
    async preCarregar({ andar, final } = {}) {
      if (falhou || andar == null || final == null) return;
      const { GEO_PREDIO: G } = await import('./google-geo.js');
      const f = G.finais[String(final)]; if (!f) return;
      const [u, v, hp] = [3.7, 4.3, 1.55];
      const x = f.M[0] * u + f.M[1] * v + f.t[0], z = f.M[2] * u + f.M[3] * v + f.t[1], y = G.laje_1 + (andar - 1) * G.piso + hp;
      // EXACTLY the first view of the 360 (point meio, yaw 0, portrait 90 deg) cropped to where the window is on that
      // screen (measured 07/10: rows 37%..77% of the height, full width). A wider prefetch (97x70 deg) needed ~1.5 GB and
      // the cache threw the prefetched tiles away before the 360 used them (measured: 526 tiles downloaded again).
      const W = Math.round(innerWidth * Math.min(3, devicePixelRatio || 1)), H = Math.round(innerHeight * Math.min(3, devicePixelRatio || 1));
      if (!api.camPre) api.camPre = new THREE.PerspectiveCamera(90, 1, 3, RAIO);
      const c = api.camPre; c.fov = innerHeight > innerWidth ? 90 : 75; c.aspect = W / H;
      const y0 = Math.round(H * 0.37), hh = Math.round(H * 0.40);
      c.setViewOffset(W, H, 0, y0, W, hh); c.position.set(x, y, z); c.up.set(0, 1, 0);
      c.lookAt(x + f.M[1] * 100, y, z + f.M[3] * 100); c.updateProjectionMatrix(); c.updateMatrixWorld(true);
      if (s.dono !== api) return; // the 360 is open: it loads its own view
      if (MODO_FOTO) { // photo mode: same regions + detail as the window photo, one region at a time (see antes())
        c.fov = 95; c.aspect = 1; c.clearViewOffset(); c.updateProjectionMatrix();
        api.preFoto = { reg: 0, t0: performance.now(), q: 0 };
        api.preCarga = { andar, final }; api.passoPreFoto(); bombear(); return;
      }
      if (!tiles.cameras.includes(c)) tiles.setCamera(c);
      // this view's errorTarget is 1.25x the 360's: a 1.25x resolution asks for the 360's exact level
      tiles.setResolution(c, Math.round(W * 1.25), Math.round(hh * 1.25));
      api.preCarga = { andar, final }; bombear();
    },
    pararPreCarga() { if (api.camPre && tiles.cameras.includes(api.camPre)) tiles.deleteCamera(api.camPre); api.preCarga = null; api.preFoto = null; },
    // one step of the photo prefetch: region r of FOTO_N x FOTO_N, resolution scaled so this camera gets the photo's detail
    passoPreFoto() {
      const P = api.preFoto, c = api.camPre; if (!P || !c || s.dono !== api) return;
      const N = FOTO_N, L = FOTO_LADO, w = L / N, x = (P.reg % N) * w, y = Math.floor(P.reg / N) * w;
      c.setViewOffset(L, L, x, y, w, w); c.updateProjectionMatrix(); c.updateMatrixWorld(true);
      if (!tiles.cameras.includes(c)) tiles.setCamera(c);
      const k = (ERRO_360 * 1.25) / ERRO_FOTO;
      tiles.setResolution(c, Math.round(w * k), Math.round(w * k));
    },
    // building ghosts (like our city): footprint map of our city's buildings + camera and tower positions (B5 = this frame)
    terreno(tex, ext) { s.recorte.terr.value = tex; s.recorte.terrExt.value = ext; },
    mapaPredios(tex, minX, minZ, tam) { s.recorte.mapa.value = tex; s.recorte.mapaR.value.set(minX, minZ, 1 / tam, 0); },
    fantasma(cam, alvo) { if (!s.recorte.mapa.value) return; s.recorte.mapaR.value.w = cam ? 1 : 0; if (cam) { s.recorte.camB5.value.copy(cam); s.recorte.alvoB5.value.copy(alvo); } },
    // the shadow-overlay material drops the same fragments (no shadow painted on clipped / ghosted Google surfaces)
    aplicarRecorte(material) { material.onBeforeCompile = s.shaderRecorte; material.customProgramCacheKey = () => 'g3d-recorte-sombra'; material.needsUpdate = true; },
    // (kept for the API; Google now stays on at night with its own night light)
    definirNoite(v) {
      if (api.noite === v) return;
      api.noite = v; g.visible = !v; cred.hidden = v || !(mostrando && !falhou);
    },
    // daylight is baked in the tiles: darken + tint at dusk/night (materials are unlit)
    definirSol(el) {
      s.definirLuz(el); api.el = el;
    },
    desligar(err) {
      falhou = true; mostrando = false; carga.remove(); if (laco) cancelAnimationFrame(laco); if (s.dono === api) { scene.remove(g); s.dono = null; } cred.remove(); mostrar();
      console.warn('google3d (cena) desligado', err && err.message); aoMudar && aoMudar();
    },
  };
  bombear();
  return api;
}
