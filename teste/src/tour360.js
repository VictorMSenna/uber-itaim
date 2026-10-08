// Guided 360 tour over photoreal Cycles panoramas (front B6). Matterport-like: drag = look around 360°,
// wheel/pinch = zoom, tap a floor spot = walk there (camera glide + crossfade, ~600 ms).
// Light per time/season/lamps comes from src/render-mix.js (sum of precomputed layers).
//
// API (same words as src/interior.js of B4):
//   const api = await abrirTour360({ container, manifesto, ponto, estacao, minutos, luzes, aoFechar, teste })
//   definirHora(minutos) · definirEstacao(estacao) · definirLuz(nome, ligada) · irPara(id) · estadoTour360() · fecharTour360()
// Frames: manifest points are in the plan of the unit (u, v, h metres; v toward the balcony). three.js world:
//   X = -v, Y = h, Z = u  (pano centre = +v = -X, turning right = increasing pano u, like the Blender equirect camera).
import { capacidade, rebaixar } from './capacidade.js';
import * as THREE from 'three';
import { SOL } from './dados-sol.js';
import { MisturaPonto, ROTULO, LUZES, INFO } from './render-mix.js';

let atual = null;
export async function abrirTour360(opts) { if (atual) atual.fechar(false); atual = await criar(opts); return atual.api; }
export function definirHora(m) { atual?.api.definirHora(m); }
export function definirEstacao(e) { atual?.api.definirEstacao(e); }
export function definirLuz(n, l) { atual?.api.definirLuz(n, l); }
export function irPara(id) { return atual?.api.irPara(id); }
export function estadoTour360() { return atual ? atual.api.estado() : null; }
export function fecharTour360() { atual?.fechar(true); }

const NOMES_LUZ = { teto: 'Spots do teto', abajur: 'Abajures', cortineiro: 'LED da cortina', cozinha: 'Luz da cozinha' };
const paraMundo = ([u, v, h]) => new THREE.Vector3(-v, h, u);

async function criar({ container, manifesto = 'assets/render/tour360/manifesto.json', ponto, estacao = 'inverno', minutos = 900,
  luzes = {}, aoFechar, teste = false, andar = null, final = null }) {
  const man = typeof manifesto === 'string' ? await (await fetch(manifesto)).json() : manifesto;
  const base = typeof manifesto === 'string' ? manifesto.replace(/[^/]*$/, '') : (man.base || '');
  const PTS = Object.fromEntries(man.pontos.map((p) => [p.id, p]));
  // first view: the middle of the room facing the balcony when it has the new render (window mask = its own exposure +
  // Google city of the unit); otherwise the first point with a window mask; the manifest order last (07/10 Victor)
  const pontoInicial = () => (man.pontos.find((p) => p.id === 'entrada' && p.camadas && p.camadas.fora) || man.pontos.find((p) => p.camadas && p.camadas.fora) || man.pontos[0]).id; // Victor 08/10: the tour starts at the entrance
  const estado = { estacao, minutos, luzes: { ...luzes }, ponto: ponto && PTS[ponto] ? ponto : pontoInicial() };
  let G = null; // B10 (local test): optional live layer with Google Photorealistic 3D Tiles behind the `fora` window mask; null = current behaviour

  // ---------------------------------------------------------------- DOM
  const raiz = document.createElement('div');
  raiz.className = 't360';
  raiz.innerHTML = `
    <canvas class="t360-cv"></canvas>
    <div class="t360-rot">${ROTULO}</div>
    <div class="t360-vista" hidden>Vista simulada</div>
    <div class="t360-nome"></div>
    <div class="t360-luzes">${LUZES.filter((k) => man.pontos.some((p) => p.camadas && p.camadas[k])).map((k) => `<button data-luz="${k}" aria-pressed="false" title="${NOMES_LUZ[k]}">${NOMES_LUZ[k]}</button>`).join('')}</div>
    <button class="t360-fechar" aria-label="Fechar">×</button>`;
  container.appendChild(raiz);
  if (!document.getElementById('t360-css')) {
    const css = document.createElement('style'); css.id = 't360-css';
    css.textContent = `
    .t360{position:absolute;inset:0;overflow:hidden;background:#111;touch-action:none;user-select:none;font:14px/1.3 system-ui,sans-serif}
    .t360-cv{width:100%;height:100%;display:block;cursor:grab}
    .t360-cv.arrastando{cursor:grabbing}.t360-cv.alvo{cursor:pointer}
    .t360-rot{position:absolute;left:12px;bottom:12px;max-width:calc(100% - 24px);padding:6px 10px;border-radius:8px;background:rgba(0,0,0,.62);color:#fff;font-size:12px}
    .t360-vista{position:absolute;padding:3px 8px;border-radius:6px;background:rgba(0,0,0,.55);color:#fff;font-size:12px;transform:translate(-50%,-50%);pointer-events:none;white-space:nowrap}
    .t360-nome{position:absolute;left:50%;top:12px;transform:translateX(-50%);padding:6px 12px;border-radius:999px;background:rgba(0,0,0,.55);color:#fff}
    .t360-luzes{position:absolute;right:12px;top:56px;display:flex;flex-direction:column;gap:6px}
    .t360-luzes button{padding:6px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.5);background:rgba(0,0,0,.45);color:#fff;cursor:pointer}
    .t360-luzes button[aria-pressed="true"]{background:#f5c66b;color:#222;border-color:#f5c66b}
    .t360-fechar{position:absolute;right:12px;top:12px;width:36px;height:36px;border-radius:50%;border:0;background:rgba(0,0,0,.55);color:#fff;font-size:22px;cursor:pointer}`;
    document.head.appendChild(css);
  }
  const cv = raiz.querySelector('.t360-cv');
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, preserveDrawingBuffer: teste });
  // GPU ran out of memory (black screen on Victor's M21s at 3072): this device goes one level down and the page reopens here
  cv.addEventListener('webglcontextlost', (ev) => { ev.preventDefault(); if (rebaixar()) setTimeout(() => location.reload(), 300); });
  renderer.setPixelRatio(Math.min(capacidade().dprMax, window.devicePixelRatio || 1)); // tier of this device (src/capacidade.js) // 07/10 Victor: full screen density on phones (max 3) // orq 07/10 08:4x: phones at real screen density (1.0 made a 390-px image stretched ~3x = blurry on Victor's phone); one sphere is cheap
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  // phones: 2048 px panoramas (GPU memory: 7 layers x 2 points); desktop: full 4096 when the GPU allows it
  const movel = /Android|iPhone|iPad/i.test(navigator.userAgent);
  const larguraMax = Math.min(capacidade().larguraPano, renderer.capabilities.maxTextureSize); // 07/10 Victor: 4096 on phones too // phones full 3072 (07/10 08:3x: 2048 + narrow portrait view looked blurry on Victor's phone; the 08:0x 'crash' was the degraded test browser)

  const cena = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 100);
  let yaw = 0, pitch = 0, fov = (innerHeight > innerWidth ? 90 : 75); // portrait phones: wider vertical fov so the horizontal view is not a narrow zoomed slice // yaw 0 = looking at the balcony (+v)

  // ---------------------------------------------------------------- panorama spheres (one per visible point)
  const RAIO = 5;
  const esferas = new Map();
  function esfera(id) {
    if (esferas.has(id)) return esferas.get(id);
    const p = PTS[id];
    const geo = new THREE.SphereGeometry(RAIO, 96, 48); geo.scale(-1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 1, depthWrite: false, toneMapped: false });
    const m = new THREE.Mesh(geo, mat); m.position.copy(paraMundo(p.pos)); m.visible = false; cena.add(m);
    const mix = new MisturaPonto(renderer, p, base, { larguraMax, SOL });
    const e = { m, mix, pronto: null };
    esferas.set(id, e);
    return e;
  }
  async function pinta(id) {
    const e = esfera(id);
    const tx = await e.mix.atualizar(estado);
    e.m.material.map = tx; e.m.material.needsUpdate = true;
    if (G) G.aposPintar(id, e);
    return e;
  }

  // ---------------------------------------------------------------- hotspots on the floor
  const grupoHot = new THREE.Group(); cena.add(grupoHot);
  const texHot = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
    g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 9; g.beginPath(); g.arc(64, 64, 52, 0, 7); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.arc(64, 64, 40, 0, 7); g.fill();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  function montaHot() {
    grupoHot.clear();
    const p = PTS[estado.ponto];
    for (const vid of p.vizinhos || []) {
      const q = PTS[vid]; if (!q) continue;
      const pos = paraMundo([q.pos[0], q.pos[1], 0.02]);
      const m = new THREE.Mesh(new THREE.CircleGeometry(0.22, 40), new THREE.MeshBasicMaterial({ map: texHot, transparent: true, depthTest: false, toneMapped: false }));
      m.rotation.x = -Math.PI / 2; m.position.copy(pos); m.userData.id = vid; m.renderOrder = 5;
      grupoHot.add(m);
    }
  }

  // ---------------------------------------------------------------- camera + interaction
  function aplicaCam() {
    pitch = Math.max(-85, Math.min(85, pitch));
    const y = (yaw * Math.PI) / 180, x = (pitch * Math.PI) / 180;
    // yaw 0 -> -X (balcony); positive yaw turns right (toward -Z)
    const d = new THREE.Vector3(-Math.cos(x) * Math.cos(y), Math.sin(x), -Math.cos(x) * Math.sin(y));
    camera.fov = fov; camera.updateProjectionMatrix();
    camera.lookAt(camera.position.clone().add(d));
  }
  function redim() {
    const w = raiz.clientWidth || 1, h = raiz.clientHeight || 1;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); desenha();
  }
  const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
  function hotEm(ev) {
    const r = cv.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const h = ray.intersectObjects(grupoHot.children, false)[0];
    return h ? h.object.userData.id : null;
  }
  let arr = null, moveu = 0; const toques = new Map(); let pinca = null;
  cv.addEventListener('pointerdown', (ev) => {
    cv.setPointerCapture(ev.pointerId); toques.set(ev.pointerId, [ev.clientX, ev.clientY]);
    arr = { x: ev.clientX, y: ev.clientY, yaw, pitch }; moveu = 0; cv.classList.add('arrastando');
    if (toques.size === 2) { const [a, b] = [...toques.values()]; pinca = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), fov }; }
  });
  cv.addEventListener('pointermove', (ev) => {
    if (toques.has(ev.pointerId)) toques.set(ev.pointerId, [ev.clientX, ev.clientY]);
    if (pinca && toques.size === 2) {
      const [a, b] = [...toques.values()]; fov = Math.max(35, Math.min(95, pinca.fov * pinca.d / Math.max(20, Math.hypot(a[0] - b[0], a[1] - b[1]))));
      aplicaCam(); desenha(); return;
    }
    if (arr) {
      const k = fov / (cv.clientHeight || 600);
      moveu = Math.max(moveu, Math.hypot(ev.clientX - arr.x, ev.clientY - arr.y));
      yaw = arr.yaw - (ev.clientX - arr.x) * k; pitch = arr.pitch + (ev.clientY - arr.y) * k;
      aplicaCam(); desenha(); return;
    }
    cv.classList.toggle('alvo', !!hotEm(ev));
  });
  const solta = (ev) => {
    toques.delete(ev.pointerId); if (toques.size < 2) pinca = null;
    cv.classList.remove('arrastando');
    if (arr && moveu < 6) { const id = hotEm(ev); if (id) irPara(id); }
    arr = null;
  };
  cv.addEventListener('pointerup', solta); cv.addEventListener('pointercancel', solta);
  cv.addEventListener('wheel', (ev) => { ev.preventDefault(); fov = Math.max(35, Math.min(95, fov + ev.deltaY * 0.05)); aplicaCam(); desenha(); }, { passive: false });

  // ---------------------------------------------------------------- draw
  const elVista = raiz.querySelector('.t360-vista');
  function desenha() {
    if (G) G.antes();
    renderer.render(cena, camera);
    // "Vista simulada" tag anchored outside the balcony (direction +v, slightly up)
    const p = PTS[estado.ponto];
    const alvo = paraMundo([p.pos[0], p.pos[1] + 30, p.pos[2] + 2]);
    const v = alvo.clone().project(camera);
    const ok = v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1;
    elVista.hidden = !ok || !!(G && G.malha.visible); // B10: with Google's city the credit pill replaces "Vista simulada"
    if (ok) { elVista.style.left = `${(v.x * 0.5 + 0.5) * 100}%`; elVista.style.top = `${(-v.y * 0.5 + 0.5) * 100}%`; }
  }

  // ---------------------------------------------------------------- walking between points
  let andando = null;
  async function irPara(id, { dur = 600 } = {}) {
    if (!PTS[id] || id === estado.ponto || andando) return andando;
    andando = (async () => {
      const de = esfera(estado.ponto), para = await pinta(id);
      para.m.visible = true; para.m.material.opacity = 0; para.m.renderOrder = 1; de.m.renderOrder = 0;
      grupoHot.clear();
      const p0 = paraMundo(PTS[estado.ponto].pos), p1 = paraMundo(PTS[id].pos);
      const t0 = performance.now();
      await new Promise((ok) => {
        const passo = (t) => {
          const k = Math.min(1, (t - t0) / dur), s = k * k * (3 - 2 * k);
          camera.position.lerpVectors(p0, p1, s);
          para.m.material.opacity = s; de.m.material.opacity = 1;
          aplicaCam(); desenha();
          if (k < 1) requestAnimationFrame(passo); else ok();
        };
        requestAnimationFrame(passo);
      });
      de.m.visible = false; para.m.material.opacity = 1;
      de.mix.soltarCamadas(); // (B1) release the layers of the point we left
      estado.ponto = id; raiz.querySelector('.t360-nome').textContent = PTS[id].nome;
      montaHot(); desenha();
      andando = null;
    })();
    return andando;
  }

  // (B1) the sun bar fires many changes: one repaint at a time, latest state wins (no pile of concurrent decodes)
  let pintando = null, pendente = false;
  async function repinta() {
    if (pintando) { pendente = true; return pintando; }
    pintando = (async () => {
      do { pendente = false; const e = await pinta(estado.ponto); e.m.visible = true; desenha(); } while (pendente);
    })().finally(() => { pintando = null; });
    return pintando;
  }
  function marcaLuzes() { raiz.querySelectorAll('[data-luz]').forEach((b) => b.setAttribute('aria-pressed', String(!!estado.luzes[b.dataset.luz]))); }
  raiz.querySelectorAll('[data-luz]').forEach((b) => b.addEventListener('click', () => { estado.luzes[b.dataset.luz] = !estado.luzes[b.dataset.luz]; marcaLuzes(); repinta(); }));
  let fechado = false;
  function fechar(chamaCb = true) {
    if (fechado) return; fechado = true;
    if (G) { try { G.liberar(); } catch (e) { /* ignore */ } G = null; }
    for (const e of esferas.values()) { e.mix.liberar(); e.m.geometry.dispose(); e.m.material.dispose(); }
    renderer.dispose(); raiz.remove(); window.removeEventListener('resize', redim);
    if (atual && atual.raiz === raiz) atual = null;
    if (chamaCb && aoFechar) aoFechar();
  }
  raiz.querySelector('.t360-fechar').addEventListener('click', () => fechar(true));
  window.addEventListener('resize', redim);

  // ---------------------------------------------------------------- B10: Google 3D Tiles behind the window mask (opt-in ?google3d=1, key injected at runtime)
  // Where the point's `fora` mask is white the city is drawn from Google's tiles with a camera at the panorama's real position
  // (manifest `geo`: lat, lon, h ellipsoid, rumo = bearing of the pano centre). The panorama sphere stays untouched underneath,
  // so any failure (no key, quota, error, trial ended) just removes the overlay and the current look remains, silently.
  // geodetic eye of any point: its own `geo`, else derived from a reference point that has one (same unit plan, so the
  // offset is the [u, v, h] difference turned by the bearing: +v = rumo, +u = rumo - 90 deg, as in paraMundo/dirParaL)
  let geoPredio = null; // dados/google-geo.json: eye of any unit (final + floor) in the registered B5 frame
  const raio = (lat) => { const la = (lat * Math.PI) / 180, a = 6378137, e2 = 0.00669437999014, w = Math.sqrt(1 - e2 * Math.sin(la) ** 2); return { M: (a * (1 - e2)) / w ** 3, N: a / w, la }; };
  function geoDaUnidade(p) {
    const G0 = geoPredio, f = G0 && G0.finais[String(final ?? G0.padrao.final)];
    if (!f || !p.pos) return null;
    const [u, v, hp] = p.pos, x = f.M[0] * u + f.M[1] * v + f.t[0], z = f.M[2] * u + f.M[3] * v + f.t[1];
    const y = G0.laje_1 + ((andar ?? G0.padrao.andar) - 1) * G0.piso + hp;
    const o = G0.origem, b = (o.rumoX * Math.PI) / 180, E = x * Math.sin(b) + z * Math.cos(b), Nn = x * Math.cos(b) - z * Math.sin(b), r = raio(o.lat);
    return { lat: o.lat + (Nn / r.M) * (180 / Math.PI), lon: o.lon + (E / (r.N * Math.cos(r.la))) * (180 / Math.PI), h: o.h + y, rumo: f.rumo, porUnidade: true, ajuste: G0.ajuste };
  }
  function geoDoPonto(id) {
    const p = PTS[id];
    const gu = geoDaUnidade(p); if (gu) return gu;
    if (p.geo) return p.geo;
    const ref = Object.values(PTS).find((q) => q.geo && q.pos) || (man.geo && man.geo.pos ? { geo: man.geo, pos: man.geo.pos } : null);
    if (!ref || !p.pos) return null;
    const g = ref.geo, b = (g.rumo * Math.PI) / 180, du = p.pos[0] - ref.pos[0], dv = p.pos[1] - ref.pos[1], dh = p.pos[2] - ref.pos[2];
    const E = Math.sin(b) * dv - Math.cos(b) * du, Nn = Math.cos(b) * dv + Math.sin(b) * du;
    const la = (g.lat * Math.PI) / 180, a = 6378137, e2 = 0.00669437999014, w = Math.sqrt(1 - e2 * Math.sin(la) ** 2);
    const M = (a * (1 - e2)) / w ** 3, Nr = a / w;
    return { ...g, lat: g.lat + (Nn / M) * (180 / Math.PI), lon: g.lon + (E / (Nr * Math.cos(la))) * (180 / Math.PI), h: g.h + dh };
  }
  async function ligaGoogle() {
    if (/[?&]google3d=0/.test(location.search)) return; // on by default (no key = silently off)
    try {
      const gm = await import('./google-vista.js');
      try { geoPredio = (await import('./google-geo.js')).GEO_PREDIO; } catch (e) { /* per-point geo only */ }
      const sess = await gm.iniciarGoogle();
      if (!sess || fechado) return;
      const vista = new gm.VistaGoogle(renderer, sess, { lat: 0, lon: 0, h: 0, rumo: 0 }, () => desenha());
      const mat = gm.materialSobreposicao();
      const geo = new THREE.SphereGeometry(RAIO, 96, 48); geo.scale(-1, 1, 1);
      const malha = new THREE.Mesh(geo, mat); malha.renderOrder = 3; malha.visible = false; malha.frustumCulled = false; cena.add(malha);
      const st = document.createElement('style'); st.id = 't360-g3d-css';
      st.textContent = '.t360-g3d{position:absolute;right:10px;bottom:78px;max-width:58%;display:flex;align-items:center;gap:5px;padding:2px 6px;border-radius:6px;background:rgba(0,0,0,.45);color:#fff;font:9px/1.2 system-ui,sans-serif;pointer-events:none;white-space:nowrap;overflow:hidden}.t360-g3d[hidden]{display:none}.t360-g3d img{height:11px;width:auto;display:block;flex:none}.t360-g3d .g3d-attr{opacity:.85;overflow:hidden;text-overflow:ellipsis}.t360-g3d-carga{position:absolute;left:12px;bottom:78px;width:160px;display:flex;flex-direction:column;gap:3px;padding:4px 8px;border-radius:7px;background:rgba(0,0,0,.45);color:#fff;font:10px/1.2 system-ui,sans-serif;pointer-events:none}.t360-g3d-carga[hidden]{display:none}.t360-g3d-carga i{display:block;height:2px;border-radius:2px;background:rgba(255,255,255,.25);overflow:hidden}.t360-g3d-carga b{display:block;height:100%;width:4%;background:#fff;transition:width .4s ease}';
      document.head.appendChild(st); raiz.appendChild(vista.credito); raiz.appendChild(vista.carga);
      const dir = new THREE.Vector3(), tam = new THREE.Vector2(), perf = { n: 0, ms: 0, max: 0 }, camV = new THREE.PerspectiveCamera();
      let atual = null, falhou = false;
      G = {
        vista, malha, perf, gm,
        ativoEm: (id) => !falhou && !!(PTS[id].camadas && PTS[id].camadas.fora) && !!geoDoPonto(id),
        aposPintar(id, e) {
          if (!this.ativoEm(id)) return;
          const g0 = geoDoPonto(id);
          // follows the unit the client opened: final (side, xy, bearing) + floor from dados/google-geo.json; old per-point geo as fallback
          const g = g0.porUnidade ? g0 : { ...g0, h: g0.h + (andar != null && g0.andar_ref != null ? (andar - g0.andar_ref) * (g0.por_andar || 2.81) : 0) };
          // switching points inside the unit keeps Google's window on (the tiles are already here: no 'reload' look)
          vista.ref = { ...g, ajuste: window.__g3dAjuste || g.ajuste };
          vista.ligaNaCena();
          mat.uniforms.tM.value = e.mix.mat.uniforms.tFora.value;
          vista.definirMascara(mat.uniforms.tM.value && mat.uniforms.tM.value.image);
          const el = e.mix.ultimo && e.mix.ultimo.sol ? e.mix.ultimo.sol.el : 20;
          // the time-of-day grade + night windows live in the tile shaders (shared with the outside view); here only the
          // brightness match of the window (city behind glass ~1.35x, as before)
          sess.definirLuz(el); mat.uniforms.ganho.value.setScalar((window.__g3dGanho && window.__g3dGanho.dia) || 1.35);
          { const c = gm.ceuParaSol(el); mat.uniforms.ceuTopo.value.set(...c.topo); mat.uniforms.ceuHoriz.value.set(...c.horiz); } // sky of the hour in the window
          this.el = el; // night (sun below -2 deg): the window shows our render's night city, not Google's day photos
          atual = id;
        },
        antes() {
          if (gm.MODO_FOTO) return this.antesFoto();
          let mostrar = !andando && !falhou && atual === estado.ponto && this.ativoEm(estado.ponto);
          // no window on screen (looking at a wall): no city to draw and nothing to download
          let janela = null;
          if (mostrar) {
            camera.updateMatrixWorld(true); janela = vista.janelaNaTela(camera);
            if (!janela) {
              // looking at the room, not the window: keep downloading the window view (yaw 0 of this point), nothing drawn
              mostrar = false; malha.visible = false; vista.credito.hidden = true;
              camV.position.copy(camera.position); camV.fov = camera.fov; camV.aspect = camera.aspect; camV.updateProjectionMatrix();
              camV.lookAt(camV.position.x - 1, camV.position.y, camV.position.z); camV.updateMatrixWorld(true);
              const jv = vista.janelaNaTela(camV);
              if (jv) { try { renderer.getDrawingBufferSize(tam); vista.tamanho(tam.x, tam.y, Math.min(1, renderer.capabilities.maxTextureSize / Math.max(tam.x, tam.y))); camV.getWorldDirection(dir); vista.desenha(dir, camV.fov, camV.aspect, jv, true); } catch (e) { /* ignore */ } }
              return;
            }
          }
          malha.visible = mostrar; vista.credito.hidden = !mostrar;
          if (!mostrar) return;
          try {
            const t0 = performance.now();
            renderer.getDrawingBufferSize(tam);
            const k = Math.min(1, renderer.capabilities.maxTextureSize / Math.max(tam.x, tam.y)); // full drawing-buffer resolution at device dpr, no phone downgrade
            vista.tamanho(tam.x, tam.y, k);
            camera.updateMatrixWorld(true); camera.getWorldDirection(dir);
            malha.position.copy(camera.position);
            vista.desenha(dir, camera.fov, camera.aspect, janela);
            vista.progresso(true);
            const op = vista.opacidade(); mat.uniforms.forca.value = op; if (op < 1) vista.acordar(); // keep frames coming during the fade
            vista.credito.hidden = op <= 0; // the credit shows only while Google's city is on screen
            // credit + progress sit just above the image caption (the sun bar below would hide them)
            if ((perf.n & 31) === 0) { const rot = raiz.querySelector('.t360-rot'); const topo = rot && rot.offsetParent ? rot.getBoundingClientRect().top : innerHeight - 120; const bb = Math.max(78, Math.round(raiz.getBoundingClientRect().bottom - topo + 6)) + 'px'; vista.credito.style.bottom = bb; vista.carga.style.bottom = bb; }
            mat.uniforms.tG.value = vista.rt.texture; mat.uniforms.res.value.copy(tam);
            const dt = performance.now() - t0; perf.n++; perf.ms += dt; perf.max = Math.max(perf.max, dt);
            if (window.__g3d && window.__g3d.erro && /403|429|quota|key|denied|permission/i.test(window.__g3d.erro)) throw new Error(window.__g3d.erro);
          } catch (err) { falhou = true; malha.visible = false; vista.credito.hidden = true; try { vista.liberar(); } catch (e2) { /* ignore */ } console.warn('google3d desligado', err && err.message); }
        },
        // photo mode (phones, 08/10): the window view is shot once per point (cube), then turning only shows that picture
        antesFoto() {
          const ok = !falhou && atual === estado.ponto && this.ativoEm(estado.ponto);
          if (!ok) { malha.visible = false; vista.credito.hidden = true; vista.progressoFoto(false); return; }
          try {
            vista.passoFoto();
            camera.updateMatrixWorld(true); const janela = vista.janelaNaTela(camera);
            const ve = !!janela && !andando;
            malha.visible = ve && vista.pronto; malha.position.copy(camera.position);
            mat.uniforms.usaCubo.value = 1; mat.uniforms.tC.value = vista.foto.rt.texture; mat.uniforms.tW.value = vista.foto.rtW.texture;
            { const L = gm.luzDaCidade(this.el); mat.uniforms.luzBase.value.set(...L.base); mat.uniforms.luzesN.value = L.luzes; } // hour of the day on the picture
            mat.uniforms.rumoB.value = ((vista.ref.rumo + ((vista.ref.ajuste && vista.ref.ajuste.rumo) || 0)) * Math.PI) / 180;
            vista.progressoFoto(ve);
            const op = vista.opacidade(); mat.uniforms.forca.value = op; if (op < 1 && malha.visible) vista.acordar();
            vista.credito.hidden = !malha.visible || op <= 0;
            if ((perf.n++ & 31) === 0) { const rot = raiz.querySelector('.t360-rot'); const topo = rot && rot.offsetParent ? rot.getBoundingClientRect().top : innerHeight - 120; const bb = Math.max(78, Math.round(raiz.getBoundingClientRect().bottom - topo + 6)) + 'px'; vista.credito.style.bottom = bb; vista.carga.style.bottom = bb; }
            if (window.__g3d && window.__g3d.erro && /403|429|quota|key|denied|permission/i.test(window.__g3d.erro)) throw new Error(window.__g3d.erro);
          } catch (err) { falhou = true; malha.visible = false; vista.credito.hidden = true; try { vista.liberar(); } catch (e2) { /* ignore */ } console.warn('google3d desligado', err && err.message); }
        },
        liberar() { malha.geometry.dispose(); mat.dispose(); cena.remove(malha); vista.liberar(); },
      };
      window.__g3dVista = G;
      G.aposPintar(estado.ponto, esfera(estado.ponto));
      vista.acordar();
      desenha();
    } catch (err) { G = null; console.warn('google3d indisponivel', err && err.message); }
  }

  // ---------------------------------------------------------------- start
  camera.position.copy(paraMundo(PTS[estado.ponto].pos));
  raiz.querySelector('.t360-nome').textContent = PTS[estado.ponto].nome;
  aplicaCam(); redim(); marcaLuzes();
  await repinta(); montaHot(); desenha();
  await ligaGoogle();
  raiz.dataset.ready = '1';
  if (/[?&]debug360=1/.test(location.search)) { // (B1) device report for Victor's screenshot
    const d = document.createElement('pre');
    d.style.cssText = 'position:absolute;left:8px;top:240px;z-index:50;margin:0;padding:6px 8px;font:11px/1.35 monospace;background:rgba(0,0,0,.75);color:#fff;border-radius:6px;pointer-events:none;white-space:pre-wrap;max-width:80%';
    const atualizaDbg = () => { d.textContent = `WebGL ${INFO.webgl} · RT float: ${INFO.rtFloat ? 'sim' : 'NAO (8 bits, sRGB)'}
maxTextureSize ${INFO.maxTex} · larguraMax ${larguraMax}
texturas enviadas: ${[...INFO.tamanhos].join(', ')}
decodificador: ${INFO.decodificador} · dpr ${renderer.getPixelRatio()}
${navigator.userAgent.slice(0, 120)}`; };
    atualizaDbg(); setInterval(atualizaDbg, 2000); raiz.appendChild(d);
  }

  const api = {
    definirHora: (m) => { estado.minutos = m; return repinta(); },
    definirEstacao: (e) => { estado.estacao = e; return repinta(); },
    definirLuz: (n, l) => { estado.luzes[n] = !!l; marcaLuzes(); return repinta(); },
    irPara,
    olhar: (y, p = 0, f = fov) => { yaw = y; pitch = p; fov = f; aplicaCam(); desenha(); },
    // screen position (CSS px, relative to the canvas) of the floor spots in view, for tests and tooltips
    hotspots: () => { const r = cv.getBoundingClientRect(); return grupoHot.children.map((m) => { const v = m.position.clone().project(camera);
      return { id: m.userData.id, x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height, visivel: v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1 }; }); },
    cursor: () => cv.className,
    estado: () => ({ ...estado, luzes: { ...estado.luzes }, yaw, pitch, fov, expo: esfera(estado.ponto).mix.ultimo?.expo, google: G ? { ...(window.__g3d || {}), ms: G.perf.n ? G.perf.ms / G.perf.n : 0, max: G.perf.max, n: G.perf.n } : null }),
    fechar: () => fechar(true),
    renderer,
  };
  return { api, fechar, raiz };
}
