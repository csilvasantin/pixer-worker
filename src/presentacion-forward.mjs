// /enviar telegram de PortAventuraNeXT (Carlos, 14-11-2026 10:33). La presentación llega a este chat por /notify;
// las RESPUESTAS de Carlos a esas diapositivas (o /editar n.m texto, /deshacer) entran por este webhook, que es
// el único del bot. Aquí solo se reenvían esas, del dueño y en su chat privado, al sitio con un secreto compartido;
// el sitio guarda la edición (mismo mecanismo que /editar de la web) y devuelve la confirmación que se publica aquí.
export const PVN_HOOK_URL = 'https://www.portaventuranext.com/api/telegram/presentacion';
const MARCA = /\bPVN·(ES|EN)·\d+\b/;

export function esParaPresentacion(msg, env) {
  if (!msg || !env || !env.PVN_TELEGRAM_HOOK_SECRET || !env.TELEGRAM_CHAT_ID) return false;
  const duenno = String(env.TELEGRAM_CHAT_ID);
  if (String((msg.from && msg.from.id) || '') !== duenno || String((msg.chat && msg.chat.id) || '') !== duenno) return false;
  const text = String(msg.text || '').trim();
  if (/^\/(editar|edit|deshacer|undo)(?:@[A-Za-z0-9_]+)?(\s|$)/i.test(text)) return true;
  const r = msg.reply_to_message;
  return !!(r && MARCA.test(String(r.text || '')) && text);
}

export async function reenviarPresentacion(update, env, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(env.PVN_TELEGRAM_HOOK_URL || PVN_HOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PVN-Hook-Secret': env.PVN_TELEGRAM_HOOK_SECRET, 'User-Agent': 'pixer-eleven/pvn-forward' },
      body: JSON.stringify(update),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (d && typeof d.reply === 'string' && d.reply) return d.reply.slice(0, 3500);
    return r.ok ? null : `⚠️ PortAventuraNeXT no pudo guardar la edición (HTTP ${r.status}).`;
  } catch (e) {
    return '⚠️ PortAventuraNeXT no responde; la edición no se ha guardado.';
  }
}
