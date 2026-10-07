// B1 (07/10): B6's baked interior (W1) loaded on top of the procedural plan, behind the `interiorBake` flag.
//   - file: assets/interior/b6/interior_b6.glb.json  ({ b64: <GLB bytes> }; never .glb: the Artifact host does not serve it)
//   - frame (B6 meta): glTF x = u_s, y = h, z = v  ->  B4 plan u = W - u_s (same transform as F28), placed inside the
//     plan group, which applies the mirroring of finals 4/5/7.
//   - the bake is daylight-only (sky through the window, fixtures off) stored as emissive; we keep it as emissive scaled
//     by daylight AND use it as base colour so our sun and lamps add on top (additive layers).
//   - the procedural meshes stay for the shadow map only (no colour, no depth); glass stays ours.
//   - any failure -> returns null and the procedural interior is left untouched (fallback).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const URL_BAKE = new URL('../assets/interior/b6/interior_b6.glb.json', import.meta.url).href;
const DRACO = 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/libs/draco/gltf/';
let cache = null;

async function baixar() {
  const r = await fetch(URL_BAKE);
  if (!r.ok) throw new Error('bake HTTP ' + r.status);
  const j = await r.json();
  const bin = atob(j.base64 || j.b64); // B6 writes { nome, mime, base64 }; B7 writes { b64 }
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const loader = new GLTFLoader();
  const draco = new DRACOLoader(); draco.setDecoderPath(DRACO);
  loader.setDRACOLoader(draco);
  const gltf = await new Promise((ok, erro) => loader.parse(u8.buffer, '', ok, erro));
  draco.dispose();
  return gltf.scene;
}

export async function aplicarBake(planta, { W }) {
  try {
    if (!cache) cache = baixar().catch((e) => { cache = null; throw e; });
    const src = await cache;
    const bake = src.clone(true);
    bake.name = 'interior-bake-b6';
    bake.scale.x = -1; bake.position.x = W;            // u = W - u_s
    const mats = [];
    bake.traverse((o) => {
      if (o.isLight || /^luz_/.test(o.name)) { o.visible = false; return; } // our own lamps are used
      if (!o.isMesh) return;
      const m = o.material.clone();
      m.map = m.emissiveMap;                            // base colour = the bake, so our lights add on top
      m.color = new THREE.Color(0.55, 0.55, 0.55);
      m.side = THREE.DoubleSide;
      m.roughness = 0.85; m.metalness = 0;
      o.material = m; o.castShadow = false; o.receiveShadow = true;
      mats.push(m);
    });
    // procedural meshes: shadow casters only (glass and lenses stay visible)
    for (const [k, m] of Object.entries(planta.malhas)) {
      if (['vidro', 'lente', 'lenteCoz', 'lenteOff'].includes(k)) continue;
      m.material = m.material.clone(); m.material.colorWrite = false; m.material.depthWrite = false;
    }
    // our print art (quadro_N_arte planes) goes onto B6's frames (inventory: base 1.136 m, height 0.571 m; our
    // procedural frames sit at 1.50-2.07 m): the test bake has empty (black) frames
    planta.grupo.children.filter((c) => /^quadro_\d_arte$/.test(c.name)).forEach((c) => { c.position.y += (1.136 + 0.571 / 2) - (1.50 + 2.07) / 2; });
    planta.grupo.add(bake);
    return {
      bake,
      // dia: 1 day .. 0 night (the bake holds daylight only)
      definirDia(dia) { for (const m of mats) m.emissiveIntensity = 0.04 + 0.96 * dia; },
    };
  } catch (e) {
    console.warn('interior bake B6: nao carregou, fica o interior procedural', e);
    return null;
  }
}
