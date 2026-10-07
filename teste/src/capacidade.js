// What this device can hold (Victor 07/10, after the Google 3D crash on his Samsung M21s: "seria legal se ele pudesse
// identificar e dar o que cada um aguenta"). One tier for the whole page, decided once from what the browser reports:
//   navigator.deviceMemory (GB, rounded down to a power of 2 and capped at 8 by Chrome; Safari does not report it),
//   phone or not, the GPU name (WEBGL_debug_renderer_info) and the largest texture.
// Measured 07/10 on the test Chrome (phone emulation): outside view with Google ~600 MB of tiles; 360 + Google renderer
// process 1.4 GB before the CPU copies were dropped. ?nivel=topo|medio|leve forces a tier (tests).
//   topo  : the maximum (8 GB+ phones, iPhones, computers)
//   medio : 4-6 GB phones and mid GPUs (Mali G5x/G7x, Adreno 5xx/6xx below 640, PowerVR): smaller tile budget, a bit less
//           Google detail, 360 layers at 2048, screen density up to 2
//   leve  : 2 GB or less / old GPU: no Google city (our city only), 360 at 2048, density up to 1.5
let cache = null;
export function capacidade() {
  if (cache) return cache;
  const q = new URLSearchParams(location.search).get('nivel');
  const movel = /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent);
  const ios = /iPhone|iPad/i.test(navigator.userAgent);
  const mem = navigator.deviceMemory || (ios ? 6 : 8);
  let gpu = '', maxTex = 4096;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (gl) {
      maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
      const perde = gl.getExtension('WEBGL_lose_context'); if (perde) perde.loseContext();
    }
  } catch (e) { /* no WebGL info: decide by memory only */ }
  const adreno = /Adreno \(TM\) (\d{3})/i.exec(gpu);
  const gpuMedia = /Mali-G(5\d|7[0-7])\b|Mali-T|PowerVR|Adreno \(TM\) [345]\d\d/i.test(gpu) || (adreno && +adreno[1] < 640);
  let nivel = 'topo';
  if (movel && (mem <= 2 || maxTex < 4096)) nivel = 'leve';
  else if (movel && !ios && (mem <= 4 || gpuMedia)) nivel = 'medio';
  if (q === 'topo' || q === 'medio' || q === 'leve') nivel = q;
  const T = {
    topo: { google: true, tilesMB: movel ? (ios ? 500 : 700) : 1200, erro360: 16, larguraPano: 4096, dprMax: 3, parse: movel ? 3 : 8 },
    medio: { google: true, tilesMB: 260, erro360: 24, larguraPano: 2048, dprMax: 2, parse: 2 },
    leve: { google: false, tilesMB: 0, erro360: 32, larguraPano: 2048, dprMax: 1.5, parse: 1 },
  }[nivel];
  cache = { nivel, movel, mem, gpu, maxTex, ...T };
  if (typeof window !== 'undefined') window.__capacidade = cache;
  return cache;
}
