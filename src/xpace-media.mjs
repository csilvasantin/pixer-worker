// Authenticated Pages RPC jobs. Existing R2 gives conditional creation/leases;
// provider calls are never repeated when an operation is retried or resumed.
import {generateAdvertisingImage} from './advertising-image.mjs';
import {finalArtworkPrompt} from './final-artwork.mjs';
import {generateAnnouncement} from './announcement-tts.mjs';
import {xaiVideoStartHandler,xaiVideoPollHandler,stockPublishHandler} from './index.js';
import {pollFinished,providerVideoUrl} from './clip-from-image.mjs';
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ownerOk=/^[a-f0-9]{64}$/;
const encoder=new TextEncoder();
const depsDefault={image:generateAdvertisingImage,audio:generateAnnouncement,video:xaiVideoStartHandler,poll:xaiVideoPollHandler,publish:stockPublishHandler};
export function validMediaInput(input){return input&&['image','video','audio'].includes(input.kind)&&typeof input.text==='string'&&input.text.trim()&&input.text.length<=1500&&['es','en'].includes(input.language)&&uuid.test(input.requestId||'')&&ownerOk.test(input.owner||'')&&(input.imageId===undefined||(input.kind==='video'&&/^[A-Za-z0-9-]{4,80}$/.test(input.imageId)&&input.duration===10&&['16:9','9:16'].includes(input.aspect||'16:9')))&&(input.kind!=='audio'||['male','female'].includes(input.voice));}
async function jobKey(env,owner,id){
 const secret=env.ADMIRANEXT_INGEST_TOKEN||env.NOTIFY_KEY;
 if(!env.STOCK_BUCKET||!secret)throw Error('media_unavailable');
 const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const digest=new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode('xpace-media:'+owner+':'+id)));
 return 'xpace-jobs/'+Array.from(digest,x=>x.toString(16).padStart(2,'0')).join('')+'.json';
}
async function read(env,key){const object=await env.STOCK_BUCKET.get(key);return object?await object.json():null;}
async function save(env,key,job){await env.STOCK_BUCKET.put(key,JSON.stringify(job),{httpMetadata:{contentType:'application/json',cacheControl:'no-store'}});}
async function queue(env,key){await env.STOCK_BUCKET.put(key.replace('xpace-jobs/','xpace-pending/'),JSON.stringify({key}),{httpMetadata:{contentType:'application/json'}});}
async function unqueue(env,key){await env.STOCK_BUCKET.delete(key.replace('xpace-jobs/','xpace-pending/'));}
function visible(job){const {id,kind,status,stock,error,createdAt,language,duration,aspect,resolution,imageId}=job;return {id,kind,status,...(stock?{stock}:{}),...(error?{error}:{}),createdAt,language,...(imageId?{sourceImageId:imageId}:{}),...(duration?{duration,aspect,resolution}:{})};}
async function lock(env,key){
 const lockKey=key.replace('xpace-jobs/','xpace-locks/'),existing=await env.STOCK_BUCKET.get(lockKey);
 let opts={etagDoesNotMatch:'*'};
 if(existing){const lease=await existing.json();if(lease.until>Date.now())return null;opts={etagMatches:existing.etag};}
 const nonce=crypto.randomUUID(),result=await env.STOCK_BUCKET.put(lockKey,JSON.stringify({nonce,until:Date.now()+5*60*1000}),{onlyIf:opts});
 if(!result)return null;
 return async()=>{const latest=await env.STOCK_BUCKET.get(lockKey);if(latest&&(await latest.json()).nonce===nonce)await env.STOCK_BUCKET.delete(lockKey);};
}
function base64(bytes){let out='';for(let i=0;i<bytes.length;i+=8192)out+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(out);}
function stockBody(job){return {type:job.kind==='audio'?'locucion':job.kind,motor:job.kind==='audio'?'elevenlabs-v4':job.kind==='video'?'grok-imagine-video':'grok-imagine-image',prompt:job.text,title:job.text.slice(0,120),mime:job.mime,base64:job.base64,sourceUrl:job.sourceUrl,contentHash:job.contentHash,externalRef:'xpaceos:'+job.id,tags:['xpaceos','admira-xp',job.kind==='audio'?'locucion':'creatividad',job.language],quality:job.kind==='audio'?'best':'good',comment:'Creado desde XpaceOS / Created in XpaceOS'+(job.kind==='audio'?' · '+job.voice+' · '+job.language:job.kind==='video'?' · '+job.duration+' s · '+job.aspect+' · 720p'+(job.imageId?' · imagen Stock '+job.imageId:''):'')};}
async function archive(env,ctx,key,job,deps){
 const body=stockBody(job),headers={'Content-Type':'application/json'};
 if(job.kind==='video'&&env.ADMIRANEXT_INGEST_TOKEN){body.externalId='xpaceos:video:'+key.split('/')[1].replace('.json','');headers['X-AdmiraNeXT-Ingest']=env.ADMIRANEXT_INGEST_TOKEN;}
 const request=new Request('https://api.admira.store/stock/publish',{method:'POST',headers,body:JSON.stringify(body)});
 let response,data;
 try{response=await deps.publish(request,env,ctx);data=await response.json();}catch(_){response=null;}
 if(!response?.ok||!data?.ok||!data.id||!data.url){console.warn(JSON.stringify({event:'xpace_media_archive',id:job.id,kind:job.kind,status:response?.status||0,reason:/^[a-z0-9:_-]{1,80}$/i.test(data?.error||'')?data.error:'publish_failed'}));job.status='archiving';job.error='stock_pending';await save(env,key,job);return job;}
 job.status='done';job.stock={id:data.id,num:data.num||null,url:data.url,contentHash:data.contentHash||job.contentHash||null,mime:job.mime};
 delete job.base64;delete job.sourceUrl;delete job.providerId;delete job.error;
 await save(env,key,job);await unqueue(env,key);return job;
}
async function advance(env,ctx,key,job,deps){
 if(job.status==='pending'&&Date.now()-job.createdAt>24*60*60*1000){job.status='failed';job.error='video_generation_expired';await save(env,key,job);await unqueue(env,key);return job;}
 if(job.status==='pending'){
  let response,data;try{response=await deps.poll(new Request('https://api.admira.store/xai/video/'+job.providerId),env,ctx,job.providerId);data=await response.json();}catch(_){return job;}
  if(!response.ok)return job;
  if(['failed','expired','error'].includes(String(data.status).toLowerCase())){job.status='failed';job.error='video_generation_failed';await save(env,key,job);await unqueue(env,key);return job;}
  if(!pollFinished(data))return job;
  const url=providerVideoUrl(data);try{const u=new URL(url);if(u.protocol!=='https:'||!(u.hostname==='x.ai'||u.hostname.endsWith('.x.ai')))throw Error();}catch(_){job.status='failed';job.error='invalid_video_output';await save(env,key,job);await unqueue(env,key);return job;}
  job.sourceUrl=url;job.mime='video/mp4';job.status='archiving';await save(env,key,job);
 }
 if(job.status==='archiving')return archive(env,ctx,key,job,deps);
 if(job.status==='generating'&&Date.now()-job.createdAt>10*60*1000){job.status='failed';job.error='generation_unconfirmed';await save(env,key,job);await unqueue(env,key);}
 return job;
}
export async function startMedia(env,input,ctx={waitUntil(){}},deps=depsDefault){
 if(!validMediaInput(input))return json({error:'invalid_media_request'},400);
 let key;try{key=await jobKey(env,input.owner,input.requestId);}catch(_){return json({error:'media_unavailable'},503);}
 const release=await lock(env,key);
 if(!release){const job=await read(env,key);if(job&&(job.kind!==input.kind||job.text!==input.text.trim()||job.language!==input.language||(job.kind==='audio'&&job.voice!==input.voice)||(job.kind==='video'&&((job.imageId||'')!==(input.imageId||'')||(job.imageId&&job.aspect!==(input.aspect||'16:9'))))))return json({error:'operation_conflict'},409);return json({ok:true,job:job?visible(job):{id:input.requestId,kind:input.kind,status:'generating'}},202);}
 try{
  let job=await read(env,key);
  if(job){if(job.kind!==input.kind||job.text!==input.text.trim()||job.language!==input.language||(job.kind==='audio'&&job.voice!==input.voice)||(job.kind==='video'&&((job.imageId||'')!==(input.imageId||'')||(job.imageId&&job.aspect!==(input.aspect||'16:9')))))return json({error:'operation_conflict'},409);job=await advance(env,ctx,key,job,deps);return json({ok:true,job:visible(job)},job.status==='done'||job.status==='failed'?200:202);}
  job={id:input.requestId,owner:input.owner,kind:input.kind,text:input.text.trim(),language:input.language,voice:input.voice,...(input.imageId?{imageId:input.imageId,aspect:input.aspect||'16:9'}:{}),status:'generating',createdAt:Date.now()};
  await save(env,key,job);await queue(env,key);
  try{
   if(input.kind==='video'){
    const prefix=input.language==='en'?'Create a retail advertising video. Any spoken words or visible text must be in English. ':'Crea un vídeo publicitario para una tienda. Cualquier voz o texto visible debe estar en castellano de España. ';
    const imagePrompt=job.imageId?(input.language==='en'?'Animate the supplied image and expand its visual story with close-ups, product details and a clear sequence. Preserve identity, existing text, prices and claims; do not invent product facts. ':'Anima la imagen suministrada y amplía su relato visual con acercamientos, detalles del producto y una secuencia clara. Conserva identidad, textos, precios y afirmaciones existentes; no inventes datos del producto. '):'';
    const response=await deps.video(new Request('https://api.admira.store/xai/video',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:finalArtworkPrompt(prefix+imagePrompt+job.text,{video:true}),duration:job.imageId?10:8,aspect_ratio:job.aspect||'16:9',resolution:'720p',...(job.imageId?{stock_id:job.imageId}:{})})}),env,job.imageId?{imageDuration:10}:{});
    const data=await response.json();if(!response.ok||!data.request_id)throw Error('generation');
    job.providerId=data.request_id;job.status='pending';job.duration=job.imageId?10:8;job.aspect=job.aspect||'16:9';job.resolution='720p';await save(env,key,job);
   }else{
    const response=await deps[input.kind](env,{text:job.text,language:job.language,voice:job.voice});if(!response.ok)throw Error('generation');
    if(input.kind==='image'){const data=await response.json();if(!data.ok||!data.b64)throw Error('generation');job.base64=data.b64;job.mime=data.mime||'image/jpeg';}
    else{const bytes=new Uint8Array(await response.arrayBuffer());if(!bytes.length)throw Error('generation');job.base64=base64(bytes);job.mime='audio/mpeg';}
    const bytes=Uint8Array.from(atob(job.base64),c=>c.charCodeAt(0));job.contentHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
    job.status='archiving';await save(env,key,job);job=await archive(env,ctx,key,job,deps);
   }
  }catch(_){if(['archiving','pending','done'].includes(job.status)){if(job.status!=='done')job.error='stock_pending';await save(env,key,job);}else{job.status='failed';job.error='generation_failed';await save(env,key,job);await unqueue(env,key);}}
  return json({ok:true,job:visible(job)},job.status==='done'||job.status==='failed'?200:202);
 }finally{await release();}
}
export async function getMedia(env,{owner,requestId}={},ctx={waitUntil(){}},deps=depsDefault){
 if(!ownerOk.test(owner||'')||!uuid.test(requestId||''))return json({error:'invalid_media_request'},400);
 let key;try{key=await jobKey(env,owner,requestId);}catch(_){return json({error:'media_unavailable'},503);}
 let job=await read(env,key);if(!job)return json({error:'job_not_found'},404);
 const release=await lock(env,key);if(release)try{job=await advance(env,ctx,key,await read(env,key),deps);}finally{await release();}
 return json({ok:true,job:visible(job)});
}
export async function recoverMedia(env,ctx,deps=depsDefault){
 if(!env.STOCK_BUCKET)return;
 const list=await env.STOCK_BUCKET.list({prefix:'xpace-pending/',limit:10});
 for(const item of list.objects){const pending=await read(env,item.key);if(!pending?.key)continue;const job=await read(env,pending.key);if(!job){await env.STOCK_BUCKET.delete(item.key);continue;}
  const release=await lock(env,pending.key);if(!release)continue;try{await advance(env,ctx,pending.key,job,deps);}catch(_){}finally{await release();}
 }
}
export async function storedAnnouncement(env,input,ctx){
 const response=await startMedia(env,{...input,kind:'audio'},ctx);const data=await response.clone().json();
 if(!response.ok||data.job?.status!=='done')return response;
 const stock=data.job.stock,meta=await read(env,'stock/'+stock.id+'/meta.json'),asset=meta?.assetKey?await env.STOCK_BUCKET.get(meta.assetKey):null;
 if(!asset)return json({error:'stock_asset_unavailable'},502);
 return new Response(asset.body,{headers:{'Content-Type':'audio/mpeg','Cache-Control':'no-store','X-Stock-Id':stock.id,'X-Stock-Url':stock.url,'X-Stock-Num':String(stock.num||''),'X-Media-Job':input.requestId}});
}
