// Faithful building volume of the Uber Itaim, built procedurally from dados/predio-forma.json (front B5).
// Measured from the drone footage (COLMAP + photo pose); see docs/RELATORIO-B5-forma.md.
//
//   import { construirPredio } from './predio-geo.js';
//   const { grupo, unidades, pecas } = construirPredio(THREE, { forma });
//   scene.add(grupo);
//   unidades.get('10-7') -> { mesh, instancia, centro: Vector3, normal: Vector3, caixa: Box3, dados }
//
// Units are ONE InstancedMesh (117 instances, instanceColor set; raycast returns instanceId). Everything else is
// grouped by material into InstancedMesh of a unit cube (+1 for the cylinder ducts), so the whole building costs
// about 15 draw calls. Glass uses plain opacity (no transmission). Axes = dados/predio.json (x away from the street,
// y up from the sidewalk, z from the 1-3-5-7-9 row to the 2-4-6-8 row).

export function construirPredio(THREE, { forma, materiais = {}, sombras = true, linhas = false } = {}) {
  if (!forma) throw new Error('construirPredio: forma (dados/predio-forma.json) is required');
  const N = forma.niveis;
  const LAJE = N.espessura_laje;
  const GC = N.guarda_corpo;
  const nivel = (k) => N.lajes[k - 1];

  // ---------- materials (overridable: materiais[nome] = THREE.Material | color string)
  const mats = {};
  for (const [nome, m] of Object.entries(forma.materiais)) {
    const o = materiais[nome];
    if (o && o.isMaterial) { mats[nome] = o; continue; }
    const vidro = nome === 'vidro';
    mats[nome] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(typeof o === 'string' ? o : m.cor),
      roughness: m.rugosidade ?? 0.9,
      metalness: m.metal ?? 0,
      transparent: vidro,
      opacity: vidro ? (m.opacidade ?? 0.4) : 1,
      depthWrite: !vidro,
    });
    mats[nome].name = 'predio-' + nome;
  }

  // ---------- collect boxes per material
  const caixas = {}; // nome -> [[x0,y0,z0,x1,y1,z1], ...]
  const add = (mat, c) => { (caixas[mat] ||= []).push(c); };
  for (const v of forma.volumes) add(v.material, v.caixa);
  for (const p of forma.pilares) add(p.material, p.caixa);
  for (const k of forma.lajes_internas.niveis) {
    const y = nivel(k);
    for (const [x0, z0, x1, z1] of forma.lajes_internas.retangulos_xz) add(forma.lajes_internas.material, [x0, y - LAJE, z0, x1, y, z1]);
  }
  for (const v of forma.varandas) {
    const [x0, z0, x1, z1] = v.laje;
    for (const k of v.niveis) {
      const y = nivel(k);
      add('pedra', [x0, y - LAJE, z0, x1, y, z1]);
      let g;
      if (v.guarda === 'z0') g = [x0 + 0.05, y, z0 + 0.03, x1 - 0.05, y + GC, z0 + 0.07];
      else if (v.guarda === 'z1') g = [x0 + 0.05, y, z1 - 0.07, x1 - 0.05, y + GC, z1 - 0.03];
      else g = [x0 + 0.03, y, z0 + 0.05, x0 + 0.07, y + GC, z1 - 0.05];
      add('vidro', g);
      // dark handrail on top of the glass
      add('metal', [g[0] - 0.01, y + GC - 0.04, g[2] - 0.01, g[3] + 0.01, y + GC + 0.01, g[5] + 0.01]);
    }
  }
  // glass railing on the west-wing roof terrace (above the stone parapet)
  {
    const y0 = forma.medidas.ala_oeste_parapeito_topo_y.valor, y1 = forma.medidas.ala_oeste_guarda_corpo_topo_y.valor;
    const z0 = forma.medidas.ala_oeste_parede_norte_z.valor, z1 = forma.medidas.ala_oeste_parede_sul_z.valor;
    const xe = forma.medidas.bloco_central_x0.valor - 1.5;
    add('vidro', [0.08, y0, z0 + 0.05, 0.14, y1, z1 - 0.05]);
    add('vidro', [0.1, y0, z0 + 0.08, xe, y1, z0 + 0.14]);
    add('vidro', [0.1, y0, z1 - 0.14, xe, y1, z1 - 0.08]);
  }

  const grupo = new THREE.Group();
  grupo.name = 'predio-b5';
  const cubo = new THREE.BoxGeometry(1, 1, 1);
  const tmpM = new THREE.Matrix4(), tmpP = new THREE.Vector3(), tmpS = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
  const matriz = (c) => tmpM.compose(
    tmpP.set((c[0] + c[3]) / 2, (c[1] + c[4]) / 2, (c[2] + c[5]) / 2), tmpQ,
    tmpS.set(Math.max(Math.abs(c[3] - c[0]), 1e-3), Math.max(Math.abs(c[4] - c[1]), 1e-3), Math.max(Math.abs(c[5] - c[2]), 1e-3)));
  const semRaio = () => {};
  const pecas = {};
  // opaque first, glass last (transparent objects are sorted after opaque by three anyway)
  for (const [nome, lista] of Object.entries(caixas)) {
    const mat = mats[nome];
    if (!mat) throw new Error('construirPredio: material sem definicao: ' + nome);
    const mesh = new THREE.InstancedMesh(cubo, mat, lista.length);
    lista.forEach((c, i) => mesh.setMatrixAt(i, matriz(c)));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    const vidro = nome === 'vidro';
    mesh.castShadow = sombras && !vidro && nome !== 'piscina';
    mesh.receiveShadow = sombras;
    mesh.raycast = semRaio;
    mesh.name = 'predio-' + nome;
    if (vidro) mesh.renderOrder = 2;
    grupo.add(mesh);
    pecas[nome] = mesh;
  }

  // ducts (chimneys): one instanced cylinder mesh
  if (forma.dutos?.length) {
    const cil = new THREE.CylinderGeometry(1, 1, 1, 14);
    const mesh = new THREE.InstancedMesh(cil, mats.metal, forma.dutos.length * 2);
    forma.dutos.forEach((d, i) => {
      mesh.setMatrixAt(i * 2, tmpM.compose(tmpP.set(d.x, (d.y0 + d.y1) / 2, d.z), tmpQ, tmpS.set(d.r, d.y1 - d.y0, d.r)));
      mesh.setMatrixAt(i * 2 + 1, tmpM.compose(tmpP.set(d.x, d.y1 + 0.06, d.z), tmpQ, tmpS.set(d.r * 1.45, 0.12, d.r * 1.45)));
    });
    mesh.castShadow = sombras; mesh.receiveShadow = sombras; mesh.raycast = semRaio; mesh.name = 'predio-dutos';
    mesh.computeBoundingSphere();
    grupo.add(mesh);
    pecas.dutos = mesh;
  }

  // ---------- units (pickable)
  const ids = Object.keys(forma.unidades);
  const meshU = new THREE.InstancedMesh(cubo, mats.unidade, ids.length);
  meshU.name = 'predio-unidades';
  const corPadrao = new THREE.Color(forma.materiais.unidade.cor);
  const unidades = new Map();
  ids.forEach((id, i) => {
    const d = forma.unidades[id];
    meshU.setMatrixAt(i, matriz(d.caixa));
    meshU.setColorAt(i, corPadrao);
    const c = d.caixa;
    unidades.set(id, {
      mesh: meshU,
      instancia: i,
      centro: new THREE.Vector3(...d.centro),
      normal: new THREE.Vector3(...d.normal),
      caixa: new THREE.Box3(new THREE.Vector3(c[0], c[1], c[2]), new THREE.Vector3(c[3], c[4], c[5])),
      dados: d,
    });
  });
  meshU.instanceMatrix.needsUpdate = true;
  meshU.instanceColor.needsUpdate = true;
  meshU.computeBoundingSphere();
  meshU.castShadow = sombras;
  meshU.receiveShadow = sombras;
  meshU.userData.ids = ids; // instanceId -> unit id
  grupo.add(meshU);
  pecas.unidades = meshU;

  // optional silhouette lines (1 extra draw call): edges of the big volumes only
  if (linhas) {
    const base = new THREE.EdgesGeometry(cubo).attributes.position.array;
    const grandes = forma.volumes.filter((v) => {
      const c = v.caixa; return (c[3] - c[0]) * (c[4] - c[1]) * (c[5] - c[2]) > 4;
    });
    const pos = new Float32Array(grandes.length * base.length);
    const v3 = new THREE.Vector3();
    grandes.forEach((v, k) => {
      const m = matriz(v.caixa).clone();
      for (let i = 0; i < base.length; i += 3) { v3.set(base[i], base[i + 1], base[i + 2]).applyMatrix4(m); pos.set([v3.x, v3.y, v3.z], k * base.length + i); }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x2b2725, transparent: true, opacity: 0.35 }));
    l.raycast = semRaio; l.name = 'predio-linhas';
    grupo.add(l);
    pecas.linhas = l;
  }

  const caixaTotal = new THREE.Box3().setFromObject(grupo);
  return {
    grupo,
    unidades,
    pecas,
    materiais: mats,
    caixa: caixaTotal,
    idDaInstancia: (i) => ids[i],
    pintar(id, cor) { const u = unidades.get(id); if (!u) return; meshU.setColorAt(u.instancia, cor); meshU.instanceColor.needsUpdate = true; },
    corPadrao,
  };
}
