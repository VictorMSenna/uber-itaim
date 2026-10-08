// Sun cycle: shared clock + "hold to move the sun" control + sun section of the unit card.
// Data: src/dados-sol.js (front B3, NOAA positions every 15 min, America/Sao_Paulo, no DST).
import { el } from './util.js';
import { posicaoSolar, fatorDia, fatorLuzesNoite } from './luz-curva.js';

const ESTACOES = [
  ['outono', 'Outono'], ['inverno', 'Inverno'], ['primavera', 'Primavera'], ['verao', 'Verão'],
];
const NOME_EST = Object.fromEntries(ESTACOES);
const DIA = 1440;

export const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
export const fmt = (t) => {
  const m = ((Math.round(t) % DIA) + DIA) % DIA;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const fmtH = (t) => fmt(t).replace(':', 'h');
const dataBR = (iso) => iso.split('-').reverse().slice(0, 2).join('/');
const durTxt = (h) => { const mm = Math.round(h * 60); return `${Math.floor(mm / 60)}h${String(mm % 60).padStart(2, '0')}`; };

export function criarRelogio(SOL, CFG) {
  const C = CFG.sol;
  const passo = SOL.meta.passo_min || 15;
  const st = { est: C.estacaoInicial in SOL.estacoes ? C.estacaoInicial : 'primavera', t: hm(C.horaInicial), segurando: false, arrastando: false, usado: false };
  const subs = new Set();

  function info() {
    const e = SOL.estacoes[st.est];
    const ini = hm(e.inicio);
    const t = st.t;
    const f = (t - ini) / passo;
    // F23: elevation/azimuth at ANY minute (NOAA, same source as B3: matches sol.json within 0.4 deg), so the
    // light follows the twilight bands continuously instead of switching at sunrise/sunset
    const ps = posicaoSolar(e.data, t, SOL.meta.local?.lat, SOL.meta.local?.lon);
    const elv = ps.el, az = ps.az;
    const dia = elv > 0;
    const noite = 1 - fatorDia(elv);          // 0 = full day, 1 = deep night, continuous
    const luzes = fatorLuzesNoite(elv);        // night window/lamp lights, fade over the twilight band
    return { est: st.est, nomeEst: NOME_EST[st.est], data: e.data, t, hora: fmt(t), nascer: e.nascer, por: e.por,
      dia, az, el: elv, noite, luzes, idx: Math.floor(f), segurando: st.segurando || st.arrastando, usado: st.usado };
  }
  const avisar = () => { const i = info(); subs.forEach((fn) => fn(i)); };

  // the cycle stays on the same day of the season: after midnight it wraps back to 00:00 of that day
  function avancar(min) { let t = st.t + min; if (t >= DIA) t -= DIA; st.t = t; }
  let raf = 0, tAnt = 0;
  function passoTempo(dtSeg) {
    const e = SOL.estacoes[st.est];
    const nascer = hm(e.nascer), por = hm(e.por);
    const dia = st.t >= nascer && st.t < por;
    if (dia) {
      const novo = st.t + dtSeg * C.horasPorSegundo * 60;
      st.t = novo >= por ? por : novo; // stop exactly at sunset, night starts next frame
      if (novo >= por) st.t = por + 0.01;
    } else {
      const noiteMin = DIA - por + nascer;
      avancar(dtSeg * noiteMin / C.noiteSegundos);
      const t = st.t;
      const aindaNoite = t >= por || t < nascer;
      if (!aindaNoite) st.t = nascer;
    }
  }
  function loop(now) {
    const dt = Math.min(0.25, (now - tAnt) / 1000);
    tAnt = now;
    passoTempo(dt);
    avisar();
    raf = st.segurando ? requestAnimationFrame(loop) : 0;
  }
  function segurar() {
    if (st.segurando) return;
    st.segurando = true; st.usado = true;
    tAnt = performance.now();
    avisar();
    raf = requestAnimationFrame(loop);
  }
  function soltar() {
    if (!st.segurando) return;
    st.segurando = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    avisar();
  }
  function toqueCurto() {
    st.usado = true;
    const e = SOL.estacoes[st.est];
    const nascer = hm(e.nascer), por = hm(e.por);
    const dia = st.t >= nascer && st.t < por;
    if (dia) { st.t = Math.min(st.t + C.toqueCurtoMin, por + 0.01); } else { st.t = nascer; }
    avisar();
  }
  function estacao(nome) { if (SOL.estacoes[nome]) { st.est = nome; avisar(); } }
  // F5: dragging the sun disc along the arc (t in minutes; only daytime points exist on the arc)
  function arrastar(t, fase) {
    if (fase === 'inicio') { st.arrastando = true; st.usado = true; avisar(); return; }
    if (fase === 'fim') { st.arrastando = false; avisar(); return; }
    if (t != null) { st.t = t; avisar(); }
  }
  function hora(t) { st.t = t; avisar(); }
  return { info, ouvir: (fn) => { subs.add(fn); fn(info()); return () => subs.delete(fn); }, segurar, soltar, toqueCurto, estacao, hora, arrastar, passo, SOL };
}

// ------------------------------------------------------------ the control (used in the 3D, the photo and the card)
export function controleSol(rel, CFG, { compacto = false, desativado = null } = {}) {
  const C = CFG.sol;
  const relogio = el('span', { class: 'sol-hora mono', 'aria-live': 'off' });
  const sub = el('span', { class: 'sol-sub' });
  const dica = el('span', { class: 'sol-dica', text: 'segure para o sol andar' });
  const btn = el('button', { type: 'button', class: 'sol-btn', 'aria-label': 'Segure para o sol andar; toque curto avança 30 minutos' },
    el('span', { class: 'sol-ico', 'aria-hidden': 'true' }), el('span', { class: 'sol-btn-txt', text: 'Segure' }));
  // F22: slim one-row bar. Season = compact select; hour = slider 00:00-24:00 like a volume control (drag the
  // thumb, click the track, arrow keys); "Segure" still animates. Disclaimer lives in the info sheet.
  const est = el('select', { class: 'sol-est', 'aria-label': 'Estação do ano', onchange: (e) => rel.estacao(e.target.value) },
    ...ESTACOES.map(([k, n]) => el('option', { value: k, text: n })));
  const faixa = el('input', { type: 'range', class: 'sol-range', min: 0, max: 1439, step: 1, 'aria-label': 'Hora do dia' });
  const marcas = el('div', { class: 'sol-marcas', 'aria-hidden': 'true' },
    el('i', { class: 'm-nasce' }), el('i', { class: 'm-poe' }), el('span', { class: 'm-txt m0', text: '0h' }), el('span', { class: 'm-txt m12', text: '12h' }), el('span', { class: 'm-txt m24', text: '24h' }));
  const trilho = el('div', { class: 'sol-trilho' }, faixa, marcas);
  let arrastandoFaixa = false;
  // F32b: the drag is ours (linear 0-24 h, like the native range) so it can offer fine control:
  //  - pull the pointer away from the bar (> 36 px vertically) = 1/4 speed
  //  - long-press the thumb (450 ms still) = fine mode, 1 min per 4 px (good on phones)
  const RAIO_POLEGAR = 12;
  let ar = null;
  const minPorPx = () => 1439 / Math.max(1, faixa.getBoundingClientRect().width - 2 * RAIO_POLEGAR);
  const tDoX = (x) => { const r = faixa.getBoundingClientRect(); return ((x - r.left - RAIO_POLEGAR) / Math.max(1, r.width - 2 * RAIO_POLEGAR)) * 1439; };
  const lim = (t) => Math.max(0, Math.min(1439, t));
  const fator = () => (ar.fino ? 0.25 / minPorPx() : 1) * (Math.abs(ar.yUlt - ar.y0) > 36 ? 0.25 : 1);
  faixa.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    try { faixa.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    faixa.focus({ preventScroll: true });
    const tAtual = +faixa.value;
    const xPolegar = (() => { const r = faixa.getBoundingClientRect(); return r.left + RAIO_POLEGAR + (tAtual / 1439) * (r.width - 2 * RAIO_POLEGAR); })();
    const noPolegar = Math.abs(e.clientX - xPolegar) <= RAIO_POLEGAR + 6;
    const t0 = noPolegar ? tAtual : lim(tDoX(e.clientX)); // click on the track = jump there (native behaviour)
    ar = { id: e.pointerId, x0: e.clientX, y0: e.clientY, yUlt: e.clientY, t0, k: 1, fino: false, moveu: false, timer: 0 };
    ar.k = fator();
    ar.timer = setTimeout(() => { if (ar && !ar.moveu) { ar.fino = true; raiz.classList.add('fino'); ar.t0 = +faixa.value; ar.x0 = ar.xUlt ?? ar.x0; ar.k = fator(); } }, 450);
    arrastandoFaixa = true; rel.arrastar(null, 'inicio');
    rel.arrastar(t0, 'movendo');
  });
  faixa.addEventListener('pointermove', (e) => {
    if (!ar || e.pointerId !== ar.id) return;
    if (Math.abs(e.clientX - ar.x0) > 4 || Math.abs(e.clientY - ar.y0) > 4) ar.moveu = true;
    ar.xUlt = e.clientX; ar.yUlt = e.clientY;
    // re-anchor when the speed changes, so the time never jumps
    const k = fator();
    if (k !== ar.k) { ar.t0 = +faixa.value; ar.x0 = e.clientX; ar.k = k; }
    rel.arrastar(lim(ar.t0 + (e.clientX - ar.x0) * minPorPx() * ar.k), 'movendo');
  });
  const fimFaixa = (e) => {
    if (ar && e && e.pointerId !== undefined && e.pointerId !== ar.id) return;
    if (ar) { clearTimeout(ar.timer); ar = null; raiz.classList.remove('fino'); }
    if (arrastandoFaixa) { arrastandoFaixa = false; rel.arrastar(null, 'fim'); }
  };
  faixa.addEventListener('pointerup', fimFaixa);
  faixa.addEventListener('pointercancel', fimFaixa);
  faixa.addEventListener('lostpointercapture', fimFaixa);
  faixa.addEventListener('mousedown', (e) => e.preventDefault()); // no native drag on top of ours
  faixa.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  // keyboard (arrows) keeps the native range behaviour
  faixa.addEventListener('input', () => { if (!ar) rel.arrastar(+faixa.value, 'movendo'); });
  faixa.addEventListener('change', () => { if (!ar) rel.arrastar(null, 'fim'); });
  const raiz = el('div', { class: `sol-ctl slim${compacto ? ' compacto' : ''}`, title: C.rotulo },
    btn, el('div', { class: 'sol-relogio' }, relogio, sub), trilho, est, dica);
  raiz._marcarEstado = (txt) => { sub.textContent = txt; sub.dataset.externo = '1'; };
  if (desativado) { btn.disabled = true; raiz.append(el('p', { class: 'sol-nota', text: desativado })); }

  let t0 = 0, timer = 0, longo = false;
  const iniciar = (e) => {
    if (btn.disabled) return;
    e.preventDefault();
    t0 = performance.now(); longo = false;
    timer = setTimeout(() => { longo = true; rel.segurar(); }, C.toqueCurtoMs);
    try { btn.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
  };
  const parar = () => {
    if (!t0) return;
    clearTimeout(timer);
    if (longo) rel.soltar(); else rel.toqueCurto();
    t0 = 0;
  };
  btn.addEventListener('pointerdown', iniciar);
  btn.addEventListener('pointerup', parar);
  btn.addEventListener('pointercancel', parar);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  // keyboard: hold Space or ArrowRight
  btn.addEventListener('keydown', (e) => {
    if (e.key !== ' ' && e.key !== 'ArrowRight' && e.key !== 'Enter') return;
    e.preventDefault();
    if (!e.repeat) { t0 = performance.now(); longo = false; timer = setTimeout(() => { longo = true; rel.segurar(); }, C.toqueCurtoMs); }
  });
  btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); parar(); } });
  btn.addEventListener('click', (e) => e.preventDefault());

  let estPintada = null;
  const desligar = rel.ouvir((i) => {
    relogio.textContent = i.hora;
    if (!sub.dataset.externo) { // phones show the short form (Victor 08/10: no truncated text; the season is in the selector)
      const curto = raiz.getBoundingClientRect().width < 560;
      sub.textContent = curto ? `${dataBR(i.data)} · sol ${i.nascer}–${i.por}` : `${i.nomeEst} · ${dataBR(i.data)} · nasce ${i.nascer} · põe ${i.por}`;
    }
    dica.hidden = i.usado;
    raiz.classList.toggle('noite', !i.dia);
    raiz.classList.toggle('andando', i.segurando);
    if (est.value !== i.est) est.value = i.est;
    faixa.value = Math.round(i.t);
    faixa.setAttribute('aria-valuetext', i.hora);
    if (estPintada !== i.est) {
      estPintada = i.est;
      // track: night -> dawn -> day -> dusk -> night for this season; ticks at sunrise/sunset
      const pn = (hm(i.nascer) / 1440) * 100, pp = (hm(i.por) / 1440) * 100;
      trilho.style.setProperty('--nasce', pn.toFixed(2) + '%');
      trilho.style.setProperty('--poe', pp.toFixed(2) + '%');
      trilho.style.setProperty('--meio', ((pn + pp) / 2).toFixed(2) + '%');
      marcas.querySelector('.m-nasce').title = `nasce ${i.nascer}`;
      marcas.querySelector('.m-poe').title = `se põe ${i.por}`;
    }
  });
  raiz._desligar = desligar;
  return raiz;
}

// ------------------------------------------------------------ sun section of the unit card
export function secaoSolUnidade(rel, CFG, u) {
  const S = rel.SOL;
  const fin = S.finais[String(u.final)];
  const dadosU = S.unidades[u.numero];
  if (!fin || !dadosU) return el('p', { class: 'sol-nota', text: 'Simulação do sol desta unidade: [falta]' });
  const cx = fin.caixa_planta;
  const W = cx.largura, D = cx.profundidade;
  const PAD = 0.5;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `${-PAD} ${-PAD} ${W + 2 * PAD} ${D + 2 * PAD}`);
  svg.setAttribute('class', 'sol-planta');
  svg.setAttribute('role', 'img');
  const mk = (tag, attrs) => { const n = document.createElementNS(ns, tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); svg.append(n); return n; };
  const vp = fin.abertura?.varanda_prof_m ?? 1.22;
  const lado = fin.sacada_lado; // N: z=0 side · S: z=D · W: x=0 (street) · E: x=W
  const varanda = lado === 'N' ? [0, 0, W, vp] : lado === 'S' ? [0, D - vp, W, vp] : lado === 'W' ? [0, 0, vp, D] : [W - vp, 0, vp, D];
  mk('rect', { x: 0, y: 0, width: W, height: D, class: 'sp-piso' });
  mk('rect', { x: varanda[0], y: varanda[1], width: varanda[2], height: varanda[3], class: 'sp-varanda' });
  const mancha = mk('polygon', { class: 'sp-sol', points: '' });
  mk('rect', { x: 0, y: 0, width: W, height: D, class: 'sp-borda' });
  const tv = mk('text', { x: varanda[0] + varanda[2] / 2, y: varanda[1] + varanda[3] / 2, class: 'sp-txt', 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
  tv.textContent = 'sacada';
  if (lado === 'W' || lado === 'E') tv.setAttribute('transform', `rotate(-90 ${varanda[0] + varanda[2] / 2} ${varanda[1] + varanda[3] / 2})`);

  // mini arc: sun elevation over the day, shaded where the balcony gets direct sun (with neighbours)
  const arco = document.createElementNS(ns, 'svg');
  arco.setAttribute('viewBox', '0 0 160 64');
  arco.setAttribute('class', 'sol-arco');
  const mkA = (tag, attrs) => { const n = document.createElementNS(ns, tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); arco.append(n); return n; };
  const faixas = mkA('g', { class: 'sa-faixas' });
  mkA('line', { x1: 0, y1: 58, x2: 160, y2: 58, class: 'sa-chao' });
  const curva = mkA('polyline', { class: 'sa-curva', points: '' });
  const ponto = mkA('circle', { r: 4, class: 'sa-ponto', cx: -10, cy: -10 });
  const tNasce = mkA('text', { x: 2, y: 63, class: 'sa-txt' });
  const tPoe = mkA('text', { x: 158, y: 63, class: 'sa-txt', 'text-anchor': 'end' });

  const resumo = el('p', { class: 'sol-resumo' });
  const agora = el('span', { class: 'sol-agora' });
  const legenda = el('p', { class: 'sol-nota' });
  let estDesenhada = null;
  const desenharEst = (i) => {
    const e = S.estacoes[i.est];
    const n = e.el.length;
    const nascer = hm(e.nascer), por = hm(e.por), ini = hm(e.inicio);
    const X = (t) => ((t - nascer) / (por - nascer)) * 156 + 2;
    const Y = (elv) => 58 - (Math.max(0, elv) / 90) * 54;
    const pts = [[X(nascer), 58], ...e.el.map((v, k) => [X(ini + k * rel.passo), Y(v)]), [X(por), 58]];
    curva.setAttribute('points', pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' '));
    faixas.replaceChildren();
    const cv = dadosU.est[i.est].cv;
    for (let k = 0; k < cv.length; k++) {
      if (cv[k] !== '1') continue;
      const r = document.createElementNS(ns, 'rect');
      const a = X(ini + k * rel.passo), b = X(ini + (k + 1) * rel.passo);
      r.setAttribute('x', a.toFixed(1)); r.setAttribute('width', Math.max(0.5, b - a).toFixed(1));
      r.setAttribute('y', 4); r.setAttribute('height', 54); r.setAttribute('class', 'sa-faixa');
      faixas.append(r);
    }
    tNasce.textContent = e.nascer; tPoe.textContent = e.por;
    const d = dadosU.est[i.est];
    const ints = d.intervalos.map(([a, b]) => `${fmtH(hm(a))}–${fmtH(hm(b))}`);
    resumo.textContent = ints.length
      ? `Sol na sacada: ${ints.join(' e ')} (~${durTxt(d.horas)}) · ${NOME_EST[i.est]}, ${dataBR(e.data)}`
      : `Sem sol direto na sacada em ${dataBR(e.data)} (${NOME_EST[i.est].toLowerCase()}), pela simulação.`;
    legenda.textContent = `Sacada voltada para ${({ N: 'a fileira 1-3-5-7-9 (noroeste aprox.)', S: 'a fileira 2-4-6-8 (sudeste aprox.)', W: 'a rua (oeste-sudoeste aprox.)', E: 'o lado oposto à rua (leste-nordeste aprox.)' })[lado] || lado}. Planta esquemática do final ${u.final}; mancha = sol direto no piso. ${S.meta.aviso}`;
    estDesenhada = i.est;
    return { X, Y };
  };
  let escala = null;
  const desligar = rel.ouvir((i) => {
    if (estDesenhada !== i.est) escala = desenharEst(i);
    const e = S.estacoes[i.est];
    const cv = dadosU.est[i.est].cv;
    const k = i.idx;
    const temSol = i.dia && k >= 0 && k < cv.length && cv[k] === '1';
    agora.textContent = temSol ? 'sol na sacada agora' : 'sem sol direto agora';
    agora.classList.toggle('sim', temSol);
    const poli = i.dia && k >= 0 ? (fin.mancha[i.est] || [])[Math.min(k, (fin.mancha[i.est] || []).length - 1)] : null;
    mancha.setAttribute('points', temSol && poli ? poli.map(([x, z]) => `${x},${z}`).join(' ') : '');
    if (temSol && !poli) agora.textContent = 'sol na sacada agora (não chega ao piso da sala)';
    if (i.dia) { ponto.setAttribute('cx', escala.X(i.t).toFixed(1)); ponto.setAttribute('cy', escala.Y(i.el).toFixed(1)); } else { ponto.setAttribute('cx', -10); }
    void e;
  });
  const sec = el('section', { class: 'cd-sol' },
    el('h3', { text: 'Sol na unidade (simulação)' }),
    el('div', { class: 'cd-sol-grid' }, svg, el('div', { class: 'cd-sol-dir' }, arco, el('p', { class: 'sol-agora-linha' }, agora))),
    resumo, legenda);
  sec._desligar = desligar;
  return sec;
}

// One line for the unit card: "Sol da manhã · ~1h10 no inverno" (data computed WITH neighbours, sol.json)
const PERIODO = { manha: 'Sol da manhã', tarde: 'Sol da tarde', 'manha e tarde': 'Sol de manhã e à tarde' };
const NA_EST = { outono: 'no outono', inverno: 'no inverno', primavera: 'na primavera', verao: 'no verão' };
export function resumoSolUnidade(SOL, u, est) {
  const d = SOL.unidades[u.numero]?.est?.[est];
  if (!d) return null;
  if (!d.horas || d.horas < 0.1) return `Sem sol direto na sacada ${NA_EST[est]}`;
  const p = PERIODO[d.periodo] || 'Sol na sacada';
  return `${p} · ~${durTxt(d.horas)} ${NA_EST[est]}`;
}
