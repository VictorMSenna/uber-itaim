// Real surroundings of the tower (front B7): the city around R. Joao Cachoeira 1577 as it is, for the view from each
// window (interior) and around the outside 3D model (maquete).
//
//   import { criarEntorno, ATRIBUICAO_ENTORNO } from './entorno.js';
//   const ent = criarEntorno({ cena, renderer, modo: 'interior' | 'externo', T, hPiso, alvo, aoCarregar });
//   ent.grupo                      THREE.Group already added to `cena` (empty until the files arrive, ~2-8 MB, lazy)
//   ent.pronto                     Promise resolved when textured (rejects -> keep the old view, nothing breaks)
//   ent.atualizarHora(min, est)    minutes 0..1439 + 'outono'|'inverno'|'primavera'|'verao' (sun from luz-curva.js)
//   ent.atualizarSol({ el, t })    same, when the caller already has the sun elevation (deg) and minutes
//   ent.atualizarCamera(camera)    externo: ghosts the neighbours between the camera and the tower (call per frame/move)
//   ent.nota                       short honest caption for the screen; ATRIBUICAO_ENTORNO for the legal footer
//   ent.dispose()
// Frames: geometry is in the B5 plan frame (dados/predio-forma.json: x away from the street, z from the 1-3-5-7-9 row to
// the 2-4-6-8 row, y up from the sidewalk). 'interior' maps it into the apartment frame of interior.js with the same
// transform B4 uses for the sky/neighbours (T = interior-sol transformacao(), hPiso = alturaPiso(andar)).
// Pixels: walls = drone frames of the building (April 2026) projected on the LiDAR geometry; walls the drone never saw
// are filled with real facade pixels of the same building (or of a similar one); ground and roofs = GeoSampa
// orthophoto 2020. Built by D:\Imobiliaria-Hugo\uber-itaim\b7-entorno\scripts (see docs/RELATORIO-B7-entorno.md).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { posicaoSolar, fatorLuzesNoite, calorSol, corCeu, smooth, fatorDia, forcaSolDireto } from './luz-curva.js';
import { SOL } from './dados-sol.js';
import { b7Ativo } from './entorno-config.js';

const BASE = new URL('../assets/entorno/', import.meta.url).href;
const BASE_TOPO = /[?&]orto=antes/.test(location.search) ? BASE + 'teste-antes/' : BASE;   // test switch: textures with the baked shadows

// E2 (Victor 00:5x "muito laranja"): the drone/orthophoto pixels ALREADY contain real daylight (April, ~13:20). They are
// never re-lit by the scene sun; only graded from the shared luz-curva:
//   exposure  = fatorDia(el)          (1 at full day: the photo as it is; darker through twilight)
//   quente    = <= 0.12 warm shift, golden hour only, applied in the shader only to faces turned to the sun
//   frio      = <= 0.05 cool shift on faces in shadow during the day
//   azul/noite= cool cast at blue hour / dark blue night
//   luzes     = street lights + lit windows, only once it is really dark (they were at 24% at sunrise and turned the
//               dimmed city orange)
export const JANELA_EXPO = +((/[?&]janelaExpo=([\d.]+)/.exec(typeof location !== 'undefined' ? location.search : '') || [0, 2.8])[1]);   // W-VISTA: 2.8 = city behind the glass about as bright as in the 2026 clips (1.0 / 1.8 / 2.4 / 3.2 tested; ?janelaExpo= overrides)
export function gradeEntorno(el) {
  const k = 0.04 + 0.96 * fatorDia(el);
  const quente = 0.12 * calorSol(el) * smooth(-1, 2, el);
  const frio = 0.05 * smooth(0, 12, el);
  const azul = smooth(-14, -3, el) * (1 - smooth(-2, 8, el));
  const noite = 1 - smooth(-14, -4, el);
  const luzes = fatorLuzesNoite(el) * (1 - smooth(-7, 0, el));
  const base = [1, 1, 1].map((v, i) => {
    let x = v;
    x += ([0.90, 0.95, 1.06][i] - x) * azul * 0.6;
    x += ([0.62, 0.74, 1.05][i] - x) * noite;
    return x * k;
  });
  return { k, base, quente, frio, azul, noite, luzes };
}
export const ATRIBUICAO_ENTORNO = 'Entorno: imagens de drone do prédio (abr/2026); mapa 3D LiDAR 2017 e ortofoto 2020 da Prefeitura de São Paulo — GeoSampa (CC BY-SA 4.0).';
export const NOTA_ENTORNO = 'vista reconstruída a partir de imagens de drone (abril/2026) e do mapa 3D da Prefeitura';

const VERT = /* glsl */`
  #include <common>
  #include <shadowmap_pars_vertex>
  uniform mat4 uLocal;              // mesh (quantised node) -> B5 plan frame
  #ifdef COM_CENTRO
  attribute vec4 _centro;           // building/tree centre (x, z), radius (m, B5 frame), wall normal angle (deg x 10)
  #endif
  varying vec2 vUv; varying vec3 vB; varying vec3 vW; varying vec3 vC; varying float vAng;
  attribute vec2 lmuv; varying vec2 vLm;   // B9: 2nd UV of the near walls (baked sky-light atlas); (0,0) elsewhere
  void main() {
    vUv = uv; vLm = lmuv;
    #ifdef COM_CENTRO
    vC = _centro.xyz; vAng = _centro.w * 0.1;
    #else
    vC = vec3(9999.0, 9999.0, 0.0); vAng = 9999.0;
    #endif
    vB = (uLocal * vec4(position, 1.0)).xyz;
    vec4 worldPosition = modelMatrix * vec4(position, 1.0); vW = worldPosition.xyz;
    #ifdef ANEL
    // E4b far ring (2-5 km): slide each vertex along its view ray to 1.9-2.4 km - same pixel, same depth ORDER, inside the
    // cameras' far planes (B1: 2600 / 3600 m). Haze and normals keep using the true position (vW).
    float dc = distance(worldPosition.xyz, cameraPosition);
    if (dc > 1900.0) worldPosition.xyz = cameraPosition + (worldPosition.xyz - cameraPosition) * ((1900.0 + (dc - 1900.0) * 0.17) / dc);
    #endif
    vec4 mvPosition = viewMatrix * worldPosition;
    gl_Position = projectionMatrix * mvPosition;
    #include <shadowmap_vertex>
  }`;
const FRAG = /* glsl */`
  #include <common>
  #include <packing>
  #include <shadowmap_pars_fragment>
  uniform float uDbg;
  uniform float uSombraK;                          // F40: strength of the real-time shadow (0 = night / no direct sun)
  uniform float uSolK;                             // direct-sun strength for the procedural facades' sunlit/shade sides
  uniform float uJanela;
  uniform sampler2D map; uniform float uTipo;      // 0 walls, 1 ground/roofs, 2 trees, 3 far walls (tiled)
  uniform sampler2D uDet; uniform float uDetOn; uniform vec3 uDetBox;      // 0.1 m orthophoto near the tower (cx, cz, half)
  uniform sampler2D uRua; uniform float uRuaOn; uniform float uRuaExt;     // street-light glow map (R sodium, G LED)
  uniform vec3 uSolW; uniform float uQuente; uniform float uFrio;   // E2: sun direction (world), warm/cool amounts
  uniform vec3 uGrade; uniform float uNoite; uniform float uFrac; uniform vec3 uHaze; uniform vec3 uHazeQ; uniform float uHazeD;
  uniform float uFant; uniform vec3 uCam; uniform vec3 uAlvo; uniform float uRaio; uniform float uSoChao;
  varying vec2 vUv; varying vec3 vB; varying vec3 vW; varying vec3 vC; varying float vAng; varying vec2 vLm;
  // B9 (07/10): sky light baked in Cycles (AO + bounce, no sun): walls = uLmP at vLm, ground/roofs = uLmT top-down
  // (box uLmBox = cx, cz, half). Stored as sqrt(lm / 2): walls relative to their building's mean, ground relative to open roofs. uLmK = strength (photo walls, procedural walls, ground).
  uniform sampler2D uLmP; uniform sampler2D uLmT; uniform float uLmOn; uniform float uLmPOn; uniform vec3 uLmBox; uniform vec3 uLmK;
  // B9: path-traced facade tiles (1 bay x 1 floor, 6 styles, 3 x 2 slots of 320 px, tile 256 + 32 px wrapped gutter)
  uniform sampler2D uFach; uniform float uFachOn; uniform vec4 uFachMed[6]; uniform float uFachW[6];
  float gFres = 0.0;   // B9: Schlick term of the view angle on this pixel (set in main, read by fachada())
  float h11(float x) { x = fract(floor(x) * 0.1031); x *= x + 33.33; x *= x + x; return fract(x); }   // no sin(): stable on D3D/ANGLE
  float h21(vec2 p);
  // E4: believable facade where no good photo exists - window/slab grid (same grid as the night windows: 3.1 x 2.85 m),
  // slightly reflective glass, darker ground floor, per-building variation; fades to its average far away (no shimmer)
  vec3 fachada(vec3 parede, vec3 pB, vec3 n, float seed, vec3 dvx, vec3 dvy) {
    // E4c ROOT CAUSE: fwidth()/dFdx() inside a per-pixel branch are undefined (D3D/ANGLE: garbage per pixel -> black
    // speckle). Derivatives are taken once in main(), in uniform control flow, and passed in (dvx, dvy = d(vB)/dx,dy).
    // E4c: the screen-derivative normal is noisy (float32 at ~300 m) -> snap the wall direction to 0.5 deg so the
    // along-wall coordinate does not jump between window cells from pixel to pixel (black speckle on light walls)
    float ang = vAng < 9000.0 ? radians(vAng) : atan(n.z, n.x);   // per-vertex wall angle (exact); far layer: derived
    ang = floor(ang / 0.00872665 + 0.5) * 0.00872665;
    vec3 tg = vec3(-sin(ang), 0.0, cos(ang));
    float s = dot(pB, tg), y = pB.y;
    vec2 q = vec2(s / 3.1, y / 2.85);
    vec2 f = fract(q), cel = floor(q);
    float larg = mix(0.18, 0.30, h11(seed));               // window width share per building
    float fita = step(0.78, h11(seed + 3.0));                // ~1 in 5 buildings: ribbon windows
    float lx = mix(larg, 0.02, fita);
    float jan = smoothstep(lx, lx + 0.03, f.x) * (1.0 - smoothstep(1.0 - lx - 0.03, 1.0 - lx, f.x))
              * smoothstep(0.34, 0.38, f.y) * (1.0 - smoothstep(0.84, 0.88, f.y));
    float laje = 1.0 - 0.10 * (1.0 - smoothstep(0.0, 0.07, f.y));
    float cortina = h21(cel + vec2(h11(seed) * 97.0, h11(seed + 1.0) * 89.0));
    vec3 vidro = mix(vec3(0.035, 0.045, 0.055), vec3(0.16, 0.18, 0.20), 0.3 + 0.2 * cortina);   // glass reads dark in daylight photos
    vec3 parede2 = parede * (0.98 + 0.03 * h21(floor(q * vec2(0.25, 0.5)) + h11(seed) * 53.0));
    float cortinaVidro = step(0.80, h11(seed + 7.0));       // ~1 in 5 buildings: dark glass curtain wall
    vidro = mix(vidro, vec3(0.05, 0.065, 0.08) + 0.06 * cortina, cortinaVidro);
    jan = mix(jan, 1.0 - 0.85 * (1.0 - smoothstep(0.0, 0.06, f.y)), cortinaVidro);
    parede2 *= mix(0.78, 1.0, h11(seed + 11.0));             // per-building tone (photos: walls rarely look white)
    vec3 c = mix(parede2 * laje, vidro, jan);
    float pier = 0.0;
    vec3 media = mix(parede2, vidro, mix(0.32 * (1.0 - fita) + 0.55 * fita, 0.9, cortinaVidro));
    // W-VISTA (07/10): the 2026 window clips show SP residential towers = continuous BALCONY BANDS (white slab edge, glass
    // railing, shaded recess, piers between units), not punched windows -> ~45% of the non-glass buildings use that style
    float varanda = step(0.45, h11(seed + 13.0)) * (1.0 - cortinaVidro);
    if (varanda > 0.5) {
      float wu = mix(7.0, 10.5, h11(seed + 17.0));               // unit width between piers
      pier = 1.0 - step(0.07, fract(s / wu));
      vec3 laj = parede2 * 1.06, gr = mix(parede2 * 0.78, vec3(0.20, 0.25, 0.25), 0.45), rec = mix(vidro, parede2 * 0.42, 0.35);
      float b1 = smoothstep(0.085, 0.10, f.y), b2 = smoothstep(0.39, 0.41, f.y);
      c = mix(mix(laj, gr, b1), rec, b2);
      c = mix(c, parede2 * 0.95, pier);
      media = mix(laj * 0.09 + gr * 0.31 + rec * 0.60, parede2 * 0.95, 0.07);
    }
    vec2 fw = vec2(abs(dot(dvx, tg)) + abs(dot(dvy, tg)), abs(dvx.y) + abs(dvy.y)) / vec2(3.1, 2.85);
    float fz = mix(4.0, 2.4, uJanela);
    if (uFachOn > 0.5) {
      // B9: same per-building style choice as above, but the bay is a path-traced tile (recess, frames, sill, railing
      // glass, balcony depth) instead of flat bands; the far average comes from the same tile (no pop when fading)
      int ti = cortinaVidro > 0.5 ? 3 : varanda > 0.5 ? (h11(seed + 19.0) > 0.5 ? 4 : 5) : fita > 0.5 ? 2 : (larg < 0.24 ? 1 : 0);
      vec2 slot = vec2(float(ti - (ti / 3) * 3), float(ti / 3));
      vec2 AT = vec2(960.0, 640.0);
      vec2 tuv = (slot * 320.0 + 32.0 + vec2(f.x, 1.0 - f.y) * 256.0) / AT;
      vec2 gx = vec2(dot(dvx, tg) / 3.1, -dvx.y / 2.85) * 256.0, gy = vec2(dot(dvy, tg) / 3.1, -dvy.y / 2.85) * 256.0;
      float esc = min(1.0, 32.0 / max(max(length(gx), length(gy)), 1e-4));   // LOD <= 5: the 32 px gutter holds
      vec4 t = textureGrad(uFach, tuv, gx * esc / AT, gy * esc / AT);
      // walls: the measured building colour shaded by the tile; glass: the B7-calibrated glass colour (E4b palette)
      // modulated by the tile's own structure (frames, recess, mullions) -> same average as before, plus detail
      vec4 mT = uFachMed[ti];
      vec3 ct = mix(t.rgb * vidro / max(mT.rgb, vec3(0.01)), t.rgb * parede2 / 0.8, t.a);
      ct *= mix(1.0, 0.85 + 0.3 * cortina, 1.0 - t.a);                          // curtains / lamps differ per window
      ct = mix(ct, vec3(0.55, 0.62, 0.70), (1.0 - t.a) * (0.05 + 0.6 * gFres));   // glass mirrors the sky at grazing angles (Schlick)
      if (varanda > 0.5) ct = mix(ct, parede2 * 0.95, pier);
      c = ct;
      media = mix(vidro, parede2 * uFachW[ti], mT.a);
      if (varanda > 0.5) media = mix(media, parede2 * 0.95, 0.07);
      fz = mix(6.0, 2.4, uJanela);                                              // tile grid fades to its average below ~5 px per bay
    }
    if (y < 4.2) c = mix(parede * 0.55, vec3(0.12, 0.12, 0.13), 0.5);   // ground floor: shopfronts / walls in shade                         // W-VISTA 2: from inside the grid holds down to ~2.4 px per cell (mid-distance blocks)
    float k = clamp(1.25 - max(fw.x, fw.y) * fz, 0.0, 1.0);  // grid fades to its average below ~4 px per cell (no aliasing dots)
    return mix(media, c, k);
  }
  float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float bayer(vec2 p) { vec2 q = mod(floor(p), 4.0); float b = 0.0;
    b = mod(q.x + q.y * 2.0, 4.0); return (b + mod(q.y, 2.0) * 0.5 + 0.25) / 4.5; }
  void main() {
    // B10: under Google's city only our GROUND is drawn (fills ghosted buildings' holes); roofs and anything above the terrain go
    if (uSoChao > 0.5) { float terr = 0.0; vec2 rq0 = (vB.xz + uRuaExt) / (2.0 * uRuaExt);
      if (uRuaOn > 0.5 && rq0.x > 0.0 && rq0.x < 1.0 && rq0.y > 0.0 && rq0.y < 1.0) terr = texture2D(uRua, rq0).b * 60.0 - 20.0;
      if (vB.y > terr + 1.5) discard; }
    if (uFant > 0.5 && vC.x < 9000.0) {
      // maquete: whole buildings (and trees) standing between the camera and the tower, or around the camera, are hidden
      vec2 a = uCam.xz, b = uAlvo.xz, ab = b - a;
      float t = clamp(dot(vC.xy - a, ab) / max(dot(ab, ab), 1e-3), 0.0, 1.0);
      float d = length(vC.xy - (a + ab * t));
      bool entre = t > 0.0 && t < 0.97 && d < vC.z + uRaio * 0.35 && length(vC.xy - b) > 18.0;
      bool naCamera = length(vC.xy - a) < vC.z + 4.0;
      if ((entre || naCamera) && (uTipo != 1.0 || vB.y > 2.5)) discard;
    }
    vec3 dvx = dFdx(vB), dvy = dFdy(vB);            // uniform control flow (see fachada)
    vec3 nDer = normalize(cross(dvx, dvy));
    { vec3 nWv = normalize(cross(dFdx(vW), dFdy(vW))); gFres = pow(1.0 - clamp(abs(dot(nWv, normalize(cameraPosition - vW))), 0.0, 1.0), 5.0); }
    vec2 duvx = dFdx(vUv), duvy = dFdy(vUv);         // uniform control flow (W-VISTA magnification gate)
    vec3 c; float proc = 0.0;                       // proc = 1: procedural facade (not lit by the photo -> lit here)
    if (uTipo > 2.5) { proc = 1.0;                               // far walls: real facade tile repeated every 12 m (UV from world position)
      vec3 nf = nDer;
      vec2 m = vec2(dot(vB.xz, normalize(vec2(-nf.z, nf.x))), vB.y) / 12.0;
      vec2 tuv = vUv + fract(m) * (124.0 / 1024.0);
      vec3 parede = textureLod(map, vUv + vec2(62.0 / 1024.0), 0.0).rgb;   // flat tile = this building's wall colour (E4b: level 0, mips mixed tiles)
      float sd = floor(vUv.x * 64.0) + floor(vUv.y * 64.0) * 7.0;
      // E4b: the far palette is measured on the drone frames at 1-2 km, so it ALREADY holds windows + glass: far away use
      // it as is (the generic window/glass average lifted dark towers to milky grey); the grid only where it resolves
      vec2 fwq = vec2(length(dvx.xz) + length(dvy.xz), abs(dvx.y) + abs(dvy.y)) / vec2(3.1, 2.85);
      float kg = clamp(1.25 - max(fwq.x, fwq.y) * mix(4.0, 2.4, uJanela), 0.0, 1.0);
      c = mix(parede * (0.85 + 0.3 * h11(sd + 5.0)), fachada(parede, vB, nf, sd, dvx, dvy), kg);
    } else {
      vec4 t4 = texture2D(map, vUv);                 // sRGB texture -> linear (colorSpace on the texture)
      c = t4.rgb;
      float a0 = textureLod(map, vUv, 0.0).a;        // full-res alpha: mip levels bleed alpha across atlas rects (black dots)
      if (uTipo < 0.5 && a0 < 0.5) {                 // E4: no good photo for this wall -> procedural facade
        vec2 cB = floor(vC.xy + 0.5);                  // E4c: integer centre from an interpolated varying -> ROUND, never floor (11.9999 vs 12 per pixel)
        c = fachada(textureLod(map, vUv, 0.0).rgb, vB - vec3(cB.x, 0.0, cB.y), nDer, cB.x * 3.0 + cB.y * 17.0, dvx, dvy); proc = 1.0;   // local origin = building centre   // wall colour from full-res too
      } else if (uTipo > 0.5 && uTipo < 1.5 && abs(nDer.y) < 0.45 && vB.y > 3.0) {
        // W-VISTA (07/10): steep sides of the ground/roof surface (LiDAR roof steps of towers) carried the ORTHOPHOTO
        // smeared vertically (grey streaks with green bands on near towers seen from the window) -> facade instead,
        // with the local roof/ground colour lifted to a wall tone
        vec3 pm = textureLod(map, vUv, 5.0).rgb;
        float lp = dot(pm, vec3(0.2126, 0.7152, 0.0722));
        vec3 parede = mix(vec3(lp), pm, 0.35) * clamp(0.32 / max(lp, 1e-3), 0.8, 2.5);
        vec2 sB = floor(vB.xz / 24.0);
        c = fachada(parede, vB, nDer, sB.x * 3.0 + sB.y * 17.0, dvx, dvy); proc = 1.0;
      } else if (uTipo < 0.5) {
        // W-VISTA (07/10): seen from a window 30-80 m away a drone photo wall is magnified 2-4x (<= 6 px/m) and reads as
        // grey smear -> fade to the procedural facade with THAT photo's local colour, only where the photo is magnified
        float tpp = max(length(duvx), length(duvy)) * float(textureSize(map, 0).x);   // texels per screen pixel
        float kz = smoothstep(0.55, 0.25, tpp) * 0.85;
        // the drone photos were taken 100-300 m from these walls at grazing angles: closer than ~120 m (the window
        // views) they read as vertical smear even when the texel density is fine -> same fade by distance
        kz = max(kz, smoothstep(260.0, 180.0, distance(vW, cameraPosition)) * uJanela);   // interior only (drone-view checks unchanged); W-VISTA 2: towers at ~150-250 m still smeared -> 260 m, full fade
        if (kz > 0.001) {
          vec2 cB = floor(vC.xy + 0.5);
          vec3 pm = textureLod(map, vUv, 4.0).rgb;
          c = mix(c, fachada(pm, vB - vec3(cB.x, 0.0, cB.y), nDer, cB.x * 3.0 + cB.y * 17.0, dvx, dvy), kz); proc = kz;
        }
      }
    }
    if (uTipo > 0.5 && uTipo < 1.5 && uDetOn > 0.5) {
      vec2 dq = (vB.xz - (uDetBox.xy - uDetBox.z)) / (2.0 * uDetBox.z);
      float bd = min(min(dq.x, 1.0 - dq.x), min(dq.y, 1.0 - dq.y)) * 2.0 * uDetBox.z;   // metres to the box edge
      if (bd > 0.0) c = mix(c, texture2D(uDet, dq).rgb, smoothstep(0.0, 6.0, bd));
    }
    vec3 lm = vec3(1.0);
    if (uLmOn > 0.5) {
      if (uTipo < 0.5 && uLmPOn > 0.5) { vec3 e = texture2D(uLmP, vLm).rgb; lm = e * e * 2.0; }
      else if (uTipo > 0.5 && uTipo < 1.5) {
        vec2 tq = (vB.xz - (uLmBox.xy - uLmBox.z)) / (2.0 * uLmBox.z);
        if (tq.x > 0.0 && tq.y > 0.0 && tq.x < 1.0 && tq.y < 1.0) { vec3 e = texture2D(uLmT, tq).rgb; lm = e * e * 2.0; }
      }
      float kl = uTipo < 0.5 ? mix(uLmK.x, uLmK.y, proc) : uLmK.z;
      lm = pow(max(lm, vec3(0.02)), vec3(kl));
    }
    if (uDbg > 6.5) { gl_FragColor = vec4(lm * 0.8, 1.0);
      #include <colorspace_fragment>
      return; }
    if (uDbg > 5.5) { gl_FragColor = vec4(uTipo < 0.5 ? vec3(1.0, 0.0, 0.0) : uTipo < 1.5 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0), 1.0) * (0.4 + 0.6 * proc); return; }
    if (uDbg > 4.5 && uDbg < 5.5) { gl_FragColor = vec4(fract(vC.x * 0.137), fract(vC.y * 0.211), fract(vAng / 37.0), 1.0); return; }
    if (uDbg > 3.5 && uDbg < 4.5) { gl_FragColor = vec4(fract(vB / 5.0), 1.0); return; }
    if (uDbg > 2.5) { gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
      return; }
    if (uDbg > 1.5 && uDbg < 2.5) { gl_FragColor = vec4(texture2D(map, vUv).rgb, 1.0);
      #include <colorspace_fragment>
      return; }
    if (uDbg > 0.5 && uDbg < 1.5 && proc > 0.5) c = textureLod(map, vUv, 0.0).rgb;
    vec3 col = c * uGrade;
    {
      vec3 nW = normalize(cross(dFdx(vW), dFdy(vW)));
      if (dot(nW, cameraPosition - vW) < 0.0) nW = -nW;
      float faceSol = smoothstep(0.05, 0.55, dot(nW, uSolW));
      col *= mix(vec3(1.0), vec3(1.0 + uQuente, 1.0 + uQuente * 0.25, 1.0 - uQuente * 0.6), faceSol);
      col *= mix(vec3(1.0), vec3(1.0 - uFrio, 1.0 - uFrio * 0.3, 1.0 + uFrio), 1.0 - faceSol);
      // E4: procedural facades carry no light of their own: sunlit vs shade like the photos (shade ~0.45, slightly cooler)
      col *= mix(vec3(1.0), mix(vec3(0.44, 0.47, 0.53), vec3(1.08), faceSol), proc * uSolK);
      // F40: real-time shadow of the tower / neighbours, same tone as the shadows baked in the photos (~50%, cooler)
      float sombra = 1.0;
      #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
        DirectionalLightShadow dsh = directionalLightShadows[ 0 ];
        sombra = getShadow( directionalShadowMap[ 0 ], dsh.shadowMapSize, 1.0, dsh.shadowBias, dsh.shadowRadius, vDirectionalShadowCoord[ 0 ] );
      #endif
      // E6/F40: the photos are now shadow-free (ground/roofs) -> our shadow carries the real ratio: ~0.40 of sunlit, cooler
      float recebe = max(smoothstep(0.0, 0.12, dot(nW, uSolW)), step(0.6, nW.y));   // any face the sun reaches receives the full shadow
      float sk = uSombraK * recebe * (1.0 - sombra);
      col *= mix(vec3(1.0), vec3(0.085, 0.092, 0.11), sk);  // F40 (07/10): shader factor; on screen (after haze + Neutral tone map) ~0.25-0.30 of sunlit, slightly cool
      // B9: baked sky light. Where the live sun reaches, the sky is only part of the light -> softer (sqrt); in the live
      // shadow, and in phones' 'pre' mode (no shadow map: sombra = 1), the full occlusion gives the depth
      col *= mix(lm, sqrt(lm), clamp(uSombraK * recebe * sombra, 0.0, 1.0) * 0.5);
    }
    if (uNoite > 0.001) {
      vec3 n = normalize(cross(dFdx(vB), dFdy(vB)));
      float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      if ((uTipo < 0.5 || uTipo > 2.5) && abs(n.y) < 0.5 && vB.y > 3.5) {
        vec3 tg = normalize(vec3(-n.z, 0.0, n.x));
        float s = dot(vB, tg);
        vec2 cel = vec2(floor(s / 3.1), floor(vB.y / 2.85));
        vec2 f = vec2(fract(s / 3.1), fract(vB.y / 2.85));
        float janela = smoothstep(0.22, 0.27, f.x) * (1.0 - smoothstep(0.73, 0.78, f.x)) * smoothstep(0.36, 0.41, f.y) * (1.0 - smoothstep(0.80, 0.85, f.y));
        float id = h21(cel + floor(n.xz * 3.0) * 17.0 + floor(vB.xz / 40.0) * 3.1);
        float acesa = step(id, uFrac) * janela;
        float vidro = 1.0 - smoothstep(0.18, 0.5, lum);
        vec3 quente = mix(vec3(1.0, 0.72, 0.42), vec3(0.95, 0.9, 0.82), step(0.82, h21(cel + 7.0)));
        float forca = 0.12 + 0.88 * pow(h21(cel + 3.0), 2.2);           // curtains / lamps: most windows dim, a few bright
        col += uNoite * acesa * mix(0.5, 1.0, vidro) * quente * forca * 0.85;
      }
      // street lights: glow map from the OSM street lines (lamp every 30 m), on the ground and the lower walls
      vec2 rq = (vB.xz + uRuaExt) / (2.0 * uRuaExt);
      if (uRuaOn > 0.5 && rq.x > 0.0 && rq.x < 1.0 && rq.y > 0.0 && rq.y < 1.0 && uTipo < 2.5) {
        vec3 lz = texture2D(uRua, rq).rgb;
        vec3 luz = lz.r * vec3(1.0, 0.56, 0.22) + lz.g * vec3(1.0, 0.82, 0.6);
        float hrua = vB.y - (lz.b * 60.0 - 20.0);                                     // height above the street (B = terrain)
        float fator = n.y > 0.5 ? 1.0 - smoothstep(1.0, 3.0, hrua) : (1.0 - smoothstep(0.0, 9.0, hrua)) * 0.8;
        col += uNoite * luz * (c * 2.2 + 0.035) * fator;
      } else if (uTipo > 0.5 && uTipo < 1.5 && n.y > 0.5) {
        // far ground: sparse warm pools (stable per 30 m cell)
        vec2 g = vB.xz / 30.0; vec2 ci = floor(g); vec2 fr = fract(g) - 0.5;
        float r = length(fr * 30.0 - (vec2(h21(ci), h21(ci + 5.0)) - 0.5) * 10.0);
        col += uNoite * (c * 0.35 + 0.04) * vec3(1.0, 0.66, 0.36) * (0.25 + 1.4 * step(0.35, h21(ci + 11.0)) * exp(-r * r / 40.0));
      }
    }
    float dist = length(vW - cameraPosition);
    // haze: sky colour of that direction - the warm horizon only toward the sun, the cooler sky everywhere else
    vec3 vd = normalize(vec3(vW.x - cameraPosition.x, 0.0, vW.z - cameraPosition.z));
    vec3 sd = normalize(vec3(uSolW.x, 0.0, uSolW.z) + vec3(1e-4, 0.0, 0.0));
    float paraSol = 0.6 * pow(max(dot(vd, sd), 0.0), 8.0);
    col = mix(col, mix(uHaze, uHazeQ, paraSol), 1.0 - exp(-(dist * uHazeD) * (dist * uHazeD)));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;

// ---- E3 trees: one quad per tree, instanced; faces the camera, vertical at street level, tilted with the camera from above
const VERT_ARV = /* glsl */`
  #include <common>
  #include <shadowmap_pars_vertex>
  attribute vec3 iPos; attribute vec4 iDim; attribute vec3 iCor;     // base (B5), (half width, height, variant + 3 x species, seed), crown colour
  attribute vec4 iBase;                                               // B9: base fraction at 10 / 40 deg, tree height / frame side, gain
  uniform mat4 uB5;                                                   // B5 -> world
  varying float vAlt; varying float vGanho;
  varying vec2 vUv; varying vec3 vB; varying vec3 vW; varying vec3 vC; varying vec3 vCor; varying float vT; varying float vVar;
  void main() {
    vec4 base = uB5 * vec4(iPos, 1.0);
    vec3 toCam = normalize(cameraPosition - base.xyz);
    float el = asin(clamp(toCam.y, -1.0, 1.0));
    vT = smoothstep(0.26, 0.61, el);                                 // 15 .. 35 deg: blend the 10 / 40 deg renders
    vec3 right = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
    vec3 upCam = normalize(vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]));
    vec3 up = normalize(mix(vec3(0.0, 1.0, 0.0), upCam, vT));
    float bf = mix(iBase.x, iBase.y, vT);
    vec3 p = base.xyz + right * (uv.x - 0.5) * 2.0 * iDim.x + up * (uv.y - bf) * iDim.y;
    vec4 worldPosition = vec4(p, 1.0);
    vW = p; vB = iPos + vec3(0.0, (uv.y - bf) * iDim.y, 0.0); vC = vec3(iPos.x, iPos.z, iDim.x);
    vUv = uv; vCor = iCor; vVar = iDim.z; vAlt = iDim.y * iBase.z; vGanho = iBase.w;
    vec4 mvPosition = viewMatrix * worldPosition;
    gl_Position = projectionMatrix * mvPosition;
    #include <shadowmap_vertex>
  }`;
const FRAG_ARV = /* glsl */`
  #include <common>
  #include <packing>
  #include <shadowmap_pars_fragment>
  uniform sampler2D map; uniform vec3 uCorMedia; uniform float uSombraK;
  uniform vec3 uGrade; uniform float uNoite; uniform vec3 uHaze; uniform float uHazeD;
  uniform sampler2D uRua; uniform float uRuaOn; uniform float uRuaExt;
  uniform float uFant; uniform vec3 uCam; uniform vec3 uAlvo; uniform float uRaio;
  varying vec2 vUv; varying vec3 vB; varying vec3 vW; varying vec3 vC; varying vec3 vCor; varying float vT; varying float vVar; varying float vAlt; varying float vGanho;
  uniform float uLinhas;   // atlas rows: 2 (B7: one species) or 2 x species (B9)
  vec2 celula(float linha) { float esp = floor(vVar / 3.0 + 0.001); float col = vVar - 3.0 * esp;
    return vec2((col + vUv.x) / 3.0, (esp * 2.0 + linha + (1.0 - vUv.y)) / uLinhas); }
  vec4 amostra(float linha) { return texture2D(map, celula(linha)); }
  vec4 amostraB(float linha) { return texture2D(map, celula(linha), 2.0); }   // blurred: closed crown
  vec4 amostraC(float linha) { return texture2D(map, celula(linha), 4.0); }   // very blurred: crown interior (alpha close)
  uniform vec3 uArvGanho;
  void main() {
    if (uFant > 0.5 && vAlt > 26.0) {   // maquete cut-away only for very tall trees (street trees cover the podium, as in the photos)
      vec2 a = uCam.xz, b = uAlvo.xz, ab = b - a;
      float t = clamp(dot(vC.xy - a, ab) / max(dot(ab, ab), 1e-3), 0.0, 1.0);
      if (t > 0.0 && t < 0.97 && length(vC.xy - (a + ab * t)) < vC.z + uRaio * 0.35 && length(vC.xy - b) > 18.0) discard;
    }
    vec4 t0 = amostra(0.0), t1 = amostra(1.0);
    vec4 tx = mix(t0, t1, vT);
    vec4 tb = mix(amostraB(0.0), amostraB(1.0), vT);
    vec4 tc = mix(amostraC(0.0), amostraC(1.0), vT);
    float cobre = max(max(tx.a, smoothstep(0.18, 0.55, tb.a)), step(0.55, tc.a));   // E3: closed canopy; interior holes closed (alpha close)
    // soft outline: leaf clusters (noise at ~0.4 m) break the edge, dithered falloff instead of a hard sprite cut
    vec2 cl = floor(vUv * vec2(48.0, 48.0)) + vVar * 31.0;
    float folha = fract(sin(dot(cl, vec2(12.9898, 78.233))) * 43758.5453);
    float lim = 0.32 + 0.36 * folha;
    float dith = fract(dot(gl_FragCoord.xy, vec2(0.0671, 0.5833)) * 3.1);
    if (cobre < lim + (dith - 0.5) * 0.18) discard;
    // E3 (07/10 round 2): the Poly Haven impostor's own leaf texture + Blender lighting, one global gain fitted to the real
    // canopy median; the per-tree measured colour only TINTS the hue (luminance-normalised, +-20%). Holes: inner leaves
    // from the blurred crown (atlas RGB is bled under alpha 0), slightly shaded.
    vec3 lb = tx.a > 0.3 ? tx.rgb : mix(tc.rgb, tb.rgb, 0.5) * 0.8;
    vec3 tint = vCor / max(uCorMedia, vec3(1e-4)); tint /= max(dot(tint, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
    vec3 c = lb * clamp(tint, vec3(0.8), vec3(1.25)) * uArvGanho * vGanho;
    float yc = clamp((vUv.y - 0.22) / 0.78, 0.0, 1.0);
    c *= mix(0.72, 1.18, smoothstep(0.1, 0.95, yc));   // top light: sunlit top of the crown, darker underside
    // leaf clumps (~1-2 m): the impostor's mid-scale light/dark, amplified - sunlit clump tops vs shaded gaps, like the photo
    float lM = dot(tb.rgb, vec3(0.2126, 0.7152, 0.0722)), lL = dot(tc.rgb, vec3(0.2126, 0.7152, 0.0722));
    c *= clamp(pow(lM / max(lL, 1e-3), 2.2), 0.45, 1.9);
    vec3 col = c * uGrade;
    float sombra = 1.0;
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
      DirectionalLightShadow dsh = directionalLightShadows[ 0 ];
      sombra = getShadow( directionalShadowMap[ 0 ], dsh.shadowMapSize, 1.0, dsh.shadowBias, dsh.shadowRadius, vDirectionalShadowCoord[ 0 ] );
    #endif
    col *= mix(vec3(1.0), vec3(0.30, 0.33, 0.33), uSombraK * (1.0 - sombra));   // F40: shaded foliage keeps skylight (~0.32), stays green
    vec2 rq = (vB.xz + uRuaExt) / (2.0 * uRuaExt);
    if (uNoite > 0.001 && uRuaOn > 0.5 && rq.x > 0.0 && rq.x < 1.0 && rq.y > 0.0 && rq.y < 1.0) {
      vec3 lz = texture2D(uRua, rq).rgb;
      float hrua = vB.y - (lz.b * 60.0 - 20.0);
      col += uNoite * (lz.r * vec3(1.0, 0.56, 0.22) + lz.g * vec3(1.0, 0.82, 0.6)) * c * 1.6 * (1.0 - smoothstep(1.0, 10.0, hrua));
    }
    float dist = length(vW - cameraPosition);
    col = mix(col, uHaze, 1.0 - exp(-(dist * uHazeD) * (dist * uHazeD)));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;
const VERT_ARV_SOMBRA = VERT_ARV.replace('#include <shadowmap_pars_vertex>', '').replace('#include <shadowmap_vertex>', '');
const FRAG_ARV_SOMBRA = /* glsl */`
  uniform sampler2D map; varying vec2 vUv; varying float vT; varying float vVar; uniform float uLinhas;
  varying vec3 vB; varying vec3 vW; varying vec3 vC; varying vec3 vCor;
  vec2 celula(float linha) { float esp = floor(vVar / 3.0 + 0.001); float col = vVar - 3.0 * esp;
    return vec2((col + vUv.x) / 3.0, (esp * 2.0 + linha + (1.0 - vUv.y)) / uLinhas); }
  void main() {
    vec4 t0 = texture2D(map, celula(0.0));
    vec4 t1 = texture2D(map, celula(1.0));
    if (mix(t0.a, t1.a, vT) < 0.45) discard;
    gl_FragColor = vec4(1.0);
  }`;

// B9 strengths of the baked sky light: photo walls (the drone photos already carry some real occlusion), procedural
// walls (no light of their own), ground/roofs (orthophoto relit: its contact shadows were removed). ?lmk=a,b,c
const LM_K = (() => { const m = /[?&]lmk=([\d.,]+)/.exec(typeof location !== 'undefined' ? location.search : ''); const v = m ? m[1].split(',').map(Number) : [];
  return [0, 1, 2].map((i) => (Number.isFinite(v[i]) ? v[i] : [1.0, 1.0, 1.0][i])); })();
const B9 = (k) => !new RegExp('[?&]' + k + '=0').test(typeof location !== 'undefined' ? location.search : '');
function material(map, tipo) {
  return new THREE.ShaderMaterial({
    lights: true,                                    // F40: gives the shader the scene's shadow maps (no lighting is used)
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
      uSombraK: { value: 0 }, uSolK: { value: 0 }, uJanela: { value: 0 }, uDbg: { value: +((/[?&]dbg=(\d)/.exec(location.search) || [0, 0])[1]) },
      map: { value: map }, uTipo: { value: tipo }, uLocal: { value: new THREE.Matrix4() },
      uSolW: { value: new THREE.Vector3(0, 1, 0) }, uQuente: { value: 0 }, uFrio: { value: 0 },
      uGrade: { value: new THREE.Vector3(1, 1, 1) }, uNoite: { value: 0 }, uFrac: { value: 0.3 },
      uHaze: { value: new THREE.Color(0xd8dde2) }, uHazeQ: { value: new THREE.Color(0xd8dde2) }, uHazeD: { value: 0.0007 },
      uFant: { value: 0 }, uCam: { value: new THREE.Vector3() }, uAlvo: { value: new THREE.Vector3(15, 25, 8) }, uRaio: { value: 22 }, uSoChao: { value: 0 },
      uDet: { value: null }, uDetOn: { value: 0 }, uDetBox: { value: new THREE.Vector3(15, 8, 80) },
      uRua: { value: null }, uRuaOn: { value: 0 }, uRuaExt: { value: 409.6 },
      uLmP: { value: null }, uLmT: { value: null }, uLmOn: { value: 0 }, uLmPOn: { value: 0 }, uLmBox: { value: new THREE.Vector3(0, 0, 1) }, uLmK: { value: new THREE.Vector3(...LM_K) },
      uFach: { value: null }, uFachOn: { value: 0 }, uFachMed: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0.1, 0.1, 0.1, 0.5)) }, uFachW: { value: new Array(6).fill(1) },
    },
    vertexShader: VERT, fragmentShader: FRAG, side: THREE.FrontSide, fog: false, defines: {},
  });
}

// ---- loading: page-wide cache (downloads/decodes once for all apartment visits), timeouts, fallbacks, visible state (E1)
const CACHE = new Map();
function emCache(chave, fn) {
  if (!CACHE.has(chave)) { const p = fn(); CACHE.set(chave, p); p.catch(() => CACHE.delete(chave)); }
  return CACHE.get(chave);
}
function comPrazo(p, ms, oque) {
  let t; return Promise.race([p, new Promise((_, erro) => { t = setTimeout(() => erro(new Error(`tempo esgotado (${ms / 1000} s): ${oque}`)), ms); })]).finally(() => clearTimeout(t));
}
function carregarDados(url, ms = 30000) {
  // small binary side files (B9 lightmap UVs): .bin, else the same bytes as base64 in <name>.json (hosts that drop .bin)
  return emCache('bin:' + url, () => comPrazo((async () => {
    try { const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.arrayBuffer(); }
    catch (e) {
      const r = await fetch(url + '.json'); if (!r.ok) throw new Error(url.split('/').pop() + ': ' + e.message);
      const bin = atob((await r.json()).b64); const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8.buffer;
    }
  })(), ms, url.split('/').pop()));
}
function carregarLinear(url, renderer, ms = 30000) {
  // B9 lightmaps: data, not colour (no sRGB decode), no mipmaps (1 px gutters between the wall rectangles)
  return emCache('lin:' + url, () => comPrazo(new Promise((ok, erro) => new THREE.TextureLoader().load(url, (t) => {
    t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    ok(t);
  }, undefined, () => erro(new Error('falhou: ' + url.split('/').pop())))), ms, url.split('/').pop()));
}
function carregarTextura(url, renderer, ms = 30000) {
  // shared THREE.Texture per URL (each renderer uploads it once; textures are never disposed by an instance)
  return emCache('tex:' + url, () => comPrazo(new Promise((ok, erro) => new THREE.TextureLoader().load(url, (t) => {
    t.flipY = false; t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
    ok(t);
  }, undefined, () => erro(new Error('falhou: ' + url.split('/').pop())))), ms, url.split('/').pop()));
}
// geometry: .glb first; if the host refuses/misses it, the same bytes as base64 in <name>.glb.json (published pages
// may not carry .glb files - E1, 06/10: the artifact had every texture but neither .glb)
function carregarGlb(nome, ms = 30000) {
  return emCache('glb:' + nome, () => comPrazo((async () => {
    let buf = null, via = 'glb';
    try {
      const r = await fetch(BASE + nome); if (!r.ok) throw new Error(`HTTP ${r.status}`);
      buf = await r.arrayBuffer();
      if (new DataView(buf).getUint32(0, true) !== 0x46546C67) throw new Error('nao e glb');
    } catch (e) {
      const r = await fetch(BASE + nome + '.json'); if (!r.ok) throw new Error(`${nome}: ${e.message}; .json HTTP ${r.status}`);
      const bin = atob((await r.json()).b64); const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      buf = u8.buffer; via = 'json';
    }
    const gltf = await new Promise((ok, erro) => new GLTFLoader().parse(buf, '', ok, erro));
    gltf.scene.updateMatrixWorld(true);
    return { cena: gltf.scene, via, bytes: buf.byteLength };
  })(), ms, nome));
}
// visible state for tests and ?revisao=1: window.__b7estado = { interior|externo: { estado, detalhe, s } }
const ESTADO = (window.__b7estado = window.__b7estado || {});
function marcar(modo, estado, detalhe = '') {
  const e = ESTADO[modo] || (ESTADO[modo] = { t0: performance.now() });
  e.estado = estado; e.detalhe = detalhe; e.s = +((performance.now() - e.t0) / 1000).toFixed(1);
  if (estado !== 'carregando') console[estado === 'ok' ? 'info' : 'warn'](`[B7 entorno ${modo}] ${estado} ${detalhe} (${e.s} s)`);
  try {
    if (!/[?&]revisao=1/.test(location.search)) return;
    let el = document.getElementById('b7-estado');
    if (!el) { el = document.createElement('div'); el.id = 'b7-estado'; el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;font:12px/1.35 monospace;background:rgba(0,0,0,.78);color:#fff;padding:6px 9px;border-radius:6px;pointer-events:none;max-width:70vw'; document.body.append(el); }
    el.innerHTML = Object.entries(ESTADO).map(([m, v]) => `entorno ${m}: <b style="color:${v.estado === 'ok' ? '#7fe08a' : v.estado === 'falhou' ? '#ff8a80' : '#ffd36b'}">${v.estado}</b> ${v.detalhe} · ${v.s} s`).join('<br>');
  } catch (e) { /* no DOM */ }
}

// fraction of lit windows by hour (evening high, small hours low)
function fracJanelas(min) {
  const h = ((min / 60) + 24) % 24;
  const pts = [[0, 0.22], [3, 0.1], [5.5, 0.12], [7, 0.18], [12, 0.15], [18, 0.26], [20.5, 0.32], [23, 0.24], [24, 0.22]];
  for (let i = 1; i < pts.length; i++) if (h <= pts[i][0]) { const [h0, v0] = pts[i - 1], [h1, v1] = pts[i]; return v0 + (v1 - v0) * (h - h0) / (h1 - h0); }
  return 0.22;
}

export function criarEntorno({ cena, renderer, modo = 'interior', T = null, hPiso = 0, alvo = null, qualidade = 'auto', aoCarregar = null } = {}) {
  if (!b7Ativo(modo === 'externo' ? 'entornoFora' : 'entorno')) {   // F (B1): separate switch for the outside view. switched off (src/entorno-config.js): no-op, the caller keeps its old surroundings
    const nada = () => {};
    return { grupo: null, nota: '', atribuicao: '', ativo: false, pronto: Promise.resolve(null), atualizarHora: nada, atualizarSol: nada, atualizarCamera: nada, dispose: nada, stats: {} };
  }
  const grupo = new THREE.Group(); grupo.name = 'entorno-b7'; grupo.visible = false;
  if (modo === 'interior' && T) {
    // B5 plan (x, y, z) -> apartment frame (u, y - hPiso, v): same affine map as interior-sol.predioParaPlanta
    const { a, b, c, d } = T.M; const ox = T.caixa.x + T.t[0], oz = T.caixa.z + T.t[1];
    grupo.matrixAutoUpdate = false;
    grupo.matrix.set(a, 0, c, -(a * ox + c * oz), 0, 1, 0, -hPiso, b, 0, d, -(b * ox + d * oz), 0, 0, 0, 1);
    grupo.matrixWorldNeedsUpdate = true;
  }
  cena.add(grupo);
  window.__entornoEspera = true; window.__entornoPronto = false; // test hooks (prints/fps)
  // 07/10 Victor: target is a high-end phone -> 4096 whenever the GPU supports it (the 2048 retry below stays as fallback)
  const grande = qualidade === 'alta' || (qualidade === 'auto' && renderer.capabilities.maxTextureSize >= 4096);
  const s = grande ? 4096 : 2048;
  const mats = [];
  const estado = { el: 30, t: 720, az: 0, est: 'primavera', pronto: false };
  const api = { arvores: () => arvoresMalha, grupo, nota: NOTA_ENTORNO, atribuicao: ATRIBUICAO_ENTORNO, resolucao: s, atualizarHora, atualizarSol, atualizarCamera, dispose, stats: {} };
  api.estado = 'carregando';
  marcar(modo, 'carregando', `textura ${s}`);
  async function tentar(res, ms) {
    return Promise.all([carregarGlb('entorno.glb', ms), carregarTextura(`${BASE}paredes-${res}.webp`, renderer, ms), carregarTextura(`${BASE_TOPO}topo-${res}.webp`, renderer, ms)]);
  }
  // B9 is for the OUTSIDE view (the window views keep their W-VISTA calibration); ?b9int=1 tries it inside too
  const b9 = (k) => B9(k) && (modo === 'externo' || /[?&]b9int=1/.test(location.search));
  // B9: baked sky light (lm-*.webp + wall UVs), in parallel with the near layer; failure = the old look
  const lmProm = b9('lm') ? Promise.all([
    emCache('json:lm', () => fetch(BASE + 'lm-b9.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })),
    carregarLinear(`${BASE}lm-paredes-2048.webp`, renderer), carregarLinear(`${BASE}lm-topo-${s >= 4096 ? 2048 : 1024}.webp`, renderer), carregarDados(BASE + 'lm-paredes-uv.bin'),
  ]).catch((e) => { console.warn('[B9] luz assada nao carregou:', e.message); return null; }) : Promise.resolve(null);
  api.pronto = (async () => {
    let r, res = s;
    try { r = await tentar(s, 30000); }
    catch (e1) {
      console.warn('[B7 entorno] 1a tentativa falhou:', e1.message, '- nova tentativa com texturas 2048');
      res = 2048; marcar(modo, 'carregando', `2a tentativa (2048): ${e1.message}`);
      try { r = await tentar(2048, 45000); }
      catch (e2) { api.estado = 'falhou'; marcar(modo, 'falhou', e2.message); window.__entornoPronto = true; fimLonge?.(null); throw e2; }
    }
    const [geo, texP, texT] = r;
    api.resolucao = res;
    const gltf = { scene: geo.cena.clone(true) };      // shares the geometry with other instances (no re-download)
    let tris = 0;
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const tipo = o.name.startsWith('topo') ? 1 : o.name.startsWith('arvores') ? 2 : 0;
      if (tipo === 2) { o.visible = false; return; }   // E3: LiDAR cones replaced by impostor trees (kept in the B6 GLB)
      const m = material(tipo === 1 ? texT : texP, tipo); m.uniforms.uJanela.value = modo === 'interior' ? 1 : 0;
      if (o.geometry.attributes._centro) m.defines.COM_CENTRO = '';
      m.uniforms.uLocal.value.copy(o.matrixWorld);   // node scale of the quantised positions (scene root = identity)
      o.material = m; mats.push(m);
      o.frustumCulled = false; o.raycast = () => {};
      o.matrixAutoUpdate = false;
      o.receiveShadow = true;
      o.castShadow = modo === 'externo' && tipo !== 1;   // walls + trees cast (outside view); ground/roofs only receive
      tris += o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3;
    });
    grupo.add(gltf.scene);
    let lmOk = false;
    try {
      const lm = await comPrazo(lmProm, 12000, 'luz assada');
      if (lm) {
        const [info, tP, tT, uvBuf] = lm;
        const uv = new Uint16Array(uvBuf);
        gltf.scene.traverse((o) => {
          if (!o.isMesh || !o.material.uniforms) return;
          const tipo = o.material.uniforms.uTipo.value;
          if (tipo === 0 && !o.geometry.attributes.lmuv && uv.length === o.geometry.attributes.position.count * 2) o.geometry.setAttribute('lmuv', new THREE.BufferAttribute(uv, 2, true));
          if (tipo === 0 && !o.geometry.attributes.lmuv) return;
          Object.assign(o.material.uniforms.uLmBox.value, { x: info.topo_box[0], y: info.topo_box[1], z: info.topo_box[2] });
        });
        for (const m of mats) { m.uniforms.uLmP.value = tP; m.uniforms.uLmT.value = tT; m.uniforms.uLmOn.value = 1; m.uniforms.uLmPOn.value = 1; m.uniforms.uLmBox.value.set(...info.topo_box); }
        lmOk = info.versao || true;
      }
    } catch (e) { console.warn('[B9] luz assada ignorada:', e.message); }
    if (modo === 'externo') {
      // plinth: the LiDAR street is ~3.2 m below B5's y = 0 (base of the model); fill the gap under the tower
      const g = new THREE.BoxGeometry(31.3, 4.5, 20.4); g.translate(15.05, -2.25, 6.05);
      const pl = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x8e8b85, roughness: 0.95 }));
      pl.name = 'entorno-base-torre'; pl.raycast = () => {}; grupo.add(pl);
    }
    carregarArvores();
    carregarLonge();
    api.stats = { triangulos: tris, textura: res, via: geo.via, luzAssada: lmOk };
    aplicar();
    grupo.visible = true; estado.pronto = true;
    api.estado = 'ok'; marcar(modo, 'ok', `perto: ${geo.via}, textura ${res}`);
    window.__b7info = { ...api.stats, modo };
    aoCarregar?.(api);
    return api;
  })();
  api.pronto.catch((e) => { console.warn('entorno B7 nao carregou:', e); });

  async function carregarArvores() {
    if (/[?&]semArvores=1/.test(location.search)) return;   // test switch (tree-pixel mask by difference)
    try {
      const [dados, arv9] = await Promise.all([
        emCache('json:arvores', () => fetch(BASE + 'arvores.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })),
        b9('arv9') ? Promise.all([emCache('json:arv9', () => fetch(BASE + 'arvores-b9.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })), carregarTextura(BASE + 'arvores-b9.webp', renderer)])
          .catch((e) => { console.warn('[B9] arvores novas nao carregaram (fica o impostor B7):', e.message); return null; }) : null,
      ]);
      const I = dados.impostor, L = dados.arvores, n = L.length;
      // B9: species per tree = the interior render's rule (stable hash of the index: Jacaranda ~50%, the rest split
      // between the other Poly Haven species); each species has its own frame, base and gain (fitted to the Jacaranda's)
      const ESP = arv9 ? arv9[0].especies : [{ altura_modelo: I.altura_modelo, raio_modelo: I.raio_modelo, lado: I.lado, base_frac: I.base_frac, ganho_rel: 1, cor_rel: [1, 1, 1] }];
      const tex = arv9 ? arv9[1] : await carregarTextura(BASE + 'arvores.webp', renderer);   // B7 atlas only when the B9 one is missing
      const especie = (i) => { if (ESP.length === 1) return 0; const u = ((i * 2654435761) % 4294967296) / 4294967296; return u < 0.5 ? 0 : 1 + Math.floor((u - 0.5) / 0.5 * (ESP.length - 1)) % (ESP.length - 1); };
      const q = new THREE.PlaneGeometry(1, 1); q.translate(0.5, 0.5, 0);
      const g = new THREE.InstancedBufferGeometry(); g.index = q.index; g.setAttribute('position', q.attributes.position); g.setAttribute('uv', q.attributes.uv);
      const pos = new Float32Array(n * 3), dim = new Float32Array(n * 4), cor = new Float32Array(n * 3), bas = new Float32Array(n * 4);
      L.forEach(([x, y, z, h, r, cr, cg, cb, v], i) => {
        const k = especie(i), E = ESP[k];
        const esc = h / E.altura_modelo;                       // impostor frame side in metres for this tree
        const largura = THREE.MathUtils.clamp(r / E.raio_modelo, esc * 0.7, esc * 1.4) * E.lado;   // E3: crown width follows the measured radius, never narrower than the impostor's own proportions (round crowns)
        pos.set([x, y, z], i * 3); dim.set([largura / 2, esc * E.lado, v + 3 * k, i], i * 4);
        cor.set([cr * E.cor_rel[0], cg * E.cor_rel[1], cb * E.cor_rel[2]], i * 3);   // tint relative to THIS species' own mean colour
        bas.set([E.base_frac[0], E.base_frac[1], E.altura_modelo / E.lado, E.ganho_rel], i * 4);
      });
      g.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 3)); g.setAttribute('iDim', new THREE.InstancedBufferAttribute(dim, 4));
      g.setAttribute('iCor', new THREE.InstancedBufferAttribute(cor, 3)); g.setAttribute('iBase', new THREE.InstancedBufferAttribute(bas, 4)); g.instanceCount = n;
      api.stats.especiesArvore = ESP.length;
      const base = material(tex, 2);                          // same grade / haze / light uniforms as the city
      const u = Object.assign(base.uniforms, { uArvGanho: { value: new THREE.Vector3(...(I.ganho_global || [0.2, 0.2, 0.2])) }, uCorMedia: { value: new THREE.Vector3(...I.cor_media) },
        uLinhas: { value: 2 * ESP.length }, uB5: { value: grupo.matrixWorld } });
      const m = new THREE.ShaderMaterial({ lights: true, uniforms: u, vertexShader: VERT_ARV, fragmentShader: FRAG_ARV, side: THREE.DoubleSide, fog: false });
      const malha = new THREE.Mesh(g, m); malha.name = 'entorno-arvores'; malha.frustumCulled = false; malha.raycast = () => {};
      malha.matrixAutoUpdate = false; malha.matrix.identity(); malha.matrixWorldNeedsUpdate = true;   // positions come in world space (uB5)
      malha.receiveShadow = true; malha.castShadow = modo === 'externo';
      malha.customDepthMaterial = new THREE.ShaderMaterial({ uniforms: u, vertexShader: VERT_ARV_SOMBRA, fragmentShader: FRAG_ARV_SOMBRA, side: THREE.DoubleSide });
      cena.add(malha); arvoresMalha = malha;                   // in the scene root: the shader applies the group matrix itself
      mats.push(m); aplicar();
      api.stats.arvores = n;
    } catch (e) { console.warn('entorno B7: arvores nao carregaram', e); }
  }
  let arvoresMalha = null;
  var fimLonge; api.prontoLonge = new Promise((ok) => { fimLonge = ok; });
  async function carregarLonge() {
    // far city (390 m - 2 km): lazy, after the near layer is on screen
    try {
      const [gl, tf, tt] = await Promise.all([
        carregarGlb('entorno-longe.glb', 45000),
        carregarTextura(BASE + 'longe-fachadas.webp', renderer),
        carregarTextura(BASE + (s >= 4096 ? 'longe-topo.webp' : 'longe-topo-1024.webp'), renderer),
      ]);
      const g = { scene: gl.cena.clone(true) }; g.scene.updateMatrixWorld(true);
      g.scene.traverse((o) => {
        if (!o.isMesh) return;
        const tipo = o.name.startsWith('longe-topo') ? 1 : 3;
        const m = material(tipo === 1 ? tt : tf, tipo); m.uniforms.uJanela.value = modo === 'interior' ? 1 : 0;
        m.uniforms.uLocal.value.copy(o.matrixWorld);
        const m0 = mats[0]?.uniforms;   // B9: same baked ground map / facade tiles as the near layer
        if (m0) for (const k of ['uLmT', 'uLmOn', 'uFach', 'uFachOn', 'uFachW']) m.uniforms[k].value = m0[k].value;
        if (m0) { m.uniforms.uLmBox.value.copy(m0.uLmBox.value); m.uniforms.uFachMed.value = m0.uFachMed.value; }
        o.material = m; mats.push(m); o.frustumCulled = false; o.raycast = () => {}; o.matrixAutoUpdate = false;
        api.stats.triangulos += o.geometry.index.count / 3;
      });
      grupo.add(g.scene); api.stats.longe = true; marcar(modo, 'ok', `perto: ${api.stats.via}, textura ${api.resolucao} · longe: ${gl.via}`);
      if (!/[?&]anel=0/.test(location.search)) try {   // E4b: skyline ring 2-5 km (LiDAR boxes + 10 km orthophoto)
        const [ga, ta] = await Promise.all([carregarGlb('entorno-anel.glb', 45000), carregarTextura(BASE + 'anel-topo.webp', renderer)]);
        const ca = ga.cena.clone(true); ca.updateMatrixWorld(true);
        ca.traverse((o) => {
          if (!o.isMesh) return;
          const tipo = o.name.startsWith('anel-topo') ? 1 : 3;
          const m = material(tipo === 1 ? ta : tf, tipo); m.defines.ANEL = '';
          m.uniforms.uLocal.value.copy(o.matrixWorld);
          o.material = m; mats.push(m); o.frustumCulled = false; o.raycast = () => {}; o.matrixAutoUpdate = false;
          api.stats.triangulos += o.geometry.index.count / 3;
        });
        grupo.add(ca); api.stats.anel = ga.via;
      } catch (e) { console.warn('entorno B7: anel 2-5 km nao carregou', e); }
      await carregarNoiteEDetalhe();
      aplicar(); aoCarregar?.(api);
    } catch (e) { console.warn('entorno B7: camada distante nao carregou', e); marcar(modo, 'ok', `perto ok; longe falhou: ${e.message}`); }
    window.__entornoPronto = true; window.__b7info = { ...api.stats, modo }; fimLonge(api);
  }
  const extras = [];
  async function carregarFachadas() {
    if (!b9('fach9')) return;
    try {
      const [tex, med] = await Promise.all([carregarTextura(BASE + 'fachadas-b9.webp', renderer),
        emCache('json:fach9', () => fetch(BASE + 'fachadas-b9.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }))]);
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      const M = med.estilos.map((e) => new THREE.Vector4(...e.vidro_lin, e.mascara)), W = med.estilos.map((e) => e.parede_sombra);
      for (const m of mats) { m.uniforms.uFach.value = tex; m.uniforms.uFachOn.value = 1; m.uniforms.uFachMed.value = M; m.uniforms.uFachW.value = W; }
      api.stats.fachadasB9 = true;
    } catch (e) { console.warn('[B9] fachadas nao carregaram:', e.message); }
  }
  async function carregarNoiteEDetalhe() {
    await carregarFachadas();
    // detail ground near the tower, street-light glow map, lamp heads, horizon glow (all small; failures are harmless)
    try {
      const [det, rua, postes] = await Promise.all([
        carregarTextura(`${BASE_TOPO}detalhe-${s >= 4096 ? 2048 : 1024}.webp`, renderer),
        carregarTextura(BASE + 'luzes-rua.webp', renderer).then((t) => { t.colorSpace = THREE.NoColorSpace; return t; }),
        emCache('json:luzes-postes', () => fetch(BASE + 'luzes-postes.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })),
      ]);
      const semDet = /[?&]detalhe=0/.test(location.search);   // test switch for before/after prints
      for (const m of mats) { m.uniforms.uDet.value = det; m.uniforms.uDetOn.value = semDet ? 0 : 1; m.uniforms.uRua.value = rua; m.uniforms.uRuaOn.value = 1; }
      // lamp heads: small additive glows 7.5 m above the street
      const pos = new Float32Array(postes.postes.length * 3), cor = new Float32Array(postes.postes.length * 3);
      postes.postes.forEach(([x, y, z, sod], i) => { pos.set([x, y, z], i * 3); cor.set(sod ? [1.0, 0.62, 0.3] : [1.0, 0.9, 0.75], i * 3); });
      const gp = new THREE.BufferGeometry(); gp.setAttribute('position', new THREE.BufferAttribute(pos, 3)); gp.setAttribute('color', new THREE.BufferAttribute(cor, 3));
      const cv = document.createElement('canvas'); cv.width = cv.height = 64; const g2 = cv.getContext('2d');
      const gr = g2.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.18, 'rgba(255,255,255,0.85)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.18)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g2.fillStyle = gr; g2.fillRect(0, 0, 64, 64);
      const pm = new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: true, map: new THREE.CanvasTexture(cv), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0 });
      const pts = new THREE.Points(gp, pm); pts.frustumCulled = false; pts.raycast = () => {}; pts.name = 'entorno-postes';
      grupo.add(pts); extras.push({ tipo: 'postes', mat: pm });
      // warm city glow near the horizon (night sky), a band at 1.9 km
      const anel = new THREE.Mesh(new THREE.CylinderGeometry(1900, 1900, 420, 64, 1, true), new THREE.ShaderMaterial({
        uniforms: { k: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide, fog: false, toneMapped: false,
        vertexShader: 'varying float vY; void main(){ vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform float k; varying float vY; void main(){ float a = pow(1.0 - vY, 2.2) * k; gl_FragColor = vec4(vec3(1.0, 0.55, 0.26) * a * 0.32, 1.0); }' }));
      anel.position.set(15, 160, 8); anel.frustumCulled = false; anel.raycast = () => {}; anel.renderOrder = -0.5; anel.name = 'entorno-brilho-horizonte';
      grupo.add(anel); extras.push({ tipo: 'anel', mat: anel.material });
      api.stats.postes = postes.postes.length;
    } catch (e) { console.warn('entorno B7: luzes/detalhe nao carregaram', e); }
  }
  const solB5 = new THREE.Vector3(0, 1, 0), solW = new THREE.Vector3(0, 1, 0), m3 = new THREE.Matrix3();
  function aplicar() {
    const el = estado.el;
    const G = gradeEntorno(el);
    // W-VISTA (07/10): from inside, the city behind the glass read DARKER than the room's walls; in the 2026 clips the
    // view is brighter than the room (camera exposed for the interior). Interior mode lifts the city's exposure in daylight.
    if (modo === 'interior') { const g = 1 + (JANELA_EXPO - 1) * fatorDia(el); G.base = G.base.map((v) => v * g); G.k *= g; }
    // sun direction in the B5 frame (+x bearing = eixo), then to world (interior: the group's rotation)
    const eixo = (SOL.meta.orientacao && SOL.meta.orientacao.eixo_x_predio_bearing_graus) || 73.4, r = Math.PI / 180;
    const h = Math.cos(Math.max(el, 0) * r);
    solB5.set(h * Math.cos((estado.az - eixo) * r), Math.sin(Math.max(el, 0) * r), h * Math.sin((estado.az - eixo) * r)).normalize();
    grupo.updateMatrixWorld(); solW.copy(solB5).applyMatrix3(m3.setFromMatrix4(grupo.matrixWorld)).normalize();
    const ceu = corCeu(el);
    // haze = sky light scattered toward the eye: same exposure as the city (G.k), mostly neutral; warm only toward the sun
    const cinza = (c, f) => { const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; return c.lerp(new THREE.Color(l, l, l), f); };
    const hazeQ = cinza(new THREE.Color(ceu.horizonte).convertSRGBToLinear(), 0.72).multiplyScalar(0.92 * Math.max(G.k, 0.08));
    const haze = cinza(new THREE.Color(ceu.topo).lerp(new THREE.Color(ceu.horizonte), 0.25).convertSRGBToLinear(), 0.7)
      .lerp(new THREE.Color(0.80, 0.82, 0.85), 0.5 * smooth(-2, 15, el)).multiplyScalar(0.92 * Math.max(G.k, 0.08));
    for (const m of mats) {
      m.uniforms.uGrade.value.set(...G.base);
      m.uniforms.uQuente.value = G.quente; m.uniforms.uFrio.value = G.frio; m.uniforms.uSolW.value.copy(solW);
      m.uniforms.uNoite.value = G.luzes;
      m.uniforms.uSombraK.value = /[?&]semsombra=1/.test(location.search) ? 0 : smooth(0.0, 6.0, el);   // F40: full whenever there is direct sun
      if (m.uniforms.uSolK) m.uniforms.uSolK.value = smooth(0.0, 6.0, el);   // test switch for before/after
      m.uniforms.uFrac.value = fracJanelas(estado.t);
      m.uniforms.uHaze.value.copy(haze); m.uniforms.uHazeQ.value.copy(hazeQ);
      m.uniforms.uHazeD.value = 0.00015 + 0.00005 * G.noite;   // E4b (07/10): haze = 1-exp(-(d*D)^2), fitted on the far band of drone frame 0203_0600: ~0.5% at 500 m, ~5% at 1.5 km, ~30% at 4 km (real dark towers at 1-2 km keep L*~6). Was linear 0.0004 (18% at 500 m, 55% at 2 km: milky skyline)
    }
    for (const x of extras) {
      if (x.tipo === 'postes') x.mat.opacity = G.luzes;
      else x.mat.uniforms.k.value = G.luzes;
    }
  }
  function atualizarSol({ el, t, az, est }) {
    if (el != null) estado.el = el; if (t != null) estado.t = t; if (est) estado.est = est;
    if (az != null) estado.az = az;
    else if (t != null) {   // callers that only pass el/t: azimuth from the same NOAA curve and the last known season
      const e = SOL.estacoes[estado.est] || SOL.estacoes.primavera;
      estado.az = posicaoSolar(e.data, t, SOL.meta.local?.lat, SOL.meta.local?.lon).az;
    }
    if (estado.pronto) aplicar();
  }
  function atualizarHora(min, est) {
    const e = SOL.estacoes[est] || SOL.estacoes.inverno;
    const ps = posicaoSolar(e.data, min, SOL.meta.local?.lat, SOL.meta.local?.lon);
    atualizarSol({ el: ps.el, t: min, az: ps.az, est });
  }
  const tmp = new THREE.Vector3();
  function atualizarCamera(camera) {
    if (modo !== 'externo' || !estado.pronto) return;
    camera.getWorldPosition(tmp);
    for (const m of mats) { m.uniforms.uFant.value = m.uniforms.uTipo.value === 3 ? 0 : 1; m.uniforms.uCam.value.copy(tmp); if (alvo) m.uniforms.uAlvo.value.copy(alvo); }
  }
  function dispose() {
    // shared (cached) geometry and textures stay alive for the next apartment visit; only this instance's own objects go
    cena.remove(grupo);
    if (arvoresMalha) { cena.remove(arvoresMalha); arvoresMalha.geometry.dispose(); arvoresMalha.material.dispose(); arvoresMalha.customDepthMaterial.dispose(); }
    grupo.traverse((o) => { if ((o.isMesh || o.isPoints) && /^entorno-/.test(o.name)) { o.geometry.dispose(); o.material.dispose?.(); } });
    for (const m of mats) m.dispose();
  }
  return api;
}
