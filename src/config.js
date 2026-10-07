// Single place for everything that depends on the broker/developer.
// Any value starting with "[falta" is shown on the page exactly as written, so the gap is visible.
export const CONFIG = {
  nome: 'Uber Itaim',                    // [falta: Hugo confirma "Uber Itaim" ou "Upper"] - o PDF do CV diz "UPPER"
  nomeNoPdf: 'Upper',
  endereco: 'R. João Cachoeira, 1577 · Itaim Bibi · São Paulo',
  tabela: 'Tabela de outubro/2026',
  tabelaCurta: 'outubro/2026',
  // The PDF only has a date. Replace with the hour of the last real update when the data comes from the CV.
  atualizado: 'Dados copiados do PDF gerado no CV CRM em 05/10/2026 · hora [falta]',

  // WhatsApp that receives the leads (decision D7: Hugo's). Digits only, with country code, e.g. 5511999999999.
  whatsapp: 'WHATSAPP_DO_HUGO',
  mensagemWhatsapp: (numero) => `Olá, tenho interesse na unidade ${numero} do Uber Itaim (tabela de outubro/2026)`,

  imobiliaria: 'Geracional',
  creciJ: '[falta: CRECI-J da Geracional]',
  corretor: 'Hugo Maron de Senna',
  creciCorretor: '[falta: CRECI do Hugo]',
  construtora: '[falta: incorporadora/construtora]',
  registro: '[falta: registro/matrícula e cartório]',
  autorizacao: '[falta: autorização da construtora para anunciar]',
  estadoImovel: 'Imóvel pronto, mobiliado e em operação de locação (nota d da tabela)',

  // Public link of the page, used by "Copiar link desta unidade". Empty = use the address of the open page.
  urlPublica: '',

  // Photo view delivered by front B2. If these files are not published next to the page, the "Foto" tab stays hidden.
  // SVG contract: one <polygon>/<path> per unit with data-id="andar-final" (e.g. "10-4"), or id="u104".
  vistaFoto: {
    imagem: 'assets/vista-frente-1080.webp',
    svg: 'assets/vista-frente-unidades.svg',
    legenda: 'Foto de drone (abril/2026) com as unidades desenhadas por cima',
  },

  // Sun cycle (hold the button for the sun to move). Tune here, no code change needed.
  sol: {
    horasPorSegundo: 1,      // day pace while the button is held: 1 h of day per second
    noiteSegundos: 3,        // the whole night (sunset -> sunrise) passes in this many seconds
    toqueCurtoMin: 30,       // a short tap advances this many minutes
    toqueCurtoMs: 260,       // press shorter than this = short tap
    estacaoInicial: 'primavera',
    horaInicial: '09:00',
    rotulo: 'Simulação do sol — pode variar com obstáculos não mapeados.',
    // rotuloNoite: built from the convention table in src/noite.js (F25), not here
    rotuloNoiteFoto: 'Ilustração noturna sobre foto diurna (abril/2026)',
  },

  // Demo (07/10): features that depend on other fronts stay OFF unless their files exist (never half-working).
  demo: {
    // B6 photoreal stills: shown first in the gallery only if this manifest exists ({ fotos: [{ arq, legenda }] })
    rendersManifesto: 'assets/render/demo/manifest.json',
    // B6 360 tour: replaces the 3D interior only if this manifest exists (the real batch); ?tour360=amostra tests the sample
    tour360Ativo: false, // OFF until B6 confirms a batch without unconfirmed lights (coordinator 22:5x)
    tour360Manifesto: 'assets/render/tour360/manifest.json',
    tour360Amostra: 'assets/render/tour360/manifesto.json',
  },

  fotos2026: {
    legenda: 'Foto real de um studio do prédio (2026) — decoração pode variar por unidade', // C1: unit not confirmed (B7/B8: north face, floors ~8-12)
    lista: [
      { arq: 'assets/tour/2026/01-sala-vista.webp', texto: 'Sala e quarto, com a vista' },
      { arq: 'assets/tour/2026/03-cama-sofa-sacada.webp', texto: 'Cama, sofá e porta da sacada' },
      { arq: 'assets/tour/2026/04-vista-da-sacada.webp', texto: 'Visto da sacada: armário e cozinha ao fundo' },
      { arq: 'assets/tour/2026/06-quarto-frente.webp', texto: 'Quarto de frente' },
      { arq: 'assets/tour/2026/07-cama-detalhe.webp', texto: 'Roupa de cama' },
      { arq: 'assets/tour/2026/08-cabeceira-quadros.webp', texto: 'Cabeceira' },
    ],
  },

  tour: {
    legenda: 'Fotos de um studio do prédio (2021) — decoração pode ter mudado', // C1: unit not documented by Hugo
    legendaCard: 'Foto real de um studio do prédio (2026) — decoração pode variar por unidade',
    dataFotos: '06/01/2021 (data gravada pela câmera)',
    legendaVideo: 'Vídeo de celular de um studio do prédio · unidade [falta: confirmar com o Hugo] · arquivo de 07/04/2026',
    legendaComum: 'Áreas comuns · quadro de vídeo de celular · arquivo de 07/04/2026',
  },
};
