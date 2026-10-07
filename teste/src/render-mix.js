// Light mixing of precomputed Cycles renders (front B6). Light adds linearly, so any time of day / season / set of
// lamps is a weighted SUM of layers rendered once offline:
//   L = gCeu * ceu + gSol * (sol[h] * (1-f) + sol[h+1] * f) + sum(lamp_k on) * lamp_k
// Layers are webp with v = (x / escala)^(1/gama) (manifest), decoded to linear in the shader, summed, white-balanced,
// exposed and tone mapped (Khronos PBR Neutral, same as the B4 interior). Gains = clear-sky illuminance models
// (ESTIMATIVA): direct beam (Meinel) and diffuse horizontal; lamps at their physical power (lm / 683).
// Same API words as src/interior.js (B4): definirHora(minutos) · definirEstacao(estacao) · definirLuz(nome, ligada).
import * as THREE from 'three';
import { solNoInstante } from './interior-sol.js';

// only fixtures seen in the clips (dados/b6-inventario.json > luzes); the curtain LED was removed (not confirmed)
export const LUZES = ['teto', 'abajur', 'cozinha'];
export const ROTULO = 'Imagem ilustrativa fiel ao apartamento — render a partir de fotos e medidas';
const LUX_W = 683, EFICACIA_SOL = 105;

export function dniLux(el) {
  if (el <= 0.5) return 0;
  const am = 1 / Math.max(Math.sin((el * Math.PI) / 180), 0.02);
  return 1353 * 0.7 ** (am ** 0.678) * EFICACIA_SOL;
}
export function dhiLux(el) {
  if (el <= -6) return 3;
  if (el <= 0) return 3 + ((el + 6) / 6) * 400;
  return 400 + 16000 * Math.sin((el * Math.PI) / 180) ** 0.6;
}
const mix3 = (a, b, k) => a.map((x, i) => x + (b[i] - x) * k);
// sky / sun colour by elevation (sunset warmer, night blue) — artistic estimate, documented in RELATORIO-B6
function corCeu(el) { return el > 10 ? [1, 1, 1] : el > -2 ? mix3([1.05, 0.9, 0.85], [1, 1, 1], (el + 2) / 12) : [0.35, 0.45, 0.9]; }
function corSol(el) { return el > 20 ? [1, 0.97, 0.92] : mix3([1, 0.62, 0.36], [1, 0.97, 0.92], Math.max(0, el) / 20); }

const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D t[7];
uniform vec3 g[7];
uniform float esc[7];
uniform float gama;
uniform vec3 wb;
uniform float expo;
uniform sampler2D tFora;
uniform float usaFora;
uniform float fatorFora;
uniform float srgb;
// v4 gradual sun: per-pixel first/last lit half-minute (t_in, t_out) packed in RGB as 12+12 bits
uniform sampler2D tAlb;
uniform sampler2D tNor;
uniform sampler2D tVis;
uniform sampler2D tVis2;
uniform float nInt;
uniform float usaVis;
uniform vec3 gDir;
uniform vec3 solDir;
uniform float meioMin;
uniform vec2 visTam;
float acesaT(sampler2D tx, vec2 uv){
  vec3 c = floor(texture2D(tx, uv).rgb * 255.0 + 0.5);
  float a = c.r * 16.0 + floor(c.g / 16.0);
  float b = mod(c.g, 16.0) * 256.0 + c.b;
  if (a + b < 0.5) return 0.0;
  return clamp((meioMin - a) / 4.0 + 0.5, 0.0, 1.0) * clamp((b - meioMin) / 4.0 + 0.5, 0.0, 1.0);
}
// uv in single-interval space; stacked files: top half (v in 0.5..1 after flipY) = even interval, bottom = odd
float acesa(vec2 uv){
  if (nInt < 0.5) return acesaT(tVis, uv);
  float v = acesaT(tVis, vec2(uv.x, 0.5 + uv.y * 0.5));
  if (nInt > 1.5) v += acesaT(tVis, vec2(uv.x, uv.y * 0.5));
  if (nInt > 2.5) v += acesaT(tVis2, vec2(uv.x, 0.5 + uv.y * 0.5));
  if (nInt > 3.5) v += acesaT(tVis2, vec2(uv.x, uv.y * 0.5));
  return min(v, 1.0);
}
float visSol(vec2 uv){
  vec2 p = uv * visTam - 0.5; vec2 f = fract(p); vec2 d = 1.0 / visTam; vec2 b0 = (floor(p) + 0.5) * d;
  return mix(mix(acesa(b0), acesa(b0 + vec2(d.x, 0.0)), f.x), mix(acesa(b0 + vec2(0.0, d.y)), acesa(b0 + d), f.x), f.y);
}
vec3 neutral(vec3 c){
  const float start = 0.76; const float desat = 0.15;
  float x = min(c.r, min(c.g, c.b));
  float off = x < 0.08 ? x - 6.25 * x * x : 0.04;
  c -= off;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < start) return c;
  float d = 1.0 - start;
  float np = 1.0 - d * d / (peak + d - start);
  c *= np / peak;
  float gg = 1.0 - 1.0 / (desat * (peak - np) + 1.0);
  return mix(c, np * vec3(1.0), gg);
}
void main(){
  vec3 s = vec3(0.0);
  ${[0, 1, 2, 3, 4, 5, 6].map((i) => `if (g[${i}].r + g[${i}].g + g[${i}].b > 0.0) s += g[${i}] * esc[${i}] * pow(texture2D(t[${i}], vUv).rgb, vec3(gama));`).join('\n  ')}
  if (usaVis > 0.5) {
    vec3 alb = pow(texture2D(tAlb, vUv).rgb, vec3(2.2));
    vec3 n = normalize(texture2D(tNor, vUv).rgb * 2.0 - 1.0);
    s += gDir * alb * max(dot(n, solDir), 0.0) * visSol(vUv);
  }
  vec3 x = s * wb * expo;
  if (usaFora > 0.5) x *= mix(1.0, fatorFora, texture2D(tFora, vUv).r); // v4: window exposed on its own
  float l = dot(x, vec3(0.2126, 0.7152, 0.0722));
  x *= (1.0 + 1.0 / 2.5) / (1.0 + l / 2.5);   // soft highlight roll-off (same as scripts/mixer.py)
  vec3 o = neutral(x);
  // (B1) 8-bit target (no float RT on this GPU): store sRGB-encoded values so the darks do not band
  if (srgb > 0.5) o = mix(o * 12.92, 1.055 * pow(max(o, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, o));
  gl_FragColor = vec4(o, 1.0);
}`;

// (B1, Victor's Android 07/10: blocky + banded) decode at full size (createImageBitmap WITHOUT the resize options,
// which some browsers ignore or do badly; fallback <img>.decode()); if the layer is wider than `max`, downscale on a
// canvas with high-quality smoothing; mipmaps on (trilinear minification). INFO is shown by ?debug360=1.
export const INFO = { tamanhos: new Set(), decodificador: null };
async function carregaTextura(url, max, dados = false) {
  if (dados) max = 0; // v4 packed data: never resample
  const blob = await (await fetch(url)).blob();
  let img = null, flipY = false;
  try { img = await createImageBitmap(blob, { imageOrientation: 'flipY', colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); INFO.decodificador = 'createImageBitmap'; }
  catch (e) {
    const el = new Image(); el.src = URL.createObjectURL(blob);
    await el.decode(); img = el; flipY = true; INFO.decodificador = 'img.decode';
  }
  let fonte = img;
  if (max && img.width > max) {
    const c = document.createElement('canvas'); c.width = max; c.height = max / 2;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    if (flipY) { g.translate(0, c.height); g.scale(1, -1); flipY = false; } // keep the same orientation as the bitmap path
    g.drawImage(img, 0, 0, c.width, c.height);
    if (img.close) img.close();
    fonte = c;
  }
  INFO.tamanhos.add(`${fonte.width}x${fonte.height}`);
  const tx = new THREE.Texture(fonte);
  tx.flipY = flipY; tx.colorSpace = THREE.NoColorSpace; tx.generateMipmaps = true;
  tx.minFilter = THREE.LinearMipmapLinearFilter; tx.magFilter = THREE.LinearFilter; tx.anisotropy = 4; tx.needsUpdate = true;
  if (dados) { tx.generateMipmaps = false; tx.minFilter = tx.magFilter = THREE.NearestFilter; tx.anisotropy = 1; }
  return tx;
}
// v4: mean of the direct-sun term at a time of day, linear between the 15-min frames ({"HH:MM": [r,g,b]})
function mediaVis(tab, minutos) {
  if (!tab) return null;
  const ks = Object.keys(tab).map((k) => [+k.slice(0, 2) * 60 + +k.slice(3, 5), tab[k]]).sort((x, y) => x[0] - y[0]);
  if (!ks.length) return null;
  if (minutos <= ks[0][0]) return ks[0][1];
  for (let i = 1; i < ks.length; i++) if (minutos <= ks[i][0]) { const f = (minutos - ks[i - 1][0]) / (ks[i][0] - ks[i - 1][0]); return ks[i - 1][1].map((x, j) => x + (ks[i][1][j] - x) * f); }
  return ks[ks.length - 1][1];
}
const PRETO = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); PRETO.needsUpdate = true;

// One panorama point: owns its layer textures and a render target with the mixed (linear, tone-mapped) result.
export class MisturaPonto {
  constructor(renderer, ponto, base, { larguraMax = 4096, SOL } = {}) {
    this.r = renderer; this.p = ponto; this.base = base; this.max = larguraMax; this.SOL = SOL;
    this.cache = new Map();
    const w = Math.min(larguraMax, ponto.largura || 4096);
    const gl = renderer.getContext();
    const half = renderer.capabilities.isWebGL2 && (gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    this.rt = new THREE.WebGLRenderTarget(w, w / 2, { type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: false });
    // (B1) with a float target keep linear; with an 8-bit target store sRGB (decoded by the sphere material)
    this.rt.texture.colorSpace = half ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
    INFO.rtFloat = !!half; INFO.webgl = renderer.capabilities.isWebGL2 ? 2 : 1; INFO.maxTex = renderer.capabilities.maxTextureSize;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
      uniforms: { t: { value: Array(7).fill(PRETO) }, g: { value: Array.from({ length: 7 }, () => new THREE.Vector3()) },
        esc: { value: Array(7).fill(1) }, gama: { value: 2.2 }, wb: { value: new THREE.Vector3(1, 1, 1) }, expo: { value: 1 }, srgb: { value: half ? 0 : 1 },
        tFora: { value: PRETO }, usaFora: { value: 0 }, fatorFora: { value: 1 },
        tAlb: { value: PRETO }, tNor: { value: PRETO }, tVis: { value: PRETO }, tVis2: { value: PRETO }, nInt: { value: 0 }, usaVis: { value: 0 }, gDir: { value: new THREE.Vector3() },
        solDir: { value: new THREE.Vector3(0, 0, 1) }, meioMin: { value: 0 }, visTam: { value: new THREE.Vector2(1, 1) } },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.cena = new THREE.Scene(); this.cena.add(this.quad);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  textura(rel, dados = false) {
    if (!rel) return Promise.resolve(null);
    if (!this.cache.has(rel)) this.cache.set(rel, carregaTextura(this.base + rel, this.max, dados));
    // (B1) LRU: keep at most 9 layers of this point in memory (ceu + 2 sun + 3 lights + 3 spare)
    const v = this.cache.get(rel); this.cache.delete(rel); this.cache.set(rel, v);
    while (this.cache.size > 12) { const [k, p] = this.cache.entries().next().value; if (this.emUso && this.emUso.has(k)) break; this.cache.delete(k); p.then((t) => t && t.dispose()); }
    return v;
  }
  // (B1) free the layer textures of a point the visitor left (GPU memory); the mixed render target stays
  soltarCamadas() { for (const p of this.cache.values()) p.then((t) => t && t.dispose()); this.cache.clear(); }
  // which layers + gains for a state; also returns the analytic mean (for exposure/white balance)
  plano({ estacao, minutos, luzes }) {
    const s = solNoInstante(this.SOL, estacao, minutos);
    const C = this.p.camadas;
    const el = Number.isFinite(s.el) ? s.el : -12; // 07/10: true elevation also below the horizon (twilight), not -12 until sunrise
    const cc = corCeu(el), cs = corSol(el);
    const lista = [];
    if (C.ceu) lista.push({ c: C.ceu, g: cc.map((x) => (x * dhiLux(el)) / LUX_W) });
    // v4 (gradual sun): indirect+glossy sun layers every ~2 h cross-faded, direct diffuse computed per pixel/minute
    const v4 = !!(C.solvis && C.solvis[estacao] && C.albedo && C.normal && C.solind && C.solind[estacao]);
    let dir = null;
    if (v4) {
      const k = this.p.solvis_k || C.solvis_k || 1;
      const gd = cs.map((x) => (x * dniLux(el) * k) / LUX_W);
      const md = mediaVis((this.p.solvis_media || C.solvis_media || {})[estacao], minutos);
      dir = { vis: C.solvis[estacao], g: gd, media: md, el, az: s.az };
    }
    // sun: hourly layers, cross-faded between the two neighbouring hours (missing hour = no direct sun then)
    const sol = ((v4 ? C.solind : C.sol) && (v4 ? C.solind : C.sol)[estacao]) || {};
    const gs = dniLux(el) / LUX_W;
    // works with hourly or sparser layers (e.g. every 2 h): fade between the nearest rendered hours around `minutos`
    const horas = Object.keys(sol).map((k) => +k.slice(0, 2) * 60 + +k.slice(3, 5)).sort((x, y) => x - y);
    const ant = horas.filter((m) => m <= minutos).pop(), pos = horas.find((m) => m > minutos);
    const nome = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    if (gs > 0 && (ant !== undefined || pos !== undefined)) {
      // a layer only counts within 2 h of the asked time (outside the rendered sun window there is no direct sun)
      const entre = ant !== undefined && pos !== undefined && pos - ant <= (v4 ? 150 : 120);
      const fa = entre ? (pos - minutos) / (pos - ant) : ant !== undefined ? Math.max(0, 1 - (minutos - ant) / 60) : 0;
      const fb = entre ? 1 - fa : pos !== undefined ? Math.max(0, 1 - (pos - minutos) / 60) : 0;
      if (fa > 0) lista.push({ c: sol[nome(ant)], g: cs.map((x) => x * gs * fa) });
      if (fb > 0) lista.push({ c: sol[nome(pos)], g: cs.map((x) => x * gs * fb) });
    }
    for (const k of LUZES) if (luzes && luzes[k] && C[k]) lista.push({ c: C[k], g: [1, 1, 1] });
    const media = [0, 0, 0];
    for (const it of lista) for (let i = 0; i < 3; i++) media[i] += it.g[i] * it.c.media[i];
    // v4: separate interior / exterior means (when every layer has them)
    let mDentro = null, mFora = null;
    if (lista.length && lista.every((it) => it.c.media_dentro && it.c.media_fora)) {
      mDentro = [0, 0, 0]; mFora = [0, 0, 0];
      for (const it of lista) for (let i = 0; i < 3; i++) { mDentro[i] += it.g[i] * it.c.media_dentro[i]; mFora[i] += it.g[i] * it.c.media_fora[i]; }
      const P = this.p, md = (P.solvis_media_dentro || {})[estacao], mf = (P.solvis_media_fora || {})[estacao];
      if (dir && md && mf) { const a = mediaVis(md, minutos), b = mediaVis(mf, minutos); for (let i = 0; i < 3; i++) { mDentro[i] += dir.g[i] * a[i]; mFora[i] += dir.g[i] * b[i]; } }
    }
    if (dir && dir.media) for (let i = 0; i < 3; i++) media[i] += dir.g[i] * dir.media[i];
    return { lista: lista.slice(0, 7), media, mDentro, mFora, sol: s, dir, minutos };
  }
  async atualizar(estado) {
    const pl = this.plano(estado);
    this.emUso = new Set(pl.lista.map((it) => it.c.arq));
    const C = this.p.camadas;
    const visArq = pl.dir ? [].concat(pl.dir.vis.arq) : [];
    const tDir = pl.dir ? await Promise.all([this.textura(C.albedo.arq), this.textura(C.normal.arq), ...visArq.map((a) => this.textura(a, true))]) : null;
    if (pl.dir) for (const a of [C.albedo.arq, C.normal.arq, ...visArq]) this.emUso.add(a);
    const tx = await Promise.all(pl.lista.map((it) => this.textura(it.c.arq)));
    const U = this.mat.uniforms;
    U.usaVis.value = tDir && tDir.every(Boolean) ? 1 : 0;
    if (U.usaVis.value) {
      U.tAlb.value = tDir[0]; U.tNor.value = tDir[1]; U.tVis.value = tDir[2]; U.tVis2.value = tDir[3] || PRETO;
      const empilhado = Array.isArray(pl.dir.vis.arq);
      U.nInt.value = empilhado ? Math.min(pl.dir.vis.intervalos || 2 * visArq.length, 2 * visArq.length) : 0;
      U.visTam.value.set(tDir[2].image.width, empilhado ? tDir[2].image.height / 2 : tDir[2].image.height);
      U.gDir.value.set(...pl.dir.g);
      U.meioMin.value = pl.minutos * 2;
      // sun direction: ENU (x east, y north, z up) from az (clockwise from north) / el, then into the normal-pass frame
      const a = (pl.dir.az * Math.PI) / 180, e = (Math.max(pl.dir.el, 0) * Math.PI) / 180;
      const enu = [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
      const M = this.p.enu_para_normal || this.manifestoMat || [1, 0, 0, 0, 1, 0, 0, 0, 1];
      U.solDir.value.set(M[0] * enu[0] + M[1] * enu[1] + M[2] * enu[2], M[3] * enu[0] + M[4] * enu[1] + M[5] * enu[2], M[6] * enu[0] + M[7] * enu[1] + M[8] * enu[2]).normalize();
    }
    for (let i = 0; i < 7; i++) {
      const it = pl.lista[i];
      U.t.value[i] = (it && tx[i]) || PRETO;
      U.g.value[i].set(...(it ? it.g : [0, 0, 0]));
      U.esc.value[i] = it ? it.c.escala : 1;
    }
    // partial grey-world white balance + exposure from the analytic mean (sum of layer means x gains)
    const lum = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    const m = pl.mDentro || pl.media, y = lum(m); // v4: expose the room on the room, not on the window
    const el = Number.isFinite(pl.sol.el) ? pl.sol.el : -12;
    // (07/10 Victor: "ilumina de uma vez quando o sol nasce") night and day rules blend over -2..8 deg instead of a
    // switch at 2 deg. Daylight: partial grey-world balance; night: keep most of the warm cast of the lamps (a photo
    // would too), otherwise saturated lamp shades turn blue after the balance
    const tDia = Math.min(1, Math.max(0, (el + 2) / 10)), kDia = tDia * tDia * (3 - 2 * tDia);
    const balanco = (WB, noite) => {
      const w = m.map((x) => (y > 0 ? (y / Math.max(x, 1e-9)) ** WB : 1));
      if (noite) { // (B1) warm but not orange: balanced R/B at most 1.25, green in between (never a green cast)
        const c = [m[0] * w[0], m[1] * w[1], m[2] * w[2]];
        const rb = c[0] / Math.max(c[2], 1e-9);
        if (rb > 1.25) { const k = Math.sqrt(rb / 1.25); w[0] /= k; w[2] *= k; c[0] /= k; c[2] *= k; }
        const alvoG = Math.sqrt(c[0] * c[2]); if (c[1] > 0) w[1] *= alvoG / c[1];
        const yy = 0.2126 * m[0] * w[0] + 0.7152 * m[1] * w[1] + 0.0722 * m[2] * w[2]; // keep the luminance
        if (yy > 0) { const n = y / yy; for (let i = 0; i < 3; i++) w[i] *= n; }
      }
      return w;
    };
    const wN = balanco(0.15, true), wD = balanco(0.6, false);
    U.wb.value.set(...wN.map((x, i) => x + (wD[i] - x) * kDia));
    // exposure: night rule unchanged (gain capped at 4.5); day rule adapts only partially to a dim sky, so the room
    // brightens with the dawn instead of being normalised to full brightness as soon as there is any daylight
    const yDia = C.ceu ? (0.2126 * C.ceu.media[0] + 0.7152 * C.ceu.media[1] + 0.0722 * C.ceu.media[2]) * dhiLux(15) / LUX_W : 0;
    const eNoite = y > 0 ? Math.min(ALVO / y, 4.5) : 1;
    const eDia = y > 0 ? (yDia > y ? ALVO / Math.sqrt(y * yDia) : ALVO / y) : 1;
    U.expo.value = Math.min(Math.max(eNoite, eDia), 8);
    // v4 window: exterior exposed on its own mean (brighter key than the room, like a real-estate photo), never
    // brighter than the room exposure would make it; at night the exterior keeps the room exposure
    const tFora = C.fora ? await this.textura(C.fora.arq) : null;
    if (tFora) this.emUso.add(C.fora.arq);
    U.usaFora.value = tFora ? 1 : 0;
    if (tFora) {
      U.tFora.value = tFora;
      const yF = pl.mFora ? lum(pl.mFora) : 0;
      const alvoFora = 0.55;
      const eFora = yF > 0 ? Math.min(U.expo.value, alvoFora / yF) : U.expo.value;
      U.fatorFora.value = 1 + (eFora / U.expo.value - 1) * kDia;
    }
    this.r.setRenderTarget(this.rt); this.r.render(this.cena, this.cam); this.r.setRenderTarget(null);
    this.ultimo = { ...pl, expo: U.expo.value };
    return this.rt.texture;
  }
  liberar() { this.rt.dispose(); this.mat.dispose(); for (const p of this.cache.values()) p.then((t) => t && t.dispose()); }
}
export let ALVO = 0.30;   // mean-luminance key (tuned on the proof prints; see RELATORIO-B6)
export function definirAlvo(x) { ALVO = x; }
