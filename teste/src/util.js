export const brl = (v) =>
  v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 });
export const brlCurto = (v) =>
  v == null ? '—' : 'R$ ' + v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
export const m2 = (v) => (v == null ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) + ' m²');
export const dataBR = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');
export const pct = (a, b) => Math.round((a / b) * 100);

export const STATUS = {
  disponivel: { rotulo: 'Disponível', curto: 'Disp.', icone: '✓' },
  reservada: { rotulo: 'Reservada', curto: 'Res.', icone: 'R' },
  indisponivel: { rotulo: 'Indisponível', curto: 'Indisp.', icone: '–' },
};

export const POSICAO = {
  1: 'fileira 1-3-5-7-9, ponta do lado da rua',
  2: 'fileira 2-4-6-8, ponta do lado da rua',
  3: 'fileira 1-3-5-7-9',
  4: 'fileira 2-4-6-8, junto aos elevadores',
  5: 'fileira 1-3-5-7-9, no centro',
  6: 'fileira 2-4-6-8, junto aos elevadores',
  7: 'fileira 1-3-5-7-9',
  8: 'fileira 2-4-6-8, ponta oposta à rua',
  9: 'fileira 1-3-5-7-9, ponta oposta à rua',
};

// How the architect's final-6 drawing applies to each final (note 6 of the plan)
export const PLANTA = {
  6: { tipo: 'original', texto: 'Planta do final 6 (desenho do arquiteto).' },
  3: { tipo: 'rotacionada', texto: 'O final 3 usa esta planta rotacionada (nota do arquiteto).' },
  4: { tipo: 'espelhada', texto: 'O final 4 usa esta planta espelhada (nota do arquiteto).' },
  5: { tipo: 'espelhada', texto: 'O final 5 usa esta planta espelhada (nota do arquiteto).' },
  7: { tipo: 'espelhada', texto: 'O final 7 usa esta planta espelhada (nota do arquiteto).' },
};

export function el(tag, attrs = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat()) if (f != null && f !== false) e.append(f instanceof Node ? f : document.createTextNode(String(f)));
  return e;
}

// Text that starts with "[falta" gets a visible marker style
export function texto(v) {
  if (typeof v === 'string' && v.includes('[falta')) {
    const frag = document.createDocumentFragment();
    v.split(/(\[falta[^\]]*\])/).forEach((p) => {
      if (!p) return;
      frag.append(p.startsWith('[falta') ? el('span', { class: 'falta', text: p }) : document.createTextNode(p));
    });
    return frag;
  }
  return document.createTextNode(v ?? '');
}
