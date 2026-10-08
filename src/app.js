// Round 1 (F2/F9): one clean stage (3D or photo) + a bottom bar with 3 actions (Foto/Maquete, Sol, Unidades),
// a unit card whose first screen shows only what matters, everything else behind "Ver detalhes".
import { b7Ativo } from './entorno-config.js';
import { nivelNoite, ROTULO_NOITE } from './noite.js';
import { aplicarCoresCss } from './estados.js';
aplicarCoresCss(); // F38: legend dots and grid cells use the same state colours as the 3D
import { CONFIG } from './config.js';
import { META, UNIDADES, PREDIO } from './dados.js';
import { brl, brlCurto, m2, dataBR, STATUS, POSICAO, PLANTA, el, texto } from './util.js';
import { abrirTour } from './tour.js';

const params = new URLSearchParams(location.search);
const TESTE = params.has('teste');
const REVISAO = params.has('revisao');
const FORCAR_SEM_3D = params.has('semwebgl');
const $ = (s, r = document) => r.querySelector(s);
const desktop = () => window.matchMedia('(min-width: 1000px)').matches;

const porId = new Map(UNIDADES.map((u) => [u.id, u]));
const porNumero = new Map(UNIDADES.map((u) => [u.numero, u]));
const N = PREDIO.andares_venda;
const falta = (v) => typeof v === 'string' && v.includes('[falta');

const app = {
  cena: null, modo3d: 'carregando', motivoSem3d: null, vista: '3d', temFoto: false,
  andar: null, unidade: null, CONFIG,
  filtro: { de: 1, ate: N, precoMax: null, finais: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]), soDisp: false },
};
window.__app = app;
if (REVISAO) document.body.classList.add('revisao');

// ---------------------------------------------------------------- texts from config ([falta] only in ?revisao=1)
function preencherTextos() {
  document.querySelectorAll('[data-cfg]').forEach((n) => {
    const k = n.dataset.cfg;
    const v = CONFIG[k];
    if (typeof v === 'function') return;
    if (falta(v) && !REVISAO) {
      n.replaceChildren();
      const seg = n.closest('.seg') || (n.classList.contains('seg') ? n : null);
      if (seg) document.querySelectorAll(`.seg[data-seg="${k}"]`).forEach((s) => { s.hidden = true; });
      else n.hidden = true;
      return;
    }
    n.replaceChildren(texto(v));
  });
  const partes = CONFIG.nome.split(' ');
  $('#ab-nome').replaceChildren(partes.slice(0, -1).join(' ') + (partes.length > 1 ? ' ' : ''), el('span', { text: partes.at(-1) }));
  $('#ab-disp').textContent = META.contagem.disponivel;
  const precos = UNIDADES.filter((u) => u.preco_total).map((u) => u.preco_total);
  $('#ab-preco').textContent = 'R$ ' + (Math.min(...precos) / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' mi';
  const areas = [...new Set(UNIDADES.map((u) => u.area_m2))].sort();
  $('#ab-area').textContent = `${Math.round(areas[0])}–${Math.round(areas.at(-1))} m²`;
}

// ---------------------------------------------------------------- filters + grid
function passaFiltro(u) {
  const F = app.filtro;
  if (u.andar < F.de || u.andar > F.ate) return false;
  if (!F.finais.has(u.final)) return false;
  if (F.soDisp && u.situacao !== 'disponivel') return false;
  if (F.precoMax != null && (u.preco_total == null || u.preco_total > F.precoMax)) return false;
  return true;
}
function filtroAtivo() {
  const F = app.filtro;
  return F.de !== 1 || F.ate !== N || F.precoMax != null || F.finais.size !== 9 || F.soDisp;
}
function montarFiltros() {
  const selDe = $('#f-de'), selAte = $('#f-ate'), selPreco = $('#f-preco');
  for (let a = 1; a <= N; a++) { selDe.append(el('option', { value: a, text: `${a}º` })); selAte.append(el('option', { value: a, text: `${a}º` })); }
  selAte.value = N;
  const precos = [...new Set(UNIDADES.filter((u) => u.preco_total).map((u) => u.preco_total))].sort((a, b) => a - b);
  selPreco.append(el('option', { value: '', text: 'qualquer' }));
  precos.forEach((p) => selPreco.append(el('option', { value: p, text: `até ${brlCurto(p)}` })));
  for (let f = 1; f <= 9; f++) {
    $('#f-finais').append(el('button', { type: 'button', class: 'chip-final', 'aria-pressed': 'true', title: POSICAO[f],
      onclick: (e) => {
        if (app.filtro.finais.has(f)) app.filtro.finais.delete(f); else app.filtro.finais.add(f);
        e.currentTarget.setAttribute('aria-pressed', app.filtro.finais.has(f) ? 'true' : 'false');
        aplicarFiltro();
      } }, String(f)));
  }
  selDe.addEventListener('change', () => { app.filtro.de = +selDe.value; if (app.filtro.ate < app.filtro.de) { app.filtro.ate = app.filtro.de; selAte.value = app.filtro.de; } aplicarFiltro(); });
  selAte.addEventListener('change', () => { app.filtro.ate = +selAte.value; if (app.filtro.de > app.filtro.ate) { app.filtro.de = app.filtro.ate; selDe.value = app.filtro.ate; } aplicarFiltro(); });
  selPreco.addEventListener('change', () => { app.filtro.precoMax = selPreco.value ? +selPreco.value : null; aplicarFiltro(); });
  $('#f-disp').addEventListener('change', (e) => { app.filtro.soDisp = e.target.checked; aplicarFiltro(); });
  $('#f-limpar').addEventListener('click', () => {
    app.filtro = { de: 1, ate: N, precoMax: null, finais: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]), soDisp: false };
    selDe.value = 1; selAte.value = N; selPreco.value = ''; $('#f-disp').checked = false;
    document.querySelectorAll('.chip-final').forEach((b) => b.setAttribute('aria-pressed', 'true'));
    aplicarFiltro();
  });
}
function aplicarFiltro() {
  const ativo = filtroAtivo();
  const n = UNIDADES.filter(passaFiltro).length;
  $('#f-resultado').textContent = ativo ? `· ${n} no filtro` : '';
  $('#btn-unidades-n').textContent = ativo ? n : '';
  document.querySelectorAll('.cel').forEach((c) => c.classList.toggle('fora', !passaFiltro(porId.get(c.dataset.id))));
  document.querySelectorAll('.foto-svg g[data-uid]').forEach((p) => p.classList.toggle('fora', !passaFiltro(porId.get(p.dataset.uid))));
  if (app.cena) app.cena.setFiltro(ativo ? passaFiltro : null);
}
function montarGrade() {
  const g = $('#grade');
  g.append(el('div', { class: 'gh', text: '' }));
  for (let f = 1; f <= 9; f++) g.append(el('div', { class: 'gh', title: POSICAO[f], text: `F${f}` }));
  for (let a = N; a >= 1; a--) {
    g.append(el('div', { class: 'gl', 'data-andar': a, 'aria-hidden': 'true' }, `${a}º`)); // F37: no floor selection
    UNIDADES.filter((u) => u.andar === a).forEach((u) => {
      const s = STATUS[u.situacao];
      g.append(el('button', { type: 'button', class: `cel ${u.situacao}`, 'data-id': u.id,
        'aria-label': `Unidade ${u.numero}, ${s.rotulo}${u.preco_total ? ', ' + brlCurto(u.preco_total) : ''}`,
        onclick: () => abrirUnidade(u.id) }, u.numero));
    });
  }
  const c = META.contagem;
  $('#resumo').replaceChildren(
    el('span', {}, el('i', { class: 'dot disponivel' }), el('b', { text: c.disponivel }), ' disponíveis'),
    el('span', {}, el('i', { class: 'dot reservada' }), el('b', { text: c.reservada }), ' reservadas'),
    el('span', {}, el('i', { class: 'dot indisponivel' }), el('b', { text: c.indisponivel }), ' indisponíveis'));
}

// ---------------------------------------------------------------- panels (units list, card)
// F27: from the photo (or anywhere) to the 3D model, centred (F19), with the units panel open
function escolherUnidade() {
  if (app.modo3d === 'sem3d') { painelUnidades(true); return; } // no 3D on this device: the photo keeps the units
  if (app.vista === 'foto') mostrarVista('3d');
  // F33: opening the list never moves the camera (was irVista)
  painelUnidades(true);
}
// B8: full-screen real walk-through; closes back to the card
async function abrirPasseioReal() {
  const m = await import('./splat-interior.js');
  let box = document.getElementById('splat');
  if (!box) { box = el('div', { id: 'splat', class: 'splat-tela' }); document.body.append(box); }
  box.hidden = false;
  try {
    await m.abrirSplat({ container: box, aoFechar: () => { box.hidden = true; box.replaceChildren(); } });
    // B8b: the caption with its limits is ONE footer line (never over the middle of the image)
    const sm = box.querySelector('.spl-rot small');
    if (sm) sm.textContent = 'luz do dia da filmagem · o que não foi filmado não aparece';
  } catch (e) { console.error('B8 passeio', e); box.hidden = true; }
}
function voltarLista() { fecharCard(); painelUnidades(true); }
function painelUnidades(abrir) {
  const p = $('#unidades');
  const ab = abrir ?? p.hidden;
  p.hidden = !ab;
  $('#btn-unidades').setAttribute('aria-pressed', ab ? 'true' : 'false');
  atualizarPainel();
}
function atualizarPainel() {
  const aberto = !$('#unidades').hidden || !$('#card').hidden;
  document.body.classList.toggle('painel-aberto', aberto);
  ajustarDeslocamento();
}
// keep the building in the free part of the screen (desktop: right panel; phone: sun panel at the bottom)
function ajustarDeslocamento() {
  if (!app.cena) return;
  const x = desktop() && document.body.classList.contains('painel-aberto') ? 432 : 0;
  let y = 0;
  if (!desktop() && solAtivo && !$('#sol-painel').hidden) { const r = $('#sol-painel').getBoundingClientRect(); y = Math.max(0, window.innerHeight - r.top - 20); }
  // F35 (phone): the bottom sheet (list or card) takes the lower part; the building is framed in the space above it
  // (projection offset only — the camera itself does not move)
  if (!desktop()) for (const id of ['#card', '#unidades']) { const f = $(id); if (!f.hidden) y = Math.max(y, f.getBoundingClientRect().height - 10); }
  app.cena.setDeslocamento({ x, y });
}
window.addEventListener('resize', () => ajustarDeslocamento());
function destacarAndar(a) { void a; } // F37: no floor state any more (kept as a no-op for old callers)

// ---------------------------------------------------------------- unit card
function linkUnidade(u) { return `${CONFIG.urlPublica || location.href.split('#')[0]}#u${u.numero}`; }
function linkWhatsapp(u) {
  const msg = encodeURIComponent(CONFIG.mensagemWhatsapp(u.numero));
  const num = String(CONFIG.whatsapp).replace(/\D/g, '');
  return num.length >= 10 ? `https://wa.me/${num}?text=${msg}` : `https://wa.me/?text=${msg}`;
}
let estavaListaAberta = false;
function abrirUnidade(id) {
  if (app.vista === 'foto' && app.modo3d !== 'sem3d') mostrarVista('3d'); // F27: units are chosen on the 3D model
  const u = porId.get(id);
  if (!u) return;
  fecharAbertura();
  const trocando = !$('#card').hidden && app.unidade && app.unidade !== id; // card open: browse prices one by one
  app.unidade = id;
  app.cena?.preCarregarJanela?.({ andar: u.andar, final: u.final }); // Google window view starts loading while the client reads the card
  // F8: the tapped unit is THE selection; its floor is only context
  // F37: only the unit is selected (no floor state)
  document.querySelectorAll('.cel').forEach((c) => c.classList.toggle('sel', c.dataset.id === id));
  document.querySelectorAll('.foto-svg g[data-uid]').forEach((p) => p.classList.toggle('sel', p.dataset.uid === id));
  if (app.cena) app.cena.marcarUnidade(id); void trocando;
  const s = STATUS[u.situacao];
  $('#card-eyebrow').textContent = `${u.andar}º andar · final ${u.final}`;
  $('#card-titulo').replaceChildren('Unidade ', el('span', { class: 'mono', text: u.numero }));
  const selo = $('#card-selo');
  selo.className = `selo ${u.situacao}`;
  selo.replaceChildren(el('i', { class: `dot ${u.situacao}`, 'aria-hidden': 'true' }), s.rotulo);
  const temPreco = u.preco_total != null;
  const planta = PLANTA[u.final];
  const numeroWa = String(CONFIG.whatsapp).replace(/\D/g, '');
  const corpo = $('#card-corpo');
  corpo.replaceChildren(
    el('figure', { class: 'cd-foto', style: 'margin:6px 0 14px', onclick: () => abrirGaleria(0) },
      el('img', { src: CONFIG.fotos2026.lista[0].arq, alt: 'Studio mobiliado do prédio (2026)', loading: 'lazy', width: 900, height: 1600 }),
      el('figcaption', { text: CONFIG.tour.legendaCard })),
    el('p', { class: 'cd-preco' }, temPreco ? brl(u.preco_total).replace(',00', '') : 'Fora da tabela de outubro',
      el('small', { text: temPreco ? `ato de 30% em ${dataBR(u.ato.data)} + 70% em ${dataBR(u.parcela.data)}` : 'Situação a confirmar com o corretor' })),
    el('p', { class: 'cd-meta', text: `${m2(u.area_m2)} · ${u.vaga ?? 1} vaga · studio mobiliado` }),
    el('p', { class: 'cd-sol1', id: 'cd-sol-linha' }, el('span', { class: 'sol-ico', 'aria-hidden': 'true' }), el('span', { text: 'Sol na sacada…' })),
    el('div', { class: 'cd-acoes' },
      el('a', { class: 'btn-pri', href: linkWhatsapp(u), target: '_blank', rel: 'noopener', id: 'btn-wa' },
        el('svg', {}), `Chamar no WhatsApp`),
      // Victor (07/10): the procedural interior looked like 'The Sims' -> "Entrar no apartamento" IS the real tour (splat)
      b7Ativo('interiorProcedural')
        ? el('button', { type: 'button', class: 'btn-sec', id: 'btn-interior', onclick: () => entrarApartamento(u.id) }, 'Entrar no apartamento')
        : null,
      el('button', { type: 'button', class: 'btn-sec', id: 'btn-splat', hidden: true, title: 'Passeio real de um studio do prédio (vídeo de 2026)', onclick: () => entrarApartamento(u.id) },
        'Entrar no apartamento (vídeo real)', el('small', { class: 'btn-sub', text: 'de um studio do prédio · vídeo de 2026' })),
      numeroWa.length >= 10 ? null : el('p', { class: 'cd-wa-nota so-revisao' }, texto('[falta: número do WhatsApp do Hugo]'))),
    el('details', { class: 'detalhes', id: 'detalhes' },
      el('summary', { text: 'Ver detalhes' }),
      el('div', { class: 'det-corpo' },
        temPreco ? el('section', { class: 'det-bloco' }, el('h3', { text: 'Pagamento' }),
          el('ol', { class: 'pag' },
            el('li', {}, el('span', { text: 'Valor total' }), el('span', { class: 'mono', text: brl(u.preco_total) })),
            el('li', {}, el('span', { text: `Ato · ${u.ato.pct}%` }), el('span', { class: 'mono', text: brl(u.ato.valor) }), el('small', { text: `em ${dataBR(u.ato.data)}` })),
            el('li', {}, el('span', { text: `Parcela única · ${u.parcela.pct}%` }), el('span', { class: 'mono', text: brl(u.parcela.valor) }), el('small', { text: `em ${dataBR(u.parcela.data)}` })),
            el('li', {}, el('span', { text: 'R$ por m²' }), el('span', { class: 'mono', text: brl(u.preco_m2) })))) : null,
        el('ul', { class: 'avisos' },
          el('li', { text: 'Preço varia por andar e posição.' }),
          el('li', { text: 'Escritura e ITBI por conta do comprador.' }),
          el('li', { text: 'Valor inclui parte da corretagem; a tabela pode mudar sem aviso prévio.' }),
          el('li', { text: 'Imóvel pronto, mobiliado e em operação de locação.' })),
        el('section', { class: 'det-bloco' }, el('h3', { text: 'Planta' }),
          planta ? el('div', { class: `planta-box ${planta.tipo}` }, el('img', { src: 'assets/planta/planta-final-6.webp', alt: 'Planta ilustrativa do studio', loading: 'lazy', width: 700, height: 900 }))
            : el('div', { class: 'planta-falta' }, 'Planta deste final em breve'),
          el('p', { class: 'legenda-pequena', text: planta ? planta.texto + ' Ilustração artística.' : `Posição: ${POSICAO[u.final]}.` })),
        el('section', { class: 'det-bloco', id: 'det-sol' }),
        el('section', { class: 'det-bloco' }, el('h3', { text: 'Fotos reais (2026)' }), galeriaMiniaturas(),
          el('p', { class: 'legenda-pequena', text: CONFIG.fotos2026.legenda })),
        el('button', { type: 'button', class: 'btn-txt', onclick: () => abrirTour(CONFIG, u) }, 'Mais fotos'),
        el('section', { class: 'det-bloco' }, el('h3', { text: 'Compartilhar' }),
          el('button', { type: 'button', class: 'btn-txt', id: 'btn-copiar', onclick: () => copiarLink(u) }, 'Copiar link desta unidade'),
          el('input', { class: 'link-txt mono', id: 'link-txt', readonly: true, value: linkUnidade(u), 'aria-label': 'Link desta unidade' })),
        el('p', { class: 'legenda-pequena', text: `Fonte: tabela do CV de 05/10/2026${u.fonte?.includes('pagina') ? ', ' + u.fonte.split(', ')[1].replace('pagina', 'página') : ''}.` }))),
  );
  // WhatsApp icon
  const ico = $('#btn-wa svg');
  ico.outerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.5l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.1-1.2l-.5-.3Z"/></svg>';
  if (planta && planta.tipo !== 'original') {
    const box = corpo.querySelector('.planta-box');
    box.after(el('button', { type: 'button', class: 'btn-txt', onclick: (e) => {
      const on = box.classList.toggle('aplicada');
      e.currentTarget.textContent = on ? 'Ver o desenho original' : `Ver ${planta.tipo} como no final ${u.final}`;
    } }, `Ver ${planta.tipo} como no final ${u.final}`));
  }
  // F35: one right-side panel = one navigation stack: the card replaces the list (desktop and phone)
  estavaListaAberta = !$('#unidades').hidden; $('#unidades').hidden = true;
  $('#card').hidden = false;
  atualizarPainel();
  // the single "Entrar no apartamento" button: the 360 tour when its manifest is live (08:15 switch), else the real video tour
  Promise.all([manifestoTour360().catch(() => null), import('./splat-interior.js').then((m) => m.splatDisponivel()).catch(() => null)]).then(([t360, spl]) => {
    const b = $('#btn-splat'); if (!b || app.unidade !== id || !(t360 || spl)) return;
    b.hidden = false;
    if (t360) { b.firstChild.textContent = 'Entrar no apartamento'; const sm = b.querySelector('.btn-sub'); if (sm) sm.remove(); }
  });
  // prefetch the interior module while the client reads the card, so "Entrar no apartamento" opens fast
  if (!interiorMod && b7Ativo('interiorProcedural')) setTimeout(() => { carregarInterior().catch(() => {}); }, 1200);
  carregarSol().then((S) => {
    if (app.unidade !== id) return;
    const est = S.rel.info().est;
    const linha = S.resumoSolUnidade(S.SOL, u, est);
    $('#cd-sol-linha span:last-child').textContent = linha || 'Sol: simulação indisponível';
    // detailed sun (schematic plan + arc) only inside "Ver detalhes", driven by the single sun control
    desligarSolCard();
    const sec = S.secaoSolUnidade(S.rel, CONFIG, u);
    $('#det-sol').replaceWith(sec);
    app._solCard = sec;
    app._solLinha = S.rel.ouvir((i) => {
      if (app.unidade !== id) return;
      const l = S.resumoSolUnidade(S.SOL, u, i.est);
      const n = $('#cd-sol-linha span:last-child');
      if (n && l) n.textContent = l;
    });
  }).catch((e) => console.error(e));
  try { history.replaceState(null, '', `#u${u.numero}`); } catch (e) { /* sandbox */ }
}
function desligarSolCard() {
  if (app._solCard && app._solCard._desligar) app._solCard._desligar();
  if (app._solLinha) app._solLinha();
  app._solCard = null; app._solLinha = null;
}
function fecharCard() {
  desligarSolCard();
  $('#card').hidden = true;
  app.cena?.pararPreCarga?.();
  app.unidade = null;
  if (app.cena) { app.cena.marcarUnidade(null); }
  document.querySelectorAll('.cel.sel,.foto-svg g.sel').forEach((c) => c.classList.remove('sel'));
  atualizarPainel(); // F35: the X only collapses; "Todas as unidades" goes back to the list
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* sandbox */ }
}
async function copiarLink(u) {
  const b = $('#btn-copiar');
  try { await navigator.clipboard.writeText(linkUnidade(u)); b.textContent = 'Link copiado'; }
  catch (e) { const i = $('#link-txt'); i.focus(); i.select(); b.textContent = 'Selecione e copie o link'; }
  setTimeout(() => { b.textContent = 'Copiar link desta unidade'; }, 2600);
}

// ---------------------------------------------------------------- F12: hover label (desktop)
function mostrarEtiqueta(h) {
  const e = $('#etiqueta');
  if (!h) { e.hidden = true; return; }
  if (h.tipo === 'sol') {
    const i = solMod?.rel.info();
    e.replaceChildren(el('b', { text: i ? i.hora : '' }), ' · arraste o sol');
  } else {
    const u = h.u;
    const s = STATUS[u.situacao].rotulo;
    const preco = u.preco_total ? ' · R$ ' + (u.preco_total / 1e6).toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' mi' : '';
    e.replaceChildren(el('b', { text: u.numero }), ` · ${s}${preco}`);
  }
  e.style.left = h.x + 'px'; e.style.top = h.y + 'px';
  e.hidden = false;
}

// ---------------------------------------------------------------- sun cycle (lazy data from B3) - ONE control
let solMod = null;
// two time bars (B7's capture E6-F40): two calls before the first import resolved built two clocks and two bars.
// One promise for every caller.
let solPromessa = null;
function carregarSol() {
  if (solMod) return Promise.resolve(solMod);
  if (!solPromessa) solPromessa = carregarSolUmaVez().catch((e) => { solPromessa = null; throw e; });
  return solPromessa;
}
async function carregarSolUmaVez() {
  const [dados, mod] = await Promise.all([import('./dados-sol.js'), import('./sol.js')]);
  const rel = mod.criarRelogio(dados.SOL, CONFIG);
  solMod = { ...mod, SOL: dados.SOL, VIZ: dados.VIZINHOS, rel, ctl: null };
  let estAnt = null;
  // F30: slider/Segure fire many events per frame: coalesce them into ONE update per animation frame
  let solPend = null, solRaf = 0, estPend = false;
  rel.ouvir((i) => {
    if (i.est !== estAnt) { estAnt = i.est; estPend = true; }
    solPend = i;
    if (!solRaf) solRaf = requestAnimationFrame(() => {
      solRaf = 0;
      const est = estPend ? dados.SOL.estacoes[solPend.est] : null;
      estPend = false;
      aplicarSol(solPend, est);
    });
  });
  return solMod;
}
let solAtivo = false;
function aplicarSol(i, estacao) {
  const noite = i.noite > 0.5;
  // F26 (Victor 22:1x): season / hour / Segure / day-night NEVER move the camera (only the first Sol activation frames it)
  if (app.cena && solAtivo) app.cena.setSol(i, { estacao, movendo: i.segurando });
  $('#cena').classList.toggle('noite', solAtivo && noite);
  const leg = $('#noite-legenda');
  // F27: the Foto view is the real daytime photo only (no night overlay, no status): the legend is 3D-only
  // Victor 07/10 08:40: no night banner over the tower; the top 3-item legend itself switches to the night colours
  leg.hidden = true;
  document.querySelector('.legenda')?.classList.toggle('noite', solAtivo && noite && app.vista !== 'foto');
  const foto = $('#foto');
  foto.style.setProperty('--noite', '0');
  foto.style.setProperty('--luzes', '0');
  foto.classList.remove('noite');
  if (interiorMod && interiorAberto) { interiorMod.definirEstacao?.(i.est); interiorMod.definirHora?.(i.t); }
}
function modoSombra() {
  const forcado = params.get('sombra');
  if (forcado === 'real' || forcado === 'pre') return forcado;
  const t = app.gpu?.tier;
  if (t && t.type === 'BENCHMARK') return t.tier >= 2 ? 'real' : 'pre';
  return 'real'; // 07/10 Victor: high-end phones get the real-time sun shadow too (only a measured weak GPU tier falls back)
}
async function alternarSol(_onde, abrir) {
  const S = await carregarSol();
  solAtivo = abrir ?? !solAtivo;
  $('#btn-sol').setAttribute('aria-pressed', solAtivo ? 'true' : 'false');
  const painel = $('#sol-painel');
  if (!S.ctl) S.ctl = S.controleSol(S.rel, CONFIG);
  if (solAtivo && !interiorAberto && S.ctl.parentNode !== painel) painel.replaceChildren(S.ctl); // one bar only
  painel.hidden = !solAtivo;
  $('#dica').hidden = true;
  ajustarDeslocamento();
  if (app.cena) {
    if (solAtivo) {
      app.cena.iniciarSol(S.SOL, S.VIZ, { modo: modoSombra() });
      const i = S.rel.info();
      app.cena.setSol(i, { estacao: S.SOL.estacoes[i.est] });
    } else app.cena.desligarSol();
  }
  aplicarSol(S.rel.info(), null);
}

// ---------------------------------------------------------------- F4: enter the apartment (module by front B4)
let interiorMod = null, interiorAberto = false;
let tour360Url = undefined;
// one shared promise: two callers at the same moment (card + deep link) used to get null from the second one -> real-video fallback
let tour360Promessa = null;
function manifestoTour360() { return tour360Promessa || (tour360Promessa = carregaManifestoTour360()); }
async function carregaManifestoTour360() {
  if (tour360Url !== undefined) return tour360Url;
  tour360Url = null;
  const amostra = params.get('tour360') === 'amostra';
  const url = amostra ? CONFIG.demo.tour360Amostra : CONFIG.demo.tour360Manifesto;
  if (params.get('tour360') === '0') return null;
  // B6's v1 360 batch has an unconfirmed cove light: the real batch only goes on with CONFIG.demo.tour360Ativo
  if (!amostra && !CONFIG.demo.tour360Ativo) return null;
  try {
    const r = await fetch(url, { method: 'GET', cache: 'no-cache' });
    if (r.ok) { const m = limparManifesto360(await r.json(), url); if (m) tour360Url = m; }
  } catch (e) { /* absent */ }
  return tour360Url;
}
// 360 v3 (B6): keep only complete points (a sky layer + at least one sun or night layer, an image per layer), drop
// neighbour links to missing points and any light layer whose fixture is not confirmed (Victor 22:5x: no light
// without the fixture seen in the clips). Returns the manifest OBJECT (base = folder of the manifest) or null.
const LUZES_CONFIRMADAS = ['teto', 'abajur', 'cozinha'];
// v4: fora (window mask, also used by the Google city), albedo/normal/solvis/solind (minute-by-minute sun) are data layers, not lights
const CAMADAS_BASE = ['ceu', 'sol', 'noite', 'fora', 'albedo', 'normal', 'solvis', 'solind'];
function limparManifesto360(man, url) {
  if (!man || !Array.isArray(man.pontos)) return null;
  const completo = (p) => p && p.id && p.camadas && p.camadas.ceu && p.camadas.ceu.arq;
  const pontos = man.pontos.filter(completo).map((p) => {
    const camadas = {};
    for (const [k, v] of Object.entries(p.camadas)) if (CAMADAS_BASE.includes(k) || LUZES_CONFIRMADAS.includes(k)) camadas[k] = v;
    return { ...p, camadas };
  });
  const ids = new Set(pontos.map((p) => p.id));
  pontos.forEach((p) => { if (Array.isArray(p.vizinhos)) p.vizinhos = p.vizinhos.filter((v) => ids.has(v)); });
  if (!pontos.length) return null;
  return { ...man, pontos, base: man.base || url.replace(/[^/]*$/, '') };
}
async function carregarInterior() {
  if (interiorMod) return interiorMod;
  const man = await manifestoTour360();
  if (man) {
    try {
      const t = await import('./tour360.js');
      interiorMod = {
        tour360: true,
        // lamps on by default (same as the 3D interior), so night is never a black room
        abrirInterior: (o) => t.abrirTour360({ container: o.container, manifesto: man, estacao: o.estacao, minutos: o.minutos, aoFechar: o.aoFechar, teste: o.teste,
          andar: porId.get(o.id)?.andar, final: porId.get(o.id)?.final, // Google city seen from the real unit
          luzes: { teto: true, abajur: true, cortineiro: false, cozinha: false } }), // night default: spots + bedside lamps (WB neutralised in render-mix)
        definirHora: t.definirHora, definirEstacao: t.definirEstacao, fecharInterior: t.fecharTour360,
      };
      return interiorMod;
    } catch (e) { console.error('tour360 indisponivel, usando o interior 3D', e); }
  }
  try { interiorMod = await import('./interior.js'); }
  catch (e) {
    // stub with the same signature until src/interior.js exists
    interiorMod = {
      stub: true,
      async abrirInterior({ id, container }) {
        container.replaceChildren(el('div', { class: 'interior-stub' },
          el('div', {}, el('p', { style: 'font:700 22px var(--f-display);color:var(--texto);margin:0 0 8px', text: `Unidade ${porId.get(id)?.numero}` }),
            el('p', { text: 'A visita por dentro está sendo preparada.' }))));
      },
      definirHora() {}, definirEstacao() {}, fechar() {},
    };
  }
  return interiorMod;
}
// ---------------------------------------------------------------- gallery: real 2026 frames (+ B6 stills if present)
let fotosGaleria = CONFIG.fotos2026.lista.map((f) => ({ ...f, legenda: CONFIG.fotos2026.legenda }));
(async () => {
  try {
    const r = await fetch(CONFIG.demo.rendersManifesto, { cache: 'no-cache' });
    if (!r.ok) return;
    const m = await r.json();
    const extras = (m.fotos || []).slice(0, 4).map((f) => ({ arq: new URL(f.arq, new URL(CONFIG.demo.rendersManifesto, location.href)).href,
      texto: f.texto || '', legenda: f.legenda || 'Imagem ilustrativa fiel ao apartamento — render a partir de fotos e medidas' }));
    if (extras.length) { fotosGaleria = [...extras, ...fotosGaleria]; app.rendersDemo = extras.length; }
  } catch (e) { /* no manifest: gallery shows only the real photos */ }
})();
function galeriaMiniaturas() {
  return el('div', { class: 'cd-galeria' }, ...fotosGaleria.map((f, i) => el('button', { type: 'button', onclick: () => abrirGaleria(i), 'aria-label': `Abrir foto: ${f.texto}` },
    el('img', { src: f.arq.replace(/\.webp$/, '-mini.webp').replace('-mini-mini', '-mini'), alt: '', loading: 'lazy', onerror: (e) => { e.target.src = f.arq; } }))));
}
let galAtual = 0;
function abrirGaleria(i) {
  const g = $('#galeria'), tr = $('#gal-trilho');
  tr.replaceChildren(...fotosGaleria.map((f) => el('figure', { class: 'lb-slide' },
    el('img', { src: f.arq, alt: f.texto, loading: 'lazy' }), el('figcaption', { text: f.texto }))));
  g.hidden = false;
  const ir = (k, suave) => {
    galAtual = Math.max(0, Math.min(fotosGaleria.length - 1, k));
    tr.scrollTo({ left: galAtual * tr.clientWidth, behavior: suave ? 'smooth' : 'instant' });
    $('#gal-cont').textContent = `${galAtual + 1} / ${fotosGaleria.length}`;
    $('#gal-legenda').textContent = fotosGaleria[galAtual].legenda;
  };
  tr.onscroll = () => { const k = Math.round(tr.scrollLeft / tr.clientWidth); if (k !== galAtual) { galAtual = k; $('#gal-cont').textContent = `${k + 1} / ${fotosGaleria.length}`; $('#gal-legenda').textContent = fotosGaleria[k].legenda; } };
  $('#gal-ant').onclick = () => ir(galAtual - 1, true);
  $('#gal-prox').onclick = () => ir(galAtual + 1, true);
  $('#gal-fechar').onclick = () => { g.hidden = true; };
  requestAnimationFrame(() => ir(i, false));
}

// F18 (round 2): "Entrar no apartamento" -> camera slides to the unit's window (~0.8 s) -> full-screen interior
// with a compact bar. "Ver por fora" (button, Esc, browser/phone back) does the reverse path and leaves the card
// of that unit open, same season and time. Re-entering the same unit restores the view the client was using.
const vistaInterior = new Map(); // unit id -> last B4 viewpoint (porta/janela/varanda)
let historicoEmpurrado = false, entrando = false;
function preencherBarraInterior(u) {
  const s = STATUS[u.situacao];
  // phone (08/10, Victor: no truncated text, only the essentials): line 1 unit + floor, line 2 price; status as a coloured dot
  $('#ib-txt').replaceChildren(el('span', { class: 'ib-l1' }, [el('b', { text: `Unidade ${u.numero}` }), el('span', { class: 'ib-andar', text: ` · ${u.andar}º andar` }),
    el('span', { class: 'ib-sep', text: ' · ' }), el('span', { class: `ib-sit ${u.situacao}`, text: s.rotulo })]),
    el('span', { class: 'ib-l2' }, [el('span', { class: 'ib-andar-c', text: `${u.andar}º andar · ` }),
      u.preco_total != null ? el('span', { class: 'mono ib-preco', text: brl(u.preco_total).replace(',00', '') }) : '']));
  $('#ib-wa').href = linkWhatsapp(u);
  $('#int-detalhes').hidden = true;
  $('#int-det-eyebrow').textContent = `${u.andar}º andar · final ${u.final}`;
  $('#int-det-titulo').replaceChildren('Unidade ', el('span', { class: 'mono', text: u.numero }));
  const planta = PLANTA[u.final];
  const temPreco = u.preco_total != null;
  $('#int-det-corpo').replaceChildren(el('div', { class: 'det-corpo' },
    el('span', { class: `selo ${u.situacao}`, style: 'justify-self:start;margin:0' }, el('i', { class: `dot ${u.situacao}`, 'aria-hidden': 'true' }), s.rotulo),
    temPreco ? el('section', { class: 'det-bloco' }, el('h3', { text: 'Pagamento' }),
      el('ol', { class: 'pag' },
        el('li', {}, el('span', { text: 'Valor total' }), el('span', { class: 'mono', text: brl(u.preco_total) })),
        el('li', {}, el('span', { text: `Ato · ${u.ato.pct}%` }), el('span', { class: 'mono', text: brl(u.ato.valor) }), el('small', { text: `em ${dataBR(u.ato.data)}` })),
        el('li', {}, el('span', { text: `Parcela única · ${u.parcela.pct}%` }), el('span', { class: 'mono', text: brl(u.parcela.valor) }), el('small', { text: `em ${dataBR(u.parcela.data)}` })))) : null,
    el('section', { class: 'det-bloco' }, el('h3', { text: 'Unidade' }),
      el('ol', { class: 'pag' },
        el('li', {}, el('span', { text: 'Área privativa' }), el('span', { class: 'mono', text: m2(u.area_m2) })),
        el('li', {}, el('span', { text: 'Vaga' }), el('span', { class: 'mono', text: String(u.vaga ?? 1) })),
        temPreco ? el('li', {}, el('span', { text: 'R$ por m²' }), el('span', { class: 'mono', text: brl(u.preco_m2) })) : null)),
    el('ul', { class: 'avisos' }, el('li', { text: 'Preço varia por andar e posição.' }), el('li', { text: 'Escritura e ITBI por conta do comprador.' })),
    el('section', { class: 'det-bloco' }, el('h3', { text: 'Planta' }),
      planta ? el('div', { class: `planta-box ${planta.tipo}` }, el('img', { src: 'assets/planta/planta-final-6.webp', alt: 'Planta ilustrativa do studio', loading: 'lazy', width: 700, height: 900 }))
        : el('div', { class: 'planta-falta' }, 'Planta deste final em breve'),
      el('p', { class: 'legenda-pequena', text: planta ? planta.texto + ' Ilustração artística.' : '' })),
    el('section', { class: 'det-bloco' }, el('h3', { text: 'Fotos reais (2026)' }), galeriaMiniaturas(),
      el('p', { class: 'legenda-pequena', text: CONFIG.fotos2026.legenda }))));
}
async function entrarApartamento(id, { semAnimacao = false } = {}) {
  // inside view: the 360 tour (tour360.js, with the outside sun bar) when its manifest is live; otherwise the real video
  // tour (interim, 06:15); the procedural 3D interior only with ?interiorProcedural=1
  if (!b7Ativo('interiorProcedural') && !(await manifestoTour360().catch(() => null))) { abrirPasseioReal(); return; }
  const u = porId.get(id);
  if (!u || interiorAberto || entrando) return;
  entrando = true;
  try {
    const carga = Promise.all([carregarSol(), carregarInterior()]);
    // camera slides to the window while the module loads
    if (app.cena && app.vista !== 'foto' && !semAnimacao) await app.cena.irParaJanela(id);
    const [S, M] = await carga;
    interiorAberto = true;
    preencherBarraInterior(u);
    $('#interior').hidden = false;
    if (!S.ctl) S.ctl = S.controleSol(S.rel, CONFIG);
    const i = S.rel.info();
    if (M.stub || M.tour360) $('#interior-sol').append(S.ctl);
    const api = await M.abrirInterior({ id, estacao: i.est, minutos: i.t, container: $('#interior-cena'), teste: TESTE,
      controleSol: (M.stub || M.tour360) ? null : S.ctl,
      aoMudarSol: ({ estacao, minutos }) => { if (estacao) S.rel.estacao(estacao); if (minutos != null) S.rel.hora(minutos); },
      aoFechar: () => pedirSaida('modulo') });
    espelharEstadoInterior(S.ctl);
    legendaVistaInterior();
    const v = vistaInterior.get(id);
    if (v && api && api.irVista) api.irVista(v);
    app.interior = { id, stub: !!M.stub, tour360: !!M.tour360, api };
    try { history.pushState({ interior: id }, '', `#u${u.numero}-dentro`); historicoEmpurrado = true; } catch (e) { historicoEmpurrado = false; }
  } finally { entrando = false; }
}
// F22: B4's state card ("Inverno · 21/06 · 10:00 — sem sol direto...") becomes the slim bar's second line
let obsEstado = null;
// F29: B4's floating "vista simulada / vista reconstruída" label never floats over the scene: it becomes a small
// caption on the bottom line, shown only while the view looks out (Janela / Varanda)
let obsVista = null;
function legendaVistaInterior() {
  if (obsVista) obsVista.disconnect();
  const raiz = document.querySelector('#interior');
  const rot = raiz && raiz.querySelector('.int-vista-rot');
  if (!raiz || !rot) return;
  let cap = raiz.querySelector('.int-rodape');
  if (!cap) { cap = document.createElement('p'); cap.className = 'int-rodape'; raiz.append(cap); }
  const atualizar = () => {
    const v = raiz.querySelector('.int-vistas button[aria-pressed="true"]')?.dataset.v;
    cap.textContent = rot.textContent;
    cap.hidden = !(v === 'janela' || v === 'varanda') || !rot.textContent;
  };
  atualizar();
  obsVista = new MutationObserver(atualizar);
  obsVista.observe(rot, { childList: true, characterData: true, subtree: true });
  raiz.querySelectorAll('.int-vistas button').forEach((b) => obsVista.observe(b, { attributes: true, attributeFilter: ['aria-pressed'] }));
}
function espelharEstadoInterior(ctl) {
  if (obsEstado) obsEstado.disconnect();
  const fonte = document.querySelector('#interior .int-estado .int-txt');
  if (!fonte || !ctl || !ctl._marcarEstado) return;
  const tmp = document.createElement('div');
  const copiar = () => {
    // F29: the source is display:none, so innerText has no line breaks ("noiteNeste dia"): split on <br> instead
    tmp.innerHTML = fonte.innerHTML.replace(/<br\s*\/?>/gi, '\n');
    const t = tmp.textContent.split(/\n+/).map((x) => x.trim()).filter(Boolean).join(' · ')
      .replace(/Neste dia: sem sol/, 'neste dia sem sol').replace(/Neste dia:/, 'sol neste dia:');
    if (t) ctl._marcarEstado(t.replace(/^[^—]*—\s*/, ''));
    ctl.title = t;
  };
  copiar();
  obsEstado = new MutationObserver(copiar);
  obsEstado.observe(fonte, { childList: true, characterData: true, subtree: true });
}
// every exit path goes through here; with a history entry we go back and let popstate do the exit
function pedirSaida(origem) {
  if (!interiorAberto) return;
  if (historicoEmpurrado && origem !== 'voltar') {
    historicoEmpurrado = false;
    let feito = false;
    const fallback = setTimeout(() => { if (!feito) sairApartamento(origem); }, 450);
    window.addEventListener('popstate', () => { feito = true; clearTimeout(fallback); }, { once: true });
    try { history.back(); } catch (e) { clearTimeout(fallback); sairApartamento(origem); }
    return;
  }
  sairApartamento(origem);
}
function sairApartamento(origem) {
  if (!interiorAberto) return;
  interiorAberto = false;
  const id = app.interior?.id;
  const pressed = document.querySelector('#interior .int-vistas [aria-pressed="true"]');
  if (id && pressed) vistaInterior.set(id, pressed.dataset.v);
  if (origem !== 'modulo') { try { (interiorMod?.fecharInterior || interiorMod?.fechar)?.(); } catch (e) { /* ignore */ } }
  $('#interior').hidden = true;
  $('#int-detalhes').hidden = true;
  $('#interior-cena').replaceChildren();
  if (obsEstado) { obsEstado.disconnect(); obsEstado = null; }
  if (solMod?.ctl) { const sb = solMod.ctl.querySelector('.sol-sub'); if (sb) delete sb.dataset.externo; solMod.rel.hora(solMod.rel.info().t); }
  if (solMod?.ctl) { $('#sol-painel').replaceChildren(solMod.ctl); $('#sol-painel').hidden = !solAtivo; }
  app.interior = null;
  app.ultimaSaida = origem;
  // back outside: the card of that unit open, camera goes from the window back to where the client was
  if (id) {
    if ($('#card').hidden || app.unidade !== id) abrirUnidade(id);
    if (app.cena) app.cena.voltarDaJanela();
  }
  try { if (id) history.replaceState(null, '', `#u${porId.get(id).numero}`); } catch (e) { /* sandbox */ }
}

// ---------------------------------------------------------------- photo view (B2)
async function carregarVistaFoto() {
  // F20: unit shapes from B2's photo-traced cells, glass area measured on the photo (gera_poligonos_foto.py)
  const vf = CONFIG.vistaFoto;
  let svgTxt = null;
  try { const r = await fetch(vf.svg, { cache: 'no-cache' }); if (r.ok) svgTxt = await r.text(); } catch (e) { /* absent */ }
  if (!svgTxt || !svgTxt.includes('<svg')) return;
  const box = $('#foto-box');
  box.replaceChildren(el('img', { src: vf.imagem, alt: vf.legenda, class: 'foto-img', width: 1080, height: 1920 }));
  const tmp = document.createElement('div');
  tmp.innerHTML = svgTxt;
  const svg = tmp.querySelector('svg');
  if (!svg) return;
  svg.querySelectorAll('script,foreignObject').forEach((n) => n.remove());
  svg.classList.add('foto-svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); return n; };
  // night layer: warm-graded copy of the photo clipped to the glass of lit (unavailable) / dim (reserved) units + soft bloom
  const defs = mk('defs');
  const cpA = mk('clipPath', { id: 'cp-acesa' }), cpF = mk('clipPath', { id: 'cp-fraca' });
  const quente = mk('filter', { id: 'f-quente', 'color-interpolation-filters': 'sRGB' });
  quente.append(mk('feColorMatrix', { type: 'matrix', values: '1.55 .25 0 0 .16  .12 1.05 .05 0 .08  0 .05 .55 0 0  0 0 0 1 0' }));
  const fraca = mk('filter', { id: 'f-fraca', 'color-interpolation-filters': 'sRGB' });
  fraca.append(mk('feColorMatrix', { type: 'matrix', values: '.8 .12 0 0 .05  .06 .52 0 0 .02  0 0 .22 0 0  0 0 0 1 0' }));
  const bloom = mk('filter', { id: 'f-bloom', x: '-20%', y: '-20%', width: '140%', height: '140%' });
  bloom.append(mk('feGaussianBlur', { stdDeviation: '7' }));
  defs.append(cpA, cpF, quente, fraca, bloom);
  const camada = mk('g', { class: 'camada-noite' });
  const imgA = mk('image', { href: vf.imagem, x: 0, y: 0, width: 1080, height: 1920, preserveAspectRatio: 'none', 'clip-path': 'url(#cp-acesa)', filter: 'url(#f-quente)' });
  const imgF = mk('image', { href: vf.imagem, x: 0, y: 0, width: 1080, height: 1920, preserveAspectRatio: 'none', 'clip-path': 'url(#cp-fraca)', filter: 'url(#f-fraca)' });
  const brilho = mk('g', { filter: 'url(#f-bloom)', opacity: '.38', style: 'mix-blend-mode:screen' });
  camada.append(brilho, imgF, imgA);
  svg.prepend(defs);
  svg.insertBefore(camada, defs.nextSibling);
  svg.querySelectorAll('g[data-id]').forEach((g) => {
    const u = porId.get(g.getAttribute('data-id'));
    if (!u) { g.remove(); return; }
    g.classList.add(u.situacao);
    g.dataset.uid = u.id;
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', `Unidade ${u.numero}, ${STATUS[u.situacao].rotulo}`);
    const vid = g.querySelector('.vidro');
    // F25: lit / dim / dark from the single convention table (src/noite.js)
    const nivel = nivelNoite(u.situacao);
    if (vid && nivel === 'acesa') { cpA.append(vid.cloneNode()); const b = vid.cloneNode(); b.setAttribute('fill', '#ffb24d'); brilho.append(b); }
    if (vid && nivel === 'fraca') cpF.append(vid.cloneNode());
    g.addEventListener('click', () => abrirUnidade(u.id));
    g.addEventListener('dblclick', () => entrarApartamento(u.id));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirUnidade(u.id); } });
    g.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') mostrarEtiqueta({ tipo: 'unidade', u, x: e.clientX, y: e.clientY }); });
    g.addEventListener('pointerleave', () => mostrarEtiqueta(null));
  });
  box.append(svg);
  app.temFoto = true;
  app.fotoUnidades = svg.querySelectorAll('g[data-uid]').length;
  $('#btn-vista').hidden = true; // 08/10: the photo view is gone
  aplicarFiltro();
}
function mostrarVista(qual) {
  if (qual === 'foto') return; // 08/10 Victor: the painted-units photo never appears (only the opening page and the 3D model)
  app.vista = qual;
  $('#foto').hidden = qual !== 'foto';
  $('#cena').style.visibility = qual === 'foto' ? 'hidden' : 'visible';
  $('#btn-vista-txt').textContent = qual === 'foto' ? 'Maquete' : 'Foto';
  $('#btn-vista').setAttribute('aria-label', qual === 'foto' ? 'Ver a maquete 3D' : 'Ver a foto do prédio');

  document.body.classList.toggle('vista-foto', qual === 'foto'); // F27: hides the sun bar and the 3D hint over the photo
  document.body.classList.toggle('sem3d', app.modo3d === 'sem3d');
  if (qual === 'foto' && app.modo3d !== 'sem3d') { painelUnidades(false); if (!$('#card').hidden) fecharCard(); }
  if (qual !== 'foto' && app.cena) app.cena.pedirRender();
  if (solMod) aplicarSol(solMod.rel.info(), null);
}

// ---------------------------------------------------------------- 3D or fallback
function webgl2Ok() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return { ok: false, motivo: 'WebGL2 indisponível' };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const rend = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { ok: true, renderer: String(rend) };
  } catch (e) { return { ok: false, motivo: 'erro ao criar WebGL2' }; }
}
async function tierGpu() {
  try {
    const mod = await Promise.race([import('detect-gpu'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout import')), 2500))]);
    return await Promise.race([
      mod.getGPUTier({ benchmarksURL: 'https://cdn.jsdelivr.net/npm/detect-gpu@5.0.70/dist/benchmarks' }),
      new Promise((res) => setTimeout(() => res({ tier: -1, type: 'TIMEOUT' }), 2500)),
    ]);
  } catch (e) { return { tier: -1, type: 'ERRO', erro: String(e.message || e) }; }
}
async function iniciar3D() {
  if (FORCAR_SEM_3D) return semTresD('modo sem 3D forçado');
  const gl = webgl2Ok();
  app.gpu = { webgl2: gl };
  if (!gl.ok) return semTresD(gl.motivo);
  const t = await tierGpu();
  app.gpu.tier = t;
  const soft = /swiftshader|llvmpipe|software/i.test(gl.renderer || '');
  if (t.tier === 0 && !(TESTE && soft)) return semTresD(`placa de vídeo classificada como fraca (${t.type})`);
  try {
    const { criarCena } = await import('./cena3d.js');
    app.cena = criarCena({
      container: $('#cena'), predio: PREDIO, unidades: UNIDADES, teste: TESTE,
      onTocarUnidade: (u) => abrirUnidade(u.id),
      onDuploToque: (u) => { abrirUnidade(u.id); entrarApartamento(u.id); },
      onTocarAndar: (a) => destacarAndar(a),
      onHover: mostrarEtiqueta,
      onArrastarSol: (t, fase) => { if (solMod) solMod.rel.arrastar(t, fase); },
    });
    app.modo3d = '3d';
    ajustarDeslocamento();
    if (filtroAtivo()) app.cena.setFiltro(passaFiltro);
    if (app.unidade) app.cena.marcarUnidade(app.unidade);
    alternarSol('cena', true); // F34: the sun/time bar is part of the outside view (no Sol mode)
  } catch (e) { console.error(e); semTresD('erro ao montar o 3D: ' + (e.message || e)); }
}
function semTresD(motivo) {
  app.modo3d = 'sem3d';
  app.motivoSem3d = motivo;
  $('#cena').setAttribute('data-ready', '1');
  $('#cena').replaceChildren(el('div', { class: 'interior-stub' },
    el('div', {}, el('p', { style: 'font:700 20px var(--f-display);color:var(--texto);margin:0 0 6px', text: 'A maquete 3D não abre neste aparelho' }),
      el('p', { text: 'Use a lista de unidades: mesmas cores, preço e WhatsApp.' }),
      el('p', { class: 'so-revisao', style: 'font-size:12px', text: `Motivo técnico: ${motivo}` }))));
  $('#cena').style.background = 'var(--base)';
  painelUnidades(true); // no 3D on this device: the units list (never the painted photo)
}

// ---------------------------------------------------------------- opening, legal, wiring
function fecharAbertura() {
  const ab = $('#abertura');
  if (ab.hidden) return;
  ab.hidden = true;
  if (desktop()) painelUnidades(true);
  if (app.cena) app.cena.pedirRender();
}
function ligar() {
  $('#btn-ver').addEventListener('click', fecharAbertura);
  $('#card-fechar').addEventListener('click', fecharCard);
  // F35: back from the card to the list, in the same panel
  $('#card-voltar').addEventListener('click', voltarLista);
  // F34: the bottom tab bar is gone: "Foto real" chip (outside view) and a "Unidades" chip when the panel is collapsed
  // Victor 07/10 08:4x: "Foto real" shows the opening page (the drone photo the link opens with); "Ver unidades" closes it
  $('#btn-foto-real').addEventListener('click', () => { if (!$('#card').hidden) fecharCard(); $('#abertura').hidden = false; });
  $('#btn-lista').addEventListener('click', () => { if (!$('#card').hidden) voltarLista(); else escolherUnidade(); });
  $('#unidades-fechar').addEventListener('click', () => painelUnidades(false));
  // F27: "Unidades" always goes to the 3D model with the units panel (never a panel over the photo)
  $('#btn-unidades').addEventListener('click', () => {
    if (app.vista === 'foto' && app.modo3d !== 'sem3d') { escolherUnidade(); return; }
    if (!$('#card').hidden && !desktop()) fecharCard();
    painelUnidades();
  });
  $('#foto-escolher').addEventListener('click', escolherUnidade);
  $('#btn-sol').addEventListener('click', () => { if (app.vista === 'foto') mostrarVista('3d'); alternarSol('cena'); });
  $('#btn-vista').addEventListener('click', () => mostrarVista(app.vista === 'foto' ? '3d' : 'foto'));
  // B7: attribution of the real surroundings (CC BY-SA) when they are switched on
  if (b7Ativo('entorno') || b7Ativo('entornoFora')) {
    import('./entorno.js').then(({ ATRIBUICAO_ENTORNO }) => {
      const p = $('#legal-entorno'); p.textContent = ATRIBUICAO_ENTORNO; p.hidden = false;
      $('#atrib-curta').hidden = false;
    }).catch(() => {});
  }
  const abrirLegal = () => { $('#legal').hidden = false; $('#legal-fechar').focus(); };
  $('#btn-legal').addEventListener('click', abrirLegal);
  $('#btn-legal-2').addEventListener('click', abrirLegal);
  $('#legal-fechar').addEventListener('click', () => { $('#legal').hidden = true; });
  $('#legal').addEventListener('click', (e) => { if (e.target.id === 'legal') $('#legal').hidden = true; });
  $('#interior-fechar').addEventListener('click', () => pedirSaida('botao'));
  $('#ib-det').addEventListener('click', () => { $('#int-detalhes').hidden = !$('#int-detalhes').hidden; });
  $('#int-det-fechar').addEventListener('click', () => { $('#int-detalhes').hidden = true; });
  window.addEventListener('popstate', () => { if (interiorAberto) sairApartamento('voltar'); });
  const vizinho = (d) => {
    const u = porId.get(app.unidade); if (!u) return;
    const f = ((u.final - 1 + d + 9) % 9) + 1;
    abrirUnidade(`${u.andar}-${f}`);
  };
  $('#card-ant').addEventListener('click', () => vizinho(-1));
  $('#card-prox').addEventListener('click', () => vizinho(1));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !$('#tour').hidden || e.defaultPrevented || ($('#splat') && !$('#splat').hidden)) return; // B8b: Esc already used (e.g. closed the real tour) -> back to the card
    if (!$('#galeria').hidden) { $('#galeria').hidden = true; return; }
    if (!$('#legal').hidden) $('#legal').hidden = true;
    else if (interiorAberto) { if (!$('#int-detalhes').hidden) $('#int-detalhes').hidden = true; else pedirSaida('tecla'); }
    else if (!$('#card').hidden) fecharCard();
  });
}
function deepLink() {
  const m = /^#u(\d{2,3})(-dentro)?$/.exec(location.hash || '');
  const u = m && porNumero.get(m[1]);
  if (!u) return false;
  fecharAbertura(); abrirUnidade(u.id);
  if (m[2]) {
    // link straight into the apartment: make "back" land on the building with the card open
    try { history.replaceState(null, '', `#u${u.numero}`); } catch (e) { /* sandbox */ }
    entrarApartamento(u.id, { semAnimacao: true });
  }
  return true;
}

preencherTextos();
montarGrade();
montarFiltros();
ligar();
aplicarFiltro();
if (!deepLink() && params.has('semabertura')) fecharAbertura();
carregarVistaFoto();
iniciar3D().finally(() => document.documentElement.setAttribute('data-app', 'pronto'));

Object.assign(app, { pedirSaida, interiorAberto: () => interiorAberto, alternarSol, carregarSol, abrirUnidade, fecharCard, destacarAndar, fecharAbertura, painelUnidades,
  mostrarVista, passaFiltro, entrarApartamento, sairApartamento, selecionarAndar: destacarAndar });
