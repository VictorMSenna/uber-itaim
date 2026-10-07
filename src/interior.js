// Apartment interior in 3D with the real sun of the unit (front B4, feedback F4/F7/F14 of round 1).
//
// API (contract with B1):
//   await abrirInterior({ id, estacao, minutos, container, aoFechar, controleSol, aoMudarSol, teste })
//     id: '13-3' (andar-final) or '133' (numero); estacao: outono|inverno|primavera|verao; minutos: 0..1439
//     controleSol: optional HTMLElement = B1's sun control; when given it is mounted in the bottom bar and this
//                  module does not create its own (B1 then drives the time through definirHora/definirEstacao).
//     aoMudarSol({estacao, minutos}): called when the module's OWN control changes the time.
//   definirHora(minutos) · definirEstacao(estacao) · definirLuz(nome, ligada) · fecharInterior() · estadoInterior()
//
// Sun: direction from B3 sol.json (az/el every 15 min, interpolated); direct sun only when the unit's `cv` flag
// (with neighbours) is "1" at that step, otherwise only sky light. Patch on the floor = shadow map of the sun
// through the modelled opening (compared with B3's `mancha` polygon in test mode: medirMancha()).
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { SOL, VIZINHOS } from './dados-sol.js';
import { UNIDADES, PREDIO } from './dados.js';
import * as S from './interior-sol.js';
import { fatorCeu } from './luz-curva.js';
import { construirPlanta } from './interior-geo.js';
import { criarEntorno } from './entorno.js'; // B7: real surroundings (drone + LiDAR + orthophoto)
import { b7Ativo } from './entorno-config.js'; // E1 (B1)

const { P } = S;
const NOMES_EST = { outono: 'Outono', inverno: 'Inverno', primavera: 'Primavera', verao: 'Verão' };
const ROSA = ['norte', 'norte-nordeste', 'nordeste', 'leste-nordeste', 'leste', 'leste-sudeste', 'sudeste', 'sul-sudeste',
  'sul', 'sul-sudoeste', 'sudoeste', 'oeste-sudoeste', 'oeste', 'oeste-noroeste', 'noroeste', 'norte-noroeste'];
const rosa = (g) => ROSA[Math.round((((g % 360) + 360) % 360) / 22.5) % 16];
const dataBR = (iso) => iso.split('-').reverse().slice(0, 2).join('/');
const durTxt = (h) => { const mm = Math.round(h * 60); return `${Math.floor(mm / 60)}h${String(mm % 60).padStart(2, '0')}`; };
const lerp = (a, b, k) => a + (b - a) * k;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// light intensities in "kilo" units (lux/1000, cd/1000, nits/1000) so day and night share one scale
// and auto-exposure brings each to a photographic level. Sources in docs/RELATORIO-B4-interior.md and dados/luminarias.json.
const LUZ = {
  sol: 60,            // direct sun on a clear day ~ 60-100 klux at the ground (ESTIMATIVA, clear sky)
  ceuJanela: 9,       // sky luminance seen through the opening ~ 5-10 kcd/m2 (overcast-bright sky)
  hemi: 1.6,          // fill standing in for inter-reflections (no GI)
  env: 0.9,           // neutral environment (RoomEnvironment) for the same purpose, day
  spot: 0.9,          // GU10 LED 7 W, ~500 lm in 36 deg -> ~1.2 kcd on axis (typical datasheet)
  abajur: 0.022,      // small table lamp, E14 LED 4 W ~ 350 lm, shade absorbs ~40% -> ~17 cd
  fita: 3.2,          // LED strip 9.6 W/m ~ 800 lm/m, 0.02 m wide (luminance through the diffuser, kcd/m2)
  cozinha: 9,         // linear surface fixture 1.2 m x 0.05 m ~ 2000 lm -> L = F/(A*pi) ~ 10 kcd/m2
};
const EXPO = { dia: 0.28, noite: 7.5 };

let atual = null;

export async function abrirInterior(opts) {
  if (atual) atual.fechar(false);
  atual = criar(opts);
  await atual.pronto;
  return atual.api;
}
export function definirHora(minutos) { atual?.api.definirHora(minutos); }
export function definirEstacao(estacao) { atual?.api.definirEstacao(estacao); }
export function definirLuz(nome, ligada) { atual?.api.definirLuz(nome, ligada); }
export function fecharInterior() { atual?.fechar(true); }
export function estadoInterior() { return atual ? atual.api.estado() : null; }

function acharUnidade(id) {
  const s = String(id);
  return UNIDADES.find((u) => u.id === s || u.numero === s || `u${u.numero}` === s) || null;
}

function criar({ id, estacao = 'inverno', minutos = 660, container, aoFechar, controleSol = null, aoMudarSol = null, teste = false }) {
  const un = acharUnidade(id);
  if (!un) throw new Error(`abrirInterior: unidade ${id} nao encontrada`);
  if (!SOL.estacoes[estacao]) estacao = 'inverno';
  const T = S.transformacao(SOL, PREDIO, un.final);
  const dadosU = SOL.unidades[un.numero];
  const hPiso = S.alturaPiso(un.andar); // B5: slab of floor 1 at 11.92 m + 2.81 m per floor
  const planta = construirPlanta({ espelhado: T.espelhado });
  const mu = planta.mu;
  const ab = T.espelhado ? [P.W - P.G1, P.W - P.G0] : [P.G0, P.G1];
  // F31 (B1): only lights whose fixture is seen in the clips; 'a conferir' ones (aConferir) are not in st.luzes
  const st = { est: estacao, t: minutos, luzes: { teto: true, abajur: true, cozinha: false }, sol: null, mancha: [] };

  // ------------------------------------------------------------ DOM
  injetarCSS();
  const raiz = document.createElement('div');
  raiz.className = 'int-raiz';
  raiz.innerHTML = `
    <canvas class="int-canvas" tabindex="0" aria-label="Apartamento em 3D. Arraste para olhar em volta, role ou faça pinça para andar."></canvas>
    <div class="int-rotulos" aria-hidden="false"></div>
    <div class="int-topo">
      <button type="button" class="int-voltar">‹ Voltar ao prédio</button>
      <div class="int-titulo"><strong></strong><span class="int-sub"></span><span class="int-aviso"></span></div>
    </div>
    <div class="int-vistas" role="group" aria-label="Pontos de vista">
      <button type="button" data-v="porta" aria-pressed="true">Porta</button>
      <button type="button" data-v="janela" aria-pressed="false">Janela</button>
      <button type="button" data-v="varanda" aria-pressed="false">Varanda</button>
    </div>
    <div class="int-baixo">
      <div class="int-estado" aria-live="polite"><span class="int-ico"></span><span class="int-txt"></span></div>
      <div class="int-luzes-barra" hidden><button type="button" class="int-todas">Acender todas</button></div>
      <div class="int-slot"></div>
      <p class="int-nota">Mobília ilustrativa, no padrão das fotos e vídeos do prédio.</p>
    </div>`;
  container.append(raiz);
  const $ = (s) => raiz.querySelector(s);
  const canvas = $('.int-canvas');
  $('.int-titulo strong').textContent = `Unidade ${un.numero} · ${un.andar}º andar`;
  const sacGraus = SOL.finais[String(un.final)].sacada_aponta_graus;
  $('.int-sub').textContent = `Sacada para ${rosa(sacGraus)} (${Math.round(sacGraus)}°) · final ${un.final}`;
  const aviso = $('.int-aviso');
  aviso.textContent = T.aviso;
  aviso.classList.toggle('falta', T.tipo === 'falta');

  // ------------------------------------------------------------ renderer / scene
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: !!teste, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = EXPO.dia;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  RectAreaLightUniformsLib.init();

  const cena = new THREE.Scene();
  cena.add(planta.grupo);
  // W1 (B1): B6's baked interior on top of the procedural plan, behind entorno-config `interiorBake`; fallback = this plan
  let bakeApi = null; st.bake = 'desligado';
  if (b7Ativo('interiorBake')) {
    st.bake = 'carregando';
    import('./interior-bake.js').then((m) => m.aplicarBake(planta, { W: P.W })).then((r) => {
      bakeApi = r; st.bake = r ? 'ok' : 'falhou';
      if (r && st.sol) r.definirDia(1 - st.sol.noite);
      pedir();
    }).catch(() => { st.bake = 'falhou'; });
  }
  // neutral studio environment as a cheap stand-in for inter-reflections (diffuse + soft specular), scaled by daylight
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  pmrem.dispose();
  cena.environment = envRT.texture;
  cena.environmentIntensity = 0;
  const camera = new THREE.PerspectiveCamera(70, 1, 0.04, 2600);

  // sun
  const sol = new THREE.DirectionalLight(0xfff3e2, 0);
  sol.castShadow = true;
  sol.shadow.mapSize.set(2048, 2048);
  const sc = sol.shadow.camera;
  sc.left = -6.5; sc.right = 6.5; sc.top = 6.5; sc.bottom = -6.5; sc.near = 0.5; sc.far = 40;
  sol.shadow.bias = -0.0004;
  sol.shadow.normalBias = 0.015;
  const CENTRO = new THREE.Vector3(P.W / 2, 1.2, 4.0);
  sol.target.position.copy(CENTRO);
  cena.add(sol, sol.target);
  const hemi = new THREE.HemisphereLight(0xdfe6ee, 0xcbbfae, 0);
  cena.add(hemi);
  // sky through the opening (directional falloff from the window)
  const janela = new THREE.RectAreaLight(0xe4ecf5, 0, ab[1] - ab[0], P.HG);
  janela.position.set((ab[0] + ab[1]) / 2, P.HG / 2, P.VI - 0.02);
  janela.lookAt((ab[0] + ab[1]) / 2, P.HG / 2, 0);
  cena.add(janela);
  // bounce of the sun patch (warm, facing up)
  const reflexo = new THREE.RectAreaLight(0xffe2c0, 0, 1, 1);
  reflexo.rotation.x = -Math.PI / 2; // face +y... set below with lookAt
  cena.add(reflexo);

  // interior lights (F14). Count is fixed (no shader recompile on toggle); off = intensity 0.
  const L = planta.luminarias;
  st.hPiso = hPiso;
  const luzes = { teto: [], abajur: [], cortineiro: [], cozinha: [] };
  // F31 (B1): B6's measured spots: 2700 K, cone 60-70 deg (half 32), soft edge (penumbra 1); only the ones lit in the
  // clips are switched on by "Spots do teto" (the others exist but stayed off when filmed)
  const kSombra = Math.max(0, L.teto.spots.findIndex((s) => s.aceso && s.alvo[1] < s.pos[1])); // a lit, downward spot casts the shadow
  st.kSombra = kSombra;
  L.teto.spots.forEach((s, k) => {
    const sp = new THREE.SpotLight(0xffb46b, 0, 0, THREE.MathUtils.degToRad(32), 1.0, 2);
    sp.userData.aceso = s.aceso !== false;
    sp.position.set(...s.pos); sp.target.position.set(...s.alvo);
    if (k === kSombra) { sp.castShadow = true; sp.shadow.mapSize.set(1024, 1024); sp.shadow.bias = -0.0006; sp.shadow.normalBias = 0.02; sp.shadow.camera.near = 0.1; sp.shadow.camera.far = 8; }
    cena.add(sp, sp.target); luzes.teto.push(sp);
  });
  L.abajur.pontos.forEach((p) => { const pl = new THREE.PointLight(0xffc98f, 0, 0, 2); pl.position.set(...p); cena.add(pl); luzes.abajur.push(pl); });
  {
    const f = L.cortineiro.fita;
    const ra = new THREE.RectAreaLight(0xffd29c, 0, Math.abs(f.u1 - f.u0), 0.05);
    ra.position.set((f.u0 + f.u1) / 2, f.y, f.v + 0.02);
    ra.lookAt((f.u0 + f.u1) / 2, f.y - 1, f.v + 0.08); // down onto the curtain
    cena.add(ra); luzes.cortineiro.push(ra);
  }
  {
    const c = L.cozinha.linear;
    const ra = new THREE.RectAreaLight(0xfff0dc, 0, 0.05, c.v1 - c.v0);
    ra.position.set(c.u, c.y, (c.v0 + c.v1) / 2);
    ra.lookAt(c.u, 0, (c.v0 + c.v1) / 2);
    cena.add(ra); luzes.cozinha.push(ra);
  }

  // ------------------------------------------------------------ outside: sky, ground, neighbours ("vista simulada")
  const exterior = construirExterior(T, hPiso);
  cena.add(exterior.grupo);
  cena.fog = new THREE.Fog(0xdfe8f0, 160, 1600);
  // E1 (B1): with the B7 view on, the old grey blocks never show: from the start only the light ground + sky
  // (placeholder) until the real surroundings arrive
  if (b7Ativo('entorno')) exterior.ocultarSoBlocos();
  const entorno = criarEntorno({ cena, renderer, modo: 'interior', T, hPiso, aoCarregar: () => { exterior.ocultarBlocos(); rotVista.textContent = entorno.nota; if (st.sol) entorno.atualizarSol({ el: st.sol.el, t: st.t, az: st.sol.az, est: st.est }); pedir(); } }); // B7

  // ------------------------------------------------------------ camera control (look around + walk, clamped to the room)
  const cam = { pos: new THREE.Vector3(), yaw: 0, pitch: 0 };
  const VISTAS = {
    porta: { p: [0.98, 1.6, 0.55], a: [2.9, 0.95, 6.8] },
    janela: { p: [2.2, 1.58, 5.45], a: [2.7, 1.25, 20] },
    varanda: { p: [2.9, 1.58, P.VB - 0.36], a: [2.6, 0.9, 1.2] },
  };
  function irVista(nome) {
    if (nome === 'varanda' && P.SEM_VARANDA) nome = 'janela';
    rotVista.hidden = !(nome === 'janela' || nome === 'varanda'); // footer caption only when looking out
    const v = VISTAS[nome];
    cam.pos.set(mu(v.p[0]), v.p[1], v.p[2]);
    const d = new THREE.Vector3(mu(v.a[0]), v.a[1], v.a[2]).sub(cam.pos).normalize();
    cam.yaw = Math.atan2(d.x, d.z); cam.pitch = Math.asin(d.y) - (camera.aspect < 0.8 ? 0.14 : 0);
    raiz.querySelectorAll('.int-vistas button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === nome ? 'true' : 'false'));
    aplicarCam(); pedir();
  }
  function limitar(p) {
    let u = mu(p.x), v = p.z; // plan frame
    const naAbertura = u > P.G0 + 0.22 && u < P.G1 - 0.22;
    if (v > 5.78 && (!naAbertura || P.SEM_VARANDA)) v = 5.78;
    v = clamp(v, 0.32, Math.max(5.78, P.VB - 0.34));
    if (v > 6.3) u = clamp(u, 0.25, 5.15);
    else if (v > 5.78) u = clamp(u, P.G0 + 0.22, P.G1 - 0.22);
    else u = clamp(u, 0.3, 5.1);
    if (u > 2.72 && v < 2.12) { if (2.12 - v < u - 2.72) v = 2.12; else u = 2.72; } // bathroom block
    p.x = mu(u); p.z = v;
  }
  function aplicarCam() {
    if (st.cima) return;
    limitar(cam.pos);
    cam.pitch = clamp(cam.pitch, -0.75, 0.6);
    camera.position.copy(cam.pos);
    const d = new THREE.Vector3(Math.sin(cam.yaw) * Math.cos(cam.pitch), Math.sin(cam.pitch), Math.cos(cam.yaw) * Math.cos(cam.pitch));
    camera.lookAt(cam.pos.clone().add(d));
  }
  function andar(dist) {
    cam.pos.x += Math.sin(cam.yaw) * dist; cam.pos.z += Math.cos(cam.yaw) * dist;
    aplicarCam(); pedir();
  }
  const ponteiros = new Map();
  let pinca0 = 0;
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture?.(e.pointerId); ponteiros.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (ponteiros.size === 2) pinca0 = distPont(); });
  canvas.addEventListener('pointermove', (e) => {
    const p = ponteiros.get(e.pointerId); if (!p) return;
    if (ponteiros.size === 1) {
      const k = 2.4 / Math.max(300, canvas.clientHeight);
      cam.yaw += (e.clientX - p.x) * k; cam.pitch += (e.clientY - p.y) * k;
      aplicarCam(); pedir();
    }
    p.x = e.clientX; p.y = e.clientY;
    if (ponteiros.size === 2) { const d = distPont(); andar((d - pinca0) * 0.012); pinca0 = d; }
  });
  const soltarP = (e) => { ponteiros.delete(e.pointerId); };
  canvas.addEventListener('pointerup', soltarP); canvas.addEventListener('pointercancel', soltarP);
  function distPont() { const [a, b] = [...ponteiros.values()]; return Math.hypot(a.x - b.x, a.y - b.y); }
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); andar(-e.deltaY * 0.0025); }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    const m = { ArrowLeft: () => { cam.yaw += 0.12; }, ArrowRight: () => { cam.yaw -= 0.12; }, ArrowUp: () => andar(0.3), ArrowDown: () => andar(-0.3) }[e.key];
    if (m) { e.preventDefault(); m(); aplicarCam(); pedir(); }
  });
  raiz.querySelectorAll('.int-vistas button').forEach((b) => b.addEventListener('click', () => irVista(b.dataset.v)));
  if (P.SEM_VARANDA) raiz.querySelector('.int-vistas [data-v="varanda"]').hidden = true;

  // ------------------------------------------------------------ lamp icons (F14)
  const rotulos = $('.int-rotulos');
  const icones = {};
  for (const [nome, l] of Object.entries(L)) {
    if (l.aConferir) continue; // F31 (B1): no icon for an unconfirmed light
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'int-lamp'; b.dataset.luz = nome;
    b.innerHTML = `<span class="int-lamp-ico" aria-hidden="true"></span><span class="int-lamp-txt">${l.rotulo}</span>`;
    b.addEventListener('click', (e) => { e.stopPropagation(); api.definirLuz(nome, !st.luzes[nome]); });
    rotulos.append(b); icones[nome] = { el: b, pos: new THREE.Vector3(...l.icone) };
  }
  const rotVista = document.createElement('div');
  rotVista.className = 'int-vista-rot';
  rotVista.textContent = window.innerWidth < 640 ? 'vista simulada (sem foto)' : 'vista simulada · prédios vizinhos em blocos, sem foto';
  if (b7Ativo('entorno')) rotVista.textContent = 'vista da cidade carregando'; // E1 (B1): no blocks are shown any more
  rotulos.append(rotVista);
  const posVista = new THREE.Vector3(mu(2.7), 0.6, P.VB + 26);
  $('.int-todas').addEventListener('click', () => {
    const todasAcesas = Object.values(st.luzes).every(Boolean);
    for (const k of Object.keys(st.luzes)) st.luzes[k] = !todasAcesas;
    aplicarLuzes(); pedir();
  });
  $('.int-voltar').addEventListener('click', () => fechar(true));

  // ------------------------------------------------------------ own sun control (only when B1 did not pass hers)
  let ctlProprio = null;
  if (controleSol) $('.int-slot').append(controleSol);
  else { ctlProprio = criarControle(); $('.int-slot').append(ctlProprio.el); }

  // ------------------------------------------------------------ state -> scene
  function aplicarSol() {
    const s = S.solNoInstante(SOL, st.est, st.t);
    st.sol = s;
    const ue = dadosU && dadosU.est[st.est];
    // F23 (B1): the with-neighbours flag has 15-min samples; blend between the two neighbouring samples so the
    // direct sun fades in/out instead of switching on a quarter-hour boundary
    const cvA = ue && s.dentro && ue.cv[s.idx] === '1' ? 1 : 0;
    const cvB = ue && ue.cv[Math.min(ue.cv.length - 1, s.idx + 1)] === '1' ? 1 : 0;
    const fr = clamp((s.t - S.hm(SOL.estacoes[st.est].inicio)) / (SOL.meta.passo_min || 15) - s.idx, 0, 1);
    const cvK = s.dia && ue ? lerp(cvA, cvB, fr) : 0;
    const cv = cvK > 0.5;
    const sv = !!(ue && s.dia && s.dentro && ue.sv[s.idx] === '1');
    const d = s.dia && s.el > 0 ? S.direcaoSolPlanta(SOL, T, s.az, s.el) : null;
    const dia = 1 - s.noite;                                   // 1 day .. 0 night
    const sinEl = d ? d[1] : 0;
    const forca = d ? cvK * clamp(sinEl * 2.4, 0, 1) : 0;     // low sun is weaker (air mass)
    const quente = d ? clamp(1 - sinEl * 3, 0, 1) : 0;         // low sun is warmer
    sol.color.setRGB(1, lerp(0.95, 0.78, quente), lerp(0.88, 0.58, quente));
    sol.intensity = LUZ.sol * forca;
    sol.castShadow = true; // F30 (B1): constant (toggling recompiles all materials); intensity 0 when there is no sun
    if (d) {
      const dir = new THREE.Vector3(d[0], d[1], d[2]);
      sol.position.copy(CENTRO).addScaledVector(dir, 20);
    }
    // sky light: brighter sky on the sunny side, dim at twilight
    // F23 (B1): sky light follows the log-shaped twilight sky (fatorCeu), the exposure follows `dia`
    const ceu = fatorCeu(s.el) * (0.55 + 0.45 * clamp(sinEl * 1.6, 0, 1)) * (1 + 0.15 * cvK);
    janela.intensity = LUZ.ceuJanela * ceu + 0.02;
    janela.color.setRGB(lerp(0.75, 0.9, dia), lerp(0.8, 0.94, dia), 1);
    hemi.intensity = LUZ.hemi * ceu + 0.004;
    st.hemiDia = hemi.intensity;
    st.envDia = LUZ.env * ceu;
    // sun patch (analytic, for the bounce light and the status text; the visible patch is the shadow map)
    st.mancha = forca > 0 ? S.manchaAnalitica(d, { abertura: ab, espessura: true, vMax: P.VI }) : [];
    const area = st.mancha.length ? Math.abs(S.area(st.mancha)) : 0;
    if (area > 0.02) {
      let cu = 0, cvv = 0; st.mancha.forEach(([u, v]) => { cu += u; cvv += v; }); cu /= st.mancha.length; cvv /= st.mancha.length;
      const us = st.mancha.map((p) => p[0]), vs = st.mancha.map((p) => p[1]);
      reflexo.width = Math.max(0.3, Math.max(...us) - Math.min(...us)) * 0.8;
      reflexo.height = Math.max(0.3, Math.max(...vs) - Math.min(...vs)) * 0.8;
      reflexo.position.set(cu, 0.03, cvv); reflexo.lookAt(cu, 3, cvv);
      reflexo.intensity = LUZ.sol * forca * sinEl * 0.55 * 0.18; // floor albedo ~0.55, diffuse share
    } else reflexo.intensity = 0;
    renderer.toneMappingExposure = Math.exp(lerp(Math.log(EXPO.noite), Math.log(EXPO.dia), dia));
    exterior.atualizar(s, d, cv, dia);
    bakeApi?.definirDia(dia); // W1
    entorno.atualizarSol({ el: s.el, t: st.t, az: s.az, est: st.est }); // B7
    renderer.shadowMap.needsUpdate = true;
    st.cv = cv; st.sv = sv; st.area = area;
    atualizarTexto();
    aplicarLuzes();
  }
  function aplicarLuzes() {
    const on = (k) => (st.luzes[k] ? 1 : 0);
    luzes.teto.forEach((l) => { l.intensity = LUZ.spot * on('teto') * (l.userData.aceso ? 1 : 0); }); // F31 (B1)
    // the one shadowed spot only renders its shadow map when it matters (night + on): keeps the frame <= 50 draw calls
    luzes.teto[st.kSombra].castShadow = !!st.luzes.teto; // F30 (B1): changes only when the lamp switch changes, not at dusk
    luzes.abajur.forEach((l) => { l.intensity = LUZ.abajur * on('abajur'); });
    luzes.cortineiro[0].intensity = LUZ.fita * on('cortineiro');
    luzes.cozinha[0].intensity = LUZ.cozinha * on('cozinha');
    const brilho = (mat, ligado, cor) => { mat.color.set(ligado ? cor : 0x3a3936); };
    brilho(planta.mats.lente, st.luzes.teto, 0xfff1d6);
    brilho(planta.mats.lenteCoz, st.luzes.cozinha, 0xfff6ea);
    planta.mats.luminaria.emissive.set(st.luzes.abajur ? 0xffcf96 : 0x000000);
    planta.mats.luminaria.emissiveIntensity = st.luzes.abajur ? 0.35 : 0;
    for (const [k, ic] of Object.entries(icones)) { ic.el.setAttribute('aria-pressed', st.luzes[k] ? 'true' : 'false'); ic.el.title = `${L[k].rotulo}: ${st.luzes[k] ? 'acesa (toque para apagar)' : 'apagada (toque para acender)'}`; }
    $('.int-todas').textContent = Object.values(st.luzes).every(Boolean) ? 'Apagar todas' : 'Acender todas';
    // indirect light of the lamps (no GI): warm fill proportional to what is on (~20% of the direct light)
    const ind = 0.03 * on('teto') + 0.006 * on('abajur') + 0.012 * on('cortineiro') + 0.01 * on('cozinha');
    hemi.intensity = (st.hemiDia ?? 0) + ind;
    cena.environmentIntensity = (st.envDia ?? 0) + ind * 0.25;
    const kq = ind / Math.max(1e-6, hemi.intensity);
    hemi.color.setRGB(lerp(0.87, 1.0, kq), lerp(0.9, 0.86, kq), lerp(0.93, 0.72, kq));
    renderer.shadowMap.needsUpdate = true;
  }
  function atualizarTexto() {
    const s = st.sol, ue = dadosU && dadosU.est[st.est];
    const ico = $('.int-ico'), txt = $('.int-txt');
    const quando = `${NOMES_EST[st.est]} · ${dataBR(s.data)} · ${s.hora}`;
    let frase;
    if (!s.dia || s.el <= 0) { frase = 'noite'; ico.dataset.k = 'noite'; }
    else if (st.cv) { frase = st.area > 0.05 ? 'sol entrando pela sacada agora' : 'sol na sacada agora (não chega ao piso da sala)'; ico.dataset.k = 'sol'; }
    else if (st.sv) { frase = 'sem sol direto agora: os prédios vizinhos tapam o sol'; ico.dataset.k = 'nublado'; }
    else { frase = 'sem sol direto agora: o sol está do outro lado do prédio'; ico.dataset.k = 'nublado'; }
    const hoje = ue ? (ue.horas > 0 ? `Neste dia: ${ue.intervalos.map((i) => i.join('–')).join(', ')} (~${durTxt(ue.horas)})` : 'Neste dia: sem sol direto na sacada') : '';
    txt.innerHTML = `<b>${quando}</b> — ${frase}<br><small>${hoje}</small>`;
    const noite = s.noite > 0.45;
    $('.int-luzes-barra').hidden = !noite;
    rotulos.classList.toggle('noite', noite);
    ctlProprio?.sync();
    raiz.style.setProperty('--int-baixo', `${$('.int-baixo').offsetHeight}px`);
  }

  // ------------------------------------------------------------ render on demand
  let raf = 0, pronto = false;
  const v3 = new THREE.Vector3();
  function pedir() { if (!raf) raf = requestAnimationFrame(desenhar); }
  function desenhar() {
    raf = 0;
    renderer.render(cena, camera);
    st.ultimasChamadas = renderer.info.render.calls;
    st.maxChamadas = Math.max(st.maxChamadas || 0, st.ultimasChamadas);
    // project the floating labels
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const proj = (el, p, mostra) => {
      v3.copy(p).project(camera);
      const ok = mostra && v3.z < 1 && Math.abs(v3.x) < 1.05 && Math.abs(v3.y) < 1.05;
      el.style.display = ok ? '' : 'none';
      if (!ok) return;
      // keep the whole label inside the view (phones): clamp its centre by half its size + 8 px
      const hw = el.offsetWidth / 2 + 8, hh = el.offsetHeight / 2 + 8;
      const x = clamp((v3.x * 0.5 + 0.5) * w, hw, w - hw), y = clamp((-v3.y * 0.5 + 0.5) * h, hh, h - hh);
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    };
    const noite = st.sol && st.sol.noite > 0.45;
    for (const ic of Object.values(icones)) proj(ic.el, ic.pos, noite);
    void posVista; // Victor (Image #137): the view caption never floats over the image: footer only, Janela/Varanda only
    if (!pronto) {
      // F30 (B1): compile every program and upload the day/night textures once, so dragging the hour across
      // sunrise/sunset never compiles or uploads mid-drag
      const ocultos = []; cena.traverse((o) => { if (!o.visible) { ocultos.push(o); o.visible = true; } });
      try { renderer.compile(cena, camera); exterior.aquecer?.(renderer); } catch (e) { /* optimisation only */ }
      ocultos.forEach((o) => { o.visible = false; });
      pronto = true; raiz.dataset.ready = '1'; container.dataset.ready = '1';
    }
  }
  function redimensionar() {
    const w = Math.max(1, raiz.clientWidth), h = Math.max(1, raiz.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const hfov = THREE.MathUtils.degToRad(84);
    if (!st.cima) camera.fov = clamp(THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / camera.aspect)), 56, 84);
    camera.updateProjectionMatrix();
    raiz.style.setProperty('--int-baixo', `${$('.int-baixo').offsetHeight}px`);
    pedir();
  }
  const ro = new ResizeObserver(redimensionar);
  ro.observe(raiz);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); });
  canvas.addEventListener('webglcontextrestored', () => { renderer.shadowMap.needsUpdate = true; pedir(); });

  // ------------------------------------------------------------ own control
  function criarControle() {
    const el = document.createElement('div');
    el.className = 'int-sol';
    el.innerHTML = `<button type="button" class="int-sol-btn" aria-label="Segure para o sol andar; toque curto avança 30 minutos"><span class="int-sol-disco" aria-hidden="true"></span>Segure</button>
      <span class="int-sol-hora mono"></span>
      <input type="range" min="0" max="1435" step="5" aria-label="Hora do dia">
      <span class="int-sol-est" role="group" aria-label="Estação">${Object.entries(NOMES_EST).map(([k, n]) => `<button type="button" data-e="${k}">${n}</button>`).join('')}</span>`;
    const btn = el.querySelector('.int-sol-btn'), rng = el.querySelector('input'), hora = el.querySelector('.int-sol-hora');
    let t0 = 0, timer = 0, longo = false, raf2 = 0, tAnt = 0;
    const avisa = () => aoMudarSol?.({ estacao: st.est, minutos: st.t });
    const passo = (now) => {
      const dt = Math.min(0.25, (now - tAnt) / 1000); tAnt = now;
      const s = st.sol; const diaAgora = s && s.dia;
      st.t = (st.t + dt * (diaAgora ? 60 : 300)) % S.DIA;
      aplicarSol(); pedir(); avisa();
      raf2 = longo ? requestAnimationFrame(passo) : 0;
    };
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); t0 = performance.now(); longo = false; timer = setTimeout(() => { longo = true; tAnt = performance.now(); raf2 = requestAnimationFrame(passo); }, 260); });
    const fim = () => { if (!t0) return; clearTimeout(timer); if (!longo) { st.t = (st.t + 30) % S.DIA; aplicarSol(); pedir(); avisa(); } longo = false; if (raf2) cancelAnimationFrame(raf2); raf2 = 0; t0 = 0; };
    btn.addEventListener('pointerup', fim); btn.addEventListener('pointercancel', fim); btn.addEventListener('contextmenu', (e) => e.preventDefault());
    rng.addEventListener('input', () => { st.t = Number(rng.value); aplicarSol(); pedir(); avisa(); });
    el.querySelectorAll('[data-e]').forEach((b) => b.addEventListener('click', () => { st.est = b.dataset.e; aplicarSol(); pedir(); avisa(); }));
    return {
      el,
      sync() {
        hora.textContent = S.fmt(st.t); rng.value = String(Math.round(st.t / 5) * 5);
        el.querySelectorAll('[data-e]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.e === st.est ? 'true' : 'false'));
      },
    };
  }

  // ------------------------------------------------------------ test helpers
  // Measure the lit floor of the SHADOW MAP (furniture hidden) and compare with B3's polygon and the analytic patch.
  function medirMancha({ px = 100, diag = false, basico = false } = {}) {
    const s = st.sol;
    const d = s.dia && s.el > 0 ? S.direcaoSolPlanta(SOL, T, s.az, s.el) : null;
    const b3 = S.manchaB3Planta(SOL, T, un.final, st.est, s.idx);
    const ana = d && st.cv ? S.manchaAnalitica(d, { abertura: ab, espessura: true, vMax: P.VG }) : [];
    const larg = Math.round(P.W * px), alt = Math.round(P.VG * px);
    const rt = new THREE.WebGLRenderTarget(larg, alt);
    // camera ABOVE the wall tops (walls read as 'wall', not as the floor inside them); ceiling, balcony ceiling and
    // beam are invisible to this camera only (colorWrite off) and still cast shadow (the shadow pass uses its own material)
    const cam2 = new THREE.OrthographicCamera(0, P.W, 0, -P.VG, 0.01, 6); // looks down; screen x = u, screen -y = v
    cam2.position.set(0, P.HT + 0.4, 0); cam2.up.set(0, 0, -1); cam2.lookAt(0, 0, 0);
    cam2.left = 0; cam2.right = P.W; cam2.top = 0; cam2.bottom = -P.VG; cam2.updateProjectionMatrix();
    cam2.layers.set(5);
    const piso = planta.malhas.piso, troca = [];
    for (const m of planta.grupo.children) {
      if (planta.SHELL.includes(m.name) && m.name !== 'vidro') {
        m.layers.enable(5); troca.push([m, m.material]);
        m.material = m === piso ? new THREE.ShadowMaterial({ color: 0x000000, opacity: 1 })
          : ['teto', 'escuro'].includes(m.name) ? new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false })
            : new THREE.MeshBasicMaterial({ color: 0xff0000 });
        m.material.shadowSide = troca[troca.length - 1][1].shadowSide; // same shadow casting as the visible scene
      }
    }
    const cc = new THREE.Color(); renderer.getClearColor(cc); const ca = renderer.getClearAlpha();
    const tm = renderer.toneMapping; renderer.toneMapping = THREE.NoToneMapping;
    renderer.setClearColor(0x000000, 0);
    const lampOn = luzes.teto[st.kSombra].castShadow; luzes.teto[st.kSombra].castShadow = false; // measure the sun only
    sol.layers.enable(5); // lights are collected by the camera's layers too
    renderer.shadowMap.needsUpdate = true;
    const tipo0 = renderer.shadowMap.type; if (basico) { renderer.shadowMap.type = THREE.BasicShadowMap; }
    renderer.setRenderTarget(rt); renderer.render(cena, cam2);
    renderer.shadowMap.type = tipo0;
    const buf = new Uint8Array(larg * alt * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, larg, alt, buf);
    renderer.setRenderTarget(null);
    for (const [m, mat] of troca) { m.material.dispose(); m.material = mat; m.layers.disable(5); }
    renderer.setClearColor(cc, ca); renderer.toneMapping = tm; luzes.teto[st.kSombra].castShadow = lampOn; sol.layers.disable(5);
    renderer.shadowMap.needsUpdate = true; rt.dispose();
    // pixel row 0 of the RT = bottom of the image = v = VG
    const dentro = (poly, u, v) => { if (!poly.length) return false; let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) c = !c; } return c; };
    let nPiso = 0, nLuz = 0, nB3 = 0, nAna = 0, iB3 = 0, iAna = 0;
    const hu = {}, hv = {};
    for (let y = 0; y < alt; y++) for (let x = 0; x < larg; x++) {
      const k = (y * larg + x) * 4;
      if (buf[k] > 128 && buf[k + 3] > 128) continue; // wall seen from above
      const u = (x + 0.5) / px, v = P.VG - (y + 0.5) / px;
      const lit = st.cv && buf[k + 3] < 128;
      const inB3 = dentro(b3, u, v), inA = dentro(ana, u, v);
      nPiso++; if (lit) nLuz++; if (inB3) nB3++; if (inA) nAna++;
      if (diag && lit && !inA) { const bu = (Math.floor(u * 10) / 10).toFixed(1), bv = (Math.floor(v * 20) / 20).toFixed(2); hu[bu] = (hu[bu] || 0) + 1; hv[bv] = (hv[bv] || 0) + 1; }
      if (lit && inB3) iB3++; if (lit && inA) iAna++;
    }
    const a = (n) => +(n / (px * px)).toFixed(3);
    const r = { unidade: un.numero, estacao: st.est, hora: s.hora, cv: st.cv,
      area_shadowmap_m2: a(nLuz), area_b3_m2: a(nB3), area_analitica_m2: a(nAna),
      iou_shadowmap_b3: nLuz + nB3 ? +(iB3 / (nLuz + nB3 - iB3)).toFixed(3) : 1,
      iou_shadowmap_analitica: nLuz + nAna ? +(iAna / (nLuz + nAna - iAna)).toFixed(3) : 1 };
    if (diag) r.diag = { sol: { az: s.az, el: s.el, d: d && d.map((x) => +x.toFixed(3)) }, fora_da_analitica_por_u: hu, fora_da_analitica_por_v: hv };
    pedir();
    return r;
  }
  // B3 polygon drawn as a dashed outline on the floor (test mode)
  let contorno = null;
  function mostrarContornoB3(liga = true) {
    if (contorno) { cena.remove(contorno); contorno.geometry.dispose(); contorno = null; }
    if (!liga) return pedir();
    const poly = S.manchaB3Planta(SOL, T, un.final, st.est, st.sol.idx);
    if (poly.length && st.cv) {
      const pts = [...poly, poly[0]].map(([u, v]) => new THREE.Vector3(u, 0.035, v));
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      contorno = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xd0006f, dashSize: 0.12, gapSize: 0.07, depthTest: false }));
      contorno.computeLineDistances(); contorno.renderOrder = 10;
      cena.add(contorno);
    }
    pedir();
  }
  async function exportarGLB() {
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const base = construirPlanta({ espelhado: false });
    const g = base.grupoExport();
    // lights as KHR_lights_punctual (+ empties for the rect lights)
    const Lb = base.luminarias;
    const lg = new THREE.Group(); lg.name = 'luminarias';
    Lb.teto.spots.forEach((s, k) => { const sp = new THREE.SpotLight(0xffd9a8, LUZ.spot * 1000, 0, THREE.MathUtils.degToRad(19), 0.55, 2); sp.name = `spot_teto_${k + 1}`; sp.position.set(...s.pos); sp.target.position.set(...s.alvo); sp.target.name = `spot_teto_${k + 1}_alvo`; lg.add(sp, sp.target); });
    Lb.abajur.pontos.forEach((p, k) => { const pl = new THREE.PointLight(0xffc98f, LUZ.abajur * 1000, 0, 2); pl.name = `abajur_${k + 1}_luz`; pl.position.set(...p); lg.add(pl); });
    const e1 = new THREE.Object3D(); e1.name = 'fita_led_cortineiro'; const f = Lb.cortineiro.fita; e1.position.set((f.u0 + f.u1) / 2, f.y, f.v); e1.userData = { tipo: 'RectAreaLight', largura: Math.abs(f.u1 - f.u0), altura: 0.05, luminancia_kcd_m2: LUZ.fita, aponta: 'para baixo' }; lg.add(e1);
    const e2 = new THREE.Object3D(); e2.name = 'luminaria_cozinha_luz'; const c = Lb.cozinha.linear; e2.position.set(c.u, c.y, (c.v0 + c.v1) / 2); e2.userData = { tipo: 'RectAreaLight', largura: 0.05, comprimento: c.v1 - c.v0, luminancia_kcd_m2: LUZ.cozinha, aponta: 'para baixo' }; lg.add(e2);
    g.add(lg);
    g.userData = { frame: 'planta do final 6: x = u (atravessa a sala), y = altura, z = v (da porta para a sacada), metros', fonte: 'B4 src/interior-geo.js' };
    const exp = new GLTFExporter();
    const buf = await exp.parseAsync(g, { binary: true });
    base.texturas.forEach((t) => t.dispose());
    return buf;
  }

  // ------------------------------------------------------------ api / lifecycle
  let fechado = false;
  function fechar(chamarCallback) {
    if (fechado) return; fechado = true;
    if (raf) cancelAnimationFrame(raf);
    ro.disconnect();
    controleSol?.remove?.();
    cena.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) [].concat(o.material).forEach((m) => { m.map?.dispose(); m.emissiveMap?.dispose(); m.dispose(); }); });
    planta.texturas.forEach((t) => t.dispose());
    exterior.dispose();
    entorno.dispose(); // B7
    envRT.dispose();
    renderer.dispose();
    renderer.forceContextLoss?.();
    raiz.remove();
    if (atual && atual.raiz === raiz) atual = null;
    if (chamarCallback) aoFechar?.();
  }
  const api = {
    definirHora(m) { st.t = ((Number(m) % S.DIA) + S.DIA) % S.DIA; aplicarSol(); pedir(); },
    definirEstacao(e) { if (SOL.estacoes[e]) { st.est = e; aplicarSol(); pedir(); } },
    definirLuz(nome, lig) { if (nome in st.luzes) { st.luzes[nome] = !!lig; aplicarLuzes(); pedir(); } },
    definirLuzes(obj) { for (const k of Object.keys(st.luzes)) st.luzes[k] = !!obj[k]; aplicarLuzes(); pedir(); },
    irVista,
    olhar: (yaw, pitch) => { if (yaw != null) cam.yaw = yaw; if (pitch != null) cam.pitch = pitch; aplicarCam(); pedir(); }, // F28 (B1): test hook
    // test view from above with the ceiling hidden from the camera only (it still casts shadow: the shadow pass
    // uses its own depth material)
    vistaCima() {
      for (const k of ['teto', 'escuro']) { const m = planta.malhas[k].material; m.colorWrite = false; m.depthWrite = false; }
      camera.position.set(P.W / 2, 11, 3.6); camera.up.set(0, 0, -1); camera.lookAt(P.W / 2, 0, 3.6);
      camera.fov = 42; camera.updateProjectionMatrix(); st.cima = true; pedir();
    },
    fechar: () => fechar(true),
    estado: () => ({ bake: st.bake, camera: [camera.position.x, camera.position.y, camera.position.z, cam.yaw, cam.pitch] /* F26 (B1) */, programas: renderer.info.programs ? renderer.info.programs.length : null /* F30 (B1) */, unidade: un.numero, final: un.final, andar: un.andar, estacao: st.est, minutos: st.t, hora: st.sol?.hora,
      sol: st.sol && { az: st.sol.az, el: st.sol.el, cv: st.cv, sv: st.sv, area_mancha_m2: +st.area.toFixed(2) },
      luzes: { ...st.luzes }, planta: T.tipo, drawCalls: st.ultimasChamadas, drawCallsMax: st.maxChamadas,
      triangulos: renderer.info.render.triangles, texturas: renderer.info.memory.textures }),
    medirMancha, mostrarContornoB3, exportarGLB,
    renderizar: () => new Promise((r) => { pedir(); requestAnimationFrame(() => requestAnimationFrame(r)); }),
  };
  const obj = { api, raiz, fechar, pronto: null };
  obj.pronto = (async () => {
    aplicarSol();
    redimensionar();
    irVista('porta');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    canvas.focus({ preventScroll: true });
  })();
  return obj;
}

// ============================================================ exterior (sky dome, ground, neighbour blocks)
function construirExterior(T, hPiso) {
  const grupo = new THREE.Group(); grupo.name = 'exterior';
  // sky dome (colours set per hour; not tone mapped so it does not follow the interior exposure)
  const ceuMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
    uniforms: { zen: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, sol: { value: new THREE.Vector3(0, 1, 0) }, brilho: { value: 0 } },
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 zen; uniform vec3 hor; uniform vec3 sol; uniform float brilho; varying vec3 vD;
      void main(){ float h = clamp(vD.y, -0.2, 1.0); vec3 c = mix(hor, zen, pow(max(h,0.0), 0.55));
        float g = max(dot(normalize(vD), sol), 0.0); c += brilho * (pow(g, 600.0) * 4.0 + pow(g, 12.0) * 0.18) * vec3(1.0,0.9,0.75);
        gl_FragColor = vec4(c, 1.0); }`,
  });
  const ceu = new THREE.Mesh(new THREE.SphereGeometry(2200, 32, 16), ceuMat);
  ceu.frustumCulled = false; ceu.renderOrder = -1;
  grupo.add(ceu);
  const chaoMat = new THREE.MeshBasicMaterial({ color: 0x8f8c84, toneMapped: false });
  const chao = new THREE.Mesh(new THREE.CircleGeometry(2000, 48).rotateX(-Math.PI / 2), chaoMat);
  chao.position.y = -hPiso;
  grupo.add(chao);
  // street (R. Joao Cachoeira) in front of the street face: building x < 0 (B3 frame), ~10 m wide
  const ruaPts = [[-14, -60], [-3, -60], [-3, 80], [-14, 80]].map(([x, z]) => S.predioParaPlanta(T, x, z));
  const ruaG = new THREE.ShapeGeometry(new THREE.Shape(ruaPts.map(([u, v]) => new THREE.Vector2(u, v))));
  ruaG.rotateX(Math.PI / 2); ruaG.translate(0, -hPiso + 0.05, 0);
  const rua = new THREE.Mesh(ruaG, new THREE.MeshBasicMaterial({ color: 0x5f5f60, toneMapped: false, side: THREE.DoubleSide }));
  grupo.add(rua);

  // neighbour blocks: walls with a window texture (day) / lit windows (night); shading by vertex colour
  const texDia = texturaFachada(false), texNoite = texturaFachada(true);
  const pos = [], nor = [], uv = [], cor = [];
  const quad = (a, b, c, d, n, uvs) => { for (const [p, t] of [[a, uvs[0]], [b, uvs[1]], [c, uvs[2]], [a, uvs[0]], [c, uvs[2]], [d, uvs[3]]]) { pos.push(...p); nor.push(...n); uv.push(...t); cor.push(1, 1, 1); } };
  const y0 = -hPiso;
  for (const bl of VIZINHOS.blocos) {
    const pts = bl.xz.map(([x, z]) => S.predioParaPlanta(T, x, z));
    if (pts.every(([u, v]) => Math.hypot(u, v) > 500)) continue;
    // CCW in (u, v) seen from above => outward normals
    let ar = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; ar += a[0] * b[1] - b[0] * a[1]; }
    const pp = ar < 0 ? pts.slice().reverse() : pts;
    const y1 = y0 + bl.h;
    let acc = 0;
    for (let i = 0; i < pp.length; i++) {
      const [u0, v0] = pp[i], [u1, v1] = pp[(i + 1) % pp.length];
      const L = Math.hypot(u1 - u0, v1 - v0); if (L < 0.2) continue;
      // outward normal for CCW (u right, v down when seen from +y): (dv, -du)
      const n = [(v1 - v0) / L, 0, -(u1 - u0) / L];
      const s0 = acc / 3.2, s1 = (acc + L) / 3.2, t1 = bl.h / 2.9;
      quad([u0, y0, v0], [u1, y0, v1], [u1, y1, v1], [u0, y1, v0], n, [[s0, 0], [s1, 0], [s1, t1], [s0, t1]]);
      acc += L;
    }
    const tri = THREE.ShapeUtils.triangulateShape(pp.map(([u, v]) => new THREE.Vector2(u, v)), []);
    for (const [a, b, c] of tri) for (const k of [a, c, b]) { pos.push(pp[k][0], y1, pp[k][1]); nor.push(0, 1, 0); uv.push(0.02, 0.02); cor.push(1, 1, 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cor, 3));
  const vizMat = new THREE.MeshBasicMaterial({ map: texDia, vertexColors: true, toneMapped: false, side: THREE.DoubleSide });
  const viz = new THREE.Mesh(g, vizMat);
  grupo.add(viz);
  // sun disc
  const disco = new THREE.Mesh(new THREE.SphereGeometry(16, 16, 8), new THREE.MeshBasicMaterial({ color: 0xfff7e6, fog: false, toneMapped: false }));
  grupo.add(disco);

  const cZd = new THREE.Color(0x6f9fd0), cHd = new THREE.Color(0xdfe9f2), cZn = new THREE.Color(0x070b16), cHn = new THREE.Color(0x1d2638), cHt = new THREE.Color(0xf0b88a);
  function atualizar(s, d, cv, dia) {
    const low = d ? clamp(1 - d[1] * 4, 0, 1) : 0;
    ceuMat.uniforms.zen.value.copy(cZn).lerp(cZd, dia);
    ceuMat.uniforms.hor.value.copy(cHn).lerp(cHd, dia).lerp(cHt, low * dia * 0.5);
    ceuMat.uniforms.brilho.value = d ? dia : 0;
    if (d) ceuMat.uniforms.sol.value.set(d[0], d[1], d[2]).normalize();
    disco.visible = !!d && cv;
    if (d) disco.position.set(d[0], d[1], d[2]).normalize().multiplyScalar(2000);
    // ground & neighbours
    chaoMat.color.setRGB(lerp(0.05, 0.56, dia), lerp(0.055, 0.55, dia), lerp(0.07, 0.52, dia));
    const noite = dia < 0.2; // F23 (B1): swap late in the twilight, brightness matched below
    const mapa = noite ? texNoite : texDia; // F30 (B1): only flag the material when the texture really changes
    if (vizMat.map !== mapa) { vizMat.map = mapa; vizMat.needsUpdate = true; }
    const c = g.attributes.color, n = g.attributes.normal;
    const sd = d ? new THREE.Vector3(d[0], d[1], d[2]).normalize() : null;
    for (let i = 0; i < c.count; i++) {
      let k;
      if (noite) k = lerp(0.8, 1, clamp((0.2 - dia) / 0.2, 0, 1));
      else {
        const nd = sd ? Math.max(0, n.getX(i) * sd.x + n.getY(i) * sd.y + n.getZ(i) * sd.z) : 0;
        k = (0.55 + 0.5 * nd) * lerp(0.35, 1, dia);
      }
      c.setXYZ(i, k, k, k * (noite ? 1 : 1.02));
    }
    c.needsUpdate = true;
    cenaFog(dia);
  }
  let fogRef = null;
  function cenaFog(dia) { if (!fogRef && grupo.parent) fogRef = grupo.parent.fog; if (fogRef) fogRef.color.copy(cHn).lerp(cHd, dia); }
  return { grupo, atualizar, ocultarBlocos() { chao.visible = rua.visible = viz.visible = false; }, ocultarSoBlocos() { rua.visible = viz.visible = false; }, // E1 (B1) dispose() { texDia.dispose(); texNoite.dispose(); },
    aquecer(r) { r.initTexture(texDia); r.initTexture(texNoite); } }; // B7: ocultarBlocos · F30 (B1): aquecer = upload both textures up front
}

function texturaFachada(noite) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = noite ? '#141922' : '#d9d5cd'; g.fillRect(0, 0, 256, 256);
  // 4 x 4 cells of 3.2 m x 2.9 m (texture repeats every 4 cells)
  let s = 11;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const x = i * 64, y = j * 64;
    if (noite) g.fillStyle = rnd() < 0.38 ? (rnd() < 0.5 ? '#ffcf8a' : '#f2e3c4') : '#0b0f16';
    else g.fillStyle = rnd() < 0.15 ? '#7c8790' : '#93a1ab';
    g.fillRect(x + 10, y + 14, 44, 30);
    if (!noite) { g.fillStyle = '#c7c2b9'; g.fillRect(x, y + 56, 64, 8); }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(0.25, 0.25);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ============================================================ CSS (scoped to .int-raiz)
function injetarCSS() {
  if (document.getElementById('int-css')) return;
  const css = document.createElement('style');
  css.id = 'int-css';
  css.textContent = `
.int-raiz{position:absolute;inset:0;overflow:hidden;background:#0d1117;color:#f3f5f4;font-family:var(--f-body,"Archivo",system-ui,sans-serif);-webkit-tap-highlight-color:transparent;z-index:40}
.int-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab;outline:none}
.int-canvas:active{cursor:grabbing}
.int-topo{position:absolute;left:12px;right:12px;top:12px;display:flex;gap:10px;align-items:flex-start;pointer-events:none}
.int-topo>*{pointer-events:auto}
.int-voltar,.int-vistas button,.int-todas,.int-sol button{font:inherit;font-size:14px;font-weight:600;border:0;border-radius:999px;padding:9px 14px;background:rgba(14,18,24,.72);color:#fff;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);cursor:pointer;min-height:40px}
.int-voltar:hover,.int-vistas button:hover,.int-todas:hover{background:rgba(14,18,24,.88)}
.int-voltar:focus-visible,.int-vistas button:focus-visible,.int-lamp:focus-visible,.int-sol button:focus-visible{outline:2px solid #ffd27a;outline-offset:2px}
.int-titulo{margin-left:auto;max-width:min(430px,60%);background:rgba(14,18,24,.66);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-radius:12px;padding:8px 12px;display:flex;flex-direction:column;gap:2px;text-align:right}
.int-titulo strong{font-size:15px}
.int-sub{font-size:12.5px;opacity:.85}
.int-aviso{font-size:11.5px;opacity:.75}
.int-aviso.falta{opacity:1;background:#fff1c7;color:#6b4a00;border-radius:6px;padding:2px 6px;align-self:flex-end}
.int-vistas{position:absolute;right:12px;bottom:calc(var(--int-baixo,150px) + 10px);display:flex;gap:6px}
.int-vistas button{padding:7px 12px;min-height:36px;font-size:13px}
.int-vistas button[aria-pressed="true"]{background:#f3f5f4;color:#111}
.int-baixo{position:absolute;left:12px;right:12px;bottom:12px;display:flex;flex-direction:column;gap:8px;pointer-events:none}
.int-baixo>*{pointer-events:auto}
.int-estado{align-self:flex-start;max-width:100%;display:flex;gap:10px;align-items:center;background:rgba(14,18,24,.72);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-radius:12px;padding:8px 12px;font-size:13.5px;line-height:1.35}
.int-estado small{opacity:.8;font-size:12px}
.int-ico{flex:none;width:18px;height:18px;border-radius:50%;background:#ffc94d;box-shadow:0 0 0 3px rgba(255,201,77,.25)}
.int-ico[data-k="nublado"]{background:#9fb1c2;box-shadow:none}
.int-ico[data-k="noite"]{background:transparent;box-shadow:inset -6px -3px 0 0 #dfe6f5}
.int-nota{margin:0;font-size:11.5px;opacity:.78;text-shadow:0 1px 2px rgba(0,0,0,.8);pointer-events:none}
.int-luzes-barra{align-self:flex-start}
.int-todas{background:rgba(255,206,130,.92);color:#2a1b00}
.int-rotulos{position:absolute;inset:0;pointer-events:none}
.int-lamp{position:absolute;left:0;top:0;pointer-events:auto;display:none;align-items:center;gap:6px;border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:5px 9px 5px 5px;background:rgba(14,18,24,.62);color:#fff;font:inherit;font-size:12px;cursor:pointer;min-height:32px;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.int-rotulos.noite .int-lamp{display:inline-flex}
.int-lamp-ico{width:20px;height:20px;border-radius:50%;background:#3b3f46;border:2px solid #8a8f98;flex:none}
.int-lamp[aria-pressed="true"] .int-lamp-ico{background:#ffd27a;border-color:#fff3cf;box-shadow:0 0 10px 3px rgba(255,200,110,.75)}
.int-lamp:hover{background:rgba(14,18,24,.85)}
.int-vista-rot{position:fixed;left:0;right:0;bottom:2px;margin:0 auto;width:max-content;max-width:90vw;font-size:10.5px;padding:2px 8px;color:rgba(255,255,255,.8);text-shadow:0 1px 2px rgba(0,0,0,.6);text-align:center;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.int-vista-rot[hidden]{display:none}
.int-sol{display:flex;flex-wrap:wrap;align-items:center;gap:8px;background:rgba(14,18,24,.72);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-radius:14px;padding:8px 10px}
.int-sol-btn{display:inline-flex;align-items:center;gap:8px;background:#ffcf5c!important;color:#2a1b00!important;user-select:none;-webkit-user-select:none;touch-action:none}
.int-sol-disco{width:16px;height:16px;border-radius:50%;background:#ff9d00;box-shadow:0 0 0 3px rgba(255,157,0,.3)}
.int-sol-hora{font-family:var(--f-mono,ui-monospace,monospace);font-size:20px;font-weight:600;min-width:58px}
.int-sol input[type=range]{flex:1 1 160px;accent-color:#ffcf5c;min-width:120px}
.int-sol-est{display:flex;gap:4px;flex-wrap:wrap}
.int-sol-est button{padding:6px 10px;min-height:32px;font-size:12.5px;background:rgba(255,255,255,.1)}
.int-sol-est button[aria-pressed="true"]{background:#f3f5f4;color:#111}
@media (max-width:640px){
 .int-titulo{max-width:62%;padding:6px 9px}.int-titulo strong{font-size:13.5px}.int-sub{font-size:11.5px}
 .int-voltar{padding:8px 11px;font-size:13px}
 .int-estado{font-size:12.5px}
 .int-sol-hora{font-size:18px}
}`;
  document.head.append(css);
}
