// Sun (and night lights) simulated OVER THE REAL PHOTO of apartment 31 (front B4, F13 + F14). No generative AI:
// the photo pixels are only re-weighted by light computed on a measured model of the room.
//
// How: the photo's camera was calibrated against the room (docs/b4-scripts/calibra_fotos.py: joint least squares on
// the door frame + 5 balcony edges, reprojection RMS < 1 px; cross-check cv2.solvePnP). A simple model of the room
// (walls, door frame, balcony beam/curb/rail, sofa, pouf, bed, curtains) is rendered FROM THAT CAMERA:
//   pass 1: direct-sun mask (N.L x shadow map) + "inside the room" flag
//   pass 2: irradiance of each lamp group (night)
// then composited over the photo in linear space: sunlit areas brighter and warmer, the rest follows the sky light;
// at night the photo is darkened and the lamps are added (reflectance estimated from the photo itself).
//
// TRUTH RULE: AP31 = FINAL 1 (balcony to the street, 253.4 deg). The simulation is applied only to units of final 1.
// For other finals podeSimular() is false and the page shows the photo without simulation (the sun is in the 3D).
//
// API: await abrirFotoSol({ foto, id, estacao, minutos, container, luzes }) -> { definirHora, definirEstacao,
//      definirLuz, fechar, estado }   ·  podeSimular(id)  ·  FOTOS_CALIBRADAS
import * as THREE from 'three';
import { SOL } from './dados-sol.js';
import { UNIDADES } from './dados.js';
import { CALIB } from './interior-fotos-calib.js';
import { solNoInstante } from './interior-sol.js';
import { GLSL_LUZES, uniformsLuzes } from './interior-luzes.js';

export const FOTOS_CALIBRADAS = Object.keys(CALIB.fotos);
const FINAL_DA_FOTO = 1;
const ROTULO_DIA = 'Simulação de sol sobre foto real de um studio do prédio (2021)';
const ROTULO_NOITE = 'Iluminação simulada sobre foto real de um studio do prédio (2021)';

const acharUnidade = (id) => UNIDADES.find((u) => u.id === String(id) || u.numero === String(id)) || null;
export function podeSimular(id) { const u = acharUnidade(id); return !!u && u.final === FINAL_DA_FOTO; }

export async function abrirFotoSol({ foto = '09-quarto', id = '31', estacao = 'inverno', minutos = 900, container, luzes = { teto: true }, teste = false }) {
  const F = CALIB.fotos[foto];
  if (!F) throw new Error(`foto ${foto} sem calibracao`);
  const un = acharUnidade(id);
  const simula = !!un && un.final === FINAL_DA_FOTO;
  const st = { est: SOL.estacoes[estacao] ? estacao : 'inverno', t: minutos, luzes: { teto: !!luzes.teto } };

  const raiz = document.createElement('div');
  raiz.className = 'ifo-raiz';
  raiz.style.cssText = 'position:relative;width:100%;aspect-ratio:3/2;background:#111;overflow:hidden;border-radius:10px';
  raiz.innerHTML = `<canvas style="position:absolute;inset:0;width:100%;height:100%;display:block"></canvas>
    <div class="ifo-rot" style="position:absolute;left:10px;top:10px;padding:4px 9px;border-radius:7px;background:rgba(14,18,24,.72);color:#fff;font:600 12.5px/1.3 var(--f-body,system-ui,sans-serif)"></div>
    <div class="ifo-est" style="position:absolute;left:10px;bottom:10px;padding:4px 9px;border-radius:7px;background:rgba(14,18,24,.72);color:#fff;font:12px/1.3 var(--f-body,system-ui,sans-serif)"></div>`;
  container.append(raiz);
  const canvas = raiz.querySelector('canvas');
  const rot = raiz.querySelector('.ifo-rot'), est = raiz.querySelector('.ifo-est');

  const fotoTex = await new THREE.TextureLoader().loadAsync(F.arquivo_site);
  fotoTex.colorSpace = THREE.SRGBColorSpace;
  const Wpx = fotoTex.image.width, Hpx = fotoTex.image.height;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: !!teste });
  renderer.setPixelRatio(1);
  renderer.setSize(Wpx, Hpx, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  // ---------------------------------------------------------------- model of the room in the photo frame
  const M = F.medido_na_foto, mv = F.moveis;
  const HG = M.altura_caixilho_m, W = M.largura_caixilho_m, HT = M.teto_sala_m_lido_na_linha_y65, DIN = M.face_interna_viga_m, DOUT = 1.50; // B5: street balcony 1.50 m
  const HB = M.fundo_viga_m, HCB = M.teto_varanda_m, HC = M.altura_mureta_m;
  const XL = mv.parede_esq_x, XR = XL + 5.40; // room width 5.40 (final 6 drawing; final 1 ESTIMATIVA)
  const BX0 = -0.53, BX1 = W + 0.53;          // balcony side walls (left one read on the photo, right by symmetry: ESTIMATIVA)
  const geos = { dentro: [], fora: [] };
  const box = (k, x0, x1, y0, y1, z0, z1) => { const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0); g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2); geos[k].push(g.toNonIndexed()); };
  // room
  box('dentro', XL - 0.2, XR + 0.2, -0.2, 0, 0, 7);              // floor
  box('dentro', XL - 0.2, XR + 0.2, HT, HT + 0.2, -0.2, 7);       // ceiling
  box('dentro', XL - 0.2, XL, -0.2, HT + 0.2, -0.2, 7);           // side walls
  box('dentro', XR, XR + 0.2, -0.2, HT + 0.2, -0.2, 7);
  box('dentro', XL - 0.2, 0, -0.2, HT + 0.2, -0.18, 0);           // window wall piers + header
  box('dentro', W, XR + 0.2, -0.2, HT + 0.2, -0.18, 0);
  box('dentro', 0, W, HG, HT + 0.2, -0.18, 0);
  // door frame bars (black, cast shadow): outer frame 5 cm, two central mullions, transom of the right fixed panel
  const xm = (u) => F.camera.pos[0] + (u - 600) * F.camera.pos[2] / F.camera.f_px_1200; // image x (1200 px) -> X on z=0
  box('dentro', 0, W, 0, 0.03, -0.06, 0); box('dentro', 0, W, HG - 0.06, HG, -0.06, 0);
  box('dentro', 0, 0.06, 0, HG, -0.06, 0); box('dentro', W - 0.06, W, 0, HG, -0.06, 0);
  box('dentro', xm(700), xm(712), 0, HG, -0.06, 0); box('dentro', xm(742), xm(754), 0, HG, -0.06, 0);
  box('dentro', xm(742), W, 0.90, 0.95, -0.06, 0);
  // furniture measured on the photo
  for (const k of ['pouf', 'sofa_assento', 'sofa_encosto', 'cama', 'cortina_esq', 'cortina_dir']) { const b = mv[k]; box('dentro', b.x[0], b.x[1], b.y[0], b.y[1], b.z[0], b.z[1]); }
  // balcony (outside)
  box('fora', BX0 - 0.2, BX1 + 0.2, -0.2, 0, -DOUT, -0.17);       // floor
  box('fora', BX0 - 0.2, BX1 + 0.2, HCB, HCB + 0.2, -DOUT, -0.17); // ceiling
  box('fora', BX0 - 0.2, BX1 + 0.2, HB, HCB + 0.01, -DOUT, -DIN);  // edge beam
  box('fora', BX0 - 0.2, BX1 + 0.2, 0, HC, -DOUT, -DIN);           // curb
  box('fora', BX0 - 0.2, BX0, -0.2, HCB + 0.2, -DOUT, -0.17);     // side walls
  box('fora', BX1, BX1 + 0.2, -0.2, HCB + 0.2, -DOUT, -0.17);
  const zr = -(DIN + DOUT) / 2;                                     // guard rail: top + bottom bars + posts (glass: no shadow)
  box('fora', BX0, BX1, 1.15, 1.20, zr - 0.03, zr + 0.03);
  box('fora', BX0, BX1, 0.27, 0.30, zr - 0.02, zr + 0.02);
  const xz = (u, z) => F.camera.pos[0] + (u - 600) * (F.camera.pos[2] - z) / F.camera.f_px_1200; // image x -> X on plane z
  for (const u of [405, 530, 660]) { const X = xz(u, zr); box('fora', X - 0.02, X + 0.02, HC, 1.15, zr - 0.02, zr + 0.02); }

  const mk = (k, emiss) => {
    const mat = new THREE.MeshLambertMaterial({ color: 0xff0000, emissive: new THREE.Color(0, emiss, 0) });
    const g = mergeSimples(geos[k]);
    const m = new THREE.Mesh(g, mat); m.castShadow = m.receiveShadow = true;
    return m;
  };
  const cenaSol = new THREE.Scene(), cenaLuz = new THREE.Scene();
  const mDentro = mk('dentro', 1), mFora = mk('fora', 0);
  cenaSol.add(mDentro, mFora);
  const lDentro = new THREE.Mesh(mDentro.geometry, mDentro.material.clone()), lFora = new THREE.Mesh(mFora.geometry, mFora.material.clone());
  lDentro.castShadow = lDentro.receiveShadow = lFora.castShadow = lFora.receiveShadow = true;
  cenaLuz.add(lDentro, lFora);

  const camF = new THREE.PerspectiveCamera(F.camera.fov_vertical_graus, 1.5, 0.05, 60);
  camF.position.set(...F.camera.pos); camF.up.set(...F.camera.up); camF.lookAt(...F.camera.alvo); camF.updateProjectionMatrix();

  const sol = new THREE.DirectionalLight(0xffffff, Math.PI);
  sol.castShadow = true; sol.shadow.mapSize.set(2048, 2048);
  Object.assign(sol.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 0.5, far: 40 });
  sol.shadow.bias = -0.0004; sol.shadow.normalBias = 0.012;
  const centro = new THREE.Vector3(2, 1, 1.2);
  sol.target.position.copy(centro);
  cenaSol.add(sol, sol.target);
  // lamps seen in the photo: 3 spots of the ceiling track (2021 photo); aimed ~30 deg toward the window wall (ESTIMATIVA)
  const spots = F.spots.map((p, k) => {
    const sp = new THREE.SpotLight(0xffffff, 6 * Math.PI, 0, THREE.MathUtils.degToRad(20), 0.5, 2); // relative units
    sp.position.set(...p); sp.target.position.set(p[0], 0, p[2] - 1.4);
    if (k === 1) { sp.castShadow = true; sp.shadow.mapSize.set(1024, 1024); sp.shadow.bias = -0.0006; }
    cenaLuz.add(sp, sp.target); return sp;
  });

  const rtOpts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true };
  // half resolution: softer mask edges hide sub-pixel misfits of thin parts (frame bars, curb) between model and photo
  const rtSol = new THREE.WebGLRenderTarget(Wpx / 2, Hpx / 2, rtOpts), rtTeto = new THREE.WebGLRenderTarget(Wpx / 2, Hpx / 2, rtOpts);

  // shading proxy: heavily blurred luminance of the photo (reflectance = photo / proxy x mean albedo)
  const sombraTex = proxySombra(fotoTex.image);

  // ---------------------------------------------------------------- compositing
  const { u: uL, vazio } = uniformsLuzes([{ nome: 'teto', tipo: 'irradiancia', textura: rtTeto.texture, cor: new THREE.Color(1.0, 0.78, 0.52), ligada: st.luzes.teto, ganho: 1 }]);
  const projSpots = F.spots.map((p) => { const v = new THREE.Vector3(...p).project(camF); return new THREE.Vector2(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5); });
  const comp = new THREE.ShaderMaterial({
    uniforms: {
      uFoto: { value: fotoTex }, uSombra: { value: sombraTex }, uMasc: { value: rtSol.texture },
      uAmb: { value: 1 }, uSol: { value: 0 }, uCorSol: { value: new THREE.Color(1, 0.93, 0.8) }, uNoite: { value: 0 },
      uSimula: { value: simula ? 1 : 0 }, uSpots: { value: projSpots }, uGlow: { value: 0 }, uAsp: { value: Wpx / Hpx },
      ...uL,
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */`
      varying vec2 vUv;
      uniform sampler2D uFoto, uSombra, uMasc;
      uniform float uAmb, uSol, uNoite, uSimula, uGlow, uAsp;
      uniform vec3 uCorSol;
      uniform vec2 uSpots[3];
      ${GLSL_LUZES}
      vec3 suave(vec3 c) { return c / (1.0 + max(c - 0.85, 0.0) * 1.2); } // soft shoulder above 0.85
      void main() {
        vec3 P = texture2D(uFoto, vUv).rgb;
        if (uSimula < 0.5) { gl_FragColor = vec4(P, 1.0);
          #include <colorspace_fragment>
          return; }
        vec4 m = texture2D(uMasc, vUv);
        float dentro = step(0.5, m.g);
        float S = max(texture2D(uSombra, vUv).r, 0.02);
        vec3 refl = clamp(P / S * 0.45, 0.0, 1.0);
        // day: sky light scales the photo; direct sun adds reflectance x sun (glass transmits ~80% indoors)
        vec3 dia = P * uAmb + refl * m.r * uSol * uCorSol * mix(1.0, 0.8, dentro);
        // night: photo almost dark (outside a little bluish city glow), plus lamps
        vec3 noite = mix(P * vec3(0.022, 0.026, 0.05), P * 0.025, dentro) + (somaLuzes(vUv, P, refl) + refl * 0.035 * uPeso[0]) * dentro; // + ~indirect fill of the lamps
        float g = 0.0;
        for (int i = 0; i < 3; i++) { vec2 d = (vUv - uSpots[i]) * vec2(uAsp, 1.0); g += exp(-dot(d, d) / 0.00035); }
        noite += vec3(1.0, 0.85, 0.6) * g * uGlow;
        vec3 c = suave(mix(dia, noite, uNoite));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), comp);
  const cenaComp = new THREE.Scene(); cenaComp.add(quad);
  const camComp = new THREE.Camera();

  // ---------------------------------------------------------------- update
  const nUn = un ? un.numero : null;
  function aplicar() {
    const s = solNoInstante(SOL, st.est, st.t);
    const ue = nUn && SOL.unidades[nUn] ? SOL.unidades[nUn].est[st.est] : null;
    const cv = !!(ue && s.dia && s.dentro && ue.cv[s.idx] === '1');
    const dia = 1 - s.noite;
    const r = Math.PI / 180;
    let sinEl = 0;
    if (s.dia && s.el > 0) {
      const h = Math.cos(s.el * r); sinEl = Math.sin(s.el * r);
      const d = new THREE.Vector3(h * Math.cos((s.az - 343.4) * r), sinEl, -h * Math.cos((s.az - 253.4) * r));
      sol.position.copy(centro).addScaledVector(d, 20);
    }
    const forca = cv ? Math.min(1, sinEl * 2.4) : 0;
    comp.uniforms.uSol.value = 3.2 * forca;
    const quente = Math.max(0, Math.min(1, 1 - sinEl * 3));
    comp.uniforms.uCorSol.value.setRGB(1, 0.95 - 0.15 * quente, 0.85 - 0.3 * quente);
    comp.uniforms.uAmb.value = dia * (0.62 + 0.38 * Math.min(1, sinEl * 1.8));
    comp.uniforms.uNoite.value = s.noite;
    comp.uniforms.uPeso.value[0] = st.luzes.teto ? 0.6 : 0;
    comp.uniforms.uGlow.value = st.luzes.teto ? 0.9 : 0;
    st.sol = { hora: s.hora, az: s.az, el: s.el, cv, noite: s.noite };
    // passes
    renderer.setClearColor(0x000000, 0);
    if (simula && forca > 0) { renderer.setRenderTarget(rtSol); renderer.render(cenaSol, camF); }
    else if (simula) { sol.intensity = 0; renderer.setRenderTarget(rtSol); renderer.render(cenaSol, camF); sol.intensity = Math.PI; }
    if (simula && s.noite > 0.01 && st.luzes.teto) { renderer.setRenderTarget(rtTeto); renderer.render(cenaLuz, camF); }
    renderer.setRenderTarget(null);
    renderer.render(cenaComp, camComp);
    rot.textContent = !simula ? `Foto real de um studio do prédio (2021) · sem simulação: unidade ${un ? un.numero : id} é do final ${un ? un.final : '?'}` : s.noite > 0.5 ? ROTULO_NOITE : ROTULO_DIA;
    est.textContent = !simula ? 'O sol desta unidade está no interior 3D.'
      : `${st.est[0].toUpperCase()}${st.est.slice(1)} · ${s.hora} · ${s.noite > 0.5 ? (st.luzes.teto ? 'spots do teto acesos' : 'luzes apagadas') : cv ? 'sol direto na sacada' : 'sem sol direto agora'} · unidade ${un.numero}`;
    raiz.dataset.ready = '1';
  }
  aplicar();

  return {
    definirHora(m) { st.t = ((Number(m) % 1440) + 1440) % 1440; aplicar(); },
    definirEstacao(e) { if (SOL.estacoes[e]) { st.est = e; aplicar(); } },
    definirLuz(nome, on) { if (nome in st.luzes) { st.luzes[nome] = !!on; aplicar(); } },
    estado: () => ({ foto, unidade: nUn, simula, estacao: st.est, minutos: st.t, sol: st.sol, luzes: { ...st.luzes },
      reprojecao_px: F.reprojecao_px }),
    luzesDaFoto: ['teto'],
    fechar() {
      [rtSol, rtTeto].forEach((t) => t.dispose()); fotoTex.dispose(); sombraTex.dispose(); vazio.dispose();
      [mDentro, mFora].forEach((m) => { m.geometry.dispose(); m.material.dispose(); }); lDentro.material.dispose(); lFora.material.dispose();
      comp.dispose(); quad.geometry.dispose(); renderer.dispose(); raiz.remove();
    },
  };
}

function mergeSimples(lista) {
  let n = 0; lista.forEach((g) => { n += g.attributes.position.count; });
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of lista) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); o += g.attributes.position.count; g.dispose(); }
  const r = new THREE.BufferGeometry();
  r.setAttribute('position', new THREE.BufferAttribute(pos, 3)); r.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return r;
}

function proxySombra(img) {
  const w = 36, h = 24;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.filter = 'blur(2px)';
  g.drawImage(img, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const out = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const L = 0.2126 * lin(px[i * 4]) + 0.7152 * lin(px[i * 4 + 1]) + 0.0722 * lin(px[i * 4 + 2]);
    // canvas rows go top->bottom, texture v goes bottom->top
    const y = Math.floor(i / w), x = i % w, j = ((h - 1 - y) * w + x) * 4;
    out[j] = out[j + 1] = out[j + 2] = L; out[j + 3] = 1;
  }
  const t = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
}
