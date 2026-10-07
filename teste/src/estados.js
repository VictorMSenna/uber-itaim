// F38 (Victor 06/10 23:5x): ONE table for the unit states — day colour of the glass in the 3D, night light (F25),
// legend text and the CSS colours of the legend/grid. Everything that paints a state reads it from here.
//   day:   disponível = saturated green glass · reservada = amber with stripes · indisponível = neutral dark grey glass
//   night: disponível = lit (warm, bright) · reservada = dim amber · indisponível = dark
export const ESTADOS = {
  disponivel: { rotulo: 'Disponível', dia: '#12a150', css: '#16a34a', noite: 'acesa', listras: false },
  reservada: { rotulo: 'Reservada', dia: '#e69f00', css: '#e69f00', noite: 'fraca', listras: true },
  indisponivel: { rotulo: 'Indisponível', dia: '#4a4e55', css: '#5b6068', noite: 'apagada', listras: false },
};
export const COR_LUZ_NOITE = { acesa: '#ffc66e', fraca: '#8a5c1c', apagada: '#1a222c' };
export const LUZ_NOITE = Object.fromEntries(Object.entries(ESTADOS).map(([k, v]) => [k, v.noite]));
export const nivelNoite = (situacao) => LUZ_NOITE[situacao] || 'apagada';
// the selected unit is never a state colour: white outline with a short soft pulse
export const SELECAO = { cor: '#ffffff', pulsoSegundos: 6 };
const TEXTO = { acesa: 'luz acesa', fraca: 'fraca', apagada: 'apagada' };
// "Modo noite: luz acesa = disponível · fraca = reservada · apagada = indisponível"
export const ROTULO_NOITE = 'Modo noite: ' + ['acesa', 'fraca', 'apagada'].map((n) => {
  const s = Object.keys(ESTADOS).find((k) => ESTADOS[k].noite === n);
  return `${TEXTO[n]} = ${ESTADOS[s].rotulo.toLowerCase()}`;
}).join(' · ');
// CSS custom properties for the legend dots and the units grid
export function aplicarCoresCss(raiz = document.documentElement) {
  raiz.style.setProperty('--disp', ESTADOS.disponivel.css);
  raiz.style.setProperty('--res', ESTADOS.reservada.css);
  raiz.style.setProperty('--ind', ESTADOS.indisponivel.css);
}
