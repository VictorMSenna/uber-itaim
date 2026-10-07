// Light mixing on a fixed viewpoint (front B4, F14).
// Light is additive: image = base + sum over lights that are ON of (contribution of that light), in LINEAR space.
// Two kinds of layer for the same component:
//   tipo 'foto'        : a real photo with ONLY that light on, same camera and fixed exposure as the base photo
//                        (contribution = max(foto_luz - foto_apagada, 0)). Used only to CHECK colours/strength
//                        if Hugo ever sends light-by-light photos (docs/ROTEIRO-CAPTURA-INTERIOR.md item 3).
//   tipo 'irradiancia' : a SIMULATED layer (irradiance of that light rendered from the calibrated camera of the
//                        photo); contribution = reflectance estimated from the photo itself x irradiance x colour.
// GLSL chunk shared with src/interior-fotos.js; criarMixLuzes() is a standalone full-screen material for 'foto' layers.
import * as THREE from 'three';

export const MAX_CAMADAS = 6;

export const GLSL_LUZES = /* glsl */`
uniform sampler2D uCam0, uCam1, uCam2, uCam3, uCam4, uCam5;
uniform float uPeso[${MAX_CAMADAS}];
uniform vec3 uCor[${MAX_CAMADAS}];
uniform int uTipo[${MAX_CAMADAS}];   // 0 = foto (difference to the base), 1 = irradiancia (x reflectance)
uniform int uN;
vec3 camada(int i, vec2 uv) {
  if (i == 0) return texture2D(uCam0, uv).rgb;
  if (i == 1) return texture2D(uCam1, uv).rgb;
  if (i == 2) return texture2D(uCam2, uv).rgb;
  if (i == 3) return texture2D(uCam3, uv).rgb;
  if (i == 4) return texture2D(uCam4, uv).rgb;
  return texture2D(uCam5, uv).rgb;
}
vec3 somaLuzes(vec2 uv, vec3 baseLin, vec3 refl) {
  vec3 s = vec3(0.0);
  for (int i = 0; i < ${MAX_CAMADAS}; i++) {
    if (i >= uN) break;
    if (uPeso[i] <= 0.0) continue;
    vec3 c = camada(i, uv);
    vec3 contrib = uTipo[i] == 0 ? max(c - baseLin, vec3(0.0)) : refl * c.r * uCor[i];
    s += uPeso[i] * contrib;
  }
  return s;
}`;

export function uniformsLuzes(camadas) {
  const vazio = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  vazio.needsUpdate = true;
  const u = {
    uPeso: { value: new Array(MAX_CAMADAS).fill(0) },
    uCor: { value: Array.from({ length: MAX_CAMADAS }, () => new THREE.Color(1, 1, 1)) },
    uTipo: { value: new Array(MAX_CAMADAS).fill(1) },
    uN: { value: Math.min(camadas.length, MAX_CAMADAS) },
  };
  for (let i = 0; i < MAX_CAMADAS; i++) u[`uCam${i}`] = { value: camadas[i]?.textura || vazio };
  camadas.slice(0, MAX_CAMADAS).forEach((c, i) => {
    u.uTipo.value[i] = c.tipo === 'foto' ? 0 : 1;
    if (c.cor) u.uCor.value[i].copy(c.cor);
    u.uPeso.value[i] = c.ligada ? (c.ganho ?? 1) : 0;
  });
  return { u, vazio };
}

// Standalone mixer for REAL light-by-light photos (tipo 'foto'): base = photo with everything off.
export function criarMixLuzes({ base, camadas }) {
  const { u, vazio } = uniformsLuzes(camadas);
  const material = new THREE.ShaderMaterial({
    uniforms: { uBase: { value: base }, ...u },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `varying vec2 vUv; uniform sampler2D uBase; ${GLSL_LUZES}
      void main(){ vec3 b = texture2D(uBase, vUv).rgb; vec3 c = b + somaLuzes(vUv, b, vec3(0.0));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
    depthTest: false, depthWrite: false,
  });
  const idx = Object.fromEntries(camadas.map((c, i) => [c.nome, i]));
  return {
    material,
    definirLuz(nome, ligada, ganho = 1) { const i = idx[nome]; if (i != null) u.uPeso.value[i] = ligada ? ganho : 0; },
    dispose() { material.dispose(); vazio.dispose(); },
  };
}
