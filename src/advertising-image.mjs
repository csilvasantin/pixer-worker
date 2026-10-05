// Narrow advertising preview, reusing the existing PixerIA image handler.
import {xaiImageHandler} from './index.js';
export async function generateAdvertisingImage(env,{text,language='es'}={},handler=xaiImageHandler){
  if(typeof text!=='string'||!text.trim()||text.length>1500||!['es','en'].includes(language))return Response.json({error:'invalid_image_brief'},{status:400});
  if(!env.XAI_KEY)return Response.json({error:'image_unavailable'},{status:503});
  const prefix=language==='en'?'Advertising image for a retail digital signage screen, vivid colors, no small text: ':'Creatividad de publicidad para pantalla de tienda (digital signage), colores vivos, sin texto pequeño: ';
  const request=new Request('https://api.admira.store/xai/image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:prefix+text.trim(),model:'grok-imagine-image',n:1,b64:true})});
  const res=await handler(request,env);
  if(!res.ok)return Response.json({error:'image_generation_failed'},{status:502});
  const data=await res.json(),item=data?.data?.[0];
  if(!item?.b64_json)return Response.json({error:'image_generation_failed'},{status:502});
  return Response.json({ok:true,b64:item.b64_json,mime:item.mime||'image/jpeg'},{headers:{'Cache-Control':'no-store'}});
}
