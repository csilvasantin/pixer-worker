export const TEXT_POSITIONS_SCHEMA='admira.text-positions.v1';
const FORMATS=['horizontal','vertical'];
const BOXES=['heading','gancho','giro','remate','fuente','marca','unidad','claim'];
// Offsets are fractions of the complete output frame, never source-video pixels.
export function normalizeTextPositions(value){
 if(value==null)return {ok:true,positions:{}};
 const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
 if(!object(value))return {ok:false,error:'invalid-text-positions'};
 const positions={};
 for(const [format,boxes]of Object.entries(value)){
  if(!FORMATS.includes(format)||!object(boxes))return {ok:false,error:'invalid-text-positions'};
  for(const [key,pos]of Object.entries(boxes)){
   if(!BOXES.includes(key)||!object(pos)||Object.keys(pos).some(k=>!['x','y'].includes(k))||!['x','y'].every(k=>typeof pos[k]==='number'&&Number.isFinite(pos[k])&&Math.abs(pos[k])<=1))return {ok:false,error:'invalid-text-positions'};
   const x=Math.round(pos.x*1e5)/1e5,y=Math.round(pos.y*1e5)/1e5;
   if(x||y){positions[format]||={};positions[format][key]={x,y};}
  }
 }
 return {ok:true,positions};
}
