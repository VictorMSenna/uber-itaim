// Front B7 switch (one place for B1): real surroundings and real facade texture of the tower.
// false = the app keeps the previous look (grey blocks / flat B5 colours); the modules become no-ops.
// URL override for tests: ?entorno=1|0  ?entornoFora=1|0  ?fachada=1|0  ?interiorBake=1|0 (B6's baked interior, W1)
// entorno = view from the windows (interior); entornoFora = outside model (also raises the camera to a drone angle);
// fachada = photo texture on the tower (B1 integration 06/10: see docs/RODADA2.md for the choice).
export const PADRAO_B7 = { entorno: true, entornoFora: true, fachada: true, interiorBake: false, interiorProcedural: false }; // interiorProcedural: the 3D-modelled interior (off: 'The Sims', Victor 07/10) // E5 (07/10 00:5x): photo facade + glass mask ON (F38 readability checked in crops)
export function b7Ativo(chave) {
  try {
    const v = new URLSearchParams(location.search).get(chave);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch (e) { /* no location (worker) */ }
  return !!PADRAO_B7[chave];
}
