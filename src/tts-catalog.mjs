// Authenticated metadata lookup; provider credentials never leave the Worker.
export async function ttsCatalog(env, fetchImpl = fetch) {
  if (!env.ELEVENLABS_KEY) throw new Error('missing_key');
  const headers = {'xi-api-key':env.ELEVENLABS_KEY, Accept:'application/json'};
  const paths = ['/shared-voices?language=es&page_size=100','/models','/user/subscription'];
  const responses = await Promise.all(paths.map(path=>fetchImpl('https://api.elevenlabs.io/v1'+path,{headers})));
  if (responses.some(r=>!r.ok)) throw new Error('catalog_unavailable');
  const [shared,models,subscription]=await Promise.all(responses.map(r=>r.json()));
  return {voices:(shared.voices||[]).map(v=>({voice_id:v.voice_id,name:v.name,gender:v.gender,accent:v.accent,language:v.language,description:v.description,category:v.category,preview_url:v.preview_url,public_owner_id:v.public_owner_id,free_users_allowed:v.free_users_allowed,live_moderation_enabled:v.live_moderation_enabled,notice_period:v.notice_period})),models:models.filter(m=>m.can_do_text_to_speech).map(m=>({id:m.model_id,name:m.name})),tier:subscription.tier};
}
