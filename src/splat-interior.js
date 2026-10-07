// Real walk-through of the studio as filmed in 2026 (front B8): a 3D Gaussian Splatting reconstruction trained only on
// the phone clips IMG_5104-5116 (COLMAP + gsplat), shown with Spark (MIT, sparkjsdev, three.js integration).
// Every pixel comes from the footage: no modelled furniture, no simulated light. Limits: furniture and daylight are
// those of the filming day (no sun per hour); places that were not filmed are not shown, so the camera only stands on
// the real camera positions and only looks within the angles the clips covered (plus a small margin).
//
// Feature flag: the module is enabled when `<base>manifest.json` exists (default base 'assets/splat/').
// API:
//   const man = await splatDisponivel()          -> manifest object or null
//   const api = await abrirSplat({ container, aoFechar, base, qualidade, ponto, teste })
//   api.irPara(id) · api.estado() · api.fechar() · api.poseQuadro(pose)  (test: exact clip-frame camera)
// `container` must be positioned; the module fills it (position:absolute; inset:0). Esc / "Sair do passeio" close it
// and call aoFechar(). Spark is imported only when the tour opens (no cost for the rest of the site).
import * as THREE from 'three';

const SPARK = 'https://cdn.jsdelivr.net/npm/@sparkjsdev/spark@2.3.1/dist/spark.module.min.js';
const MARGEM_YAW = 10;     // degrees allowed beyond the covered yaw arc of a viewpoint
const MARGEM_PITCH = 8;
// Zoom is a HORIZONTAL field of view: the clips are portrait with ~66 deg horizontal, so a wide landscape screen must not
// show more than the footage saw at once (beyond it are the unfilmed, smeared borders).
const HFOV = { padrao: 62, min: 30, max: 70 };
const VFOV_MAX = 100;
const cache = {};

export async function splatDisponivel(base = 'assets/splat/') {
  if (base in cache) return cache[base];
  try {
    const r = await fetch(base + 'manifest.json', { cache: 'no-cache' });
    cache[base] = r.ok ? await r.json() : null;
  } catch { cache[base] = null; }
  return cache[base];
}

let atual = null;
export async function abrirSplat(opts) {
  if (atual) atual.fechar(false);
  atual = await criar(opts);
  return atual.api;
}
export function fecharSplat() { atual?.fechar(true); }

const rad = THREE.MathUtils.degToRad;
const dirDe = (yaw, pitch) => new THREE.Vector3(Math.sin(rad(yaw)) * Math.cos(rad(pitch)), Math.sin(rad(pitch)), Math.cos(rad(yaw)) * Math.cos(rad(pitch)));
const difAng = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;   // a - b in (-180, 180]
const suave = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function estilo() {
  if (document.getElementById('spl-css')) return;
  const css = document.createElement('style'); css.id = 'spl-css';
  css.textContent = `
  .spl{position:absolute;inset:0;overflow:hidden;background:#0d0f0e;touch-action:none;user-select:none;-webkit-user-select:none;
    font:500 14px/1.35 var(--f-body,"Archivo","Segoe UI",Roboto,Arial,sans-serif);color:#f1ede6}
  .spl canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab}
  .spl canvas.arrastando{cursor:grabbing}
  .spl-topo{position:absolute;left:12px;right:12px;top:12px;display:flex;gap:10px;align-items:flex-start;justify-content:space-between;pointer-events:none}
  .spl-rot{pointer-events:auto;max-width:min(560px,calc(100% - 150px));padding:8px 12px;border-radius:14px;background:rgba(16,18,17,.72);
    -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border:1px solid rgba(240,236,228,.14)}
  .spl-rot b{display:block;font-weight:700;font-size:14px}
  .spl-rot small{display:block;color:#b8b1a5;font-size:12px;margin-top:2px}
  .spl-sair{pointer-events:auto;flex:none;min-height:44px;padding:0 16px;border-radius:999px;border:1px solid rgba(240,236,228,.22);
    background:rgba(16,18,17,.72);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);color:#f1ede6;font:600 14px inherit;cursor:pointer}
  .spl-sair:hover{background:rgba(40,44,41,.85)}
  .spl-pontos{position:absolute;left:0;right:0;bottom:14px;display:flex;gap:8px;padding:0 12px;overflow-x:auto;scrollbar-width:none}
  .spl-pontos>:first-child{margin-left:auto}.spl-pontos>:last-child{margin-right:auto}
  .spl-pontos::-webkit-scrollbar{display:none}
  .spl-pontos button{flex:none;min-height:40px;padding:0 14px;border-radius:999px;border:1px solid rgba(240,236,228,.22);background:rgba(16,18,17,.7);
    -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);color:#f1ede6;font:600 13px inherit;cursor:pointer}
  .spl-pontos button[aria-current="true"]{background:#f1ede6;color:#141614;border-color:#f1ede6}
  .spl-alvo{position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:2px solid rgba(255,255,255,.9);
    background:rgba(255,255,255,.18);box-shadow:0 2px 12px rgba(0,0,0,.35);cursor:pointer;transform:scaleY(.55);transition:background .15s}
  .spl-alvo:hover{background:rgba(255,255,255,.45)}
  .spl-alvo span{position:absolute;left:50%;top:-30px;transform:translateX(-50%) scaleY(1.8);white-space:nowrap;font:600 12px inherit;
    padding:3px 8px;border-radius:999px;background:rgba(16,18,17,.75);opacity:0;transition:opacity .15s;pointer-events:none}
  .spl-alvo:hover span{opacity:1}
  .spl-dica{position:absolute;left:50%;bottom:68px;transform:translateX(-50%);padding:6px 12px;border-radius:999px;background:rgba(16,18,17,.7);
    font-size:12.5px;color:#d9d3c8;white-space:nowrap;transition:opacity .6s;pointer-events:none}
  .spl-carga{position:absolute;inset:0;display:grid;place-items:center;background:#0d0f0e;transition:opacity .5s}
  .spl-carga div{width:min(320px,70%);text-align:center;color:#b8b1a5;font-size:13px}
  .spl-carga i{display:block;height:3px;margin-top:12px;border-radius:2px;background:rgba(240,236,228,.12);overflow:hidden}
  .spl-carga i::after{content:"";display:block;height:100%;width:var(--p,0%);background:#f1ede6;transition:width .2s}
  .spl-aviso{position:absolute;inset:auto 12px 64px 12px;margin:auto;max-width:520px;padding:10px 12px;border-radius:12px;background:rgba(16,18,17,.88);font-size:12.5px;color:#d9d3c8}
  @media (max-width:560px){.spl-rot b{font-size:13px}.spl-rot small{display:none}.spl-sair{padding:0 12px}}`;
  document.head.appendChild(css);
}

async function criar({ container, aoFechar, base = 'assets/splat/', qualidade = 'auto', ponto, teste = false, pixelRatio }) {
  const man = await splatDisponivel(base);
  if (!man) throw new Error('splat: manifest ausente em ' + base);
  estilo();
  const PTS = Object.fromEntries(man.pontos.map((p) => [p.id, p]));
  const celular = qualidade === 'celular' || (qualidade === 'auto' && (matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700));
  const toque = matchMedia('(pointer: coarse)').matches || window.innerWidth < 900; // (B1) phones/tablets: resolution cap 1.0
  // phones get the full build (truncating the SH bands left dark/blue streaks on the ceiling, 07/10); the light build
  // (SH baked into the base colour, 10 MB) only on data-saver / 2G-3G connections or with qualidade 'leve'
  const con = navigator.connection || {};
  const leve = qualidade === 'leve' || (celular && qualidade === 'auto' && (con.saveData || /(^|-)(2g|3g)$/.test(con.effectiveType || '')));
  const arq = (leve && man.arquivos.celular_leve) || (celular ? man.arquivos.celular : man.arquivos.desktop) || man.arquivos.desktop;

  const raiz = document.createElement('div');
  raiz.className = 'spl';
  raiz.innerHTML = `
    <div class="spl-topo">
      <div class="spl-rot"><b></b><small>Imagem 3D feita só com o vídeo real · sem sol por horário · o que não foi filmado não aparece</small></div>
      <button class="spl-sair" type="button">‹ Sair do passeio</button>
    </div>
    <div class="spl-alvos"></div>
    <div class="spl-dica">Arraste para olhar · toque nos círculos para andar</div>
    <nav class="spl-pontos" aria-label="Pontos do passeio"></nav>
    <div class="spl-carga"><div>Carregando o passeio real…<i></i></div></div>`;
  raiz.querySelector('.spl-rot b').textContent = man.legenda || 'Passeio real (vídeo de 2026)';
  container.appendChild(raiz);
  const carga = raiz.querySelector('.spl-carga');
  const nav = raiz.querySelector('.spl-pontos');
  const alvos = raiz.querySelector('.spl-alvos');

  // ---------------------------------------------------------------- three + Spark
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: teste, powerPreference: 'high-performance' });
  // (B1, Victor's phone 'travado'): cap 1.0 on phones/tablets, 1.5 on desktop; then adaptive (see the loop)
  const PR_MAX = Math.min(window.devicePixelRatio || 1, toque ? 1.0 : 1.5);
  let prAtual = pixelRatio || PR_MAX;
  renderer.setPixelRatio(prAtual);
  raiz.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0f0e);
  const camera = new THREE.PerspectiveCamera(62, 1, 0.15, 500);   // near 0.15 m: the camera never stood closer to a surface
  const { SparkRenderer, SplatMesh } = await import(SPARK);
  // maxPixelRadius: Spark's default 512 px clips the big wall/ceiling gaussians seen up close at desktop resolution
  // (dark smears); maxStdDev 3 = the 3-sigma extent the trainer (gsplat) used.
  const spark = new SparkRenderer({ renderer, maxPixelRadius: 4096, maxStdDev: 3, enableLod: false, minSortIntervalMs: toque ? 120 : 0 }); // (B1) phones: sort less often
  scene.add(spark);
  const M = new THREE.Matrix4().fromArray(man.matriz);
  const progresso = (f) => carga.style.setProperty('--p', Math.round(100 * f) + '%');
  let mesh;
  if (arq.partes) {
    // the splat is published as binary parts (host limit per file); fetched in parallel, concatenated, parsed as PLY
    // fallback: if the host refused the .bin parts, the same bytes exist as base64 text parts (*.b64-N.json)
    let listas = arq.partes, b64 = false;
    if (arq.partes_b64) {
      const t = await fetch(base + arq.partes[0], { method: 'HEAD' }).catch(() => null);
      if (!t || !t.ok) { listas = arq.partes_b64; b64 = true; }
    }
    const total = (b64 ? arq.bytes * 4 / 3 : arq.bytes) || 1; const lidos = listas.map(() => 0);
    const pedacos = await Promise.all(listas.map(async (nome, i) => {
      const r = await fetch(base + nome);
      if (!r.ok) throw new Error('splat: ' + nome + ' ' + r.status);
      const leitor = r.body.getReader(); const blocos = [];
      for (;;) {
        const { done, value } = await leitor.read(); if (done) break;
        blocos.push(value); lidos[i] += value.length; progresso(lidos.reduce((a, b) => a + b, 0) / total);
      }
      if (!b64) return blocos;
      const txt = await new Blob(blocos).text();
      const bin = atob(JSON.parse(txt).d); const u = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k);
      lidos[i] = u.length; return [u];
    }));
    if (b64) lidos.splice(0, lidos.length, ...pedacos.map((p) => p[0].length));
    const bytes = new Uint8Array(lidos.reduce((a, b) => a + b, 0)); let o = 0;
    for (const bl of pedacos.flat()) { bytes.set(bl, o); o += bl.length; }
    mesh = new SplatMesh({ fileBytes: bytes, fileType: arq.tipo || 'ply', fileName: 'studio.' + (arq.tipo || 'ply'), maxSh: toque ? 1 : 3 }); // (B1) phones: SH degree 1
  } else {
    mesh = new SplatMesh({ url: base + arq.url, onProgress: (e) => { if (e.total) progresso(e.loaded / e.total); } });
  }
  M.decompose(mesh.position, mesh.quaternion, mesh.scale);
  scene.add(mesh);

  const est = { ponto: null, yaw: 0, pitch: 0, hfov: HFOV.padrao, pos: new THREE.Vector3(), anim: null, livre: false, fechado: false };
  function tamanho() {
    const w = raiz.clientWidth || 1, h = raiz.clientHeight || 1;
    renderer.setSize(w, h, false);
    if (!est.livre) {
      camera.aspect = w / h;
      const v = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(rad(est.hfov) / 2) / camera.aspect));
      camera.fov = Math.min(v, VFOV_MAX);
      camera.updateProjectionMatrix();
    }
  }
  const ro = new ResizeObserver(tamanho); ro.observe(raiz); tamanho();

  function limita() {
    const p = PTS[est.ponto]; if (!p || est.anim) return;
    const meio = (p.yaw[0] + p.yaw[1]) / 2, meia = (p.yaw[1] - p.yaw[0]) / 2 + MARGEM_YAW;
    const d = difAng(est.yaw, meio);
    if (Math.abs(d) > meia) est.yaw = meio + Math.sign(d) * meia;
    // pitch_max (manifest, optional): per-viewpoint ceiling cap where the footage never looked up
    est.pitch = THREE.MathUtils.clamp(est.pitch, p.pitch[0] - MARGEM_PITCH, p.pitch_max ?? (p.pitch[1] + MARGEM_PITCH));
  }
  function aplicaCamera() {
    if (est.livre) return;
    camera.position.copy(est.pos);
    camera.lookAt(est.pos.clone().add(dirDe(est.yaw, est.pitch)));
  }

  // ---------------------------------------------------------------- navigation
  man.pontos.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = p.nome; b.dataset.id = p.id;
    b.addEventListener('click', () => irPara(p.id));
    nav.appendChild(b);
    const a = document.createElement('div');
    a.className = 'spl-alvo'; a.dataset.id = p.id; a.title = p.nome; a.innerHTML = `<span>${p.nome}</span>`;
    a.addEventListener('click', (e) => { e.stopPropagation(); irPara(p.id); });
    alvos.appendChild(a);
  });
  function irPara(id, instantaneo = false) {
    const p = PTS[id]; if (!p) return;
    est.livre = false; tamanho();
    const destino = { pos: new THREE.Vector3(...p.pos), yaw: p.olhar[0], pitch: p.olhar[1] };
    // keep the current view direction if it is inside the new point's arc (feels like walking, not teleporting)
    const meio = (p.yaw[0] + p.yaw[1]) / 2;
    if (est.ponto && Math.abs(difAng(est.yaw, meio)) <= (p.yaw[1] - p.yaw[0]) / 2 + MARGEM_YAW) { destino.yaw = est.yaw; destino.pitch = est.pitch; }
    est.ponto = id;
    nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.id === id)));
    if (instantaneo || !est.pos.lengthSq()) { est.pos.copy(destino.pos); est.yaw = destino.yaw; est.pitch = destino.pitch; est.anim = null; limita(); return; }
    const dist = est.pos.distanceTo(destino.pos);
    est.anim = { t0: performance.now(), dur: THREE.MathUtils.clamp(500 + dist * 380, 600, 1600), de: { pos: est.pos.clone(), yaw: est.yaw, pitch: est.pitch }, para: destino };
  }
  let arr = null; const toques = new Map(); let pinca = null;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    renderer.domElement.setPointerCapture(e.pointerId); toques.set(e.pointerId, [e.clientX, e.clientY]);
    if (toques.size === 2) { const [a, b] = [...toques.values()]; pinca = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), hfov: est.hfov }; arr = null; return; }
    arr = { x: e.clientX, y: e.clientY, yaw: est.yaw, pitch: est.pitch };
    renderer.domElement.classList.add('arrastando'); esconderDica();
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (!toques.has(e.pointerId)) return;
    toques.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinca && toques.size === 2) {
      const [a, b] = [...toques.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      est.hfov = THREE.MathUtils.clamp(pinca.hfov * (pinca.d / Math.max(d, 1)), HFOV.min, HFOV.max); tamanho(); return;
    }
    if (!arr || est.anim) return;
    const k = camera.fov / raiz.clientHeight;      // degrees per pixel: the scene follows the finger
    est.yaw = arr.yaw + (e.clientX - arr.x) * k;
    est.pitch = arr.pitch + (e.clientY - arr.y) * k;
    limita();
  });
  const solta = (e) => { toques.delete(e.pointerId); if (toques.size < 2) pinca = null; if (!toques.size) { arr = null; renderer.domElement.classList.remove('arrastando'); } };
  renderer.domElement.addEventListener('pointerup', solta);
  renderer.domElement.addEventListener('pointercancel', solta);
  renderer.domElement.addEventListener('wheel', (e) => { e.preventDefault(); est.hfov = THREE.MathUtils.clamp(est.hfov * Math.exp(e.deltaY * 0.0012), HFOV.min, HFOV.max); tamanho(); }, { passive: false });
  function tecla(e) {
    if (e.key === 'Escape') { e.preventDefault(); fechar(true); return; }
    const passo = { ArrowLeft: [-6, 0], ArrowRight: [6, 0], ArrowUp: [0, 4], ArrowDown: [0, -4] }[e.key];
    if (passo) { e.preventDefault(); est.yaw -= passo[0]; est.pitch += passo[1]; limita(); }
    const n = parseInt(e.key, 10); if (n >= 1 && n <= man.pontos.length) irPara(man.pontos[n - 1].id);
  }
  window.addEventListener('keydown', tecla);
  raiz.querySelector('.spl-sair').addEventListener('click', () => fechar(true));
  const dica = raiz.querySelector('.spl-dica');
  let dicaFora = false; function esconderDica() { if (!dicaFora) { dicaFora = true; dica.style.opacity = 0; } }
  setTimeout(esconderDica, 6000);

  // floor targets of the other viewpoints, projected each frame
  const v = new THREE.Vector3();
  function atualizaAlvos() {
    const w = raiz.clientWidth, h = raiz.clientHeight;
    alvos.querySelectorAll('.spl-alvo').forEach((a) => {
      const p = PTS[a.dataset.id];
      if (a.dataset.id === est.ponto || est.livre) { a.style.display = 'none'; return; }
      v.set(p.pos[0], 0.02, p.pos[2]).project(camera);
      const vis = v.z < 1 && Math.abs(v.x) < 0.95 && Math.abs(v.y) < 0.95 && camera.position.distanceTo(new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2])) > 0.35;
      a.style.display = vis ? '' : 'none';
      if (vis) { a.style.left = ((v.x + 1) / 2) * w + 'px'; a.style.top = ((1 - v.y) / 2) * h + 'px'; }
    });
  }

  // ---------------------------------------------------------------- loop
  const fps = { n: 0, t0: performance.now(), valor: 0, quadros: [] };
  const ad = { dts: [], ult: 0 };
  renderer.setAnimationLoop((t) => {
    if (est.anim) {
      const a = est.anim, u = Math.min(1, (t - a.t0) / a.dur), s = suave(u);
      est.pos.lerpVectors(a.de.pos, a.para.pos, s);
      est.yaw = a.de.yaw + difAng(a.para.yaw, a.de.yaw) * s;
      est.pitch = a.de.pitch + (a.para.pitch - a.de.pitch) * s;
      if (u >= 1) { est.anim = null; limita(); }
    }
    aplicaCamera();
    renderer.render(scene, camera);
    atualizaAlvos();
    // (B1) adaptive resolution: median frame time over 30 frames > 28 ms -> step down (1.0 -> 0.75 -> 0.6); < 14 ms -> up
    if (pixelRatio == null) {
      if (ad.ult) { ad.dts.push(t - ad.ult); if (ad.dts.length >= 30) {
        const m = ad.dts.sort((a, b) => a - b)[15]; ad.dts = [];
        const passos = [PR_MAX, Math.min(PR_MAX, 0.75), Math.min(PR_MAX, 0.6)];
        let k = passos.indexOf(prAtual); if (k < 0) k = 0;
        if (m > 28 && k < passos.length - 1) k++; else if (m < 14 && k > 0) k--;
        if (passos[k] !== prAtual) { prAtual = passos[k]; renderer.setPixelRatio(prAtual); tamanho(); }
      } }
      ad.ult = t;
    }
    fps.n++; if (t - fps.t0 > 1000) { fps.valor = (fps.n * 1000) / (t - fps.t0); fps.quadros.push(fps.valor); fps.n = 0; fps.t0 = t; }
  });

  try {
    await mesh.initialized;
  } catch (err) {
    carga.querySelector('div').textContent = 'Não foi possível carregar o passeio real neste aparelho.';
    throw err;
  }
  irPara(ponto && PTS[ponto] ? ponto : man.inicio || man.pontos[0].id, true);
  carga.style.opacity = 0; setTimeout(() => carga.remove(), 600);
  raiz.dataset.ready = '1';

  function fechar(avisar) {
    if (est.fechado) return; est.fechado = true;
    renderer.setAnimationLoop(null); ro.disconnect(); window.removeEventListener('keydown', tecla);
    mesh.dispose?.(); spark.dispose?.(); renderer.dispose(); raiz.remove();
    if (atual && atual.api === api) atual = null;
    if (avisar && aoFechar) aoFechar();
  }

  // exact camera of a clip frame (test / evidence only): pose from poses.json (viewer frame, OpenCV axes)
  function poseQuadro(q) {
    est.livre = true; est.anim = null;
    const R = q.R_opencv;     // rows of the matrix; columns = camera x(right), y(down), z(forward) in viewer frame
    const x = new THREE.Vector3(R[0][0], R[1][0], R[2][0]), y = new THREE.Vector3(R[0][1], R[1][1], R[2][1]), z = new THREE.Vector3(R[0][2], R[1][2], R[2][2]);
    camera.position.set(...q.pos);
    camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y.clone().negate(), z.clone().negate()));
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(q.H / 2 / q.fy));
    camera.aspect = (q.W / q.fx) / (q.H / q.fy);
    camera.updateProjectionMatrix();
  }

  const api = {
    irPara, fechar: () => fechar(true), poseQuadro,
    olhar: (yaw, pitch) => { est.yaw = yaw; est.pitch = pitch; limita(); },   // same clamp as a drag
    estado: () => ({ pixelRatio: renderer.getPixelRatio(), ponto: est.ponto, yaw: est.yaw, pitch: est.pitch, fov: camera.fov, arquivo: arq.url || arq.partes.join('+'), gaussianas: arq.gaussianas,
      fps: fps.valor, fpsHistorico: fps.quadros.slice(-30), pos: camera.position.toArray() }),
    renderer, camera, scene, mesh,
  };
  return { api, fechar };
}
