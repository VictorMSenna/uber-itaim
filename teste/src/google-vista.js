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
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const V = '3d-tiles-renderer@0.5.3'; // pinned
const CDN = `https://cdn.jsdelivr.net/npm/${V}/build/`;
const DRACO = 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/libs/draco/gltf/';
const LOGO = 'https://maps.gstatic.com/mapfiles/api-3/images/google_white5_hdpi.png';

// detail level: ?gerr=<px> sets the 360 target, the outside view uses 1.25x
// 16 px at the drawing-buffer size (= ~5 CSS px on a 3x phone): measured 07/10 to look the same as 8 on a phone screen
// (prints/b10/g11-niveis.png) with ~half the download; zooming in still refines, since the target is in screen pixels
const ERRO_360 = (typeof location !== 'undefined' && +new URLSearchParams(location.search).get('gerr')) || 16;
// ON by default (07/10); ?google3d=0 turns it off. Key: test harness (window.__G3D_KEY) or ?gkey=, else src/g3d-chave.js,
// which only exists in the PUBLISHED copy (written by prepara_pages.py from the referrer-restricted site key)
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

// ---------------------------------------------------------------- shared session (ONE root tileset request per page load)
let sessao = null;
export const STATUS = { estado: 'parado', erro: null, raiz: 0, bytes: 0, tiles: 0 };
if (typeof window !== 'undefined') window.__g3d = STATUS;

export function iniciarGoogle() {
  if (sessao) return sessao;
  sessao = (async () => {
    const chave = await chaveDaPagina();
    if (!chave || desligadoPorUrl()) { STATUS.estado = 'sem-chave'; return null; }
    STATUS.estado = 'carregando';
    try {
      const [{ TilesRenderer }, { GoogleCloudAuthPlugin }] = await Promise.all([import(`${CDN}index.js`), import(`${CDN}index.core-plugins.js`)]);
      const tiles = new TilesRenderer();
      tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: chave, autoRefreshToken: true, logoUrl: LOGO, useRecommendedSettings: false }));
      const draco = new DRACOLoader(); draco.setDecoderPath(DRACO);
      const gltf = new GLTFLoader(tiles.manager); gltf.setDRACOLoader(draco);
      tiles.manager.addHandler(/\.gltf$/, gltf);
      tiles.errorTarget = 8;                      // detail: close, narrow views (each view sets its own below)
      if (tiles.downloadQueue) tiles.downloadQueue.maxJobs = 30; if (tiles.parseQueue) tiles.parseQueue.maxJobs = 8;
      // 07/10: at 300 MB the cache was FULL (315 MB) and the renderer refused every finer tile -> coarse city. The full-detail
      // view needs more; ?gmb=<MB> overrides for measuring. Same on phones (high-end target): no coarsening.
      const mb = +new URLSearchParams(location.search).get('gmb') || 1200;
      tiles.lruCache.maxBytesSize = mb * 1048576; tiles.lruCache.minBytesSize = Math.round(mb * 0.6) * 1048576;
      tiles.autoDisableRendererCulling = true;
      const escena = new THREE.Scene(); escena.add(tiles.group);
      const s = { tiles, escena, TilesRenderer, dono: null, cor: [1, 1, 1] };
      // ONE tiles set serves two views (outside scene and 360 window). Whoever draws takes it: its scene, its frame, ONLY its
      // camera (a forgotten camera keeps loading tiles for a view nobody sees) and its detail target.
      s.tomar = (quem, pai, matriz, cam, erro) => {
        if (s.dono !== quem) {
          for (const c of [...tiles.cameras]) tiles.deleteCamera(c);
          tiles.setCamera(cam);
          const g = tiles.group; if (g.parent !== pai) { g.parent?.remove(g); pai.add(g); }
          s.dono = quem;
        }
        const g = tiles.group; g.matrixAutoUpdate = false;
        if (!g.matrix.equals(matriz)) { g.matrix.copy(matriz); g.matrixWorldNeedsUpdate = true; }
        tiles.errorTarget = erro;
      };
      // unlit tiles: one colour multiplier for all of them, also for tiles that arrive later
      s.pintar = (k) => { s.cor = k; tiles.group.traverse((o) => { if (o.isMesh && o.material && o.material.color) o.material.color.setRGB(k[0], k[1], k[2]); }); };
      tiles.addEventListener('load-model', (ev) => { const k = s.cor; if (k[0] !== 1 || k[1] !== 1 || k[2] !== 1) ev.scene.traverse((o) => { if (o.isMesh && o.material && o.material.color) o.material.color.setRGB(k[0], k[1], k[2]); }); });
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
    this.camSel = new THREE.PerspectiveCamera(60, 1, 3, 20000);
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
  // Discreet progress (Victor 07/10): while the window is on screen and tiles are still arriving, a thin bar fills with the
  // share of this batch already loaded; it hides ~1 s after the queue empties. Coarse tiles are already drawn meanwhile.
  // 0..1 opacity of the Google overlay (fade 0.8 s after it is ready)
  opacidade() { return this.pronto ? Math.min(1, (performance.now() - this.tPronto) / 800) : 0; }
  progresso(janelaNaTela) {
    const st = this.s.tiles.stats, pend = st.queued + st.downloading + st.parsing, el = this.credito.querySelector('.g3d-carga');
    if (!el) return;
    const barra = el.querySelector('b');
    if (pend > 0) {
      if (!this._lote) this._lote = { base: st.loaded, p: 0 };
      const feitos = Math.max(0, st.loaded - this._lote.base);
      this._lote.p = Math.max(this._lote.p, feitos / (feitos + pend));
      clearTimeout(this._some); this._some = 0;
    }
    // our render's city (inside the panorama) stays in the window until Google's batch is half loaded (the first seconds
    // are melted blobs); then Google fades in and stays for this point, even if a new area starts loading
    if (!this.pronto && (pend === 0 || (this._lote && this._lote.p >= 0.5))) { this.pronto = true; this.tPronto = performance.now(); }
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
    d.innerHTML = '<span class="g3d-quem">Cidade: Google</span><img alt="Google Maps" src="' + LOGO + '" height="18" referrerpolicy="no-referrer"><span class="g3d-attr"></span>'
      + '<span class="g3d-carga" hidden><span class="g3d-carga-txt">Montando a vista real da cidade</span><i><b></b></i></span>';
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
    if (this.s.dono === this) { this.s.tiles.deleteCamera(this.camSel); this.s.dono = null; }
    if (this.rt) this.rt.dispose();
    this.credito.remove();
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
void main(){
  float m = texture2D(tM, vUv).r;
  vec4 g = texture2D(tG, gl_FragCoord.xy / res);
  gl_FragColor = vec4(g.rgb * ganho, m * g.a * forca);
  #include <colorspace_fragment>
}`;
export function materialSobreposicao() {
  return new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false,
    uniforms: { tG: { value: null }, tM: { value: null }, res: { value: new THREE.Vector2(1, 1) }, ganho: { value: new THREE.Vector3(1, 1, 1) }, forca: { value: 1 } },
  });
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
export async function ligarGoogleCena({ scene, camera, renderer, ref, aoMudar, esconder = [], mostrar = () => {} }) {
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
  let ganhoCena = [1, 1, 1];
  const tam = new THREE.Vector2(), camSelFora = new THREE.PerspectiveCamera();
  let falhou = false, mostrando = false;
  const cred = document.createElement('div'); cred.className = 'g3d-cena'; // not t360-g3d: the 360's CSS (bottom:78px) stretched it
  cred.style.cssText = 'position:absolute;left:10px;top:138px;z-index:5;display:flex;gap:8px;align-items:center;padding:4px 8px;border-radius:8px;background:rgba(0,0,0,.6);color:#fff;font:11px system-ui,sans-serif;pointer-events:none';
  cred.innerHTML = '<span>Cidade: Google</span><img alt="Google Maps" src="' + LOGO + '" height="16"><span class="g3d-attr" style="opacity:.85"></span>';
  renderer.domElement.parentElement.appendChild(cred);
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
        camSelFora.copy(camera, false);
        if (fr < 1) camSelFora.setViewOffset(tam.x, tam.y, 0, 0, tam.x, Math.round(tam.y * fr)); else camSelFora.clearViewOffset();
        camSelFora.updateProjectionMatrix(); camSelFora.updateMatrixWorld(true);
        tiles.setResolution(camSelFora, tam.x, Math.round(tam.y * fr)); tiles.update();
        out.length = 0; tiles.getAttributions(out);
        const txt = out.filter((a) => a.type === 'string' && a.value).map((a) => a.value).join(' · ');
        const el = cred.querySelector('.g3d-attr'); if (el.textContent !== txt) el.textContent = txt;
        if (!mostrando && tiles.stats.visible > 8 && tiles.loadProgress > 0.9) mostrando = true;
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
      if (!api.camPre) api.camPre = new THREE.PerspectiveCamera(90, 1, 3, 20000);
      const c = api.camPre; c.fov = innerHeight > innerWidth ? 90 : 75; c.aspect = W / H;
      const y0 = Math.round(H * 0.37), hh = Math.round(H * 0.40);
      c.setViewOffset(W, H, 0, y0, W, hh); c.position.set(x, y, z); c.up.set(0, 1, 0);
      c.lookAt(x + f.M[1] * 100, y, z + f.M[3] * 100); c.updateProjectionMatrix(); c.updateMatrixWorld(true);
      if (s.dono !== api) return; // the 360 is open: it loads its own view
      if (!tiles.cameras.includes(c)) tiles.setCamera(c);
      // this view's errorTarget is 1.25x the 360's: a 1.25x resolution asks for the 360's exact level
      tiles.setResolution(c, Math.round(W * 1.25), Math.round(hh * 1.25));
      api.preCarga = { andar, final }; bombear();
    },
    pararPreCarga() { if (api.camPre && tiles.cameras.includes(api.camPre)) tiles.deleteCamera(api.camPre); api.preCarga = null; },
    // daylight is baked in the tiles: darken + tint at dusk/night (materials are unlit)
    definirSol(el) {
      const k = ganhoParaSol(el, { dia: 1, noite: 0.16 });
      ganhoCena = k; if (s.dono === api) s.pintar(k);
      api.ganho = k;
    },
    desligar(err) {
      falhou = true; mostrando = false; if (laco) cancelAnimationFrame(laco); if (s.dono === api) { scene.remove(g); s.dono = null; } cred.remove(); mostrar();
      console.warn('google3d (cena) desligado', err && err.message); aoMudar && aoMudar();
    },
  };
  bombear();
  return api;
}
