// Photo tour of the furnished studio (photos of apartment 31), opened from the unit card.
import { el, texto } from './util.js';

const FOTOS = [
  { f: '00-entrada', amb: 'entrada', t: 'Porta do apartamento' },
  { f: '01-sala', amb: 'sala', t: 'Sala, cozinha e porta da varanda' },
  { f: '02-cozinha', amb: 'cozinha', t: 'Cozinha' },
  { f: '03-cozinha', amb: 'cozinha', t: 'Cozinha: bancada e geladeira' },
  { f: '04-cozinha', amb: 'cozinha', t: 'Cozinha e mesa' },
  { f: '05-sala-quarto', amb: 'sala', t: 'Sala e quarto integrados' },
  { f: '06-quarto', amb: 'sala', t: 'Quarto visto da cama' },
  { f: '07-quarto', amb: 'sala', t: 'Quarto e cozinha' },
  { f: '08-quarto', amb: 'sala', t: 'Cama e sofá' },
  { f: '09-quarto', amb: 'sala', t: 'Porta da varanda' },
  { f: '10-varanda', amb: 'varanda', t: 'Varanda · a vista muda por andar e posição' },
  { f: '11-varanda', amb: 'varanda', t: 'Vista da varanda · muda por andar e posição' },
  { f: '12-closet', amb: 'closet', t: 'Armário' },
  { f: '13-banheiro', amb: 'banheiro', t: 'Banheiro' },
  { f: '14-banheiro', amb: 'banheiro', t: 'Banheiro: pia' },
  { f: '15-banheiro', amb: 'banheiro', t: 'Banheiro: pia e vaso' },
  { f: '16-banheiro', amb: 'banheiro', t: 'Banheiro: chuveiro' },
];
// hotspot positions in % of the final-6 drawing (assets/planta/planta-final-6.webp)
const PONTOS = [
  { amb: 'entrada', rot: 'Entrada', x: 30, y: 6 },
  { amb: 'cozinha', rot: 'Cozinha', x: 13, y: 22 },
  { amb: 'banheiro', rot: 'Banheiro', x: 73, y: 18 },
  { amb: 'sala', rot: 'Sala e quarto', x: 48, y: 58 },
  { amb: 'varanda', rot: 'Varanda', x: 48, y: 92 },
];
const GRUPOS = [
  ['entrada', 'Entrada'], ['sala', 'Sala e quarto'], ['cozinha', 'Cozinha'],
  ['varanda', 'Varanda'], ['closet', 'Armário'], ['banheiro', 'Banheiro'],
];
const VIDEOS = [
  { f: 'clip-5114', t: 'Sala e quarto (6 s)' },
  { f: 'clip-5104', t: 'Cama e sofá (9 s)' },
];
const COMUNS = [
  { f: 'comum-5099', t: 'Mercadinho na garagem' },
  { f: 'comum-5101', t: 'Espaço gourmet' },
];

const $ = (s, r = document) => r.querySelector(s);
let montado = false;
let voltarFoco = null;

function legenda(cfg) {
  return el('p', { class: 'tour-legenda' }, el('b', { text: cfg.tour.legenda }), ` · fotos de ${cfg.tour.dataFotos}`);
}

function montar(cfg) {
  const t = $('#tour');
  const corpo = $('#tour-corpo');
  const planta = el('div', { class: 'tour-planta' },
    el('img', { src: 'assets/planta/planta-final-6.webp', alt: 'Planta ilustrativa do studio, final 6', width: 700, height: 900, loading: 'lazy' }),
    ...PONTOS.map((p) => el('button', {
      type: 'button', class: 'ponto', style: `left:${p.x}%;top:${p.y}%`,
      onclick: () => abrirFoto(cfg, FOTOS.findIndex((x) => x.amb === p.amb)),
      'aria-label': `Fotos: ${p.rot}`,
    }, el('span', { class: 'ponto-dot', 'aria-hidden': 'true' }), el('span', { class: 'ponto-rot', text: p.rot }))));
  const grupos = GRUPOS.map(([amb, nome]) => el('section', { class: 'tour-grupo' },
    el('h3', { text: nome }),
    el('div', { class: 'tour-minis' }, ...FOTOS.map((x, i) => (x.amb !== amb ? null : el('button', {
      type: 'button', class: 'mini', onclick: () => abrirFoto(cfg, i), 'aria-label': `Abrir foto: ${x.t}`,
    }, el('img', { src: `assets/tour/${x.f}-mini.webp`, alt: '', width: 240, height: 160, loading: 'lazy' })))))));
  corpo.replaceChildren(
    legenda(cfg),
    el('p', { class: 'tour-nota', text: 'Toque num ponto da planta ou numa foto. A planta é a do final 6 (ilustrativa); as fotos são de um studio do prédio, com a mesma mobília dos studios.' }),
    el('div', { class: 'tour-cols' }, planta, el('div', { class: 'tour-grupos' }, ...grupos)),
    el('section', { class: 'tour-videos' },
      el('h3', { text: 'Vídeos curtos' }),
      el('p', { class: 'tour-nota' }, texto(cfg.tour.legendaVideo)),
      el('div', { class: 'tour-vids' }, ...VIDEOS.map((v) => el('figure', {},
        el('video', { src: `assets/tour/${v.f}.mp4`, poster: `assets/tour/${v.f}-poster.webp`, preload: 'none', controls: true, muted: true, playsinline: true, width: 540, height: 960 }),
        el('figcaption', { text: v.t }))))),
    el('section', { class: 'tour-comuns' },
      el('h3', { text: 'Áreas comuns' }),
      el('p', { class: 'tour-nota', text: cfg.tour.legendaComum }),
      el('div', { class: 'tour-minis grande' }, ...COMUNS.map((c) => el('figure', {},
        el('img', { src: `assets/tour/${c.f}.webp`, alt: c.t, loading: 'lazy', width: 1080, height: 1920 }),
        el('figcaption', { text: c.t }))))),
  );
  $('#tour-fechar').addEventListener('click', fechar);
  $('#lb-fechar').addEventListener('click', fecharFoto);
  $('#lb-ant').addEventListener('click', () => passo(-1));
  $('#lb-prox').addEventListener('click', () => passo(1));
  const trilho = $('#lb-trilho');
  trilho.replaceChildren(...FOTOS.map((x) => el('figure', { class: 'lb-slide' },
    el('img', { 'data-src': `assets/tour/${x.f}.webp`, alt: x.t, width: 1080, height: 720 }),
    el('figcaption', { text: x.t }))));
  trilho.addEventListener('scroll', () => {
    const i = Math.round(trilho.scrollLeft / trilho.clientWidth);
    atualizar(i);
  }, { passive: true });
  t.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); if (!$('#lb').hidden) fecharFoto(); else fechar(); }
    if (!$('#lb').hidden && e.key === 'ArrowRight') passo(1);
    if (!$('#lb').hidden && e.key === 'ArrowLeft') passo(-1);
  });
  $('#lb-legenda').replaceChildren(legenda(cfg));
  montado = true;
}

let atual = 0;
function carregar(i) {
  [i - 1, i, i + 1].forEach((k) => {
    const img = document.querySelectorAll('#lb-trilho img')[k];
    if (img && !img.src) img.src = img.dataset.src;
  });
}
function atualizar(i) {
  i = Math.max(0, Math.min(FOTOS.length - 1, i));
  atual = i;
  carregar(i);
  $('#lb-cont').textContent = `${i + 1} / ${FOTOS.length}`;
}
function passo(d) {
  const trilho = $('#lb-trilho');
  const i = Math.max(0, Math.min(FOTOS.length - 1, atual + d));
  trilho.scrollTo({ left: i * trilho.clientWidth, behavior: 'smooth' });
  atualizar(i);
}
function abrirFoto(cfg, i) {
  const lb = $('#lb');
  lb.hidden = false;
  const trilho = $('#lb-trilho');
  atualizar(i);
  requestAnimationFrame(() => { trilho.scrollTo({ left: i * trilho.clientWidth, behavior: 'instant' }); });
  $('#lb-fechar').focus({ preventScroll: true });
}
function fecharFoto() { $('#lb').hidden = true; }

export function abrirTour(cfg, unidade) {
  if (!montado) montar(cfg);
  voltarFoco = document.activeElement;
  $('#tour-sub').textContent = unidade ? `Studio da unidade ${unidade.numero}: mesmo padrão de mobília` : '';
  $('#tour').hidden = false;
  document.body.classList.add('com-tour');
  $('#tour-fechar').focus({ preventScroll: true });
}
function fechar() {
  fecharFoto();
  document.querySelectorAll('#tour video').forEach((v) => v.pause());
  $('#tour').hidden = true;
  document.body.classList.remove('com-tour');
  if (voltarFoco) voltarFoco.focus({ preventScroll: true });
}
window.__tour = { abrirTour, abrirFoto: (i) => abrirFoto(null, i), fechar };
