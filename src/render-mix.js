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
  vec3 x = s * wb * expo;
  float l = dot(x, vec3(0.2126, 0.7152, 0.0722));
  x *= (1.0 + 1.0 / 2.5) / (1.0 + l / 2.5);   // soft highlight roll-off (same as scripts/mixer.py)
  gl_FragColor = vec4(neutral(x), 1.0);
}`;

async function carregaTextura(url, max) {
  const blob = await (await fetch(url)).blob();
  const opt = { imageOrientation: 'flipY', colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
  let bmp = await createImageBitmap(blob, opt);
  if (max && bmp.width > max) { bmp.close?.(); bmp = await createImageBitmap(blob, { ...opt, resizeWidth: max, resizeHeight: max / 2, resizeQuality: 'high' }); }
  const tx = new THREE.Texture(bmp);
  tx.flipY = false; tx.colorSpace = THREE.NoColorSpace; tx.generateMipmaps = false;
  tx.minFilter = THREE.LinearFilter; tx.magFilter = THREE.LinearFilter; tx.needsUpdate = true;
  return tx;
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
    this.rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false,
      uniforms: { t: { value: Array(7).fill(PRETO) }, g: { value: Array.from({ length: 7 }, () => new THREE.Vector3()) },
        esc: { value: Array(7).fill(1) }, gama: { value: 2.2 }, wb: { value: new THREE.Vector3(1, 1, 1) }, expo: { value: 1 } },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.cena = new THREE.Scene(); this.cena.add(this.quad);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  textura(rel) {
    if (!rel) return Promise.resolve(null);
    if (!this.cache.has(rel)) this.cache.set(rel, carregaTextura(this.base + rel, this.max));
    return this.cache.get(rel);
  }
  // which layers + gains for a state; also returns the analytic mean (for exposure/white balance)
  plano({ estacao, minutos, luzes }) {
    const s = solNoInstante(this.SOL, estacao, minutos);
    const C = this.p.camadas;
    const el = s.dia ? s.el : -12;
    const cc = corCeu(el), cs = corSol(el);
    const lista = [];
    if (C.ceu) lista.push({ c: C.ceu, g: cc.map((x) => (x * dhiLux(el)) / LUX_W) });
    // sun: hourly layers, cross-faded between the two neighbouring hours (missing hour = no direct sun then)
    const sol = (C.sol && C.sol[estacao]) || {};
    const gs = dniLux(el) / LUX_W;
    // works with hourly or sparser layers (e.g. every 2 h): fade between the nearest rendered hours around `minutos`
    const horas = Object.keys(sol).map((k) => +k.slice(0, 2) * 60 + +k.slice(3, 5)).sort((x, y) => x - y);
    const ant = horas.filter((m) => m <= minutos).pop(), pos = horas.find((m) => m > minutos);
    const nome = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    if (gs > 0 && (ant !== undefined || pos !== undefined)) {
      // a layer only counts within 2 h of the asked time (outside the rendered sun window there is no direct sun)
      const fa = ant !== undefined && minutos - ant <= 120 ? (pos !== undefined && pos - ant <= 120 ? (pos - minutos) / (pos - ant) : 1) : 0;
      const fb = pos !== undefined && pos - minutos <= 120 ? 1 - fa : 0;
      if (fa > 0) lista.push({ c: sol[nome(ant)], g: cs.map((x) => x * gs * fa) });
      if (fb > 0) lista.push({ c: sol[nome(pos)], g: cs.map((x) => x * gs * fb) });
    }
    for (const k of LUZES) if (luzes && luzes[k] && C[k]) lista.push({ c: C[k], g: [1, 1, 1] });
    const media = [0, 0, 0];
    for (const it of lista) for (let i = 0; i < 3; i++) media[i] += it.g[i] * it.c.media[i];
    return { lista: lista.slice(0, 7), media, sol: s };
  }
  async atualizar(estado) {
    const pl = this.plano(estado);
    const tx = await Promise.all(pl.lista.map((it) => this.textura(it.c.arq)));
    const U = this.mat.uniforms;
    for (let i = 0; i < 7; i++) {
      const it = pl.lista[i];
      U.t.value[i] = (it && tx[i]) || PRETO;
      U.g.value[i].set(...(it ? it.g : [0, 0, 0]));
      U.esc.value[i] = it ? it.c.escala : 1;
    }
    // partial grey-world white balance + exposure from the analytic mean (sum of layer means x gains)
    const m = pl.media, y = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
    const noite = !pl.sol.dia || pl.sol.el < 2;
    // daylight: partial grey-world balance; night: keep most of the warm cast of the lamps (a photo would too),
    // otherwise saturated lamp shades turn blue after the balance
    const WB = noite ? 0.15 : 0.6;
    U.wb.value.set(...m.map((x) => (y > 0 ? (y / Math.max(x, 1e-9)) ** WB : 1)));
    U.expo.value = y > 0 ? Math.min(ALVO / y, noite ? 40 : 8) : 1;
    this.r.setRenderTarget(this.rt); this.r.render(this.cena, this.cam); this.r.setRenderTarget(null);
    this.ultimo = { ...pl, expo: U.expo.value };
    return this.rt.texture;
  }
  liberar() { this.rt.dispose(); this.mat.dispose(); for (const p of this.cache.values()) p.then((t) => t && t.dispose()); }
}
export let ALVO = 0.30;   // mean-luminance key (tuned on the proof prints; see RELATORIO-B6)
export function definirAlvo(x) { ALVO = x; }
