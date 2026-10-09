// Exact authored layers, not copy inferred from a generation prompt or a model name.
// Kept byte-identical to pixer-worker/src/content-composition.mjs.
export const COMPOSITION_SCHEMA='admira.composition.v1';
const roles=['headline','body','brand','legal'];
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const dimension=v=>Number.isInteger(v)&&v>=64&&v<=16384;
const box=v=>Array.isArray(v)&&v.length===4&&v.every(n=>Number.isFinite(n)&&n>=0&&n<=1000)&&v[2]>v[0]&&v[3]>v[1];
function typography(s){
 if(s==null)return undefined;
 if(!s||!['condensed','rounded','sans','serif','script','mono'].includes(s.family)||!Number.isFinite(s.weight)||s.weight<300||s.weight>900||!/^#[a-f0-9]{6}$/i.test(s.color||'')||!['left','center','right'].includes(s.align))throw Error('invalid-composition-style');
 return {family:s.family,weight:s.weight,color:s.color.toUpperCase(),align:s.align,italic:false,trackingEm:0,lineHeight:1.14,outlineEm:0,outlineColor:'#102D36',shadow:false};
}
export function validateComposition(value,{type,width,height}={}){
 if(!value||value.schema!==COMPOSITION_SCHEMA||value.producer!=='admira.studio'||value.renderer!=='campaign-canvas.v1'||!['image','video'].includes(value.mediaType)||!dimension(value.width)||!dimension(value.height)||value.width*value.height>16777216||typeof value.complete!=='boolean'||!Array.isArray(value.copy)||value.copy.length>32)throw Error('invalid-composition');
 if((type&&value.mediaType!==type)||(width!=null&&value.width!==width)||(height!=null&&value.height!==height))throw Error('composition-asset-mismatch');
 let total=0;
 const copy=value.copy.map(x=>{
  if(!x||!roles.includes(x.role)||typeof x.text!=='string'||!x.text.trim()||x.text.length>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(x.text)||!box(x.box))throw Error('invalid-composition-copy');
  total+=x.text.length;if(total>20000)throw Error('invalid-composition-copy');
  const style=typography(x.typography);
  return {role:x.role,text:x.text,box:[...x.box],...(style?{typography:style}:{})};
 });
 return {schema:COMPOSITION_SCHEMA,producer:'admira.studio',renderer:'campaign-canvas.v1',mediaType:value.mediaType,width:value.width,height:value.height,complete:value.complete,copy};
}
export function bindComposition(value,assetHash,dimensions){
 if(!hash(assetHash))throw Error('composition-asset-hash');
 return {...validateComposition(value,dimensions),assetHash,verification:'authenticated-compositor'};
}
// Only the selected Stock entry may supply this contract. Imports/filenames/prompts are not evidence.
export function compositionFromStock(item){
 try{
  const c=item?.composition;
  if(!c||!hash(item.contentHash)||c.assetHash!==item.contentHash||c.verification!=='authenticated-compositor'||!['image','video'].includes(item.type)||!dimension(item.ancho)||!dimension(item.alto))return null;
  return {...validateComposition(c,{type:item.type,width:item.ancho,height:item.alto}),assetHash:c.assetHash,verification:c.verification};
 }catch{return null;}
}
export function withSystemComposition(document,composition,{width,height,type='image'}={}){
 if(!composition?.complete)return document;
 let c;try{if(!dimension(width)||!dimension(height))return document;c=validateComposition(composition,{type,width,height});}catch{return document;}
 if(!hash(composition.assetHash)||composition.verification!=='authenticated-compositor')return document;
 return {...document,texts:c.copy.map(x=>({...x,confidence:1})),uncertain:false,copySource:'system-composition',compositionAssetHash:composition.assetHash};
}
