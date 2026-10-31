// Telegram (@AdmiraXPBot) → cápsula de conocimiento (Carlos, OK 31-oct-2026).
// `#capsula` tras la URL (o en el caption del adjunto) → además de importar a Stock, encola
// una cápsula auto-aprobada. `#formato` implica cápsula y pide las DOS orientaciones.
// Las etiquetas se quitan del comentario para que no acaben como hashtags del Stock.
const TAG_RE = /(^|\s)#(capsula|cápsula|formato)\b/giu;

export function parseImportFlags(text) {
  const raw = String(text || '');
  let capsula = false, formato = false;
  for (const m of raw.matchAll(TAG_RE)) {
    const t = m[2].toLowerCase();
    if (t === 'formato') formato = true; else capsula = true;
  }
  if (formato) capsula = true;
  const comment = raw.replace(TAG_RE, '$1').replace(/[ \t]{2,}/g, ' ').trim();
  return { capsula, formato, comment };
}

export const ORIENTACIONES = ['vertical', 'horizontal'];
export function opuesta(o) { return o === 'vertical' ? 'horizontal' : o === 'horizontal' ? 'vertical' : null; }

// Cuerpo de /capsula/url/encargar según el contrato acordado con Jobs (preroll, postroll,
// orientacion, idioma, subtitulos, formatos[], requestedBy, autoApprove). Los campos que
// el handler aún no lea se ignoran sin romper nada.
export function buildCapsulaEncargo({ url, borrador, flags, orientacion, idioma, subtitulos }) {
  const o = ORIENTACIONES.includes(orientacion) ? orientacion : null;
  const base = o || 'vertical';
  const formatos = flags?.formato ? [base, opuesta(base)] : [base];
  const src = borrador?.source || {};
  return {
    url, guion: borrador?.guion,
    image: src.image || '', title: src.title || '', author: src.author || '',
    preroll: true, postroll: true, cartela: true,
    orientacion: base, formatos,
    idioma: idioma || null, subtitulos: subtitulos ?? true,
    requestedBy: 'AdmiraXPBot', autoApprove: true, origen: 'telegram',
  };
}
