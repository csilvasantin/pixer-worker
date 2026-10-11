// A named, private service entrypoint may only generate the fixed Spain and English voices.
export const voices={es:{male:'Nh2zY9kknu6z4pZy6FhD',female:'KHCvMklQZZo0O30ERnVn'},en:{male:'EkK5I93UQWFDigLMpZcX',female:'56AoDkrOh6qfVPDXZ7Pt'}};
// Voces de consejero (admira.live /debatir mejor audio · aprobado por Carlos 11-10-2026 11:48).
// voiceId es OPCIONAL y solo vale si está en esta lista corta de voces premade de ElevenLabs; cualquier otro
// valor se ignora y manda voice (male/female) como siempre. Las llamadas existentes no cambian.
export const counselorVoiceIds=Object.freeze(['cjVigY5qzO86Huf0OWal','TX3LPaxmHKxFdv7VOQHJ','CwhRBWXzGAHq8TQ4Fs17','pqHfZKP75CyOlX2KQs5n','nPczCjzI2devNBz1zQrW','onwK4e9ZLuTAKqWW03F9','iP95p4xoKVk53GoZ742B','JBFqnCBsd6RMkjVDRZzb','N2lVS1w4EtoT3dr4eOWO','bIHbv24MWmeRgasZH58o','EXAVITQu4vr4xnSDxMaL','XrExE9yKIg1WjnnlVkGX','IKne3meq5aSn9XLyUdCD']);
export function announcementVoiceId(language,voice,voiceId){return typeof voiceId==='string'&&counselorVoiceIds.includes(voiceId)?voiceId:voices[language][voice];}
export async function generateAnnouncement(env,{text,voice,language='es',voiceId}={},fetchImpl=fetch){
  if(typeof text!=='string'||!text.trim()||text.length>1500||!['male','female'].includes(voice)||!['es','en'].includes(language))return Response.json({error:'invalid_announcement'},{status:400});
  if(!env.ELEVENLABS_KEY)return Response.json({error:'tts_unavailable'},{status:503});
  const res=await fetchImpl('https://api.elevenlabs.io/v1/text-to-dialogue?output_format=mp3_44100_192',{
    method:'POST',headers:{'xi-api-key':env.ELEVENLABS_KEY,'Content-Type':'application/json','Accept':'audio/mpeg'},
    body:JSON.stringify({model_id:'eleven_v4',language_code:language,inputs:[{text:text.trim(),voice_id:announcementVoiceId(language,voice,voiceId)}],apply_text_normalization:'on'}),signal:AbortSignal.timeout(90000)
  });
  if(!res.ok)return Response.json({error:'tts_generation_failed'},{status:502});
  return new Response(res.body,{headers:{'Content-Type':'audio/mpeg','Cache-Control':'no-store'}});
}
