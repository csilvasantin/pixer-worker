// A named, private service entrypoint may only generate these two Spain voices.
export const voices={male:'Nh2zY9kknu6z4pZy6FhD',female:'KHCvMklQZZo0O30ERnVn'};
export async function generateAnnouncement(env,{text,voice}={},fetchImpl=fetch){
  if(typeof text!=='string'||!text.trim()||text.length>1500||!['male','female'].includes(voice))return Response.json({error:'invalid_announcement'},{status:400});
  if(!env.ELEVENLABS_KEY)return Response.json({error:'tts_unavailable'},{status:503});
  const res=await fetchImpl('https://api.elevenlabs.io/v1/text-to-dialogue?output_format=mp3_44100_192',{
    method:'POST',headers:{'xi-api-key':env.ELEVENLABS_KEY,'Content-Type':'application/json','Accept':'audio/mpeg'},
    body:JSON.stringify({model_id:'eleven_v4',language_code:'es',inputs:[{text:text.trim(),voice_id:voices[voice]}],apply_text_normalization:'on'}),signal:AbortSignal.timeout(90000)
  });
  if(!res.ok)return Response.json({error:'tts_generation_failed'},{status:502});
  return new Response(res.body,{headers:{'Content-Type':'audio/mpeg','Cache-Control':'no-store'}});
}
