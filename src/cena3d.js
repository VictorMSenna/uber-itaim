// 3D model of the building, generated from dados/predio.json (no .glb file).
// three.js WebGLRenderer + camera-controls, render on demand, 1 InstancedMesh for the 117 units.
// Round 1: white-model finish (F1), stronger readable shadows (F7), sun arc centred on the building with a
// large radius and only above the horizon (F3/F6), draggable sun (F5), tap = that exact unit (F8),
// hover cursor + label (F12), loop that never sleeps while there is input (F10).
import { capacidade, rebaixar } from './capacidade.js';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import CameraControls from 'camera-controls';
import { construirPredio } from './predio-geo.js';
import { FORMA } from './predio-forma.js';
import { CONTINUO } from './predio-continuo.js'; // E5 (B7)
import { forcaSolDireto, calorSol, corCeu, smooth } from './luz-curva.js';
import { Sky } from 'three/addons/objects/Sky.js'; // F42: physically based day sky (Preetham, MIT)
// B7 modules are loaded only when their flag is on (they pull dados-sol.js, 236 KB, and GLTFLoader at start-up)
import { b7Ativo } from './entorno-config.js';
import { LUZ_NOITE, COR_LUZ_NOITE, nivelNoite } from './noite.js';

CameraControls.install({ THREE });

import { ESTADOS, SELECAO } from './estados.js'; // F38: day colours, night light and legend in one table

export function criarCena({ container, predio, unidades, teste = false,
  onTocarUnidade, onDuploToque, onTocarAndar, onHover, onArrastarSol }) {
  void predio; // geometry now comes from FORMA (front B5, measured from the drone)
  const NIV = FORMA.niveis;
  const H = NIV.pe_direito;
  const LAJES = NIV.lajes;            // LAJES[k-1] = top of the slab of level k (1 = 1st floor, 14 = terrace)
  const LAJE = NIV.espessura_laje;
  const TOPO = NIV.topo_coroa;
  // tower footprint = union of the unit boxes; whole building = all volumes
  const cxs = Object.values(FORMA.unidades).map((u) => u.caixa);
  const X0 = Math.min(...cxs.map((c) => c[0])), X1 = Math.max(...cxs.map((c) => c[3]));
  const Z0 = Math.min(...cxs.map((c) => c[2])), Z1 = Math.max(...cxs.map((c) => c[5]));
  const vols = FORMA.volumes.map((v) => v.caixa);
  const BX0 = Math.min(...vols.map((c) => c[0])), BX1 = Math.max(...vols.map((c) => c[3]));
  const BZ0 = Math.min(...vols.map((c) => c[2])), BZ1 = Math.max(...vols.map((c) => c[5]));
  const CX = (X0 + X1) / 2, CZ = (Z0 + Z1) / 2;
  const W = X1 - X0, D = Z1 - Z0;
  const mobile = Math.min(window.innerWidth, window.innerHeight) < 700;
  // F6 + F19: the sun and its arc live on a SKY DOME around the camera (direction only, "at infinity"), drawn with
  // depth test so buildings hide it: it is always in the sky behind/around the tower, never in front of a facade,
  // and the building can stay centred and large. Light and shadows use the TRUE direction; on the dome the elevation
  // is compressed (ELEV_TELA) so the whole day arc fits in the sky above the tower in the sun framing.
  // F39 (Victor 01:0x): the arc is FINITE again, around the building, radius 2.5x its height (F6 hugged it at 1.2x,
  // the sky dome was too big); true sun directions; always visible (faint where a building is in front)
  const RAIO_CEU = 2.5 * TOPO;
  const RAIO_ARCO = RAIO_CEU; // kept for helpers/tests
  // F34: no Sol mode any more: one lens; F33: no camera change when the sun switches on
  const FOV_NORMAL = 56, FOV_SOL = 56;
  // B7 outside surroundings on: drone-like camera (30-40 deg above the building centre), never near street level,
  // where the base boxes / orthophoto ground would look unfinished. Off: the previous camera.
  const DRONE = b7Ativo('entornoFora');
  // F34: one outside view; aerial (start 18 deg above the building centre = ~roof height, sky band at the top of the
  // frame for the sun), lowest 8 deg (never street level), highest 50 deg
  const POL = {
    inicio: (DRONE ? 0.40 : 0.42) * Math.PI,
    max: (DRONE ? 0.455 : 0.48) * Math.PI,
    sol: 0.42 * Math.PI,                        // sun view: ~14 deg, roof height, sky above the roof
    maxSol: 0.44 * Math.PI,
    solRetrato: 0.46 * Math.PI,                 // portrait: little sky above the tall tower -> look a bit flatter
    maxSolRetrato: 0.47 * Math.PI,
  };
  // Sun framing: camera ~5 m above the street, slightly looking up (polar 0.56 pi), lens 62 deg: the roof line is
  // ~24 deg above the horizon and the top of the frame ~40 deg. Low sun stays at the real horizon (hidden by the
  // neighbours when behind them); from ~12 deg up the sun is drawn ABOVE the roof line, up to the top of the sky.
  // Portrait screens have less sky above the roof: roof line ~22 deg, top of the frame ~30 deg.
  let ceuRetrato = false, estacaoAtual = null;
  // display elevation on the dome: the sun view looks ~14 deg down with a 70 deg lens, so the top of the frame is
  // ~20 deg above the horizon; the sun goes from just above the horizon to just under the top of the frame.
  let topoCeuVisivel = 12; // elevation (deg) of the top edge of the current view, updated by seguirCamera()
  const ELEV_TELA = (el) => Math.max(0, el); // F39: true elevation on the finite arc
  const ELEV_TELA_CEU = (el) => {
    const e = Math.max(0, el);
    const topo = Math.max(3, topoCeuVisivel - (ceuRetrato ? 4 : 3)); // keep the disc under the top bar
    const teto = 1.5 + (topo - 1.5) * 0.55;
    if (e <= 12) return 1.5 + e * (teto - 1.5) / 12;
    return teto + (Math.min(e, 90) - 12) * (topo - teto) / 78;
  };
  let largura = 1, altura = 1;
  const stats = { quadros: 0, calls: 0, triangles: 0, geometries: 0, textures: 0, pronto: false };
  const clock = { t: performance.now(), getDelta() { const n = performance.now(); const d = (n - this.t) / 1000; this.t = n; return Math.min(d, 0.25); } };
  let rafId = 0, sujo = true, ociosos = 0;
  let controls = null;
  let ponteiroAbaixo = 0, continuo = false;

  // ---------- renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'default', preserveDrawingBuffer: !!teste });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2, capacidade().dprMax)); // tier: src/capacidade.js
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false; // static scene: shadow recomputed only when the light changes
  renderer.shadowMap.needsUpdate = true;
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-label', 'Prédio em 3D: arraste para girar, toque numa janela para ver a unidade');
  canvas.className = 'cena-canvas';
  container.prepend(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV_NORMAL, 1, 1, 3600);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  // ---------- palette (from the building: light concrete, brick, green-tinted balcony glass)
  const tema = {};
  function lerTema() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => (cs.getPropertyValue(n).trim() || d);
    tema.ceu = new THREE.Color(v('--cena-ceu', '#c9cfcc'));
    tema.fundo = new THREE.Color(v('--cena-fundo', '#e4dfd5'));
    tema.chao = new THREE.Color(v('--cena-chao', '#dcd6cb'));
    tema.argila = new THREE.Color(v('--cena-argila', '#efebe4'));
    tema.argilaEscura = new THREE.Color(v('--cena-argila-2', '#cfc9be'));
    tema.tijolo = new THREE.Color(v('--cena-tijolo', '#8a4a35'));
    tema.vizinho = new THREE.Color(v('--cena-vizinho', '#dcd7cd'));
    tema.linha = new THREE.Color(v('--cena-linha', '#3a3530'));
    tema.rua = new THREE.Color(v('--cena-rua', '#3c3e42'));
    tema.vidro = new THREE.Color(v('--cena-vidro', '#9fbdb2'));
    tema.destaque = new THREE.Color(v('--cena-destaque', '#14110f'));
  }
  lerTema();

  // sky gradient (CanvasTexture, generated, 1 small texture)
  function texturaCeu(topo, horizonte) {
    const cv = document.createElement('canvas');
    cv.width = 2; cv.height = 256;
    const g = cv.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, '#' + topo.getHexString());
    gr.addColorStop(1, '#' + horizonte.getHexString());
    g.fillStyle = gr; g.fillRect(0, 0, 2, 256);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  let ceuDia = texturaCeu(tema.ceu, tema.fundo);
  // F23: one sky texture repainted along the twilight curve (continuous, no swap)
  const ceuCv = document.createElement('canvas');
  ceuCv.width = 2; ceuCv.height = 256;
  const ceuTex = new THREE.CanvasTexture(ceuCv);
  ceuTex.colorSpace = THREE.SRGBColorSpace;
  function pintarCeu(topo, horiz) {
    const g = ceuCv.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, topo); gr.addColorStop(1, horiz);
    g.fillStyle = gr; g.fillRect(0, 0, 2, 256);
    ceuTex.needsUpdate = true;
  }
  scene.background = ceuDia;
  scene.fog = new THREE.Fog(tema.fundo.clone(), 500, 1500); // F24: farther zoom-out without haze on the tower

  // ---------- lights (F7: less ambient, stronger key light, darker readable shadows)
  const LUZ = { sol: 2.8, env: 0.36, hemi: 0.16, sombra: 0.95 };
  scene.environmentIntensity = LUZ.env;
  const hemi = new THREE.HemisphereLight(0xffffff, 0xb7ad9e, LUZ.hemi);
  scene.add(hemi);
  const sol = new THREE.DirectionalLight(0xfff4e6, LUZ.sol);
  const CENTRO = new THREE.Vector3(CX, 0, CZ);
  sol.position.set(-45, 70, -50);
  sol.target.position.copy(CENTRO);
  sol.castShadow = true;
  const MAPA = mobile ? 2048 : 4096; // F40: the shadow map covers ~250 m around the tower (city shadows), never off on phones
  sol.shadow.mapSize.set(MAPA, MAPA);
  const sc = sol.shadow.camera;
  sc.left = -60; sc.right = 60; sc.top = 72; sc.bottom = -60; sc.near = 10; sc.far = 340;
  sol.shadow.bias = -0.0008; // F40 (B7): wider shadow box
  sol.shadow.normalBias = 0.05;
  sol.shadow.intensity = LUZ.sombra;
  // B9 (07/10): softer shadow edge (PCF radius; the city shader reads the same radius). ~0.6 m on phones (2048 map over
  // 500 m), ~0.25 m on desktop (4096). ?sombraRaio= overrides for tests
  sol.shadow.radius = +((/[?&]sombraRaio=([\d.]+)/.exec(location.search) || [0, mobile ? 2.5 : 2.0])[1]);
  scene.add(sol, sol.target);

  // ---------- materials (white-model recipe: matte light clay, thin dark edges)
  const matUnid = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
  const matChao = new THREE.MeshStandardMaterial({ color: tema.chao, roughness: 1, metalness: 0 });
  const matRua = new THREE.MeshStandardMaterial({ color: tema.rua, roughness: 1, metalness: 0 });
  const CALCADA = new THREE.Color('#b3ada3');
  const matCalcada = new THREE.MeshStandardMaterial({ color: CALCADA, roughness: 1, metalness: 0 });
  // balcony glass suggested WITHOUT transmission: tinted, slightly reflective, semi-opaque

  const box = new THREE.BoxGeometry(1, 1, 1);
  const tmpQ = new THREE.Quaternion();
  const matrizBox = (x0, y0, z0, x1, y1, z1) => new THREE.Matrix4().compose(
    new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), tmpQ,
    new THREE.Vector3(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)));

  // ---------- building (front B5): measured volumes, units = ONE InstancedMesh with the same ids
  // F1 finish: real tones sampled from sunlit drone frames (DJI_0204 8 s, DJI_0197), backlight compensated
  const matUnidade = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.05 });
  // E5: each unit face = sliding glass doors: dark frame on the edges, 3 mullions, a transom at door height; the
  // status colour (instance colour) stays only on the glass panes (F38 readability)
  matUnidade.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vUvE5;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec2 q = vUvE5;
          float fx = 0.018, fy = 0.03;                                   // outer frame (~8-10 cm)
          float borda = step(q.x, fx) + step(1.0 - fx, q.x) + step(q.y, fy) + step(1.0 - fy, q.y);
          float m = abs(fract(q.x * 4.0 + 0.5) - 0.5) / 4.0;            // 3 mullions (4 panes)
          float mul = 1.0 - step(0.006, m);
          float tr = 1.0 - step(0.008, abs(q.y - 0.86));                 // transom at door height
          float quadro = clamp(borda + mul + tr, 0.0, 1.0);
          vec3 vidro = mix(vec3(0.05, 0.07, 0.08), diffuseColor.rgb, 0.92); // tinted glass, a bit deeper
          diffuseColor.rgb = mix(vidro, vec3(0.16, 0.165, 0.17), quadro);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.7, step(0.5, clamp(step(vUvE5.x, 0.018) + step(0.982, vUvE5.x) + step(vUvE5.y, 0.03) + step(0.97, vUvE5.y), 0.0, 1.0)));`);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec2 vUvE5;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vUvE5 = uv;`);
  };
  matUnidade.customProgramCacheKey = () => 'unidade-e5';
  // E5: B7's filler boxes (piers between units, slab bands between floors) join B5's volumes (same material batches,
  // no extra draw calls)
  const PB = construirPredio(THREE, { forma: FORMA, linhas: true, materiais: {
    branco: '#c2bdb3',      // E5c: cream piers (DJI_0201, lit)  — was #9a968f      // exposed concrete: medium grey-brown (sunlit #bfbfc0 overexposed, shade #605c5b)
    pedra: '#a4a5a8',       // E5c: slab edges, uniform light grey (DJI_0201) — was #aca79f       // slab edges / stone bands
    embasamento: '#919297', // stone box under the units: median of its lit face in DJI_0201 (was #55575b, read as black)
    tijolo: '#4f3938',      // purple-brown brick crown (sunlit median #4e3837)
    cornija: '#3c3938', cobertura: '#3e3d3f', bege: '#8a7f6f',
    unidade: matUnidade,    // white so instanceColor shows the status colour exactly
  } });
  scene.add(PB.grupo);
  // F45: the facade shader (predio-textura.js) reads a 'uvB' attribute on the cube shared by all of B5's meshes. If
  // it is only added when the facade arrives, the cube was already drawn without it: some loads then bound the
  // attribute as constant (0,0) and every face sampled one texel of the photo (flat dark tower). Add it up front,
  // before the first frame, whatever finishes first.
  PB.grupo.traverse((o) => { if (o.isMesh && o.geometry.attributes.uv && !o.geometry.attributes.uvB) o.geometry.setAttribute('uvB', o.geometry.attributes.uv.clone()); });
  // E5: B7's fillers (piers between units, slab bands between floors) as two extra instanced meshes (own meshes, so
  // B5's meshes keep the instance counts the facade photo bake was made for). Colours from the drone photo.
  {
    const CORES = { branco: '#cdc5b8', pedra: '#b9b2a6' }; // cream concrete of the piers / slab edges (DJI_0201/0199, sunlit)
    for (const mat of ['branco', 'pedra']) {
      const lista = CONTINUO.filter((c) => c.material === mat);
      if (!lista.length) continue;
      const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: CORES[mat], roughness: 0.9 }), lista.length);
      lista.forEach((c, k) => m.setMatrixAt(k, matrizBox(...c.caixa)));
      m.instanceMatrix.needsUpdate = true; m.computeBoundingSphere();
      m.castShadow = m.receiveShadow = true; m.raycast = () => {}; m.name = 'predio-continuo-' + mat;
      PB.grupo.add(m);
    }
  }
  let gradeFn = null; // E2 (B7's gradeEntorno once entorno.js is loaded)
  // B7 (behind flags): no-op stand-in until/unless the module loads
  let entB7 = { carregado: false, atualizarCamera() {}, atualizarSol() {} };
  if (DRONE) {
    import('./entorno.js').then(({ criarEntorno, gradeEntorno }) => {
      gradeFn = gradeEntorno || null; // E2: the tower follows the same twilight grade as the B7 city
      if (solEstado.ultimo && gradeFn) pedirRender();
      entB7 = criarEntorno({ cena: scene, renderer, modo: 'externo', alvo: new THREE.Vector3(CX, TOPO * 0.45, CZ), aoCarregar: () => { entB7.carregado = true; chao.visible = rua.visible = false; if (entorno) entorno.visible = entornoFantasma.visible = false; pedirRender(); setTimeout(() => nossoCarregou(), 0); } });
    }).catch((e) => console.error('B7 entorno', e));
  }
  const b7 = { fachada: false };
  // B10 (local test, opt-in ?google3d=1 + key injected at runtime): Google Photorealistic 3D Tiles as the city. The tower (PB) stays on
  // top untouched; the B7 city + B9 bake are hidden only while Google's tiles are really on screen and come back on any failure.
  let gCena = null, torreCamada = false;
  // Victor 07/10: OUR tower and city load first; Google's city starts downloading only after the facade texture and our
  // city are on screen (or after 20 s, whichever comes first), so the phone's bandwidth goes to our model first
  let preJanela = null; // unit whose window view should be prefetched (card open)
  let avisaNosso = null; const nossoPronto = new Promise((ok) => { avisaNosso = ok; setTimeout(ok, 20000); });
  const nossoCarregou = () => { if ((entB7.carregado || !DRONE) && (b7.fachada || !b7Ativo('fachada'))) avisaNosso(); };
  if (!/[?&]google3d=0/.test(location.search)) nossoPronto.then(() => import('./google-vista.js')).then(async (gm) => {
    // origin of the B5 plan (sidewalk NW corner, y = 0): LiDAR-registered (b7 quadro.py); h = LiDAR 736.39 m + geoid N (-3.5 m, calibrated in RELATORIO-B10)
    gCena = await gm.ligarGoogleCena({ scene, camera, renderer, ref: { lat: -23.5939395, lon: -46.6747339, h: 732.89, rumoX: 71.67 }, aoMudar: () => pedirRender(), recorte: (() => { const bx = new THREE.Box3().setFromObject(PB.grupo); bx.min.x -= 2.2; bx.min.z -= 2.2; bx.max.x += 2.2; bx.max.z += 2.2; /* 07/10: the real building's balconies stuck out of 0.8 m */ bx.min.y = 3.5 /* 07/10: keeps Google's ground around the tower (0.3 m showed our 2020 construction-site photo as a grey stain) */; bx.max.y += 3; return bx; })(),
      mostrar: () => { chao.visible = rua.visible = !entB7.carregado; if (entB7.grupo) { entB7.grupo.visible = !!entB7.carregado; if (b7SoSombra) voltaB7(); } pedirRender(); } });
    if (gCena && solEstado.ultimo) gCena.definirSol(solEstado.ultimo.el);
    if (gCena && preJanela) gCena.preCarregar(preJanela);
  }).catch((e) => console.warn('google3d (cena) indisponivel', e && e.message));
  if (b7Ativo('fachada')) import('./predio-textura.js').then(({ texturizarPredio }) => texturizarPredio(PB, { renderer, mascara: true }).then((r) => {
    b7.fachada = true; nossoCarregou(); b7.mascara = !!(r.mascararMaterial && r.mascararMaterial(matUnidNoite)); // E5: night light only on the glass
    if (b7.mascara) { const mascara = matUnidNoite.onBeforeCompile; matUnidNoite.onBeforeCompile = (sh) => { fachadaNoite(sh); mascara(sh); }; matUnidNoite.customProgramCacheKey = () => 'unid-noite-fachada-mascara'; matUnidNoite.needsUpdate = true; } // 07/10: keep the facade-only rule (mascararMaterial replaced it)
    // F30: compile the new programs now (facade + masked night light), not at the first dusk of a drag
    const v = meshNoite.visible; meshNoite.visible = true;
    try { renderer.compile(scene, camera); } catch (e) { /* optimisation only */ }
    meshNoite.visible = v;
    pedirRender();
  })).catch((e) => console.error('B7 fachada', e));
  const meshUnid = PB.pecas.unidades;
  // E5: the gaps between unit volumes are closed by B7's piers (predio-continuo), not by stretching the units
  const inst = unidades.map((u) => PB.unidades.get(u.id).instancia); // my index -> instance
  const doInst = new Map(inst.map((k, i) => [k, i]));                 // instance -> my index
  const unidadeBox = unidades.map((u) => { const b = PB.unidades.get(u.id).caixa; return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]; });
  const corIndisp = new THREE.Color(ESTADOS.indisponivel.dia); // F38: neutral dark grey glass (was B5's pale green glass)
  stats.predio = 'B5';

  const reservIdx = unidades.map((u, i) => (u.situacao === 'reservada' ? i : -1)).filter((i) => i >= 0);
  let meshListras = null;
  if (reservIdx.length) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    g.strokeStyle = 'rgba(40,28,0,0.55)'; g.lineWidth = 9;
    for (let k = -64; k <= 128; k += 22) { g.beginPath(); g.moveTo(k, 0); g.lineTo(k + 64, 64); g.stroke(); }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(3, 2); tex.colorSpace = THREE.SRGBColorSpace;
    meshListras = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false }), reservIdx.length);
    reservIdx.forEach((i, k) => { const b = unidadeBox[i]; meshListras.setMatrixAt(k, matrizBox(b[0] - 0.01, b[1] - 0.01, b[2] - 0.01, b[3] + 0.01, b[4] + 0.01, b[5] + 0.01)); });
    meshListras.raycast = () => {};
    scene.add(meshListras);
  }

  const chao = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), matChao);
  chao.rotation.x = -Math.PI / 2; chao.position.copy(CENTRO); chao.receiveShadow = true; chao.raycast = () => {};
  scene.add(chao);
  // F24: the street was a 9 x 1600 m plane that turned yellow-brown at night and read as a light beam. Now a dark
  // asphalt street of the block's length with a sidewalk on each side; dark at night. Hidden once B7 loads.
  const COMPR_RUA = 300;
  const rua = new THREE.Group();
  const asfalto = new THREE.Mesh(new THREE.PlaneGeometry(9, COMPR_RUA), matRua);
  asfalto.position.set(BX0 - 7, 0.02, CZ);
  const calcadas = [BX0 - 1.25, BX0 - 12.75].map((x) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(2.5, COMPR_RUA), matCalcada); m.position.set(x, 0.04, CZ); return m; });
  [asfalto, ...calcadas].forEach((m) => { m.rotation.x = -Math.PI / 2; m.receiveShadow = true; m.raycast = () => {}; rua.add(m); });
  scene.add(rua);
  // Victor 22:0x: the OSM blocks are not georeferenced to this street and sat on it. The street is not shown at all:
  // with B7 on, the LiDAR model + orthophoto ground carry the real street; with B7 off, no fake street.
  rua.visible = false;

  // thin silhouette lines come from B5 (linhas: true)
  const matLinha = PB.pecas.linhas ? PB.pecas.linhas.material : new THREE.LineBasicMaterial();
  matLinha.toneMapped = false;

  // selection (floor = context, unit = the one tapped) and hover outlines
  const matSel = new THREE.LineBasicMaterial({ color: SELECAO.cor, toneMapped: false, depthTest: false, transparent: true, linewidth: 2 }); // F38
  const matAndar = new THREE.LineBasicMaterial({ color: tema.destaque, toneMapped: false, transparent: true, opacity: 0.35 });
  const matHover = new THREE.LineBasicMaterial({ color: 0xffffff, toneMapped: false, depthTest: false, transparent: true, opacity: 0.95 });
  const caixaLinhas = (b) => { const g = new THREE.EdgesGeometry(box); g.applyMatrix4(matrizBox(...b)); return g; };
  const selAndar = new THREE.LineSegments(new THREE.BufferGeometry(), matAndar);
  const selUnid = new THREE.LineSegments(new THREE.BufferGeometry(), matSel);
  const selHover = new THREE.LineSegments(new THREE.BufferGeometry(), matHover);
  [selAndar, selUnid, selHover].forEach((o) => { o.renderOrder = 10; o.visible = false; o.raycast = () => {}; scene.add(o); });
  const brilho = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false, toneMapped: false }));
  brilho.visible = false; brilho.raycast = () => {}; brilho.renderOrder = 9;
  scene.add(brilho);

  // ---------- colours by status (day mesh + night mesh, toggled by visibility)
  const estado = { andar: null, unidade: null, filtro: null };
  const corStatus = { disponivel: new THREE.Color(ESTADOS.disponivel.dia), reservada: new THREE.Color(ESTADOS.reservada.dia) };
  // F25: night colours come from the single convention table (src/noite.js)
  const corNoite = Object.fromEntries(Object.keys(LUZ_NOITE).map((s) => [s, new THREE.Color(COR_LUZ_NOITE[nivelNoite(s)])]));
  const fundoNoite = new THREE.Color('#15213a');
  const cTmp = new THREE.Color();
  const solEstado = { ativo: false, noite: 0, luzes: 0, modo: 'real', flags: null, SOL: null, ref: null };
  const matUnidNoite = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  // Victor 07/10 08:47: amber horizontal streaks on the tower at night = the top/bottom and side faces of each unit's
  // light box showing in the slab gaps. Light only the facade faces (normal along the box's THIN horizontal axis).
  const fachadaNoite = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vFachada;\nattribute vec3 aFace;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vFachada = step(0.5, dot(normal, aFace));
        vec3 escN = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        `); // 07/10 10:5x: no outward push (light floated in front of the balcony, Victor)
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vFachada;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (vFachada < 0.5) discard;');
  };
  matUnidNoite.onBeforeCompile = fachadaNoite;
  matUnidNoite.customProgramCacheKey = () => 'unid-noite-fachada';
  const boxNoite = box.clone();
  const faceArr = new Float32Array(unidades.length * 3);
  unidades.forEach((u, i) => { const nn = PB.unidades.get(u.id)?.normal; if (nn) faceArr.set([nn.x, nn.y, nn.z], inst[i] * 3); });
  boxNoite.setAttribute('aFace', new THREE.InstancedBufferAttribute(faceArr, 3));
  const meshNoite = new THREE.InstancedMesh(boxNoite, matUnidNoite, unidades.length);
  unidadeBox.forEach((b, i) => meshNoite.setMatrixAt(inst[i], matrizBox(...b))); // E5: same instance order as PB's units
  meshNoite.visible = false; meshNoite.raycast = () => {};
  scene.add(meshNoite);
  function pintar() {
    const luzes = solEstado.luzes || 0;
    unidades.forEach((u, i) => {
      const foraFiltro = estado.filtro && !estado.filtro(u);
      const foraAndar = estado.andar != null && u.andar !== estado.andar;
      cTmp.copy(u.situacao === 'indisponivel' ? corIndisp : corStatus[u.situacao]);
      if (solEstado.flags && solEstado.flags[i] === 0) cTmp.multiplyScalar(0.58);
      if (foraFiltro) cTmp.lerp(tema.fundo, 0.8); else if (foraAndar) cTmp.lerp(tema.fundo, 0.45);
      meshUnid.setColorAt(inst[i], cTmp);
      cTmp.copy(corNoite[u.situacao]);
      if (foraFiltro) cTmp.lerp(fundoNoite, 0.78); else if (foraAndar) cTmp.lerp(fundoNoite, 0.5);
      meshNoite.setColorAt(inst[i], cTmp);
    });
    meshUnid.instanceColor.needsUpdate = true;
    meshNoite.instanceColor.needsUpdate = true;
    meshUnid.visible = true;
    meshNoite.visible = luzes > 0.01;
    matUnidNoite.opacity = luzes;
    if (meshListras) { meshListras.material.opacity = (estado.andar != null ? 0.6 : 1) * (1 - luzes); meshListras.visible = luzes < 0.99; }
    pedirRender();
  }
  pintar();

  // ---------- camera + controls
  // F19/F21: the orbit target is ALWAYS the building centre; full 360 deg azimuth; no pan; polar and distance
  // clamped so the building stays centred in the free area (left of the panel / above the sun panel) and large.
  controls = new CameraControls(camera, canvas);
  controls.smoothTime = 0.25;
  controls.draggingSmoothTime = 0.1;
  controls.minPolarAngle = 0.22 * Math.PI;
  controls.maxPolarAngle = POL.max;
  controls.minAzimuthAngle = -Infinity;
  controls.maxAzimuthAngle = Infinity;
  controls.dollyToCursor = false;
  controls.mouseButtons.left = CameraControls.ACTION.ROTATE;
  controls.mouseButtons.right = CameraControls.ACTION.ROTATE;
  controls.mouseButtons.middle = CameraControls.ACTION.DOLLY;
  controls.mouseButtons.wheel = CameraControls.ACTION.DOLLY;
  controls.touches.one = CameraControls.ACTION.TOUCH_ROTATE;
  controls.touches.two = CameraControls.ACTION.TOUCH_DOLLY;
  controls.touches.three = CameraControls.ACTION.NONE;

  const caixaPredio = new THREE.Box3(new THREE.Vector3(BX0, 0, BZ0), new THREE.Vector3(BX1, TOPO, BZ1));
  const ALVO = caixaPredio.getCenter(new THREE.Vector3());
  const RAIO_PREDIO = caixaPredio.getBoundingSphere(new THREE.Sphere()).radius;
  const esferaPredio = new THREE.Sphere(ALVO.clone(), RAIO_PREDIO);
  // target may slide up/down the tower axis (unit focus), never sideways
  const limiteAlvo = new THREE.Box3(new THREE.Vector3(ALVO.x - 0.25, 0, ALVO.z - 0.25), new THREE.Vector3(ALVO.x + 0.25, TOPO, ALVO.z + 0.25));
  const alvoAtual = ALVO.clone();
  controls.setBoundary(limiteAlvo);
  controls.boundaryFriction = 0;
  let modoJanela = false;
  // distance that fits the building sphere in the FREE area (setViewOffset widens the virtual frame)
  function distanciaAjuste() {
    const fullW = largura + desloc.x, fullH = altura + desloc.y;
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const tv = t * (altura - desloc.y) / fullH;            // half-height of the free area
    const th = t * (largura - desloc.x) / fullH;           // half-width of the free area (same pixel scale)
    const meia = Math.atan(Math.min(tv, th));
    return RAIO_PREDIO / Math.sin(meia);
  }
  // F39: distance that frames the whole sun arc (radius RAIO_CEU around the building) in the free area
  function distanciaArco() {
    const tg = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const meia = Math.atan(tg * Math.min(altura - desloc.y, largura - desloc.x) / (altura + desloc.y));
    return (RAIO_CEU * 1.08) / Math.sin(meia);
  }
  function aplicarLimites() {
    if (modoJanela) return;
    // F33/F26: panels, the photo and the bar never move the camera: the limits are widened to include the current
    // distance (camera-controls would otherwise clamp it on the next frame); hidden stage (photo) = no change at all
    if (largura < 50 || altura < 50 || container.style.visibility === 'hidden') return;
    const d = distanciaAjuste();
    const atual = controls.distance;
    // F24 (Victor 21:3x): zoom out farther (was 0.95 portrait / 1.12 landscape)
    controls.minDistance = Math.min(d * 0.42, atual);
    // F39: the max zoom-out frames the whole sun arc (radius RAIO_CEU around the building)
    const dArco = distanciaArco();
    controls.maxDistance = Math.max(d * (largura - desloc.x < altura - desloc.y ? 1.7 : 2.0), dArco, atual);
    acordar();
  }
  function modoLenteSol(ligar) {
    camera.fov = ligar ? FOV_SOL : FOV_NORMAL;
    controls.maxPolarAngle = ligar ? (largura < altura ? POL.maxSolRetrato : POL.maxSol) : POL.max;
    aplicarDesloc();
    aplicarLimites();
  }
  function recentrar(anim = true) {
    if (modoJanela) return;
    const t = new THREE.Vector3();
    controls.getTarget(t);
    if (t.distanceTo(alvoAtual) > 0.3) controls.moveTo(alvoAtual.x, alvoAtual.y, alvoAtual.z, anim);
  }
  const VISTAS = { inicio: { az: -0.78 * Math.PI, pol: POL.inicio } };
  function irVista(nome = 'inicio', anim = true) {
    const vv = VISTAS[nome] || VISTAS.inicio;
    estado.andar = null; estado.unidade = null;
    selAndar.visible = selUnid.visible = false;
    pintar();
    alvoAtual.copy(ALVO);
    controls.moveTo(ALVO.x, ALVO.y, ALVO.z, anim); // F34: the start view is the same with the sun on
    controls.rotateTo(vv.az, vv.pol, anim);
    // F39b: start view = as much of the sun arc as fits while the building keeps >= 15% of the free area (F19);
    // the whole arc is framed at max zoom-out
    const dA = distanciaAjuste();
    controls.dollyTo(Math.min(Math.max(dA * 0.92, distanciaArco() * 0.8), dA * (largura - desloc.x < altura - desloc.y ? 1.3 : 1.33)), anim);
    acordar();
  }
  function caixaDoAndar(a) { const yb = LAJES[a - 1]; return [X0 - 0.3, yb - 0.02, Z0 - 0.3, X1 + 0.3, yb + H - LAJE + 0.02, Z1 + 0.3]; }
  function focarAndar(a, anim = true, mover = true) {
    void a; void caixaDoAndar; // F37: no floor selection / highlight any more (kept as a no-op for old callers)
    // F19: the floor is highlighted only; the camera keeps orbiting the building centre
    void mover; void anim;
    recentrar(true);
    acordar();
  }
  function marcarUnidade(id) {
    const i = unidades.findIndex((u) => u.id === id);
    if (i < 0) { selUnid.visible = false; estado.unidade = null; pedirRender(); return; }
    const b = unidadeBox[i];
    selUnid.geometry.dispose();
    selUnid.geometry = caixaLinhas([b[0] - 0.12, b[1] - 0.12, b[2] - 0.12, b[3] + 0.12, b[4] + 0.12, b[5] + 0.12]);
    selUnid.visible = true;
    estado.unidade = id;
    alvoAtual.set(ALVO.x, (b[1] + b[4]) / 2, ALVO.z);
    controls.moveTo(alvoAtual.x, alvoAtual.y, alvoAtual.z, true);
    pulsoAte = performance.now() + SELECAO.pulsoSegundos * 1000; // F38: soft pulse for a few seconds, then solid
    pedirRender();
  }
  function setFiltro(fn) { estado.filtro = fn; pintar(); }
  function limparSelecao() { estado.andar = null; estado.unidade = null; selAndar.visible = selUnid.visible = false; alvoAtual.copy(ALVO); controls.moveTo(ALVO.x, ALVO.y, ALVO.z, true); pintar(); }

  // ---------- floor labels beside the silhouette
  const camadaRotulos = document.createElement('div');
  camadaRotulos.className = 'rotulos-3d';
  container.appendChild(camadaRotulos);
  const rotulos = [];
  for (let a = 1; a <= NIV.andares; a++) {
    const el = document.createElement('span'); // F37: plain, non-interactive floor number
    el.className = 'rotulo-andar'; el.textContent = `${a}º`; el.setAttribute('aria-hidden', 'true'); void onTocarAndar;
    camadaRotulos.appendChild(el);
    rotulos.push({ a, el, y: LAJES[a - 1] + H / 2 });
  }
  const cantos = [[X0, Z0], [X1, Z0], [X1, Z1], [X0, Z1]];
  const vp = new THREE.Vector3();
  function projetar(x, y, z) { vp.set(x, y, z).project(camera); return { x: (vp.x * 0.5 + 0.5) * largura, y: (-vp.y * 0.5 + 0.5) * altura, z: vp.z }; }
  function bordaEsq(y) {
    let minX = Infinity, yy = 0;
    cantos.forEach(([cx, cz]) => { const p = projetar(cx, y, cz); if (p.x < minX) { minX = p.x; yy = p.y; } });
    return { x: minX, y: yy };
  }
  function atualizarRotulos() {
    const passo = Math.abs(projetar(X0, LAJES[0], Z0).y - projetar(X0, LAJES[1], Z0).y);
    const mostrar = passo >= 9;
    const todos = passo >= 15;
    rotulos.forEach((r) => {
      const p = bordaEsq(r.y);
      const ok = mostrar && p.x > -40 && p.y > 0 && p.y < altura && (todos || r.a % 2 === 1 || r.a === estado.andar);
      r.el.hidden = !ok;
      if (!ok) return;
      const w = r.el.offsetWidth || 26;
      r.el.style.transform = `translate(${Math.round(Math.max(4, p.x - 8 - w))}px, ${Math.round(p.y)}px) translate(0, -50%)`;
      r.el.classList.toggle('ativo', r.a === estado.andar);
    });
  }

  // ---------- render on demand; F10: the loop never sleeps while there is input
  // F42: physical sky on top of the luz-curva gradient: blue day sky, warm around a low sun; it fades out toward the
  // horizon (where the gradient = the city's haze colour shows, so the far city melts into it) and at night (the
  // gradient's dark blue, the same curve the city grade uses). One box around the camera, drawn before everything.
  const ceuFisico = new Sky();
  ceuFisico.scale.setScalar(3000);
  ceuFisico.frustumCulled = false; ceuFisico.renderOrder = -100; ceuFisico.raycast = () => {};
  {
    const u = ceuFisico.material.uniforms;
    u.turbidity.value = 3.2; u.rayleigh.value = 1.4; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.78;
    if (u.cloudCoverage) u.cloudCoverage.value = 0;
    if (u.showSunDisc) u.showSunDisc.value = 0;
    u.uAlfa = { value: 0 }; u.uGanho = { value: 0.55 };
    ceuFisico.material.transparent = true; ceuFisico.material.fog = false;
    ceuFisico.material.onBeforeCompile = (sh) => {
      sh.uniforms.uAlfa = u.uAlfa; sh.uniforms.uGanho = u.uGanho;
      sh.fragmentShader = sh.fragmentShader
        .replace('uniform float showSunDisc;', 'uniform float showSunDisc; uniform float uAlfa; uniform float uGanho;')
        .replace('gl_FragColor = vec4( texColor, 1.0 );', 'gl_FragColor = vec4( texColor * uGanho, uAlfa * smoothstep( 0.0, 0.16, direction.y ) );');
    };
    ceuFisico.material.customProgramCacheKey = () => 'ceu-f42';
  }
  ceuFisico.visible = false;
  scene.add(ceuFisico);
  // B10 shadows with Google's city: our city becomes a shadow-only caster (layer 2) instead of being hidden
  let b7SoSombra = false;
  // shadow-only: three.js picks shadow casters with the MAIN camera's layers, so a separate layer cast nothing (07/10: only
  // our tower and the trees had shadows). Our city stays in the scene but writes no colour/depth: invisible, still casting.
  function objsB7() { const l = []; if (entB7.grupo) entB7.grupo.traverse((o) => { if (o.isMesh || o.isPoints || o.isLine) l.push(o); }); const a = entB7.arvores && entB7.arvores(); if (a) l.push(a); return l; }
  // 08/10 (Victor: floating roofs over Google): the far city / ring of our city arrive AFTER Google may already show; the
  // marking ran once, so those late meshes stayed on screen (dark walls, orthophoto roofs in the air). Re-run on any new mesh.
  let b7Marcados = 0;
  function sombraSoB7() {
    if (!entB7.grupo) return;
    const objs = objsB7();
    if (b7SoSombra && objs.length === b7Marcados) return;
    b7SoSombra = true; b7Marcados = objs.length; entB7.grupo.visible = true;
    for (const o of objs) { if (o.name === 'entorno-postes') continue; /* street-lamp glows stay on over Google (08/10) */ o.layers.set(0); for (const m of [].concat(o.material || [])) { if (m.userData.g3dCw === undefined) { m.userData.g3dCw = m.colorWrite; m.userData.g3dDw = m.depthWrite; }
      // our GROUND (tipo 1, orthophoto) stays visible a bit behind Google's ground: it fills the holes left by ghosted buildings
      if (m.uniforms && m.uniforms.uTipo && m.uniforms.uTipo.value === 1) { m.polygonOffset = true; m.polygonOffsetFactor = 2; m.polygonOffsetUnits = 16; if (m.uniforms.uSoChao) m.uniforms.uSoChao.value = 1; continue; } // ground only (no floating roofs)
      m.colorWrite = false; m.depthWrite = false; } }
    renderer.shadowMap.needsUpdate = true;
  }
  // our tower's box projected on screen: [[x0, y0, x1, y1] in drawing-buffer px (y up), nearest view depth]
  const caixaTorre = new THREE.Box3(), cantoT = new THREE.Vector3(), tamT = new THREE.Vector2();
  function caixaTorreNaTela() {
    if (caixaTorre.isEmpty()) caixaTorre.setFromObject(PB.grupo);
    renderer.getDrawingBufferSize(tamT); camera.updateMatrixWorld();
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, prof = 1e9;
    for (let i = 0; i < 8; i++) {
      cantoT.set(i & 1 ? caixaTorre.max.x : caixaTorre.min.x, i & 2 ? caixaTorre.max.y : caixaTorre.min.y, i & 4 ? caixaTorre.max.z : caixaTorre.min.z);
      const d = -cantoT.clone().applyMatrix4(camera.matrixWorldInverse).z; prof = Math.min(prof, d);
      if (d <= camera.near) return [null, 0]; // camera inside / behind the box: no ghosting
      cantoT.project(camera);
      const x = (cantoT.x * 0.5 + 0.5) * tamT.x, y = (cantoT.y * 0.5 + 0.5) * tamT.y;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return [[x0 - 2, y0 - 2, x1 + 2, y1 + 2], prof - 1.5];
  }
  // top-down map of our city's building footprints, rendered once from its meshes (attribute _centro = centre x, z,
  // radius): Google's fragments look up which building they belong to (google-vista.js g3dFantasma)
  let mapaPrediosFeito = false, terrenoFeito = false;
  const ALVO_FANT = new THREE.Vector3(CX, TOPO * 0.45, CZ); // same target as entorno.js atualizarCamera
  function montaMapaPredios() {
    try {
      const TAM = 1400, N = 1024, gl = renderer.getContext();
      const flutua = renderer.capabilities.isWebGL2 && gl.getExtension('EXT_color_buffer_float');
      const rt = new THREE.WebGLRenderTarget(N, N, { type: flutua ? THREE.FloatType : THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, depthBuffer: true });
      const mat = new THREE.ShaderMaterial({ side: THREE.DoubleSide,
        vertexShader: 'attribute vec4 _centro; varying vec3 vC; void main() { vC = _centro.xyz; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }',
        fragmentShader: 'varying vec3 vC; void main() { if (vC.x > 9000.0) discard; gl_FragColor = vec4(vC, 1.0); }' });
      const cena = new THREE.Scene(), pais = new Map();
      entB7.grupo.traverse((o) => { if (o.isMesh && !o.isInstancedMesh && o.geometry && o.geometry.attributes._centro) pais.set(o, o.parent); });
      const cam = new THREE.OrthographicCamera(-TAM / 2, TAM / 2, TAM / 2, -TAM / 2, 1, 3000);
      cam.position.set(CX, 1500, CZ); cam.up.set(0, 0, -1); cam.lookAt(CX, 0, CZ); cam.updateMatrixWorld(true);
      // each mesh drawn alone with the footprint material, at its world transform (it stays in its own parent)
      const ac = renderer.autoClear, rtAnt = renderer.getRenderTarget(), cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
      renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.autoClear = false;
      for (const o of pais.keys()) { const c = new THREE.Mesh(o.geometry, mat); o.updateWorldMatrix(true, false); c.matrixAutoUpdate = false; c.matrix.copy(o.matrixWorld); c.matrixWorld.copy(o.matrixWorld); cena.children.length = 0; cena.add(c); c.matrixWorld.copy(o.matrixWorld); renderer.render(cena, cam); }
      renderer.setRenderTarget(rtAnt); renderer.autoClear = ac; renderer.setClearColor(cc, ca);
      // texel (u, v): u along +x; cam.up = -z puts z max at the bottom row (v 0): the shader flips v
      gCena.mapaPredios(rt.texture, CX - TAM / 2, CZ - TAM / 2, TAM);
      stats.mapaPredios = pais.size;
    } catch (e) { console.warn('mapa de predios (fantasma do Google) falhou', e && e.message); }
  }
  function voltaB7() { // Google off (night / failure): our city back on screen
    b7SoSombra = false; b7Marcados = 0;
    for (const o of objsB7()) for (const m of [].concat(o.material || [])) if (m.userData.g3dCw !== undefined) { m.colorWrite = m.userData.g3dCw; m.depthWrite = m.userData.g3dDw; m.polygonOffset = false; if (m.uniforms && m.uniforms.uSoChao) m.uniforms.uSoChao.value = 0; }
    if (entB7.grupo) entB7.grupo.visible = !!entB7.carregado;
    chao.visible = rua.visible = !entB7.carregado;
    renderer.shadowMap.needsUpdate = true;
  }
  const matSombraG = new THREE.ShadowMaterial({ opacity: +((/[?&]sombraG=([\d.]+)/.exec(location.search) || [0, 0.42])[1]), depthWrite: false, transparent: true });
  matSombraG.depthFunc = THREE.LessEqualDepth; matSombraG.polygonOffset = true; matSombraG.polygonOffsetFactor = -1; matSombraG.polygonOffsetUnits = -1;
  function render() {
    if (ceuFisico.visible) ceuFisico.position.copy(camera.position);
    seguirCamera();
    entB7.atualizarCamera(camera); // B7: ghost neighbours between camera and tower
    // at night OUR city (dark, lit windows) instead of Google's day photos (Victor 07/10 20:49); Google pauses (no download)
    const noiteCidade = false; // Google stays on at night: its tiles get the night grade + lit windows (google-vista.js)
    if (gCena) { gCena.definirNoite(noiteCidade); gCena.antes(modoJanela || noiteCidade); }
    const usaGoogle = !!(gCena && gCena.mostrando && !noiteCidade);
    if (usaGoogle) { chao.visible = rua.visible = false; if (entorno) entorno.visible = false; if (entornoFantasma) entornoFantasma.visible = false; if (entB7.grupo) sombraSoB7(); }
    else if (b7SoSombra) voltaB7();
    if (usaGoogle) {
      // the sun's shadow camera sees our tower (1) and the B7/B9 city as shadow-only casters (2)
      if (!sol.shadow.camera.layers.isEnabled(2)) { sol.shadow.camera.layers.enable(1); sol.shadow.camera.layers.enable(2); renderer.shadowMap.needsUpdate = true; }
      // B10: our tower + units are drawn in a second pass over Google's city (depth cleared), so they always read in front of
      // Google's own mesh of the tower. Google's mesh is not clipped or hidden.
      if (!torreCamada) { torreCamada = true; PB.grupo.traverse((o) => o.layers.set(1)); selUnid.layers.set(1); meshNoite.layers.set(1); hemi.layers.enable(1); sol.layers.enable(1); ray.layers.enableAll(); } // unit night lights go with the tower pass (they vanished under it)
      // one pass with normal depth (Google's mesh of our building is clipped): our tower + Google's city, where Google's
      // buildings in front of the tower are ghosted (dropped inside the tower's screen box)
      if (!mapaPrediosFeito && entB7.carregado && entB7.grupo) { mapaPrediosFeito = true; montaMapaPredios(); }
      if (!terrenoFeito && entB7.grupo) entB7.grupo.traverse((o) => { const u = !terrenoFeito && o.material && o.material.uniforms; if (u && u.uRua && u.uRua.value && u.uRuaOn && u.uRuaOn.value > 0.5) { terrenoFeito = true; gCena.terreno(u.uRua.value, u.uRuaExt.value); } });
      gCena.fantasma(camera.position, ALVO_FANT);
      if (!matSombraG.__recorte) { matSombraG.__recorte = true; gCena.aplicarRecorte(matSombraG); }
      const fundo = scene.background, ac = renderer.autoClear;
      camera.layers.set(0); camera.layers.enable(1); renderer.render(scene, camera);
      scene.background = null; renderer.autoClear = false;
      // shadows of the chosen hour over Google's photo city (same depth buffer: only the visible tile surface is darkened)
      if (solEstado.modo === 'real' && sol.intensity > 0 && !/[?&]sombraG=0/.test(location.search)) {
        sol.layers.enable(3); scene.overrideMaterial = matSombraG; camera.layers.set(3); renderer.render(scene, camera); scene.overrideMaterial = null;
      }
      scene.background = fundo; renderer.autoClear = ac; camera.layers.enableAll();
    } else renderer.render(scene, camera);
    stats.quadros++;
    stats.calls = renderer.info.render.calls;
    stats.triangles = renderer.info.render.triangles;
    stats.geometries = renderer.info.memory.geometries;
    stats.textures = renderer.info.memory.textures;
    atualizarRotulos();
    if (!stats.pronto) { stats.pronto = true; canvas.setAttribute('data-ready', '1'); container.setAttribute('data-ready', '1'); }
  }
  let pulsoAte = 0;
  function loop() {
    const dt = clock.getDelta();
    if (selUnid.visible && performance.now() < pulsoAte) { matSel.opacity = 0.55 + 0.45 * (0.5 + 0.5 * Math.cos((pulsoAte - performance.now()) / 1000 * Math.PI * 1.25)); sujo = true; }
    else if (matSel.opacity !== 1) { matSel.opacity = 1; sujo = true; }
    const mudou = controls ? controls.update(dt) : false;
    if (mudou || sujo) { render(); sujo = false; ociosos = 0; } else { ociosos++; if (ociosos === 1) talvezReparticionar(); }
    rafId = (ociosos < 3 || ponteiroAbaixo || continuo || (selUnid.visible && performance.now() < pulsoAte)) ? requestAnimationFrame(loop) : 0;
  }
  function acordar() { ociosos = 0; if (!rafId) { clock.getDelta(); rafId = requestAnimationFrame(loop); } }
  function pedirRender() { sujo = true; acordar(); }
  // F10 root cause: camera-controls changes its internal target on wheel/pointer input but only moves the
  // camera inside update(); with render-on-demand the loop had stopped, and the events we listened to
  // ('wake', 'controlstart', 'update') are not all fired for wheel or for a drag that pauses, so the camera froze.
  ['wake', 'controlstart', 'control', 'controlend', 'transitionstart', 'update'].forEach((ev) => controls.addEventListener(ev, acordar));
  // any programmatic camera call (rotate, dolly, move...) must also wake the on-demand loop, or the camera
  // only moves on the next input event (same class of bug as F10)
  ['rotate', 'rotateTo', 'rotateAzimuthTo', 'rotatePolarTo', 'dolly', 'dollyTo', 'zoom', 'zoomTo', 'moveTo', 'setLookAt', 'fitToSphere', 'fitToBox', 'setPosition', 'setTarget', 'reset']
    .forEach((nome) => {
      const orig = controls[nome];
      if (typeof orig !== 'function') return;
      controls[nome] = function (...args) { const r = orig.apply(controls, args); acordar(); return r; };
    });
  controls.addEventListener('rest', () => { talvezReparticionar(); recentrar(true); });
  controls.addEventListener('controlend', () => recentrar(true));
  canvas.addEventListener('wheel', acordar, { passive: true });
  canvas.addEventListener('pointerdown', () => { ponteiroAbaixo++; acordar(); });
  canvas.addEventListener('pointermove', () => { if (ponteiroAbaixo) acordar(); });
  const soltouPonteiro = () => { if (ponteiroAbaixo) { ponteiroAbaixo = 0; acordar(); } canvas.classList.remove('arrastando'); };
  window.addEventListener('pointerup', soltouPonteiro);
  window.addEventListener('pointercancel', soltouPonteiro);
  window.addEventListener('blur', soltouPonteiro);

  const desloc = { x: 0, y: 0 };
  function aplicarDesloc() {
    const x = Math.min(desloc.x, largura * 0.6);
    let y = Math.min(desloc.y, altura * 0.6);
    // Victor 07/10 08:4x (phone): the tower sat too high and its top was cut under the header chips. In portrait the
    // top ~120 px are covered too: centre the target in the band between the chips and the bottom bar/sheet.
    let oy = y, ext = y;
    if (largura < altura) {
      const topo = 120, d = Math.min(y, altura * 0.6) - topo;
      ext = Math.abs(d); oy = d > 0 ? d : 0;
    }
    camera.aspect = (largura + x) / (altura + ext);
    if (x || ext) camera.setViewOffset(largura + x, altura + ext, x, oy, largura, altura); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }
  function redimensionar() {
    const r = container.getBoundingClientRect();
    largura = Math.max(1, Math.round(r.width));
    altura = Math.max(1, Math.round(r.height));
    renderer.setSize(largura, altura, false);
    canvas.style.width = largura + 'px';
    canvas.style.height = altura + 'px';
    aplicarDesloc();
    if (controls) aplicarLimites();
    const retrato = largura < altura;
    if (retrato !== ceuRetrato) {
      ceuRetrato = retrato;
      if (estacaoAtual && solEstado.ultimo) { desenharArco(estacaoAtual); dirDisco = direcao(solEstado.ultimo.az, ELEV_TELA(solEstado.ultimo.el)); }
    }
    pedirRender();
  }
  // panels over the stage: x = width covered on the right, y = height covered at the bottom (px)
  function setDeslocamento({ x = 0, y = 0 } = {}) {
    if (x === desloc.x && y === desloc.y) return;
    desloc.x = x; desloc.y = y;
    aplicarDesloc();
    aplicarLimites();
    pedirRender();
  }
  new ResizeObserver(redimensionar).observe(container);
  redimensionar();

  // ---------- picking
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function raioDe(x, y) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray;
  }
  function unidadeEm(x, y) {
    const hit = raioDe(x, y).intersectObject(meshUnid, false)[0];
    return hit && hit.instanceId != null ? (doInst.get(hit.instanceId) ?? -1) : -1;
  }
  const esferaDisco = new THREE.Sphere();
  function noDisco(x, y) {
    if (!disco.visible) return false;
    seguirCamera();
    esferaDisco.set(disco.position, RAIO_CEU * 0.09); // generous hit area for fingers
    return raioDe(x, y).ray.intersectsSphere(esferaDisco);
  }

  // F8: tap = that exact unit; double tap = enter the apartment
  let down = null, ultimoToque = { i: -1, t: 0 };
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const dt = performance.now() - down.t;
    down = null;
    if (moved > 8 || dt > 600) return;
    const i = unidadeEm(e.clientX, e.clientY);
    if (i < 0) return;
    const agora = performance.now();
    if (ultimoToque.i === i && agora - ultimoToque.t < 380 && onDuploToque) { ultimoToque = { i: -1, t: 0 }; onDuploToque(unidades[i]); return; }
    ultimoToque = { i, t: agora };
    if (onTocarUnidade) onTocarUnidade(unidades[i]);
  });

  // F12: hover (mouse only) -> cursor + highlight + label; throttled with rAF
  let hoverPendente = null, hoverRaf = 0, hoverAtual = -2;
  function mostrarHover(i) {
    if (i === hoverAtual) return;
    hoverAtual = i;
    if (i >= 0) {
      const b = unidadeBox[i];
      selHover.geometry.dispose();
      selHover.geometry = caixaLinhas([b[0] - 0.08, b[1] - 0.08, b[2] - 0.08, b[3] + 0.08, b[4] + 0.08, b[5] + 0.08]);
      brilho.matrix.copy(matrizBox(b[0] - 0.05, b[1] - 0.05, b[2] - 0.05, b[3] + 0.05, b[4] + 0.05, b[5] + 0.05));
      brilho.matrix.decompose(brilho.position, brilho.quaternion, brilho.scale);
      selHover.visible = brilho.visible = true;
    } else selHover.visible = brilho.visible = false;
    pedirRender();
  }
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || arrasto) return;
    hoverPendente = { x: e.clientX, y: e.clientY, botao: e.buttons };
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const h = hoverPendente;
      if (!h) return;
      if (h.botao) { canvas.style.cursor = 'grabbing'; mostrarHover(-1); onHover && onHover(null); return; }
      if (noDisco(h.x, h.y)) {
        canvas.style.cursor = 'grab'; mostrarHover(-1);
        onHover && onHover({ tipo: 'sol', x: h.x, y: h.y });
        return;
      }
      const i = unidadeEm(h.x, h.y);
      canvas.style.cursor = i >= 0 ? 'pointer' : 'grab';
      mostrarHover(i);
      onHover && onHover(i >= 0 ? { tipo: 'unidade', u: unidades[i], x: h.x, y: h.y } : null);
    });
  });
  canvas.addEventListener('pointerleave', () => { hoverPendente = null; mostrarHover(-1); onHover && onHover(null); if (!arrasto) canvas.style.cursor = 'grab'; });
  canvas.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') canvas.style.cursor = 'grabbing'; mostrarHover(-1); onHover && onHover(null); });
  canvas.style.cursor = 'grab';

  // ---------- context loss
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stats.contextoPerdido = (stats.contextoPerdido || 0) + 1; if (!/[?&]teste=1/.test(location.search) && rebaixar()) setTimeout(() => location.reload(), 300); }); // out of GPU memory: one level down for this device
  canvas.addEventListener('webglcontextrestored', () => { stats.contextoRestaurado = (stats.contextoRestaurado || 0) + 1; renderer.shadowMap.needsUpdate = true; pedirRender(); });

  // ---------- sun (data from B3). F3: direction from sol.json az/el with the building north;
  // y is up; the arc is centred on the building base, radius 3x the height, drawn only above the horizon.
  let eixoX = 73.4; // bearing of +x (degrees), from sol.json meta
  function direcao(az, el, out = new THREE.Vector3()) {
    const r = THREE.MathUtils.degToRad;
    const h = Math.cos(r(el));
    // bearing b -> scene: +x has bearing eixoX, +z has bearing eixoX + 90 (clockwise from north)
    return out.set(h * Math.cos(r(az - eixoX)), Math.sin(r(el)), h * Math.cos(r(az - eixoX - 90)));
  }
  const matArco = new THREE.LineBasicMaterial({ color: 0xf0b24a, transparent: true, opacity: 0.9, toneMapped: false });
  const arco = new THREE.Line(new THREE.BufferGeometry(), matArco);
  arco.visible = false; arco.raycast = () => {};
  const disco = new THREE.Mesh(new THREE.SphereGeometry(RAIO_CEU * 0.022, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffcf5c, toneMapped: false, fog: false }));
  const halo = new THREE.Mesh(new THREE.SphereGeometry(RAIO_CEU * 0.042, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffcf5c, transparent: true, opacity: 0.25, depthWrite: false, toneMapped: false, fog: false }));
  disco.add(halo);
  // depth test ON: neighbours and the tower hide the sun/arc when it is behind them (sky layer)
  arco.renderOrder = 1; disco.renderOrder = 2; halo.renderOrder = 2;
  arco.frustumCulled = false; disco.frustumCulled = false;
  let dirDisco = null; // display direction of the sun on the dome (unit vector)
  // F39: faint copy of the arc drawn without depth test (visible behind buildings) + hour ticks
  const matArcoFantasma = new THREE.LineBasicMaterial({ color: 0xf0b24a, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
  const arcoFantasma = new THREE.Line(new THREE.BufferGeometry(), matArcoFantasma);
  arcoFantasma.renderOrder = 3; arcoFantasma.frustumCulled = false; arcoFantasma.raycast = () => {};
  const matMarcas = new THREE.PointsMaterial({ color: 0xf0b24a, size: 6, sizeAttenuation: false, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
  const marcasHora = new THREE.Points(new THREE.BufferGeometry(), matMarcas);
  marcasHora.renderOrder = 4; marcasHora.frustumCulled = false; marcasHora.raycast = () => {};
  arco.add(arcoFantasma, marcasHora);
  const rotulosHora = [];
  function rotuloHora(txt) {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64;
    const g = cv.getContext('2d');
    g.font = '700 42px Archivo, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 8; g.strokeStyle = 'rgba(16,18,17,.8)'; g.strokeText(txt, 64, 33);
    g.fillStyle = '#f4c45a'; g.fillText(txt, 64, 33);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false, toneMapped: false, fog: false }));
    const e = largura < altura ? 0.11 : 0.06; // F39b: legible on phones (portrait needs a larger share of the height)
    sp.scale.set(e, e / 2, 1); sp.renderOrder = 5; sp.raycast = () => {};
    return sp;
  }
  const vTmpCeu = new THREE.Vector3();
  let topoArco = null;
  function seguirCamera() {
    if (!arco.visible) return;
    arco.position.copy(CENTRO); // F39: finite arc centred on the building
    if (dirDisco) disco.position.copy(CENTRO).addScaledVector(dirDisco, RAIO_CEU);
    return;
    // eslint-disable-next-line no-unreachable
    // pitch of the view + half the vertical lens = elevation of the top edge of the frame
    const pitch = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(camera.getWorldDirection(vTmpCeu).y, -1, 1)));
    topoCeuVisivel = pitch + camera.fov / 2;
    if (topoArco == null || Math.abs(topoCeuVisivel - topoArco) > 0.3) {
      topoArco = topoCeuVisivel;
      if (estacaoAtual) desenharArcoSo(estacaoAtual);
      if (solEstado.ultimo) dirDisco = direcao(solEstado.ultimo.az, ELEV_TELA(solEstado.ultimo.el));
    }
    arco.position.copy(camera.position);
    if (dirDisco) disco.position.copy(camera.position).addScaledVector(dirDisco, RAIO_CEU);
  }
  disco.visible = false; disco.raycast = () => {}; halo.raycast = () => {};
  matArco.fog = false;
  scene.add(arco, disco);
  let arcoPts = []; // [{ t (minutes), d (unit display direction), get p() world point on the dome }]
  let entorno = null, entornoFantasma = null;
  const matEntorno = new THREE.MeshStandardMaterial({ color: tema.vizinho, roughness: 1, metalness: 0 });
  // neighbours between the camera and our building are ghosted (still cast shadows), so they never hide it
  const matFantasma = new THREE.MeshStandardMaterial({ color: tema.vizinho, roughness: 1, metalness: 0, transparent: true, opacity: 0.16, depthWrite: false });
  let blocosGeo = []; // [{ c: Vector2 centroid, r: radius, h, pos: [], nor: [] }]
  function montarEntorno(camPos) {
    const B = new THREE.Vector2(CX, CZ);
    const C = new THREE.Vector2(camPos.x, camPos.z);
    const dir = C.clone().sub(B); const L = dir.length() || 1; dir.divideScalar(L);
    const op = { pos: [], nor: [] }, fa = { pos: [], nor: [] };
    let nf = 0;
    blocosGeo.forEach((b) => {
      const v = b.c.clone().sub(B);
      const s2 = v.dot(dir);
      const perp = Math.abs(v.x * dir.y - v.y * dir.x);
      const naFrente = s2 > 0 && s2 < L && perp < 20 + b.r && b.h > 12;
      const alvo = naFrente ? fa : op;
      if (naFrente) nf++;
      for (let i = 0; i < b.pos.length; i++) alvo.pos.push(b.pos[i]);
      for (let i = 0; i < b.nor.length; i++) alvo.nor.push(b.nor[i]);
    });
    const geo = (o) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(o.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(o.nor, 3)); return g; };
    entorno.geometry.dispose(); entorno.geometry = geo(op);
    entornoFantasma.geometry.dispose(); entornoFantasma.geometry = geo(fa);
    stats.vizinhosFantasma = nf;
    renderer.shadowMap.needsUpdate = true;
    pedirRender();
  }
  function criarEntorno(blocosViz) {
    if (entB7.carregado) return; // B7: real surroundings replace the grey blocks
    if (DRONE) return; // F36: B7 on -> never the old blocks, not even while it loads (the light ground is the placeholder)
    if (entorno || !blocosViz?.length) return;
    let pos2 = [], nor = [];
    const push = (a, b, c, n) => { pos2.push(...a, ...b, ...c); nor.push(...n, ...n, ...n); };
    const RAIO_VIZ = 220; // F1: neighbours only around the building
    blocosViz.forEach((bl) => {
      pos2 = []; nor = [];
      const pts = bl.xz.map(([x, z]) => new THREE.Vector2(x, z));
      if (pts.length > 2 && pts[0].equals(pts[pts.length - 1])) pts.pop();
      if (pts.length < 3) return;
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cz = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      if (Math.hypot(cx - CX, cz - CZ) > RAIO_VIZ) return;
      if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
      const h = Math.max(2, bl.h);
      for (let i = 0; i < pts.length; i++) {
        const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
        const n = new THREE.Vector3(p1.y - p0.y, 0, -(p1.x - p0.x)).normalize().toArray();
        const a0 = [p0.x, 0, p0.y], a1 = [p1.x, 0, p1.y], b0 = [p0.x, h, p0.y], b1 = [p1.x, h, p1.y];
        push(a0, a1, b1, n); push(a0, b1, b0, n);
      }
      THREE.ShapeUtils.triangulateShape(pts, []).forEach(([i, j, k]) => push([pts[i].x, h, pts[i].y], [pts[k].x, h, pts[k].y], [pts[j].x, h, pts[j].y], [0, 1, 0]));
      const r = Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.y - cz)));
      blocosGeo.push({ c: new THREE.Vector2(cx, cz), r, h, pos: pos2, nor });
    });
    matEntorno.side = matFantasma.side = THREE.DoubleSide;
    entorno = new THREE.Mesh(new THREE.BufferGeometry(), matEntorno);
    entornoFantasma = new THREE.Mesh(new THREE.BufferGeometry(), matFantasma);
    entorno.castShadow = entorno.receiveShadow = true;
    entornoFantasma.castShadow = true;
    entorno.raycast = entornoFantasma.raycast = () => {};
    scene.add(entorno, entornoFantasma);
    stats.entornoTriangulos = blocosGeo.reduce((s3, b) => s3 + b.pos.length / 9, 0);
    stats.entornoBlocos = blocosGeo.length;
    montarEntorno(camera.position);
  }
  // re-split when the camera stops (cheap: ~100 blocks)
  let ultimoSplit = new THREE.Vector3(1e9, 0, 0);
  function talvezReparticionar() {
    if (!entorno) return;
    if (camera.position.distanceTo(ultimoSplit) < 6) return;
    ultimoSplit.copy(camera.position);
    montarEntorno(camera.position);
  }
  const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  // estacaoAtual declared at the top (used by redimensionar before this point)
  function desenharArco(estacao) { estacaoAtual = estacao; desenharArcoSo(estacao); }
  function desenharArcoSo(estacao) {
    const passo = solEstado.SOL?.meta?.passo_min || 15;
    const ini = hm(estacao.inicio);
    arcoPts = [];
    estacao.az.forEach((az, k) => {
      const el = estacao.el[k];
      if (el >= 0) {
        const d = direcao(az, ELEV_TELA(el));
        arcoPts.push({ t: ini + k * passo, d, p: CENTRO.clone().addScaledVector(d, RAIO_CEU) });
      }
    });
    arco.geometry.dispose();
    arco.geometry = new THREE.BufferGeometry().setFromPoints(arcoPts.map((x) => x.d.clone().multiplyScalar(RAIO_CEU)));
    arcoFantasma.geometry = arco.geometry; // same line, drawn faint over buildings
    // hour ticks (full hours above the horizon)
    const hs = arcoPts.filter((x) => Math.abs(x.t % 60) < 1e-6).map((x) => x.d.clone().multiplyScalar(RAIO_CEU));
    marcasHora.geometry.dispose();
    marcasHora.geometry = new THREE.BufferGeometry().setFromPoints(hs);
    // F39b: hour numbers on a few ticks
    rotulosHora.forEach((r) => { arco.remove(r); r.material.map.dispose(); r.material.dispose(); });
    rotulosHora.length = 0;
    const cheias = arcoPts.filter((x) => Math.abs(x.t % 60) < 1e-6);
    if (cheias.length) {
      const quer = new Set([6, 12, 18, cheias[0].t / 60, cheias[cheias.length - 1].t / 60]);
      cheias.filter((x) => quer.has(x.t / 60)).forEach((x) => {
        const sp = rotuloHora(`${x.t / 60}h`);
        sp.position.copy(x.d).multiplyScalar(RAIO_CEU * 1.06);
        arco.add(sp); rotulosHora.push(sp);
      });
    }
  }
  // camera for the sun: looking toward the noon sun, so the arc rises over the building
  function enquadrarSol(anim = true, { agora = false } = {}) {
    if (!estacaoAtual || !arcoPts.length) return;
    const elMax = Math.max(...estacaoAtual.el);
    const k = estacaoAtual.el.indexOf(elMax);
    // facing the sun of the chosen time, beside the tower (so it is never framed behind it); at night: the noon sun
    void agora;
    const comSol = solEstado.ultimo && solEstado.ultimo.el > 0;
    const azSol = comSol ? solEstado.ultimo.az : estacaoAtual.az[k];
    // offset so the sun sits beside the tower, inside the frame (narrower on portrait screens)
    const meiaH = THREE.MathUtils.radToDeg(Math.atan(Math.tan(THREE.MathUtils.degToRad(FOV_SOL / 2)) * (largura - desloc.x) / (altura + desloc.y)));
    const desvio = Math.min(28, meiaH * (largura < altura ? 0.55 : 0.8));
    const dCam = direcao(azSol + 180 + desvio, 0);
    controls.moveTo(ALVO.x, ALVO.y, ALVO.z, anim);
    // camera slightly below the building centre, looking a little up: the sky (and the sun arc) above the roof
    controls.rotateTo(Math.atan2(dCam.x, dCam.z), largura < altura ? POL.solRetrato : POL.sol, anim);
    controls.dollyTo(distanciaAjuste() * 1.0, anim);
    acordar();
  }
  const cTemp = new THREE.Color();
  let sombraUlt = null;
  function setSol(i, { estacao = null, movendo = false, enquadrar = false } = {}) {
    if (estacao) desenharArco(estacao);
    const primeiro = !solEstado.ativo;
    solEstado.ativo = true;
    arco.visible = true;
    if (primeiro) controls.maxPolarAngle = POL.max; // F33: nothing about the camera changes when the sun switches on
    scene.fog.near = 900; scene.fog.far = 3200;
    const luzesAntes = solEstado.luzes || 0;
    solEstado.noite = i.noite;
    solEstado.luzes = i.luzes ?? (i.noite > 0.5 ? 1 : 0);
    const dia = 1 - i.noite;
    if (i.dia && i.el > -2) {
      const d = direcao(i.az, Math.max(i.el, 0.5));
      sol.position.copy(CENTRO).addScaledVector(d, 420); // same direction as the arc/disc; F40: far enough for the 250 m shadow box
      sol.target.position.copy(CENTRO);
      dirDisco = direcao(i.az, ELEV_TELA(i.el));
      disco.visible = i.el >= 0;
      seguirCamera();
    } else disco.visible = false;
    solEstado.ultimo = { az: i.az, el: i.el, t: i.t };
    // F42: the physical sky follows the same sun; full by day, gone by night (the gradient takes over)
    ceuFisico.visible = true;
    ceuFisico.material.uniforms.sunPosition.value.copy(direcao(i.az, i.el));
    ceuFisico.material.uniforms.uAlfa.value = smooth(-8, 6, i.el);
    entB7.atualizarSol({ el: i.el, t: i.t, az: i.az, est: i.est }); // B7
    if (gCena) gCena.definirSol(i.el); // B10
    // F23: direct sun ramps from 0 at the horizon (airmass), warm when low
    sol.intensity = LUZ.sol * 1.1 * forcaSolDireto(i.el);
    sol.color.set(0xfff4e6).lerp(cTemp.set('#ff9f55'), calorSol(i.el));
    // F30: castShadow stays constant (toggling it recompiles every material: the night<->day hitch); the sun just
    // goes to intensity 0 at night
    sol.castShadow = solEstado.modo === 'real';
    let flags = null;
    if (solEstado.SOL && i.dia) {
      flags = new Int8Array(unidades.length).fill(-1);
      unidades.forEach((u, k) => {
        const cv = solEstado.SOL.unidades[u.numero]?.est?.[i.est]?.cv;
        if (cv && i.idx >= 0 && i.idx < cv.length) flags[k] = cv[i.idx] === '1' ? 1 : 0;
      });
    }
    solEstado.ref = flags;
    const flagsAntes = solEstado.flags;
    solEstado.flags = solEstado.modo === 'pre' ? flags : null;
    const mudouFlags = solEstado.modo === 'pre' && String(flagsAntes) !== String(solEstado.flags);
    // F19: night stays readable: moonlight fill (bluish hemisphere) instead of near-black
    scene.environmentIntensity = 0.3 + (LUZ.env - 0.3) * dia;
    hemi.intensity = 0.5 + (LUZ.hemi - 0.5) * dia;
    hemi.color.set(0xffffff).lerp(cTemp.set('#9fb4e0'), i.noite);
    hemi.groundColor.set(0xb7ad9e).lerp(cTemp.set('#3a4458'), i.noite);
    // F40: less sky/ambient fill while the sun is up, so the tower's shadows are crisp and dark like the reference
    const fill = 1 - 0.35 * forcaSolDireto(i.el);
    scene.environmentIntensity *= fill; hemi.intensity *= fill;
    // E2: the tower follows the same twilight grade as the city photos (otherwise it glows at dawn); a floor keeps it
    // readable at night (its lit windows are separate)
    if (gradeFn) {
      const g = gradeFn(i.el), kt = 0.15 + 0.85 * g.k;
      scene.environmentIntensity *= kt; hemi.intensity *= kt;
      if (g.k > 1e-3) hemi.color.multiply(cTemp.setRGB(g.base[0] / g.k, g.base[1] / g.k, g.base[2] / g.k));
    }
    const ceu = corCeu(i.el);
    pintarCeu(ceu.topo, ceu.horizonte);
    scene.background = ceuTex;
    scene.fog.color.set(ceu.horizonte);
    matChao.color.copy(tema.chao).lerp(cTemp.set('#2a3448'), i.noite);
    matRua.color.copy(tema.rua).lerp(cTemp.set('#121418'), i.noite); // F24: dark asphalt at night, never yellow
    matCalcada.color.copy(CALCADA).lerp(cTemp.set('#2a2c31'), i.noite);
    matEntorno.color.copy(tema.vizinho).lerp(cTemp.set('#3a465c'), i.noite);
    matLinha.color.copy(tema.linha).lerp(cTemp.set('#b9c9dd'), i.noite);
    matLinha.opacity = 0.32 + 0.4 * i.noite;
    matArco.color.set(0xf0b24a).lerp(cTemp.set('#5d6f8c'), i.noite);
    matArcoFantasma.color.copy(matArco.color); matMarcas.color.copy(matArco.color);
    // F30: one shadow-map size (re-allocating it at drag start/end popped and stalled); while dragging, re-render the
    // shadow map only when the sun moved > 0.5 deg; full update on release
    if (sol.shadow.mapSize.x !== MAPA) { sol.shadow.mapSize.set(MAPA, MAPA); if (sol.shadow.map) { sol.shadow.map.dispose(); sol.shadow.map = null; } }
    const dSol = sombraUlt ? Math.hypot(i.az - sombraUlt.az, i.el - sombraUlt.el) : 99;
    if (!movendo || dSol > 0.5) { renderer.shadowMap.needsUpdate = true; sombraUlt = { az: i.az, el: i.el }; }
    if (enquadrar) enquadrarSol(true); // F33: only on an explicit request
    if (mudouFlags || (luzesAntes > 0.01) !== (solEstado.luzes > 0.01)) pintar();
    else { matUnidNoite.opacity = solEstado.luzes; if (meshListras) meshListras.material.opacity = (estado.andar != null ? 0.6 : 1) * (1 - solEstado.luzes); pedirRender(); }
  }
  function desligarSol() {
    entB7.atualizarSol({ el: 35, t: 720 }); // B7
    solEstado.ativo = false; solEstado.noite = 0; solEstado.luzes = 0; solEstado.flags = null; sol.color.set(0xfff4e6);
    arco.visible = disco.visible = false;
    scene.fog.near = 500; scene.fog.far = 1500;
    sol.position.set(-45, 70, -50); sol.target.position.copy(CENTRO);
    sol.intensity = LUZ.sol; sol.castShadow = true;
    scene.environmentIntensity = LUZ.env; hemi.intensity = LUZ.hemi; hemi.color.set(0xffffff); hemi.groundColor.set(0xb7ad9e);
    scene.background = ceuDia; scene.fog.color.copy(tema.fundo);
    matChao.color.copy(tema.chao); matRua.color.copy(tema.rua); matCalcada.color.copy(CALCADA); matEntorno.color.copy(tema.vizinho);
    matLinha.color.copy(tema.linha); matLinha.opacity = 0.32;
    if (sol.shadow.mapSize.x !== MAPA) { sol.shadow.mapSize.set(MAPA, MAPA); if (sol.shadow.map) { sol.shadow.map.dispose(); sol.shadow.map = null; } }
    renderer.shadowMap.needsUpdate = true;
    pintar();
    irVista('inicio');
  }
  function iniciarSol(SOL, VIZ, { modo = 'real' } = {}) {
    eixoX = SOL?.meta?.orientacao?.eixo_x_predio_bearing_graus ?? eixoX;
    solEstado.SOL = SOL;
    solEstado.modo = modo;
    criarEntorno(VIZ?.blocos);
    sc.left = sc.bottom = -250; sc.right = sc.top = 250; sc.near = 20; sc.far = 900; // F40: tower + neighbours shadows on the city, ~250 m around
    sc.updateProjectionMatrix();
    renderer.shadowMap.needsUpdate = true;
    // F30: pre-compile every program the day<->night sweep can need (night windows, sun disc/arc), so crossing the
    // sunrise/sunset tick never compiles a shader mid-drag
    const objs = [meshNoite, arco, disco, halo], vis = objs.map((o) => o.visible);
    objs.forEach((o) => { o.visible = true; });
    sol.castShadow = modo === 'real';
    try { renderer.compile(scene, camera); } catch (e) { /* compile is an optimisation only */ }
    objs.forEach((o, k) => { o.visible = vis[k]; });
  }

  // ---------- F5: drag the sun disc along the arc (capture on the container, so the orbit never starts)
  let arrasto = null;
  function tempoNaTela(x, y) {
    const r = canvas.getBoundingClientRect();
    let melhor = null;
    for (let k = 0; k < arcoPts.length - 1; k++) {
      const a = projetar(arcoPts[k].p.x, arcoPts[k].p.y, arcoPts[k].p.z);
      const b = projetar(arcoPts[k + 1].p.x, arcoPts[k + 1].p.y, arcoPts[k + 1].p.z);
      const px = x - r.left, py = y - r.top;
      const vx = b.x - a.x, vy = b.y - a.y;
      const L = vx * vx + vy * vy || 1;
      const s = Math.max(0, Math.min(1, ((px - a.x) * vx + (py - a.y) * vy) / L));
      const d = Math.hypot(a.x + vx * s - px, a.y + vy * s - py);
      if (!melhor || d < melhor.d) melhor = { d, t: arcoPts[k].t + (arcoPts[k + 1].t - arcoPts[k].t) * s };
    }
    return melhor ? melhor.t : null;
  }
  container.addEventListener('pointerdown', (e) => {
    if (!solEstado.ativo || !noDisco(e.clientX, e.clientY)) return;
    e.stopPropagation(); e.preventDefault();
    arrasto = { id: e.pointerId };
    continuo = true;
    canvas.style.cursor = 'grabbing';
    onArrastarSol && onArrastarSol(null, 'inicio');
    acordar();
  }, { capture: true });
  window.addEventListener('pointermove', (e) => {
    if (!arrasto || e.pointerId !== arrasto.id) return;
    const t = tempoNaTela(e.clientX, e.clientY);
    if (t != null && onArrastarSol) onArrastarSol(t, 'movendo');
    onHover && onHover({ tipo: 'sol', x: e.clientX, y: e.clientY });
  });
  const fimArrasto = (e) => {
    if (!arrasto || (e && e.pointerId != null && e.pointerId !== arrasto.id)) return;
    arrasto = null; continuo = false;
    canvas.style.cursor = 'grab';
    onHover && onHover(null);
    onArrastarSol && onArrastarSol(null, 'fim');
    acordar();
  };
  window.addEventListener('pointerup', fimArrasto);
  window.addEventListener('pointercancel', fimArrasto);
  window.addEventListener('blur', () => fimArrasto());

  // ---------- F18: camera to the unit's window and back (symmetric)
  let poseSalva = null;
  function irParaJanela(id) {
    const u = PB.unidades.get(id);
    if (!u) return Promise.resolve();
    const p = new THREE.Vector3(), t = new THREE.Vector3();
    controls.getPosition(p); controls.getTarget(t);
    poseSalva = { p, t };
    modoJanela = true;
    controls.setBoundary();
    controls.minDistance = 1;
    const alvo = u.centro.clone().add(new THREE.Vector3(0, 1.2, 0));
    const pos = alvo.clone().addScaledVector(u.normal, 6.5).add(new THREE.Vector3(0, 0.6, 0));
    const st = controls.smoothTime;
    controls.smoothTime = 0.22;
    controls.setLookAt(pos.x, pos.y, pos.z, alvo.x, alvo.y, alvo.z, true);
    acordar();
    return new Promise((res) => setTimeout(() => { controls.smoothTime = st; res(); }, 800));
  }
  function voltarDaJanela() {
    if (!poseSalva) return;
    const { p, t } = poseSalva;
    poseSalva = null;
    controls.setLookAt(p.x, p.y, p.z, ALVO.x, ALVO.y, ALVO.z, true);
    acordar();
    setTimeout(() => { modoJanela = false; controls.setBoundary(limiteAlvo); aplicarLimites(); recentrar(true); }, 900);
  }

  irVista('inicio', false);
  controls.update(0);
  render();

  // ---------- test helpers (screen points, sun geometry)
  function pontoDaUnidade(id) {
    const i = unidades.findIndex((u) => u.id === id);
    if (i < 0) return null;
    const b = unidadeBox[i];
    const c = new THREE.Vector3((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
    const faces = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].map((n) => new THREE.Vector3(...n));
    const paraCam = camera.position.clone().sub(c).normalize();
    const n = faces.reduce((m, f) => (f.dot(paraCam) > m.dot(paraCam) ? f : m));
    const half = new THREE.Vector3((b[3] - b[0]) / 2, 0, (b[5] - b[2]) / 2);
    const p = c.clone().add(new THREE.Vector3(n.x * (half.x + 0.02), 0, n.z * (half.z + 0.02)));
    const s = projetar(p.x, p.y, p.z);
    const r = canvas.getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y, alvo: unidadeEm(r.left + s.x, r.top + s.y) >= 0 ? unidades[unidadeEm(r.left + s.x, r.top + s.y)].id : null };
  }
  function pontoDoSol() { if (!disco.visible) return null; const s = projetar(disco.position.x, disco.position.y, disco.position.z); const r = canvas.getBoundingClientRect(); return { x: r.left + s.x, y: r.top + s.y }; }
  function pontoDoArco(t) {
    if (!arcoPts.length) return null;
    const k = arcoPts.reduce((m, x, j) => (Math.abs(x.t - t) < Math.abs(arcoPts[m].t - t) ? j : m), 0);
    const p = arcoPts[k].p; const s = projetar(p.x, p.y, p.z); const r = canvas.getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y, t: arcoPts[k].t };
  }
  function luminanciaMedia() {
    render();
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let soma = 0, n = 0;
    for (let k = 0; k < px.length; k += 4 * 37) { soma += 0.2126 * px[k] + 0.7152 * px[k + 1] + 0.0722 * px[k + 2]; n++; }
    return soma / n / 255;
  }
  function medirEnquadramento() {
    const r = canvas.getBoundingClientRect();
    const cs = [];
    for (const x of [BX0, BX1]) for (const y of [0, TOPO]) for (const z of [BZ0, BZ1]) cs.push(projetar(x, y, z));
    const xs = cs.map((p) => p.x), ys = cs.map((p) => p.y);
    const livreW = largura - desloc.x, livreH = altura - desloc.y;
    const bx0 = Math.max(0, Math.min(...xs)), bx1 = Math.min(livreW, Math.max(...xs));
    const by0 = Math.max(0, Math.min(...ys)), by1 = Math.min(livreH, Math.max(...ys));
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const t = new THREE.Vector3(); controls.getTarget(t);
    // centre of the VISIBLE part of the building box (what the client sees); the raw box centre is kept too
    return { cxRel: +(((bx0 + bx1) / 2) / livreW).toFixed(3), cyRel: +(((by0 + by1) / 2) / livreH).toFixed(3),
      cxBruto: +(cx / livreW).toFixed(3), cyBruto: +(cy / livreH).toFixed(3),
      areaRel: +((Math.max(0, bx1 - bx0) * Math.max(0, by1 - by0)) / (livreW * livreH)).toFixed(3),
      wRel: +(Math.max(0, bx1 - bx0) / livreW).toFixed(3), hRel: +(Math.max(0, by1 - by0) / livreH).toFixed(3), // tower box as % of the free screen
      alvoDist: +t.distanceTo(ALVO).toFixed(2), dist: +controls.distance.toFixed(1), azimute: +THREE.MathUtils.radToDeg(controls.azimuthAngle).toFixed(1),
      livre: [livreW, livreH], canvas: [r.width, r.height] };
  }
  function solDebug() {
    const topo = projetar(CX, TOPO, CZ);
    const ds = disco.visible ? projetar(disco.position.x, disco.position.y, disco.position.z) : null;
    const norte = direcao(0, 0);
    seguirCamera();
    return { ...solEstado.ultimo, ceu: true, elevTela: solEstado.ultimo ? +ELEV_TELA(solEstado.ultimo.el).toFixed(1) : null, discoNaTela: ds ? [Math.round(ds.x), Math.round(ds.y)] : null,
      discoAltura_m: +disco.position.y.toFixed(1), topoPredio_m: +TOPO.toFixed(1), raioArco_m: +RAIO_ARCO.toFixed(1),
      discoAcimaDoTopoNaTela: ds ? ds.y < topo.y : null, arcoPontos: arcoPts.length, arcoMinY_m: arcoPts.length ? +Math.min(...arcoPts.map((x) => x.p.y)).toFixed(1) : null,
      norteNaCena: [+norte.x.toFixed(3), +norte.z.toFixed(3)], luzMesmaDirecao: disco.visible ? +sol.position.clone().sub(CENTRO).normalize().dot(disco.position.clone().sub(CENTRO).normalize()).toFixed(4) : null };
  }

  return {
    renderer, stats, controls, camera, irVista, focarAndar, marcarUnidade, setFiltro, pedirRender, limparSelecao,
    iniciarSol, setSol, desligarSol, enquadrarSol, emNoite: () => solEstado.noite > 0.5,
    solRef: () => ({ modo: solEstado.modo, ref: solEstado.ref ? Array.from(solEstado.ref) : null }),
    pontoDaUnidade, pontoDoSol, pontoDoArco, solDebug, setDeslocamento, irParaJanela, voltarDaJanela, medirEnquadramento, luminanciaMedia,
    // B10: start/stop downloading the Google city seen from inside a unit (card open -> 360 window ready sooner)
    preCarregarJanela: (u) => { preJanela = u; if (gCena) gCena.preCarregar(u); }, pararPreCarga: () => { preJanela = null; if (gCena) gCena.pararPreCarga(); }, // a card opened before Google is up is prefetched when it comes up (08/10)
    // test helper: top-down view over the tower; contorno = red outline of the B5 tower footprint, semPredio hides it
    vistaDeCima({ altura: h = 320, contorno = true, semPredio = false, raio = 0 } = {}) {
      controls.minPolarAngle = 0; controls.maxDistance = 1e4; controls.minDistance = 1;
      controls.setLookAt(ALVO.x, h, ALVO.z + 0.001, ALVO.x, 0, ALVO.z, false);
      if (raio) { camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(raio / h)); aplicarDesloc(); }
      PB.grupo.visible = !semPredio;
      const base = scene.getObjectByName('entorno-base-torre'); if (base) base.visible = !semPredio;
      if (meshListras && semPredio) meshListras.visible = false;
      if (meshNoite) meshNoite.visible = !semPredio && meshNoite.visible;
      if (contorno) {
        const b = new THREE.Box3().setFromObject(PB.grupo);
        const pts = [[b.min.x, b.min.z], [b.max.x, b.min.z], [b.max.x, b.max.z], [b.min.x, b.max.z], [b.min.x, b.min.z]].map(([x, z]) => new THREE.Vector3(x, TOPO + 1, z));
        const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xff2020, depthTest: false, toneMapped: false }));
        l.renderOrder = 50; scene.add(l);
      }
      acordar(); pedirRender();
      return { alvo: [ALVO.x, ALVO.z], caixa: new THREE.Box3().setFromObject(PB.grupo) };
    },
    b7Estado: () => ({ entornoFora: DRONE, entornoCarregado: !!entB7.carregado, fachada: b7.fachada }),
    // F45 test hook: is the facade really bound on the units mesh, and how many units carry each state colour
    malhasInfo: () => PB.grupo.children.filter((m) => m.isMesh).map((m) => ({ n: m.name, cont: m.count, key: m.material.customProgramCacheKey ? m.material.customProgramCacheKey() : '-', comp: !!m.material.userData.compilado, cor: m.material.color && m.material.color.getHexString(), vis: m.visible })),
    contaLuzes: () => { const c = {}; let somb = 0; scene.traverse((o) => { if (o.isLight) { c[o.type] = (c[o.type] || 0) + 1; if (o.castShadow) somb++; } });
      return { luzes: c, comSombra: somb, maxTex: renderer.capabilities.maxTextures, maxVertTex: renderer.capabilities.maxVertexTextures, programas: renderer.info.programs.length }; },
    luzInfo: () => ({ sol: sol.intensity, solCast: sol.castShadow, env: scene.environmentIntensity, hemi: hemi.intensity, expo: renderer.toneMappingExposure,
      mapa: sol.shadow.mapSize.x, ultimo: solEstado.ultimo, ativo: solEstado.ativo, modo: solEstado.modo, gradeFn: !!gradeFn, ceu: ceuFisico.visible,
      matU: { cor: meshUnid.material.color.getHexString(), emis: meshUnid.material.emissive ? meshUnid.material.emissive.getHexString() : null, ver: meshUnid.material.version } }),
    fachadaInfo: () => {
      const m = meshUnid.material, u = m.userData || {};
      const cont = { disponivel: 0, reservada: 0, indisponivel: 0 };
      unidades.forEach((x) => { cont[x.situacao]++; });
      const cor = new THREE.Color(), porCor = {};
      for (let i = 0; i < meshUnid.count; i++) { meshUnid.getColorAt(i, cor); const k = cor.getHexString(); porCor[k] = (porCor[k] || 0) + 1; }
      return { material: m.name || m.type, chave: m.customProgramCacheKey ? m.customProgramCacheKey() : null, atlasPronto: !!(u.atlas && u.atlas.image && u.atlas.image.complete !== false && u.atlas.image.width),
        mascaraPronta: !!(u.mascara && u.mascara.image && u.mascara.image.width), compilado: !!u.compilado, situacoes: cont, coresInstancia: porCor };
    },
    info() { return { ...stats, programas: renderer.info.programs ? renderer.info.programs.length : null, dpr: renderer.getPixelRatio(), largura, altura, sombraMapa: sol.shadow.mapSize.x, instancias: unidades.length }; },
  };
}
