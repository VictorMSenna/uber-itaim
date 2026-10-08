// Real facade texture for Hugo's building (front B7) on top of the B5 model of src/predio-geo.js, without changing
// its structure: every InstancedMesh keeps its instances, raycast and instanceColor (unit status).
//
//   import { texturizarPredio } from './predio-textura.js';
//   const PB = construirPredio(THREE, { forma });               // as today
//   texturizarPredio(PB, { renderer }).then((r) => { pedirRender(); });   // lazy, ~0.9-3 MB; never throws
//   r.definirNoite(k)        0..1: warm glow on the glass of the units (optional; B1 keeps its own night overlay)
//   r.definirTinta(k)        0..1: strength of the status tint on the units' glass (default 0.85)
//   r.desfazer()             back to the flat B5 colours
//
// How: assets/predio/predio-{2048|4096}.webp is an atlas baked from the drone frames (RGB = facade, delighted per
// orientation; A = ambient occlusion). assets/predio/predio-rects.json gives, per mesh and per instance, the atlas
// rectangle of each of the 6 BoxGeometry faces (0 = no texture: material colour stays). A 6 x N float texture carries
// those rectangles to the vertex shader (gl_InstanceID). Units: the photo is shown and the status colour
// (instanceColor, set by B1 via PB.pintar) tints only its glass-like (dark) pixels, so the selection reads on the glass.
// Safety: if predio-forma.json changed (instance count or first box differ from the bake), that mesh is left untouched.
import * as THREE from 'three';
import { b7Ativo } from './entorno-config.js';

const BASE = new URL('../assets/predio/', import.meta.url).href;

export async function texturizarPredio(PB, { renderer, qualidade = 'auto', mascara = false } = {}) {
  if (!b7Ativo('fachada')) return { aplicado: [], definirNoite() {}, definirTinta() {}, desfazer() {} };
  const grande = qualidade === 'alta' || (qualidade === 'auto' && renderer.capabilities.maxTextureSize >= 4096
    && Math.min(window.screen?.width || 0, window.screen?.height || 0) >= 700 && !/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent));
  const s = grande ? 4096 : 2048;
  let rects, atlas;
  try {
    [rects, atlas] = await Promise.all([
      fetch(BASE + 'predio-rects.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      new THREE.TextureLoader().loadAsync(`${BASE}predio-${s}.webp`),
    ]);
  } catch (e) {
    console.warn('predio-textura: nao carregou, fica a cor do B5', e);
    return { aplicado: [], definirNoite() {}, definirTinta() {}, desfazer() {} };
  }
  // E5 (B1): glass mask (255 = glass) in the same layout; status tint and night light only on the glass
  let texMasc = null;
  if (mascara) {
    try { texMasc = await new THREE.TextureLoader().loadAsync(`${BASE}predio-vidro-${s}.webp`); texMasc.flipY = false; texMasc.colorSpace = THREE.NoColorSpace; }
    catch (e) { console.warn('predio-textura: sem mascara de vidro, fica a regra do escuro', e); }
  }
  // B9 (07/10): sky occlusion baked in Cycles with the city around (piers, slab edges, balcony undersides, lower floors
  // next to the neighbours); optional, grey, same layout as the atlas
  let texAo = null;
  if (!/[?&]aoTorre=0/.test(location.search)) {
    try { texAo = await new THREE.TextureLoader().loadAsync(`${BASE}predio-ao-b9-2048.webp`); texAo.flipY = false; texAo.colorSpace = THREE.NoColorSpace; }
    catch (e) { console.warn('predio-textura: sem AO B9 (fica sem oclusao)', e.message || e); }
  }
  const AO_K = +((/[?&]aoTorreK=([\d.]+)/.exec(location.search) || [0, 0.8])[1]);
  atlas.flipY = false; atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const U = { uNoite: { value: 0 }, uTinta: { value: 0.85 }, uCorPadrao: { value: PB.corPadrao ? PB.corPadrao.clone() : new THREE.Color('#5b6a70') } };
  const aplicado = [], originais = [];
  let rectsUnid = null;
  const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  for (const mesh of PB.grupo.children) {
    if (!mesh.isInstancedMesh) continue;
    const R = rects.malhas[mesh.name];
    if (!R || R.n !== mesh.count) continue;
    // first instance must be the same box as in the bake
    mesh.getMatrixAt(0, m4); m4.decompose(p, q, sc);
    const c = R.primeira, ok = Math.abs(p.x - (c[0] + c[3]) / 2) < 0.02 && Math.abs(p.y - (c[1] + c[4]) / 2) < 0.02 && Math.abs(p.z - (c[2] + c[5]) / 2) < 0.02;
    if (!ok) { console.warn('predio-textura: caixa diferente do bake em', mesh.name); continue; }
    const data = new Float32Array(R.rects);
    if (!data.some((v) => v > 0)) continue;
    const tex = new THREE.DataTexture(data, 6, R.n, THREE.RGBAFormat, THREE.FloatType);
    tex.needsUpdate = true;
    const unid = mesh.name === 'predio-unidades';
    if (unid) rectsUnid = tex;
    if (!mesh.geometry.attributes.uvB) mesh.geometry.setAttribute('uvB', mesh.geometry.attributes.uv.clone());
    const mat = mesh.material.clone();
    const limpa = mesh.material.color.clone(); // E5c (B1): clean colour used up close (LOD by distance)
    mat.color.set(0xffffff);
    mat.onBeforeCompile = (sh) => {
      mat.userData.compilado = true; // F45 test hook
      Object.assign(sh.uniforms, U, { uAtlas: { value: atlas }, uRects: { value: tex }, uMascara: { value: texMasc }, uLimpa: { value: limpa }, uAoB9: { value: texAo }, uAoK: { value: texAo ? AO_K : 0 } });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 uvB; uniform sampler2D uRects; varying vec2 vUvA; varying float vTem; varying vec2 vUvB;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          int fB = abs(normal.x) > 0.5 ? (normal.x > 0.0 ? 0 : 1) : (abs(normal.y) > 0.5 ? (normal.y > 0.0 ? 2 : 3) : (normal.z > 0.0 ? 4 : 5));
          vec4 rB = texelFetch(uRects, ivec2(fB, gl_InstanceID), 0);
          vTem = rB.z > 0.0 ? 1.0 : 0.0;
          vUvA = rB.xy + vec2(uvB.x, 1.0 - uvB.y) * rB.zw;
          vUvB = uvB;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D uAtlas; uniform sampler2D uMascara; uniform float uNoite; uniform float uTinta; uniform vec3 uCorPadrao; uniform vec3 uLimpa;
          varying vec2 vUvA; varying float vTem; varying vec2 vUvB;
          uniform sampler2D uAoB9; uniform float uAoK;
          float aoB9() { return uAoK > 0.0 ? mix(1.0, texture2D(uAoB9, vUvA).r, uAoK) : 1.0; }   // B9
          // E5c (B1): the drone photo is too coarse up close: clean colours below ~65 m, photo above ~75 m
          float lodFoto() { return 0.0; } // Victor (07/10, real phone): the drone photo reads as stains at every distance -> clean materials always`)
        .replace('#include <color_fragment>', unid ? `
          #include <color_fragment>
          vec3 corEstado = vec3(1.0);
          #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
            corEstado = vColor.rgb;
          #endif
          if (vTem > 0.5) {
            vec4 tA = texture2D(uAtlas, vUvA);
            float lA = dot(tA.rgb, vec3(0.2126, 0.7152, 0.0722));
            float temEstado = step(0.04, distance(corEstado, uCorPadrao));
            ${texMasc ? `
            // E5 (B1): glass from the mask; the status colour REPLACES most of the glass (F38: green / grey / amber
            // must read at a glance), a little of the photo stays for the reflections; frames and piers = photo
            float vidro = smoothstep(0.35, 0.65, texture2D(uMascara, vUvA).r);
            vec3 foto = tA.rgb * mix(0.55, 1.0, tA.a);
            vec3 vidroEstado = corEstado * (0.78 + 0.5 * lA);
            vec3 longe = mix(foto, vidroEstado, vidro * uTinta * temEstado);
            vec2 q = vUvB;
            float borda = step(q.x, 0.018) + step(0.982, q.x) + step(q.y, 0.03) + step(0.97, q.y);
            float mul = 1.0 - step(0.006, abs(fract(q.x * 4.0 + 0.5) - 0.5) / 4.0);
            float tr = 1.0 - step(0.008, abs(q.y - 0.86));
            float quadro = clamp(borda + mul + tr, 0.0, 1.0);
            vec3 perto = mix(mix(vec3(0.05, 0.07, 0.08), corEstado, 0.92), vec3(0.17, 0.19, 0.2), quadro);
            diffuseColor.rgb = mix(perto, longe, lodFoto());
            diffuseColor.rgb *= mix(1.0, aoB9(), 0.6);   // B9: lighter on the units (the status colours must read)` : `
            float vidro = 1.0 - smoothstep(0.12, 0.55, lA);
            vec3 tinta = mix(vec3(1.0), corEstado * 2.6, uTinta * mix(0.35, 1.0, vidro) * temEstado);
            diffuseColor.rgb = tA.rgb * tinta * mix(0.55, 1.0, tA.a) * mix(1.0, aoB9(), 0.6);`}
          }` : `
          #include <color_fragment>
          if (vTem > 0.5) { vec4 tA = texture2D(uAtlas, vUvA); diffuseColor.rgb = mix(uLimpa, tA.rgb * mix(0.55, 1.0, tA.a), lodFoto()) * aoB9(); }`)
        .replace('#include <emissivemap_fragment>', unid ? `#include <emissivemap_fragment>
          if (vTem > 0.5 && uNoite > 0.0) { float lB = dot(texture2D(uAtlas, vUvA).rgb, vec3(0.2126, 0.7152, 0.0722));
            totalEmissiveRadiance += 0.0 * lB; } // orq 07/10: no photo-based night glow (amber lines on piers/slabs)` : '#include <emissivemap_fragment>');
    };
    mat.customProgramCacheKey = () => 'b7-predio-' + (unid ? 'u' : 'v') + (texMasc ? 'm' : '') + (texAo ? 'a' : '');
    mat.userData.atlas = atlas; mat.userData.mascara = texMasc; // F45 test hook
    originais.push([mesh, mesh.material]);
    mesh.material = mat;
    aplicado.push(mesh.name);
  }
  // glass railings: the photo already shows the glass, so the B5 green panel becomes a light film
  const vidro = PB.grupo.children.find((m) => m.name === 'predio-vidro');
  if (vidro && aplicado.length) { originais.push([vidro, vidro.material]); vidro.material = vidro.material.clone(); vidro.material.color.set('#3f6b66'); vidro.material.opacity = 0.45; } // E5c: teal glass guard
  return {
    aplicado,
    definirNoite(k) { U.uNoite.value = k; },
    definirTinta(k) { U.uTinta.value = k; },
    // E5 (B1): restrict a night overlay (one instance per unit, SAME instance order as PB's units mesh) to the glass
    mascararMaterial(material) {
      if (!texMasc || !rectsUnid) return false;
      material.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, { uRects: { value: rectsUnid }, uMascara: { value: texMasc } });
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nuniform sampler2D uRects; varying vec2 vUvM; varying float vTemM; varying vec3 vViewPositionM; varying vec2 vUvQ;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            int fM = abs(normal.x) > 0.5 ? (normal.x > 0.0 ? 0 : 1) : (abs(normal.y) > 0.5 ? (normal.y > 0.0 ? 2 : 3) : (normal.z > 0.0 ? 4 : 5));
            vec4 rM = texelFetch(uRects, ivec2(fM, gl_InstanceID), 0);
            vTemM = rM.z > 0.0 ? 1.0 : 0.0;
            vUvM = rM.xy + vec2(uv.x, 1.0 - uv.y) * rM.zw;`)
          .replace('#include <project_vertex>', `#include <project_vertex>
            vViewPositionM = -mvPosition.xyz; vUvQ = uv;`);
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform sampler2D uMascara; varying vec2 vUvM; varying float vTemM; varying vec3 vViewPositionM; varying vec2 vUvQ;')
          .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
            if (vTemM > 0.5) {
              float mk = smoothstep(0.25, 0.5, texture2D(uMascara, vUvM).r);
              vec2 qM = vUvQ; float bordaM = step(qM.x, 0.018) + step(0.982, qM.x) + step(qM.y, 0.03) + step(0.97, qM.y);
              float pertoM = 1.0 - clamp(bordaM, 0.0, 1.0);
              diffuseColor.a *= pertoM; // clean doors at every distance: the whole pane lights (mask holes never show)
            }`);
      };
      material.customProgramCacheKey = () => 'b1-noite-mascara';
      material.needsUpdate = true;
      return true;
    },
    desfazer() { for (const [m, mt] of originais) m.material = mt; },
  };
}
